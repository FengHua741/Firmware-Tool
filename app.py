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
                shell=True, capture_output=True, text=True
            )
            seen_uuids = set()
            if output.stdout:
                for line in output.stdout.strip().split('\n'):
                    # 过滤错误信息和警告
                    if 'Error' in line or 'Traceback' in line or 'DeprecationWarning' in line:
                        continue
                    # 解析 UUID (8 位或更长的十六进制)
                    match = re.search(r'\b([a-f0-9]{8,})\b', line)
                    if match:
                        uuid = match.group(1)
                        # 去重
                        if uuid in seen_uuids:
                            continue
                        seen_uuids.add(uuid)
                        # 格式化为 canbus_uuid: <uuid>
                        formatted = f"canbus_uuid: {uuid}"
                        result['can'].append({'raw': uuid, 'formatted': formatted})
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
        rp2040_can_rx_gpio = data.get('rp2040_can_rx_gpio', '4')
        rp2040_can_tx_gpio = data.get('rp2040_can_tx_gpio', '5')
        
        if not os.path.exists(klipper_path):
            return jsonify({'error': f'Klipper目录不存在: {klipper_path}'}), 400
        
        # 清理之前的编译
        subprocess.run(f'cd {klipper_path} && rm -rf .config out', 
                      shell=True, capture_output=True)
        
        # 生成配置文件
        config_lines = ['CONFIG_LOW_LEVEL_OPTIONS=y']
        
        # MCU架构 (支持新的文档格式 "Raspberry Pi RP2040/RP235x")
        if 'STM32' in mcu_arch:
            config_lines.append('CONFIG_MACH_STM32=y')
        elif 'RP2040' in mcu_arch or 'RP235x' in mcu_arch:
            # RP2040/RP2350使用RPXXXX配置
            config_lines.append('CONFIG_MACH_RPXXXX=y')
        
        # 处理器
        processor_map = {
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
            'RP2040': 'CONFIG_MACH_RP2040=y',
            'RP2350': 'CONFIG_MACH_RP2350=y'
        }
        if processor in processor_map:
            config_lines.append(processor_map[processor])
        
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
        
        # 通信接口
        if 'RP2040' in processor or 'RP2350' in processor:
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
        else:
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
    """切换 Web界面（Fluidd ↔ Mainsail）"""
    try:
        data = request.get_json()
        target = data.get('target', '')
        
        if not target or target not in ['fluidd', 'mainsail']:
            return jsonify({'error': '无效的目标界面'}), 400
        
        # 目标端口
        target_port = 80 if target == 'fluidd' else 81
        other_port = 81 if target == 'fluidd' else 80
        
        messages = []
        
        # 1. 读取当前 nginx 配置
        nginx_configs = [
            '/etc/nginx/sites-enabled/fluidd',
            '/etc/nginx/sites-enabled/mainsail',
            '/etc/nginx/sites-available/fluidd',
            '/etc/nginx/sites-available/mainsail'
        ]
        
        # 2. 找到并修改配置文件（注释掉一个，启用另一个）
        for config_file in nginx_configs:
            if os.path.exists(config_file):
                try:
                    with open(config_file, 'r') as f:
                        lines = f.readlines()
                    
                    new_lines = []
                    for line in lines:
                        stripped = line.strip()
                        # 如果是目标服务，取消注释 listen 指令
                        if target in config_file:
                            if stripped.startswith('#') and f'listen {target_port}' in stripped:
                                # 取消注释（去掉开头的 # ）
                                line = stripped.lstrip('#').lstrip() + '\n'
                        else:
                            # 注释掉另一个服务的 listen
                            if not stripped.startswith('#') and f'listen {other_port}' in stripped:
                                line = '# ' + stripped + '\n'
                    
                    # 写回文件
                    with open(config_file, 'w') as f:
                        f.writelines(new_lines)
                    
                    messages.append(f'已处理配置文件：{config_file}')
                except Exception as e:
                    messages.append(f'配置文件处理失败：{str(e)}')
        
        # 3. 重新加载 nginx 配置
        try:
            result = subprocess.run('sudo nginx -t && sudo systemctl reload nginx', 
                                  shell=True, capture_output=True, text=True)
            if result.returncode == 0:
                messages.append('Nginx 配置已重载')
            else:
                messages.append(f'Nginx 重载失败：{result.stderr}')
        except Exception as e:
            messages.append(f'Nginx 重载失败：{str(e)}')
        
        return jsonify({
            'success': True,
            'message': f'已切换到 {target.capitalize()}（端口 {target_port}）',
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
RestartSec=100ms
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

if __name__ == '__main__':
    # 启动时自动更新JSON
    auto_update_json()
    
    logger.info(f'启动 Firmware-Tool 服务，端口: {PORT}')
    app.run(host='0.0.0.0', port=PORT, debug=False)
