#!/usr/bin/env python3
"""
Firmware-Tool
Port: 9999 (可配置)
"""

from flask import Flask, jsonify, request, send_from_directory, send_file
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
CORS(app)

# 配置路径
BASE_DIR = '/home/fenghua/Firmware-Tool'
CONFIG_PATH = os.path.join(BASE_DIR, 'config.json')
BOARD_CONFIGS_DIR = os.path.join(BASE_DIR, 'board_configs')

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

# ==================== ID搜索 API ====================
@app.route('/api/system/ids')
def get_all_ids():
    """获取所有ID信息"""
    try:
        result = {'usb': [], 'can': [], 'camera': []}
        
        # USB设备 - 格式: serial: <id>
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
        
        # CAN设备 - 格式: canbus_uuid: <uuid>
        try:
            output = subprocess.run(
                '~/klippy-env/bin/python ~/klipper/lib/canboot/flash_can.py -q 2>/dev/null || echo ""',
                shell=True, capture_output=True, text=True
            )
            if output.stdout:
                for line in output.stdout.strip().split('\n'):
                    # 解析UUID
                    match = re.search(r'([a-f0-9]{8,})', line)
                    if match:
                        uuid = match.group(1)
                        # 格式化为 canbus_uuid: <uuid>
                        formatted = f"canbus_uuid: {uuid}"
                        result['can'].append({'raw': uuid, 'formatted': formatted})
        except:
            pass
        
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
        
        return jsonify(result)
    except Exception as e:
        return jsonify({'error': str(e)}), 500

# ==================== 主板配置 API ====================
@app.route('/api/firmware/boards')
def get_boards():
    """获取所有主板配置"""
    try:
        boards = load_all_boards()
        return jsonify({'boards': boards})
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
def get_bl_firmwares_list(manufacturer):
    """获取指定厂家的BL固件列表"""
    try:
        firmwares = get_bl_firmwares(manufacturer)
        return jsonify({'firmwares': firmwares})
    except Exception as e:
        return jsonify({'error': str(e)}), 500

# ==================== 固件编译 API ====================
@app.route('/api/firmware/compile', methods=['POST'])
def compile_firmware():
    """编译Klipper固件"""
    try:
        data = request.json
        klipper_path = os.path.expanduser(data.get('klipper_path', config.get('klipper_path', '~/klipper')))
        mcu_arch = data.get('mcu_arch', 'STMicroelectronics STM32')
        processor = data.get('processor', 'STM32F072')
        bootloader_offset = data.get('bootloader_offset', 'No bootloader')
        communication = data.get('communication', 'USB (on PA11/PA12)')
        can_bus_interface = data.get('can_bus_interface', 'CAN bus (on PB8/PB9)')
        startup_pin = data.get('startup_pin', '')
        
        if not os.path.exists(klipper_path):
            return jsonify({'error': f'Klipper目录不存在: {klipper_path}'}), 400
        
        # 清理之前的编译
        subprocess.run(f'cd {klipper_path} && rm -rf .config out', 
                      shell=True, capture_output=True)
        
        # 生成配置文件
        config_lines = ['CONFIG_LOW_LEVEL_OPTIONS=y']
        
        # MCU架构
        if 'STM32' in mcu_arch:
            config_lines.append('CONFIG_MACH_STM32=y')
        elif 'RP2040' in mcu_arch:
            config_lines.append('CONFIG_MACH_RP2040=y')
        
        # 处理器
        processor_map = {
            'STM32F072': 'CONFIG_MACH_STM32F072=y',
            'STM32F103': 'CONFIG_MACH_STM32F103=y',
            'STM32F407': 'CONFIG_MACH_STM32F407=y',
            'STM32F405': 'CONFIG_MACH_STM32F405=y',
            'STM32H723': 'CONFIG_MACH_STM32H723=y',
            'RP2040': 'CONFIG_MACH_RP2040=y'
        }
        if processor in processor_map:
            config_lines.append(processor_map[processor])
        
        # Bootloader偏移
        offset_map = {
            'No bootloader': 'CONFIG_FLASH_START=0x8000000',
            '8KiB bootloader': 'CONFIG_FLASH_START=0x8002000',
            '16KiB bootloader': 'CONFIG_FLASH_START=0x8004000',
            '32KiB bootloader': 'CONFIG_FLASH_START=0x8008000',
            '128KiB bootloader': 'CONFIG_FLASH_START=0x8020000'
        }
        if bootloader_offset in offset_map:
            config_lines.append(offset_map[bootloader_offset])
        
        # 通信接口
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
        elif 'CAN' in communication:
            config_lines.append('CONFIG_CANBUS=y')
            config_lines.append('CONFIG_CANBUS_FREQUENCY=1000000')
            if 'PB8/PB9' in communication:
                config_lines.append('CONFIG_STM32_CANBUS_PB8_PB9=y')
        elif 'Serial' in communication:
            config_lines.append('CONFIG_SERIAL=y')
        
        # 启动引脚
        if startup_pin:
            config_lines.append(f'CONFIG_INITIAL_PINS="{startup_pin}"')
        
        # 写入配置
        config_content = '\n'.join(config_lines) + '\n'
        config_path = os.path.join(klipper_path, '.config')
        with open(config_path, 'w') as f:
            f.write(config_content)
        
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
        firmware_path = os.path.join(klipper_path, 'out', 'klipper.bin')
        
        if compile_result.returncode == 0 and os.path.exists(firmware_path):
            return jsonify({
                'success': True,
                'message': '编译成功',
                'output': output,
                'firmware_path': firmware_path
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
            os.path.join(BASE_DIR, 'board_configs')
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
    """扫描CAN设备"""
    try:
        result = subprocess.run(
            '~/klippy-env/bin/python ~/klipper/lib/canboot/flash_can.py -q 2>/dev/null || echo ""',
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
        
        # 确定固件路径
        if not firmware_path:
            firmware_path = os.path.join(klipper_path, 'out', 'klipper.bin')
        
        if not os.path.exists(firmware_path):
            return jsonify({'error': '固件文件不存在'}), 400
        
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
            # Katapult烧录
            if 'katapult' in device.lower():
                cmd = f'python3 ~/katapult/scripts/flashtool.py -d {device}'
            else:
                cmd = f'cd {klipper_path} && make flash FLASH_DEVICE={device}'
            
            result = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=60)
            output = result.stdout + result.stderr
            returncode = result.returncode
            
        elif flash_mode == 'CAN':
            # CAN烧录 (Katapult via CAN)
            can_uuid = device.replace('can0:', '') if 'can0:' in device else device
            cmd = f'~/klippy-env/bin/python ~/klipper/lib/canboot/flash_can.py -u {can_uuid} -f {firmware_path}'
            
            result = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=120)
            output = result.stdout + result.stderr
            returncode = result.returncode
            
        elif flash_mode == 'UF2':
            cmd = f'sudo ~/klipper/lib/rp2040_flash/rp2040_flash {firmware_path}'
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
            return jsonify({'error': 'BL固件文件不存在'}), 400
        
        # BL固件默认从0x08000000开始（无偏移）
        dfu_address = '0x08000000'
        
        if flash_mode == 'DFU':
            cmd = f'sudo dfu-util -a 0 -d 0483:df11 --dfuse-address {dfu_address} -D {bl_firmware_path}'
        elif flash_mode == 'KAT':
            cmd = f'python3 ~/katapult/scripts/flashtool.py -d {device}'
        else:
            return jsonify({'error': f'不支持的BL烧录方式: {flash_mode}'}), 400
        
        result = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=60)
        
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

# ==================== CAN配置 API ====================
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
            # 解析 BitRate=1000000
            import re
            bitrate_match = re.search(r'BitRate\s*=\s*(\d+)', content)
            if bitrate_match:
                config['bitrate'] = int(bitrate_match.group(1))
            
            # 解析 TxQueueLength
            txqueue_match = re.search(r'TxQueueLength\s*=\s*(\d+)', content)
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
RestartSec=100ms
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
            'message': f'CAN配置已更新，速率: {bitrate}，重启后生效'
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

if __name__ == '__main__':
    # 启动时自动更新JSON
    auto_update_json()
    
    logger.info(f'启动 Firmware-Tool 服务，端口: {PORT}')
    app.run(host='0.0.0.0', port=PORT, debug=False)
