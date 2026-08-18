"""
固件编译与烧录蓝图 - 固件编译、下载、检测、烧录等
"""

from flask import Blueprint, jsonify, request, send_file, Response
from werkzeug.utils import secure_filename
import subprocess
import os
import posixpath
import re
import json
import time
import shlex
import hashlib
import shutil
import threading
import urllib.parse

from shared import (
    config, logger, BASE_DIR, BOARD_CONFIGS_DIR,
    DFU_KNOWN_DEVICES,
    run_cmd, run_cmd_stream, path_exists, get_file_size,
    is_ssh_mode, is_fast_ssh_mode,
    expand_klipper_path, get_klipper_owner, get_klipper_python_bin,
    download_firmware_from_remote, upload_bl_firmware_for_remote,
    sudo_write_file,
    load_all_boards, load_board_config, get_manufacturers, get_bl_firmwares,
    SSHManager,
    safe_error,
)
from routes_system import _scan_can_uuids, _is_valid_can_iface
from klipper_kconfig_parser import KlipperKconfigParser
from kconfig_can_parser import parse_can_options

firmware_bp = Blueprint('firmware', __name__)
MANIFEST_FILENAME = 'firmware-tool-manifest.json'
DEFAULT_CANBUS_FREQUENCY = '1000000'
HOST_PREBUILT_FIRMWARE_DIR = '/usr/lib/firmware/klipper'
_compile_lock = threading.Lock()
_flash_lock = threading.Lock()
_bl_flash_lock = threading.Lock()
BL_UPLOAD_DIR = os.path.join(BASE_DIR, 'data', 'bl_uploads')
BL_UPLOAD_MAX_BYTES = 4 * 1024 * 1024


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
                            f'sudo umount {shlex.quote(mount_point)} 2>/dev/null || true',
                            shell=True, capture_output=True, timeout=10
                        )
    except Exception:
        pass
    time.sleep(0.5)


def _normalize_config_symbol(symbol):
    """返回不带 CONFIG_ 前缀的 Kconfig symbol。"""
    symbol = str(symbol or '').strip()
    if symbol.startswith('CONFIG_'):
        symbol = symbol[7:]
    if re.match(r'^[A-Za-z_][A-Za-z0-9_]*$', symbol):
        return symbol
    return ''


def _config_line(symbol):
    symbol = _normalize_config_symbol(symbol)
    if not symbol:
        return ''
    return f'CONFIG_{symbol}=y'


def _kconfig_string(value):
    value = str(value or '').strip()
    if '\n' in value or '\r' in value:
        raise ValueError('Kconfig 字符串不能包含换行')
    return value.replace('\\', '\\\\').replace('"', '\\"')


def _truthy(value):
    if isinstance(value, bool):
        return value
    return str(value or '').strip().lower() in ('1', 'true', 'yes', 'on')


def _normalize_canbus_frequency(value):
    raw = str(value or '').strip().lower()
    if not raw:
        return DEFAULT_CANBUS_FREQUENCY
    match = re.match(r'^(\d+(?:\.\d+)?)\s*([km])?$', raw)
    if not match:
        raise ValueError(f'CAN 速率格式错误: {value}')
    number = float(match.group(1))
    multiplier = 1000000 if match.group(2) == 'm' else 1000 if match.group(2) == 'k' else 1
    frequency = int(round(number * multiplier))
    if frequency < 10000 or frequency > 5000000:
        raise ValueError(f'CAN 速率必须在 10000 到 5000000 之间: {value}')
    return str(frequency)


def _normalize_rp2040_gpio(value, label):
    raw = str(value or '').strip()
    if not re.fullmatch(r'\d+', raw):
        raise ValueError(f'{label} 必须是 0 到 29 之间的整数')
    pin = int(raw)
    if pin < 0 or pin > 29:
        raise ValueError(f'{label} 必须是 0 到 29 之间的整数')
    return str(pin)


def _device_state(device):
    dtype = (device.get('type') or '').lower()
    did = (device.get('id') or '').lower()
    name = (device.get('name') or '').lower()
    if dtype == 'dfu' or did.startswith('dfu:'):
        return 'dfu'
    if did == 'rp2040_boot' or 'rp2' in name or 'uf2' in name:
        return 'uf2'
    if 'katapult' in name or 'canboot' in name:
        return 'katapult'
    if 'klipper' in name:
        return 'klipper'
    if dtype in ('usb_serial', 'usb_acm', 'usb_ftdi'):
        return 'serial'
    return 'unknown'


def _annotate_devices(devices):
    for device in devices:
        device.setdefault('state', _device_state(device))
    return devices


def _dfu_device_id(vid_pid, serial='', usb_path=''):
    value = f'dfu:{str(vid_pid or "").lower()}'
    if serial:
        value += ';serial=' + urllib.parse.quote(str(serial), safe='')
    if usb_path:
        value += ';path=' + urllib.parse.quote(str(usb_path), safe='')
    return value


def _dfu_device_filter(device):
    """将 UI 的唯一 DFU 标识转换成 dfu-util 过滤参数。"""
    raw = str(device or '').strip()
    if not raw or raw == 'dfu':
        return ''
    payload = raw[4:] if raw.startswith('dfu:') else raw
    parts = payload.split(';')
    vid_pid = parts[0].lower()
    if not re.fullmatch(r'[0-9a-f]{4}:[0-9a-f]{4}', vid_pid):
        raise ValueError('DFU 设备 ID 无效')
    filters = [f'-d {shlex.quote(vid_pid)}']
    for part in parts[1:]:
        key, sep, encoded = part.partition('=')
        if not sep:
            continue
        value = urllib.parse.unquote(encoded)
        if key == 'serial' and value:
            filters.append(f'-S {shlex.quote(value)}')
        elif key == 'path' and value:
            filters.append(f'-p {shlex.quote(value)}')
    return ' '.join(filters)


def _openocd_target_for_mcu(mcu_id):
    """根据 MCU 型号选择 OpenOCD target，未知型号不允许猜测。"""
    value = str(mcu_id or '').strip().lower().replace('-', '').replace('_', '')
    mappings = (
        (('stm32f0',), 'stm32f0x'),
        (('stm32f1',), 'stm32f1x'),
        (('stm32f2',), 'stm32f2x'),
        (('stm32f3',), 'stm32f3x'),
        (('stm32f4',), 'stm32f4x'),
        (('stm32f7',), 'stm32f7x'),
        (('stm32g0',), 'stm32g0x'),
        (('stm32g4',), 'stm32g4x'),
        (('stm32h7',), 'stm32h7x'),
        (('stm32l0',), 'stm32l0'),
        (('stm32l4',), 'stm32l4x'),
    )
    for prefixes, target in mappings:
        if value.startswith(prefixes):
            return target
    return ''


def _manifest_path(klipper_path):
    return os.path.join(klipper_path, 'out', MANIFEST_FILENAME)


def _read_text_file(path):
    if is_ssh_mode():
        result = run_cmd(f'cat {shlex.quote(path)} 2>/dev/null', shell=True, capture_output=True, text=True, timeout=5)
        if result.returncode != 0:
            return ''
        return result.stdout or ''
    try:
        with open(path, 'r', encoding='utf-8', errors='replace') as f:
            return f.read()
    except (OSError, IOError):
        return ''


def _normalize_fs_path(path):
    path = str(path or '').strip()
    if is_ssh_mode():
        norm = posixpath.normpath(path)
        # SSH 模式：解析符号链接，防止链接逃逸出允许根目录（S9）
        try:
            result = run_cmd(
                f'readlink -f {shlex.quote(norm)} 2>/dev/null || echo {shlex.quote(norm)}',
                shell=True, capture_output=True, text=True, timeout=5
            )
            resolved = (result.stdout or '').strip()
            if resolved:
                return posixpath.normpath(resolved)
        except Exception:
            pass
        return norm
    return os.path.realpath(os.path.expanduser(path))


def _path_under(path, roots):
    normalized = _normalize_fs_path(path)
    for root in roots:
        normalized_root = _normalize_fs_path(root)
        try:
            if is_ssh_mode():
                if normalized == normalized_root or normalized.startswith(normalized_root.rstrip('/') + '/'):
                    return True
            elif os.path.commonpath([normalized, normalized_root]) == normalized_root:
                return True
        except ValueError:
            continue
    return False


def _unique_paths(paths):
    unique = []
    seen = set()
    for path in paths:
        if not path:
            continue
        normalized = _normalize_fs_path(path)
        if normalized in seen:
            continue
        seen.add(normalized)
        unique.append(path)
    return unique


def _host_firmware_dirs(klipper_path=None):
    klipper_path = klipper_path or expand_klipper_path(config.get('klipper_path', '~/klipper'))
    return _unique_paths([
        os.path.join(klipper_path, 'out'),
        '/data/klipper/out',
        HOST_PREBUILT_FIRMWARE_DIR,
    ])


def _allowed_firmware_roots(klipper_path=None):
    klipper_path = klipper_path or expand_klipper_path(config.get('klipper_path', '~/klipper'))
    roots = [
        os.path.join(klipper_path, 'out'),
        '/data/klipper/out',
        HOST_PREBUILT_FIRMWARE_DIR,
        os.path.join(BASE_DIR, 'board_configs'),
        os.path.join(BASE_DIR, 'out'),
    ]
    return _unique_paths(roots)


def _allowed_browse_roots(klipper_path=None):
    klipper_path = klipper_path or expand_klipper_path(config.get('klipper_path', '~/klipper'))
    roots = [
        klipper_path,
        os.path.join(klipper_path, 'out'),
        HOST_PREBUILT_FIRMWARE_DIR,
        os.path.join(BASE_DIR, 'board_configs'),
    ]
    try:
        _, home_dir = get_klipper_owner(klipper_path)
        if home_dir:
            roots.append(home_dir)
    except Exception:
        pass
    for root in ('/data', '/tmp'):
        roots.append(root)
    return _unique_paths(roots)


def _is_safe_klipper_tree(klipper_path):
    if not klipper_path or klipper_path in ('/', '/root', '/home', '/data', '/tmp'):
        return False
    return path_exists(os.path.join(klipper_path, 'Makefile')) and path_exists(os.path.join(klipper_path, 'src', 'Kconfig'))


def _decode_config_value(value):
    value = str(value or '').strip()
    if len(value) >= 2 and value[0] == '"' and value[-1] == '"':
        value = value[1:-1]
        value = value.replace(r'\"', '"').replace(r'\\', '\\')
    return value


def _parse_klipper_config(content):
    config_values = {}
    raw_config = {}
    for line in (content or '').splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        unset_match = re.match(r'^#\s*CONFIG_([A-Za-z0-9_]+)\s+is\s+not\s+set$', stripped)
        if unset_match:
            symbol = unset_match.group(1)
            config_values[symbol] = 'n'
            raw_config[f'CONFIG_{symbol}'] = 'n'
            continue
        if not stripped.startswith('CONFIG_') or '=' not in stripped:
            continue
        key, value = stripped.split('=', 1)
        symbol = key[7:]
        decoded = _decode_config_value(value)
        config_values[symbol] = decoded
        raw_config[key] = decoded
    return config_values, raw_config


def _config_truthy(config_values, symbol):
    symbol = _normalize_config_symbol(symbol)
    if not symbol:
        return False
    return str(config_values.get(symbol, '')).strip().lower() in ('y', '1', 'true', 'yes', 'on')


def _first_enabled_option(options, config_values, symbol_key='config_symbol'):
    for option in options or []:
        if _config_truthy(config_values, option.get(symbol_key)):
            return option
    return None


def _infer_crystal_from_symbols(config_values):
    for symbol, value in config_values.items():
        if str(value).strip().lower() not in ('y', '1', 'true', 'yes', 'on'):
            continue
        upper = symbol.upper()
        if 'CLOCK_REF_INTERNAL' in upper:
            return 'internal'
        if 'CLOCK_REF_X32K' in upper:
            return '32768'
        match = re.search(r'CLOCK_REF_X?(\d+)M\b', upper)
        if match:
            return str(int(match.group(1)) * 1000000)
        match = re.search(r'CLOCK_REF_(\d+)$', upper)
        if match and match.group(1) in ('8', '12', '16', '20', '24', '25'):
            return str(int(match.group(1)) * 1000000)
    return ''


def _infer_bl_offset_from_symbols(config_values):
    for symbol, value in config_values.items():
        if str(value).strip().lower() not in ('y', '1', 'true', 'yes', 'on'):
            continue
        match = re.search(r'FLASH_START_([0-9A-Fa-f]+)$', symbol)
        if match:
            try:
                return str(int(match.group(1), 16))
            except ValueError:
                return ''
    return ''


def _find_current_mcu(mcu_database, config_values):
    fallback = None
    for platform_name, platform_data in (mcu_database or {}).items():
        arch_enabled = _config_truthy(config_values, platform_data.get('arch_config'))
        for mcu_id, mcu in (platform_data.get('mcus') or {}).items():
            mcu_symbol = mcu.get('config_symbol') or mcu.get('config_name')
            if not _config_truthy(config_values, mcu_symbol):
                continue
            result = {
                'platform': platform_name,
                'platform_key': platform_data.get('platform', ''),
                'arch_config': platform_data.get('arch_config', ''),
                'mcu_id': mcu_id,
                'mcu': mcu,
            }
            if arch_enabled:
                return result
            if fallback is None:
                fallback = result
    return fallback


def _resolve_current_config_params(kconfig_klipper_path, config_values):
    warnings = []
    parser = KlipperKconfigParser(kconfig_klipper_path)
    mcu_database = parser.parse_all_platforms()
    selected = _find_current_mcu(mcu_database, config_values)
    if not selected:
        return {}, ['未能从 .config 识别 MCU 平台和型号']

    mcu = selected['mcu']
    params = {
        'platform': selected['platform'],
        'platform_key': selected.get('platform_key', ''),
        'arch_config': selected.get('arch_config', ''),
        'mcu': selected['mcu_id'],
        'mcu_name': mcu.get('name', ''),
        'mcu_config_symbol': mcu.get('config_symbol') or mcu.get('config_name', ''),
        'startup_pin': config_values.get('INITIAL_PINS', ''),
    }

    crystal_option = _first_enabled_option(mcu.get('crystal_options', []), config_values)
    if crystal_option:
        params['crystal'] = crystal_option.get('value', '')
        params['crystal_config_symbol'] = crystal_option.get('config_symbol', '')
        params['crystal_display'] = crystal_option.get('display', '')
    else:
        params['crystal'] = _infer_crystal_from_symbols(config_values)

    bl_option = _first_enabled_option(mcu.get('bl_offset_options', []), config_values)
    if bl_option:
        params['bl_offset'] = bl_option.get('offset', '')
        params['bl_offset_config_symbol'] = bl_option.get('config_symbol', '')
        params['bl_offset_display'] = bl_option.get('display', '')
    else:
        params['bl_offset'] = _infer_bl_offset_from_symbols(config_values)

    comm_data = parse_can_options(kconfig_klipper_path)
    platform_data = comm_data.get(selected.get('platform_key', ''), {})
    comm_option = _first_enabled_option(platform_data.get('communication_options', []), config_values)
    if comm_option:
        params['comm_type'] = comm_option.get('comm_type', '')
        params['comm_config_symbol'] = comm_option.get('config_symbol', '')
        params['communication'] = comm_option.get('display', '')
    else:
        warnings.append('未能从 .config 识别通信接口')

    bridge_option = _first_enabled_option(platform_data.get('bridge_can', []), config_values, 'config')
    if bridge_option:
        params['bridge_can_config'] = bridge_option.get('config', '')
        params['bridge_can_display'] = bridge_option.get('display', '')

    if 'RPXXXX_CANBUS_GPIO_RX' in config_values:
        params['rp2040_can_rx_gpio'] = config_values.get('RPXXXX_CANBUS_GPIO_RX')
    if 'RPXXXX_CANBUS_GPIO_TX' in config_values:
        params['rp2040_can_tx_gpio'] = config_values.get('RPXXXX_CANBUS_GPIO_TX')
    if 'CANBUS_FREQUENCY' in config_values:
        params['canbus_frequency'] = config_values.get('CANBUS_FREQUENCY')

    return params, warnings


def _file_sha256(path):
    if is_ssh_mode():
        result = run_cmd(f'sha256sum {shlex.quote(path)} 2>/dev/null', shell=True, capture_output=True, text=True, timeout=20)
        if result.returncode == 0 and result.stdout.strip():
            return result.stdout.strip().split()[0]
        return ''
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def _firmware_download_name(path):
    ext = os.path.splitext(str(path or ''))[1].lower()
    if ext in ('.bin', '.uf2', '.hex'):
        return f'firmware{ext}'
    return secure_filename(os.path.basename(str(path or ''))) or 'firmware'


def _klipper_commit(klipper_path):
    result = run_cmd(f'cd {shlex.quote(klipper_path)} && git rev-parse --short HEAD 2>/dev/null',
                     shell=True, capture_output=True, text=True, timeout=5)
    if result.returncode == 0:
        return (result.stdout or '').strip()
    return ''


def _application_address(platform_key, bl_offset):
    offset = _offset_int(bl_offset)
    if offset is None:
        offset = 0
    if platform_key == 'stm32':
        return f'0x{0x08000000 + offset:08x}'
    if platform_key == 'rp2040':
        return f'0x{0x10000000 + offset:08x}'
    if offset:
        return f'0x{offset:x}'
    return ''


def _offset_int(value):
    raw = str(value or '').strip()
    if not raw:
        return None
    raw_lower = raw.lower()
    if raw_lower in ('nobl', 'no_bl', 'no bootloader', 'no_bootloader', 'none'):
        return 0
    if 'no bootloader' in raw_lower or 'nobl' in raw_lower:
        return 0
    try:
        return int(raw, 0)
    except ValueError:
        pass
    kib_match = re.search(r'(\d+)\s*kib', raw_lower)
    if kib_match:
        return int(kib_match.group(1)) * 1024
    symbol_match = re.search(r'FLASH_START_([0-9A-Fa-f]+)$', raw)
    if symbol_match:
        try:
            return int(symbol_match.group(1), 16)
        except ValueError:
            return None
    return None


def _manifest_bl_offset(manifest):
    return ((manifest or {}).get('build') or {}).get('bl_offset', '')


def _manifest_has_known_bl_offset(manifest):
    return _offset_int(_manifest_bl_offset(manifest)) is not None


def _is_nobl_build(manifest):
    offset = _offset_int(_manifest_bl_offset(manifest))
    return offset == 0


def _write_manifest(klipper_path, manifest):
    manifest_path = _manifest_path(klipper_path)
    content = json.dumps(manifest, ensure_ascii=False, indent=2) + '\n'
    if is_ssh_mode():
        run_cmd(f'mkdir -p {shlex.quote(os.path.dirname(manifest_path))}', shell=True, capture_output=True)
        sudo_write_file(manifest_path, content)
    else:
        os.makedirs(os.path.dirname(manifest_path), exist_ok=True)
        with open(manifest_path, 'w', encoding='utf-8') as f:
            f.write(content)
    return manifest_path


def _load_manifest(klipper_path):
    manifest_path = _manifest_path(klipper_path)
    content = _read_text_file(manifest_path)
    if not content.strip():
        return None
    try:
        manifest = json.loads(content)
        manifest['_manifest_path'] = manifest_path
        return manifest
    except json.JSONDecodeError:
        return None


def _manifest_matches_firmware(manifest, firmware_path):
    """验证 manifest 是否确实描述当前待烧录文件。"""
    if not manifest:
        return False, '未找到固件 manifest'
    firmware = manifest.get('firmware') or {}
    expected_path = firmware.get('path', '')
    if not firmware_path or not expected_path:
        return False, 'manifest 缺少固件路径'
    actual_path = expand_klipper_path(firmware_path)
    manifest_path = expand_klipper_path(expected_path)
    if _normalize_fs_path(actual_path) != _normalize_fs_path(manifest_path):
        return False, '当前固件路径与 manifest 不一致'
    if not path_exists(actual_path):
        return False, '当前固件文件不存在'
    expected_size = firmware.get('size')
    if expected_size not in (None, ''):
        try:
            if int(expected_size) != int(get_file_size(actual_path)):
                return False, '当前固件大小与 manifest 不一致'
        except (TypeError, ValueError):
            return False, 'manifest 固件大小无效'
    expected_sha = str(firmware.get('sha256') or '').strip().lower()
    if expected_sha:
        actual_sha = _file_sha256(actual_path).lower()
        if not actual_sha or actual_sha != expected_sha:
            return False, '当前固件校验值与 manifest 不一致'
    return True, ''


def _create_manifest(klipper_path, firmware_path, firmware_size, mcu_info, request_data,
                     config_data, compile_values):
    platform_key = mcu_info.get('platform_key') or ''
    board = {}
    if config_data:
        board = {
            'manufacturer': config_data.get('manufacturer', ''),
            'board_type': config_data.get('board_type') or config_data.get('type', ''),
            'id': config_data.get('id', ''),
            'name': config_data.get('name', ''),
            'default_flash': config_data.get('default_flash', ''),
            'flash_modes': config_data.get('flash_modes', []),
        }
    bl_offset = compile_values.get('bl_offset', '')
    manifest = {
        'schema': 1,
        'created_at': time.strftime('%Y-%m-%dT%H:%M:%S%z'),
        'board': board,
        'mcu': {
            'platform': mcu_info.get('platform', ''),
            'platform_key': platform_key,
            'id': (mcu_info.get('mcu') or {}).get('id', ''),
            'config_symbol': (mcu_info.get('mcu') or {}).get('config_symbol', ''),
        },
        'build': {
            'klipper_path': klipper_path,
            'klipper_commit': _klipper_commit(klipper_path),
            'crystal': compile_values.get('crystal', ''),
            'bl_offset': bl_offset,
            'flash_application_address': _application_address(platform_key, bl_offset),
            'communication': compile_values.get('communication', ''),
            'comm_type': compile_values.get('comm_type', ''),
            'comm_config_symbol': compile_values.get('comm_config_symbol', ''),
            'canbus_frequency': compile_values.get('canbus_frequency', ''),
            'bridge_can_config': compile_values.get('bridge_can_config', ''),
        },
        'firmware': {
            'path': firmware_path,
            'name': os.path.basename(firmware_path),
            'size': firmware_size,
            'sha256': _file_sha256(firmware_path),
            'ext': os.path.splitext(firmware_path)[1].lower(),
        },
        'request': {
            'mode': 'preset' if config_data else 'custom',
            'klipper_path': request_data.get('klipper_path', ''),
        }
    }
    return manifest


def _recommended_flash_mode(manifest, firmware_path='', device_id=''):
    board = (manifest or {}).get('board', {})
    build = (manifest or {}).get('build', {})
    fw = (manifest or {}).get('firmware', {})
    ext = (fw.get('ext') or os.path.splitext(firmware_path or fw.get('path', ''))[1]).lower()
    device = str(device_id or '').lower()
    is_nobl = _is_nobl_build(manifest)
    has_known_offset = _manifest_has_known_bl_offset(manifest)

    if ext == '.uf2' or device == 'rp2040_boot':
        return 'UF2'
    if is_nobl:
        return 'DFU'
    if re.match(r'^(can\d+:)?[a-f0-9]{8,32}$', device):
        return 'CAN'
    default_flash = board.get('default_flash') or ''
    if default_flash and default_flash != 'DFU':
        return default_flash
    comm_type = build.get('comm_type') or ''
    if comm_type == 'can':
        return 'CAN'
    if comm_type == 'usbcanbridge':
        return 'KAT'
    if device.startswith('dfu:') and has_known_offset:
        return 'KAT'
    if default_flash == 'DFU' and not has_known_offset:
        return 'DFU'
    if has_known_offset:
        return 'KAT'
    return 'DFU'


def _flash_plan(manifest, firmware_path, flash_mode='', device_id='', can_iface='can0'):
    if not firmware_path and manifest:
        firmware_path = (manifest.get('firmware') or {}).get('path', '')
    manifest_valid, manifest_error = _manifest_matches_firmware(manifest, firmware_path)
    effective_manifest = manifest if manifest_valid else None
    recommended = _recommended_flash_mode(effective_manifest or {}, firmware_path, device_id)
    selected = flash_mode or recommended
    effective_selected = {'CAN_BRIDGE_DFU': 'DFU', 'CAN_BRIDGE_KAT': 'KAT'}.get(selected, selected)
    errors = []
    warnings = []
    ext = os.path.splitext(firmware_path or '')[1].lower()
    is_nobl = _is_nobl_build(effective_manifest)
    has_known_offset = _manifest_has_known_bl_offset(effective_manifest)
    bl_offset = _manifest_bl_offset(effective_manifest)

    if manifest and not manifest_valid:
        warnings.append(f'manifest 未用于本次预检：{manifest_error}')

    if not firmware_path:
        errors.append('未找到固件路径，请先编译或选择固件文件')
    elif not path_exists(expand_klipper_path(firmware_path)):
        errors.append(f'固件文件不存在: {firmware_path}')

    if effective_selected == 'UF2' and ext and ext != '.uf2':
        warnings.append('UF2 烧录通常需要 .uf2 固件文件')
    if effective_selected == 'DFU' and has_known_offset and not is_nobl:
        errors.append(f'DFU 仅用于 NOBL（无 Bootloader 偏移）固件，当前 BL 偏移为 {bl_offset}')
    elif effective_selected == 'DFU' and not has_known_offset:
        errors.append('无法确认当前固件是否为 NOBL；请先在本工具中重新编译，再使用 DFU 烧录')
    if effective_selected == 'DFU' and not device_id:
        errors.append('DFU 烧录需要先选择明确的 DFU 设备')
    elif effective_selected == 'DFU' and not str(device_id).startswith('dfu:'):
        errors.append('当前选择不是 DFU 设备，请重新扫描并选择')
    if effective_selected in ('KAT', 'CAN') and not device_id:
        errors.append('Katapult/CAN 烧录需要先选择设备 ID 或 CAN UUID')
    if effective_selected == 'KAT' and str(device_id).startswith(('dfu:', 'rp2040_boot')):
        errors.append('Katapult 烧录必须选择 CAN UUID 或 Katapult USB 串口设备')
    if effective_selected == 'CAN' and device_id and not re.match(r'^(can\d+:)?[a-fA-F0-9]{8,32}$', str(device_id)):
        errors.append('CAN 烧录必须选择有效的 CAN UUID 设备')
    if effective_selected == 'UF2' and device_id != 'rp2040_boot':
        errors.append('UF2 烧录需要先选择 RP2040/RP2350 BOOT 设备')
    if effective_selected == 'TF' and ext != '.bin':
        errors.append('TF 卡烧录仅支持 .bin 固件，不能将其他格式重命名为 firmware.bin')

    dfu_address = ''
    if effective_manifest:
        dfu_address = (effective_manifest.get('build') or {}).get('flash_application_address', '')

    return {
        'recommended_mode': recommended,
        'selected_mode': selected,
        'effective_selected_mode': effective_selected,
        'firmware_path': firmware_path,
        'dfu_address': dfu_address,
        'bl_offset': bl_offset,
        'is_nobl': is_nobl,
        'manifest_valid': manifest_valid,
        'manifest_error': manifest_error,
        'can_iface': can_iface,
        'errors': errors,
        'warnings': warnings,
        'ok': not errors,
    }


def _norm_match_text(value):
    return re.sub(r'[^a-z0-9]+', '', str(value or '').lower())


def _bl_category_for_board_type(board_type):
    board_type = str(board_type or '').lower()
    if board_type == 'mainboard':
        return 'MainBoard'
    if board_type == 'toolboard':
        return 'ToolBoard'
    if board_type in ('extensionboard', 'extension'):
        return 'ExtensionBoard'
    return ''


def _decorate_bl_firmware(fw, manufacturer, board_type='', board_id='', board_name=''):
    path = fw.get('path', '')
    rel_path = os.path.relpath(path, os.path.join(BOARD_CONFIGS_DIR, manufacturer, 'BL'))
    ext = os.path.splitext(path)[1].lower()
    recommended_tool = 'rp2040_flash' if ext == '.uf2' else 'openocd' if ext == '.hex' else 'dfu-util'
    category = rel_path.split(os.sep, 1)[0] if os.sep in rel_path else ''
    match_text = _norm_match_text(rel_path + ' ' + fw.get('name', ''))
    tokens = [_norm_match_text(board_id), _norm_match_text(board_name)]
    for raw in (board_id, board_name):
        for part in re.split(r'[^A-Za-z0-9]+', str(raw or '')):
            part_norm = _norm_match_text(part)
            if len(part_norm) >= 2 and part_norm not in ('fly', 'board', 'main', 'tool'):
                tokens.append(part_norm)
    score = 0
    for token in set(tokens):
        if token and token in match_text:
            score += 10 if token == _norm_match_text(board_id) else 5
    expected_category = _bl_category_for_board_type(board_type)
    if expected_category and category.lower() == expected_category.lower():
        score += 3
    decorated = dict(fw)
    decorated.update({
        'manufacturer': manufacturer,
        'relative_path': rel_path,
        'category': category,
        'ext': ext,
        'recommended_tool': recommended_tool,
        'default_address': '0x8000000',
        'match_score': score,
    })
    try:
        decorated['size'] = os.path.getsize(path)
    except OSError:
        decorated['size'] = 0
    return decorated


def _format_bl_offset_label(offset, display='', mcu_id=''):
    offset_value = _offset_int(offset)
    display_text = str(display or '')
    if offset_value is None:
        return display_text or str(offset or '')
    if offset_value == 0 or (str(mcu_id).lower() == 'rp2040' and offset_value == 256):
        return 'NO BL'
    if offset_value < 1024:
        return f'{offset_value} bytes'
    kib = offset_value / 1024
    if kib.is_integer():
        return f'{int(kib)} KB'
    return f'{kib:.1f} KB'


def _bl_address_options_from_mcu_info(mcu_info):
    mcu = (mcu_info or {}).get('mcu') or {}
    mcu_id = str(mcu.get('id') or '').lower()
    platform_key = (mcu_info or {}).get('platform_key') or ''
    raw_options = mcu.get('bl_offset_options') or [
        {'offset': offset, 'display': ''} for offset in mcu.get('bl_offsets', [])
    ]
    seen = set()
    options = []
    for option in raw_options:
        offset = str(option.get('offset', '')).strip()
        offset_value = _offset_int(offset)
        if offset_value is None or offset_value in seen:
            continue
        seen.add(offset_value)
        options.append({
            'offset': offset,
            'offset_bytes': offset_value,
            'label': _format_bl_offset_label(offset, option.get('display', ''), mcu_id),
            'kconfig_display': option.get('display', ''),
            'config_symbol': option.get('config_symbol', ''),
            'address': _application_address(platform_key, offset),
            'recommended_for_bl': offset_value == 0 or (mcu_id == 'rp2040' and offset_value == 256),
        })

    options.sort(key=lambda x: x['offset_bytes'])
    if not options:
        options.append({
            'offset': '0',
            'offset_bytes': 0,
            'label': 'NO BL',
            'kconfig_display': '',
            'config_symbol': '',
            'address': _application_address(platform_key or 'stm32', '0'),
            'recommended_for_bl': True,
        })
    return options


def _valid_flash_address(address):
    return bool(re.match(r'^0x[0-9A-Fa-f]+$', str(address or '').strip()))


def _offset_candidates(value):
    raw = str(value or '').strip()
    candidates = {raw}
    if not raw:
        return candidates

    if raw.lower().startswith('0x'):
        try:
            candidates.add(str(int(raw, 16)))
        except ValueError:
            pass
    if raw.isdigit():
        candidates.add(str(int(raw)))

    kib_match = re.search(r'(\d+)\s*KiB', raw, re.IGNORECASE)
    if kib_match:
        candidates.add(str(int(kib_match.group(1)) * 1024))

    return candidates


def _resolve_option_by_value(options, value, value_key):
    symbol = _normalize_config_symbol(value)
    if symbol:
        for option in options:
            if _normalize_config_symbol(option.get('config_symbol')) == symbol:
                return option

    value_text = str(value or '').strip()
    candidates = _offset_candidates(value_text) if value_key == 'offset' else {value_text}
    for option in options:
        option_value = str(option.get(value_key, '')).strip()
        display = str(option.get('display', '')).strip()
        if option_value in candidates or display == value_text:
            return option
    return None


def _infer_comm_type(communication):
    text = str(communication or '').upper()
    if 'BRIDGE' in text or 'USB转CAN' in text or ('USB' in text and 'CAN' in text and '(ON' not in text):
        return 'usbcanbridge'
    if 'CAN' in text:
        return 'can'
    if 'USB' in text or 'USBSERIAL' in text:
        return 'usb'
    if 'SERIAL' in text or 'UART' in text:
        return 'serial'
    return ''


def _compatible_options(options, processor):
    processor = str(processor or '').upper()
    return [
        option for option in options
        if not option.get('compatible_processors') or processor in option.get('compatible_processors', [])
    ]


def _match_communication_option(options, communication, comm_type):
    communication = str(communication or '').strip()
    comm_type = comm_type or _infer_comm_type(communication)
    typed_options = [opt for opt in options if not comm_type or opt.get('comm_type') == comm_type]

    symbol = _normalize_config_symbol(communication)
    if symbol:
        for option in typed_options or options:
            if _normalize_config_symbol(option.get('config_symbol')) == symbol:
                return option

    for option in typed_options:
        if option.get('display') == communication:
            return option

    if communication:
        pin_match = re.search(r'P[A-K]\d+\/P[A-K]\d+', communication, re.IGNORECASE)
        for option in typed_options:
            display = option.get('display', '')
            if pin_match and pin_match.group(0).upper() in display.upper():
                return option
            if communication in display or display in communication:
                return option

    if comm_type == 'usb':
        for option in typed_options:
            if 'USB' in option.get('display', '').upper():
                return option
    if comm_type and len(typed_options) == 1:
        return typed_options[0]

    return None


def _resolve_bridge_can_option(platform_data, processor, bridge_can_config):
    bridge_options = _compatible_options(platform_data.get('bridge_can', []), processor)
    if not bridge_options:
        bridge_options = platform_data.get('bridge_can', [])
    if not bridge_options:
        return None

    symbol = _normalize_config_symbol(bridge_can_config)
    if symbol:
        for option in bridge_options:
            if _normalize_config_symbol(option.get('config')) == symbol:
                return option

    text = str(bridge_can_config or '').strip()
    if text:
        for option in bridge_options:
            if option.get('display') == text or option.get('pins') == text:
                return option

    for option in bridge_options:
        if 'PB8/PB9' in option.get('display', ''):
            return option
    return bridge_options[0]


def _build_klipper_config_lines(
        kconfig_klipper_path, mcu_arch, processor, crystal, bootloader_offset,
        communication, comm_type, comm_config_symbol, bridge_can_config,
        rp2040_can_rx_gpio, rp2040_can_tx_gpio, canbus_frequency):
    """从当前 Klipper Kconfig 解析结果生成 .config 行。"""
    parser = KlipperKconfigParser(kconfig_klipper_path)
    parser.parse_all_platforms()
    mcu_info = parser.resolve_mcu_info(processor, mcu_arch)
    if not mcu_info:
        raise ValueError(f'当前 Klipper Kconfig 未找到 MCU: {processor}')

    mcu = mcu_info['mcu']
    platform_key = mcu_info.get('platform_key') or ''
    config_lines = ['CONFIG_LOW_LEVEL_OPTIONS=y']
    logs = []

    arch_line = _config_line(mcu_info.get('arch_config'))
    mcu_line = _config_line(mcu.get('config_symbol') or mcu.get('config_name'))
    if not arch_line or not mcu_line:
        raise ValueError(f'当前 Klipper Kconfig 中 MCU 符号不完整: {processor}')
    config_lines.extend([arch_line, mcu_line])

    crystal_options = mcu.get('crystal_options') or []
    if crystal_options and crystal:
        crystal_option = _resolve_option_by_value(crystal_options, crystal, 'value')
        if not crystal_option:
            raise ValueError(f'当前 Klipper Kconfig 中 {processor} 不支持晶振: {crystal}')
        crystal_line = _config_line(crystal_option.get('config_symbol'))
        if crystal_line:
            config_lines.append(crystal_line)

    bl_options = mcu.get('bl_offset_options') or []
    if bl_options and bootloader_offset is not None:
        bl_option = _resolve_option_by_value(bl_options, bootloader_offset, 'offset')
        if not bl_option:
            raise ValueError(f'当前 Klipper Kconfig 中 {processor} 不支持 BL 偏移: {bootloader_offset}')
        config_lines.append(_config_line(bl_option.get('config_symbol')))

    comm_data = parse_can_options(kconfig_klipper_path)
    platform_data = comm_data.get(platform_key, {})
    processor_upper = str(processor or '').upper()
    comm_options = _compatible_options(platform_data.get('communication_options', []), processor_upper)
    if not comm_options:
        comm_options = platform_data.get('communication_options', [])

    comm_symbol = _normalize_config_symbol(comm_config_symbol)
    comm_option = None
    if comm_symbol:
        for option in comm_options:
            if _normalize_config_symbol(option.get('config_symbol')) == comm_symbol:
                comm_option = option
                break
        if not comm_option:
            raise ValueError(f'当前 Klipper Kconfig 中 {processor} 不支持通信选项: {comm_config_symbol}')
    else:
        comm_option = _match_communication_option(comm_options, communication, comm_type)
        if comm_option:
            comm_symbol = _normalize_config_symbol(comm_option.get('config_symbol'))

    if not comm_symbol:
        raise ValueError(f'当前 Klipper Kconfig 中无法匹配通信方式: {communication or comm_type}')

    config_lines.append(_config_line(comm_symbol))
    resolved_comm_type = comm_type or (comm_option or {}).get('comm_type') or _infer_comm_type(communication)

    if resolved_comm_type in ('can', 'usbcanbridge'):
        resolved_canbus_frequency = _normalize_canbus_frequency(canbus_frequency)
        config_lines.append(f'CONFIG_CANBUS_FREQUENCY={resolved_canbus_frequency}')
        logs.append(f"CAN速率: {resolved_canbus_frequency}")

    if resolved_comm_type == 'usbcanbridge':
        bridge_option = _resolve_bridge_can_option(platform_data, processor_upper, bridge_can_config)
        if bridge_option:
            config_lines.append(_config_line(bridge_option.get('config')))
            logs.append(f"USB-CAN桥接CAN引脚: {bridge_option.get('display')}")

    if platform_key == 'rp2040' and resolved_comm_type in ('can', 'usbcanbridge'):
        rp2040_can_rx_gpio = _normalize_rp2040_gpio(rp2040_can_rx_gpio, 'RP2040 CAN RX GPIO')
        rp2040_can_tx_gpio = _normalize_rp2040_gpio(rp2040_can_tx_gpio, 'RP2040 CAN TX GPIO')
        if rp2040_can_rx_gpio == rp2040_can_tx_gpio:
            raise ValueError('RP2040 CAN RX 与 TX 不能使用同一个 GPIO')
        config_lines.append(f'CONFIG_RPXXXX_CANBUS_GPIO_RX={rp2040_can_rx_gpio}')
        config_lines.append(f'CONFIG_RPXXXX_CANBUS_GPIO_TX={rp2040_can_tx_gpio}')

    logs.append(f"平台符号: {arch_line}")
    logs.append(f"MCU符号: {mcu_line}")
    logs.append(f"通信符号: CONFIG_{comm_symbol}=y")
    return config_lines, logs, mcu_info


# ==================== 主板配置 API ====================
@firmware_bp.route('/api/firmware/boards')
def get_boards():
    """获取所有主板配置"""
    try:
        boards = load_all_boards()
        manufacturers = get_manufacturers()
        return jsonify({'boards': boards, 'manufacturers': manufacturers})
    except Exception as e:
        return jsonify({'error': safe_error(e)}), 500


@firmware_bp.route('/api/firmware/manufacturers')
def get_manufacturers_list():
    """获取厂家列表"""
    try:
        manufacturers = get_manufacturers()
        return jsonify({'manufacturers': manufacturers})
    except Exception as e:
        return jsonify({'error': safe_error(e)}), 500


@firmware_bp.route('/api/firmware/bl-firmwares')
def get_all_bl_firmwares():
    """获取所有厂家的BL固件列表"""
    try:
        manufacturer_filter = request.args.get('manufacturer', '')
        board_type = request.args.get('board_type', '')
        board_id = request.args.get('board_id', '')
        board_name = request.args.get('board_name', '')
        all_firmwares = []
        if os.path.exists(BOARD_CONFIGS_DIR):
            for manufacturer in os.listdir(BOARD_CONFIGS_DIR):
                if manufacturer_filter and manufacturer != manufacturer_filter:
                    continue
                mfr_dir = os.path.join(BOARD_CONFIGS_DIR, manufacturer)
                if os.path.isdir(mfr_dir):
                    try:
                        firmwares = get_bl_firmwares(manufacturer)
                        for fw in firmwares:
                            decorated = _decorate_bl_firmware(
                                fw, manufacturer, board_type, board_id, board_name
                            )
                            expected_category = _bl_category_for_board_type(board_type)
                            if expected_category and decorated['category'].lower() != expected_category.lower():
                                continue
                            all_firmwares.append(decorated)
                    except Exception:
                        pass
        uploaded_firmwares = []
        if os.path.isdir(BL_UPLOAD_DIR):
            for name in sorted(os.listdir(BL_UPLOAD_DIR)):
                path = os.path.join(BL_UPLOAD_DIR, name)
                ext = os.path.splitext(name)[1].lower()
                if not os.path.isfile(path) or ext not in ('.bin', '.uf2'):
                    continue
                uploaded_firmwares.append({
                    'path': path,
                    'name': name,
                    'relative_path': f'已上传/{name}',
                    'manufacturer': '',
                    'category': 'Uploaded',
                    'ext': ext,
                    'recommended_tool': 'rp2040_flash' if ext == '.uf2' else 'dfu-util',
                    'default_address': '0x08000000',
                    'match_score': 0,
                    'size': os.path.getsize(path),
                    'uploaded': True,
                })
        matched = [fw for fw in all_firmwares if fw.get('match_score', 0) > 0]
        all_firmwares.extend(uploaded_firmwares)
        files = (matched + uploaded_firmwares) if (board_id or board_name) and matched else all_firmwares
        files.sort(key=lambda x: (-x.get('match_score', 0), x.get('relative_path', x.get('name', '')).lower()))
        return jsonify({
            'files': files,
            'filtered': bool(matched),
            'query': {
                'manufacturer': manufacturer_filter,
                'board_type': board_type,
                'board_id': board_id,
                'board_name': board_name,
            }
        })
    except Exception as e:
        return jsonify({'error': safe_error(e)}), 500


@firmware_bp.route('/api/firmware/bl/upload', methods=['POST'])
def upload_bl_firmware():
    """上传临时 BL 固件；文件仅保存在受限的应用数据目录。"""
    uploaded = request.files.get('file')
    if not uploaded or not uploaded.filename:
        return jsonify({'success': False, 'error': '未选择 BL 文件'}), 400
    original_name = secure_filename(uploaded.filename)
    if not original_name:
        return jsonify({'success': False, 'error': 'BL 文件名无效'}), 400
    ext = os.path.splitext(original_name)[1].lower()
    if ext not in ('.bin', '.uf2'):
        return jsonify({'success': False, 'error': '仅支持 .bin 或 .uf2 BL 文件'}), 400
    content = uploaded.stream.read(BL_UPLOAD_MAX_BYTES + 1)
    if not content:
        return jsonify({'success': False, 'error': 'BL 文件不能为空'}), 400
    if len(content) > BL_UPLOAD_MAX_BYTES:
        return jsonify({'success': False, 'error': 'BL 文件不能超过 4 MB'}), 413

    os.makedirs(BL_UPLOAD_DIR, exist_ok=True)
    digest = hashlib.sha256(content).hexdigest()[:12]
    stem = secure_filename(os.path.splitext(original_name)[0]) or 'bootloader'
    stored_name = f'{stem}-{digest}{ext}'
    stored_path = os.path.join(BL_UPLOAD_DIR, stored_name)
    with open(stored_path, 'wb') as output:
        output.write(content)
    return jsonify({
        'success': True,
        'file': {
            'path': stored_path,
            'name': original_name,
            'stored_name': stored_name,
            'relative_path': f'已上传/{original_name}',
            'ext': ext,
            'size': len(content),
            'uploaded': True,
            'recommended_tool': 'rp2040_flash' if ext == '.uf2' else 'dfu-util',
        }
    })

@firmware_bp.route('/api/firmware/bl-firmwares/<manufacturer>')
@firmware_bp.route('/api/firmware/bl-firmwares/<manufacturer>/<board_type>')
def get_bl_firmwares_list(manufacturer, board_type=None):
    """获取指定厂家的BL固件列表，可按主板类型过滤"""
    try:
        firmwares = get_bl_firmwares(manufacturer, board_type)
        return jsonify({'firmwares': firmwares})
    except Exception as e:
        return jsonify({'error': safe_error(e)}), 500

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
        return jsonify({'error': safe_error(e)}), 500

@firmware_bp.route('/api/firmware/rules')
def get_all_rules():
    """获取所有处理器的固件编译规则"""
    try:
        rules = load_klipper_rules()
        return jsonify(rules)
    except Exception as e:
        return jsonify({'error': safe_error(e)}), 500


@firmware_bp.route('/api/firmware/current-config')
def get_current_firmware_config():
    """读取 Klipper .config 并解析为页面可回填的编译参数。"""
    try:
        raw_klipper_path = request.args.get('klipper_path') or config.get('klipper_path', '~/klipper')
        klipper_path = expand_klipper_path(raw_klipper_path)
        kconfig_klipper_path = expand_klipper_path(raw_klipper_path, force_local=True)
        config_path = os.path.join(klipper_path, '.config')
        content = _read_text_file(config_path)
        if not content.strip():
            return jsonify({
                'success': False,
                'error': f'未找到 Klipper .config: {config_path}'
            }), 404

        config_values, raw_config = _parse_klipper_config(content)
        params, warnings = _resolve_current_config_params(kconfig_klipper_path, config_values)
        return jsonify({
            'success': True,
            'klipper_path': klipper_path,
            'config_path': config_path,
            'params': params,
            'config': raw_config,
            'warnings': warnings,
        })
    except Exception as e:
        logger.exception('读取当前 Klipper 编译参数失败')
        return jsonify({'success': False, 'error': safe_error(e)}), 500

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
        return jsonify({'error': safe_error(e)}), 500


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
    req_data = request.get_json(silent=True) or {}  # 在请求上下文中提前捕获
    def _compile_stream():
     if not _compile_lock.acquire(blocking=False):
        yield f'data: {json.dumps({"error": "已有固件编译任务正在执行，请稍后再试"})}\n\n'
        return
     try:
        data = req_data
        verbose_config_logs = _truthy(data.get('verbose_config_logs'))

        raw_klipper_path = data.get('klipper_path', config.get('klipper_path', '~/klipper'))
        klipper_path = expand_klipper_path(raw_klipper_path)
        kconfig_klipper_path = expand_klipper_path(raw_klipper_path, force_local=True)

        config_data = data.get('config')
        board_config_data = data.get('board_config') if isinstance(data.get('board_config'), dict) else None
        if config_data:
            mcu_arch = config_data.get('platform', config_data.get('平台', 'STM32'))
            processor = config_data.get('mcu', config_data.get('处理器', 'STM32F072')).upper()
            bootloader_offset = config_data.get('bl_offset', config_data.get('BL 偏移', '0'))
            communication = config_data.get('default_connection', config_data.get('默认连接', 'USB'))
            startup_pin = config_data.get('boot_pins', config_data.get('启动引脚', ''))
            crystal = config_data.get('crystal', config_data.get('晶振', '8000000'))
            rp2040_can_rx_gpio = str(config_data.get('can_gpio', {}).get('rx', '4'))
            rp2040_can_tx_gpio = str(config_data.get('can_gpio', {}).get('tx', '5'))
            canbus_frequency = config_data.get('canbus_frequency', config_data.get('can_bitrate', DEFAULT_CANBUS_FREQUENCY))
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
            startup_pin = data.get('startup_pin', '')
            crystal = data.get('crystal', '8000000')
            rp2040_can_rx_gpio = data.get('rp2040_can_rx_gpio', '4')
            rp2040_can_tx_gpio = data.get('rp2040_can_tx_gpio', '5')
            canbus_frequency = data.get('canbus_frequency', DEFAULT_CANBUS_FREQUENCY)

            if not str(comm_type or '').strip():
                yield f'data: {json.dumps({"error": "请选择通信方式"})}\n\n'
                return

        if not path_exists(klipper_path):
            yield f'data: {json.dumps({"error": f"Klipper目录不存在: {klipper_path}"})}\n\n'
            return
        if not _is_safe_klipper_tree(klipper_path):
            yield f'data: {json.dumps({"error": f"Klipper目录不合法或不完整，已停止清理和编译: {klipper_path}"})}\n\n'
            return

        try:
            config_lines, config_logs, mcu_info = _build_klipper_config_lines(
                kconfig_klipper_path, mcu_arch, processor, crystal, bootloader_offset,
                communication, comm_type, comm_config_symbol, bridge_can_config,
                rp2040_can_rx_gpio, rp2040_can_tx_gpio, canbus_frequency
            )
        except ValueError as e:
            yield f'data: {json.dumps({"error": safe_error(e)})}\n\n'
            return
        if verbose_config_logs:
            for log_line in config_logs:
                yield f'data: [LOG] {log_line}\n\n'

        if startup_pin:
            startup_pin = _kconfig_string(startup_pin)
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
            if verbose_config_logs:
                yield f'data: [LOG] 启动引脚已配置: {startup_pin}\n\n'
        else:
            # 始终设置 CONFIG_INITIAL_PINS（空值），否则 STM32H723 等使用 DECL_STARTUP_PIN_STATE 的 MCU 编译会失败
            config_lines.append('CONFIG_INITIAL_PINS=""')
            if verbose_config_logs:
                yield f'data: [LOG] 未设置启动引脚（使用空值）\n\n'

        run_cmd(f'cd {shlex.quote(klipper_path)} && rm -rf .config out', shell=True, capture_output=True)

        config_content = '\n'.join(config_lines) + '\n'
        config_path = os.path.join(klipper_path, '.config')
        if is_ssh_mode():
            sudo_write_file(config_path, config_content)
        else:
            with open(config_path, 'w', encoding='utf-8') as f:
                f.write(config_content)

        if verbose_config_logs:
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
            except Exception:
                pass

        if verbose_config_logs:
            yield 'data: [LOG] 生成配置中...\n\n'
        for line in run_cmd_stream(f'cd {shlex.quote(klipper_path)} && make olddefconfig', shell=True, timeout=60):
            if line.startswith('[DONE]'):
                pass
            elif line.startswith('[ERROR]'):
                yield f'data: {json.dumps({"error": "配置生成失败", "detail": line})}\n\n'
                return
            else:
                yield f'data: [LOG] {line}\n\n'

        yield 'data: [LOG] 开始编译...\n\n'
        compile_ok = False
        for line in run_cmd_stream(f'cd {shlex.quote(klipper_path)} && make -j4', shell=True, timeout=300):
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
        firmware_files = ['klipper.bin', 'klipper.uf2', 'klipper.elf']
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
                    run_cmd(f'chmod 664 {shlex.quote(firmware_path)}', shell=True, capture_output=True, timeout=5)
                    run_cmd(f'chmod 755 {shlex.quote(out_dir)}', shell=True, capture_output=True, timeout=5)
                    if owner_name:
                        run_cmd(f'chown {shlex.quote(owner_name)} {shlex.quote(firmware_path)} {shlex.quote(out_dir)}', shell=True, capture_output=True, timeout=5)
                        run_cmd(f'chown -R {shlex.quote(owner_name)} {shlex.quote(out_dir)}', shell=True, capture_output=True, timeout=5)
                        config_file = os.path.join(klipper_path, '.config')
                        run_cmd(f'chown {shlex.quote(owner_name)} {shlex.quote(config_file)}', shell=True, capture_output=True, timeout=5)
                else:
                    import pwd as _pwd, grp as _grp
                    os.chmod(firmware_path, 0o664)
                    os.chmod(out_dir, 0o755)
                    try:
                        klipper_stat = os.stat(klipper_path)
                        owner_name = _pwd.getpwuid(klipper_stat.st_uid).pw_name
                        group_name = _grp.getgrgid(klipper_stat.st_gid).gr_name
                    except (KeyError, OSError):
                        owner_name = None
                        group_name = None
                    if owner_name and group_name:
                        shutil.chown(firmware_path, user=owner_name, group=group_name)
                        shutil.chown(out_dir, user=owner_name, group=group_name)
                        for root_dir, dirs, files in os.walk(out_dir):
                            for d in dirs:
                                shutil.chown(os.path.join(root_dir, d), user=owner_name, group=group_name)
                            for f in files:
                                shutil.chown(os.path.join(root_dir, f), user=owner_name, group=group_name)
                        config_file = os.path.join(klipper_path, '.config')
                        if os.path.exists(config_file):
                            shutil.chown(config_file, user=owner_name, group=group_name)
            except Exception as e:
                logger.warning(f"修改文件权限失败: {e}")

            firmware_size = get_file_size(firmware_path)
            if firmware_size < 1024:
                size_str = f'{firmware_size} bytes'
            elif firmware_size < 1024 * 1024:
                size_str = f'{firmware_size / 1024:.1f} KB'
            else:
                size_str = f'{firmware_size / (1024 * 1024):.2f} MB'

            compile_values = {
                'crystal': crystal,
                'bl_offset': bootloader_offset,
                'communication': communication,
                'comm_type': comm_type or _infer_comm_type(communication),
                'comm_config_symbol': comm_config_symbol,
                'canbus_frequency': _normalize_canbus_frequency(canbus_frequency),
                'bridge_can_config': bridge_can_config,
            }
            manifest = _create_manifest(
                klipper_path, firmware_path, firmware_size, mcu_info,
                data, config_data or board_config_data, compile_values
            )
            manifest_path = _write_manifest(klipper_path, manifest)

            yield f'data: {json.dumps({"success": True, "message": "编译成功", "firmware_path": firmware_path, "firmware_size": size_str, "firmware_size_bytes": firmware_size, "manifest_path": manifest_path, "manifest": manifest})}\n\n'
            try:
                from shared import ws_broadcast
                ws_broadcast('compile_complete', {'firmware_path': firmware_path, 'size': size_str})
                from routes_notifications import push_notification
                push_notification('compile_complete', '编译完成', f'固件: {size_str}', 'success')
                from routes_firmware_history import record_compile
                record_compile(manifest, firmware_path)
            except Exception:
                pass
            return
        else:
            yield f'data: {json.dumps({"success": False, "error": "编译失败：未找到固件文件"})}\n\n'
            return

     except subprocess.TimeoutExpired:
            yield f'data: {json.dumps({"error": "编译超时"})}\n\n'
     except Exception as e:
            yield f'data: {json.dumps({"error": safe_error(e)})}\n\n'
     finally:
            _compile_lock.release()
    return Response(_compile_stream(), mimetype='text/event-stream',
                    headers={'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no'})

# ==================== 固件下载 API ====================
@firmware_bp.route('/api/firmware/manifest')
def get_firmware_manifest():
    """读取最近一次编译生成的固件 manifest"""
    try:
        klipper_path = expand_klipper_path(config.get('klipper_path', '~/klipper'))
        manifest = _load_manifest(klipper_path)
        if not manifest:
            return jsonify({'success': False, 'error': '未找到固件 manifest'}), 404
        return jsonify({'success': True, 'manifest': manifest})
    except Exception as e:
        return jsonify({'success': False, 'error': safe_error(e)}), 500


@firmware_bp.route('/api/firmware/flash/plan', methods=['POST'])
def get_firmware_flash_plan():
    """根据 manifest、设备和用户选择生成烧录推荐与预检结果"""
    try:
        data = request.get_json(silent=True) or {}
        klipper_path = expand_klipper_path(config.get('klipper_path', '~/klipper'))
        manifest = _load_manifest(klipper_path)
        firmware_path = data.get('firmware_path') or ((manifest or {}).get('firmware') or {}).get('path', '')
        flash_mode = data.get('flash_mode', '')
        device_id = data.get('device_id', '')
        can_iface = data.get('can_iface', 'can0')
        plan = _flash_plan(manifest, firmware_path, flash_mode, device_id, can_iface)
        return jsonify({'success': True, 'plan': plan, 'manifest': manifest})
    except Exception as e:
        return jsonify({'success': False, 'error': safe_error(e)}), 500


@firmware_bp.route('/api/firmware/download')
def download_firmware():
    """下载固件文件"""
    try:
        firmware_path = request.args.get('path', '')
        klipper_path = expand_klipper_path(config.get('klipper_path', '~/klipper'))

        if not firmware_path:
            firmware_path = os.path.join(klipper_path, 'out', 'klipper.bin')

        firmware_path = expand_klipper_path(firmware_path)

        if not _path_under(firmware_path, _allowed_firmware_roots(klipper_path)):
            return jsonify({'error': '非法路径'}), 403

        if not path_exists(firmware_path):
            return jsonify({'error': '固件文件不存在'}), 404

        local_firmware_path = download_firmware_from_remote(firmware_path)
        return send_file(local_firmware_path, as_attachment=True, download_name=_firmware_download_name(firmware_path))
    except Exception as e:
        return jsonify({'error': safe_error(e)}), 500

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
                path_match = re.search(r'path="([^"]+)"', line)
                usb_path = path_match.group(1) if path_match else ''
                dedup_key = f'{vid_pid}:{devnum}'
                if dedup_key in seen_dfu:
                    continue
                seen_dfu.add(dedup_key)
                chip_name = DFU_KNOWN_DEVICES.get(vid_pid, '')
                display_parts = [f'{chip_name} DFU' if chip_name else f'DFU ({vid_pid})']
                if serial:
                    display_parts.append(f'SN:{serial}')
                devices.append({'id': _dfu_device_id(vid_pid, serial, usb_path), 'name': ' '.join(display_parts), 'type': 'dfu', 'vid_pid': vid_pid, 'serial': serial, 'devnum': devnum, 'usb_path': usb_path})
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
            except Exception:
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
                        path_match = re.search(r'path="([^"]+)"', line)
                        usb_path = path_match.group(1) if path_match else ''
                        dedup_key = f'{vid_pid}:{devnum}'
                        if dedup_key in seen_dfu:
                            continue
                        seen_dfu.add(dedup_key)
                        chip_name = DFU_KNOWN_DEVICES.get(vid_pid, '')
                        display_parts = [f'{chip_name} DFU' if chip_name else f'DFU ({vid_pid})']
                        if serial:
                            display_parts.append(f'SN:{serial}')
                        devices.append({'id': _dfu_device_id(vid_pid, serial, usb_path), 'name': ' '.join(display_parts), 'type': 'dfu', 'vid_pid': vid_pid, 'serial': serial, 'devnum': devnum, 'usb_path': usb_path})
                        found_dfu = True
                if not found_dfu:
                    for vidpid, chip_name in DFU_KNOWN_DEVICES.items():
                        lsusb_result = run_cmd(f'lsusb | grep -i "{vidpid}" || echo ""', shell=True, capture_output=True, text=True)
                        if lsusb_result.stdout and vidpid in lsusb_result.stdout:
                            devices.append({'id': f'dfu:{vidpid}', 'name': f'DFU Device ({chip_name} {vidpid})', 'type': 'dfu', 'vid_pid': vidpid, 'serial': '', 'devnum': ''})
                            found_dfu = True
            except Exception:
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
            except Exception:
                pass

        return jsonify({'devices': _annotate_devices(devices)})
    except Exception as e:
        return jsonify({'error': safe_error(e)}), 500

# ==================== CAN设备搜索 API ====================
@firmware_bp.route('/api/firmware/can/scan')
def scan_can_devices():
    """扫描CAN设备 - 使用统一扫描函数（支持 ?iface=can1 参数）"""
    iface = request.args.get('iface', 'can0')
    if not _is_valid_can_iface(iface):
        return jsonify({'error': f'无效的CAN接口: {iface}'}), 400
    devices, error = _scan_can_uuids(iface)
    return jsonify({'devices': devices, 'error': error})

# ==================== 固件烧录 API ====================
@firmware_bp.route('/api/firmware/flash', methods=['POST'])
def flash_firmware():
    """烧录固件（SSE 流式输出）"""
    req_data = request.get_json(silent=True) or {}
    def _flash_stream():
     if not _flash_lock.acquire(blocking=False):
        yield f'data: {json.dumps({"error": "已有固件烧录任务正在执行，请稍后再试"})}\n\n'
        return
     try:
        data = req_data
        klipper_path = expand_klipper_path(config.get('klipper_path', '~/klipper'))
        device = data.get('device_id', data.get('device', ''))
        flash_mode = data.get('flash_mode', 'DFU')

        if config.get('backup', {}).get('auto_backup', False):
            try:
                from routes_backup import auto_backup_printer_cfg
                backup_id = auto_backup_printer_cfg()
                if backup_id:
                    yield f'data: {json.dumps({"log": f"[AUTO-BACKUP] 已自动备份 printer.cfg ({backup_id})"})}\n\n'
            except Exception as e:
                yield f'data: {json.dumps({"log": f"[AUTO-BACKUP] 自动备份失败: {e}"})}\n\n'
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
        if not _is_valid_can_iface(can_iface):
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

        manifest = _load_manifest(klipper_path)
        plan = _flash_plan(manifest, firmware_path, flash_mode, device, can_iface)
        if plan.get('dfu_address') and not data.get('dfu_address'):
            dfu_address = plan['dfu_address']
        if plan.get('errors') and not _truthy(data.get('skip_precheck')):
            yield f'data: {json.dumps({"error": "烧录前预检失败", "precheck": plan})}\n\n'
            return
        for warning in plan.get('warnings', []):
            yield f'data: [LOG] 预检提示: {warning}\n\n'

        if not path_exists(firmware_path):
            yield f'data: {json.dumps({"error": f"固件文件不存在: {firmware_path}"})}\n\n'
            return
        if not _path_under(firmware_path, _allowed_firmware_roots(klipper_path)):
            yield f'data: {json.dumps({"error": "固件路径不在允许目录内"})}\n\n'
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
                device_filter = _dfu_device_filter(device)
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
                    try:
                        from shared import ws_broadcast
                        ws_broadcast('flash_complete', {'message': '烧录成功'})
                        from routes_notifications import push_notification
                        push_notification('flash_complete', '烧录成功', '', 'success')
                    except Exception:
                        pass
                    return
                else:
                    yield f'data: {json.dumps({"success": False, "error": "烧录失败", "output": output})}\n\n'
                    try:
                        from shared import ws_broadcast
                        ws_broadcast('flash_failed', {'error': '烧录失败'})
                        from routes_notifications import push_notification
                        push_notification('flash_failed', '烧录失败', '', 'error')
                    except Exception:
                        pass
                    return

        if flash_mode in ('KAT', 'CAN'):
            klipper_owner, home_dir = get_klipper_owner()
            python_bin = get_klipper_python_bin(home_dir)
            flashtool_script = os.path.join(home_dir, 'katapult', 'scripts', 'flashtool.py')

            _is_can_uuid = bool(re.match(r'^[a-fA-F0-9]{8,32}$', re.sub(r'^can\d+:', '', device)))
            if re.match(r'^can\d+:', device) or _is_can_uuid:
                can_uuid = re.sub(r'^can\d+:', '', device)

                if is_fast_ssh_mode():
                    logger.info('FAST-SSH 模式：使用 CAN 直接烧录')
                    yield f'data: [LOG] 正在通过 CAN ({can_iface}) 烧录设备 {can_uuid}...\n\n'
                    fast_flashtool = os.path.join(home_dir, 'klipper', 'lib', 'katapult', 'flashtool.py')
                    fast_flash_can = os.path.join(home_dir, 'klipper', 'lib', 'canboot', 'flash_can.py')
                    if path_exists(fast_flashtool):
                        cmd = f'{shlex.quote(python_bin)} {shlex.quote(fast_flashtool)} -i {shlex.quote(can_iface)} -u {shlex.quote(can_uuid)} -f {shlex.quote(firmware_path)}'
                        logger.info(f'FAST-SSH 新版烧录命令 (katapult/flashtool.py, {can_iface}): {cmd}')
                    elif path_exists(fast_flash_can):
                        cmd = f'{shlex.quote(python_bin)} {shlex.quote(fast_flash_can)} -i {shlex.quote(can_iface)} -u {shlex.quote(can_uuid)} -f {shlex.quote(firmware_path)}'
                        logger.info(f'FAST-SSH 旧版烧录命令 (canboot/flash_can.py, {can_iface}): {cmd}')
                    else:
                        _err_msg = f"未找到烧录工具。请确认 Klipper 已安装。\n查找路径:\n  {fast_flashtool}\n  {fast_flash_can}"
                        yield f'data: {json.dumps({"error": _err_msg})}\n\n'
                        return
                    yield f'data: [LOG] 执行烧录命令: {os.path.basename(cmd.split()[1])}\n\n'
                    result = run_cmd(cmd, shell=True, capture_output=True, text=True, timeout=120)
                else:
                    before_result = run_cmd(
                        "ls /dev/serial/by-id/* 2>/dev/null",
                        shell=True, capture_output=True, text=True, timeout=5
                    )
                    devices_before_reset = {
                        line.strip() for line in (before_result.stdout or '').splitlines() if line.strip()
                    }
                    reset_cmd = f'{shlex.quote(python_bin)} {shlex.quote(flashtool_script)} -i {shlex.quote(can_iface)} -r -u {shlex.quote(can_uuid)}'
                    logger.info(f'CAN 重置命令：{reset_cmd}')
                    yield f'data: [LOG] 发送 CAN 复位命令到 {can_uuid}...\n\n'
                    run_cmd(reset_cmd, shell=True, capture_output=True, text=True, timeout=30)
                    logger.info('等待设备重新枚举...')
                    yield f'data: [LOG] 等待设备进入 Katapult 模式...\n\n'
                    katapult_device = None
                    for _ in range(20):
                        time.sleep(0.5)
                        find_result = run_cmd("ls /dev/serial/by-id/* 2>/dev/null", shell=True, capture_output=True, text=True, timeout=5)
                        if find_result.stdout.strip():
                            lines = [l.strip() for l in find_result.stdout.strip().split('\n') if l.strip()]
                            new_devices = [line for line in lines if line not in devices_before_reset]
                            if len(new_devices) == 1:
                                katapult_device = new_devices[0]
                                break
                            if len(new_devices) > 1:
                                yield f'data: {json.dumps({"error": "CAN 复位后出现多个新 USB 设备，无法安全确定目标，请拔除无关设备后重试", "devices": new_devices})}\n\n'
                                return
                        logger.info(f'轮询中... ({_+1}/20)')

                    if katapult_device:
                        new_device = katapult_device
                        logger.info(f'找到设备：{new_device}')
                        cmd = f'{shlex.quote(python_bin)} {shlex.quote(flashtool_script)} -d {shlex.quote(new_device)} -f {shlex.quote(firmware_path)}'
                        logger.info(f'USB 烧录命令：{cmd}')
                        result = run_cmd(cmd, shell=True, capture_output=True, text=True, timeout=60)
                    else:
                        logger.warning('未找到 USB 串口设备，尝试直接 CAN 烧录...')
                        flash_can_script = os.path.join(home_dir, 'klipper', 'lib', 'canboot', 'flash_can.py')
                        if path_exists(flash_can_script):
                            cmd = f'{shlex.quote(python_bin)} {shlex.quote(flash_can_script)} -i {shlex.quote(can_iface)} -u {shlex.quote(can_uuid)} -f {shlex.quote(firmware_path)}'
                            logger.info(f'CAN 烧录命令 ({can_iface}): {cmd}')
                            result = run_cmd(cmd, shell=True, capture_output=True, text=True, timeout=120)
                        else:
                            logger.warning(f'flash_can.py 不存在: {flash_can_script}，回退到 flashtool.py CAN 模式')
                            cmd = f'{shlex.quote(python_bin)} {shlex.quote(flashtool_script)} -i {shlex.quote(can_iface)} -u {shlex.quote(can_uuid)} -f {shlex.quote(firmware_path)}'
                            logger.info(f'flashtool CAN 烧录命令 ({can_iface}): {cmd}')
                            result = run_cmd(cmd, shell=True, capture_output=True, text=True, timeout=120)
            else:
                usb_device = katapult_serial if katapult_serial else device
                logger.info(f'USB 烧录命令：device={usb_device}')
                cmd = f'{shlex.quote(python_bin)} {shlex.quote(flashtool_script)} -d {shlex.quote(usb_device)} -f {shlex.quote(firmware_path)}'
                logger.info(f'USB 烧录命令：{cmd}')
                result = run_cmd(cmd, shell=True, capture_output=True, text=True, timeout=60)

            output = result.stdout + result.stderr
            returncode = result.returncode
            logger.info(f'烧录结果：returncode={returncode}, output={output[:200]}')

        elif flash_mode == 'UF2':
            rp2040_flash_tool = os.path.join(klipper_path, 'lib/rp2040_flash/rp2040_flash')
            if not path_exists(rp2040_flash_tool):
                yield f'data: {json.dumps({"error": "rp2040_flash工具不存在，请检查Klipper安装"})}\n\n'
                return
            _umount_rp2040_boot()
            cmd = f'sudo {shlex.quote(rp2040_flash_tool)} {shlex.quote(firmware_path)}'
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
            yield f'data: {json.dumps({"error": safe_error(e)})}\n\n'
     finally:
            _flash_lock.release()
    return Response(_flash_stream(), mimetype='text/event-stream',
                    headers={'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no'})

# ==================== HOST固件安装 API ====================
@firmware_bp.route('/api/firmware/install-host', methods=['POST'])
def install_host_firmware():
    """安装固件到主板 MCU（通过 HOST 设备烧录）（SSE 流式输出）"""
    req_data = request.get_json(silent=True) or {}
    def _install_stream():
     if not _flash_lock.acquire(blocking=False):
        yield f'data: {json.dumps({"error": "已有固件烧录任务正在执行，请稍后再试"})}\n\n'
        return
     try:
        data = req_data
        firmware_path = data.get('firmware_path', '')
        if not firmware_path:
            yield f'data: {json.dumps({"error": "固件路径不能为空"})}\n\n'
            return
        firmware_path = expand_klipper_path(firmware_path)
        klipper_path = expand_klipper_path(config.get('klipper_path', '~/klipper'))
        if not _path_under(firmware_path, _allowed_firmware_roots(klipper_path)):
            yield f'data: {json.dumps({"error": "固件路径不在允许目录内"})}\n\n'
            return
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

        target_path = os.path.join(klipper_path, 'out', 'klipper.bin')
        if is_ssh_mode():
            run_cmd(f'mkdir -p {shlex.quote(os.path.dirname(target_path))}', shell=True, capture_output=True)
            result = run_cmd(f'cp {shlex.quote(firmware_path)} {shlex.quote(target_path)}', shell=True, capture_output=True, text=True, timeout=10)
            if result.returncode != 0:
                yield f'data: {json.dumps({"error": f"复制失败: {result.stderr}"})}\n\n'
                return
        else:
            os.makedirs(os.path.dirname(target_path), exist_ok=True)
            shutil.copy2(firmware_path, target_path)

        yield f'data: {json.dumps({"success": True, "message": f"固件已复制到 {target_path}", "target_path": target_path, "method": "copy"})}\n\n'
        return

     except Exception as e:
            yield f'data: {json.dumps({"error": safe_error(e)})}\n\n'
     finally:
            _flash_lock.release()
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
        klipper_path = expand_klipper_path(config.get('klipper_path', '~/klipper'))
        firmware_dirs = _host_firmware_dirs(klipper_path)
        firmware_exts = ('.bin', '.elf', '.uf2', '.hex')
        existing_dirs = []
        firmware_files = []

        if is_ssh_mode():
            script = (
                "import json, os, sys\n"
                "dirs = json.loads(sys.argv[1])\n"
                "exts = tuple(json.loads(sys.argv[2]))\n"
                "payload = {'dirs': [], 'files': []}\n"
                "for base in dirs:\n"
                "    if not os.path.isdir(base):\n"
                "        continue\n"
                "    payload['dirs'].append(base)\n"
                "    try:\n"
                "        names = os.listdir(base)\n"
                "    except OSError:\n"
                "        continue\n"
                "    for name in names:\n"
                "        if name.startswith('.') or not name.lower().endswith(exts):\n"
                "            continue\n"
                "        full = os.path.join(base, name)\n"
                "        try:\n"
                "            if not os.path.isfile(full):\n"
                "                continue\n"
                "            payload['files'].append({'name': name, 'path': full, 'size': os.path.getsize(full)})\n"
                "        except OSError:\n"
                "            pass\n"
                "print(json.dumps(payload, ensure_ascii=False))\n"
            )
            cmd = (
                f'python3 -c {shlex.quote(script)} '
                f'{shlex.quote(json.dumps(firmware_dirs))} '
                f'{shlex.quote(json.dumps(firmware_exts))}'
            )
            result = run_cmd(cmd, shell=True, capture_output=True, text=True, timeout=10)
            if result.returncode == 0:
                payload = json.loads(result.stdout or '{}')
                existing_dirs = payload.get('dirs', [])
                firmware_files = payload.get('files', [])
        else:
            for firmware_dir in firmware_dirs:
                if not os.path.isdir(firmware_dir):
                    continue
                existing_dirs.append(firmware_dir)
                for name in os.listdir(firmware_dir):
                    if name.startswith('.') or not name.lower().endswith(firmware_exts):
                        continue
                    full_path = os.path.join(firmware_dir, name)
                    if os.path.isfile(full_path):
                        try:
                            size = os.path.getsize(full_path)
                        except Exception:
                            size = 0
                        firmware_files.append({'name': name, 'path': full_path, 'size': size})

        firmware_files.sort(key=lambda fw: (fw.get('name') or '').lower())

        for fw in firmware_files:
            m = re.match(r'^([a-z0-9]+)-(\d+)k-(\w+?)(?:-(\w+))?\.(?:bin|elf|uf2|hex)$', fw['name'], re.IGNORECASE)
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

        default_browser_dir = existing_dirs[0] if existing_dirs else firmware_dirs[0]

        return jsonify({
            'firmware_dir': default_browser_dir,
            'firmware_dirs': firmware_dirs,
            'existing_dirs': existing_dirs,
            'default_browser_dir': default_browser_dir,
            'firmware_files': firmware_files,
            'best_match': best_match,
            'best_score': best_score,
            'query': {'mcu': mcu_id, 'comm_type': comm_type, 'bl_offset': bl_offset}
        })
    except Exception as e:
        return jsonify({'error': safe_error(e)}), 500

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

        if not _path_under(path, _allowed_browse_roots()):
            return jsonify({'error': '非法路径'}), 403

        entries = []
        if is_ssh_mode():
            manager = SSHManager.get_instance()
            script = (
                "import json, os, sys\n"
                "base = sys.argv[1]\n"
                "items = []\n"
                "for name in os.listdir(base):\n"
                "    if name.startswith('.'):\n"
                "        continue\n"
                "    full = os.path.join(base, name)\n"
                "    try:\n"
                "        is_dir = os.path.isdir(full)\n"
                "        size = 0 if is_dir else os.path.getsize(full)\n"
                "        items.append({'name': name, 'is_dir': is_dir, 'size': size, 'path': full})\n"
                "    except OSError:\n"
                "        pass\n"
                "print(json.dumps(items, ensure_ascii=False))\n"
            )
            result = manager.exec_command(
                f'python3 -c {shlex.quote(script)} {shlex.quote(path)}',
                timeout=10
            )
            if result.returncode == 0 and result.stdout.strip():
                entries = json.loads(result.stdout)
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
        return jsonify({'error': safe_error(e)}), 500

# ==================== BL固件烧录 API ====================
@firmware_bp.route('/api/firmware/bl/address-options')
def get_bl_address_options():
    """根据当前 Klipper Kconfig 和 MCU 返回 BL 烧录地址选项"""
    try:
        mcu_id = (request.args.get('mcu') or '').strip()
        platform = (request.args.get('platform') or '').strip()
        manufacturer = (request.args.get('manufacturer') or '').strip()
        board_type = (request.args.get('board_type') or '').strip().lower()
        board_id = (request.args.get('board_id') or '').strip()
        board_config = None

        if manufacturer and board_type and board_id:
            board_config = load_board_config(manufacturer, board_type, board_id)
            if board_config:
                mcu_id = mcu_id or str(board_config.get('mcu') or '')
                platform = platform or str(board_config.get('platform') or '')

        if not mcu_id:
            return jsonify({'success': False, 'error': '缺少 MCU 型号，无法生成 BL 烧录地址选项'}), 400

        klipper_path = expand_klipper_path(config.get('klipper_path', '~/klipper'), force_local=True)
        parser = KlipperKconfigParser(klipper_path)
        parser.parse_all_platforms()
        mcu_info = parser.resolve_mcu_info(mcu_id, platform)
        if not mcu_info:
            return jsonify({'success': False, 'error': f'当前 Klipper Kconfig 未找到 MCU: {mcu_id}'}), 404

        options = _bl_address_options_from_mcu_info(mcu_info)
        default_option = next((opt for opt in options if opt.get('recommended_for_bl')), options[0])
        board_default_offset = str((board_config or {}).get('bl_offset') or '').strip()
        board_default_address = ''
        if board_default_offset:
            board_default_address = _application_address(mcu_info.get('platform_key') or '', board_default_offset)

        return jsonify({
            'success': True,
            'mcu': mcu_id,
            'platform': mcu_info.get('platform', ''),
            'platform_key': mcu_info.get('platform_key', ''),
            'options': options,
            'default_offset': default_option.get('offset', ''),
            'default_address': default_option.get('address', ''),
            'board_default_offset': board_default_offset,
            'board_default_address': board_default_address,
        })
    except Exception as e:
        return jsonify({'success': False, 'error': safe_error(e)}), 500


@firmware_bp.route('/api/firmware/bl/flash', methods=['POST'])
def flash_bl_firmware():
    """烧录BL固件 (Katapult/Bootloader)"""
    if not _bl_flash_lock.acquire(blocking=False):
        return jsonify({'error': '已有 BL 烧录任务正在执行，请稍后再试'}), 409
    try:
        data = request.get_json(silent=True) or {}
        bl_firmware_path = data.get('bl_firmware_path', '')
        device = data.get('device_id', data.get('device', ''))
        flash_mode = data.get('flash_mode', 'DFU')
        mcu_id = str(data.get('mcu_id') or '').strip()
        dfu_offset = str(data.get('dfu_offset', '')).strip()
        platform_key = str(data.get('platform_key') or 'stm32').strip().lower()
        dfu_address = data.get('dfu_address', '0x08000000')
        katapult_serial = data.get('katapult_serial', '')
        erase_flash = _truthy(data.get('erase_flash', True))

        if dfu_offset:
            dfu_address = _application_address(platform_key, dfu_offset)

        if not bl_firmware_path or not os.path.exists(bl_firmware_path):
            return jsonify({'error': f'BL固件文件不存在: {bl_firmware_path}'}), 400
        if not _path_under(bl_firmware_path, [BOARD_CONFIGS_DIR, BL_UPLOAD_DIR]):
            return jsonify({'error': 'BL固件路径不在允许目录内'}), 403

        firmware_ext = os.path.splitext(bl_firmware_path)[1].lower()
        if flash_mode == 'UF2':
            if device != 'rp2040_boot':
                return jsonify({'error': 'UF2 烧录必须选择处于 BOOTSEL 模式的 RP2040/RP2350 设备'}), 400
            if firmware_ext != '.uf2':
                return jsonify({'error': 'UF2 烧录仅支持 .uf2 BL 固件'}), 400
            if platform_key not in ('rp2040', 'rp2350', 'rp2'):
                return jsonify({'error': f'当前 MCU 平台 {platform_key} 与 UF2 烧录方式不兼容'}), 400
        elif flash_mode == 'DFU':
            if not str(device).startswith('dfu:'):
                return jsonify({'error': 'DFU 烧录必须选择明确的 DFU 设备'}), 400
            if platform_key != 'stm32':
                return jsonify({'error': f'当前 MCU 平台 {platform_key} 与 STM32 DFU 烧录方式不兼容'}), 400
            if firmware_ext != '.bin':
                return jsonify({'error': 'STM32 DFU 烧录仅支持原始 .bin BL 固件'}), 400
        elif flash_mode in ('st-flash', 'openocd') and platform_key != 'stm32':
            return jsonify({'error': f'当前 MCU 平台 {platform_key} 与 STM32 调试器烧录方式不兼容'}), 400
        elif flash_mode == 'st-flash' and firmware_ext != '.bin':
            return jsonify({'error': 'st-flash 仅支持原始 .bin BL 固件'}), 400
        elif flash_mode == 'openocd' and firmware_ext not in ('.bin', '.hex'):
            return jsonify({'error': 'OpenOCD BL 烧录仅支持 .bin 或 .hex 固件'}), 400

        if flash_mode in ('DFU', 'st-flash', 'openocd') and not _valid_flash_address(dfu_address):
            return jsonify({'error': f'烧录地址无效: {dfu_address}'}), 400

        if is_ssh_mode():
            bl_firmware_path = upload_bl_firmware_for_remote(bl_firmware_path)

        if flash_mode == 'DFU':
            device_filter = _dfu_device_filter(device)
            safe_address = shlex.quote(dfu_address)

            if erase_flash:
                logger.info('BL 烧录前执行 Flash 全片擦除...')
                erase_address = _application_address(platform_key or 'stm32', '0') or '0x08000000'
                erase_result = None
                for alt in (0, 1):
                    erase_cmd = f'sudo dfu-util -a {alt} {device_filter} -s {shlex.quote(erase_address)}:mass-erase:force'
                    erase_result = run_cmd(erase_cmd, shell=True, capture_output=True, text=True, timeout=60)
                    if erase_result.returncode == 0:
                        break
                if erase_result.returncode != 0:
                    logger.warning(f'Flash 擦除失败 (rc={erase_result.returncode})，已停止 BL 烧录')
                    return jsonify({
                        'success': False,
                        'error': 'Flash 擦除失败，已停止 BL 烧录以避免旧固件与 BL 偏移规则冲突',
                        'output': (erase_result.stdout or '') + (erase_result.stderr or '')
                    }), 500
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
            cmd = f'sudo {shlex.quote(rp2040_flash_tool)} {shlex.quote(bl_firmware_path)}'
            result = run_cmd(cmd, shell=True, capture_output=True, text=True, timeout=60)
            if result.returncode == 0 and 'No rp2040 in BOOTSEL mode was found' in (result.stdout + result.stderr):
                return jsonify({'success': False, 'error': '未找到处于 BOOTSEL 模式的 RP2040 设备', 'output': result.stdout + result.stderr}), 500

        elif flash_mode == 'KAT':
            klipper_owner, home_dir = get_klipper_owner()
            python_bin = get_klipper_python_bin(home_dir)
            flashtool_script = os.path.join(home_dir, 'katapult', 'scripts', 'flashtool.py')
            usb_device = katapult_serial if katapult_serial else device
            cmd = (
                f'{shlex.quote(python_bin)} {shlex.quote(flashtool_script)} -d {shlex.quote(usb_device)} -f {shlex.quote(bl_firmware_path)}'
                if usb_device else
                f'{shlex.quote(python_bin)} {shlex.quote(flashtool_script)} -f {shlex.quote(bl_firmware_path)}'
            )
            result = run_cmd(cmd, shell=True, capture_output=True, text=True, timeout=60)

        elif flash_mode == 'st-flash':
            stflash_cmd = f'sudo st-flash --reset write {shlex.quote(bl_firmware_path)} {shlex.quote(dfu_address)}'
            result = run_cmd(stflash_cmd, shell=True, capture_output=True, text=True, timeout=60)

        elif flash_mode == 'openocd':
            openocd_target = _openocd_target_for_mcu(mcu_id)
            if not openocd_target:
                return jsonify({'error': f'无法根据 MCU 型号选择 OpenOCD target: {mcu_id or "未提供"}'}), 400
            openocd_program = f'program {bl_firmware_path} {dfu_address} verify reset exit'
            openocd_cmd = f'sudo openocd -f interface/stlink.cfg -f target/{openocd_target}.cfg -c {shlex.quote(openocd_program)}'
            result = run_cmd(openocd_cmd, shell=True, capture_output=True, text=True, timeout=120)

        else:
            return jsonify({'error': f'不支持的BL烧录方式: {flash_mode}'}), 400

        if result.returncode == 0:
            return jsonify({'success': True, 'message': 'BL固件烧录成功', 'output': result.stdout + result.stderr})
        else:
            return jsonify({'success': False, 'error': 'BL固件烧录失败', 'output': result.stdout + result.stderr}), 500

    except Exception as e:
        return jsonify({'error': safe_error(e)}), 500
    finally:
        _bl_flash_lock.release()


# ==================== 编译配置导入/导出 API ====================
@firmware_bp.route('/api/firmware/export-config')
def export_compile_config():
    """导出当前编译配置为可分享的 JSON 文件"""
    try:
        raw_klipper_path = request.args.get('klipper_path') or config.get('klipper_path', '~/klipper')
        klipper_path = expand_klipper_path(raw_klipper_path)
        kconfig_klipper_path = expand_klipper_path(raw_klipper_path, force_local=True)

        config_path = os.path.join(klipper_path, '.config')
        content = _read_text_file(config_path)
        if not content.strip():
            return jsonify({'success': False, 'error': '未找到 Klipper .config'}), 404

        config_values, _ = _parse_klipper_config(content)
        params, warnings = _resolve_current_config_params(kconfig_klipper_path, config_values)
        if not params:
            return jsonify({'success': False, 'error': '无法解析编译参数', 'warnings': warnings}), 400

        manifest = _load_manifest(klipper_path)
        board_info = {}
        if manifest and manifest.get('board', {}).get('id'):
            board_info = manifest['board']
        else:
            boards = load_all_boards()
            for mfr, types in boards.items():
                for btype, configs in types.items():
                    for bc in configs.values():
                        if bc.get('mcu') == params.get('mcu') and bc.get('platform') == params.get('platform'):
                            board_info = {
                                'manufacturer': mfr,
                                'board_type': btype,
                                'id': bc.get('id', ''),
                                'name': bc.get('name', ''),
                            }
                            break

        export_data = {
            'schema': 1,
            'exported_at': time.strftime('%Y-%m-%dT%H:%M:%S%z'),
            'board': board_info,
            'mcu': {
                'platform': params.get('platform', ''),
                'platform_key': params.get('platform_key', ''),
                'mcu': params.get('mcu', ''),
                'mcu_name': params.get('mcu_name', ''),
            },
            'compile': {
                'crystal': params.get('crystal', ''),
                'bl_offset': params.get('bl_offset', ''),
                'communication': params.get('communication', ''),
                'comm_type': params.get('comm_type', ''),
                'comm_config_symbol': params.get('comm_config_symbol', ''),
                'canbus_frequency': params.get('canbus_frequency', '1000000'),
                'bridge_can_config': params.get('bridge_can_config', ''),
                'startup_pin': params.get('startup_pin', ''),
                'rp2040_can_rx_gpio': params.get('rp2040_can_rx_gpio', ''),
                'rp2040_can_tx_gpio': params.get('rp2040_can_tx_gpio', ''),
            },
            'klipper_path': raw_klipper_path,
        }
        return jsonify({'success': True, 'config': export_data, 'warnings': warnings})
    except Exception as e:
        logger.exception('导出编译配置失败')
        return jsonify({'success': False, 'error': safe_error(e)}), 500


@firmware_bp.route('/api/firmware/import-config', methods=['POST'])
def import_compile_config():
    """导入编译配置 JSON，返回验证后的参数和板卡配置"""
    try:
        data = request.get_json(silent=True)
        if not data:
            return jsonify({'success': False, 'error': '无效的 JSON 数据'}), 400

        schema = data.get('schema')
        if schema != 1:
            return jsonify({'success': False, 'error': f'不支持的配置版本: {schema}'}), 400

        compile_cfg = data.get('compile', {})
        mcu_cfg = data.get('mcu', {})
        board_cfg = data.get('board', {})

        warnings = []
        board_config = None

        if board_cfg.get('id') and board_cfg.get('manufacturer'):
            bc = load_board_config(board_cfg['manufacturer'], board_cfg.get('board_type', ''), board_cfg['id'])
            if bc:
                board_config = bc
            else:
                warnings.append(f'板卡 {board_cfg["id"]} 未找到，将使用自定义模式')

        params = {
            'platform': mcu_cfg.get('platform', ''),
            'platform_key': mcu_cfg.get('platform_key', ''),
            'mcu': mcu_cfg.get('mcu', ''),
            'mcu_name': mcu_cfg.get('mcu_name', ''),
            'crystal': compile_cfg.get('crystal', ''),
            'bl_offset': compile_cfg.get('bl_offset', ''),
            'communication': compile_cfg.get('communication', ''),
            'comm_type': compile_cfg.get('comm_type', ''),
            'comm_config_symbol': compile_cfg.get('comm_config_symbol', ''),
            'canbus_frequency': compile_cfg.get('canbus_frequency', '1000000'),
            'bridge_can_config': compile_cfg.get('bridge_can_config', ''),
            'startup_pin': compile_cfg.get('startup_pin', ''),
            'rp2040_can_rx_gpio': compile_cfg.get('rp2040_can_rx_gpio', ''),
            'rp2040_can_tx_gpio': compile_cfg.get('rp2040_can_tx_gpio', ''),
        }

        return jsonify({
            'success': True,
            'params': params,
            'board_config': board_config,
            'board_info': board_cfg,
            'klipper_path': data.get('klipper_path', ''),
            'warnings': warnings,
        })
    except Exception as e:
        logger.exception('导入编译配置失败')
        return jsonify({'success': False, 'error': safe_error(e)}), 500
