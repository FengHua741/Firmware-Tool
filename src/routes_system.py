"""
系统管理蓝图 - 系统资源监控、设备检测、服务管理等
"""

from flask import Blueprint, jsonify, request, send_from_directory, Response
import subprocess
import os
import re
import time
import psutil
import requests
import threading
import urllib.parse
from datetime import datetime
from collections import deque

from shared import (
    app, config, logger, BASE_DIR, CONFIG_PATH,
    DFU_KNOWN_DEVICES, DFU_KNOWN_VIDPIDS,
    run_cmd, run_cmd_check, path_exists, list_dir, is_ssh_mode, is_fast_ssh_mode,
    SSHManager, get_klipper_owner, get_klipper_python_bin, expand_klipper_path
)

system_bp = Blueprint('system', __name__)

# ==================== 历史数据与缓存 ====================
MAX_HISTORY_POINTS = 3600
resource_history = {
    'cpu': deque(maxlen=MAX_HISTORY_POINTS),
    'memory': deque(maxlen=MAX_HISTORY_POINTS),
    'disk': deque(maxlen=MAX_HISTORY_POINTS),
    'timestamps': deque(maxlen=MAX_HISTORY_POINTS)
}

# 服务列表
SERVICES = ['klipper', 'moonraker', 'nginx', 'crowsnest', 'KlipperScreen']

# 远程资源采集缓存
_remote_cpu_prev = None
_remote_resource_cache = {
    'cpu': {'percent': 0, 'freq': 0, 'count': 1},
    'memory': {'total': 0, 'used': 0, 'percent': 0},
    'disk': {'total': 0, 'used': 0, 'percent': 0},
    'network': {'interfaces': []},
    'timestamp': 0
}
_remote_flyos_version = None
_remote_board_name = None

# SSH 连接状态
_ssh_connection_status = {
    'connected': False,
    'circuit_open': False,
    'consecutive_failures': 0,
    'cooldown_remaining': 0,
    'cooldown_level': 0,
    'last_disconnect_time': None,
    'reconnect_attempts': 0,
}

SSH_RECONNECT_COOLDOWN = 10
SSH_RECONNECT_MAX_INTERVAL = 120


def _collect_remote_resources():
    """通过 SSH 单次命令采集远程系统资源"""
    global _remote_cpu_prev

    try:
        if not is_ssh_mode():
            return None

        manager = SSHManager.get_instance()

        cmd = (
            "echo '===STAT==='; grep 'cpu ' /proc/stat; "
            "echo '===FRQ==='; cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq 2>/dev/null || echo 0; "
            "echo '===CNT==='; nproc; "
            "echo '===MEM==='; free -b | grep '^Mem:'; "
            "echo '===DSK==='; df -B1 --output=source,size,used,target 2>/dev/null | grep -vE '^(tmpfs|devtmpfs|overlayfs|Filesystem|/dev/zram)' | sort -k2 -rn | head -1; "
            "echo '===NET==='; ip -br -4 addr show 2>/dev/null | grep -iE '^(eth|en|wlan|wlo)'; "
            "echo '===VER==='; flyos-fast-ota --version 2>&1 | head -1; "
            "echo '===BRD==='; cat /proc/cmdline 2>/dev/null; "
            "echo '===END==='"
        )

        result = manager.exec_command(cmd, timeout=8)
        logger.info(f"远程资源采集: rc={result.returncode}, stdout_len={len(result.stdout)}, stderr={result.stderr[:100]}")
        if result.returncode != 0:
            logger.warning(f"远程资源采集命令失败: rc={result.returncode}, stderr={result.stderr[:200]}")
            return None

        output = result.stdout

        sections = {}
        current_key = None
        current_lines = []

        for line in output.split('\n'):
            line = line.strip()
            if line.startswith('===') and line.endswith('==='):
                key = line[3:-3]
                if current_key:
                    sections[current_key] = '\n'.join(current_lines)
                current_key = key
                current_lines = []
            else:
                if current_key and line:
                    current_lines.append(line)
        if current_key:
            sections[current_key] = '\n'.join(current_lines)

        cpu_info = {'percent': 0, 'freq': 0, 'count': 1}
        if 'STAT' in sections:
            parts = sections['STAT'].split()
            if len(parts) >= 8:
                try:
                    values = [int(x) for x in parts[1:8]]
                    idle = values[3] + values[4]
                    total = sum(values)
                    if _remote_cpu_prev is not None:
                        prev_total, prev_idle = _remote_cpu_prev
                        diff_total = total - prev_total
                        diff_idle = idle - prev_idle
                        if diff_total > 0:
                            cpu_info['percent'] = round((1 - diff_idle / diff_total) * 100, 1)
                    _remote_cpu_prev = (total, idle)
                except (ValueError, IndexError):
                    pass

        if 'FRQ' in sections:
            try:
                cpu_info['freq'] = round(int(sections['FRQ'].strip()) / 1000000, 2)
            except (ValueError, TypeError):
                pass

        if 'CNT' in sections:
            try:
                cpu_info['count'] = int(sections['CNT'].strip())
            except (ValueError, TypeError):
                pass

        mem_info = {'total': 0, 'used': 0, 'percent': 0}
        if 'MEM' in sections:
            line = sections['MEM'].strip()
            if line.startswith('Mem:'):
                line = line[4:].strip()
            parts = line.split()
            if len(parts) >= 6:
                try:
                    mem_total = int(parts[0])
                    mem_used_raw = int(parts[1])
                    mem_avail = int(parts[5])
                    mem_used = mem_total - mem_avail if mem_avail > 0 else mem_used_raw
                    mem_info = {
                        'total': round(mem_total / (1024**3), 1),
                        'used': round(mem_used / (1024**3), 1),
                        'percent': round(mem_used / mem_total * 100, 1) if mem_total > 0 else 0
                    }
                except (ValueError, IndexError):
                    logger.warning(f"远程内存解析失败: line={sections['MEM'][:80]}")

        disk_info = {'total': 0, 'used': 0, 'percent': 0}
        if 'DSK' in sections:
            line = sections['DSK'].strip()
            parts = line.split()
            if len(parts) >= 4:
                try:
                    disk_total = int(parts[1])
                    disk_used = int(parts[2])
                    disk_info = {
                        'total': round(disk_total / (1024**3), 1),
                        'used': round(disk_used / (1024**3), 1),
                        'percent': round(disk_used / disk_total * 100, 1) if disk_total > 0 else 0
                    }
                except (ValueError, IndexError):
                    logger.warning(f"远程磁盘解析失败: line={sections['DSK'][:80]}")

        net_info = {'interfaces': []}
        if 'NET' in sections:
            import socket as _socket
            for line in sections['NET'].split('\n'):
                line = line.strip()
                if not line:
                    continue
                parts = line.split()
                if len(parts) >= 3:
                    iface_name = parts[0]
                    ip_addr = parts[2].split('/')[0]
                    iface_lower = iface_name.lower()
                    if iface_lower.startswith('eth') or iface_lower.startswith('en'):
                        display_name = '网线'
                    elif iface_lower.startswith('wlan') or iface_lower.startswith('wlo'):
                        display_name = 'WiFi'
                    else:
                        display_name = iface_name
                    net_info['interfaces'].append({'name': display_name, 'ips': [ip_addr]})

        global _remote_flyos_version, _remote_board_name
        if _remote_flyos_version is None and 'VER' in sections:
            ver_line = sections['VER'].strip()
            import re as _re
            _ver_match = _re.search(r'FlyOS-Fast:\s*(v[\S]+)', ver_line)
            if _ver_match:
                _remote_flyos_version = _ver_match.group(1)
            else:
                _remote_flyos_version = ''

        if _remote_board_name is None and 'BRD' in sections:
            import re as _re
            _brd_match = _re.search(r'board_name=([^\s]+)', sections['BRD'].strip())
            if _brd_match:
                _remote_board_name = _brd_match.group(1)
            else:
                _remote_board_name = ''

        resources = {
            'cpu': cpu_info,
            'memory': mem_info,
            'disk': disk_info,
            'network': net_info
        }

        _remote_resource_cache.update(resources)
        _remote_resource_cache['timestamp'] = time.time()

        return resources
    except Exception as e:
        logger.error(f"远程资源采集失败: {e}")
        return None


def _update_ssh_disconnect_status():
    """更新 SSH 断连状态"""
    global _ssh_connection_status
    try:
        manager = SSHManager.get_instance()
        status = manager.get_connection_status()
        _ssh_connection_status.update({
            'connected': status['connected'],
            'circuit_open': status['circuit_open'],
            'consecutive_failures': status['consecutive_failures'],
            'cooldown_remaining': status['cooldown_remaining'],
            'cooldown_level': status['cooldown_level'],
        })
        if not status['connected'] and _ssh_connection_status.get('last_disconnect_time') is None:
            _ssh_connection_status['last_disconnect_time'] = datetime.now().isoformat()
    except Exception:
        _ssh_connection_status['connected'] = False


def resource_monitor():
    """后台线程：采集系统资源数据"""
    global _ssh_connection_status
    first_run = True
    _ssh_fail_count = 0
    _last_reconnect_attempt = 0
    while True:
        try:
            if is_ssh_mode():
                try:
                    resources = _collect_remote_resources()
                    if resources:
                        resource_history['cpu'].append(resources['cpu']['percent'])
                        resource_history['memory'].append(resources['memory']['percent'])
                        resource_history['disk'].append(resources['disk']['percent'])
                        resource_history['timestamps'].append(datetime.now().isoformat())
                        _ssh_fail_count = 0
                        if not _ssh_connection_status['connected']:
                            logger.info("SSH 连接已自动恢复")
                        _ssh_connection_status.update({
                            'connected': True,
                            'circuit_open': False,
                            'consecutive_failures': 0,
                            'cooldown_remaining': 0,
                            'cooldown_level': 0,
                            'reconnect_attempts': 0,
                            'last_disconnect_time': None,
                        })
                    else:
                        _ssh_fail_count += 1
                        if first_run:
                            logger.warning("远程资源采集返回 None， 可能 SSH 连接未建立")
                        _update_ssh_disconnect_status()
                except ConnectionError as e:
                    _ssh_fail_count += 1
                    if '不可用' in str(e) or '断路器' in str(e):
                        logger.debug(f"远程资源采集跳过: {e}")
                    else:
                        logger.warning(f"远程资源采集连接失败: {e}")
                    _update_ssh_disconnect_status()

                if _ssh_fail_count >= 3:
                    now = time.time()
                    reconnect_interval = min(
                        SSH_RECONNECT_COOLDOWN * (2 ** min(_ssh_connection_status['reconnect_attempts'], 4)),
                        SSH_RECONNECT_MAX_INTERVAL
                    )
                    if now - _last_reconnect_attempt >= reconnect_interval:
                        _last_reconnect_attempt = now
                        _ssh_connection_status['reconnect_attempts'] += 1
                        logger.info(
                            f"SSH 自动重连尝试 (第 {_ssh_connection_status['reconnect_attempts']} 次)..."
                        )
                        try:
                            manager = SSHManager.get_instance()
                            manager.disconnect()
                            manager.get_connection()
                            logger.info("SSH 自动重连成功")
                        except Exception as re:
                            logger.debug(f"SSH 自动重连失败: {re}")
                    time.sleep(5)
                else:
                    time.sleep(2)
                first_run = False
            else:
                cpu_percent = psutil.cpu_percent(interval=1)
                memory = psutil.virtual_memory()
                disk = psutil.disk_usage('/')

                resource_history['cpu'].append(cpu_percent)
                resource_history['memory'].append(memory.percent)
                resource_history['disk'].append((disk.used / disk.total) * 100)
                resource_history['timestamps'].append(datetime.now().isoformat())
                time.sleep(1)
        except Exception as e:
            logger.error(f"资源监控错误: {e}")
            time.sleep(3)


# 启动监控线程
monitor_thread = threading.Thread(target=resource_monitor, daemon=True)
monitor_thread.start()


# ==================== 页面路由 ====================
@system_bp.route('/')
def index():
    """主页面"""
    return send_from_directory('../static', 'index.html')


# ==================== 系统资源 API ====================
@system_bp.route('/api/system/resources')
def get_system_resources():
    """获取系统资源信息"""
    try:
        if is_ssh_mode():
            cached = _remote_resource_cache
            cpu_info = cached.get('cpu', {'percent': 0, 'freq': 0, 'count': 1})
            mem_info = cached.get('memory', {'total': 0, 'used': 0, 'percent': 0})
            disk_info = cached.get('disk', {'total': 0, 'used': 0, 'percent': 0})
            net_info = cached.get('network', {'interfaces': []})
        else:
            cpu_freq = psutil.cpu_freq()
            cpu_info = {
                'percent': psutil.cpu_percent(interval=0.1),
                'freq': round(cpu_freq.current / 1000, 2) if cpu_freq else 0,
                'count': psutil.cpu_count()
            }
            memory = psutil.virtual_memory()
            mem_info = {
                'total': round(memory.total / (1024**3), 1),
                'used': round(memory.used / (1024**3), 1),
                'percent': memory.percent
            }
            disk = psutil.disk_usage('/')
            disk_info = {
                'total': round(disk.total / (1024**3), 1),
                'used': round(disk.used / (1024**3), 1),
                'percent': round((disk.used / disk.total) * 100, 1)
            }
            net_info = {'interfaces': []}
            try:
                import socket
                interfaces = psutil.net_if_addrs()
                for iface_name, addrs in interfaces.items():
                    iface_lower = iface_name.lower()
                    if not (iface_lower.startswith('eth') or
                            iface_lower.startswith('en') or
                            iface_lower.startswith('wlan') or
                            iface_lower.startswith('wlo')):
                        continue
                    iface_lower = iface_name.lower()
                    if iface_lower.startswith('eth') or iface_lower.startswith('en'):
                        display_name = '网线'
                    elif iface_lower.startswith('wlan') or iface_lower.startswith('wlo'):
                        display_name = 'WiFi'
                    else:
                        display_name = iface_name
                    iface_info = {'name': display_name, 'ips': []}
                    for addr in addrs:
                        if addr.family == socket.AF_INET:
                            iface_info['ips'].append(addr.address)
                    if iface_info['ips']:
                        net_info['interfaces'].append(iface_info)
            except:
                try:
                    hostname = socket.gethostname()
                    net_info['interfaces'] = [{'name': 'default', 'ips': [socket.gethostbyname(hostname)]}]
                except:
                    net_info['interfaces'] = []

        service_status = {}
        try:
            for service in SERVICES:
                try:
                    result = run_cmd(
                        ['systemctl', 'is-active', service],
                        capture_output=True, text=True, timeout=2
                    )
                    service_status[service] = result.returncode == 0
                except Exception:
                    service_status[service] = False
        except ConnectionError:
            service_status = {s: False for s in SERVICES}

        return jsonify({
            'current': {
                'cpu': cpu_info,
                'memory': mem_info,
                'disk': disk_info,
                'network': net_info,
                'services': service_status,
                'flyos_version': _remote_flyos_version if is_fast_ssh_mode() else None,
                'board_name': _remote_board_name if is_fast_ssh_mode() else None
            },
            'history': {
                'cpu': list(resource_history['cpu']),
                'memory': list(resource_history['memory']),
                'disk': list(resource_history['disk']),
                'timestamps': list(resource_history['timestamps'])
            }
        })
    except Exception as e:
        return jsonify({'error': str(e)}), 500


# ==================== lsusb API ====================
@system_bp.route('/api/system/lsusb')
def get_lsusb():
    """获取 lsusb 完整输出"""
    search = request.args.get('search', '')
    default_exclude = ['Linux Foundation']
    try:
        output = run_cmd_check(['lsusb'], text=True)
        devices = []
        for line in output.strip().split('\n'):
            if not line.strip():
                continue
            line_lower = line.lower()
            if any(ex.lower() in line_lower for ex in default_exclude):
                continue
            if search and search.lower() in line_lower:
                continue
            match = re.match(r'Bus\s+(\d+)\s+Device\s+(\d+):\s+ID\s+(\S+)\s+(.*)', line)
            if match:
                bus, dev, usb_id, name = match.groups()
                devices.append({
                    'name': name.strip(),
                    'bus': bus,
                    'device': dev,
                    'usb_id': usb_id,
                    'formatted': f'Bus {bus} Device {dev}: ID {usb_id} {name.strip()}'
                })
            else:
                devices.append({'name': line.strip(), 'formatted': line.strip()})
        return jsonify({'devices': devices})
    except Exception as e:
        if isinstance(e, ConnectionError) or 'SSH' in str(e):
            return jsonify({'devices': [], 'error': f'SSH连接不可用: {e}'})
        return jsonify({'devices': [], 'error': str(e)})


# ==================== 串口设备详情 API ====================
@system_bp.route('/api/system/serial')
def get_serial_devices():
    """获取串口设备详细信息"""
    try:
        return _get_serial_devices()
    except Exception as e:
        import logging
        logging.error(f'获取串口设备失败: {e}')
        return jsonify({'devices': [], 'error': str(e)})


def _get_serial_devices():
    """获取串口设备（内部实现）"""
    devices = []

    if is_ssh_mode():
        try:
            result = run_cmd(
                'for p in /dev/serial/by-id/* /dev/serial/by-path/*; do '
                '[ -e "$p" ] || continue; '
                'echo "===DEV===$p"; '
                'udevadm info --query=property --name="$p" 2>/dev/null; '
                'done',
                shell=True, capture_output=True, text=True, timeout=10
            )
            output = result.stdout or ''

            current_path = None
            info = {}
            all_device_data = []
            for line in output.split('\n'):
                line_s = line.strip()
                if line_s.startswith('===DEV==='):
                    if current_path and info:
                        all_device_data.append((current_path, info))
                    current_path = line_s[9:]
                    info = {}
                elif '=' in line_s and current_path:
                    k, v = line_s.split('=', 1)
                    info[k] = v
            if current_path and info:
                all_device_data.append((current_path, info))

            for path, info in all_device_data:
                devlinks = info.get('DEVLINKS', '').split()
                by_id_link = ''
                for dl in devlinks:
                    if '/dev/serial/by-id/' in dl:
                        by_id_link = dl
                        break
                prefer_by_id = False
                if by_id_link:
                    by_id_lower = by_id_link.lower()
                    prefer_by_id = any(kw in by_id_lower for kw in [
                        'klipper', 'katapult', 'canboot', 'stm32', 'stm32f',
                        'atmel', 'samd', 'same', 'lpc', 'rp2040', 'raspberry'
                    ])
                display_path = by_id_link if (prefer_by_id and by_id_link) else path
                devices.append({
                    'path': path, 'by_id': by_id_link,
                    'display_path': display_path, 'prefer_by_id': prefer_by_id,
                    'devname': info.get('DEVNAME', ''), 'model': info.get('ID_MODEL', ''),
                    'vendor': info.get('ID_VENDOR', ''), 'vid': info.get('ID_VENDOR_ID', ''),
                    'pid': info.get('ID_USB_MODEL_ID', info.get('ID_MODEL_ID', '')),
                    'driver': info.get('ID_USB_DRIVER', ''),
                })
        except ConnectionError:
            pass
        except Exception:
            pass
    else:
        import glob
        serial_paths = glob.glob('/dev/serial/by-path/*')
        for path in serial_paths:
            try:
                info = {}
                output = run_cmd_check(
                    ['udevadm', 'info', '--query=property', '--name=' + path],
                    text=True, timeout=5
                )
                for line in output.strip().split('\n'):
                    if '=' in line:
                        k, v = line.split('=', 1)
                        info[k] = v
                devlinks = info.get('DEVLINKS', '').split()
                by_id_link = ''
                for dl in devlinks:
                    if '/dev/serial/by-id/' in dl:
                        by_id_link = dl
                        break
                prefer_by_id = False
                if by_id_link:
                    by_id_lower = by_id_link.lower()
                    prefer_by_id = any(kw in by_id_lower for kw in [
                        'klipper', 'katapult', 'canboot', 'stm32', 'stm32f',
                        'atmel', 'samd', 'same', 'lpc', 'rp2040', 'raspberry'
                    ])
                display_path = by_id_link if (prefer_by_id and by_id_link) else path
                devices.append({
                    'path': path, 'by_id': by_id_link,
                    'display_path': display_path, 'prefer_by_id': prefer_by_id,
                    'devname': info.get('DEVNAME', ''), 'model': info.get('ID_MODEL', ''),
                    'vendor': info.get('ID_VENDOR', ''), 'vid': info.get('ID_VENDOR_ID', ''),
                    'pid': info.get('ID_USB_MODEL_ID', info.get('ID_MODEL_ID', '')),
                    'driver': info.get('ID_USB_DRIVER', ''),
                })
            except Exception:
                continue

    seen = {}
    for d in devices:
        key = d['devname'] or d['by_id'] or d['path']
        if key not in seen:
            seen[key] = d
        else:
            if d['prefer_by_id'] and not seen[key]['prefer_by_id']:
                seen[key] = d
    devices = list(seen.values())
    return jsonify({'devices': devices})


# ==================== CAN接口列表 API ====================
@system_bp.route('/api/system/can-iface')
def get_can_interfaces():
    """获取可用CAN接口列表"""
    try:
        output = run_cmd_check(
            ['ip', '-d', '-j', 'link', 'show', 'type', 'can'],
            text=True, timeout=5
        )
        import json as _json
        ifaces_data = _json.loads(output) if output.strip() else []
        result = []
        for iface in ifaces_data:
            if isinstance(iface, dict) and iface.get('ifname'):
                result.append({
                    'ifname': iface.get('ifname', ''),
                    'operstate': iface.get('operstate', 'UNKNOWN'),
                    'flags': iface.get('flags', []),
                })
        return jsonify({'ifaces': result})
    except ConnectionError as e:
        return jsonify({'ifaces': [], 'error': f'SSH连接不可用: {e}'})
    except (subprocess.CalledProcessError, Exception):
        try:
            text_output = run_cmd_check(
                ['ip', '-d', 'link', 'show', 'type', 'can'],
                text=True, timeout=5
            )
            result = []
            for line in text_output.split('\n'):
                m = re.match(r'^\d+:\s+(\S+):\s+<[^>]*>.*\bstate\s+(\S+)', line)
                if m:
                    ifname = m.group(1)
                    state = m.group(2).upper()
                    result.append({'ifname': ifname, 'operstate': state, 'flags': []})
            return jsonify({'ifaces': result})
        except Exception as e:
            return jsonify({'ifaces': [], 'error': str(e)})


# ==================== CAN UUID 搜索辅助函数 ====================

def read_mcu_uuids_from_printer_cfg(content):
    """从 printer.cfg 内容中提取所有 MCU 段落的 canbus_uuid"""
    uuids = []
    current_section = None
    for line in content.split('\n'):
        line_stripped = line.strip()
        line_no_comment = re.sub(r'\s*#.*$', '', line_stripped).strip()
        if not line_no_comment:
            continue
        m = re.match(r'^\[mcu(\s+.+)?\]$', line_no_comment, re.IGNORECASE)
        if m:
            current_section = m.group(0)
            continue
        if current_section:
            m = re.match(r'^canbus_uuid\s*[:=]\s*([a-fA-F0-9]+)\s*$', line_no_comment)
            if m:
                uuid_val = m.group(1).lower()
                uuids.append({
                    'uuid': uuid_val,
                    'app': 'Klipper (config)',
                    'section': current_section,
                })
                current_section = None
    return uuids


def get_moonraker_base_url():
    """获取 Moonraker HTTP API 的基础 URL"""
    if is_ssh_mode():
        host = config.get('ssh_host', '127.0.0.1')
    else:
        host = config.get('moonraker_host', '127.0.0.1')
    port = config.get('moonraker_port', 7125)
    return f'http://{host}:{port}'


def query_moonraker_printer_cfg():
    """通过 Moonraker HTTP API 读取 printer.cfg 并提取 MCU UUID"""
    base = get_moonraker_base_url()
    try:
        r = requests.get(f'{base}/server/info', timeout=3)
        if r.status_code != 200:
            return [], False, None
        r = requests.get(f'{base}/server/files/config/printer.cfg', timeout=5)
        if r.status_code != 200:
            return [], True, None
        uuids = read_mcu_uuids_from_printer_cfg(r.text)
        return uuids, True, None
    except requests.ConnectionError:
        return [], False, 'Moonraker 连接失败'
    except requests.Timeout:
        return [], False, 'Moonraker 超时'
    except Exception as e:
        return [], True, str(e)


def read_printer_cfg_direct():
    """直接读取文件系统中的 printer.cfg"""
    _, home_dir = get_klipper_owner()
    candidates = [
        os.path.join(home_dir, 'printer_data', 'config', 'printer.cfg'),
        os.path.join(home_dir, 'klipper_config', 'printer.cfg'),
        os.path.join(home_dir, 'printer.cfg'),
    ]
    if is_ssh_mode():
        manager = SSHManager.get_instance()
        for path in candidates:
            try:
                result = manager.exec_command(f'cat "{path}" 2>/dev/null', timeout=5, inject_sudo=False)
                if result.returncode == 0 and result.stdout.strip():
                    uuids = read_mcu_uuids_from_printer_cfg(result.stdout)
                    if uuids:
                        logger.info(f"SSH 读取 printer.cfg 成功: {path}, 发现 {len(uuids)} 个 UUID")
                        return uuids, True
            except Exception as e:
                logger.warning(f"SSH 读取 {path} 失败: {e}")
                continue
        logger.warning("SSH 模式: 所有 printer.cfg 路径均无法读取")
        return [], False
    for path in candidates:
        if os.path.exists(path):
            try:
                with open(path) as f:
                    content = f.read()
                uuids = read_mcu_uuids_from_printer_cfg(content)
                if uuids:
                    return uuids, True
            except:
                continue
    return [], False


def _scan_can_uuids(iface='can0'):
    """统一的 CAN UUID 扫描函数"""
    try:
        klipper_owner, home_dir = get_klipper_owner()
        python_bin = get_klipper_python_bin(home_dir)
        canbus_script = os.path.join(home_dir, 'klipper', 'scripts', 'canbus_query.py')

        output = run_cmd(
            f'{python_bin} {canbus_script} {iface} 2>&1',
            shell=True, capture_output=True, text=True, timeout=10
        )

        devices = []
        error = None
        seen_uuids = set()

        if output.stdout:
            for line in output.stdout.strip().split('\n'):
                if 'Error' in line or 'Traceback' in line:
                    if not error:
                        error = line.strip()
                    continue
                if 'canbus_uuid' in line:
                    match = re.search(r'canbus_uuid=([a-fA-F0-9]+)', line)
                    if match:
                        uuid = match.group(1)
                        if uuid not in seen_uuids:
                            seen_uuids.add(uuid)
                            app_type = 'Klipper' if 'Klipper' in line else \
                                       'Katapult' if ('Katapult' in line or 'CanBoot' in line) else 'Unknown'
                            devices.append({'uuid': uuid, 'app': app_type, 'raw': line.strip()})

        if not devices and not error:
            error = '未找到CAN设备，请确认CAN接口已启用且设备处于Katapult/Klipper模式'
        return devices, error
    except subprocess.TimeoutExpired:
        return [], 'CAN查询超时'
    except Exception as e:
        return [], str(e)


def verify_mcu_connection_status(uuids):
    """通过 Moonraker 验证各 MCU 实际使用的传输方式"""
    if not uuids:
        return [], True

    base = get_moonraker_base_url()

    try:
        r = requests.get(f'{base}/server/info', timeout=3)
        if r.status_code != 200:
            return uuids, False

        section_names = list(dict.fromkeys(
            u.get('section', '').strip('[]') for u in uuids if u.get('section')
        ))
        if not section_names:
            return uuids, True

        r = requests.get(f'{base}/printer/objects/query?configfile', timeout=5)
        if r.status_code != 200:
            return uuids, True
        config_settings = r.json().get('result', {}).get('status', {}).get('configfile', {}).get('settings', {})

        can_sections = []
        can_uuid_map = {}
        for u in uuids:
            sname = u.get('section', '').strip('[]')
            if not sname:
                continue
            sec_cfg = config_settings.get(sname) or config_settings.get(sname.lower(), {})
            serial = sec_cfg.get('serial')
            canbus = sec_cfg.get('canbus_uuid')

            if serial:
                logger.info(
                    f"MCU 验证: [{sname}] active config 为串口(serial={serial}), "
                    f"canbus_uuid={canbus} 为残留，已跳过"
                )
                continue

            if canbus:
                can_sections.append(sname)
                can_uuid_map[sname] = u

        if not can_sections:
            return [], True

        r = requests.get(f'{base}/printer/objects/query?webhooks', timeout=5)
        webhooks_state = 'unknown'
        lost_mcus = []
        if r.status_code == 200:
            wh = r.json().get('result', {}).get('status', {}).get('webhooks', {})
            webhooks_state = wh.get('state', 'unknown')
            msg = wh.get('state_message', '')
            import re as _re
            for m in _re.finditer(r"Lost communication with MCU '([^']+)'", msg):
                lost_mcus.append(m.group(1))

        query_str = '&'.join(urllib.parse.quote(s) for s in can_sections)
        r = requests.get(f'{base}/printer/objects/query?{query_str}', timeout=5)
        if r.status_code != 200:
            return uuids, True

        mcu_statuses = r.json().get('result', {}).get('status', {})

        verified_uuids = []
        for sname in can_sections:
            mcu_status = mcu_statuses.get(sname) or mcu_statuses.get(sname.lower(), {})
            is_klipper_ready = (webhooks_state == 'ready')
            is_mcu_lost = sname in lost_mcus or sname.lower() in lost_mcus

            if not is_klipper_ready and is_mcu_lost:
                logger.info(
                    f"MCU 验证: [{sname}] Klipper 已断连 (state={webhooks_state}), 已跳过 "
                    f"(UUID={can_uuid_map[sname]['uuid']})"
                )
                continue

            if mcu_status.get('mcu_version'):
                entry = dict(can_uuid_map[sname])
                mcu_constants = mcu_status.get('mcu_constants', {})
                mcu_model = mcu_constants.get('MCU', '')
                if mcu_model:
                    entry['mcu_model'] = mcu_model.lower()
                entry['mcu_version'] = mcu_status.get('mcu_version', '')
                entry['mcu_freq'] = mcu_constants.get('CLOCK_FREQ', '')
                verified_uuids.append(entry)
                logger.info(
                    f"MCU 验证: [{sname}] 通过 CAN 已连接 "
                    f"(UUID={can_uuid_map[sname]['uuid']}, MCU={mcu_constants.get('MCU','?')})"
                )
            else:
                logger.info(
                    f"MCU 验证: [{sname}] 配置了 CAN 但 Klipper 未连接，已跳过 "
                    f"(UUID={can_uuid_map[sname]['uuid']})"
                )

        return verified_uuids, True
    except requests.ConnectionError:
        logger.warning("MCU 连接验证: Moonraker 连接失败，跳过验证")
        return uuids, False
    except Exception as e:
        logger.warning(f"MCU 连接验证出错: {e}")
        return uuids, True


# ==================== CAN UUID搜索 API ====================
@system_bp.route('/api/system/can-uuid', methods=['POST'])
def search_can_uuid():
    """通过指定CAN接口搜索UUID"""
    data = request.get_json() or {}
    iface = data.get('iface', 'can0')
    if not iface or not iface.startswith('can'):
        return jsonify({'uuids': [], 'error': '无效的CAN接口'})
    try:
        klipper_owner, home_dir = get_klipper_owner()
        python_bin = get_klipper_python_bin(home_dir)
        canbus_script = os.path.join(home_dir, 'klipper', 'scripts', 'canbus_query.py')
        output = run_cmd(
            f'{python_bin} {canbus_script} {iface}',
            shell=True, capture_output=True, text=True, timeout=10
        )
        uuids = []
        error = None
        combined = (output.stdout or '') + (output.stderr or '')
        for line in combined.strip().split('\n'):
            if 'canbus_uuid' in line:
                match = re.search(r'canbus_uuid=([a-fA-F0-9]+)', line)
                if match:
                    uuid_val = match.group(1)
                    app_type = 'Klipper' if 'Klipper' in line else \
                          'Katapult' if ('Katapult' in line or 'CanBoot' in line) else 'Unknown'
                    if not any(u['uuid'] == uuid_val for u in uuids):
                        uuids.append({'uuid': uuid_val, 'app': app_type})
            elif 'Error' in line or 'error' in line:
                if not error:
                    error = line.strip()
        if not uuids:
            error_msg = error
            mr_uuids, mr_available, mr_error = query_moonraker_printer_cfg()
            if mr_uuids:
                verified_uuids, _ = verify_mcu_connection_status(mr_uuids)
                for u in verified_uuids:
                    u['source'] = 'moonraker'
                return jsonify({
                    'uuids': verified_uuids, 'source': 'printer_cfg',
                    'moonraker_available': True, 'verified': True,
                    'skipped': len(mr_uuids) - len(verified_uuids),
                })
            fs_uuids, fs_available = read_printer_cfg_direct()
            if fs_uuids:
                verified_uuids, verifier_available = verify_mcu_connection_status(fs_uuids)
                for u in verified_uuids:
                    u['source'] = 'filesystem'
                return jsonify({
                    'uuids': verified_uuids, 'source': 'printer_cfg',
                    'moonraker_available': verifier_available,
                    'verified': verifier_available,
                    'skipped': len(fs_uuids) - len(verified_uuids),
                })
            return jsonify({
                'uuids': [], 'source': 'none',
                'moonraker_available': mr_available,
                'error': error_msg or 'Moonraker 不可达且无法读取 printer.cfg',
            })
        return jsonify({'uuids': uuids})
    except ConnectionError as e:
        return jsonify({'uuids': [], 'error': f'SSH连接不可用: {e}'})
    except subprocess.TimeoutExpired:
        return jsonify({'uuids': [], 'error': 'CAN查询超时'})
    except Exception as e:
        return jsonify({'uuids': [], 'error': str(e)})


# ==================== 摄像头详情 API ====================
@system_bp.route('/api/system/video')
def get_video_devices():
    """获取摄像头详细信息"""
    import glob
    devices = []
    video_paths = sorted(glob.glob('/dev/video*'))
    for path in video_paths:
        video_name = os.path.basename(path)
        name, index = 'Unknown', ''
        try:
            name_path = f'/sys/class/video4linux/{video_name}/name'
            if os.path.exists(name_path):
                with open(name_path) as f:
                    name = f.read().strip()
        except Exception:
            pass
        try:
            index_path = f'/sys/class/video4linux/{video_name}/index'
            if os.path.exists(index_path):
                with open(index_path) as f:
                    index = f.read().strip()
        except Exception:
            pass
        devices.append({'path': path, 'name': name, 'index': index})
    return jsonify({'videos': devices})


# ==================== CAN 烧录搜索 API ====================
@system_bp.route('/api/firmware/detect-can')
def detect_can_for_flash():
    """为固件烧录搜索 CAN UUID 设备"""
    iface = request.args.get('iface', 'can0')
    if not iface.startswith('can'):
        return jsonify({'devices': [], 'error': f'无效的CAN接口: {iface}'})
    try:
        devices, error = _scan_can_uuids(iface)
    except ConnectionError as e:
        return jsonify({'devices': [], 'error': f'SSH连接不可用: {e}'})
    simple_devices = [{'uuid': d['uuid']} for d in devices]
    return jsonify({'devices': simple_devices, 'error': error})


# ==================== ID搜索 API ====================
@system_bp.route('/api/system/ids')
def get_all_ids():
    """获取所有ID信息"""
    try:
        result = {'usb': [], 'can': [], 'camera': [], 'kat_usb': [], 'rp_boot': []}

        try:
            output = run_cmd(
                'ls /dev/serial/by-id/* 2>/dev/null || echo ""',
                shell=True, capture_output=True, text=True
            )
            if output.stdout:
                for line in output.stdout.strip().split('\n'):
                    if '/dev/serial/by-id/' in line:
                        device_id = line.strip()
                        formatted = f"serial: {device_id}"
                        result['usb'].append({'raw': device_id, 'formatted': formatted})
                        result['kat_usb'].append({'raw': device_id, 'formatted': f'USB: {device_id}'})
        except:
            pass

        try:
            output = run_cmd(
                'sudo dfu-util -l 2>/dev/null | grep "Found DFU" || echo ""',
                shell=True, capture_output=True, text=True
            )
            if output.stdout and 'Found DFU' in output.stdout:
                dfu_devices = []
                seen = set()
                for line in output.stdout.strip().split('\n'):
                    if 'Found DFU' not in line:
                        continue
                    vid_pid_match = re.search(r'\[([0-9a-f]{4}:[0-9a-f]{4})\]', line, re.IGNORECASE)
                    if not vid_pid_match:
                        continue
                    vid_pid = vid_pid_match.group(1).lower()
                    if vid_pid in seen:
                        continue
                    seen.add(vid_pid)
                    chip_name = DFU_KNOWN_DEVICES.get(vid_pid, '')
                    label = f'{chip_name} DFU ({vid_pid})' if chip_name else f'DFU ({vid_pid})'
                    dfu_devices.append({'raw': f'dfu:{vid_pid}', 'formatted': label})
                if dfu_devices:
                    result['dfu'] = dfu_devices
        except:
            pass

        try:
            devices, error = _scan_can_uuids('can0')
            for d in devices:
                formatted = f"canbus_uuid: {d['uuid']}"
                result['can'].append({'raw': d['uuid'], 'formatted': formatted, 'app': d.get('app', 'Unknown')})
            if error:
                result['can_error'] = error
        except Exception as e:
            import logging
            logging.error(f'CAN设备检测失败：{e}')

        try:
            output = run_cmd(
                'ls /dev/video* 2>/dev/null || echo ""',
                shell=True, capture_output=True, text=True
            )
            if output.stdout:
                for line in output.stdout.strip().split('\n'):
                    if '/dev/video' in line:
                        result['camera'].append(line.strip())
        except:
            pass

        try:
            lsblk_output = run_cmd(
                'lsblk -o NAME,MODEL 2>/dev/null | grep -i "RP2"',
                shell=True, capture_output=True, text=True
            )
            if lsblk_output.stdout.strip():
                for line in lsblk_output.stdout.strip().split('\n'):
                    if line.strip():
                        result['rp_boot'].append({
                            'raw': 'rp2040_boot',
                            'formatted': f'RP2040 BOOT设备 ({line.strip()})'
                        })
            if not result['rp_boot']:
                lsusb_output = run_cmd(
                    'lsusb | grep -i "2e8a:" 2>/dev/null || echo ""',
                    shell=True, capture_output=True, text=True
                )
                if lsusb_output.stdout.strip() and '2e8a:' in lsusb_output.stdout:
                    result['rp_boot'].append({
                        'raw': 'rp2040_boot',
                        'formatted': 'RP2040 BOOT设备 (USB 2e8a)'
                    })
        except:
            pass

        return jsonify(result)
    except ConnectionError as e:
        return jsonify({'usb': [], 'can': [], 'camera': [], 'kat_usb': [], 'rp_boot': [], 'error': f'SSH连接不可用: {e}'})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


# ==================== 版本与服务 API ====================
@system_bp.route('/api/system/versions', methods=['GET'])
def get_versions():
    """获取Klipper版本信息"""
    result = {'klipper_version': None}
    try:
        klipper_path = expand_klipper_path(config.get('klipper_path', '~/klipper'))
        if path_exists(os.path.join(klipper_path, '.git')):
            output = run_cmd(
                ['git', '-C', klipper_path, 'describe', '--tags', '--always'],
                capture_output=True, text=True, timeout=5
            )
            if output.returncode == 0:
                result['klipper_version'] = output.stdout.strip()
        else:
            result['klipper_version'] = '未安装'
    except Exception as e:
        logger.warning(f"获取Klipper版本失败: {e}")
        result['klipper_version'] = '获取失败'
    return jsonify(result)


@system_bp.route('/api/system/services', methods=['GET'])
def get_available_services():
    """获取系统中实际安装的服务及其状态（优先通过 Moonraker API 获取）"""
    systemd_services = ['klipper', 'moonraker', 'KlipperScreen', 'crowsnest', 'firmware-tool']
    web_frontends = {
        'mainsail': {
            'nginx_configs': ['/etc/nginx/sites-enabled/mainsail', '/etc/nginx/conf.d/mainsail.conf'],
            'web_roots': ['/home/pi/mainsail', '/home/fenghua/mainsail', '/usr/share/mainsail'],
        },
        'fluidd': {
            'nginx_configs': ['/etc/nginx/sites-enabled/fluidd', '/etc/nginx/conf.d/fluidd.conf'],
            'web_roots': ['/home/pi/fluidd', '/home/fenghua/fluidd', '/usr/share/fluidd'],
        },
    }

    # 通过 Moonraker system_info 获取所有服务的安装和运行状态
    moonraker_active = False
    klipper_active = False
    mr_base = get_moonraker_base_url()
    mr_service_state = {}  # Moonraker system_info 中的服务状态 {name: {active_state, sub_state}}
    try:
        r = requests.get(f'{mr_base}/server/info', timeout=3)
        if r.status_code == 200:
            info = r.json().get('result', {})
            moonraker_active = True
            klipper_active = info.get('klippy_connected', False)
    except Exception:
        pass

    # 通过 Moonraker machine/system_info 获取所有服务的状态
    try:
        r2 = requests.get(f'{mr_base}/machine/system_info', timeout=5)
        if r2.status_code == 200:
            sys_info = r2.json().get('result', {}).get('system_info', {})
            mr_service_state = sys_info.get('service_state', {})
    except Exception:
        pass

    # 检测 nginx 状态（用于 web 前端）
    try:
        nginx_result = run_cmd(['systemctl', 'is-active', 'nginx'],
                                    capture_output=True, text=True, timeout=5)
        nginx_active = nginx_result.returncode == 0
    except Exception:
        nginx_active = False

    # 构建 Moonraker 服务状态的小写映射（处理名称变体，如 helixscreen → KlipperScreen）
    mr_state_map = {}
    for svc_name, state_info in mr_service_state.items():
        mr_state_map[svc_name.lower()] = state_info

    # 已知的服务名称别名映射
    service_aliases = {
        'klipperscreen': ['helixscreen'],  # KlipperScreen 在某些发行版中可能叫 helixscreen
    }

    available_services = []
    for service in systemd_services:
        try:
            svc_lower = service.lower()

            if service == 'firmware-tool':
                # 自身服务，能响应请求说明一定在运行
                available_services.append({'name': service, 'active': True, 'self_service': True})
                continue

            # 优先通过 Moonraker system_info 判断服务是否安装及运行状态
            mr_state = mr_state_map.get(svc_lower)
            # 检查别名（如 KlipperScreen 可能注册为 helixscreen）
            if mr_state is None and svc_lower in service_aliases:
                for alias in service_aliases[svc_lower]:
                    if alias in mr_state_map:
                        mr_state = mr_state_map[alias]
                        break
            if mr_state is not None:
                is_installed = True
                is_active = mr_state.get('active_state') == 'active'
            else:
                # 回退到 systemctl 检测
                is_installed = False
                is_active = False
                # 检查主名称和别名
                check_names = [service]
                if svc_lower in service_aliases:
                    check_names.extend(service_aliases[svc_lower])
                for check_name in check_names:
                    result = run_cmd(['systemctl', 'list-unit-files', f'{check_name}.service'],
                                          capture_output=True, text=True, timeout=5)
                    if result.returncode == 0 and f'{check_name}.service' in result.stdout:
                        is_installed = True
                        status_result = run_cmd(['systemctl', 'is-active', check_name],
                                                     capture_output=True, text=True, timeout=5)
                        is_active = status_result.returncode == 0
                        break

            if is_installed:
                # klipper 使用 Moonraker klippy_connected 状态更准确
                if service == 'klipper' and moonraker_active:
                    is_active = klipper_active
                available_services.append({'name': service, 'active': is_active})
        except Exception as e:
            logger.warning(f'检查服务 {service} 状态失败: {e}')
            continue

    for frontend_name, paths in web_frontends.items():
        try:
            config_exists = any(os.path.isfile(cfg) for cfg in paths['nginx_configs'])
            root_exists = any(os.path.isdir(root) for root in paths['web_roots'])
            if config_exists or root_exists:
                available_services.append({'name': frontend_name, 'active': nginx_active})
        except Exception as e:
            logger.warning(f'检查 Web 前端 {frontend_name} 失败: {e}')
            continue

    return jsonify({'services': available_services})


@system_bp.route('/api/system/service', methods=['POST'])
def control_service():
    """控制服务（启动/停止/重启）"""
    data = request.json
    service_name = data.get('service')
    action = data.get('action')

    if not service_name or not action:
        return jsonify({'success': False, 'error': '缺少服务名或操作'}), 400
    if action not in ['start', 'stop', 'restart']:
        return jsonify({'success': False, 'error': '无效的操作'}), 400

    nginx_frontends = ['mainsail', 'fluidd']
    if service_name in nginx_frontends:
        service_name = 'nginx'

    # firmware-tool 重启自身时，需要用后台方式执行，否则当前进程会被杀掉无法返回响应
    if service_name == 'firmware-tool' and action == 'restart':
        import subprocess as _sp
        _sp.Popen(['sudo', 'systemctl', 'restart', 'firmware-tool'],
                   stdout=_sp.DEVNULL, stderr=_sp.DEVNULL)
        return jsonify({'success': True, 'message': 'firmware-tool 正在重启...'})

    try:
        result = run_cmd(['sudo', 'systemctl', action, service_name],
                              capture_output=True, text=True, timeout=30)
        if result.returncode == 0:
            return jsonify({'success': True, 'message': f'{service_name} {action} 成功'})
        else:
            return jsonify({'success': False, 'error': result.stderr or '命令执行失败'}), 500
    except subprocess.TimeoutExpired:
        return jsonify({'success': False, 'error': '服务操作超时'}), 500
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


@system_bp.route('/api/system/check-update', methods=['GET'])
def check_update():
    """检查项目更新"""
    try:
        import pwd
        stat_info = os.stat(BASE_DIR)
        uid = stat_info.st_uid
        user_info = pwd.getpwuid(uid)
        username = user_info.pw_name
        home_dir = user_info.pw_dir

        env = os.environ.copy()
        env['HOME'] = home_dir
        env['USER'] = username

        run_cmd(
            ['git', 'config', '--global', '--add', 'safe.directory', BASE_DIR],
            capture_output=True, env=env
        )

        current_output = run_cmd(
            ['git', '-C', BASE_DIR, 'rev-parse', '--short', 'HEAD'],
            capture_output=True, text=True, timeout=10, env=env
        )
        current_version = current_output.stdout.strip() if current_output.returncode == 0 else 'unknown'

        run_cmd(
            ['git', '-C', BASE_DIR, 'fetch', 'origin'],
            capture_output=True, timeout=30, env=env
        )

        remote_output = run_cmd(
            ['git', '-C', BASE_DIR, 'rev-parse', '--short', 'origin/main'],
            capture_output=True, text=True, timeout=10, env=env
        )
        latest_version = remote_output.stdout.strip() if remote_output.returncode == 0 else current_version

        has_update = current_version != latest_version
        update_time = None
        if has_update:
            time_output = run_cmd(
                ['git', '-C', BASE_DIR, 'log', '-1', '--format=%cd', '--date=iso', 'origin/main'],
                capture_output=True, text=True, timeout=10, env=env
            )
            update_time = time_output.stdout.strip() if time_output.returncode == 0 else None

        return jsonify({
            'has_update': has_update,
            'current_version': current_version,
            'latest_version': latest_version,
            'update_time': update_time
        })
    except Exception as e:
        logger.error(f"检查更新失败: {e}")
        return jsonify({'error': str(e)}), 500


@system_bp.route('/api/system/update', methods=['POST'])
def update_project():
    """执行项目更新"""
    def generate():
        try:
            import pwd
            stat_info = os.stat(BASE_DIR)
            uid = stat_info.st_uid
            user_info = pwd.getpwuid(uid)
            home_dir = user_info.pw_dir

            env = os.environ.copy()
            env['HOME'] = home_dir
            env['USER'] = user_info.pw_name

            run_cmd(
                ['git', 'config', '--global', '--add', 'safe.directory', BASE_DIR],
                capture_output=True, env=env
            )

            yield "开始更新 Firmware-Tool...\n"
            yield "保存当前配置...\n"
            config_backup = None
            if os.path.exists(CONFIG_PATH):
                with open(CONFIG_PATH, 'r') as f:
                    config_backup = f.read()

            yield "拉取最新代码...\n"
            result = run_cmd(
                ['git', '-C', BASE_DIR, 'pull', 'origin', 'main'],
                capture_output=True, text=True, timeout=60, env=env
            )
            yield result.stdout
            if result.stderr:
                yield f"警告: {result.stderr}\n"

            if result.returncode != 0:
                yield f"错误: git pull 失败\n"
                return

            if config_backup:
                yield "恢复配置...\n"
                with open(CONFIG_PATH, 'w') as f:
                    f.write(config_backup)

            yield "重启服务...\n"
            restart_result = run_cmd(
                ['sudo', 'systemctl', 'restart', 'firmware-tool'],
                capture_output=True, text=True, timeout=30
            )

            if restart_result.returncode == 0:
                yield "服务重启成功！\n"
            else:
                yield f"服务重启失败: {restart_result.stderr}\n"

            yield "更新完成！\n"

        except subprocess.TimeoutExpired:
            yield "错误: 操作超时\n"
        except Exception as e:
            yield f"错误: {str(e)}\n"

    return Response(generate(), mimetype='text/plain')
