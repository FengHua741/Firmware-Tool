"""
固件编译与烧录蓝图 - 固件编译、下载、检测、烧录等
"""

from flask import Blueprint, jsonify, request, send_file, Response
import subprocess
import os
import re
import json
import time
import shlex

from shared import (
    app, config, logger, BASE_DIR, BOARD_CONFIGS_DIR,
    DFU_KNOWN_DEVICES,
    run_cmd, run_cmd_stream, path_exists, get_file_size,
    is_ssh_mode, is_fast_ssh_mode,
    expand_klipper_path, get_klipper_owner, get_klipper_python_bin,
    download_firmware_from_remote, upload_bl_firmware_for_remote,
    sudo_write_file,
    load_all_boards, get_manufacturers, get_bl_firmwares,
    SSHManager,
)
from routes_system import _scan_can_uuids

firmware_bp = Blueprint('firmware', __name__)


def load_klipper_rules():
    """加载Klipper固件编译规则"""
    rules_path = os.path.join(BASE_DIR, 'data', 'klipper_rules.json')
    if os.path.exists(rules_path):
        with open(rules_path, 'r', encoding='utf-8') as f:
            return json.load(f)
    return {}


def _umount_rp2040_boot():
    """动态查找并卸载RP2040 BOOT设备"""
    try:
        result = run_cmd(
            'lsblk -o NAME,MOUNTPOINT,MODEL 2>/dev/null | grep -i "rp2"',
            shell=True, capture_output=True, text=True, timeout=10
        )
        if result.stdout:
            for line in result.stdout.strip().split('\n'):
                parts = line.split()
                if len(parts) >= 2:
                    mount_point = parts[1]
                    if mount_point and mount_point != '':
                        run_cmd(
                            f'sudo umount {mount_point} 2>/dev/null || true',
                            shell=True, capture_output=True, timeout=10
                        )
    except:
        pass
    time.sleep(0.5)


# ==================== 主板配置 API ====================
@firmware_bp.route('/api/firmware/boards')
def get_boards():
    """获取所有主板配置"""
    try:
        boards = load_all_boards()
        manufacturers = get_manufacturers()
        return jsonify({'boards': boards, 'manufacturers': manufacturers})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@firmware_bp.route('/api/firmware/manufacturers')
def get_manufacturers_list():
    """获取厂家列表"""
    try:
        manufacturers = get_manufacturers()
        return jsonify({'manufacturers': manufacturers})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@firmware_bp.route('/api/firmware/bl-firmwares')
def get_all_bl_firmwares():
    """获取所有厂家的BL固件列表"""
    try:
        all_firmwares = []
        if os.path.exists(BOARD_CONFIGS_DIR):
            for manufacturer in os.listdir(BOARD_CONFIGS_DIR):
                mfr_dir = os.path.join(BOARD_CONFIGS_DIR, manufacturer)
                if os.path.isdir(mfr_dir):
                    try:
                        firmwares = get_bl_firmwares(manufacturer)
                        for fw in firmwares:
                            fw['manufacturer'] = manufacturer
                        all_firmwares.extend(firmwares)
                    except Exception:
                        pass
        return jsonify({'files': all_firmwares})
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@firmware_bp.route('/api/firmware/bl-firmwares/<manufacturer>')
@firmware_bp.route('/api/firmware/bl-firmwares/<manufacturer>/<board_type>')
def get_bl_firmwares_list(manufacturer, board_type=None):
    """获取指定厂家的BL固件列表，可按主板类型过滤"""
    try:
        firmwares = get_bl_firmwares(manufacturer, board_type)
        return jsonify({'firmwares': firmwares})
    except Exception as e:
        return jsonify({'error': str(e)}), 500

# ==================== 固件编译规则 API ====================
@firmware_bp.route('/api/firmware/rules/<processor>')
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

@firmware_bp.route('/api/firmware/rules')
def get_all_rules():
    """获取所有处理器的固件编译规则"""
    try:
        rules = load_klipper_rules()
        return jsonify(rules)
    except Exception as e:
        return jsonify({'error': str(e)}), 500

# ==================== 编译依赖检测 API ====================
@firmware_bp.route('/api/firmware/dependencies')
def check_compile_dependencies():
    """检测固件编译所需依赖工具是否已安装"""
    try:
        deps = [
            {'name': 'make',           'cmd': 'make --version',            'pkg': 'build-essential'},
            {'name': 'arm-none-eabi-gcc', 'cmd': 'arm-none-eabi-gcc --version', 'pkg': 'gcc-arm-none-eabi'},
            {'name': 'dfu-util',       'cmd': 'dfu-util --version',         'pkg': 'dfu-util'},
            {'name': 'avrdude',        'cmd': 'avrdude -v',                 'pkg': 'avrdude'},
            {'name': 'python3',        'cmd': 'python3 --version',          'pkg': 'python3'},
        ]
        results = []
        all_ok = True
        for dep in deps:
            try:
                r = run_cmd(dep['cmd'], shell=True, capture_output=True, text=True, timeout=5)
                installed = (r.returncode == 0)
                version = ''
                if installed:
                    out = (r.stdout or r.stderr or '').strip().split('\n')[0]
                    version = out[:80]
            except Exception:
                installed = False
                version = ''
            if not installed:
                all_ok = False
            results.append({
                'name': dep['name'],
                'installed': installed,
                'version': version,
                'pkg': dep['pkg'],
            })
        return jsonify({'dependencies': results, 'all_ok': all_ok})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@firmware_bp.route('/api/firmware/dependencies/install', methods=['POST'])
def install_compile_dependencies():
    """安装缺失的编译依赖（仅本地模式）"""
    def _stream():
        pkgs = ['build-essential', 'gcc-arm-none-eabi', 'dfu-util', 'avrdude', 'python3']
        cmd = f'sudo apt-get install -y {" ".join(pkgs)} 2>&1'
        try:
            proc = subprocess.Popen(cmd, shell=True, stdout=subprocess.PIPE,
                                    stderr=subprocess.STDOUT, text=True)
            for line in iter(proc.stdout.readline, ''):
                yield f'data: {line.rstrip()}\n\n'
            proc.wait()
            if proc.returncode == 0:
                yield 'data: [DONE] 依赖安装完成\n\n'
            else:
                yield f'data: [ERROR] 安装失败，退出码 {proc.returncode}\n\n'
        except Exception as e:
            yield f'data: [ERROR] {e}\n\n'
    return Response(_stream(), mimetype='text/event-stream',
                    headers={'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no'})


# ==================== 固件编译 API ====================
@firmware_bp.route('/api/firmware/compile', methods=['POST'])
def compile_firmware():
    """编译Klipper固件 - 支持预设配置和自定义MCU（SSE 流式输出）"""
    req_data = request.json  # 在请求上下文中提前捕获
    def _compile_stream():
     try:
        data = req_data
        
        klipper_path = data.get('klipper_path', config.get('klipper_path', '~/klipper'))
        klipper_path = expand_klipper_path(klipper_path)
        
        config_data = data.get('config')
        if config_data:
            mcu_arch = config_data.get('platform', config_data.get('平台', 'STM32'))
            processor = config_data.get('mcu', config_data.get('处理器', 'STM32F072')).upper()
            bootloader_offset = config_data.get('bl_offset', config_data.get('BL 偏移', '0'))
            communication = config_data.get('default_connection', config_data.get('默认连接', 'USB'))
            can_bus_interface = 'CAN bus (on PB8/PB9)'
            startup_pin = config_data.get('boot_pins', config_data.get('启动引脚', ''))
            crystal = config_data.get('crystal', config_data.get('晶振', '8000000'))
            rp2040_can_rx_gpio = str(config_data.get('can_gpio', {}).get('rx', '4'))
            rp2040_can_tx_gpio = str(config_data.get('can_gpio', {}).get('tx', '5'))
            comm_type = ''
            comm_config_symbol = ''
            bridge_can_config = ''
        else:
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
        
        bl_offset_map = {
            '0': 'No bootloader', '256': 'No bootloader',
            '2048': '2KiB bootloader', '4096': '4KiB bootloader',
            '8192': '8KiB bootloader', '16384': '16KiB bootloader',
            '32768': '32KiB bootloader', '49152': '48KiB bootloader',
            '65536': '64KiB bootloader', '131072': '128KiB bootloader',
            '20480': '20KiB bootloader', '28672': '28KiB bootloader',
            '34816': '34KiB bootloader', '36864': '36KiB bootloader',
            '0x8000': '32KiB bootloader', '0xC000': '48KiB bootloader',
            '0x10000': '64KiB bootloader'
        }
        if bootloader_offset in bl_offset_map:
            bootloader_offset = bl_offset_map[bootloader_offset]
        
        mcu_arch_upper = mcu_arch.upper()
        processor_upper = processor.upper()
        
        if not path_exists(klipper_path):
            yield f'data: {json.dumps({"error": f"Klipper目录不存在: {klipper_path}"})}\n\n'
            return
        
        run_cmd(f'cd {klipper_path} && rm -rf .config out', shell=True, capture_output=True)
        
        config_lines = ['CONFIG_LOW_LEVEL_OPTIONS=y']
        
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
        
        processor_map = {
            'STM32F031': 'CONFIG_MACH_STM32F031=y', 'STM32F042': 'CONFIG_MACH_STM32F042=y',
            'STM32F070': 'CONFIG_MACH_STM32F070=y', 'STM32F072': 'CONFIG_MACH_STM32F072=y',
            'STM32F103': 'CONFIG_MACH_STM32F103=y', 'STM32F207': 'CONFIG_MACH_STM32F207=y',
            'STM32F401': 'CONFIG_MACH_STM32F401=y', 'STM32F405': 'CONFIG_MACH_STM32F405=y',
            'STM32F407': 'CONFIG_MACH_STM32F407=y', 'STM32F429': 'CONFIG_MACH_STM32F429=y',
            'STM32F446': 'CONFIG_MACH_STM32F446=y', 'STM32F765': 'CONFIG_MACH_STM32F765=y',
            'STM32G070': 'CONFIG_MACH_STM32G070=y', 'STM32G071': 'CONFIG_MACH_STM32G071=y',
            'STM32G0B0': 'CONFIG_MACH_STM32G0B0=y', 'STM32G0B1': 'CONFIG_MACH_STM32G0B1=y',
            'STM32G431': 'CONFIG_MACH_STM32G431=y', 'STM32G474': 'CONFIG_MACH_STM32G474=y',
            'STM32H723': 'CONFIG_MACH_STM32H723=y', 'STM32H743': 'CONFIG_MACH_STM32H743=y',
            'STM32H750': 'CONFIG_MACH_STM32H750=y', 'STM32L412': 'CONFIG_MACH_STM32L412=y',
            'RP2040': 'CONFIG_MACH_RP2040=y', 'RP2350': 'CONFIG_MACH_RP2350=y',
            'SAMC21G18': 'CONFIG_MACH_SAMC21G18=y', 'SAMD21E15': 'CONFIG_MACH_SAMD21E15=y',
            'SAMD21E18': 'CONFIG_MACH_SAMD21E18=y', 'SAMD21G18': 'CONFIG_MACH_SAMD21G18=y',
            'SAMD21J18': 'CONFIG_MACH_SAMD21J18=y', 'SAMD51G19': 'CONFIG_MACH_SAMD51G19=y',
            'SAMD51J19': 'CONFIG_MACH_SAMD51J19=y', 'SAMD51N19': 'CONFIG_MACH_SAMD51N19=y',
            'SAMD51N20': 'CONFIG_MACH_SAMD51N20=y', 'SAMD51P20': 'CONFIG_MACH_SAMD51P20=y',
            'SAME51J19': 'CONFIG_MACH_SAME51J19=y', 'SAME51N19': 'CONFIG_MACH_SAME51N19=y',
            'SAME51N20': 'CONFIG_MACH_SAME51N20=y', 'SAME54P20': 'CONFIG_MACH_SAME54P20=y',
            'SAM3X8C': 'CONFIG_MACH_SAM3X8C=y', 'SAM3X8E': 'CONFIG_MACH_SAM3X8E=y',
            'SAM4E8E': 'CONFIG_MACH_SAM4E8E=y', 'SAM4E16E': 'CONFIG_MACH_SAM4E16E=y',
            'SAM4S8C': 'CONFIG_MACH_SAM4S8C=y', 'SAM4S8B': 'CONFIG_MACH_SAM4S8B=y',
            'SAME70N20': 'CONFIG_MACH_SAME70N20=y', 'SAME70J19': 'CONFIG_MACH_SAME70J19=y',
            'SAME70J20': 'CONFIG_MACH_SAME70J20=y', 'SAME70Q20': 'CONFIG_MACH_SAME70Q20=y',
            'LPC1768': 'CONFIG_MACH_LPC1768=y', 'LPC1769': 'CONFIG_MACH_LPC1769=y',
            'HC32F460': 'CONFIG_MACH_HC32F460=y',
            'AT90USB1286': 'CONFIG_MACH_at90usb1286=y', 'AT90USB646': 'CONFIG_MACH_at90usb646=y',
            'ATMEGA1280': 'CONFIG_MACH_atmega1280=y', 'ATMEGA2560': 'CONFIG_MACH_atmega2560=y',
            'ATMEGA328P': 'CONFIG_MACH_atmega328p=y', 'ATMEGA328': 'CONFIG_MACH_atmega328=y',
            'ATMEGA32U4': 'CONFIG_MACH_atmega32u4=y', 'ATMEGA168': 'CONFIG_MACH_atmega168=y',
            'ATMEGA328PB': 'CONFIG_MACH_atmega328pb=y', 'LGT8F328P': 'CONFIG_MACH_lgt8f328p=y',
            'at90usb1286': 'CONFIG_MACH_at90usb1286=y', 'at90usb646': 'CONFIG_MACH_at90usb646=y',
            'atmega1280': 'CONFIG_MACH_atmega1280=y', 'atmega2560': 'CONFIG_MACH_atmega2560=y',
            'atmega328p': 'CONFIG_MACH_atmega328p=y', 'atmega328': 'CONFIG_MACH_atmega328=y',
            'atmega32u4': 'CONFIG_MACH_atmega32u4=y', 'atmega168': 'CONFIG_MACH_atmega168=y',
            'atmega328pb': 'CONFIG_MACH_atmega328pb=y', 'lgt8f328p': 'CONFIG_MACH_lgt8f328p=y'
        }
        
        if processor_upper in processor_map:
            config_lines.append(processor_map[processor_upper])
        elif processor_upper.startswith('STM32'):
            match = re.match(r'(STM32\w+)', processor_upper)
            if match and match.group(1) in processor_map:
                config_lines.append(processor_map[match.group(1)])
            else:
                config_lines.append('CONFIG_MACH_STM32F072=y')
        elif 'RP2040' in processor_upper:
            config_lines.append('CONFIG_MACH_RP2040=y')
        else:
            config_lines.append('CONFIG_MACH_STM32F072=y')
        
        crystal_str = str(crystal) if crystal else ''
        if 'STM32' in mcu_arch_upper:
            crystal_map = {'8000000': 'CONFIG_STM32_CLOCK_REF_8M=y', '12000000': 'CONFIG_STM32_CLOCK_REF_12M=y', '16000000': 'CONFIG_STM32_CLOCK_REF_16M=y', '20000000': 'CONFIG_STM32_CLOCK_REF_20M=y', '24000000': 'CONFIG_STM32_CLOCK_REF_24M=y', '25000000': 'CONFIG_STM32_CLOCK_REF_25M=y'}
        elif 'ATSAMD' in mcu_arch_upper:
            crystal_map = {'32768': 'CONFIG_CLOCK_REF_X32K=y', '12000000': 'CONFIG_CLOCK_REF_X12M=y', '25000000': 'CONFIG_CLOCK_REF_X25M=y'}
        elif 'ATSAM' in mcu_arch_upper:
            crystal_map = {'8000000': 'CONFIG_CLOCK_REF_8M=y', '12000000': 'CONFIG_CLOCK_REF_12M=y', '16000000': 'CONFIG_CLOCK_REF_16M=y', '20000000': 'CONFIG_CLOCK_REF_20M=y', '24000000': 'CONFIG_CLOCK_REF_24M=y', '25000000': 'CONFIG_CLOCK_REF_25M=y'}
        else:
            crystal_map = {'8000000': 'CONFIG_CLOCK_REF_8M=y', '12000000': 'CONFIG_CLOCK_REF_12M=y', '16000000': 'CONFIG_CLOCK_REF_16M=y', '20000000': 'CONFIG_CLOCK_REF_20M=y', '24000000': 'CONFIG_CLOCK_REF_24M=y', '25000000': 'CONFIG_CLOCK_REF_25M=y'}
        if crystal_str in crystal_map:
            config_lines.append(crystal_map[crystal_str])
        
        if 'RP2040' in processor:
            offset_map = {'No bootloader': 'CONFIG_RPXXXX_FLASH_START_0100=y', '16KiB bootloader': 'CONFIG_RPXXXX_FLASH_START_4000=y'}
        elif 'RP2350' in processor:
            offset_map = {'No bootloader': 'CONFIG_RPXXXX_FLASH_START_0000=y', '16KiB bootloader': 'CONFIG_RPXXXX_FLASH_START_4000=y'}
        else:
            offset_map = {'No bootloader': 'CONFIG_STM32_FLASH_START_0000=y', '2KiB bootloader': 'CONFIG_STM32_FLASH_START_800=y', '4KiB bootloader': 'CONFIG_STM32_FLASH_START_1000=y', '8KiB bootloader': 'CONFIG_STM32_FLASH_START_2000=y', '16KiB bootloader': 'CONFIG_STM32_FLASH_START_4000=y', '20KiB bootloader': 'CONFIG_STM32_FLASH_START_5000=y', '28KiB bootloader': 'CONFIG_STM32_FLASH_START_7000=y', '32KiB bootloader': 'CONFIG_STM32_FLASH_START_8000=y', '34KiB bootloader': 'CONFIG_STM32_FLASH_START_8800=y', '36KiB bootloader': 'CONFIG_STM32_FLASH_START_9000=y', '48KiB bootloader': 'CONFIG_STM32_FLASH_START_C000=y', '64KiB bootloader': 'CONFIG_STM32_FLASH_START_10000=y', '128KiB bootloader': 'CONFIG_STM32_FLASH_START_20000=y'}
        if bootloader_offset in offset_map:
            config_lines.append(offset_map[bootloader_offset])
        
        _is_dynamic = comm_config_symbol and ' ' not in comm_config_symbol and comm_config_symbol.replace('_', '').isalnum()
        
        if _is_dynamic:
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
            if ('RP2040' in processor or 'RP2350' in processor) and comm_type in ('can', 'usbcanbridge'):
                config_lines.append(f'CONFIG_RPXXXX_CANBUS_GPIO_RX={rp2040_can_rx_gpio}')
                config_lines.append(f'CONFIG_RPXXXX_CANBUS_GPIO_TX={rp2040_can_tx_gpio}')
        elif 'RP2040' in processor or 'RP2350' in processor:
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
            if 'USB' in communication:
                config_lines.append('CONFIG_USB=y')
            elif 'CAN' in communication:
                config_lines.append('CONFIG_SAMD_CANBUS=y')
                config_lines.append('CONFIG_CANBUS_FREQUENCY=1000000')
            elif 'Serial' in communication or 'UART' in communication:
                config_lines.append('CONFIG_SERIAL=y')
        elif processor_upper.startswith('LPC176'):
            if 'USB' in communication:
                config_lines.append('CONFIG_USB=y')
            elif 'Serial' in communication or 'UART' in communication:
                config_lines.append('CONFIG_SERIAL=y')
        elif 'HC32F460' in processor_upper:
            if 'Serial' in communication or 'UART' in communication:
                config_lines.append('CONFIG_HC32F460_SERIAL_PA7_PA8=y')
        elif processor_upper.startswith('ATMEGA') or processor_upper.startswith('AT90USB') or processor_upper.startswith('ATMega'):
            if 'USB' in communication:
                config_lines.append('CONFIG_USB=y')
            elif 'Serial' in communication or 'UART' in communication:
                config_lines.append('CONFIG_SERIAL=y')
        
        if startup_pin:
            is_rp2040 = 'RP2040' in processor or 'RP2350' in processor
            has_stm32_pin = bool(re.search(r'P[A-K]\d+', startup_pin, re.IGNORECASE))
            has_rp2040_pin = bool(re.search(r'gpio\d+', startup_pin, re.IGNORECASE))
            if is_rp2040 and has_stm32_pin and not has_rp2040_pin:
                yield f'data: {json.dumps({"error": "RP2040/RP2350启动引脚格式错误，应使用gpio格式（如gpio5）"})}\n\n'
                return
            if not is_rp2040 and has_rp2040_pin and not has_stm32_pin:
                yield f'data: {json.dumps({"error": "STM32启动引脚格式错误，应使用大写格式（如PA2, PB9）"})}\n\n'
                return
            config_lines.append(f'CONFIG_INITIAL_PINS="{startup_pin}"')
            yield f'data: [LOG] 启动引脚已配置: {startup_pin}\n\n'
        else:
            yield f'data: [LOG] 未设置启动引脚\n\n'
        
        config_content = '\n'.join(config_lines) + '\n'
        config_path = os.path.join(klipper_path, '.config')
        if is_ssh_mode():
            sudo_write_file(config_path, config_content)
        else:
            with open(config_path, 'w') as f:
                f.write(config_content)
        
        for line in config_lines:
            if 'INITIAL_PINS' in line or 'CONFIG_USB' in line or 'CONFIG_SERIAL' in line or 'CONFIG_CAN' in line:
                yield f'data: [LOG] .config: {line}\n\n'
        
        out_dir = os.path.join(klipper_path, 'out')
        if is_ssh_mode():
            run_cmd(f'mkdir -p {shlex.quote(out_dir)}', shell=True, capture_output=True)
        else:
            os.makedirs(out_dir, exist_ok=True)
            try:
                os.chmod(out_dir, 0o755)
            except:
                pass
        
        yield 'data: [LOG] 生成配置中...\n\n'
        olddefconfig_failed = False
        for line in run_cmd_stream(f'cd {klipper_path} && make olddefconfig', shell=True, timeout=60):
            if line.startswith('[DONE]'):
                pass
            elif line.startswith('[ERROR]'):
                olddefconfig_failed = True
                yield f'data: {json.dumps({"error": "配置生成失败", "detail": line})}\n\n'
                return
            else:
                yield f'data: [LOG] {line}\n\n'
        
        yield 'data: [LOG] 开始编译...\n\n'
        compile_ok = False
        for line in run_cmd_stream(f'cd {klipper_path} && make -j4', shell=True, timeout=300):
            if line.startswith('[DONE]'):
                compile_ok = True
            elif line.startswith('[ERROR]'):
                yield f'data: {json.dumps({"error": "编译失败", "detail": line})}\n\n'
                return
            else:
                yield f'data: [LOG] {line}\n\n'
        
        if not compile_ok:
            yield f'data: {json.dumps({"error": "编译失败"})}\n\n'
            return
        
        out_dir = os.path.join(klipper_path, 'out')
        firmware_files = ['klipper.bin', 'klipper.uf2']
        firmware_path = None
        
        for fw_file in firmware_files:
            fw_path = os.path.join(out_dir, fw_file)
            if path_exists(fw_path):
                firmware_path = fw_path
                break
        
        if firmware_path:
            try:
                if is_ssh_mode():
                    owner_name, _ = get_klipper_owner(klipper_path)
                    run_cmd(f'chmod 666 {shlex.quote(firmware_path)}', shell=True, capture_output=True, timeout=5)
                    run_cmd(f'chmod 755 {shlex.quote(out_dir)}', shell=True, capture_output=True, timeout=5)
                    if owner_name:
                        run_cmd(f'chown {shlex.quote(owner_name)} {shlex.quote(firmware_path)} {shlex.quote(out_dir)}', shell=True, capture_output=True, timeout=5)
                        run_cmd(f'chown -R {shlex.quote(owner_name)} {shlex.quote(out_dir)}', shell=True, capture_output=True, timeout=5)
                        config_file = os.path.join(klipper_path, '.config')
                        run_cmd(f'chown {shlex.quote(owner_name)} {shlex.quote(config_file)}', shell=True, capture_output=True, timeout=5)
                else:
                    import shutil as _shutil, pwd as _pwd, grp as _grp
                    os.chmod(firmware_path, 0o666)
                    os.chmod(out_dir, 0o755)
                    try:
                        klipper_stat = os.stat(klipper_path)
                        owner_name = _pwd.getpwuid(klipper_stat.st_uid).pw_name
                        group_name = _grp.getgrgid(klipper_stat.st_gid).gr_name
                    except (KeyError, OSError):
                        owner_name = None
                        group_name = None
                    if owner_name and group_name:
                        _shutil.chown(firmware_path, user=owner_name, group=group_name)
                        _shutil.chown(out_dir, user=owner_name, group=group_name)
                        for root_dir, dirs, files in os.walk(out_dir):
                            for d in dirs:
                                _shutil.chown(os.path.join(root_dir, d), user=owner_name, group=group_name)
                            for f in files:
                                _shutil.chown(os.path.join(root_dir, f), user=owner_name, group=group_name)
                        config_file = os.path.join(klipper_path, '.config')
                        if os.path.exists(config_file):
                            _shutil.chown(config_file, user=owner_name, group=group_name)
            except Exception as e:
                logger.warning(f"修改文件权限失败: {e}")
            
            firmware_size = get_file_size(firmware_path)
            if firmware_size < 1024:
                size_str = f'{firmware_size} bytes'
            elif firmware_size < 1024 * 1024:
                size_str = f'{firmware_size / 1024:.1f} KB'
            else:
                size_str = f'{firmware_size / (1024 * 1024):.2f} MB'
            
            yield f'data: {json.dumps({"success": True, "message": "编译成功", "firmware_path": firmware_path, "firmware_size": size_str, "firmware_size_bytes": firmware_size})}\n\n'
            return
        else:
            yield f'data: {json.dumps({"success": False, "error": "编译失败：未找到固件文件"})}\n\n'
            return
            
     except subprocess.TimeoutExpired:
            yield f'data: {json.dumps({"error": "编译超时"})}\n\n'
     except Exception as e:
            yield f'data: {json.dumps({"error": str(e)})}\n\n'
    return Response(_compile_stream(), mimetype='text/event-stream',
                    headers={'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no'})

# ==================== 固件下载 API ====================
@firmware_bp.route('/api/firmware/download')
def download_firmware():
    """下载固件文件"""
    try:
        firmware_path = request.args.get('path', '')
        klipper_path = expand_klipper_path(config.get('klipper_path', '~/klipper'))
        
        if not firmware_path:
            firmware_path = os.path.join(klipper_path, 'out', 'klipper.bin')
        
        firmware_path = expand_klipper_path(firmware_path)
        
        klipper_out = os.path.join(expand_klipper_path(config.get('klipper_path', '~/klipper')), 'out')
        allowed_paths = [
            klipper_out,
            '/data/klipper/out',
            os.path.join(BASE_DIR, 'board_configs'),
            os.path.join(BASE_DIR, 'out')
        ]
        
        is_allowed = any(firmware_path.startswith(p) for p in allowed_paths)
        if not is_allowed:
            return jsonify({'error': '非法路径'}), 403
        
        if not path_exists(firmware_path):
            return jsonify({'error': '固件文件不存在'}), 404
        
        local_firmware_path = download_firmware_from_remote(firmware_path)
        return send_file(local_firmware_path, as_attachment=True, download_name='firmware.bin')
    except Exception as e:
        return jsonify({'error': str(e)}), 500

# ==================== 设备检测 API ====================
@firmware_bp.route('/api/firmware/detect')
def detect_devices():
    """检测设备"""
    try:
        devices = []
        
        if is_ssh_mode():
            cmd = (
                "echo '===BY_ID==='; ls /dev/serial/by-id/* 2>/dev/null; "
                "echo '===ACM==='; ls /dev/ttyACM* 2>/dev/null; "
                "echo '===USB==='; ls /dev/ttyUSB* 2>/dev/null; "
                "echo '===DFU==='; sudo dfu-util -l 2>/dev/null; "
                "echo '===LSBLK==='; lsblk -o NAME,MODEL 2>/dev/null | grep -i 'RP2'; "
                "echo '===LSUSB_RP==='; lsusb 2>/dev/null | grep -i '2e8a:'; "
                "echo '===LSUSB_DFU==='; lsusb 2>/dev/null | grep -iE '0483:df11|314b:0106'; "
                "echo '===END==='"
            )
            result = run_cmd(cmd, shell=True, capture_output=True, text=True, timeout=15)
            output = result.stdout or ''
            
            sections = {}
            current_key = None
            current_lines = []
            for line in output.split('\n'):
                line_s = line.strip()
                if line_s.startswith('===') and line_s.endswith('==='):
                    if current_key:
                        sections[current_key] = current_lines
                    current_key = line_s.strip('=')
                    current_lines = []
                elif current_key:
                    current_lines.append(line_s)
            if current_key:
                sections[current_key] = current_lines
            
            for line in sections.get('BY_ID', []):
                if '/dev/serial/by-id/' in line:
                    device_id = line.strip()
                    short_name = os.path.basename(device_id)
                    devices.append({'id': device_id, 'name': short_name, 'type': 'usb_serial'})
            
            for line in sections.get('ACM', []):
                if line.strip():
                    device_id = line.strip()
                    short_name = os.path.basename(device_id)
                    if not any(d['id'] == device_id for d in devices):
                        devices.append({'id': device_id, 'name': f'{short_name} (ACM)', 'type': 'usb_acm'})
            
            for line in sections.get('USB', []):
                if line.strip():
                    device_id = line.strip()
                    short_name = os.path.basename(device_id)
                    if not any(d['id'] == device_id for d in devices):
                        devices.append({'id': device_id, 'name': f'{short_name} (USB)', 'type': 'usb_ftdi'})
            
            dfu_lines = sections.get('DFU', [])
            seen_dfu = set()
            found_dfu = False
            for line in dfu_lines:
                if 'Found DFU' not in line:
                    continue
                vid_pid_match = re.search(r'\[([0-9a-f]{4}:[0-9a-f]{4})\]', line, re.IGNORECASE)
                if not vid_pid_match:
                    continue
                vid_pid = vid_pid_match.group(1).lower()
                devnum_match = re.search(r'devnum=(\d+)', line)
                devnum = devnum_match.group(1) if devnum_match else ''
                serial_match = re.search(r'serial="([^"]+)"', line)
                serial = serial_match.group(1) if serial_match else ''
                dedup_key = f'{vid_pid}:{devnum}'
                if dedup_key in seen_dfu:
                    continue
                seen_dfu.add(dedup_key)
                chip_name = DFU_KNOWN_DEVICES.get(vid_pid, '')
                display_parts = [f'{chip_name} DFU' if chip_name else f'DFU ({vid_pid})']
                if serial:
                    display_parts.append(f'SN:{serial}')
                devices.append({'id': f'dfu:{vid_pid}', 'name': ' '.join(display_parts), 'type': 'dfu', 'vid_pid': vid_pid, 'serial': serial, 'devnum': devnum})
                found_dfu = True
            
            if not found_dfu:
                for line in sections.get('LSUSB_DFU', []):
                    for vidpid, chip_name in DFU_KNOWN_DEVICES.items():
                        if vidpid in line.lower():
                            devices.append({'id': f'dfu:{vidpid}', 'name': f'DFU Device ({chip_name} {vidpid})', 'type': 'dfu', 'vid_pid': vidpid, 'serial': '', 'devnum': ''})
            
            lsblk_lines = sections.get('LSBLK', [])
            if lsblk_lines:
                for line in lsblk_lines:
                    if line.strip():
                        devices.append({'id': 'rp2040_boot', 'name': f'RP2040 UF2 ({line.strip()})'})
            if not any(d['id'] == 'rp2040_boot' for d in devices):
                rp_lines = sections.get('LSUSB_RP', [])
                for line in rp_lines:
                    if '2e8a:' in line.lower():
                        devices.append({'id': 'rp2040_boot', 'name': 'RP2040 UF2 (USB 2e8a)'})
                        break
        else:
            try:
                result = run_cmd('ls /dev/serial/by-id/* 2>/dev/null || echo ""', shell=True, capture_output=True, text=True)
                if result.stdout:
                    for line in result.stdout.strip().split('\n'):
                        if '/dev/serial/by-id/' in line:
                            device_id = line.strip()
                            short_name = os.path.basename(device_id)
                            devices.append({'id': device_id, 'name': short_name, 'type': 'usb_serial'})
                
                acm_result = run_cmd('ls /dev/ttyACM* 2>/dev/null || echo ""', shell=True, capture_output=True, text=True)
                if acm_result.stdout:
                    for line in acm_result.stdout.strip().split('\n'):
                        if line.strip():
                            device_id = line.strip()
                            short_name = os.path.basename(device_id)
                            if not any(d['id'] == device_id for d in devices):
                                devices.append({'id': device_id, 'name': f'{short_name} (ACM)', 'type': 'usb_acm'})
                
                usb_result = run_cmd('ls /dev/ttyUSB* 2>/dev/null || echo ""', shell=True, capture_output=True, text=True)
                if usb_result.stdout:
                    for line in usb_result.stdout.strip().split('\n'):
                        if line.strip():
                            device_id = line.strip()
                            short_name = os.path.basename(device_id)
                            if not any(d['id'] == device_id for d in devices):
                                devices.append({'id': device_id, 'name': f'{short_name} (USB)', 'type': 'usb_ftdi'})
            except:
                pass
            
            try:
                dfu_result = run_cmd('sudo dfu-util -l 2>/dev/null || echo ""', shell=True, capture_output=True, text=True)
                found_dfu = False
                if dfu_result.stdout:
                    seen_dfu = set()
                    for line in dfu_result.stdout.strip().split('\n'):
                        if 'Found DFU' not in line:
                            continue
                        vid_pid_match = re.search(r'\[([0-9a-f]{4}:[0-9a-f]{4})\]', line, re.IGNORECASE)
                        if not vid_pid_match:
                            continue
                        vid_pid = vid_pid_match.group(1).lower()
                        devnum_match = re.search(r'devnum=(\d+)', line)
                        devnum = devnum_match.group(1) if devnum_match else ''
                        serial_match = re.search(r'serial="([^"]+)"', line)
                        serial = serial_match.group(1) if serial_match else ''
                        dedup_key = f'{vid_pid}:{devnum}'
                        if dedup_key in seen_dfu:
                            continue
                        seen_dfu.add(dedup_key)
                        chip_name = DFU_KNOWN_DEVICES.get(vid_pid, '')
                        display_parts = [f'{chip_name} DFU' if chip_name else f'DFU ({vid_pid})']
                        if serial:
                            display_parts.append(f'SN:{serial}')
                        devices.append({'id': f'dfu:{vid_pid}', 'name': ' '.join(display_parts), 'type': 'dfu', 'vid_pid': vid_pid, 'serial': serial, 'devnum': devnum})
                        found_dfu = True
                if not found_dfu:
                    for vidpid, chip_name in DFU_KNOWN_DEVICES.items():
                        lsusb_result = run_cmd(f'lsusb | grep -i "{vidpid}" || echo ""', shell=True, capture_output=True, text=True)
                        if lsusb_result.stdout and vidpid in lsusb_result.stdout:
                            devices.append({'id': f'dfu:{vidpid}', 'name': f'DFU Device ({chip_name} {vidpid})', 'type': 'dfu', 'vid_pid': vidpid, 'serial': '', 'devnum': ''})
                            found_dfu = True
            except:
                pass
            
            try:
                lsblk_output = run_cmd('lsblk -o NAME,MODEL 2>/dev/null | grep -i "RP2"', shell=True, capture_output=True, text=True)
                if lsblk_output.stdout.strip():
                    for line in lsblk_output.stdout.strip().split('\n'):
                        if line.strip():
                            devices.append({'id': 'rp2040_boot', 'name': f'RP2040 UF2 ({line.strip()})'})
                if not any(d['id'] == 'rp2040_boot' for d in devices):
                    lsusb_output = run_cmd('lsusb | grep -i "2e8a:" 2>/dev/null || echo ""', shell=True, capture_output=True, text=True)
                    if lsusb_output.stdout.strip() and '2e8a:' in lsusb_output.stdout:
                        devices.append({'id': 'rp2040_boot', 'name': 'RP2040 UF2 (USB 2e8a)'})
            except:
                pass
        
        return jsonify({'devices': devices})
    except Exception as e:
        return jsonify({'error': str(e)}), 500

# ==================== CAN设备搜索 API ====================
@firmware_bp.route('/api/firmware/can/scan')
def scan_can_devices():
    """扫描CAN设备 - 使用统一扫描函数（支持 ?iface=can1 参数）"""
    iface = request.args.get('iface', 'can0')
    if not iface.startswith('can'):
        return jsonify({'error': f'无效的CAN接口: {iface}'}), 400
    devices, error = _scan_can_uuids(iface)
    return jsonify({'devices': devices, 'error': error})

# ==================== 固件烧录 API ====================
@firmware_bp.route('/api/firmware/flash', methods=['POST'])
def flash_firmware():
    """烧录固件（SSE 流式输出）"""
    req_data = request.json
    def _flash_stream():
     try:
        data = req_data
        klipper_path = expand_klipper_path(config.get('klipper_path', '~/klipper'))
        device = data.get('device_id', data.get('device', ''))
        flash_mode = data.get('flash_mode', 'DFU')
        # CAN Bridge 烧录方式映射：实际使用 DFU 或 KAT 方式烧录
        if flash_mode == 'CAN_BRIDGE_DFU':
            flash_mode = 'DFU'
        elif flash_mode == 'CAN_BRIDGE_KAT':
            flash_mode = 'KAT'
        dfu_address = data.get('dfu_address', '0x08000000')
        firmware_path = data.get('firmware_path', '')
        if firmware_path:
            firmware_path = expand_klipper_path(firmware_path)
        katapult_serial = data.get('katapult_serial', '')
        can_iface = data.get('can_iface', 'can0')
        if not can_iface.startswith('can'):
            can_iface = 'can0'
        
        if not firmware_path:
            firmware_uf2 = os.path.join(klipper_path, 'out', 'klipper.uf2')
            firmware_bin = os.path.join(klipper_path, 'out', 'klipper.bin')
            if flash_mode == 'UF2' and path_exists(firmware_uf2):
                firmware_path = firmware_uf2
            elif path_exists(firmware_uf2):
                firmware_path = firmware_uf2
            else:
                firmware_path = firmware_bin
        
        if not path_exists(firmware_path):
            yield f'data: {json.dumps({"error": f"固件文件不存在: {firmware_path}"})}\n\n'
            return
        
        if is_ssh_mode() and os.path.exists(firmware_path):
            firmware_path = upload_bl_firmware_for_remote(firmware_path)
        
        if flash_mode == 'TF':
            yield f'data: {json.dumps({"success": True, "message": "TF卡模式: 请下载固件并复制到TF卡", "download_url": "/api/firmware/download", "mode": "tf_card"})}\n\n'
            return
        
        if flash_mode == 'DFU':
            if device == 'rp2040_boot':
                flash_mode = 'UF2'
            else:
                if device and device != 'dfu':
                    dfu_vid_pid = device.replace('dfu:', '', 1) if device.startswith('dfu:') else device
                    safe_device = shlex.quote(dfu_vid_pid)
                    device_filter = f'-d {safe_device}'
                else:
                    device_filter = ''
                safe_address = shlex.quote(dfu_address)

                def _run_dfu():
                    LIBUSB_FATAL = ('LIBUSB_ERROR_OTHER', 'LIBUSB_ERROR_NOT_FOUND',
                                    'LIBUSB_ERROR_NO_DEVICE', 'Cannot claim interface',
                                    'Cannot set alternate interface')
                    for alt in (0, 1):
                        flash_cmd = f'sudo dfu-util -a {alt} {device_filter} --dfuse-address {safe_address} -D {shlex.quote(firmware_path)}'
                        r = run_cmd(flash_cmd, shell=True, capture_output=True, text=True, timeout=60)
                        combined = (r.stdout or '') + (r.stderr or '')
                        if r.returncode == 0:
                            return r
                        if not any(e in combined for e in LIBUSB_FATAL):
                            return r
                        logger.warning(f'DFU alt={alt} 失败 ({combined.strip().splitlines()[-1] if combined.strip() else ""})，尝试 alt={1-alt}')
                    r.stdout = (r.stdout or '') + (
                        '\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n'
                        '[烧录失败] dfu-util 无法访问 DFU 设备\n'
                        '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n'
                        '\n【请先重新进入 DFU 烧录模式】\n'
                        '  方法一（推荐）：\n'
                        '    1. 按住主板上的 BOOT 按键不放\n'
                        '    2. 同时按一下 RESET 按键后松开\n'
                        '    3. 再松开 BOOT 按键\n'
                        '    4. 重新点击烧录按钮\n'
                        '  方法二（断电重进）：\n'
                        '    1. 拔掉 USB 线\n'
                        '    2. 按住 BOOT 按键\n'
                        '    3. 插上 USB 线后松开 BOOT 按键\n'
                        '    4. 重新点击烧录按钮\n'
                        '\n【如果仍然失败，请检查以下问题】\n'
                        '  1. 更换 USB 线（建议使用短线，避免延长线/hub）\n'
                        '  2. 直连主机 USB 口，不要经过 USB hub 或扩展坞\n'
                        '  3. 尝试更换主机上不同的 USB 口\n'
                        '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n'
                    )
                    return r

                flash_result = _run_dfu()
                output = flash_result.stdout + flash_result.stderr
                returncode = flash_result.returncode
                
                if returncode == 0:
                    yield f'data: {json.dumps({"success": True, "message": "烧录成功", "output": output})}\n\n'
                    return
                else:
                    yield f'data: {json.dumps({"success": False, "error": "烧录失败", "output": output})}\n\n'
                    return
        
        if flash_mode in ('KAT', 'CAN'):
            klipper_owner, home_dir = get_klipper_owner()
            python_bin = get_klipper_python_bin(home_dir)
            flashtool_script = os.path.join(home_dir, 'katapult', 'scripts', 'flashtool.py')
            
            import logging
            _prefix = f'{can_iface}:'
            _is_can_uuid = bool(re.match(r'^[a-fA-F0-9]{8,32}$', device.replace(_prefix, '').replace('can0:', '')))
            if _prefix in device or 'can0:' in device or _is_can_uuid:
                can_uuid = device
                for pfx in (_prefix, 'can0:', 'can1:', 'can2:'):
                    if pfx in can_uuid:
                        can_uuid = can_uuid.replace(pfx, '')
                        break
                
                if is_fast_ssh_mode():
                    logging.info('FAST-SSH 模式：使用 CAN 直接烧录')
                    fast_flashtool = os.path.join(home_dir, 'klipper', 'lib', 'katapult', 'flashtool.py')
                    fast_flash_can = os.path.join(home_dir, 'klipper', 'lib', 'canboot', 'flash_can.py')
                    if path_exists(fast_flashtool):
                        cmd = f'{python_bin} {fast_flashtool} -i {can_iface} -u {shlex.quote(can_uuid)} -f {shlex.quote(firmware_path)}'
                        logging.info(f'FAST-SSH 新版烧录命令 (katapult/flashtool.py, {can_iface}): {cmd}')
                    elif path_exists(fast_flash_can):
                        cmd = f'{python_bin} {fast_flash_can} -i {can_iface} -u {shlex.quote(can_uuid)} -f {shlex.quote(firmware_path)}'
                        logging.info(f'FAST-SSH 旧版烧录命令 (canboot/flash_can.py, {can_iface}): {cmd}')
                    else:
                        yield f'data: {json.dumps({"error": f"未找到烧录工具。请确认 Klipper 已安装。\\n查找路径:\\n  {fast_flashtool}\\n  {fast_flash_can}"})}\n\n'
                        return
                    result = run_cmd(cmd, shell=True, capture_output=True, text=True, timeout=120)
                else:
                    reset_cmd = f'{python_bin} {flashtool_script} -i {can_iface} -r -u {shlex.quote(can_uuid)}'
                    logging.info(f'CAN 重置命令：{reset_cmd}')
                    run_cmd(reset_cmd, shell=True, capture_output=True, text=True, timeout=30)
                    logging.info('等待设备重新枚举...')
                    katapult_device = None
                    for _ in range(20):
                        time.sleep(0.5)
                        find_result = run_cmd("ls /dev/serial/by-id/* 2>/dev/null", shell=True, capture_output=True, text=True, timeout=5)
                        if find_result.stdout.strip():
                            lines = [l.strip() for l in find_result.stdout.strip().split('\n') if l.strip()]
                            for line in lines:
                                if re.search(r'(Klipper|Katapult|STM32)', line, re.IGNORECASE):
                                    katapult_device = line
                                    break
                            if not katapult_device and lines:
                                katapult_device = lines[0]
                            if katapult_device:
                                break
                        logging.info(f'轮询中... ({_+1}/20)')
                    
                    if katapult_device:
                        new_device = katapult_device
                        logging.info(f'找到设备：{new_device}')
                        cmd = f'{python_bin} {flashtool_script} -d {shlex.quote(new_device)} -f {shlex.quote(firmware_path)}'
                        logging.info(f'USB 烧录命令：{cmd}')
                        result = run_cmd(cmd, shell=True, capture_output=True, text=True, timeout=60)
                    else:
                        logging.warning('未找到 USB 串口设备，尝试直接 CAN 烧录...')
                        flash_can_script = os.path.join(home_dir, 'klipper', 'lib', 'canboot', 'flash_can.py')
                        if path_exists(flash_can_script):
                            cmd = f'{python_bin} {flash_can_script} -i {can_iface} -u {shlex.quote(can_uuid)} -f {shlex.quote(firmware_path)}'
                            logging.info(f'CAN 烧录命令 ({can_iface}): {cmd}')
                            result = run_cmd(cmd, shell=True, capture_output=True, text=True, timeout=120)
                        else:
                            logging.warning(f'flash_can.py 不存在: {flash_can_script}，回退到 flashtool.py CAN 模式')
                            cmd = f'{python_bin} {flashtool_script} -i {can_iface} -u {shlex.quote(can_uuid)} -f {shlex.quote(firmware_path)}'
                            logging.info(f'flashtool CAN 烧录命令 ({can_iface}): {cmd}')
                            result = run_cmd(cmd, shell=True, capture_output=True, text=True, timeout=120)
            else:
                usb_device = katapult_serial if katapult_serial else device
                logging.info(f'USB 烧录命令：device={usb_device}')
                cmd = f'{python_bin} {flashtool_script} -d {shlex.quote(usb_device)} -f {shlex.quote(firmware_path)}'
                logging.info(f'USB 烧录命令：{cmd}')
                result = run_cmd(cmd, shell=True, capture_output=True, text=True, timeout=60)
                    
            output = result.stdout + result.stderr
            returncode = result.returncode
            logging.info(f'烧录结果：returncode={returncode}, output={output[:200]}')
            
        elif flash_mode == 'UF2':
            rp2040_flash_tool = os.path.join(klipper_path, 'lib/rp2040_flash/rp2040_flash')
            if not path_exists(rp2040_flash_tool):
                yield f'data: {json.dumps({"error": "rp2040_flash工具不存在，请检查Klipper安装"})}\n\n'
                return
            _umount_rp2040_boot()
            cmd = f'sudo {rp2040_flash_tool} {firmware_path}'
            result = run_cmd(cmd, shell=True, capture_output=True, text=True, timeout=60)
            output = result.stdout + result.stderr
            returncode = result.returncode
            if returncode == 0 and 'No rp2040 in BOOTSEL mode was found' in output:
                returncode = 1
                output = '【错误】未找到处于 BOOTSEL 模式的 RP2040 设备\n' + output
        else:
            yield f'data: {json.dumps({"error": f"不支持的烧录方式: {flash_mode}"})}\n\n'
            return
        
        if returncode == 0:
            yield f'data: {json.dumps({"success": True, "message": "烧录成功", "output": output})}\n\n'
            return
        else:
            yield f'data: {json.dumps({"success": False, "error": "烧录失败", "output": output})}\n\n'
            return
            
     except subprocess.TimeoutExpired:
            yield f'data: {json.dumps({"error": "烧录超时"})}\n\n'
     except Exception as e:
            yield f'data: {json.dumps({"error": str(e)})}\n\n'
    return Response(_flash_stream(), mimetype='text/event-stream',
                    headers={'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no'})

# ==================== HOST固件安装 API ====================
@firmware_bp.route('/api/firmware/install-host', methods=['POST'])
def install_host_firmware():
    """安装固件到主板 MCU（通过 HOST 设备烧录）（SSE 流式输出）"""
    req_data = request.json
    def _install_stream():
     try:
        data = req_data
        firmware_path = data.get('firmware_path', '')
        if not firmware_path:
            yield f'data: {json.dumps({"error": "固件路径不能为空"})}\n\n'
            return
        firmware_path = expand_klipper_path(firmware_path)
        if not path_exists(firmware_path):
            yield f'data: {json.dumps({"error": f"固件文件不存在: {firmware_path}"})}\n\n'
            return
        
        if is_fast_ssh_mode():
            flash_cmd = f'fly-flash -d auto -h -f {shlex.quote(firmware_path)}'
            logger.info(f'HOST 烧录命令: {flash_cmd}')
            result = run_cmd(flash_cmd, shell=True, capture_output=True, text=True, timeout=120)
            output = (result.stdout + '\n' + result.stderr).strip()
            if result.returncode != 0:
                yield f'data: {json.dumps({"error": f"fly-flash 烧录失败: {output}"})}\n\n'
                return
            restart_result = run_cmd('systemctl restart klipper.service', shell=True, capture_output=True, text=True, timeout=30)
            restart_output = (restart_result.stdout + restart_result.stderr).strip()
            if restart_result.returncode != 0:
                logger.warning(f'Klipper 重启失败: {restart_output}')
            yield f'data: {json.dumps({"success": True, "message": f"固件烧录成功: {firmware_path}", "flash_output": output, "restart_output": restart_output, "method": "fly-flash"})}\n\n'
            return
        
        klipper_path = expand_klipper_path(config.get('klipper_path', '~/klipper'))
        target_path = os.path.join(klipper_path, 'out', 'klipper.bin')
        if is_ssh_mode():
            run_cmd(f'mkdir -p {shlex.quote(os.path.dirname(target_path))}', shell=True, capture_output=True)
            result = run_cmd(f'cp {shlex.quote(firmware_path)} {shlex.quote(target_path)}', shell=True, capture_output=True, text=True, timeout=10)
            if result.returncode != 0:
                yield f'data: {json.dumps({"error": f"复制失败: {result.stderr}"})}\n\n'
                return
        else:
            import shutil
            os.makedirs(os.path.dirname(target_path), exist_ok=True)
            shutil.copy2(firmware_path, target_path)
        
        yield f'data: {json.dumps({"success": True, "message": f"固件已复制到 {target_path}", "target_path": target_path, "method": "copy"})}\n\n'
        return
        
     except Exception as e:
            yield f'data: {json.dumps({"error": str(e)})}\n\n'
    return Response(_install_stream(), mimetype='text/event-stream',
                    headers={'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no'})

# ==================== HOST 固件信息 API ====================
@firmware_bp.route('/api/firmware/host-info')
def get_host_firmware_info():
    """获取预构建固件列表并根据 MCU 匹配最佳固件"""
    try:
        mcu_id = (request.args.get('mcu', '') or '').lower()
        comm_type = request.args.get('comm_type', '')
        bl_offset = request.args.get('bl_offset', '')
        firmware_dir = '/usr/lib/firmware/klipper'
        firmware_files = []
        
        if is_ssh_mode():
            result = run_cmd(f'ls -la {shlex.quote(firmware_dir)}/ 2>/dev/null', shell=True, capture_output=True, text=True, timeout=10)
            if result.returncode == 0:
                for line in result.stdout.strip().split('\n'):
                    parts = line.split()
                    if len(parts) >= 9 and parts[-1].endswith('.bin'):
                        name = parts[-1]
                        size = int(parts[4]) if parts[4].isdigit() else 0
                        full_path = os.path.join(firmware_dir, name)
                        firmware_files.append({'name': name, 'path': full_path, 'size': size})
        else:
            if os.path.isdir(firmware_dir):
                for name in os.listdir(firmware_dir):
                    if name.endswith('.bin'):
                        full_path = os.path.join(firmware_dir, name)
                        try:
                            size = os.path.getsize(full_path)
                        except:
                            size = 0
                        firmware_files.append({'name': name, 'path': full_path, 'size': size})
        
        for fw in firmware_files:
            m = re.match(r'^([a-z0-9]+)-(\d+)k-(\w+?)(?:-(\w+))?\.bin$', fw['name'])
            if m:
                fw['fw_mcu'] = m.group(1)
                fw['fw_bl'] = m.group(2) + 'k'
                fw['fw_comm'] = m.group(3)
                fw['fw_speed'] = m.group(4) or ''
            else:
                fw['fw_mcu'] = fw['fw_bl'] = fw['fw_comm'] = fw['fw_speed'] = ''
        
        best_match = None
        best_score = 0
        comm_map = {'usb': 'usb', 'serial': 'serial', 'can': 'usbcan', 'usbcanbridge': 'usbcan'}
        target_comm = comm_map.get(comm_type, comm_type)
        
        for fw in firmware_files:
            if not fw.get('fw_mcu'):
                continue
            score = 0
            if mcu_id and mcu_id.lower() == fw['fw_mcu'].lower():
                score += 10
            elif mcu_id and mcu_id.lower().startswith(fw['fw_mcu'][:6].lower()):
                score += 5
            if bl_offset and bl_offset.lower() == fw['fw_bl'].lower():
                score += 3
            if target_comm and target_comm == fw['fw_comm']:
                score += 5
            if score > best_score:
                best_score = score
                best_match = fw
        
        return jsonify({
            'firmware_dir': firmware_dir,
            'firmware_files': firmware_files,
            'best_match': best_match,
            'best_score': best_score,
            'query': {'mcu': mcu_id, 'comm_type': comm_type, 'bl_offset': bl_offset}
        })
    except Exception as e:
        return jsonify({'error': str(e)}), 500

# ==================== 远程目录浏览 API ====================
@firmware_bp.route('/api/remote/browse')
def remote_browse():
    """浏览远程/本地目录，用于选择固件文件"""
    try:
        path = request.args.get('path', '')
        if not path:
            if is_ssh_mode():
                path = '~'
            else:
                path = os.path.expanduser('~')
        
        if path.startswith('~'):
            if is_ssh_mode():
                manager = SSHManager.get_instance()
                result = manager.exec_command('echo $HOME', timeout=5)
                home = result.stdout.strip()
                if home:
                    path = path.replace('~', home, 1)
            else:
                path = os.path.expanduser(path)
        
        entries = []
        if is_ssh_mode():
            manager = SSHManager.get_instance()
            result = manager.exec_command(
                f'ls -la --time-style=long-iso {shlex.quote(path)} 2>/dev/null | tail -n +2',
                timeout=10
            )
            if result.returncode == 0 and result.stdout.strip():
                for line in result.stdout.strip().split('\n'):
                    parts = line.split()
                    if len(parts) >= 8:
                        perms = parts[0]
                        size = parts[4]
                        name = parts[7]
                        if name in ('.', '..') or name.startswith('.'):
                            continue
                        is_dir = perms.startswith('d')
                        entries.append({'name': name, 'is_dir': is_dir, 'size': int(size) if not is_dir else 0, 'path': os.path.join(path, name)})
        else:
            abs_path = os.path.abspath(path)
            if os.path.isdir(abs_path):
                for name in sorted(os.listdir(abs_path)):
                    if name.startswith('.'):
                        continue
                    full_path = os.path.join(abs_path, name)
                    is_dir = os.path.isdir(full_path)
                    entries.append({'name': name, 'is_dir': is_dir, 'size': os.path.getsize(full_path) if not is_dir else 0, 'path': full_path})
        
        entries.sort(key=lambda x: (not x['is_dir'], x['name'].lower()))
        parent = os.path.dirname(path.rstrip('/')) if path != '/' and path != '~' else None
        
        return jsonify({'path': path, 'parent': parent, 'entries': entries})
    except Exception as e:
        return jsonify({'error': str(e)}), 500

# ==================== BL固件烧录 API ====================
@firmware_bp.route('/api/firmware/bl/flash', methods=['POST'])
def flash_bl_firmware():
    """烧录BL固件 (Katapult/Bootloader)"""
    try:
        data = request.json
        bl_firmware_path = data.get('bl_firmware_path', '')
        device = data.get('device_id', data.get('device', ''))
        flash_mode = data.get('flash_mode', 'DFU')
        dfu_address = data.get('dfu_address', '0x08000000')
        katapult_serial = data.get('katapult_serial', '')
        erase_flash = data.get('erase_flash', True)
        
        if not bl_firmware_path or not os.path.exists(bl_firmware_path):
            return jsonify({'error': f'BL固件文件不存在: {bl_firmware_path}'}), 400
        
        if is_ssh_mode():
            bl_firmware_path = upload_bl_firmware_for_remote(bl_firmware_path)
        
        if flash_mode == 'DFU':
            if device and device != 'dfu':
                dfu_vid_pid = device.replace('dfu:', '', 1) if device.startswith('dfu:') else device
                device_filter = f'-d {dfu_vid_pid}'
            else:
                device_filter = ''
            safe_address = shlex.quote(dfu_address)

            if erase_flash:
                logger.info('BL 烧录前执行 Flash 全片擦除...')
                erase_cmd = f'sudo dfu-util -a 0 {device_filter} -s {safe_address}:mass-erase:force'
                erase_result = run_cmd(erase_cmd, shell=True, capture_output=True, text=True, timeout=60)
                if erase_result.returncode != 0:
                    logger.warning(f'Flash 擦除失败 (rc={erase_result.returncode})，继续尝试烧录')
                else:
                    logger.info('Flash 擦除完成')

            def _run_dfu_flash():
                LIBUSB_FATAL = ('LIBUSB_ERROR_OTHER', 'LIBUSB_ERROR_NOT_FOUND',
                                'LIBUSB_ERROR_NO_DEVICE', 'Cannot claim interface',
                                'Cannot set alternate interface')
                for alt in (0, 1):
                    flash_cmd = f'sudo dfu-util -a {alt} {device_filter} --dfuse-address {safe_address} -D {shlex.quote(bl_firmware_path)}'
                    r = run_cmd(flash_cmd, shell=True, capture_output=True, text=True, timeout=60)
                    combined = (r.stdout or '') + (r.stderr or '')
                    if r.returncode == 0:
                        return None, r
                    if not any(e in combined for e in LIBUSB_FATAL):
                        return None, r
                    logger.warning(f'DFU alt={alt} 失败 ({combined.strip().splitlines()[-1] if combined.strip() else ""})，尝试 alt={1-alt}')
                r.stdout = (r.stdout or '') + (
                    '\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n'
                    '[烧录失败] dfu-util 无法访问 DFU 设备\n'
                    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n'
                    '\n【请先重新进入 DFU 烧录模式】\n'
                    '  方法一（推荐）：\n'
                    '    1. 按住主板上的 BOOT 按键不放\n'
                    '    2. 同时按一下 RESET 按键后松开\n'
                    '    3. 再松开 BOOT 按键\n'
                    '    4. 重新点击烧录按钮\n'
                    '  方法二（断电重进）：\n'
                    '    1. 拔掉 USB 线\n'
                    '    2. 按住 BOOT 按键\n'
                    '    3. 插上 USB 线后松开 BOOT 按键\n'
                    '    4. 重新点击烧录按钮\n'
                    '\n【如果仍然失败，请检查以下问题】\n'
                    '  1. 更换 USB 线（建议使用短线，避免延长线/hub）\n'
                    '  2. 直连主机 USB 口，不要经过 USB hub 或扩展坞\n'
                    '  3. 尝试更换主机上不同的 USB 口\n'
                    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n'
                )
                return None, r

            _, result = _run_dfu_flash()
            
        elif flash_mode == 'UF2':
            klipper_path = expand_klipper_path(config.get('klipper_path', '~/klipper'))
            rp2040_flash_tool = os.path.join(klipper_path, 'lib/rp2040_flash/rp2040_flash')
            if not path_exists(rp2040_flash_tool):
                return jsonify({'error': 'rp2040_flash工具不存在，请检查Klipper安装'}), 500
            _umount_rp2040_boot()
            time.sleep(0.5)
            cmd = f'sudo {rp2040_flash_tool} {bl_firmware_path}'
            result = run_cmd(cmd, shell=True, capture_output=True, text=True, timeout=60)
            if result.returncode == 0 and 'No rp2040 in BOOTSEL mode was found' in (result.stdout + result.stderr):
                return jsonify({'success': False, 'error': '未找到处于 BOOTSEL 模式的 RP2040 设备', 'output': result.stdout + result.stderr}), 500
            
        elif flash_mode == 'KAT':
            klipper_owner, home_dir = get_klipper_owner()
            python_bin = get_klipper_python_bin(home_dir)
            flashtool_script = os.path.join(home_dir, 'katapult', 'scripts', 'flashtool.py')
            usb_device = katapult_serial if katapult_serial else device
            cmd = f'{python_bin} {flashtool_script} -d {usb_device} -f {bl_firmware_path}' if usb_device else f'{python_bin} {flashtool_script} -f {bl_firmware_path}'
            result = run_cmd(cmd, shell=True, capture_output=True, text=True, timeout=60)
            
        elif flash_mode == 'st-flash':
            stflash_cmd = f'sudo st-flash --reset write {bl_firmware_path} {dfu_address}'
            result = run_cmd(stflash_cmd, shell=True, capture_output=True, text=True, timeout=60)
            
        elif flash_mode == 'openocd':
            openocd_cmd = f'sudo openocd -f interface/stlink.cfg -f target/stm32f1x.cfg -c "program {bl_firmware_path} {dfu_address} verify reset exit"'
            result = run_cmd(openocd_cmd, shell=True, capture_output=True, text=True, timeout=120)
            
        else:
            return jsonify({'error': f'不支持的BL烧录方式: {flash_mode}'}), 400
        
        if result.returncode == 0:
            return jsonify({'success': True, 'message': 'BL固件烧录成功', 'output': result.stdout + result.stderr})
        else:
            return jsonify({'success': False, 'error': 'BL固件烧录失败', 'output': result.stdout + result.stderr}), 500
            
    except Exception as e:
        return jsonify({'error': str(e)}), 500
