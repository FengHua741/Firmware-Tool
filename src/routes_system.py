"""
系统管理蓝图 - 系统资源监控、设备检测、服务管理等
"""

from flask import Blueprint, jsonify, request, send_from_directory
import subprocess
import os
import re
import shlex
import time
import json
import glob
import socket
import psutil
import requests
import threading
import urllib.parse
from datetime import datetime
from collections import deque

from shared import (
    config, logger, BASE_DIR,
    DFU_KNOWN_DEVICES, DFU_KNOWN_VIDPIDS,
    run_cmd, run_cmd_check, path_exists, list_dir, is_ssh_mode, is_fast_remote,
    SSHManager, get_klipper_owner, get_klipper_python_bin, expand_klipper_path,
    get_moonraker_base_url,
    CSRF_COOKIE_NAME, new_csrf_token,
    safe_error,
    load_all_boards,
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
SERVICE_CONTROL_ALIASES = {
    'klipper': 'klipper',
    'moonraker': 'moonraker',
    'nginx': 'nginx',
    'crowsnest': 'crowsnest',
    'klipperscreen': 'KlipperScreen',
    'helixscreen': 'Helixscreen',
    'firmware-tool': 'firmware-tool',
    'mainsail': 'nginx',
    'fluidd': 'nginx',
}


def _normalize_service_name(service_name):
    key = str(service_name or '').strip().lower()
    if key in SERVICE_CONTROL_ALIASES:
        return SERVICE_CONTROL_ALIASES[key]
    return ''

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


def _get_disk_usage():
    """获取磁盘使用情况：优先选择容量最大的真实数据分区。

    FlyOS-Fast 的 / 是只读 squashfs 系统分区（通常 100% 占用），
    真实数据分区是 /overlay，必须跳过虚拟/只读文件系统避免误报。
    """
    try:
        best = None
        for part in psutil.disk_partitions(all=False):
            dev = (part.device or '').lower()
            fstype = (part.fstype or '').lower()
            mp = part.mountpoint
            # 跳过虚拟/只读/临时文件系统（含 overlay 挂载与 squashfs 只读根分区）
            if (fstype in ('tmpfs', 'devtmpfs', 'squashfs', 'ramfs', 'overlay', 'overlayfs', 'zram')
                    or 'overlay' in dev or dev.startswith('/dev/zram')
                    or mp.startswith(('/run/', '/dev/', '/sys/', '/proc/', '/var/log'))):
                continue
            try:
                usage = psutil.disk_usage(mp)
            except OSError:
                continue
            if usage.total <= 0:
                continue
            if best is None or usage.total > best.total:
                best = usage
        return best or psutil.disk_usage('/')
    except Exception:
        try:
            return psutil.disk_usage('/')
        except Exception:
            return None


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
            "echo '===DSK==='; df -B1 --output=source,size,used,target 2>/dev/null | grep -vE '^(tmpfs|devtmpfs|overlayfs|squashfs|Filesystem|/dev/zram)' | sort -k2 -rn | head -1; "
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
        if not _remote_flyos_version and 'VER' in sections:
            ver_line = sections['VER'].strip()
            _ver_match = re.search(r'FlyOS-Fast:\s*(v[\S]+)', ver_line)
            if _ver_match:
                _remote_flyos_version = _ver_match.group(1)
            else:
                _remote_flyos_version = ''

        if not _remote_board_name and 'BRD' in sections:
            _brd_match = re.search(r'board_name=([^\s]+)', sections['BRD'].strip())
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
                        except Exception as reconn_err:
                            logger.debug(f"SSH 自动重连失败: {reconn_err}")
                    time.sleep(5)
                else:
                    time.sleep(2)
                first_run = False
            else:
                cpu_percent = psutil.cpu_percent(interval=1)
                memory = psutil.virtual_memory()
                disk = _get_disk_usage() or psutil.disk_usage('/')

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
    response = send_from_directory('../static', 'index.html')
    # 与 /static/ 一致：禁用缓存，确保页面更新后浏览器能立即拿到最新版本
    response.headers['Cache-Control'] = 'no-cache, no-store, must-revalidate'
    response.headers['Pragma'] = 'no-cache'
    response.headers['Expires'] = '0'
    response.set_cookie(
        CSRF_COOKIE_NAME, new_csrf_token(),
        samesite='Lax', secure=request.is_secure, httponly=False
    )
    return response


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
            disk = _get_disk_usage() or psutil.disk_usage('/')
            disk_info = {
                'total': round(disk.total / (1024**3), 1),
                'used': round(disk.used / (1024**3), 1),
                'percent': round((disk.used / disk.total) * 100, 1)
            }
            net_info = {'interfaces': []}
            try:
                interfaces = psutil.net_if_addrs()
                for iface_name, addrs in interfaces.items():
                    iface_lower = iface_name.lower()
                    if not (iface_lower.startswith('eth') or
                            iface_lower.startswith('en') or
                            iface_lower.startswith('wlan') or
                            iface_lower.startswith('wlo')):
                        continue
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
            except Exception:
                try:
                    hostname = socket.gethostname()
                    net_info['interfaces'] = [{'name': 'default', 'ips': [socket.gethostbyname(hostname)]}]
                except Exception:
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

        response_data = {
            'current': {
                'cpu': cpu_info,
                'memory': mem_info,
                'disk': disk_info,
                'network': net_info,
                'services': service_status,
                'flyos_version': _remote_flyos_version if is_fast_remote() else None,
                'board_name': _remote_board_name if is_fast_remote() else None
            }
        }
        if not request.args.get('no_history'):
            response_data['history'] = {
                'cpu': list(resource_history['cpu']),
                'memory': list(resource_history['memory']),
                'disk': list(resource_history['disk']),
                'timestamps': list(resource_history['timestamps'])
            }
        return jsonify(response_data)
    except Exception as e:
        return jsonify({'error': safe_error(e)}), 500


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
        return jsonify({'devices': [], 'error': safe_error(e)})


# ==================== 串口设备详情 API ====================
@system_bp.route('/api/system/serial')
def get_serial_devices():
    """获取串口设备详细信息"""
    try:
        return _get_serial_devices()
    except Exception as e:
        logger.error(f'获取串口设备失败: {e}')
        return jsonify({'devices': [], 'error': safe_error(e)})


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
        ifaces_data = json.loads(output) if output.strip() else []
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
            return jsonify({'ifaces': [], 'error': safe_error(e)})


# ==================== CAN UUID 搜索辅助函数 ====================

CAN_IFACE_RE = re.compile(r'^can[\w.-]*$')
LOCAL_CANBUS_QUERY_SCRIPT = os.path.join(BASE_DIR, 'src', 'canbus_query.py')


def _is_valid_can_iface(iface):
    return bool(iface and CAN_IFACE_RE.match(str(iface)))


def _get_canbus_query_script(home_dir):
    """返回用于 CAN UUID 查询的脚本路径。

    本地模式优先使用仓库内增强脚本；SSH 模式把增强脚本上传到远端临时目录。
    失败时回退到 Klipper 自带脚本，保持旧环境可用。
    """
    klipper_script = os.path.join(home_dir, 'klipper', 'scripts', 'canbus_query.py')
    if not os.path.exists(LOCAL_CANBUS_QUERY_SCRIPT):
        return klipper_script, 'klipper'

    if not is_ssh_mode():
        return LOCAL_CANBUS_QUERY_SCRIPT, 'firmware-tool'

    try:
        from ssh_manager import ssh_upload
        remote_path = '/tmp/firmware-tool-canbus_query.py'
        return ssh_upload(LOCAL_CANBUS_QUERY_SCRIPT, remote_path), 'firmware-tool'
    except Exception as e:
        logger.warning(f"增强 CAN 查询脚本上传失败，回退到 Klipper 脚本: {e}")
        return klipper_script, 'klipper'


def _normalize_can_app(line):
    if 'Klipper' in line:
        return 'Klipper'
    if 'Katapult' in line or 'CanBoot' in line:
        return 'Katapult'
    return 'Unknown'


def _set_device_field(device, key, value, source):
    if value is None or value == '':
        return
    device[key] = value
    sources = device.setdefault('field_sources', {})
    sources[key] = source


def _truthy_constant(value):
    if isinstance(value, bool):
        return value
    raw = str(value or '').strip().lower()
    return raw not in ('', '0', 'false', 'none', 'no')


def _normalize_mcu_name(value):
    value = str(value or '').strip().lower()
    value = re.sub(r'[^a-z0-9]', '', value)
    if value.endswith('xx'):
        value = value[:-2]
    return value


def _offset_int(value):
    raw = str(value or '').strip()
    if not raw:
        return None
    try:
        return int(raw, 0)
    except ValueError:
        return None


def _format_offset_label(offset):
    offset_int = _offset_int(offset)
    if offset_int is None:
        return ''
    if offset_int == 0:
        return 'No bootloader'
    if offset_int % 1024 == 0:
        return f'{offset_int // 1024}KiB'
    return f'{offset_int} bytes'


def _flash_base_for_mcu(mcu_model):
    mcu = _normalize_mcu_name(mcu_model)
    if mcu.startswith('rp2040') or mcu.startswith('rp2350') or mcu.startswith('rpxxxx'):
        return 0x10000000
    if mcu.startswith('stm32'):
        return 0x08000000
    return None


def _parse_frequency_hz(value):
    if value is None or value == '':
        return ''
    raw = str(value).strip().lower()
    if raw in ('internal', 'int'):
        return 'internal'
    try:
        num = float(raw)
        if num <= 0:
            return ''
        if num == 1:
            return 'internal'
        return str(int(num))
    except (TypeError, ValueError):
        pass

    match = re.search(r'(\d+(?:\.\d+)?)\s*(mhz|m|khz|k|hz)?', raw)
    if not match:
        return ''
    num = float(match.group(1))
    unit = match.group(2) or 'hz'
    if unit in ('mhz', 'm'):
        num *= 1000000
    elif unit in ('khz', 'k'):
        num *= 1000
    if num <= 0:
        return ''
    if int(num) == 1:
        return 'internal'
    return str(int(num))


def _crystal_label(value):
    if value == 'internal':
        return 'Internal clock'
    freq = _parse_frequency_hz(value)
    if not freq or freq == 'internal':
        return 'Internal clock' if freq == 'internal' else ''
    num = int(freq)
    if num >= 1000000 and num % 1000000 == 0:
        return f'{num // 1000000} MHz'
    if num >= 1000000:
        return f'{num / 1000000:.2f}'.rstrip('0').rstrip('.') + ' MHz'
    if num >= 1000 and num % 1000 == 0:
        return f'{num // 1000} kHz'
    if num >= 1000:
        return f'{num / 1000:.2f}'.rstrip('0').rstrip('.') + ' kHz'
    return f'{num} Hz'


def _crystal_from_config_symbol(key):
    key = str(key or '').upper()
    if key.endswith('CLOCK_REF_INTERNAL') or key.endswith('CRYSTAL_INTERNAL'):
        return 'internal'
    if 'CLOCK_REF_X32K' in key or 'CRYSTAL_X32K' in key:
        return '32768'
    match = re.search(r'(?:CLOCK_REF|CRYSTAL|XOSC|HSE)_X?(\d+)M\b', key)
    if match:
        return str(int(match.group(1)) * 1000000)
    return ''


def _extract_crystal_from_constants(constants):
    direct_keys = (
        'CLOCK_REF_FREQ', 'CRYSTAL_FREQ', 'XOSC_FREQ', 'HSE_FREQ',
        'OSC_FREQ', 'EXTERNAL_CLOCK_FREQ',
    )
    for key in direct_keys:
        freq = _parse_frequency_hz(constants.get(key))
        if freq:
            return freq

    for key, value in constants.items():
        if not _truthy_constant(value):
            continue
        freq = _crystal_from_config_symbol(key)
        if freq:
            return freq
    return ''


def _extract_device_constants(device, constants, source):
    constants = constants or {}
    if not isinstance(constants, dict):
        return

    if constants:
        device['mcu_constants'] = constants

    mcu_model = constants.get('MCU')
    if mcu_model:
        _set_device_field(device, 'mcu_model', str(mcu_model).lower(), source)

    _set_device_field(device, 'mcu_freq', constants.get('CLOCK_FREQ'), source)
    _set_device_field(device, 'canbus_frequency', constants.get('CANBUS_FREQUENCY'), source)
    _set_device_field(device, 'startup_pin', constants.get('INITIAL_PINS'), source)
    crystal = _extract_crystal_from_constants(constants)
    if crystal:
        _set_device_field(device, 'crystal', crystal, source)
        _set_device_field(device, 'crystal_label', _crystal_label(crystal), source)

    connection_pins = {}
    for key, value in constants.items():
        if key.startswith('RESERVE_PINS_') and value:
            connection_pins[key.replace('RESERVE_PINS_', '').lower()] = value
    if connection_pins:
        _set_device_field(device, 'connection_pins', connection_pins, source)

    can_pins = constants.get('RESERVE_PINS_CAN')
    if can_pins:
        _set_device_field(device, 'can_pins', can_pins, source)
        parts = [p.strip() for p in str(can_pins).split(',') if p.strip()]
        if len(parts) >= 2:
            _set_device_field(device, 'can_rx_pin', parts[0], source)
            _set_device_field(device, 'can_tx_pin', parts[1], source)
    crystal_pins = constants.get('RESERVE_PINS_crystal') or constants.get('RESERVE_PINS_CRYSTAL')
    if crystal_pins:
        _set_device_field(device, 'crystal_pins', crystal_pins, source)

    if _truthy_constant(constants.get('CANBUS_BRIDGE')):
        _set_device_field(device, 'inferred_connection', 'USB桥接CAN', 'firmware_inferred')
    elif constants.get('CANBUS_FREQUENCY') or can_pins:
        _set_device_field(device, 'inferred_connection', 'CANBUS', 'firmware_inferred')


def _format_gpio_pin(value):
    if value is None or value == '':
        return ''
    raw = str(value).strip()
    if re.fullmatch(r'\d+', raw):
        return f'gpio{raw}'
    return raw


def _board_led_pin(board):
    for key in ('katapult_led_pin', 'status_led_pin', 'led_pin', 'status_led', 'led'):
        value = board.get(key)
        if value:
            return value
    return ''


def _normalize_connection_label(value):
    raw = str(value or '').strip()
    if not raw:
        return ''
    compact = re.sub(r'[\s_\-()/]+', '', raw).lower()
    if 'usb' in compact and 'can' in compact:
        return 'USB桥接CAN'
    if 'canbus' in compact or compact == 'can' or 'can总线' in raw.lower():
        return 'CANBUS'
    if 'usb' in compact:
        return 'USB'
    if 'serial' in compact or 'uart' in compact or '串口' in raw:
        return '串口/UART'
    return raw


def _unique_labels(labels):
    result = []
    seen = set()
    for label in labels:
        if not label or label in seen:
            continue
        seen.add(label)
        result.append(label)
    return result


def _board_connection_labels(board):
    labels = []
    for item in board.get('connections') or []:
        labels.append(_normalize_connection_label(item))
    labels.append(_normalize_connection_label(board.get('default_connection')))

    flash_values = [board.get('default_flash')]
    flash_values.extend(board.get('flash_modes') or [])
    if any(str(mode or '').upper() == 'CAN_BRIDGE_KAT' for mode in flash_values):
        labels.append('USB桥接CAN')

    return _unique_labels(labels)


def _preferred_connection_label(labels, device):
    labels = _unique_labels(labels)
    if not labels:
        if device.get('canbus_frequency') or device.get('can_pins'):
            return 'CANBUS'
        return ''

    for preferred in ('USB桥接CAN', 'CANBUS', 'USB', '串口/UART'):
        if preferred in labels:
            return preferred
    return labels[0]


def _candidate_connection_summary(candidates, device):
    option_sets = []
    options = []
    for _score, _manufacturer, _board_type, _board_id, board in candidates:
        labels = _board_connection_labels(board)
        if labels:
            option_sets.append(set(labels))
            options.extend(labels)

    options = _unique_labels(options)
    common = []
    if option_sets:
        common_set = set.intersection(*option_sets)
        common = [label for label in options if label in common_set]

    label = _preferred_connection_label(common or options, device)
    return {
        'connection_label': label,
        'connection_options': options,
        'connection_common': common,
    }


def _board_match_score(board, device):
    board_mcu = _normalize_mcu_name(board.get('mcu') or board.get('processor'))
    dev_mcu = _normalize_mcu_name(device.get('mcu_model'))
    if dev_mcu and board_mcu and not (dev_mcu == board_mcu or dev_mcu.startswith(board_mcu) or board_mcu.startswith(dev_mcu)):
        return -1

    score = 0
    if dev_mcu and board_mcu:
        score += 2

    dev_offset = _offset_int(device.get('bl_offset'))
    board_offset = _offset_int(board.get('bl_offset') or board.get('bootloader_offset'))
    if dev_offset is not None and board_offset is not None:
        if dev_offset == board_offset:
            score += 2
        else:
            return -1

    section = str(device.get('section') or '').lower()
    if section:
        board_id = str(board.get('id') or '').lower()
        board_name = str(board.get('name') or '').lower()
        section_compact = re.sub(r'[^a-z0-9]', '', section)
        board_compact = re.sub(r'[^a-z0-9]', '', f'{board_id} {board_name}')
        if board_compact and len(board_compact) >= 4 and board_compact in section_compact:
            score += 8
        board_tokens = [token for token in re.split(r'[^a-z0-9]+', f'{board_id} {board_name}') if len(token) >= 3]
        if any(token in section for token in board_tokens):
            score += 4

    return score


def _apply_can_mcu_defaults(device):
    """补充无法从运行中固件实读、但编译时必须明确的 CAN MCU 默认值。"""
    mcu_model = _normalize_mcu_name(device.get('mcu_model'))
    connection = _normalize_connection_label(device.get('inferred_connection'))
    is_can = connection == 'CANBUS' or bool(device.get('canbus_frequency') or device.get('can_pins'))
    if mcu_model == 'rp2040' and is_can and not device.get('bl_offset'):
        _set_device_field(device, 'bl_offset', '16384', 'mcu_can_default')
        _set_device_field(device, 'bl_offset_hex', '0x4000', 'mcu_can_default')
        _set_device_field(device, 'bl_offset_label', '16 KB', 'mcu_can_default')
    return device


def _infer_board_fields(device):
    try:
        boards = load_all_boards()
    except Exception as e:
        logger.warning(f'板卡数据库加载失败，跳过 KAT 引脚推断: {e}')
        return _apply_can_mcu_defaults(device)

    candidates = []
    for manufacturer, type_map in (boards or {}).items():
        for board_type, board_map in (type_map or {}).items():
            for board_id, board in (board_map or {}).items():
                score = _board_match_score(board, device)
                if score > 0:
                    candidates.append((score, manufacturer, board_type, board_id, board))

    if not candidates:
        label = _preferred_connection_label([], device)
        if label:
            _set_device_field(device, 'inferred_connection', label, 'klipper_identify')
        return _apply_can_mcu_defaults(device)
    candidates.sort(key=lambda item: item[0], reverse=True)
    best = candidates[0]
    if len(candidates) > 1 and candidates[1][0] == best[0]:
        tied_candidates = [c for c in candidates if c[0] == best[0]]
        connection_summary = _candidate_connection_summary(tied_candidates, device)
        device['board_inference'] = {
            'status': 'ambiguous',
            'candidates': [c[4].get('name') or c[3] for c in candidates[:5]],
            **connection_summary,
        }
        if connection_summary.get('connection_label') and not device.get('inferred_connection'):
            _set_device_field(device, 'inferred_connection', connection_summary['connection_label'], 'board_config_inferred')
        return _apply_can_mcu_defaults(device)

    _score, manufacturer, board_type, board_id, board = best
    connection_summary = _candidate_connection_summary([best], device)
    device['board_inference'] = {
        'status': 'matched',
        'manufacturer': manufacturer,
        'board_type': board_type,
        'id': board_id,
        'name': board.get('name') or board_id,
        'source': 'board_config_inferred',
        **connection_summary,
    }
    if connection_summary.get('connection_label') and not device.get('inferred_connection'):
        _set_device_field(device, 'inferred_connection', connection_summary['connection_label'], 'board_config_inferred')

    can_gpio = board.get('can_gpio') or {}
    if isinstance(can_gpio, dict):
        rx_pin = _format_gpio_pin(can_gpio.get('rx'))
        tx_pin = _format_gpio_pin(can_gpio.get('tx'))
        if rx_pin and tx_pin and not device.get('can_pins'):
            _set_device_field(device, 'can_pins', f'{rx_pin},{tx_pin}', 'board_config_inferred')
            _set_device_field(device, 'can_rx_pin', rx_pin, 'board_config_inferred')
            _set_device_field(device, 'can_tx_pin', tx_pin, 'board_config_inferred')

    if not device.get('startup_pin'):
        _set_device_field(device, 'startup_pin', board.get('boot_pins'), 'board_config_inferred')
    if not device.get('led_pin'):
        _set_device_field(device, 'led_pin', _board_led_pin(board), 'board_config_inferred')
    if not device.get('bl_offset'):
        board_offset = board.get('bl_offset') or board.get('bootloader_offset')
        _set_device_field(device, 'bl_offset', board_offset, 'board_config_inferred')
        _set_device_field(device, 'bl_offset_label', _format_offset_label(board_offset), 'board_config_inferred')

    return _apply_can_mcu_defaults(device)


def _parse_info_json(line):
    marker = 'InfoJSON:'
    if marker not in line:
        return None
    raw = line.split(marker, 1)[1].strip()
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return None


def _parse_can_uuid_line(line):
    match = re.search(r'canbus_uuid=([a-fA-F0-9]+)', line)
    if not match:
        return None

    device = {
        'uuid': match.group(1),
        'app': _normalize_can_app(line),
        'raw': line.strip(),
    }

    info = _parse_info_json(line)
    if isinstance(info, dict):
        constants = info.get('constants') or {}
        _extract_device_constants(device, constants, 'klipper_identify')

    processor_match = re.search(r'\bProcessor:\s*([^,]+)', line)
    if processor_match and not device.get('mcu_model'):
        _set_device_field(device, 'mcu_model', processor_match.group(1).strip(), 'klipper_identify')

    firmware_match = re.search(r'\bFirmware:\s*([^,]+)', line)
    if firmware_match and not device.get('mcu_version'):
        _set_device_field(device, 'mcu_version', firmware_match.group(1).strip(), 'klipper_identify')

    return device


def _expand_remote_style_path(path, home_dir):
    raw = str(path or '').strip() or '~/katapult'
    if raw == '~':
        return home_dir
    if raw.startswith('~/'):
        return os.path.join(home_dir, raw[2:])
    return os.path.expanduser(raw) if not is_ssh_mode() else raw


def _get_katapult_flashtool_script(home_dir):
    katapult_path = _expand_remote_style_path(config.get('katapult_path', '~/katapult'), home_dir)
    candidates = [
        os.path.join(katapult_path, 'scripts', 'flashtool.py'),
        os.path.join(home_dir, 'katapult', 'scripts', 'flashtool.py'),
        os.path.join(home_dir, 'klipper', 'lib', 'katapult', 'flashtool.py'),
        '/data/katapult/scripts/flashtool.py',
        '/data/klipper/lib/katapult/flashtool.py',
    ]
    for candidate in dict.fromkeys(candidates):
        try:
            if path_exists(candidate):
                return candidate
        except Exception:
            continue
    return ''


def _parse_katapult_status_output(output):
    status = {}
    patterns = {
        'katapult_version': r'Software Version:\s*([^\n]+)',
        'katapult_protocol': r'Protocol Version:\s*([^\n]+)',
        'katapult_block_size': r'Block Size:\s*(\d+)\s*bytes',
        'application_start': r'Application Start:\s*(0x[0-9a-fA-F]+)',
        'mcu_model': r'MCU type:\s*([^\n]+)',
    }
    for key, pattern in patterns.items():
        match = re.search(pattern, output or '', re.IGNORECASE)
        if match:
            status[key] = match.group(1).strip()
    return status


def _apply_katapult_status(device, status):
    if not status:
        return device
    for key in ('mcu_model', 'katapult_version', 'katapult_protocol', 'katapult_block_size', 'application_start'):
        _set_device_field(device, key, status.get(key), 'katapult_protocol')
    if status.get('katapult_version'):
        _set_device_field(device, 'mcu_version', status.get('katapult_version'), 'katapult_protocol')

    start = _offset_int(status.get('application_start'))
    base = _flash_base_for_mcu(status.get('mcu_model') or device.get('mcu_model'))
    if start is not None and base is not None and start >= base:
        offset = start - base
        _set_device_field(device, 'bl_offset', str(offset), 'katapult_protocol')
        _set_device_field(device, 'bl_offset_hex', f'0x{offset:x}', 'katapult_protocol')
        _set_device_field(device, 'bl_offset_label', _format_offset_label(offset), 'katapult_protocol')
    return device


def _query_katapult_status(iface, uuid, python_bin, home_dir):
    flashtool_script = _get_katapult_flashtool_script(home_dir)
    if not flashtool_script:
        return {}, '未找到 Katapult flashtool.py，无法读取 KAT 状态'
    cmd = (
        f'{shlex.quote(python_bin)} {shlex.quote(flashtool_script)} '
        f'-i {shlex.quote(iface)} -u {shlex.quote(uuid)} -s 2>&1'
    )
    release_cmd = (
        f'{shlex.quote(python_bin)} {shlex.quote(flashtool_script)} '
        f'-i {shlex.quote(iface)} -q >/dev/null 2>&1 || true'
    )
    try:
        output = run_cmd(cmd, shell=True, capture_output=True, text=True, timeout=20)
        combined = (output.stdout or '') + (output.stderr or '')
        if output.returncode != 0 and 'Katapult Connected' not in combined:
            return {}, combined.strip()[:300] or 'Katapult 状态读取失败'
        return _parse_katapult_status_output(combined), None
    finally:
        try:
            # flashtool.py -s assigns a temporary node id.  Clear it so the
            # node remains discoverable by later CAN UUID searches.
            run_cmd(release_cmd, shell=True, capture_output=True, text=True, timeout=8)
        except Exception as e:
            logger.warning(f'Katapult 临时 CAN node id 释放失败: {e}')


def _merge_config_sections(devices):
    cfg_uuids = []
    mr_uuids, _mr_available, _mr_error = query_moonraker_printer_cfg()
    if mr_uuids:
        cfg_uuids = mr_uuids
    else:
        fs_uuids, _fs_available = read_printer_cfg_direct()
        cfg_uuids = fs_uuids

    cfg_uuid_map = {u.get('uuid', '').lower(): u for u in cfg_uuids if u.get('uuid')}
    for dev in devices:
        cfg_info = cfg_uuid_map.get(str(dev.get('uuid', '')).lower())
        if cfg_info and not dev.get('section'):
            dev['section'] = cfg_info.get('section', '')
    return devices

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
        return [], True, safe_error(e)


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
                result = manager.exec_command(f'cat {shlex.quote(path)} 2>/dev/null', timeout=5, inject_sudo=False)
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
                with open(path, 'r', encoding='utf-8', errors='replace') as f:
                    content = f.read()
                uuids = read_mcu_uuids_from_printer_cfg(content)
                if uuids:
                    return uuids, True
            except Exception:
                continue
    return [], False


def _scan_can_uuids(iface='can0'):
    """统一的 CAN UUID 扫描函数"""
    try:
        if not _is_valid_can_iface(iface):
            return [], '无效的CAN接口'
        klipper_owner, home_dir = get_klipper_owner()
        python_bin = get_klipper_python_bin(home_dir)
        canbus_script, script_source = _get_canbus_query_script(home_dir)

        timeout = 30 if script_source == 'firmware-tool' else 10
        output = run_cmd(
            f'{shlex.quote(python_bin)} {shlex.quote(canbus_script)} {shlex.quote(iface)} 2>&1',
            shell=True, capture_output=True, text=True, timeout=timeout
        )

        devices = []
        error = None
        seen_uuids = set()

        combined = (output.stdout or '') + (output.stderr or '')
        if combined:
            for line in combined.strip().split('\n'):
                if 'Error' in line or 'Traceback' in line:
                    if not error:
                        error = line.strip()
                    continue
                if 'canbus_uuid' in line:
                    device = _parse_can_uuid_line(line)
                    if device and device['uuid'] not in seen_uuids:
                        seen_uuids.add(device['uuid'])
                        device['script_source'] = script_source
                        devices.append(device)

        if devices:
            _merge_config_sections(devices)
            for device in devices:
                if device.get('app') == 'Katapult':
                    status, kat_error = _query_katapult_status(
                        iface, device.get('uuid', ''), python_bin, home_dir
                    )
                    if kat_error:
                        device['katapult_query_error'] = kat_error
                    _apply_katapult_status(device, status)
                _infer_board_fields(device)

        if not devices and not error:
            error = '未找到CAN设备，请确认CAN接口已启用且设备处于Katapult/Klipper模式'
        return devices, error
    except subprocess.TimeoutExpired:
        return [], 'CAN查询超时'
    except Exception as e:
        return [], safe_error(e)


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
            for m in re.finditer(r"Lost communication with MCU '([^']+)'", msg):
                lost_mcus.append(m.group(1))

        # configfile.settings 会把 section 名归一化为小写，但 Moonraker 的运行
        # 对象仍可能保留原始大小写（例如配置键 mcu t0、对象名 mcu T0）。
        # 查询前按 objects/list 做一次不区分大小写的映射，否则会得到空状态。
        section_object_names = {name: name for name in can_sections}
        try:
            objects_response = requests.get(f'{base}/printer/objects/list', timeout=5)
            if objects_response.status_code == 200:
                object_names = objects_response.json().get('result', {}).get('objects', [])
                object_name_map = {
                    str(name).lower(): str(name)
                    for name in object_names
                    if str(name).lower().startswith('mcu')
                }
                section_object_names = {
                    name: object_name_map.get(name.lower(), name)
                    for name in can_sections
                }
        except Exception as e:
            logger.warning(f'Moonraker MCU 对象名映射失败，使用配置名称查询: {e}')

        query_str = '&'.join(
            urllib.parse.quote(section_object_names[name])
            for name in can_sections
        )
        r = requests.get(f'{base}/printer/objects/query?{query_str}', timeout=5)
        if r.status_code != 200:
            return uuids, True

        mcu_statuses = r.json().get('result', {}).get('status', {})

        verified_uuids = []
        returned_uuid_keys = set()
        for sname in can_sections:
            object_name = section_object_names.get(sname, sname)
            mcu_status = (
                mcu_statuses.get(object_name)
                or mcu_statuses.get(sname)
                or mcu_statuses.get(sname.lower(), {})
            )
            is_klipper_ready = (webhooks_state == 'ready')
            lost_mcu_names = {str(name).lower() for name in lost_mcus}
            is_mcu_lost = sname.lower() in lost_mcu_names or object_name.lower() in lost_mcu_names
            base_entry = dict(can_uuid_map[sname])

            if not is_klipper_ready and is_mcu_lost:
                logger.info(
                    f"MCU 验证: [{sname}] Klipper 已断连 (state={webhooks_state}), 已跳过 "
                    f"(UUID={can_uuid_map[sname]['uuid']})"
                )
                continue

            if mcu_status.get('mcu_version'):
                entry = base_entry
                mcu_constants = mcu_status.get('mcu_constants', {})
                _extract_device_constants(entry, mcu_constants, 'moonraker_mcu_constants')
                _set_device_field(entry, 'mcu_version', mcu_status.get('mcu_version', ''), 'moonraker_mcu_constants')
                _infer_board_fields(entry)
                verified_uuids.append(entry)
                returned_uuid_keys.add(str(entry.get('uuid', '')).lower())
                logger.info(
                    f"MCU 验证: [{sname}] 通过 CAN 已连接 "
                    f"(UUID={can_uuid_map[sname]['uuid']}, MCU={mcu_constants.get('MCU','?')})"
                )
            elif base_entry.get('app') == 'Katapult':
                _infer_board_fields(base_entry)
                verified_uuids.append(base_entry)
                returned_uuid_keys.add(str(base_entry.get('uuid', '')).lower())
            else:
                logger.info(
                    f"MCU 验证: [{sname}] 配置了 CAN 但 Klipper 未连接，已跳过 "
                    f"(UUID={can_uuid_map[sname]['uuid']})"
                )

        for entry in uuids:
            uuid_key = str(entry.get('uuid', '')).lower()
            if entry.get('app') == 'Katapult' and uuid_key not in returned_uuid_keys:
                _infer_board_fields(entry)
                verified_uuids.append(entry)
                returned_uuid_keys.add(uuid_key)

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
    data = request.get_json(silent=True) or {}
    iface = data.get('iface', 'can0')
    if not _is_valid_can_iface(iface):
        return jsonify({'uuids': [], 'error': '无效的CAN接口'})
    try:
        uuids, error = _scan_can_uuids(iface)
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
        return jsonify({'uuids': [], 'error': safe_error(e)})


# ==================== 摄像头详情 API ====================
@system_bp.route('/api/system/video')
def get_video_devices():
    """获取摄像头详细信息（兼容本地/SSH远程模式）"""
    devices = []
    try:
        # 使用 run_cmd 统一路由，兼容本地和 SSH 远程模式
        ls_result = run_cmd('ls /dev/video* 2>/dev/null || echo ""',
                            shell=True, capture_output=True, text=True, timeout=5)
        video_paths = [p.strip() for p in ls_result.stdout.strip().split('\n') if '/dev/video' in p]
    except Exception:
        video_paths = []

    for path in video_paths:
        video_name = os.path.basename(path)
        name, index = 'Unknown', ''
        try:
            name_result = run_cmd(f'cat /sys/class/video4linux/{video_name}/name 2>/dev/null || echo "Unknown"',
                                  shell=True, capture_output=True, text=True, timeout=5)
            name = name_result.stdout.strip() or 'Unknown'
        except Exception:
            pass
        try:
            index_result = run_cmd(f'cat /sys/class/video4linux/{video_name}/index 2>/dev/null || echo ""',
                                   shell=True, capture_output=True, text=True, timeout=5)
            index = index_result.stdout.strip()
        except Exception:
            pass
        devices.append({'path': path, 'name': name, 'index': index})
    return jsonify({'videos': devices})


# ==================== CAN 烧录搜索 API ====================
@system_bp.route('/api/firmware/detect-can')
def detect_can_for_flash():
    """为固件烧录搜索 CAN UUID 设备"""
    iface = request.args.get('iface', 'can0')
    if not _is_valid_can_iface(iface):
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
        except Exception:
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
        except Exception:
            pass

        try:
            devices, error = _scan_can_uuids('can0')
            for d in devices:
                formatted = f"canbus_uuid: {d['uuid']}"
                result['can'].append({'raw': d['uuid'], 'formatted': formatted, 'app': d.get('app', 'Unknown')})
            if error:
                result['can_error'] = error
        except Exception as e:
            logger.error(f'CAN设备检测失败：{e}')

        try:
            output = run_cmd(
                'ls /dev/video* 2>/dev/null || echo ""',
                shell=True, capture_output=True, text=True
            )
            if output.stdout:
                for line in output.stdout.strip().split('\n'):
                    if '/dev/video' in line:
                        result['camera'].append(line.strip())
        except Exception:
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
        except Exception:
            pass

        return jsonify(result)
    except ConnectionError as e:
        return jsonify({'usb': [], 'can': [], 'camera': [], 'kat_usb': [], 'rp_boot': [], 'error': f'SSH连接不可用: {e}'})
    except Exception as e:
        return jsonify({'error': safe_error(e)}), 500


# ==================== 版本与服务 API ====================
def _normalize_klipper_version(value):
    """过滤 Klipper/Fly-Klipper 常见的空版本占位符。"""
    version = str(value or '').strip().splitlines()[0] if str(value or '').strip() else ''
    if version.lower() in ('', '?', 'unknown', 'none', 'null'):
        return ''
    return version[:200]


def _detect_klipper_version(klipper_path):
    """兼容 Git 安装与不包含 .git 的 FlyOS 打包版 Klipper。"""
    if not path_exists(klipper_path):
        return '', 'missing'

    if path_exists(os.path.join(klipper_path, '.git')):
        output = run_cmd(
            ['git', '-C', klipper_path, 'describe', '--tags', '--always', '--long', '--dirty=-d'],
            capture_output=True, text=True, timeout=5
        )
        version = _normalize_klipper_version(output.stdout) if output.returncode == 0 else ''
        if version:
            return version, 'git'

    version_file = os.path.join(klipper_path, 'klippy', '.version')
    if path_exists(version_file):
        output = run_cmd(
            ['head', '-n', '1', version_file],
            capture_output=True, text=True, timeout=5
        )
        version = _normalize_klipper_version(output.stdout) if output.returncode == 0 else ''
        if version:
            return version, 'version_file'

    util_path = os.path.join(klipper_path, 'klippy', 'util.py')
    if path_exists(util_path):
        script = (
            'import sys; '
            'sys.path.insert(0, sys.argv[1]); '
            'import util; '
            'info = util.get_git_version(from_file=False) or {}; '
            'print(info.get("version", ""))'
        )
        klippy_path = os.path.join(klipper_path, 'klippy')
        for interpreter in ('python3', 'python'):
            output = run_cmd(
                [interpreter, '-c', script, klippy_path],
                capture_output=True, text=True, timeout=8
            )
            version = _normalize_klipper_version(output.stdout) if output.returncode == 0 else ''
            if version:
                return version, 'packaged_source'

    return '', 'unknown'


@system_bp.route('/api/system/versions', methods=['GET'])
def get_versions():
    """获取Klipper版本信息"""
    try:
        klipper_path = expand_klipper_path(config.get('klipper_path', '~/klipper'))
        version, source = _detect_klipper_version(klipper_path)
        if source == 'missing':
            return jsonify({'klipper_version': '未安装', 'source': source})
        if not version:
            return jsonify({'klipper_version': '未知版本', 'source': source})
        return jsonify({'klipper_version': version, 'source': source})
    except Exception as e:
        logger.warning(f"获取Klipper版本失败: {e}")
        return jsonify({'klipper_version': '获取失败', 'source': 'error'})


@system_bp.route('/api/system/services', methods=['GET'])
def get_available_services():
    """获取系统中实际安装的服务及其状态（优先通过 Moonraker API 动态发现）"""
    # 核心服务（始终检查）
    core_services = ['klipper', 'moonraker', 'firmware-tool']
    # Moonraker system_info 中需要过滤掉的内部/辅助服务
    excluded_services = {'klipper-mcu', 'moonraker'}
    # 服务显示名称映射（小写 → 显示名）
    display_names = {
        'klipper': 'klipper',
        'moonraker': 'moonraker',
        'firmware-tool': 'firmware-tool',
        'crowsnest': 'crowsnest',
        'klipperscreen': 'KlipperScreen',
        'helixscreen': 'Helixscreen',
    }
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

    # 通过 Moonraker server/info 获取 klipper 连接状态
    moonraker_active = False
    klipper_active = False
    mr_base = get_moonraker_base_url()
    try:
        r = requests.get(f'{mr_base}/server/info', timeout=3)
        if r.status_code == 200:
            info = r.json().get('result', {})
            moonraker_active = True
            klipper_active = info.get('klippy_connected', False)
    except Exception:
        pass

    # 通过 Moonraker machine/system_info 动态发现所有服务
    mr_service_state = {}  # {name: {active_state, sub_state}}
    try:
        r2 = requests.get(f'{mr_base}/machine/system_info', timeout=5)
        if r2.status_code == 200:
            sys_info = r2.json().get('result', {}).get('system_info', {})
            mr_service_state = sys_info.get('service_state', {})
    except Exception:
        pass

    # 通过 Moonraker update_manager 发现额外的服务（如 helixscreen、led_effect 等）
    mr_update_services = set()
    try:
        r3 = requests.get(f'{mr_base}/machine/update/status', timeout=5)
        if r3.status_code == 200:
            version_info = r3.json().get('result', {}).get('version_info', {})
            for svc_name in version_info:
                mr_update_services.add(svc_name.lower())
    except Exception:
        pass

    # 检测 nginx 状态（用于 web 前端）
    try:
        nginx_result = run_cmd(['systemctl', 'is-active', 'nginx'],
                                    capture_output=True, text=True, timeout=5)
        nginx_active = nginx_result.returncode == 0
    except Exception:
        nginx_active = False

    # 构建服务列表：核心服务 + Moonraker 动态发现的服务
    discovered = set()
    for svc_name in mr_service_state:
        svc_lower = svc_name.lower()
        if svc_lower not in excluded_services:
            discovered.add(svc_lower)
    # 也从 update_manager 中添加（排除已知通过其他方式检测的）
    for svc_name in mr_update_services:
        if svc_name not in excluded_services and not svc_name.endswith('-config'):
            discovered.add(svc_name)

    # 合并核心服务和动态发现的服务
    all_services = set(s.lower() for s in core_services) | discovered

    available_services = []
    for svc_lower in sorted(all_services):
        try:
            # 确定显示名称
            display_name = display_names.get(svc_lower, svc_lower)

            if svc_lower == 'firmware-tool':
                # 自身服务，能响应请求说明一定在运行
                available_services.append({
                    'name': 'firmware-tool',
                    'control_name': 'firmware-tool',
                    'active': True,
                    'self_service': True,
                })
                continue

            # 优先通过 Moonraker system_info 获取状态
            mr_state = mr_service_state.get(svc_lower)
            # 尝试大小写匹配
            if mr_state is None:
                for orig_name, state_info in mr_service_state.items():
                    if orig_name.lower() == svc_lower:
                        mr_state = state_info
                        break

            if mr_state is not None:
                is_installed = True
                is_active = mr_state.get('active_state') == 'active'
            else:
                # 回退到 systemctl 检测
                result = run_cmd(['systemctl', 'list-unit-files', f'{svc_lower}.service'],
                                      capture_output=True, text=True, timeout=5)
                is_installed = result.returncode == 0 and f'{svc_lower}.service' in result.stdout
                if is_installed:
                    status_result = run_cmd(['systemctl', 'is-active', svc_lower],
                                                 capture_output=True, text=True, timeout=5)
                    is_active = status_result.returncode == 0
                else:
                    continue  # 未安装，跳过

            # klipper 使用 Moonraker klippy_connected 状态更准确
            if svc_lower == 'klipper' and moonraker_active:
                is_active = klipper_active

            control_name = _normalize_service_name(display_name) or _normalize_service_name(svc_lower)
            available_services.append({
                'name': display_name,
                'control_name': control_name,
                'active': is_active,
                'controllable': bool(control_name),
            })
        except Exception as e:
            logger.warning(f'检查服务 {svc_lower} 状态失败: {e}')
            continue

    for frontend_name, paths in web_frontends.items():
        try:
            config_exists = any(os.path.isfile(cfg) for cfg in paths['nginx_configs'])
            root_exists = any(os.path.isdir(root) for root in paths['web_roots'])
            if config_exists or root_exists:
                available_services.append({
                    'name': frontend_name,
                    'control_name': 'nginx',
                    'active': nginx_active,
                    'controllable': True,
                })
        except Exception as e:
            logger.warning(f'检查 Web 前端 {frontend_name} 失败: {e}')
            continue

    return jsonify({'services': available_services})


@system_bp.route('/api/system/service', methods=['POST'])
def control_service():
    """控制服务（启动/停止/重启）"""
    data = request.get_json(silent=True) or {}
    requested_service = data.get('service')
    service_name = _normalize_service_name(requested_service)
    action = data.get('action')

    if not requested_service or not action:
        return jsonify({'success': False, 'error': '缺少服务名或操作'}), 400
    if not service_name:
        return jsonify({'success': False, 'error': '不允许控制该服务'}), 400
    if action not in ['start', 'stop', 'restart']:
        return jsonify({'success': False, 'error': '无效的操作'}), 400

    # firmware-tool 重启自身时，需要用后台方式执行，否则当前进程会被杀掉无法返回响应
    if service_name == 'firmware-tool' and action == 'restart':
        subprocess.Popen(['sudo', 'systemctl', 'restart', 'firmware-tool'],
                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
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
        return jsonify({'success': False, 'error': safe_error(e)}), 500


# ==================== CAN 总线拓扑 API ====================
@system_bp.route('/api/system/can-topology')
def can_topology():
    """获取 CAN 总线拓扑数据：接口信息 + 设备列表 + 连接状态"""
    iface = request.args.get('iface', 'can0').strip()
    if not _is_valid_can_iface(iface):
        iface = 'can0'

    result = {
        'success': True,
        'interface': {'name': iface, 'state': 'UNKNOWN', 'bitrate': 0, 'type': ''},
        'devices': [],
        'klipper_state': 'unknown',
        'total_devices': 0,
    }

    try:
        ip_result = run_cmd(f'ip -d -j link show {shlex.quote(iface)} 2>/dev/null',
                            shell=True, capture_output=True, text=True, timeout=5)
        if ip_result.returncode == 0 and ip_result.stdout.strip():
            try:
                iface_data = json.loads(ip_result.stdout.strip())
                if iface_data and len(iface_data) > 0:
                    info = iface_data[0]
                    result['interface']['state'] = info.get('operstate', 'UNKNOWN')
                    result['interface']['type'] = info.get('link_type', 'can')
                    link_info = info.get('linkinfo', {}).get('info_data', {})
                    result['interface']['bitrate'] = link_info.get('bittime', {}).get('bitrate', 0)
            except (json.JSONDecodeError, KeyError, IndexError):
                pass
    except Exception:
        pass

    try:
        _, home_dir = get_klipper_owner()
        devices_raw, scan_err = _scan_can_uuids(iface)
        if devices_raw:
            cfg_uuids, cfg_ok = read_printer_cfg_direct()
            cfg_uuid_map = {}
            for u in cfg_uuids:
                uuid_val = u.get('uuid', '')
                if uuid_val:
                    cfg_uuid_map[uuid_val] = u

            verified, verify_ok = verify_mcu_connection_status(devices_raw)

            for dev in verified:
                uuid = dev.get('uuid', '')
                cfg_info = cfg_uuid_map.get(uuid, {})
                if cfg_info.get('section'):
                    dev['section'] = cfg_info.get('section', '')
                dev['connection_status'] = 'unknown'

                if dev.get('app') == 'Katapult':
                    dev['connection_status'] = 'katapult'
                elif dev.get('app') == 'Klipper':
                    dev['connection_status'] = 'connected'

            result['devices'] = verified
            result['total_devices'] = len(verified)
    except Exception as e:
        logger.warning(f'CAN 拓扑扫描异常: {e}')

    try:
        base = get_moonraker_base_url()
        r = requests.get(f'{base}/printer/objects/query?webhooks', timeout=3)
        if r.status_code == 200:
            wh = r.json().get('result', {}).get('status', {}).get('webhooks', {})
            result['klipper_state'] = wh.get('state', 'unknown')
    except Exception:
        pass

    return jsonify(result)
