#!/usr/bin/env python3
"""
Firmware-Tool
Port: 9999 (可配置)
"""

from flask import Flask, jsonify, request, send_from_directory, send_file, Response
from flask_cors import CORS
import subprocess
import os
import re
import json
import time
import psutil
import glob
import shutil
import requests
import threading
from datetime import datetime
from collections import deque
import logging
import sys

# 导入主板配置
from board_config_loader import load_all_boards, load_board_config, get_manufacturers, get_board_types, get_bl_firmwares
from firmware_compiler import FirmwareCompiler
from kconfig_can_parser import parse_can_options

# 配置日志
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s',
    handlers=[
        logging.FileHandler('/tmp/firmware-tool.log'),
        logging.StreamHandler()
    ]
)
logger = logging.getLogger(__name__)

app = Flask(__name__, static_folder='static')
app.config['SEND_FILE_MAX_AGE_DEFAULT'] = 0
CORS(app)

# 配置路径 - 使用动态路径，不硬编码
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(BASE_DIR, 'config.json')
# 统一使用 board_configs 目录存放所有配置
BOARD_CONFIGS_DIR = os.path.join(BASE_DIR, 'board_configs')
# 保留 USER_CONFIGS_DIR 和 CONFIGS_DIR 指向同一目录，用于兼容旧代码
USER_CONFIGS_DIR = BOARD_CONFIGS_DIR
CONFIGS_DIR = BOARD_CONFIGS_DIR

# 默认配置
DEFAULT_CONFIG = {
    'port': 9999,
    'klipper_path': '~/klipper',
    'json_repo_url': '',  # JSON配置仓库地址
    'last_json_update': None
}

def load_config():
    """加载配置"""
    if os.path.exists(CONFIG_PATH):
        try:
            with open(CONFIG_PATH, 'r') as f:
                config = json.load(f)
                # 合并默认配置
                for key, value in DEFAULT_CONFIG.items():
                    if key not in config:
                        config[key] = value
                return config
        except Exception as e:
            logger.error(f"加载配置失败: {e}")
    return DEFAULT_CONFIG.copy()

def save_config(config):
    """保存配置"""
    try:
        with open(CONFIG_PATH, 'w') as f:
            json.dump(config, f, indent=2)
        return True
    except Exception as e:
        logger.error(f"保存配置失败: {e}")
        return False

config = load_config()
compiler = FirmwareCompiler(config.get('klipper_path', '~/klipper'))
PORT = config.get('port', 9999)

# 历史数据存储
MAX_HISTORY_POINTS = 3600
resource_history = {
    'cpu': deque(maxlen=MAX_HISTORY_POINTS),
    'memory': deque(maxlen=MAX_HISTORY_POINTS),
    'disk': deque(maxlen=MAX_HISTORY_POINTS),
    'timestamps': deque(maxlen=MAX_HISTORY_POINTS)
}

# 服务列表
SERVICES = ['klipper', 'moonraker', 'nginx', 'crowsnest', 'KlipperScreen']

# ==================== 资源监控 ====================
def resource_monitor():
    """后台线程：每秒采集系统资源数据"""
    while True:
        try:
            cpu_percent = psutil.cpu_percent(interval=1)
            memory = psutil.virtual_memory()
            disk = psutil.disk_usage('/')
            
            resource_history['cpu'].append(cpu_percent)
            resource_history['memory'].append(memory.percent)
            resource_history['disk'].append((disk.used / disk.total) * 100)
            resource_history['timestamps'].append(datetime.now().isoformat())
        except Exception as e:
            logger.error(f"资源监控错误: {e}")
        
        time.sleep(1)

monitor_thread = threading.Thread(target=resource_monitor, daemon=True)
monitor_thread.start()

# ==================== 页面路由 ====================
@app.route('/')
def index():
    """主页面"""
    return send_from_directory('static', 'index.html')

# ==================== 系统资源 API ====================
@app.route('/api/system/resources')
def get_system_resources():
    """获取系统资源信息"""
    try:
        # CPU信息
        cpu_freq = psutil.cpu_freq()
        cpu_info = {
            'percent': psutil.cpu_percent(interval=0.1),
            'freq': round(cpu_freq.current / 1000, 2) if cpu_freq else 0,
            'count': psutil.cpu_count()
        }
        
        # 内存信息
        memory = psutil.virtual_memory()
        mem_info = {
            'total': round(memory.total / (1024**3), 1),
            'used': round(memory.used / (1024**3), 1),
            'percent': memory.percent
        }
        
        # 磁盘信息
        disk = psutil.disk_usage('/')
        disk_info = {
            'total': round(disk.total / (1024**3), 1),
            'used': round(disk.used / (1024**3), 1),
            'percent': round((disk.used / disk.total) * 100, 1)
        }
        
        # 网络信息 - 只获取网口(eth/en)和WiFi(wlan/wlo)
        net_info = {'interfaces': []}
        try:
            import socket
            
            # 获取所有网络接口
            interfaces = psutil.net_if_addrs()
            for iface_name, addrs in interfaces.items():
                # 只保留网口(eth/en)和WiFi(wlan/wlo)
                iface_lower = iface_name.lower()
                if not (iface_lower.startswith('eth') or 
                        iface_lower.startswith('en') or 
                        iface_lower.startswith('wlan') or 
                        iface_lower.startswith('wlo')):
                    continue
                
                # 转换接口名称为中文
                iface_lower = iface_name.lower()
                if iface_lower.startswith('eth') or iface_lower.startswith('en'):
                    display_name = '网线'
                elif iface_lower.startswith('wlan') or iface_lower.startswith('wlo'):
                    display_name = 'WiFi'
                else:
                    display_name = iface_name
                
                iface_info = {'name': display_name, 'ips': []}
                for addr in addrs:
                    if addr.family == socket.AF_INET:  # IPv4
                        iface_info['ips'].append(addr.address)
                
                if iface_info['ips']:
                    net_info['interfaces'].append(iface_info)
        except:
            # 如果获取失败，使用hostname
            try:
                hostname = socket.gethostname()
                net_info['interfaces'] = [{'name': 'default', 'ips': [socket.gethostbyname(hostname)]}]
            except:
                net_info['interfaces'] = []
        
        # 服务状态
        service_status = {}
        for service in SERVICES:
            try:
                result = subprocess.run(
                    ['systemctl', 'is-active', service],
                    capture_output=True,
                    text=True,
                    timeout=2
                )
                service_status[service] = result.returncode == 0
            except:
                service_status[service] = False
        
        return jsonify({
            'current': {
                'cpu': cpu_info,
                'memory': mem_info,
                'disk': disk_info,
                'network': net_info,
                'services': service_status
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
@app.route('/api/system/lsusb')
def get_lsusb():
    """获取 lsusb 完整输出"""
    search = request.args.get('search', '')
    try:
        output = subprocess.check_output(['lsusb'], text=True)
        devices = []
        for line in output.strip().split('\n'):
            if not line.strip():
                continue
            if search and search.lower() not in line.lower():
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
        return jsonify({'devices': [], 'error': str(e)})

# ==================== 串口设备详情 API ====================
@app.route('/api/system/serial')
def get_serial_devices():
    """获取串口设备详细信息（模仿FlyTools getSerial）"""
    import glob
    devices = []
    serial_paths = glob.glob('/dev/serial/by-path/*')
    for path in serial_paths:
        try:
            info = {}
            output = subprocess.check_output(
                ['udevadm', 'info', '--query=property', '--name=' + path],
                text=True, timeout=5
            )
            for line in output.strip().split('\n'):
                if '=' in line:
                    k, v = line.split('=', 1)
                    info[k] = v
            devlinks = info.get('DEVLINKS', '').split()
            link = ''
            for dl in devlinks:
                if dl != path:
                    link = dl
                    break
            devices.append({
                'path': path,
                'link': link,
                'devname': info.get('DEVNAME', ''),
                'model': info.get('ID_MODEL', ''),
                'vendor': info.get('ID_VENDOR', ''),
                'vid': info.get('ID_VENDOR_ID', ''),
                'pid': info.get('ID_USB_MODEL_ID', info.get('ID_MODEL_ID', '')),
                'driver': info.get('ID_USB_DRIVER', ''),
            })
        except Exception:
            continue
    return jsonify({'devices': devices})

# ==================== CAN接口列表 API ====================
@app.route('/api/system/can-iface')
def get_can_interfaces():
    """获取可用CAN接口列表（模仿FlyTools getCanIface）"""
    try:
        output = subprocess.check_output(
            ['ip', '-d', '-j', 'link', 'show', 'type', 'can'],
            text=True, timeout=5
        )
        import json as _json
        ifaces = _json.loads(output) if output.strip() else []
        result = []
        for iface in ifaces:
            if isinstance(iface, dict) and iface.get('ifname'):
                result.append({
                    'ifname': iface.get('ifname', ''),
                    'operstate': iface.get('operstate', 'UNKNOWN'),
                    'flags': iface.get('flags', []),
                })
        return jsonify({'ifaces': result})
    except subprocess.CalledProcessError:
        return jsonify({'ifaces': []})
    except Exception as e:
        return jsonify({'ifaces': [], 'error': str(e)})

# ==================== CAN UUID搜索 API ====================
@app.route('/api/system/can-uuid', methods=['POST'])
def search_can_uuid():
    """通过指定CAN接口搜索UUID（模仿FlyTools getCan）"""
    data = request.get_json() or {}
    iface = data.get('iface', 'can0')
    if not iface or not iface.startswith('can'):
        return jsonify({'uuids': [], 'error': '无效的CAN接口'})
    try:
        import pwd
        try:
            home_dir = pwd.getpwnam('fenghua').pw_dir
        except KeyError:
            home_dir = os.path.expanduser('~')
        python_bin = os.path.join(home_dir, 'klippy-env', 'bin', 'python')
        canbus_script = os.path.join(home_dir, 'klipper', 'scripts', 'canbus_query.py')
        output = subprocess.run(
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
                    app = 'Klipper' if 'Klipper' in line else \
                          'Katapult' if 'Katapult' in line else 'Unknown'
                    if not any(u['uuid'] == uuid_val for u in uuids):
                        uuids.append({'uuid': uuid_val, 'app': app})
            elif 'Error' in line or 'error' in line:
                if not error:
                    error = line.strip()
        if not uuids and error:
            return jsonify({'uuids': [], 'error': error})
        return jsonify({'uuids': uuids})
    except subprocess.TimeoutExpired:
        return jsonify({'uuids': [], 'error': 'CAN查询超时'})
    except Exception as e:
        return jsonify({'uuids': [], 'error': str(e)})

# ==================== 摄像头详情 API ====================
@app.route('/api/system/video')
def get_video_devices():
    """获取摄像头详细信息（模仿FlyTools getVideoDevice）"""
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

# ==================== 通信选项 API ====================
@app.route('/api/klipper/communication-options')
def get_communication_options():
    """获取 Kconfig 中的通信接口选项"""
    klipper_path = request.args.get('klipper_path', config.get('klipper_path', '~/klipper'))
    if klipper_path.startswith('~'):
        klipper_path = '/home/fenghua' + klipper_path[1:]
    try:
        data = parse_can_options(klipper_path)
        return jsonify(data)
    except Exception as e:
        logger.error(f'解析通信选项失败: {e}')
        return jsonify({'error': str(e)})

# ==================== CAN 烧录搜索 API ====================
@app.route('/api/firmware/detect-can')
def detect_can_for_flash():
    """为固件烧录搜索 CAN UUID 设备"""
    try:
        import pwd
        try:
            home_dir = pwd.getpwnam('fenghua').pw_dir
        except KeyError:
            home_dir = os.path.expanduser('~')
        
        python_bin = os.path.join(home_dir, 'klippy-env', 'bin', 'python')
        canbus_script = os.path.join(home_dir, 'klipper', 'scripts', 'canbus_query.py')
        
        output = subprocess.run(
            f'{python_bin} {canbus_script} can0 2>&1',
            shell=True, capture_output=True, text=True, timeout=10
        )
        
        devices = []
        error = None
        seen_uuids = set()
        
        if output.stdout:
            for line in output.stdout.strip().split('\n'):
                if 'Error' in line or 'Traceback' in line:
                    if not error:
                        error = line
                    continue
                match = re.search(r'\b([a-f0-9]{8,})\b', line)
                if match:
                    uuid = match.group(1)
                    if uuid not in seen_uuids:
                        seen_uuids.add(uuid)
                        devices.append(uuid)
        
        if not devices and not error:
            error = '未找到CAN设备，请确认CAN接口已启用且设备处于Katapult/DFU模式'
        
        return jsonify({'devices': devices, 'error': error})
    except Exception as e:
        return jsonify({'devices': [], 'error': str(e)})

# ==================== ID搜索 API ====================
@app.route('/api/system/ids')
def get_all_ids():
    """获取所有ID信息"""
    try:
        result = {'usb': [], 'can': [], 'camera': []}
        
        # USB 设备 - 格式：serial: <id>
        try:
            output = subprocess.run(
                'ls /dev/serial/by-id/* 2>/dev/null || echo ""',
                shell=True, capture_output=True, text=True
            )
            if output.stdout:
                for line in output.stdout.strip().split('\n'):
                    if '/dev/serial/by-id/' in line:
                        device_id = line.strip()
                        # 格式化为 serial: <id>
                        formatted = f"serial: {device_id}"
                        result['usb'].append({'raw': device_id, 'formatted': formatted})
                        # 如果是 Katapult 设备，同时添加到 kat_usb 列表
                        if 'katapult' in device_id.lower():
                            if 'kat_usb' not in result:
                                result['kat_usb'] = []
                            result['kat_usb'].append({'raw': device_id, 'formatted': f'Katapult (USB): {device_id}'})
        except:
            pass
        
        # DFU设备检测
        try:
            output = subprocess.run(
                'sudo dfu-util -l 2>/dev/null | grep "Found DFU" || echo ""',
                shell=True, capture_output=True, text=True
            )
            if output.stdout and 'Found DFU' in output.stdout:
                result['dfu'] = [{'raw': 'dfu', 'formatted': 'DFU模式设备 (0483:df11)'}]
        except:
            pass
        
        # CAN设备 - 使用Klipper的 canbus_query.py
        try:
            import pwd
            try:
                home_dir = pwd.getpwnam('fenghua').pw_dir
            except KeyError:
                home_dir = os.path.expanduser('~')
                    
            python_bin = os.path.join(home_dir, 'klippy-env', 'bin', 'python')
            canbus_script = os.path.join(home_dir, 'klipper', 'scripts', 'canbus_query.py')
                    
            output = subprocess.run(
                f'{python_bin} {canbus_script} can0 2>&1',
                shell=True, capture_output=True, text=True, timeout=10
            )
            seen_uuids = set()
            can_error = None
            if output.stdout:
                for line in output.stdout.strip().split('\n'):
                    # 捕获错误信息
                    if 'Error' in line or 'Traceback' in line or 'DeprecationWarning' in line:
                        if 'Error' in line and not can_error:
                            can_error = line.strip()
                        continue
                    # 解析 UUID (8 位或更长的十六进制)
                    match = re.search(r'\b([a-f0-9]{8,})\b', line)
                    if match:
                        uuid = match.group(1)
                        if uuid in seen_uuids:
                            continue
                        seen_uuids.add(uuid)
                        formatted = f"canbus_uuid: {uuid}"
                        result['can'].append({'raw': uuid, 'formatted': formatted})
            if not result['can'] and can_error:
                result['can_error'] = can_error
            elif not result['can']:
                result['can_error'] = '未找到CAN设备，请确认CAN接口已启用且设备处于Katapult模式'
        except Exception as e:
            import logging
            logging.error(f'CAN设备检测失败：{e}')
        
        # 摄像头设备
        try:
            output = subprocess.run(
                'ls /dev/video* 2>/dev/null || echo ""',
                shell=True, capture_output=True, text=True
            )
            if output.stdout:
                for line in output.stdout.strip().split('\n'):
                    if '/dev/video' in line:
                        result['camera'].append(line.strip())
        except:
            pass
        
        # RP2040 BOOT设备检测
        result['rp_boot'] = []
        try:
            # 方法1: 通过lsblk检测RP2040 BOOT块设备
            lsblk_output = subprocess.run(
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
            
            # 方法2: 通过lsusb检测Raspberry Pi RP2 Boot设备 (2e8a:0003)
            if not result['rp_boot']:
                lsusb_output = subprocess.run(
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
    except Exception as e:
        return jsonify({'error': str(e)}), 500

# ==================== 主板配置 API ====================
@app.route('/api/firmware/boards')
def get_boards():
    """获取所有主板配置"""
    try:
        boards = load_all_boards()
        manufacturers = get_manufacturers()
        return jsonify({'boards': boards, 'manufacturers': manufacturers})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/firmware/manufacturers')
def get_manufacturers_list():
    """获取厂家列表"""
    try:
        manufacturers = get_manufacturers()
        return jsonify({'manufacturers': manufacturers})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/firmware/bl-firmwares/<manufacturer>')
@app.route('/api/firmware/bl-firmwares/<manufacturer>/<board_type>')
def get_bl_firmwares_list(manufacturer, board_type=None):
    """获取指定厂家的BL固件列表，可按主板类型过滤"""
    try:
        firmwares = get_bl_firmwares(manufacturer, board_type)
        return jsonify({'firmwares': firmwares})
    except Exception as e:
        return jsonify({'error': str(e)}), 500

# 加载Klipper规则
def load_klipper_rules():
    """加载Klipper固件编译规则"""
    rules_path = os.path.join(BASE_DIR, 'klipper_rules.json')
    if os.path.exists(rules_path):
        with open(rules_path, 'r', encoding='utf-8') as f:
            return json.load(f)
    return {}

# ==================== 固件编译规则 API ====================
@app.route('/api/firmware/rules/<processor>')
def get_processor_rules(processor):
    """获取指定处理器的固件编译规则"""
    try:
        rules = load_klipper_rules()
        if processor in rules:
            return jsonify(rules[processor])
        else:
            return jsonify({'error': f'未找到处理器 {processor} 的规则'}), 404
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/api/firmware/rules')
def get_all_rules():
    """获取所有处理器的固件编译规则"""
    try:
        rules = load_klipper_rules()
        return jsonify(rules)
    except Exception as e:
        return jsonify({'error': str(e)}), 500

# ==================== 固件编译 API ====================
@app.route('/api/firmware/compile', methods=['POST'])
def compile_firmware():
    """编译Klipper固件 - 支持预设配置和自定义MCU"""
    try:
        data = request.json
        
        # 获取 Klipper 路径，优先使用用户传入的，其次是配置的，最后是默认值
        # 修复 systemd root 运行时 ~ 被扩展为 /root 的问题
        klipper_path = data.get('klipper_path', config.get('klipper_path', '~/klipper'))
        # 手动替换 ~ 为 /home/fenghua（因为服务以 root 运行但 klipper 在用户目录）
        if klipper_path.startswith('~'):
            klipper_path = '/home/fenghua' + klipper_path[1:]
        klipper_path = os.path.expanduser(klipper_path)
        
        # 检查是否是预设配置模式
        config_data = data.get('config')
        if config_data:
            # 从预设配置提取参数 - 支持中英文字段
            mcu_arch = config_data.get('platform', config_data.get('平台', 'STM32'))
            processor = config_data.get('mcu', config_data.get('处理器', 'STM32F072')).upper()
            bootloader_offset = config_data.get('bl_offset', config_data.get('BL 偏移', '0'))
            communication = config_data.get('default_connection', config_data.get('默认连接', 'USB'))
            can_bus_interface = 'CAN bus (on PB8/PB9)'
            startup_pin = config_data.get('boot_pins', config_data.get('启动引脚', ''))
            crystal = config_data.get('crystal', config_data.get('晶振', '8000000'))
            rp2040_can_rx_gpio = str(config_data.get('can_gpio', {}).get('rx', '4'))
            rp2040_can_tx_gpio = str(config_data.get('can_gpio', {}).get('tx', '5'))
        else:
            # 自定义MCU模式
            mcu_arch = data.get('platform', 'STM32')
            processor = data.get('mcu', 'STM32F072').upper()
            bootloader_offset = data.get('bl_offset', '0')
            communication = data.get('connection', 'USB')
            comm_type = data.get('comm_type', '')
            comm_config_symbol = data.get('comm_config_symbol', '')
            bridge_can_config = data.get('bridge_can_config', '')
            can_bus_interface = data.get('can_bus_interface', 'CAN bus (on PB8/PB9)')
            startup_pin = data.get('startup_pin', '')
            crystal = data.get('crystal', '8000000')
            rp2040_can_rx_gpio = data.get('rp2040_can_rx_gpio', '4')
            rp2040_can_tx_gpio = data.get('rp2040_can_tx_gpio', '5')
        
        # 转换 BL 偏移数值为文本格式
        bl_offset_map = {
            '0': 'No bootloader',
            '256': 'No bootloader',
            '2048': '2KiB bootloader',
            '4096': '4KiB bootloader',
            '8192': '8KiB bootloader',
            '16384': '16KiB bootloader',
            '32768': '32KiB bootloader',
            '49152': '48KiB bootloader',
            '65536': '64KiB bootloader',
            '131072': '128KiB bootloader',
            '20480': '20KiB bootloader',
            '28672': '28KiB bootloader',
            '34816': '34KiB bootloader',
            '36864': '36KiB bootloader',
            '0x8000': '32KiB bootloader',
            '0xC000': '48KiB bootloader',
            '0x10000': '64KiB bootloader'
        }
        if bootloader_offset in bl_offset_map:
            bootloader_offset = bl_offset_map[bootloader_offset]
        
        # 预计算大写变量（避免重复计算）
        mcu_arch_upper = mcu_arch.upper()
        processor_upper = processor.upper()
        
        if not os.path.exists(klipper_path):
            return jsonify({'error': f'Klipper目录不存在: {klipper_path}'}), 400
        
        # 清理之前的编译
        subprocess.run(f'cd {klipper_path} && rm -rf .config out', 
                      shell=True, capture_output=True)
        
        # 生成配置文件
        config_lines = ['CONFIG_LOW_LEVEL_OPTIONS=y']
        
        # MCU架构 - 必须首先选择平台
        if 'STM32' in mcu_arch_upper:
            config_lines.append('CONFIG_MACH_STM32=y')
        elif 'RP2040' in mcu_arch_upper or 'RP235' in mcu_arch_upper:
            config_lines.append('CONFIG_MACH_RPXXXX=y')
        elif 'ATSAMD' in mcu_arch_upper or processor_upper.startswith('SAMC21') or processor_upper.startswith('SAMD21') or processor_upper.startswith('SAMD51') or processor_upper.startswith('SAME51') or processor_upper.startswith('SAME54'):
            config_lines.append('CONFIG_MACH_ATSAMD=y')
        elif 'ATSAM' in mcu_arch_upper or processor_upper.startswith('SAM3X') or processor_upper.startswith('SAM4') or processor_upper.startswith('SAME70'):
            config_lines.append('CONFIG_MACH_ATSAM=y')
        elif 'LPC176' in mcu_arch_upper or processor_upper.startswith('LPC176'):
            config_lines.append('CONFIG_MACH_LPC176X=y')
        elif 'HC32F460' in mcu_arch_upper or 'HC32F460' in processor_upper:
            config_lines.append('CONFIG_MACH_HC32F460=y')
        elif 'AVR' in mcu_arch_upper or processor_upper.startswith('ATMEGA') or processor_upper.startswith('AT90USB') or processor_upper.startswith('ATMega'):
            config_lines.append('CONFIG_MACH_AVR=y')
        
        # 处理器映射（支持大小写）
        processor_map = {
            # STM32
            'STM32F031': 'CONFIG_MACH_STM32F031=y',
            'STM32F042': 'CONFIG_MACH_STM32F042=y',
            'STM32F070': 'CONFIG_MACH_STM32F070=y',
            'STM32F072': 'CONFIG_MACH_STM32F072=y',
            'STM32F103': 'CONFIG_MACH_STM32F103=y',
            'STM32F207': 'CONFIG_MACH_STM32F207=y',
            'STM32F401': 'CONFIG_MACH_STM32F401=y',
            'STM32F405': 'CONFIG_MACH_STM32F405=y',
            'STM32F407': 'CONFIG_MACH_STM32F407=y',
            'STM32F429': 'CONFIG_MACH_STM32F429=y',
            'STM32F446': 'CONFIG_MACH_STM32F446=y',
            'STM32F765': 'CONFIG_MACH_STM32F765=y',
            'STM32G070': 'CONFIG_MACH_STM32G070=y',
            'STM32G071': 'CONFIG_MACH_STM32G071=y',
            'STM32G0B0': 'CONFIG_MACH_STM32G0B0=y',
            'STM32G0B1': 'CONFIG_MACH_STM32G0B1=y',
            'STM32G431': 'CONFIG_MACH_STM32G431=y',
            'STM32G474': 'CONFIG_MACH_STM32G474=y',
            'STM32H723': 'CONFIG_MACH_STM32H723=y',
            'STM32H743': 'CONFIG_MACH_STM32H743=y',
            'STM32H750': 'CONFIG_MACH_STM32H750=y',
            'STM32L412': 'CONFIG_MACH_STM32L412=y',
            # RP2040
            'RP2040': 'CONFIG_MACH_RP2040=y',
            'RP2350': 'CONFIG_MACH_RP2350=y',
            # ATSAMD
            'SAMC21G18': 'CONFIG_MACH_SAMC21G18=y',
            'SAMD21E15': 'CONFIG_MACH_SAMD21E15=y',
            'SAMD21E18': 'CONFIG_MACH_SAMD21E18=y',
            'SAMD21G18': 'CONFIG_MACH_SAMD21G18=y',
            'SAMD21J18': 'CONFIG_MACH_SAMD21J18=y',
            'SAMD51G19': 'CONFIG_MACH_SAMD51G19=y',
            'SAMD51J19': 'CONFIG_MACH_SAMD51J19=y',
            'SAMD51N19': 'CONFIG_MACH_SAMD51N19=y',
            'SAMD51N20': 'CONFIG_MACH_SAMD51N20=y',
            'SAMD51P20': 'CONFIG_MACH_SAMD51P20=y',
            'SAME51J19': 'CONFIG_MACH_SAME51J19=y',
            'SAME51N19': 'CONFIG_MACH_SAME51N19=y',
            'SAME51N20': 'CONFIG_MACH_SAME51N20=y',
            'SAME54P20': 'CONFIG_MACH_SAME54P20=y',
            # ATSAM
            'SAM3X8C': 'CONFIG_MACH_SAM3X8C=y',
            'SAM3X8E': 'CONFIG_MACH_SAM3X8E=y',
            'SAM4E8E': 'CONFIG_MACH_SAM4E8E=y',
            'SAM4E16E': 'CONFIG_MACH_SAM4E16E=y',
            'SAM4S8C': 'CONFIG_MACH_SAM4S8C=y',
            'SAM4S8B': 'CONFIG_MACH_SAM4S8B=y',
            'SAME70N20': 'CONFIG_MACH_SAME70N20=y',
            'SAME70J19': 'CONFIG_MACH_SAME70J19=y',
            'SAME70J20': 'CONFIG_MACH_SAME70J20=y',
            'SAME70Q20': 'CONFIG_MACH_SAME70Q20=y',
            # LPC176x
            'LPC1768': 'CONFIG_MACH_LPC1768=y',
            'LPC1769': 'CONFIG_MACH_LPC1769=y',
            # HC32F460
            'HC32F460': 'CONFIG_MACH_HC32F460=y',
            # AVR (小写也支持)
            'AT90USB1286': 'CONFIG_MACH_at90usb1286=y',
            'AT90USB646': 'CONFIG_MACH_at90usb646=y',
            'ATMEGA1280': 'CONFIG_MACH_atmega1280=y',
            'ATMEGA2560': 'CONFIG_MACH_atmega2560=y',
            'ATMEGA328P': 'CONFIG_MACH_atmega328p=y',
            'ATMEGA328': 'CONFIG_MACH_atmega328=y',
            'ATMEGA32U4': 'CONFIG_MACH_atmega32u4=y',
            'ATMEGA168': 'CONFIG_MACH_atmega168=y',
            'ATMEGA328PB': 'CONFIG_MACH_atmega328pb=y',
            'LGT8F328P': 'CONFIG_MACH_lgt8f328p=y',
            # 小写版本
            'at90usb1286': 'CONFIG_MACH_at90usb1286=y',
            'at90usb646': 'CONFIG_MACH_at90usb646=y',
            'atmega1280': 'CONFIG_MACH_atmega1280=y',
            'atmega2560': 'CONFIG_MACH_atmega2560=y',
            'atmega328p': 'CONFIG_MACH_atmega328p=y',
            'atmega328': 'CONFIG_MACH_atmega328=y',
            'atmega32u4': 'CONFIG_MACH_atmega32u4=y',
            'atmega168': 'CONFIG_MACH_atmega168=y',
            'atmega328pb': 'CONFIG_MACH_atmega328pb=y',
            'lgt8f328p': 'CONFIG_MACH_lgt8f328p=y'
        }
        
        # 尝试匹配处理器（processor_upper 已在前面定义）
        if processor_upper in processor_map:
            config_lines.append(processor_map[processor_upper])
        elif processor_upper.startswith('STM32'):
            # 尝试提取型号
            import re
            match = re.match(r'(STM32\w+)', processor_upper)
            if match and match.group(1) in processor_map:
                config_lines.append(processor_map[match.group(1)])
            else:
                # 默认使用 F072
                config_lines.append('CONFIG_MACH_STM32F072=y')
        elif 'RP2040' in processor_upper:
            config_lines.append('CONFIG_MACH_RP2040=y')
        else:
            config_lines.append('CONFIG_MACH_STM32F072=y')
        
        # 晶振配置
        crystal_map = {
            '8000000': 'CONFIG_CLOCK_REF_8=y',
            '12000000': 'CONFIG_CLOCK_REF_12=y',
            '16000000': 'CONFIG_CLOCK_REF_16=y',
            '20000000': 'CONFIG_CLOCK_REF_20=y',
            '24000000': 'CONFIG_CLOCK_REF_24=y',
            '25000000': 'CONFIG_CLOCK_REF_25=y',
            '8000000': 'CONFIG_CLOCK_REF_8=y',
            '12000000': 'CONFIG_CLOCK_REF_12=y',
            '16000000': 'CONFIG_CLOCK_REF_16=y',
            '20000000': 'CONFIG_CLOCK_REF_20=y',
            '24000000': 'CONFIG_CLOCK_REF_24=y',
            '25000000': 'CONFIG_CLOCK_REF_25=y'
        }
        if crystal in crystal_map:
            config_lines.append(crystal_map[crystal])
        elif str(crystal) in crystal_map:
            config_lines.append(crystal_map[str(crystal)])
        
        # Bootloader偏移 (区分STM32和RP2040/RP2350)
        if 'RP2040' in processor:
            # RP2040使用256字节stage2
            offset_map = {
                'No bootloader': 'CONFIG_RPXXXX_FLASH_START_0100=y',
                '16KiB bootloader': 'CONFIG_RPXXXX_FLASH_START_4000=y'
            }
        elif 'RP2350' in processor:
            # RP2350真正无bootloader
            offset_map = {
                'No bootloader': 'CONFIG_RPXXXX_FLASH_START_0000=y',
                '16KiB bootloader': 'CONFIG_RPXXXX_FLASH_START_4000=y'
            }
        else:
            # STM32
            offset_map = {
                'No bootloader': 'CONFIG_STM32_FLASH_START_0000=y',
                '2KiB bootloader': 'CONFIG_STM32_FLASH_START_800=y',
                '4KiB bootloader': 'CONFIG_STM32_FLASH_START_1000=y',
                '8KiB bootloader': 'CONFIG_STM32_FLASH_START_2000=y',
                '16KiB bootloader': 'CONFIG_STM32_FLASH_START_4000=y',
                '20KiB bootloader': 'CONFIG_STM32_FLASH_START_5000=y',
                '28KiB bootloader': 'CONFIG_STM32_FLASH_START_7000=y',
                '32KiB bootloader': 'CONFIG_STM32_FLASH_START_8000=y',
                '34KiB bootloader': 'CONFIG_STM32_FLASH_START_8800=y',
                '36KiB bootloader': 'CONFIG_STM32_FLASH_START_9000=y',
                '48KiB bootloader': 'CONFIG_STM32_FLASH_START_C000=y',
                '64KiB bootloader': 'CONFIG_STM32_FLASH_START_10000=y',
                '128KiB bootloader': 'CONFIG_STM32_FLASH_START_20000=y'
            }
        if bootloader_offset in offset_map:
            config_lines.append(offset_map[bootloader_offset])
        
        # 通信接口 - 优先使用动态 config_symbol
        _is_dynamic = comm_config_symbol and ' ' not in comm_config_symbol and comm_config_symbol.replace('_', '').isalnum()
        
        if _is_dynamic:
            # 动态模式: 前端直接传来 Kconfig config_symbol
            config_lines.append(f'CONFIG_{comm_config_symbol}=y')
            if comm_type == 'can':
                config_lines.append('CONFIG_CANBUS_FREQUENCY=1000000')
            elif comm_type == 'usbcanbridge':
                config_lines.append('CONFIG_CANBUS_FREQUENCY=1000000')
                if bridge_can_config:
                    if bridge_can_config.startswith('STM32_') or bridge_can_config.startswith('RPXXXX_'):
                        config_lines.append(f'CONFIG_{bridge_can_config}=y')
                    else:
                        pin_suffix = bridge_can_config.replace('/', '_')
                        config_lines.append(f'CONFIG_STM32_CMENU_CANBUS_{pin_suffix}=y')
            # RP2040 CAN/Bridge 需要 GPIO
            if ('RP2040' in processor or 'RP2350' in processor) and comm_type in ('can', 'usbcanbridge'):
                config_lines.append(f'CONFIG_RPXXXX_CANBUS_GPIO_RX={rp2040_can_rx_gpio}')
                config_lines.append(f'CONFIG_RPXXXX_CANBUS_GPIO_TX={rp2040_can_tx_gpio}')
        elif 'RP2040' in processor or 'RP2350' in processor:
            # RP2040/RP2350通信接口
            if 'USB to CAN bus bridge' in communication:
                config_lines.append('CONFIG_RPXXXX_USBCANBUS=y')
                config_lines.append(f'CONFIG_RPXXXX_CANBUS_GPIO_RX={rp2040_can_rx_gpio}')
                config_lines.append(f'CONFIG_RPXXXX_CANBUS_GPIO_TX={rp2040_can_tx_gpio}')
            elif 'USBSERIAL' in communication:
                config_lines.append('CONFIG_RPXXXX_USB=y')
            elif 'CAN' in communication:
                config_lines.append('CONFIG_RPXXXX_CANBUS=y')
                config_lines.append(f'CONFIG_RPXXXX_CANBUS_GPIO_RX={rp2040_can_rx_gpio}')
                config_lines.append(f'CONFIG_RPXXXX_CANBUS_GPIO_TX={rp2040_can_tx_gpio}')
            elif 'UART' in communication:
                config_lines.append('CONFIG_RPXXXX_SERIAL_UART0_PINS_0_1=y')
        elif processor_upper.startswith('STM32'):
            # STM32通信接口
            if 'USB to CAN bus bridge' in communication:
                config_lines.append('CONFIG_USBCANBUS=y')
                config_lines.append('CONFIG_USB=y')
                config_lines.append('CONFIG_CANBUS=y')
                config_lines.append('CONFIG_CANBUS_FREQUENCY=1000000')
                config_lines.append('CONFIG_STM32_USBCANBUS_PA11_PA12=y')
                if 'PB8/PB9' in can_bus_interface:
                    config_lines.append('CONFIG_STM32_CMENU_CANBUS_PB8_PB9=y')
                    config_lines.append('CONFIG_STM32_CANBUS_PB8_PB9=y')
                elif 'PD0/PD1' in can_bus_interface:
                    config_lines.append('CONFIG_STM32_CMENU_CANBUS_PD0_PD1=y')
                    config_lines.append('CONFIG_STM32_CANBUS_PD0_PD1=y')
            elif 'USB' in communication:
                config_lines.append('CONFIG_USB=y')
                config_lines.append('CONFIG_USB_BUS=y')
                config_lines.append('CONFIG_STM32_USB_PA11_PA12=y')
            elif 'CAN' in communication:
                config_lines.append('CONFIG_CANBUS=y')
                config_lines.append('CONFIG_CANBUS_FREQUENCY=1000000')
                if 'PB8/PB9' in communication:
                    config_lines.append('CONFIG_STM32_CANBUS_PB8_PB9=y')
                elif 'PA11/PA12' in communication:
                    config_lines.append('CONFIG_STM32_CANBUS_PA11_PA12=y')
            elif 'Serial' in communication:
                config_lines.append('CONFIG_SERIAL=y')
                config_lines.append('CONFIG_STM32_SERIAL_USART1=y')
        elif processor_upper.startswith('SAM') or 'ATSAMD' in mcu_arch_upper:
            # ATSAMD 通信接口
            if 'USB' in communication:
                config_lines.append('CONFIG_USB=y')
            elif 'CAN' in communication:
                config_lines.append('CONFIG_SAMD_CANBUS=y')
                config_lines.append('CONFIG_CANBUS_FREQUENCY=1000000')
            elif 'Serial' in communication or 'UART' in communication:
                config_lines.append('CONFIG_SERIAL=y')
        elif processor_upper.startswith('LPC176'):
            # LPC176x 通信接口
            if 'USB' in communication:
                config_lines.append('CONFIG_USB=y')
            elif 'Serial' in communication or 'UART' in communication:
                config_lines.append('CONFIG_SERIAL=y')
        elif 'HC32F460' in processor_upper:
            # HC32F460 通信接口
            if 'Serial' in communication or 'UART' in communication:
                config_lines.append('CONFIG_HC32F460_SERIAL_PA7_PA8=y')
        elif processor_upper.startswith('ATMEGA') or processor_upper.startswith('AT90USB') or processor_upper.startswith('ATMega'):
            # AVR 通信接口
            if 'USB' in communication:
                config_lines.append('CONFIG_USB=y')
            elif 'Serial' in communication or 'UART' in communication:
                config_lines.append('CONFIG_SERIAL=y')
        
        # 启动引脚（验证格式）
        if startup_pin:
            is_rp2040 = 'RP2040' in processor or 'RP2350' in processor
            import re
            has_stm32_pin = bool(re.search(r'P[A-K]\d+', startup_pin, re.IGNORECASE))
            has_rp2040_pin = bool(re.search(r'gpio\d+', startup_pin, re.IGNORECASE))
            
            # RP2040不应包含STM32格式引脚
            if is_rp2040 and has_stm32_pin and not has_rp2040_pin:
                return jsonify({'error': 'RP2040/RP2350启动引脚格式错误，应使用gpio格式（如gpio5）'}), 400
            # STM32不应包含RP2040格式引脚
            if not is_rp2040 and has_rp2040_pin and not has_stm32_pin:
                return jsonify({'error': 'STM32启动引脚格式错误，应使用大写格式（如PA2, PB9）'}), 400
            
            config_lines.append(f'CONFIG_INITIAL_PINS="{startup_pin}"')
        
        # 写入配置
        config_content = '\n'.join(config_lines) + '\n'
        config_path = os.path.join(klipper_path, '.config')
        with open(config_path, 'w') as f:
            f.write(config_content)
        
        # 确保 out 目录存在且权限正确
        out_dir = os.path.join(klipper_path, 'out')
        os.makedirs(out_dir, exist_ok=True)
        try:
            os.chmod(out_dir, 0o755)
        except:
            pass
        
        # 使用make olddefconfig补全配置
        olddefconfig_result = subprocess.run(
            f'cd {klipper_path} && make olddefconfig',
            shell=True, capture_output=True, text=True, timeout=60
        )
        
        if olddefconfig_result.returncode != 0:
            return jsonify({
                'success': False,
                'error': '配置生成失败',
                'output': olddefconfig_result.stderr
            }), 500
        
        # 编译
        compile_result = subprocess.run(
            f'cd {klipper_path} && make -j4',
            shell=True, capture_output=True, text=True, timeout=300
        )
        
        output = compile_result.stdout + compile_result.stderr
        
        # 检查编译是否成功 - 支持多种固件格式
        out_dir = os.path.join(klipper_path, 'out')
        firmware_files = ['klipper.bin', 'klipper.uf2']
        firmware_path = None
        
        for fw_file in firmware_files:
            fw_path = os.path.join(out_dir, fw_file)
            if os.path.exists(fw_path):
                firmware_path = fw_path
                break
        
        if compile_result.returncode == 0 and firmware_path:
            # 修改文件权限为普通用户可读写 (666)
            try:
                os.chmod(firmware_path, 0o666)
                # 也修改 out 目录权限
                os.chmod(out_dir, 0o755)
                # 修改文件所有者为运行服务的实际用户（避免root编译后普通用户无权限）
                import shutil
                shutil.chown(firmware_path, user='fenghua', group='fenghua')
                shutil.chown(out_dir, user='fenghua', group='fenghua')
                # 递归修改 out 目录下所有文件/子目录的所有者
                for root_dir, dirs, files in os.walk(out_dir):
                    for d in dirs:
                        shutil.chown(os.path.join(root_dir, d), user='fenghua', group='fenghua')
                    for f in files:
                        shutil.chown(os.path.join(root_dir, f), user='fenghua', group='fenghua')
                # 同时修改 .config 文件所有者
                config_file = os.path.join(klipper_path, '.config')
                if os.path.exists(config_file):
                    shutil.chown(config_file, user='fenghua', group='fenghua')
            except Exception as e:
                logger.warning(f"修改文件权限失败: {e}")
            
            # 获取固件大小
            firmware_size = os.path.getsize(firmware_path)
            # 格式化为人类可读
            if firmware_size < 1024:
                size_str = f'{firmware_size} bytes'
            elif firmware_size < 1024 * 1024:
                size_str = f'{firmware_size / 1024:.1f} KB'
            else:
                size_str = f'{firmware_size / (1024 * 1024):.2f} MB'
            
            return jsonify({
                'success': True,
                'message': '编译成功',
                'output': output,
                'firmware_path': firmware_path,
                'firmware_size': size_str,
                'firmware_size_bytes': firmware_size
            })
        else:
            return jsonify({
                'success': False,
                'error': '编译失败',
                'output': output
            }), 500
            
    except subprocess.TimeoutExpired:
        return jsonify({'error': '编译超时'}), 500
    except Exception as e:
        return jsonify({'error': str(e)}), 500

# ==================== 固件下载 API ====================
@app.route('/api/firmware/download')
def download_firmware():
    """下载固件文件"""
    try:
        firmware_path = request.args.get('path', '')
        klipper_path = os.path.expanduser(config.get('klipper_path', '~/klipper'))
        
        if not firmware_path:
            # 默认使用klipper/out/klipper.bin
            firmware_path = os.path.join(klipper_path, 'out', 'klipper.bin')
        
        firmware_path = os.path.expanduser(firmware_path)
        
        # 安全检查
        allowed_paths = [
            os.path.expanduser('~/klipper/out'),
            '/data/klipper/out',
            os.path.join(BASE_DIR, 'board_configs'),
            os.path.join(BASE_DIR, 'out')  # 编译输出目录
        ]
        
        is_allowed = any(firmware_path.startswith(p) for p in allowed_paths)
        if not is_allowed:
            return jsonify({'error': '非法路径'}), 403
        
        if not os.path.exists(firmware_path):
            return jsonify({'error': '固件文件不存在'}), 404
        
        return send_file(firmware_path, as_attachment=True, download_name='firmware.bin')
    except Exception as e:
        return jsonify({'error': str(e)}), 500

# ==================== 设备检测 API ====================
@app.route('/api/firmware/detect')
def detect_devices():
    """检测设备"""
    try:
        devices = []
        
        # USB设备
        try:
            result = subprocess.run(
                'ls /dev/serial/by-id/* 2>/dev/null || echo ""',
                shell=True, capture_output=True, text=True
            )
            if result.stdout:
                for line in result.stdout.strip().split('\n'):
                    if '/dev/serial/by-id/' in line:
                        devices.append(line.strip())
        except:
            pass
        
        # DFU设备
        try:
            result = subprocess.run(
                'lsusb | grep "0483:df11" || echo ""',
                shell=True, capture_output=True, text=True
            )
            if result.stdout and '0483:df11' in result.stdout:
                devices.append('DFU Device (0483:df11)')
        except:
            pass
        
        return jsonify({'devices': devices})
    except Exception as e:
        return jsonify({'error': str(e)}), 500

# ==================== CAN设备搜索 API ====================
@app.route('/api/firmware/can/scan')
def scan_can_devices():
    """扫描CAN设备 - 使用Klipper的canbus_query.py"""
    try:
        result = subprocess.run(
            '~/klippy-env/bin/python ~/klipper/scripts/canbus_query.py can0 2>/dev/null || echo ""',
            shell=True, capture_output=True, text=True, timeout=10
        )
        
        devices = []
        if result.stdout:
            for line in result.stdout.strip().split('\n'):
                if 'uuid' in line.lower():
                    # 解析UUID
                    match = re.search(r'([a-f0-9]{8,})', line)
                    if match:
                        devices.append({
                            'uuid': match.group(1),
                            'raw': line.strip()
                        })
        
        return jsonify({'devices': devices})
    except Exception as e:
        return jsonify({'error': str(e)}), 500

# ==================== 固件烧录 API ====================
@app.route('/api/firmware/flash', methods=['POST'])
def flash_firmware():
    """烧录固件"""
    try:
        data = request.json
        klipper_path = os.path.expanduser(config.get('klipper_path', '~/klipper'))
        device = data.get('device', '')
        flash_mode = data.get('flash_mode', 'DFU')
        dfu_address = data.get('dfu_address', '0x08000000')
        firmware_path = data.get('firmware_path', '')
        
        # 确定固件路径（根据烧录模式选择合适的文件）
        if not firmware_path:
            firmware_uf2 = os.path.join(klipper_path, 'out', 'klipper.uf2')
            firmware_bin = os.path.join(klipper_path, 'out', 'klipper.bin')
            
            # UF2模式优先使用.uf2文件
            if flash_mode == 'UF2' and os.path.exists(firmware_uf2):
                firmware_path = firmware_uf2
            elif os.path.exists(firmware_uf2):
                firmware_path = firmware_uf2
            else:
                firmware_path = firmware_bin
        
        if not os.path.exists(firmware_path):
            return jsonify({'error': f'固件文件不存在: {firmware_path}'}), 400
        
        # TF卡模式 - 返回下载链接
        if flash_mode == 'TF':
            return jsonify({
                'success': True,
                'message': 'TF卡模式: 请下载固件并复制到TF卡',
                'download_url': '/api/firmware/download',
                'mode': 'tf_card'
            })
        
        if flash_mode == 'DFU':
            # DFU烧录：先擦除再烧录
            erase_cmd = f'sudo dfu-util -a 0 -d 0483:df11 --dfuse-address {dfu_address} -e'
            flash_cmd = f'sudo dfu-util -a 0 -d 0483:df11 --dfuse-address {dfu_address} -D {firmware_path}'
            
            erase_result = subprocess.run(erase_cmd, shell=True, capture_output=True, text=True, timeout=30)
            flash_result = subprocess.run(flash_cmd, shell=True, capture_output=True, text=True, timeout=60)
            
            output = f"擦除: {erase_result.stdout + erase_result.stderr}\n烧录: {flash_result.stdout + flash_result.stderr}"
            returncode = flash_result.returncode
            
        elif flash_mode == 'KAT':
            # Katapult 烧录 - 自动判断 USB 或 CAN 方式
            import pwd
            try:
                home_dir = pwd.getpwnam('fenghua').pw_dir
            except KeyError:
                home_dir = os.path.expanduser('~')
                    
            python_bin = os.path.join(home_dir, 'klippy-env', 'bin', 'python3')
            flashtool_script = os.path.join(home_dir, 'katapult', 'scripts', 'flashtool.py')
                    
            import logging
                    
            # 判断设备类型
            if 'can0:' in device or (len(device) == 12 and all(c in '0123456789abcdef' for c in device.lower())):  # CAN UUID
                # CAN 方式：先尝试重置进入 USB 烧录模式
                can_uuid = device.replace('can0:', '') if 'can0:' in device else device
                
                # 第一步：发送重置命令，让设备进入 Katapult USB 模式
                reset_cmd = f'{python_bin} {flashtool_script} -i can0 -r -u {can_uuid}'
                logging.info(f'CAN 重置命令：{reset_cmd}')
                reset_result = subprocess.run(reset_cmd, shell=True, capture_output=True, text=True, timeout=30)
                
                # 第二步：等待设备重新枚举
                import time
                logging.info('等待设备重新枚举...')
                time.sleep(3)
                
                # 第三步：查找新的 USB 串口设备
                find_device_cmd = "ls /dev/serial/by-id/*katapult* 2>/dev/null | head -1"
                device_result = subprocess.run(find_device_cmd, shell=True, capture_output=True, text=True, timeout=10)
                
                if device_result.stdout.strip():
                    # 成功进入 USB 模式，使用 USB 方式烧录
                    new_device = device_result.stdout.strip()
                    logging.info(f'找到设备：{new_device}')
                    cmd = f'{python_bin} {flashtool_script} -d {new_device} -f {firmware_path}'
                    logging.info(f'USB 烧录命令：{cmd}')
                    result = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=60)
                else:
                    # 降级方案：设备可能已经在 Katapult CAN 模式，直接 CAN 烧录
                    logging.warning('未找到 USB 串口设备，尝试直接 CAN 烧录...')
                    flash_can_script = os.path.join(home_dir, 'klipper', 'lib', 'canboot', 'flash_can.py')
                    cmd = f'{python_bin} {flash_can_script} -i can0 -u {can_uuid} -f {firmware_path}'
                    logging.info(f'CAN 烧录命令：{cmd}')
                    result = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=120)
            else:
                # USB 方式：直接烧录
                logging.info(f'USB 烧录命令：device={device}')
                cmd = f'{python_bin} {flashtool_script} -d {device} -f {firmware_path}'
                logging.info(f'USB 烧录命令：{cmd}')
                result = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=60)
                    
            output = result.stdout + result.stderr
            returncode = result.returncode
            logging.info(f'烧录结果：returncode={returncode}, output={output[:200]}')
            
        elif flash_mode == 'UF2':
            # UF2烧录（RP2040/RP2350）- 使用rp2040_flash工具
            rp2040_flash_tool = os.path.join(klipper_path, 'lib/rp2040_flash/rp2040_flash')
            
            if not os.path.exists(rp2040_flash_tool):
                return jsonify({'error': 'rp2040_flash工具不存在，请检查Klipper安装'}), 500
            
            # 先卸载RP2040 BOOT设备（避免设备占用）
            import time
            subprocess.run('sudo umount /dev/sda1 2>/dev/null || true', shell=True, capture_output=True, timeout=10)
            subprocess.run('sudo umount /dev/sda 2>/dev/null || true', shell=True, capture_output=True, timeout=10)
            time.sleep(0.5)
            
            cmd = f'sudo {rp2040_flash_tool} {firmware_path}'
            result = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=60)
            output = result.stdout + result.stderr
            returncode = result.returncode
        else:
            return jsonify({'error': f'不支持的烧录方式: {flash_mode}'}), 400
        
        if returncode == 0:
            return jsonify({'success': True, 'message': '烧录成功', 'output': output})
        else:
            return jsonify({'success': False, 'error': '烧录失败', 'output': output}), 500
            
    except subprocess.TimeoutExpired:
        return jsonify({'error': '烧录超时'}), 500
    except Exception as e:
        return jsonify({'error': str(e)}), 500

# ==================== HOST固件安装 API ====================
@app.route('/api/firmware/install-host', methods=['POST'])
def install_host_firmware():
    """安装固件到上位机（Linux进程）"""
    try:
        data = request.json
        firmware_path = data.get('firmware_path', '')
        
        if not firmware_path:
            return jsonify({'error': '固件路径不能为空'}), 400
        
        firmware_path = os.path.expanduser(firmware_path)
        
        if not os.path.exists(firmware_path):
            return jsonify({'error': f'固件文件不存在: {firmware_path}'}), 400
        
        # 复制到 klipper/out/klipper.elf
        klipper_path = os.path.expanduser(config.get('klipper_path', '~/klipper'))
        target_path = os.path.join(klipper_path, 'out', 'klipper.elf')
        
        # 确保目录存在
        os.makedirs(os.path.dirname(target_path), exist_ok=True)
        
        # 复制文件
        import shutil
        shutil.copy2(firmware_path, target_path)
        
        # 设置权限
        os.chmod(target_path, 0o755)
        
        return jsonify({
            'success': True,
            'message': f'固件已安装到 {target_path}，请重启Klipper服务',
            'target_path': target_path
        })
        
    except Exception as e:
        return jsonify({'error': str(e)}), 500

# ==================== BL固件烧录 API ====================
@app.route('/api/firmware/bl/flash', methods=['POST'])
def flash_bl_firmware():
    """烧录BL固件 (Katapult/Bootloader)"""
    try:
        data = request.json
        bl_firmware_path = data.get('bl_firmware_path', '')
        device = data.get('device', '')
        flash_mode = data.get('flash_mode', 'DFU')
        
        if not bl_firmware_path or not os.path.exists(bl_firmware_path):
            return jsonify({'error': f'BL固件文件不存在: {bl_firmware_path}'}), 400
        
        # BL固件默认从0x08000000开始（无偏移）
        dfu_address = '0x08000000'
        
        if flash_mode == 'DFU':
            cmd = f'sudo dfu-util -a 0 -d 0483:df11 --dfuse-address {dfu_address} -D {bl_firmware_path}'
            result = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=60)
            
        elif flash_mode == 'UF2':
            # UF2烧录（RP2040/RP2350）- 使用rp2040_flash工具
            klipper_path = os.path.expanduser(config.get('klipper_path', '~/klipper'))
            rp2040_flash_tool = os.path.join(klipper_path, 'lib/rp2040_flash/rp2040_flash')
            
            if not os.path.exists(rp2040_flash_tool):
                return jsonify({'error': 'rp2040_flash工具不存在，请检查Klipper安装'}), 500
            
            # 先卸载RP2040 BOOT设备
            import time
            subprocess.run('sudo umount /dev/sda1 2>/dev/null || true', shell=True, capture_output=True, timeout=10)
            subprocess.run('sudo umount /dev/sda 2>/dev/null || true', shell=True, capture_output=True, timeout=10)
            time.sleep(0.5)
            
            cmd = f'sudo {rp2040_flash_tool} {bl_firmware_path}'
            result = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=60)
            
        elif flash_mode == 'KAT':
            cmd = f'python3 ~/katapult/scripts/flashtool.py -d {device}'
            result = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=60)
        else:
            return jsonify({'error': f'不支持的BL烧录方式: {flash_mode}'}), 400
        
        if result.returncode == 0:
            return jsonify({'success': True, 'message': 'BL固件烧录成功', 'output': result.stdout})
        else:
            return jsonify({'success': False, 'error': 'BL固件烧录失败', 'output': result.stderr}), 500
            
    except Exception as e:
        return jsonify({'error': str(e)}), 500

# ==================== 系统设置 API ====================
@app.route('/api/settings/config', methods=['GET', 'POST'])
def handle_config():
    """获取或更新系统配置"""
    global config, PORT
    
    if request.method == 'GET':
        return jsonify(config)
    else:
        data = request.json
        # 更新配置
        for key in ['klipper_path', 'json_repo_url', 'port']:
            if key in data:
                config[key] = data[key]
        
        # 如果端口改变，更新全局PORT（需要重启生效）
        if 'port' in data:
            PORT = data['port']
        
        # JSON仓库地址
        if 'json_repo_url' in data:
            config['json_repo_url'] = data['json_repo_url']
        
        if save_config(config):
            return jsonify({'success': True, 'message': '配置已保存', 'config': config})
        else:
            return jsonify({'error': '保存配置失败'}), 500

# ==================== Web 界面切换 API ====================
@app.route('/api/system/web-ui', methods=['GET'])
def get_web_ui_status():
    """获取当前 Web界面状态"""
    try:
        # 检测哪个端口有服务在运行
        fluidd_active = False
        mainsail_active = False
        
        try:
            # 检查端口 80（Fluidd）
            result = subprocess.run(
                'sudo ss -tlnp 2>/dev/null | grep ":80 " || sudo netstat -tlnp 2>/dev/null | grep ":80 "',
                shell=True, capture_output=True, text=True
            )
            fluidd_active = ':80' in result.stdout and 'LISTEN' in result.stdout
        except:
            pass
        
        try:
            # 检查端口 81（Mainsail）
            result = subprocess.run(
                'sudo ss -tlnp 2>/dev/null | grep ":81 " || sudo netstat -tlnp 2>/dev/null | grep ":81 "',
                shell=True, capture_output=True, text=True
            )
            mainsail_active = ':81' in result.stdout and 'LISTEN' in result.stdout
        except:
            pass
        
        if fluidd_active:
            return jsonify({'current_ui': 'fluidd', 'port': 80})
        elif mainsail_active:
            return jsonify({'current_ui': 'mainsail', 'port': 81})
        else:
            return jsonify({'current_ui': 'unknown', 'port': None})
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/api/system/web-ui/switch', methods=['POST'])
def switch_web_ui():
    """切换 Web界面（Fluidd ↔ Mainsail）- 80 端口固定显示激活的界面"""
    try:
        data = request.get_json()
        target = data.get('target', '')
        
        if not target or target not in ['fluidd', 'mainsail']:
            return jsonify({'error': '无效的目标界面'}), 400
        
        # 目标端口（始终使用 80）
        target_port = 80
        other_port = 81
        
        messages = []
        
        # 1. 读取并修改 nginx 配置
        nginx_configs = [
            '/etc/nginx/sites-enabled/fluidd',
            '/etc/nginx/sites-enabled/mainsail'
        ]
        
        for config_file in nginx_configs:
            if os.path.exists(config_file):
                try:
                    with open(config_file, 'r') as f:
                        content = f.read()
                    
                    # 逐行处理 nginx 配置
                    lines = content.split('\n')
                    new_lines = []
                    has_active_listen_80 = False
                    has_active_listen_81 = False
                    
                    for line in lines:
                        stripped = line.strip()
                        
                        # 检查是否是 listen 80 或 listen 81 的行（包括已注释的）
                        if re.match(r'^#?\s*listen\s+80\s*;$', stripped):
                            # 只有未注释的才算数
                            if not stripped.startswith('#'):
                                has_active_listen_80 = True
                            
                            if target in config_file:
                                # 目标服务：应该在 80 运行
                                new_lines.append('    listen 80;')
                            else:
                                # 非目标服务：禁用 80
                                new_lines.append('    # listen 80;')
                        elif re.match(r'^#?\s*listen\s+81\s*;$', stripped):
                            # 只有未注释的才算数
                            if not stripped.startswith('#'):
                                has_active_listen_81 = True
                            
                            if target in config_file:
                                # 目标服务：禁用 81
                                new_lines.append('    # listen 81;')
                            else:
                                # 非目标服务：应该在 81 运行
                                new_lines.append('    listen 81;')
                        else:
                            # 其他行保持不变
                            new_lines.append(line)
                    
                    content = '\n'.join(new_lines)
                    
                    # 添加成功消息
                    if target in config_file:
                        messages.append(f'已启用 {target.capitalize()} (端口 80)')
                    else:
                        other_name = 'Mainsail' if target == 'fluidd' else 'Fluidd'
                        messages.append(f'已配置 {other_name} (端口 81)')
                    
                    # 写回文件
                    with open(config_file, 'w') as f:
                        f.write(content)
                except Exception as e:
                    messages.append(f'配置文件处理失败：{str(e)}')
        
        # 2. 重新加载 nginx 配置
        try:
            result = subprocess.run('sudo nginx -t && sudo systemctl reload nginx', 
                                  shell=True, capture_output=True, text=True)
            if result.returncode == 0:
                messages.append(f'Nginx 配置已重载，{target.capitalize()} 已在端口 80 就绪')
            else:
                messages.append(f'Nginx 重载失败：{result.stderr}')
        except Exception as e:
            messages.append(f'Nginx 重载失败：{str(e)}')
        
        return jsonify({
            'success': True,
            'message': f'已切换到 {target.capitalize()}（端口 80）',
            'messages': messages
        })
    except Exception as e:
        return jsonify({'error': str(e)}), 500
CAN_NETWORK_DIR = '/etc/systemd/network'
CAN_INTERFACES_DIR = '/etc/network/interfaces.d'

def detect_can_config_type():
    """检测CAN配置类型"""
    # 检测systemd-networkd配置
    if os.path.exists(CAN_NETWORK_DIR):
        for filename in os.listdir(CAN_NETWORK_DIR):
            if 'can' in filename.lower() and filename.endswith('.network'):
                return 'systemd', os.path.join(CAN_NETWORK_DIR, filename)
    
    # 检测传统interfaces配置
    if os.path.exists(CAN_INTERFACES_DIR):
        for filename in os.listdir(CAN_INTERFACES_DIR):
            if 'can' in filename.lower():
                return 'interfaces', os.path.join(CAN_INTERFACES_DIR, filename)
    
    return None, None

@app.route('/api/system/can-config', methods=['GET'])
def get_can_config():
    """获取当前CAN配置"""
    try:
        config_type, config_path = detect_can_config_type()
        
        if not config_type:
            return jsonify({
                'exists': False,
                'message': '未检测到CAN配置文件'
            })
        
        # 读取配置内容
        with open(config_path, 'r') as f:
            content = f.read()
        
        # 解析配置
        config = {
            'exists': True,
            'type': config_type,
            'path': config_path,
            'content': content
        }
        
        # 解析速率
        if config_type == 'systemd':
            # 解析 BitRate=1000000 或 BitRate=1M
            import re
            bitrate_match = re.search(r'BitRate\s*=\s*(\d+)', content)
            if bitrate_match:
                bitrate_val = int(bitrate_match.group(1))
                # 转换M单位到完整数值
                if bitrate_val == 1:
                    config['bitrate'] = 1000000
                elif bitrate_val == 500:
                    config['bitrate'] = 500000
                elif bitrate_val == 250:
                    config['bitrate'] = 250000
                else:
                    config['bitrate'] = bitrate_val
            
            # 解析 TxQueueLength（从.link文件）
            link_file = os.path.join(CAN_NETWORK_DIR, '99-can.link')
            if os.path.exists(link_file):
                with open(link_file, 'r') as f:
                    link_content = f.read()
                txqueue_match = re.search(r'TxQueueLength\s*=\s*(\d+)', link_content)
                if txqueue_match:
                    config['txqueuelen'] = int(txqueue_match.group(1))
        else:
            # 解析传统配置 bitrate 1000000
            import re
            bitrate_match = re.search(r'bitrate\s+(\d+)', content)
            if bitrate_match:
                config['bitrate'] = int(bitrate_match.group(1))
        
        # 获取当前CAN0状态
        try:
            result = subprocess.run(
                'ip -details link show can0 2>/dev/null || echo "CAN0 not found"',
                shell=True, capture_output=True, text=True
            )
            config['status'] = result.stdout
        except:
            config['status'] = '无法获取CAN0状态'
        
        # 检测 USB CAN设备数量 (OpenMoko CAN 适配器 1d50:xxxx)
        try:
            lsusb_result = subprocess.run(
                'lsusb | grep "1d50:" || echo ""',
                shell=True, capture_output=True, text=True
            )
            # 过滤掉已知的非 CAN设备（如 stm32f072xb、stm32f446 等 Klipper 主板）
            usb_devices = []
            for line in lsusb_result.stdout.strip().split('\n'):
                if not line.strip():
                    continue
                # 排除主板设备，只保留 CAN 适配器
                # 常见主板ID: 614e(stm32f072), 6018(stm32f446), 等
                # CAN 适配器通常是 606f 或其他
                if 'stm32f072' in line.lower() or 'stm32f446' in line.lower():
                    continue
                usb_devices.append(line)
                    
            config['usb_can_count'] = len(usb_devices)
            config['usb_can_devices'] = usb_devices
        except:
            config['usb_can_count'] = 0
            config['usb_can_devices'] = []
        
        return jsonify(config)
        
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/api/system/can-config', methods=['POST'])
def set_can_config():
    """设置CAN配置"""
    try:
        data = request.get_json()
        bitrate = data.get('bitrate', 1000000)
        txqueuelen = data.get('txqueuelen', 1024)
        config_type = data.get('type', 'systemd')
        
        # 检测是否为Fast系统
        is_fast = False
        try:
            with open('/etc/issue', 'r') as f:
                if 'FlyOS-Fast' in f.read():
                    is_fast = True
        except:
            pass
        
        if is_fast:
            return jsonify({
                'success': False,
                'message': 'FlyOS-Fast系统已预设CAN配置，无需修改'
            })
        
        if config_type == 'systemd':
            # 创建systemd-networkd配置
            os.makedirs(CAN_NETWORK_DIR, exist_ok=True)
            
            # 查找或创建配置文件
            config_file = None
            for filename in os.listdir(CAN_NETWORK_DIR):
                if 'can' in filename.lower() and filename.endswith('.network'):
                    config_file = os.path.join(CAN_NETWORK_DIR, filename)
                    break
            
            if not config_file:
                config_file = os.path.join(CAN_NETWORK_DIR, '99-can.network')
            
            # 写入配置 - 转换bitrate为M格式
            if bitrate >= 1000000:
                bitrate_str = f"{bitrate // 1000000}M"
            elif bitrate >= 1000:
                bitrate_str = f"{bitrate // 1000}K"
            else:
                bitrate_str = str(bitrate)
            
            # 使用sudo tee写入配置文件
            config_content = f"""[Match]
Name=can*

[CAN]
BitRate={bitrate_str}
"""
            subprocess.run(f'echo "{config_content}" | sudo tee {config_file} > /dev/null', 
                         shell=True, capture_output=True, check=True)
            
            # 创建link配置文件
            link_content = f"""[Match]
OriginalName=can*

[Link]
TxQueueLength={txqueuelen}
"""
            link_file = os.path.join(CAN_NETWORK_DIR, '99-can.link')
            subprocess.run(f'echo "{link_content}" | sudo tee {link_file} > /dev/null', 
                         shell=True, capture_output=True, check=True)
            
            # 重启systemd-networkd
            subprocess.run('sudo systemctl restart systemd-networkd', shell=True, capture_output=True)
            
            # 立即应用配置到can0接口（如果存在）
            try:
                can0_check = subprocess.run('ip link show can0 2>&1', 
                                           shell=True, capture_output=True, text=True)
                if 'does not exist' not in can0_check.stdout:
                    # can0存在，立即应用新配置
                    subprocess.run('sudo ip link set can0 down', shell=True, capture_output=True)
                    subprocess.run(f'sudo ip link set can0 type can bitrate {bitrate}', 
                                 shell=True, capture_output=True)
                    subprocess.run(f'sudo ip link set can0 txqueuelen {txqueuelen}', 
                                 shell=True, capture_output=True)
                    subprocess.run('sudo ip link set can0 up', shell=True, capture_output=True)
            except:
                pass
            
        else:
            # 创建传统interfaces配置
            subprocess.run(f'sudo mkdir -p {CAN_INTERFACES_DIR}', shell=True, capture_output=True)
            config_file = os.path.join(CAN_INTERFACES_DIR, 'can0')
            
            interfaces_content = f"""allow-hotplug can0
iface can0 can static
    bitrate {bitrate}
    up ifconfig $IFACE txqueuelen {txqueuelen}
    pre-up ip link set can0 type can bitrate {bitrate}
    pre-up ip link set can0 txqueuelen {txqueuelen}
"""
            subprocess.run(f'echo "{interfaces_content}" | sudo tee {config_file} > /dev/null',
                         shell=True, capture_output=True, check=True)
        
        return jsonify({
            'success': True,
            'message': f'CAN配置已更新，速率: {bitrate_str}，已立即生效'
        })
        
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/api/system/can-diagnose', methods=['GET'])
def diagnose_can_network():
    """诊断CAN网络状态"""
    try:
        result = {
            'can_device_exists': False,
            'can_device_info': '',
            'can0_exists': False,
            'can0_state': '',
            'can0_bitrate': '',
            'kernel_support': False,
            'errors': []
        }
        
        # 1. 检查内核CAN支持
        try:
            modprobe_result = subprocess.run(
                'sudo modprobe can && echo "OK" || echo "FAIL"',
                shell=True, capture_output=True, text=True
            )
            result['kernel_support'] = 'OK' in modprobe_result.stdout
        except:
            result['errors'].append('内核CAN模块检查失败')
        
        # 2. 检查USB CAN设备（GS_USB或UTOC）
        try:
            lsusb_result = subprocess.run(
                'lsusb | grep -E "(GS_USB|CAN|UTOC|can)" || echo ""',
                shell=True, capture_output=True, text=True
            )
            if lsusb_result.stdout.strip():
                result['can_device_exists'] = True
                result['can_device_info'] = lsusb_result.stdout.strip()
        except:
            pass
        
        # 3. 检查can0接口
        try:
            can0_result = subprocess.run(
                'ip link show can0 2>&1',
                shell=True, capture_output=True, text=True
            )
            if 'can0' in can0_result.stdout and 'does not exist' not in can0_result.stdout:
                result['can0_exists'] = True
                # 解析状态
                if 'state UP' in can0_result.stdout:
                    result['can0_state'] = 'UP'
                elif 'state DOWN' in can0_result.stdout:
                    result['can0_state'] = 'DOWN'
                else:
                    result['can0_state'] = 'UNKNOWN'
                
                # 获取详细比特率信息
                details_result = subprocess.run(
                    'ip -details link show can0 2>&1 | grep bitrate || echo ""',
                    shell=True, capture_output=True, text=True
                )
                if details_result.stdout.strip():
                    result['can0_bitrate'] = details_result.stdout.strip()
            else:
                result['can0_exists'] = False
                result['errors'].append('can0接口不存在')
        except:
            result['errors'].append('can0接口检查失败')
        
        return jsonify(result)
        
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/api/system/can-repair', methods=['POST'])
def repair_can_network():
    """修复CAN网络"""
    try:
        data = request.json or {}
        bitrate = data.get('bitrate', 1000000)
        txqueuelen = data.get('txqueuelen', 1024)
        
        messages = []
        
        # 1. 加载CAN内核模块
        try:
            subprocess.run('sudo modprobe can', shell=True, capture_output=True)
            subprocess.run('sudo modprobe can_raw', shell=True, capture_output=True)
            subprocess.run('sudo modprobe gs_usb', shell=True, capture_output=True)
            messages.append('CAN内核模块已加载')
        except:
            messages.append('CAN内核模块加载失败')
        
        # 2. 检查是否有USB CAN设备
        lsusb_result = subprocess.run(
            'lsusb | grep -E "(GS_USB|CAN|UTOC)" || echo ""',
            shell=True, capture_output=True, text=True
        )
        
        if not lsusb_result.stdout.strip():
            return jsonify({
                'success': False,
                'error': '未检测到USB CAN设备，请检查硬件连接',
                'messages': messages
            }), 400
        
        # 3. 创建systemd-networkd配置
        try:
            os.makedirs(CAN_NETWORK_DIR, exist_ok=True)
            
            # 转换bitrate为M格式
            if bitrate >= 1000000:
                bitrate_str = f"{bitrate // 1000000}M"
            elif bitrate >= 1000:
                bitrate_str = f"{bitrate // 1000}K"
            else:
                bitrate_str = str(bitrate)
            
            config_content = f"""[Match]
Name=can*

[CAN]
BitRate={bitrate_str}
"""
            subprocess.run(
                f'echo "{config_content}" | sudo tee {CAN_NETWORK_DIR}/99-can.network > /dev/null',
                shell=True, capture_output=True, check=True
            )
            
            # 创建link配置文件
            link_content = f"""[Match]
OriginalName=can*

[Link]
TxQueueLength={txqueuelen}
"""
            subprocess.run(
                f'echo "{link_content}" | sudo tee {CAN_NETWORK_DIR}/99-can.link > /dev/null',
                shell=True, capture_output=True, check=True
            )
            
            messages.append(f'CAN配置文件已创建（速率: {bitrate_str}）')
        except Exception as e:
            messages.append(f'配置文件创建失败: {str(e)}')
        
        # 4. 重启systemd-networkd
        try:
            subprocess.run('sudo systemctl restart systemd-networkd', 
                         shell=True, capture_output=True, check=True)
            messages.append('systemd-networkd已重启')
        except:
            messages.append('systemd-networkd重启失败')
        
        # 5. 等待并启动can0
        import time
        time.sleep(2)
        
        try:
            # 检查can0是否存在，如果不存在尝试手动创建
            can0_check = subprocess.run('ip link show can0 2>&1', 
                                       shell=True, capture_output=True, text=True)
            
            if 'does not exist' in can0_check.stdout:
                # 尝试手动创建can0（如果知道设备名）
                messages.append('can0接口不存在，尝试手动创建...')
                # 查找CAN设备
                can_devs = subprocess.run('ls /sys/bus/usb/devices/*/can* 2>/dev/null || echo ""',
                                         shell=True, capture_output=True, text=True)
                messages.append(f'找到的CAN设备: {can_devs.stdout.strip() or "无"}')
            else:
                # 启动can0
                subprocess.run('sudo ip link set can0 up', 
                             shell=True, capture_output=True, check=True)
                messages.append('can0接口已启动')
        except Exception as e:
            messages.append(f'can0启动失败: {str(e)}')
        
        return jsonify({
            'success': True,
            'messages': messages,
            'note': '修复完成，请刷新页面查看状态。如果仍有问题，请检查硬件连接或重启系统。'
        })
        
    except Exception as e:
        return jsonify({'error': str(e)}), 500

# ==================== JSON仓库更新 API ====================
@app.route('/api/settings/update-json', methods=['POST'])
def update_json_repo():
    """从远程仓库更新JSON配置"""
    try:
        data = request.get_json() or {}
        repo_url = data.get('json_repo_url', '') or config.get('json_repo_url', '')
        if not repo_url:
            return jsonify({'error': '未配置JSON仓库地址'}), 400
        
        # 使用git克隆或拉取
        temp_dir = os.path.join(BASE_DIR, 'temp_bl_repo')
        
        # 清理临时目录
        if os.path.exists(temp_dir):
            shutil.rmtree(temp_dir)
        
        # 克隆仓库
        result = subprocess.run(
            f'git clone --depth 1 {repo_url} {temp_dir}',
            shell=True, capture_output=True, text=True, timeout=60
        )
        
        if result.returncode != 0:
            return jsonify({'error': f'克隆仓库失败: {result.stderr}'}), 500
        
        # 合并JSON配置到本地
        # 策略：复制所有文件，有冲突则覆盖（仓库优先）
        source_configs = os.path.join(temp_dir, 'board_configs')
        if not os.path.exists(source_configs):
            # 如果仓库根目录就是配置，直接使用
            source_configs = temp_dir
        
        updated_files = []
        
        # 递归复制所有文件
        for root, dirs, files in os.walk(source_configs):
            # 跳过.git目录
            if '.git' in root:
                continue
            
            # 计算相对路径
            rel_path = os.path.relpath(root, source_configs)
            if rel_path == '.':
                rel_path = ''
            
            # 目标目录
            target_dir = os.path.join(BOARD_CONFIGS_DIR, rel_path)
            os.makedirs(target_dir, exist_ok=True)
            
            # 复制文件
            for filename in files:
                # 跳过非JSON文件和README
                if filename.endswith('.md') or filename.startswith('.'):
                    continue
                
                src = os.path.join(root, filename)
                dst = os.path.join(target_dir, filename)
                
                if os.path.isfile(src):
                    shutil.copy2(src, dst)
                    updated_files.append(os.path.join(rel_path, filename) if rel_path else filename)
        
        # 清理临时目录
        if os.path.exists(temp_dir):
            shutil.rmtree(temp_dir)
        
        # 更新最后更新时间
        config['last_json_update'] = datetime.now().isoformat()
        save_config(config)
        
        return jsonify({
            'success': True, 
            'message': f'JSON配置已更新，共同步 {len(updated_files)} 个文件',
            'files': updated_files
        })
            
    except subprocess.TimeoutExpired:
        return jsonify({'error': '更新超时'}), 500
    except Exception as e:
        return jsonify({'error': str(e)}), 500

# ==================== 时区设置 API ====================
@app.route('/api/settings/timezone', methods=['GET', 'POST'])
def handle_timezone():
    """获取或设置时区"""
    if request.method == 'GET':
        try:
            result = subprocess.run(['timedatectl', 'show', '--property=Timezone'], 
                                  capture_output=True, text=True)
            timezone = result.stdout.strip().replace('Timezone=', '')
            return jsonify({'timezone': timezone})
        except:
            return jsonify({'timezone': 'Unknown'})
    else:
        data = request.json
        new_timezone = data.get('timezone', 'Asia/Shanghai')
        try:
            subprocess.run(['sudo', 'timedatectl', 'set-timezone', new_timezone], 
                         check=True, capture_output=True)
            return jsonify({'success': True, 'message': f'时区已设置为 {new_timezone}'})
        except Exception as e:
            return jsonify({'error': str(e)}), 500

# ==================== 服务管理 API ====================
@app.route('/api/settings/service/<action>', methods=['POST'])
def manage_service(action):
    """管理服务"""
    valid_actions = ['restart', 'stop', 'start', 'status']
    if action not in valid_actions:
        return jsonify({'error': '无效的操作'}), 400
    
    data = request.json
    service = data.get('service', '')
    
    if not service:
        return jsonify({'error': '未指定服务'}), 400
    
    try:
        if action == 'status':
            result = subprocess.run(['systemctl', 'is-active', service], 
                                  capture_output=True, text=True)
            is_active = result.returncode == 0
            return jsonify({'service': service, 'active': is_active})
        else:
            result = subprocess.run(['sudo', 'systemctl', action, service], 
                                  capture_output=True, text=True)
            if result.returncode == 0:
                return jsonify({'success': True, 'message': f'{service} {action}成功'})
            else:
                return jsonify({'error': result.stderr}), 500
    except Exception as e:
        return jsonify({'error': str(e)}), 500

# ==================== 启动时自动更新JSON ====================
def auto_update_json():
    """启动时自动更新JSON配置"""
    try:
        repo_url = config.get('json_repo_url', '')
        if not repo_url:
            logger.info('未配置JSON仓库地址，跳过自动更新')
            return
        
        logger.info('正在自动更新JSON配置...')
        
        temp_dir = os.path.join(BASE_DIR, 'temp_json_repo')
        if os.path.exists(temp_dir):
            shutil.rmtree(temp_dir)
        
        result = subprocess.run(
            f'git clone --depth 1 {repo_url} {temp_dir}',
            shell=True, capture_output=True, text=True, timeout=60
        )
        
        if result.returncode != 0:
            logger.error(f'自动更新JSON失败: {result.stderr}')
            return
        
        # 合并JSON配置到本地
        source_configs = os.path.join(temp_dir, 'board_configs')
        if not os.path.exists(source_configs):
            source_configs = temp_dir
        
        updated_count = 0
        
        for root, dirs, files in os.walk(source_configs):
            if '.git' in root:
                continue
            
            rel_path = os.path.relpath(root, source_configs)
            if rel_path == '.':
                rel_path = ''
            
            target_dir = os.path.join(BOARD_CONFIGS_DIR, rel_path)
            os.makedirs(target_dir, exist_ok=True)
            
            for filename in files:
                if filename.endswith('.md') or filename.startswith('.'):
                    continue
                
                src = os.path.join(root, filename)
                dst = os.path.join(target_dir, filename)
                
                if os.path.isfile(src):
                    shutil.copy2(src, dst)
                    updated_count += 1
        
        if os.path.exists(temp_dir):
            shutil.rmtree(temp_dir)
        
        config['last_json_update'] = datetime.now().isoformat()
        save_config(config)
        
        logger.info(f'JSON配置自动更新成功，共同步 {updated_count} 个文件')
            
    except Exception as e:
        logger.error(f'自动更新JSON出错: {e}')

# ==================== 配置管理 API ====================

@app.route('/api/config/list/<manufacturer>', methods=['GET'])
def list_configs(manufacturer):
    """获取指定厂家的所有配置"""
    try:
        configs = []
        
        # 从 BOARD_CONFIGS_DIR 读取配置
        mfr_dir = os.path.join(BOARD_CONFIGS_DIR, manufacturer)
        if os.path.exists(mfr_dir):
            for board_type in os.listdir(mfr_dir):
                type_dir = os.path.join(mfr_dir, board_type)
                if os.path.isdir(type_dir) and not board_type.startswith('.'):
                    for filename in os.listdir(type_dir):
                        if filename.endswith('.json') and not filename.endswith('.bak'):
                            filepath = os.path.join(type_dir, filename)
                            try:
                                with open(filepath, 'r', encoding='utf-8') as f:
                                    config = json.load(f)
                                    config_id = filename.replace('.json', '')
                                    config['id'] = config_id
                                    config['type'] = board_type
                                    configs.append(config)
                            except Exception as e:
                                logger.error(f"读取配置失败 {filename}: {e}")
        
        # 按名称排序
        configs.sort(key=lambda x: x.get('name', ''))
        
        return jsonify({'configs': configs})
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/api/config/get/<manufacturer>/<config_id>', methods=['GET'])
def get_config(manufacturer, config_id):
    """获取单个配置详情"""
    try:
        mfr_dir = os.path.join(BOARD_CONFIGS_DIR, manufacturer)
        for board_type in ['mainboard', 'toolboard', 'expansion']:
            filepath = os.path.join(mfr_dir, board_type, f"{config_id}.json")
            if os.path.exists(filepath):
                with open(filepath, 'r', encoding='utf-8') as f:
                    config = json.load(f)
                return jsonify(config)
        
        return jsonify({'error': '配置不存在'}), 404
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/api/config/create/<manufacturer>', methods=['POST'])
def create_config(manufacturer):
    """创建新配置"""
    try:
        data = request.get_json()
        
        if not data or 'name' not in data:
            return jsonify({'error': 'Missing required fields'}), 400
        
        # 确定产品类型
        product_type = data.get('type', 'mainboard')
        if product_type not in ['mainboard', 'toolboard', 'expansion']:
            product_type = 'mainboard'
        
        # 生成 ID
        config_id = data.get('id', generate_id_from_name(data['name']))
        
        # 确保目录存在
        type_dir = os.path.join(CONFIGS_DIR, manufacturer, product_type)
        os.makedirs(type_dir, exist_ok=True)
        
        # 保存配置
        filepath = os.path.join(type_dir, f"{config_id}.json")
        with open(filepath, 'w', encoding='utf-8') as f:
            json.dump(data, f, indent=4, ensure_ascii=False)
        
        logger.info(f"创建配置：{manufacturer}/{product_type}/{config_id}.json")
        
        return jsonify({
            'success': True,
            'id': config_id,
            'path': filepath
        })
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/api/config/delete/<manufacturer>/<config_id>', methods=['DELETE'])
def delete_config(manufacturer, config_id):
    """删除配置"""
    try:
        mfr_dir = os.path.join(BOARD_CONFIGS_DIR, manufacturer)
        
        # 在所有类型目录中查找
        for board_type in ['mainboard', 'toolboard', 'expansion']:
            filepath = os.path.join(mfr_dir, board_type, f"{config_id}.json")
            if os.path.exists(filepath):
                os.remove(filepath)
                logger.info(f"删除配置：{filepath}")
                return jsonify({'success': True})
        
        return jsonify({'error': '配置不存在'}), 404
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/api/config/upload', methods=['POST'])
def upload_config():
    """上传配置文件"""
    try:
        manufacturer = request.form.get('manufacturer', 'FLY')
        files = request.files.getlist('files[]')
        
        if not files:
            return jsonify({'error': '没有文件'}), 400
        
        uploaded_count = 0
        
        for file in files:
            if file.filename:
                # 处理路径：configs/{manufacturer}/...
                save_path = os.path.join(CONFIGS_DIR, manufacturer, file.filename)
                
                # 确保目录存在
                os.makedirs(os.path.dirname(save_path), exist_ok=True)
                
                file.save(save_path)
                uploaded_count += 1
                logger.info(f"上传文件：{save_path}")
        
        return jsonify({
            'success': True,
            'uploaded_count': uploaded_count
        })
    except Exception as e:
        return jsonify({'error': str(e)}), 500

def generate_id_from_name(name):
    """从名称生成 ID"""
    import re
    # 转换为小写，替换非字母数字字符为连字符
    config_id = name.lower()
    config_id = re.sub(r'[^a-z0-9]', '-', config_id)
    config_id = re.sub(r'-+', '-', config_id)
    config_id = config_id.strip('-')
    return config_id

KLIPPER_MCU_LIST = {
    "STM32": {
        "platform": "stm32",
        "mcus": [
            {"id": "stm32f103", "name": "STM32F103", "crystal": ["8000000", "12000000"], "bl_offset": ["0", "8192", "16384"]},
            {"id": "stm32f207", "name": "STM32F207", "crystal": ["8000000", "12000000", "25000000"], "bl_offset": ["0", "16384"]},
            {"id": "stm32f401", "name": "STM32F401", "crystal": ["8000000", "12000000", "25000000"], "bl_offset": ["0", "16384"]},
            {"id": "stm32f405", "name": "STM32F405", "crystal": ["8000000", "12000000", "25000000"], "bl_offset": ["0", "16384", "32768"]},
            {"id": "stm32f407", "name": "STM32F407", "crystal": ["8000000", "12000000", "25000000"], "bl_offset": ["0", "16384", "32768"]},
            {"id": "stm32f429", "name": "STM32F429", "crystal": ["8000000", "12000000", "25000000"], "bl_offset": ["0", "16384"]},
            {"id": "stm32f446", "name": "STM32F446", "crystal": ["8000000", "12000000", "25000000"], "bl_offset": ["0", "16384"]},
            {"id": "stm32f765", "name": "STM32F765", "crystal": ["8000000", "12000000", "25000000"], "bl_offset": ["0", "16384"]},
            {"id": "stm32f031", "name": "STM32F031", "crystal": ["8000000"], "bl_offset": ["0"]},
            {"id": "stm32f042", "name": "STM32F042", "crystal": ["8000000"], "bl_offset": ["0", "4096"]},
            {"id": "stm32f070", "name": "STM32F070", "crystal": ["8000000"], "bl_offset": ["0"]},
            {"id": "stm32f072", "name": "STM32F072", "crystal": ["8000000"], "bl_offset": ["0", "4096"]},
            {"id": "stm32g070", "name": "STM32G070", "crystal": ["8000000", "16000000"], "bl_offset": ["0", "2048"]},
            {"id": "stm32g071", "name": "STM32G071", "crystal": ["8000000", "16000000"], "bl_offset": ["0", "2048"]},
            {"id": "stm32g0b0", "name": "STM32G0B0", "crystal": ["8000000", "16000000"], "bl_offset": ["0", "2048"]},
            {"id": "stm32g0b1", "name": "STM32G0B1", "crystal": ["8000000", "16000000"], "bl_offset": ["0", "2048"]},
            {"id": "stm32g431", "name": "STM32G431", "crystal": ["8000000", "16000000", "24000000"], "bl_offset": ["0", "2048"]},
            {"id": "stm32g474", "name": "STM32G474", "crystal": ["8000000", "16000000", "24000000"], "bl_offset": ["0", "2048"]},
            {"id": "stm32h723", "name": "STM32H723", "crystal": ["8000000", "25000000"], "bl_offset": ["0", "16384", "32768"]},
            {"id": "stm32h743", "name": "STM32H743", "crystal": ["8000000", "25000000"], "bl_offset": ["0", "16384", "32768"]},
            {"id": "stm32h750", "name": "STM32H750", "crystal": ["8000000", "25000000"], "bl_offset": ["0", "16384"]},
        ],
        "flash_modes": ["DFU", "KAT", "CAN", "CAN_BRIDGE_DFU", "CAN_BRIDGE_KAT"]
    },
    "RP2040": {
        "platform": "rp2040",
        "mcus": [
            {"id": "rp2040", "name": "RP2040", "crystal": ["12000000"], "bl_offset": ["0", "256", "16384"]},
            {"id": "rp2350", "name": "RP2350", "crystal": ["12000000"], "bl_offset": ["0", "256", "16384"]},
        ],
        "flash_modes": ["UF2", "KAT", "CAN"]
    },
    "ATSAMD": {
        "platform": "atsamd",
        "mcus": [
            {"id": "samc21g18", "name": "SAMC21G18", "crystal": ["8000000", "16000000"], "bl_offset": ["0", "8192"]},
            {"id": "samd21g18", "name": "SAMD21G18", "crystal": ["8000000", "16000000"], "bl_offset": ["0", "8192"]},
            {"id": "samd21e18", "name": "SAMD21E18", "crystal": ["8000000", "16000000"], "bl_offset": ["0", "8192"]},
            {"id": "samd51g19", "name": "SAMD51G19", "crystal": ["8000000", "16000000"], "bl_offset": ["0", "16384"]},
            {"id": "samd51j19", "name": "SAMD51J19", "crystal": ["8000000", "16000000"], "bl_offset": ["0", "16384"]},
            {"id": "same51j19", "name": "SAME51J19", "crystal": ["8000000", "16000000"], "bl_offset": ["0", "16384"]},
        ],
        "flash_modes": ["UF2", "KAT"]
    },
    "LPC176x": {
        "platform": "lpc176x",
        "mcus": [
            {"id": "lpc1768", "name": "LPC1768 (100MHz)", "crystal": ["8000000", "12000000"], "bl_offset": ["0", "16384"]},
            {"id": "lpc1769", "name": "LPC1769 (120MHz)", "crystal": ["8000000", "12000000"], "bl_offset": ["0", "16384"]},
        ],
        "flash_modes": ["DFU", "KAT"]
    },
    "HC32F460": {
        "platform": "hc32f460",
        "mcus": [
            {"id": "hc32f460", "name": "HC32F460", "crystal": ["8000000", "16000000"], "bl_offset": ["0", "0x8000", "0xC000", "0x10000"]},
        ],
        "flash_modes": ["DFU", "KAT"]
    },
    "ATSAM": {
        "platform": "atsam",
        "mcus": [
            {"id": "sam3x8e", "name": "SAM3X8E", "crystal": ["8000000", "16000000"], "bl_offset": ["0", "8192"]},
            {"id": "sam4s8c", "name": "SAM4S8C", "crystal": ["8000000", "16000000"], "bl_offset": ["0", "8192"]},
            {"id": "same70q20b", "name": "SAME70Q20B", "crystal": ["8000000", "12000000"], "bl_offset": ["0", "8192"]},
        ],
        "flash_modes": ["DFU", "KAT"]
    },
    "AVR": {
        "platform": "avr",
        "mcus": [
            {"id": "atmega2560", "name": "ATmega2560", "crystal": ["8000000", "16000000"], "bl_offset": ["0"]},
            {"id": "atmega328p", "name": "ATmega328P", "crystal": ["8000000", "16000000"], "bl_offset": ["0"]},
            {"id": "at90usb1286", "name": "AT90USB1286", "crystal": ["8000000", "16000000"], "bl_offset": ["0"]},
        ],
        "flash_modes": ["DFU"]
    }
}

# 预设厂家列表（可扩展）
PRESET_MANUFACTURERS = ["FLY", "BTT", "MKS", "Creality", "Prusa", "Voron", "自定义"]

@app.route('/api/config/mcu-list', methods=['GET'])
def get_mcu_list():
    """获取 Klipper 支持的 MCU 列表"""
    return jsonify({
        'success': True,
        'mcu_types': list(KLIPPER_MCU_LIST.keys()),
        'mcu_details': KLIPPER_MCU_LIST
    })

@app.route('/api/config/manufacturers', methods=['GET'])
def get_preset_manufacturers():
    """获取厂家列表（从board_configs目录动态读取）"""
    try:
        manufacturers = set()
        
        # 从 board_configs 目录读取所有厂家
        if os.path.exists(BOARD_CONFIGS_DIR):
            for item in os.listdir(BOARD_CONFIGS_DIR):
                item_path = os.path.join(BOARD_CONFIGS_DIR, item)
                if os.path.isdir(item_path) and not item.startswith('.'):
                    manufacturers.add(item)
        
        # 如果没有找到任何厂家，返回默认列表
        if not manufacturers:
            manufacturers = set(PRESET_MANUFACTURERS)
        
        return jsonify({
            'success': True,
            'manufacturers': sorted(list(manufacturers))
        })
    except Exception as e:
        logger.error(f"获取厂家列表失败: {e}")
        return jsonify({
            'success': True,
            'manufacturers': PRESET_MANUFACTURERS
        })

@app.route('/api/config/mcu-info/<mcu_id>', methods=['GET'])
def get_mcu_info(mcu_id):
    """获取特定 MCU 的详细信息"""
    mcu_id = mcu_id.lower()
    
    for mcu_type, data in KLIPPER_MCU_LIST.items():
        for mcu in data['mcus']:
            if mcu['id'] == mcu_id:
                return jsonify({
                    'success': True,
                    'mcu': mcu,
                    'type': mcu_type,
                    'flash_modes': data['flash_modes']
                })
    
    return jsonify({
        'success': False,
        'error': f'未找到 MCU: {mcu_id}'
    }), 404


# ==================== Klipper Kconfig 解析器集成 ====================

from klipper_kconfig_parser import KlipperKconfigParser

# 初始化解析器（启动时解析一次）
klipper_parser = KlipperKconfigParser(config.get('klipper_path', '~/klipper'))
klipper_mcu_db = {}

def init_klipper_mcu_db():
    """初始化 Klipper MCU 数据库"""
    global klipper_mcu_db
    try:
        klipper_mcu_db = klipper_parser.parse_all_platforms()
        logger.info(f"✓ Klipper MCU 数据库已加载: {len(klipper_mcu_db)} 个平台")
        for platform, data in klipper_mcu_db.items():
            logger.info(f"  - {platform}: {len(data['mcus'])} 个 MCU")
    except Exception as e:
        logger.error(f"加载 Klipper MCU 数据库失败: {e}")
        klipper_mcu_db = {}

# 启动时初始化
init_klipper_mcu_db()

@app.route('/api/klipper/mcu-database', methods=['GET'])
def get_klipper_mcu_database():
    """获取完整的 Klipper MCU 数据库"""
    return jsonify({
        'success': True,
        'platforms': list(klipper_mcu_db.keys()),
        'database': klipper_mcu_db
    })

@app.route('/api/klipper/platforms', methods=['GET'])
def get_klipper_platforms():
    """获取所有 MCU 平台列表"""
    platforms = []
    for platform_name, data in klipper_mcu_db.items():
        platforms.append({
            'name': platform_name,
            'mcu_count': len(data['mcus']),
            'flash_modes': data.get('flash_modes', [])
        })
    
    return jsonify({
        'success': True,
        'platforms': platforms
    })

@app.route('/api/klipper/mcus/<platform>', methods=['GET'])
def get_klipper_mcus(platform):
    """获取指定平台的所有 MCU"""
    # 尝试直接匹配，如果不匹配则尝试大小写转换
    if platform in klipper_mcu_db:
        platform_key = platform
    else:
        # 尝试大写
        platform_upper = platform.upper()
        if platform_upper in klipper_mcu_db:
            platform_key = platform_upper
        else:
            # 尝试查找匹配（不区分大小写）
            for key in klipper_mcu_db.keys():
                if key.upper() == platform_upper:
                    platform_key = key
                    break
            else:
                return jsonify({
                    'success': False,
                    'error': f'未找到平台: {platform}'
                }), 404
    
    platform = platform_key
    if platform not in klipper_mcu_db:
        return jsonify({
            'success': False,
            'error': f'未找到平台: {platform}'
        }), 404
    
    data = klipper_mcu_db[platform]
    mcus = []
    for mcu_id, mcu_info in data['mcus'].items():
        mcus.append({
            'id': mcu_id,
            'name': mcu_info['name'],
            'crystals': mcu_info.get('crystals', []),
            'bl_offsets': mcu_info.get('bl_offsets', []),
            'connections': mcu_info.get('connections', [])
        })
    
    return jsonify({
        'success': True,
        'platform': platform,
        'mcus': mcus,
        'flash_modes': data.get('flash_modes', []),
        'connections': data.get('connections', [])
    })

@app.route('/api/klipper/mcu-info/<mcu_id>', methods=['GET'])
def get_klipper_mcu_info(mcu_id):
    """获取特定 MCU 的详细信息"""
    mcu_id = mcu_id.lower()
    
    for platform, data in klipper_mcu_db.items():
        if mcu_id in data['mcus']:
            mcu = data['mcus'][mcu_id]
            return jsonify({
                'success': True,
                'platform': platform,
                'mcu': mcu,
                'flash_modes': data.get('flash_modes', []),
                'connections': data.get('connections', [])
            })
    
    return jsonify({
        'success': False,
        'error': f'未找到 MCU: {mcu_id}'
    }), 404

@app.route('/api/klipper/refresh-database', methods=['POST'])
def refresh_klipper_database():
    """强制刷新 Klipper MCU 数据库"""
    try:
        init_klipper_mcu_db()
        return jsonify({
            'success': True,
            'message': 'MCU 数据库已刷新',
            'platforms': list(klipper_mcu_db.keys()),
            'total_mcus': sum(len(d['mcus']) for d in klipper_mcu_db.values())
        })
    except Exception as e:
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500


# ==================== 新增 API ====================

@app.route('/api/config/all', methods=['GET'])
def get_all_configs():
    """获取所有配置（不分厂家）"""
    all_configs = []
    
    try:
        for manufacturer in os.listdir(BOARD_CONFIGS_DIR):
            manufacturer_path = os.path.join(BOARD_CONFIGS_DIR, manufacturer)
            if not os.path.isdir(manufacturer_path):
                continue
                
            for board_type in ['mainboard', 'toolboard', 'expansion']:
                type_path = os.path.join(manufacturer_path, board_type)
                if not os.path.exists(type_path):
                    continue
                    
                for filename in os.listdir(type_path):
                    if not filename.endswith('.json'):
                        continue
                        
                    config_path = os.path.join(type_path, filename)
                    try:
                        with open(config_path, 'r', encoding='utf-8') as f:
                            config = json.load(f)
                            config['manufacturer'] = manufacturer
                            all_configs.append(config)
                    except Exception as e:
                        logger.error(f"读取配置失败 {config_path}: {e}")
        
        return jsonify({
            'success': True,
            'configs': all_configs,
            'count': len(all_configs)
        })
    except Exception as e:
        logger.error(f"获取所有配置失败: {e}")
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500


@app.route('/api/config/save', methods=['POST'])
def save_config():
    """保存配置（支持更新）"""
    try:
        config_data = request.json
        
        manufacturer = config_data.get('manufacturer', 'FLY')
        board_type = config_data.get('type', 'mainboard')
        config_id = config_data.get('id')
        
        if not config_id:
            return jsonify({
                'success': False,
                'error': '缺少配置 ID'
            }), 400
        
        # 确保目录存在
        config_dir = os.path.join(BOARD_CONFIGS_DIR, manufacturer, board_type)
        os.makedirs(config_dir, exist_ok=True)
        
        # 保存配置
        config_path = os.path.join(config_dir, f"{config_id}.json")
        with open(config_path, 'w', encoding='utf-8') as f:
            json.dump(config_data, f, ensure_ascii=False, indent=2)
        
        return jsonify({
            'success': True,
            'message': '配置已保存',
            'path': config_path
        })
        
    except Exception as e:
        logger.error(f"保存配置失败: {e}")
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500


# ==================== 固件更新配置 API ====================

@app.route('/api/firmware-update/configs', methods=['GET'])
def list_firmware_update_configs():
    """列出所有固件更新配置"""
    try:
        configs = []
        
        # 从 BOARD_CONFIGS_DIR 读取固件更新配置
        if os.path.exists(BOARD_CONFIGS_DIR):
            for manufacturer in os.listdir(BOARD_CONFIGS_DIR):
                mfr_dir = os.path.join(BOARD_CONFIGS_DIR, manufacturer)
                if not os.path.isdir(mfr_dir) or manufacturer.startswith('.'):
                    continue
                    
                update_dir = os.path.join(mfr_dir, 'firmware_update')
                if not os.path.exists(update_dir):
                    continue
                
                for filename in os.listdir(update_dir):
                    if filename.endswith('.json'):
                        filepath = os.path.join(update_dir, filename)
                        try:
                            with open(filepath, 'r', encoding='utf-8') as f:
                                config = json.load(f)
                                config['_filepath'] = filepath
                                config['_manufacturer'] = manufacturer
                                configs.append(config)
                        except Exception as e:
                            logger.warning(f"读取固件更新配置失败 {filepath}: {e}")
        
        return jsonify({
            'success': True,
            'configs': configs
        })
        
    except Exception as e:
        logger.error(f"列出固件更新配置失败: {e}")
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500


@app.route('/api/firmware-update/config/<manufacturer>/<config_id>', methods=['GET'])
def get_firmware_update_config(manufacturer, config_id):
    """获取固件更新配置"""
    try:
        filepath = os.path.join(BOARD_CONFIGS_DIR, manufacturer, 'firmware_update', f"{config_id}.json")
        
        if not os.path.exists(filepath):
            return jsonify({
                'success': False,
                'error': '配置不存在'
            }), 404
        
        with open(filepath, 'r', encoding='utf-8') as f:
            config = json.load(f)
        
        return jsonify({
            'success': True,
            'config': config
        })
        
    except Exception as e:
        logger.error(f"获取固件更新配置失败: {e}")
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500


@app.route('/api/firmware-update/config/<manufacturer>/<config_id>', methods=['POST', 'PUT'])
def save_firmware_update_config(manufacturer, config_id):
    """保存固件更新配置"""
    try:
        config_data = request.json
        
        # 确保目录存在
        update_dir = os.path.join(BOARD_CONFIGS_DIR, manufacturer, 'firmware_update')
        os.makedirs(update_dir, exist_ok=True)
        
        # 保存配置
        filepath = os.path.join(update_dir, f"{config_id}.json")
        with open(filepath, 'w', encoding='utf-8') as f:
            json.dump(config_data, f, ensure_ascii=False, indent=2)
        
        return jsonify({
            'success': True,
            'message': '固件更新配置已保存',
            'path': filepath
        })
        
    except Exception as e:
        logger.error(f"保存固件更新配置失败: {e}")
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500


@app.route('/api/firmware-update/config/<manufacturer>/<config_id>', methods=['DELETE'])
def delete_firmware_update_config(manufacturer, config_id):
    """删除固件更新配置"""
    try:
        filepath = os.path.join(BOARD_CONFIGS_DIR, manufacturer, 'firmware_update', f"{config_id}.json")
        
        if not os.path.exists(filepath):
            return jsonify({
                'success': False,
                'error': '配置不存在'
            }), 404
        
        os.remove(filepath)
        
        return jsonify({
            'success': True,
            'message': '固件更新配置已删除'
        })
        
    except Exception as e:
        logger.error(f"删除固件更新配置失败: {e}")
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500


# ==================== 系统设置 API ====================

@app.route('/api/system/versions', methods=['GET'])
def get_versions():
    """获取Klipper版本信息"""
    result = {
        'klipper_version': None
    }
    
    # 获取 Klipper 版本 - 使用绝对路径避免systemd的~扩展问题
    try:
        klipper_path = '/home/fenghua/klipper'
        if os.path.exists(os.path.join(klipper_path, '.git')):
            output = subprocess.run(
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

@app.route('/api/system/service', methods=['POST'])
def control_service():
    """控制服务（启动/停止/重启）"""
    data = request.json
    service_name = data.get('service')
    action = data.get('action')
    
    if not service_name or not action:
        return jsonify({'success': False, 'error': '缺少服务名或操作'}), 400
    
    if action not in ['start', 'stop', 'restart']:
        return jsonify({'success': False, 'error': '无效的操作'}), 400
    
    try:
        # 使用 sudo systemctl 控制服务
        cmd = ['sudo', 'systemctl', action, service_name]
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        
        if result.returncode == 0:
            return jsonify({'success': True, 'message': f'{service_name} {action} 成功'})
        else:
            return jsonify({'success': False, 'error': result.stderr or '命令执行失败'}), 500
    except subprocess.TimeoutExpired:
        return jsonify({'success': False, 'error': '服务操作超时'}), 500
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/system/check-update', methods=['GET'])
def check_update():
    """检查项目更新"""
    try:
        import pwd
        
        # 获取项目所有者的用户名
        stat_info = os.stat(BASE_DIR)
        uid = stat_info.st_uid
        user_info = pwd.getpwuid(uid)
        username = user_info.pw_name
        home_dir = user_info.pw_dir
        
        # 设置环境变量，使用项目所有者的home目录
        env = os.environ.copy()
        env['HOME'] = home_dir
        env['USER'] = username
        
        # 添加 safe.directory 配置
        subprocess.run(
            ['git', 'config', '--global', '--add', 'safe.directory', BASE_DIR],
            capture_output=True, env=env
        )
        
        # 获取当前版本（git commit hash）
        current_output = subprocess.run(
            ['git', '-C', BASE_DIR, 'rev-parse', '--short', 'HEAD'],
            capture_output=True, text=True, timeout=10, env=env
        )
        current_version = current_output.stdout.strip() if current_output.returncode == 0 else 'unknown'
        
        # 获取远程最新版本
        # 先获取远程信息
        subprocess.run(
            ['git', '-C', BASE_DIR, 'fetch', 'origin'],
            capture_output=True, timeout=30, env=env
        )
        
        # 获取远程最新commit
        remote_output = subprocess.run(
            ['git', '-C', BASE_DIR, 'rev-parse', '--short', 'origin/main'],
            capture_output=True, text=True, timeout=10, env=env
        )
        latest_version = remote_output.stdout.strip() if remote_output.returncode == 0 else current_version
        
        # 检查是否有更新
        has_update = current_version != latest_version
        
        # 获取最新提交时间
        update_time = None
        if has_update:
            time_output = subprocess.run(
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

@app.route('/api/system/update', methods=['POST'])
def update_project():
    """执行项目更新"""
    def generate():
        try:
            import pwd
            
            # 获取项目所有者的环境变量
            stat_info = os.stat(BASE_DIR)
            uid = stat_info.st_uid
            user_info = pwd.getpwuid(uid)
            home_dir = user_info.pw_dir
            
            env = os.environ.copy()
            env['HOME'] = home_dir
            env['USER'] = user_info.pw_name
            
            # 添加 safe.directory 配置
            subprocess.run(
                ['git', 'config', '--global', '--add', 'safe.directory', BASE_DIR],
                capture_output=True, env=env
            )
            
            yield "开始更新 Firmware-Tool...\n"
            
            # 1. 保存当前配置
            yield "保存当前配置...\n"
            config_backup = None
            if os.path.exists(CONFIG_PATH):
                with open(CONFIG_PATH, 'r') as f:
                    config_backup = f.read()
            
            # 2. 执行 git pull
            yield "拉取最新代码...\n"
            result = subprocess.run(
                ['git', '-C', BASE_DIR, 'pull', 'origin', 'main'],
                capture_output=True, text=True, timeout=60, env=env
            )
            yield result.stdout
            if result.stderr:
                yield f"警告: {result.stderr}\n"
            
            if result.returncode != 0:
                yield f"错误: git pull 失败\n"
                return
            
            # 3. 恢复配置
            if config_backup:
                yield "恢复配置...\n"
                with open(CONFIG_PATH, 'w') as f:
                    f.write(config_backup)
            
            # 4. 重启服务
            yield "重启服务...\n"
            restart_result = subprocess.run(
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

if __name__ == '__main__':
    import os
    os.chdir(BASE_DIR)
    app.run(host='0.0.0.0', port=PORT, debug=False, threaded=True)

