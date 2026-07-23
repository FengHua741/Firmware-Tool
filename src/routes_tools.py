"""
工具页面 API - Klipper配置解析器/生成器的后端接口
"""

import os
import posixpath
import re
import json
import shlex
import fnmatch
import glob
import subprocess
import urllib.parse
import requests
from flask import Blueprint, jsonify, request, send_from_directory

from shared import config, logger, expand_klipper_path, get_moonraker_base_url
from ssh_manager import run_cmd, is_ssh_mode

tools_bp = Blueprint('tools_api', __name__)
ALLOWED_CONFIG_EXTENSIONS = ('.cfg', '.conf', '.txt', '.cfg.mainsail', '.cfg.fluidd')
MAX_CONFIG_CONTENT_BYTES = 2 * 1024 * 1024


def _safe_data_id(value):
    return bool(re.match(r'^[A-Za-z0-9_.-]{1,120}$', str(value or ''))) and not str(value).startswith('.')


def _is_allowed_config_name(path):
    return str(path or '').lower().endswith(ALLOWED_CONFIG_EXTENSIONS)


def _normalize_moonraker_config_path(path):
    if not path or not path.startswith('config/'):
        return ''
    rel_path = posixpath.normpath(path[len('config/'):])
    if rel_path in ('', '.') or rel_path.startswith('../') or rel_path.startswith('/'):
        return ''
    if not _is_allowed_config_name(rel_path):
        return ''
    return f'config/{rel_path}'


def _path_under_local(path, root):
    try:
        return os.path.commonpath([os.path.realpath(path), os.path.realpath(root)]) == os.path.realpath(root)
    except ValueError:
        return False


def get_klipper_config_dir():
    """获取 Klipper 配置文件目录路径"""
    klipper_path = config.get('klipper_path', '~/klipper')
    # 常见配置目录: ~/klipper_config, ~/printer_data/config, ~/klipper/config
    if is_ssh_mode():
        ssh_user = config.get('ssh_user', '')
        home = f'/home/{ssh_user}' if ssh_user and ssh_user != 'root' else '/root'
        base = home + klipper_path.lstrip('~') if klipper_path.startswith('~') else klipper_path
    else:
        base = expand_klipper_path(klipper_path, force_local=True)
        home = os.path.dirname(base) if os.path.basename(base) == 'klipper' else os.path.expanduser('~')

    candidates = [
        os.path.join(home, 'printer_data', 'config'),
        os.path.join(home, 'klipper_config'),
        os.path.join(base, 'config'),
        base,
    ]
    return candidates


def _normalize_path_for_mode(path):
    path = str(path or '').strip()
    if is_ssh_mode():
        if path.startswith('~'):
            ssh_user = config.get('ssh_user', '')
            home = f'/home/{ssh_user}' if ssh_user and ssh_user != 'root' else '/root'
            path = home + path[1:]
        return posixpath.normpath(path)
    return os.path.realpath(os.path.expanduser(path))


def _path_under(path, roots):
    norm_path = _normalize_path_for_mode(path)
    for root in roots:
        norm_root = _normalize_path_for_mode(root)
        try:
            if is_ssh_mode():
                if norm_path == norm_root or norm_path.startswith(norm_root.rstrip('/') + '/'):
                    return True
            elif os.path.commonpath([norm_path, norm_root]) == norm_root:
                return True
        except ValueError:
            continue
    return False

def _validate_config_file_path(file_path):
    if not file_path or '..' in file_path:
        return False
    if not _is_allowed_config_name(file_path):
        return False
    return _path_under(file_path, get_klipper_config_dir())


def _parse_cfg_sections(content):
    """轻量解析 Klipper 配置 section 和 key/value。"""
    sections = []
    current = None
    for line_no, line in enumerate((content or '').splitlines(), 1):
        header = re.match(r'^\s*\[([^\]]+)\]\s*(?:#.*)?$', line)
        if header:
            current = {'name': header.group(1).strip(), 'line': line_no, 'options': {}}
            sections.append(current)
            continue
        if not current:
            continue
        kv = re.match(r'^\s*([^:#]+)\s*:\s*(.*?)\s*(?:#.*)?$', line)
        if kv:
            current['options'][kv.group(1).strip()] = kv.group(2).strip()
    return sections


def _static_validate_klipper_config(content, board_id=None):
    sections = _parse_cfg_sections(content)
    section_map = {sec['name']: sec for sec in sections}
    seen = {}
    pin_usage = {}
    errors = []
    warnings = []

    for sec in sections:
        seen.setdefault(sec['name'], []).append(sec['line'])
        for key, value in sec.get('options', {}).items():
            if not (key.endswith('_pin') or key == 'pin'):
                continue
            clean_pin = str(value or '').split('#', 1)[0].strip()
            clean_pin = re.sub(r'^[!^~]+', '', clean_pin)
            if clean_pin.endswith(':virtual_endstop') or clean_pin.startswith('probe:'):
                continue
            if clean_pin and ':' not in clean_pin and not clean_pin.startswith('probe:'):
                pin_usage.setdefault(clean_pin.lower(), []).append(f'[{sec["name"]}] {key}')
            m = re.search(r'[!^~]?\b([A-Za-z_][\w.-]*):[A-Za-z0-9_.-]+', value)
            if not m:
                continue
            mcu = m.group(1)
            if mcu not in ('mcu', 'probe') and f'mcu {mcu}' not in section_map:
                errors.append(f'[{sec["name"]}] {key} 使用 {mcu}: 前缀，但缺少 [mcu {mcu}]')
            prefixed_pin = re.sub(r'^[!^~]+', '', str(value or '').strip()).lower()
            if prefixed_pin and not prefixed_pin.startswith('probe:'):
                pin_usage.setdefault(prefixed_pin, []).append(f'[{sec["name"]}] {key}')

    for name, lines in seen.items():
        if len(lines) > 1:
            errors.append(f'重复 section [{name}]，行号: {", ".join(map(str, lines))}')

    for pin, owners in pin_usage.items():
        unique_owners = sorted(set(owners))
        if len(unique_owners) > 1:
            errors.append(f'引脚重复使用 {pin}: {", ".join(unique_owners)}')

    if 'mcu' not in section_map:
        warnings.append('未发现 [mcu] 主控 section')

    result = {'ok': not errors, 'errors': errors, 'warnings': warnings, 'method': 'static'}

    if board_id:
        board_conflicts = _check_board_mapping_conflicts(pin_usage, board_id)
        result['board_conflicts'] = board_conflicts
        if board_conflicts:
            for bc in board_conflicts:
                warnings.append(f'引脚 {bc["pin"]} 在板卡映射中默认为 {bc["default_for"]}，但当前配置为 {bc["assigned_to"]}')

    return result


def _check_board_mapping_conflicts(pin_usage, board_id):
    """检查引脚分配与板卡默认映射的冲突"""
    if not _safe_data_id(board_id):
        return []

    index = _load_boards_index()
    board_info = None
    mapping_dir = None
    for brand, data in index.items():
        for btype in ['mainboards', 'toolboards']:
            if board_id in data.get(btype, {}):
                board_info = data[btype][board_id]
                mapping_dir = board_info.get('mapping_dir', '')
                break
        if board_info:
            break

    if not board_info or not mapping_dir:
        return []

    mapping_file = os.path.join(BOARDS_BASE_DIR, mapping_dir, 'klipper_Mapping.json')
    if not _path_under_local(mapping_file, BOARDS_BASE_DIR) or not os.path.isfile(mapping_file):
        return []

    try:
        with open(mapping_file, 'r', encoding='utf-8') as f:
            mapping = json.load(f)
    except Exception:
        return []

    default_pins = {}
    function_labels = {
        'Drives': '电机', 'BED_OUT': '热床', 'bed': '热床',
        'heat': '加热器', 'temp': '热敏', 'fan': '风扇',
        'stop': '限位', 'probe': '探针', 'servo': '舵机',
        'rgb': 'RGB', 'bltouch': 'BLTouch', 'ADXL': 'ADXL',
    }

    for key, value in mapping.items():
        if isinstance(value, dict):
            for sub_key, sub_pin in value.items():
                if isinstance(sub_pin, str) and re.match(r'^[A-Ga-g]\d{1,2}$', sub_pin.strip()):
                    default_pins[sub_pin.strip().upper()] = f'{key}.{sub_key}'
        elif isinstance(value, str) and re.match(r'^[A-Ga-g]\d{1,2}$', value.strip()):
            label = key
            for prefix, lbl in function_labels.items():
                if key.lower().startswith(prefix.lower()):
                    label = f'{key} ({lbl})'
                    break
            default_pins[value.strip().upper()] = label

    conflicts = []
    for pin_raw, owners in pin_usage.items():
        pin_upper = pin_raw.split(':')[-1].upper() if ':' in pin_raw else pin_raw.upper()
        if pin_upper in default_pins:
            assigned_to = ', '.join(sorted(set(owners)))
            expected = default_pins[pin_upper]
            is_correct = any(expected.startswith(owner.split('] ')[0].replace('[', '')) for owner in owners if '] ' in owner)
            if not is_correct:
                conflicts.append({
                    'pin': pin_upper,
                    'assigned_to': assigned_to,
                    'default_for': expected,
                    'board_id': board_id,
                })

    return conflicts


@tools_bp.route('/api/tools/config-files', methods=['GET'])
def list_config_files():
    """列出被控机器上的 Klipper 配置文件

    优先通过 Moonraker API 获取，回退到 SSH/本地文件系统。
    返回格式: { success, source, files: [{name, path, size}], error }
    """
    # 方案1: 通过 Moonraker API 列出配置文件
    base = get_moonraker_base_url()
    try:
        r = requests.get(f'{base}/server/info', timeout=3)
        if r.status_code == 200:
            r2 = requests.get(f'{base}/server/files/list?root=config', timeout=5)
            if r2.status_code == 200:
                data = r2.json()
                files = []
                for item in data.get('result', {}).get('dirs', []):
                    files.append({
                        'name': item.get('dirname', ''),
                        'path': f"config/{item.get('dirname', '')}",
                        'type': 'dir',
                    })
                for item in data.get('result', {}).get('files', []):
                    fname = item.get('filename', '')
                    if fname.lower().endswith(('.cfg', '.conf', '.txt', '.cfg.mainsail', '.cfg.fluidd')):
                        files.append({
                            'name': fname,
                            'path': f"config/{fname}",
                            'size': item.get('size', 0),
                            'modified': item.get('modified', 0),
                            'type': 'file',
                        })
                return jsonify({'success': True, 'source': 'moonraker', 'files': files})
    except Exception as e:
        logger.debug(f"Moonraker 文件列表失败: {e}")

    # 方案2: 通过 SSH/本地文件系统列出
    config_dirs = get_klipper_config_dir()
    all_files = []
    for cfg_dir in config_dirs:
        if is_ssh_mode():
            cmd = f'find {shlex.quote(cfg_dir)} -maxdepth 2 -type f \\( -name "*.cfg" -o -name "*.conf" -o -name "*.txt" \\) 2>/dev/null | head -50'
            result = run_cmd(cmd, shell=True, capture_output=True, text=True, timeout=10)
            if result.returncode == 0 and result.stdout.strip():
                for line in result.stdout.strip().split('\n'):
                    line = line.strip()
                    if line:
                        all_files.append({
                            'name': os.path.basename(line),
                            'path': line,
                            'size': 0,
                            'type': 'file',
                        })
                if all_files:
                    return jsonify({'success': True, 'source': 'ssh', 'config_dir': cfg_dir, 'files': all_files})
        else:
            expanded = os.path.expanduser(cfg_dir)
            if os.path.isdir(expanded):
                for root, dirs, fnames in os.walk(expanded):
                    dirs[:] = [d for d in dirs if not d.startswith('.')]
                    for fname in fnames:
                        if fname.lower().endswith(('.cfg', '.conf', '.txt')):
                            fpath = os.path.join(root, fname)
                            try:
                                fsize = os.path.getsize(fpath)
                            except Exception:
                                fsize = 0
                            all_files.append({
                                'name': fname,
                                'path': fpath,
                                'size': fsize,
                                'type': 'file',
                            })
                if all_files:
                    return jsonify({'success': True, 'source': 'local', 'config_dir': cfg_dir, 'files': all_files})

    return jsonify({'success': False, 'error': '未找到 Klipper 配置文件目录，请检查 Klipper 路径设置'})


@tools_bp.route('/api/tools/config-wildcard', methods=['POST'])
def list_wildcard_files():
    """展开通配符模式，返回匹配的文件列表

    请求体: { pattern: "config/macros/*.cfg" }
    返回: { success, files: [{name, path}] }
    """
    data = request.get_json(silent=True) or {}
    if not isinstance(data, dict):
        return jsonify({'success': False, 'error': '请求体必须是 JSON 对象'}), 400
    pattern = data.get('pattern', '').strip()
    if not pattern:
        return jsonify({'success': False, 'error': '未指定通配符模式'})
    if len(pattern) > 500:
        return jsonify({'success': False, 'error': '通配符模式过长'})
    if '..' in pattern:
        return jsonify({'success': False, 'error': '非法路径'})

    # Moonraker 来源 (config/xxx/*.cfg)
    if pattern.startswith('config/'):
        base = get_moonraker_base_url()
        try:
            r = requests.get(f'{base}/server/files/list?root=config', timeout=5)
            if r.status_code == 200:
                all_files = []
                for item in r.json().get('result', {}).get('files', []):
                    all_files.append(item.get('filename', ''))
                # 提取目录部分用于匹配
                dir_part = os.path.dirname(pattern)
                matched = []
                for fname in all_files:
                    full_path = f"config/{fname}"
                    if fnmatch.fnmatch(full_path, pattern):
                        matched.append({
                            'name': fname,
                            'path': full_path,
                        })
                return jsonify({'success': True, 'files': matched})
        except Exception as e:
            logger.debug(f"Moonraker 通配符查询失败: {e}")

    # SSH/本地来源
    if is_ssh_mode():
        dir_part = os.path.dirname(pattern)
        expanded_dir = os.path.expanduser(dir_part) if dir_part else '.'
        if not _path_under(expanded_dir, get_klipper_config_dir()):
            return jsonify({'success': False, 'error': '非法路径'})
        file_pattern = os.path.basename(pattern)
        cmd = f'find {shlex.quote(expanded_dir)} -maxdepth 1 -type f -name {shlex.quote(file_pattern)} 2>/dev/null | head -20'
        result = run_cmd(cmd, shell=True, capture_output=True, text=True, timeout=10)
        if result.returncode == 0 and result.stdout.strip():
            matched = []
            for line in result.stdout.strip().split('\n'):
                line = line.strip()
                if line:
                    matched.append({'name': os.path.basename(line), 'path': line})
            return jsonify({'success': True, 'files': matched})
    else:
        expanded = os.path.expanduser(pattern)
        dir_part = os.path.dirname(expanded)
        if not _path_under(dir_part, get_klipper_config_dir()):
            return jsonify({'success': False, 'error': '非法路径'})
        file_pattern = os.path.basename(expanded)
        matched = []
        if os.path.isdir(dir_part):
            for fname in os.listdir(dir_part):
                if fnmatch.fnmatch(fname, file_pattern):
                    fpath = os.path.join(dir_part, fname)
                    if os.path.isfile(fpath):
                        matched.append({'name': fname, 'path': fpath})
            return jsonify({'success': True, 'files': matched})

    return jsonify({'success': True, 'files': []})


@tools_bp.route('/api/tools/validate-klipper-config', methods=['POST'])
def validate_klipper_config():
    """校验生成的 Klipper 配置。"""
    data = request.get_json(silent=True) or {}
    if not isinstance(data, dict):
        return jsonify({'success': False, 'error': '请求体必须是 JSON 对象'}), 400
    content = data.get('content', '')
    if not content.strip():
        return jsonify({'success': False, 'error': '配置内容为空'})
    if len(content.encode('utf-8', errors='ignore')) > MAX_CONFIG_CONTENT_BYTES:
        return jsonify({'success': False, 'error': '配置内容过大'}), 413
    board_id = data.get('board_id', '').strip() or None
    result = _static_validate_klipper_config(content, board_id=board_id)
    return jsonify({'success': True, **result})


@tools_bp.route('/api/tools/config-content', methods=['POST'])
def read_config_content():
    """读取指定配置文件的完整内容

    请求体: { path: "config/printer.cfg" }  (Moonraker来源)
            或 { path: "/home/pi/printer_data/config/printer.cfg" }  (SSH/本地来源)
    返回: { success, content, filename, source }
    """
    data = request.get_json(silent=True) or {}
    if not isinstance(data, dict):
        return jsonify({'success': False, 'error': '请求体必须是 JSON 对象'}), 400
    file_path = data.get('path', '').strip()
    if not file_path:
        return jsonify({'success': False, 'error': '未指定文件路径'})

    # 防止路径遍历
    if '..' in file_path:
        return jsonify({'success': False, 'error': '非法路径'})

    # 方案1: Moonraker API 读取 (path 以 "config/" 开头)
    if file_path.startswith('config/'):
        file_path = _normalize_moonraker_config_path(file_path)
        if not file_path:
            return jsonify({'success': False, 'error': '非法路径'})
        base = get_moonraker_base_url()
        encoded_path = urllib.parse.quote(file_path, safe='/')
        try:
            r = requests.get(f'{base}/server/files/{encoded_path}', timeout=10)
            if r.status_code == 200:
                if len(r.content) > MAX_CONFIG_CONTENT_BYTES:
                    return jsonify({'success': False, 'error': '配置文件过大'}), 413
                return jsonify({
                    'success': True,
                    'content': r.text,
                    'filename': os.path.basename(file_path),
                    'source': 'moonraker',
                })
            else:
                return jsonify({'success': False, 'error': f'Moonraker 返回 {r.status_code}'})
        except requests.ConnectionError:
            return jsonify({'success': False, 'error': 'Moonraker 连接失败'})
        except requests.Timeout:
            return jsonify({'success': False, 'error': 'Moonraker 超时'})
        except Exception as e:
            return jsonify({'success': False, 'error': str(e)})

    # 方案2: SSH/本地读取
    if not _validate_config_file_path(file_path):
        return jsonify({'success': False, 'error': '非法路径'})
    if is_ssh_mode():
        size_cmd = f'stat -c %s {shlex.quote(file_path)} 2>/dev/null || wc -c < {shlex.quote(file_path)} 2>/dev/null'
        size_result = run_cmd(size_cmd, shell=True, capture_output=True, text=True, timeout=10)
        try:
            remote_size = int((size_result.stdout or '').strip().splitlines()[0])
        except (ValueError, IndexError):
            remote_size = 0
        if remote_size > MAX_CONFIG_CONTENT_BYTES:
            return jsonify({'success': False, 'error': '配置文件过大'}), 413
        cmd = f'cat {shlex.quote(file_path)} 2>&1'
        result = run_cmd(cmd, shell=True, capture_output=True, text=True, timeout=10)
        if result.returncode == 0:
            return jsonify({
                'success': True,
                'content': result.stdout,
                'filename': os.path.basename(file_path),
                'source': 'ssh',
            })
        else:
            return jsonify({'success': False, 'error': result.stderr.strip() or '读取失败'})
    else:
        expanded = os.path.expanduser(file_path)
        if not os.path.isfile(expanded):
            return jsonify({'success': False, 'error': '文件不存在'})
        if os.path.getsize(expanded) > MAX_CONFIG_CONTENT_BYTES:
            return jsonify({'success': False, 'error': '配置文件过大'}), 413
        try:
            with open(expanded, 'r', encoding='utf-8', errors='replace') as f:
                content = f.read()
            return jsonify({
                'success': True,
                'content': content,
                'filename': os.path.basename(file_path),
                'source': 'local',
            })
        except Exception as e:
            return jsonify({'success': False, 'error': str(e)})


@tools_bp.route('/api/tools/mainsail-config', methods=['GET'])
def get_mainsail_config():
    """获取 Mainsail 默认宏配置基准内容

    优先读取本地基准文件 data/mainsail_baseline.cfg，
    回退到被控机器的 mainsail.cfg。
    返回: { success, content, source }
    """
    # 方案1: 本地基准文件（优先）
    baseline_path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'data', 'mainsail_baseline.cfg')
    if os.path.isfile(baseline_path):
        try:
            with open(baseline_path, 'r', encoding='utf-8', errors='replace') as f:
                return jsonify({'success': True, 'content': f.read(), 'source': 'local_baseline'})
        except Exception as e:
            logger.debug(f"本地基准文件读取失败: {e}")

    # 方案2: Moonraker API
    base = get_moonraker_base_url()
    try:
        r = requests.get(f'{base}/server/files/config/mainsail.cfg', timeout=10)
        if r.status_code == 200:
            return jsonify({'success': True, 'content': r.text, 'source': 'moonraker'})
    except Exception as e:
        logger.debug(f"Moonraker mainsail.cfg 读取失败: {e}")

    # 方案3: SSH/本地
    if is_ssh_mode():
        config_dirs = get_klipper_config_dir()
        for cfg_dir in config_dirs:
            cmd = f'cat {shlex.quote(cfg_dir)}/mainsail.cfg 2>/dev/null'
            result = run_cmd(cmd, shell=True, capture_output=True, text=True, timeout=10)
            if result.returncode == 0 and result.stdout.strip():
                return jsonify({'success': True, 'content': result.stdout, 'source': 'ssh'})
    else:
        config_dirs = get_klipper_config_dir()
        for cfg_dir in config_dirs:
            expanded = os.path.expanduser(os.path.join(cfg_dir, 'mainsail.cfg'))
            if os.path.isfile(expanded):
                try:
                    with open(expanded, 'r', encoding='utf-8', errors='replace') as f:
                        return jsonify({'success': True, 'content': f.read(), 'source': 'local'})
                except Exception:
                    pass

    return jsonify({'success': False, 'error': '未找到 mainsail.cfg 文件'})


@tools_bp.route('/api/tools/mainsail-config/update', methods=['POST'])
def update_mainsail_baseline():
    """从被控机器获取最新的 mainsail.cfg 并更新本地基准文件

    返回: { success, message, macro_count }
    """
    content = None
    source = None

    # 从被控机器获取
    base = get_moonraker_base_url()
    try:
        r = requests.get(f'{base}/server/files/config/mainsail.cfg', timeout=10)
        if r.status_code == 200:
            content = r.text
            source = 'moonraker'
    except Exception as e:
        logger.debug(f"Moonraker mainsail.cfg 获取失败: {e}")

    if not content and is_ssh_mode():
        config_dirs = get_klipper_config_dir()
        for cfg_dir in config_dirs:
            cmd = f'cat {shlex.quote(cfg_dir)}/mainsail.cfg 2>/dev/null'
            result = run_cmd(cmd, shell=True, capture_output=True, text=True, timeout=10)
            if result.returncode == 0 and result.stdout.strip():
                content = result.stdout
                source = 'ssh'
                break

    if not content:
        return jsonify({'success': False, 'error': '无法从被控机器获取 mainsail.cfg'})

    # 保存到本地基准文件
    baseline_path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'data', 'mainsail_baseline.cfg')
    try:
        with open(baseline_path, 'w', encoding='utf-8') as f:
            f.write(content)
        # 统计宏数量
        macro_count = len(re.findall(r'\[gcode_macro\s+', content, re.IGNORECASE))
        return jsonify({'success': True, 'message': f'基准已更新 (来源: {source})', 'macro_count': macro_count})
    except Exception as e:
        return jsonify({'success': False, 'error': f'保存失败: {e}'})


# ========== 板卡数据 API ==========

BOARDS_BASE_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'data', 'boards')
BOARDS_INDEX_FILE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'data', 'boards_index.json')


@tools_bp.route('/api/tools/boards/<board_id>/image', methods=['GET'])
def get_board_image(board_id):
    """获取指定板卡的图片文件

    返回: 图片文件
    """
    try:
        if not _safe_data_id(board_id):
            return 'Invalid board id', 400
        index = _load_boards_index()
        board_info = None
        for brand, data in index.items():
            for btype in ['mainboards', 'toolboards']:
                if board_id in data.get(btype, {}):
                    board_info = data[btype][board_id]
                    break
            if board_info:
                break
        if not board_info:
            return 'Board not found', 404
        image_path = board_info.get('image', '')
        if not image_path:
            return 'No image', 404
        # image_path 是相对于 data/ 的路径，如 boards/board/C5/C5.png
        data_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'data')
        full_path = os.path.join(data_dir, image_path)
        if not _path_under_local(full_path, data_dir):
            return 'Invalid image path', 403
        if not os.path.isfile(full_path):
            return 'Image not found', 404
        directory = os.path.dirname(full_path)
        filename = os.path.basename(full_path)
        return send_from_directory(directory, filename)
    except Exception as e:
        return str(e), 500


def _load_boards_index():
    """加载板卡索引"""
    if os.path.isfile(BOARDS_INDEX_FILE):
        with open(BOARDS_INDEX_FILE, 'r', encoding='utf-8') as f:
            return json.load(f)
    return {}


@tools_bp.route('/api/tools/boards', methods=['GET'])
def list_boards():
    """获取板卡索引（按品牌分类）

    返回: { success, brands: { FLY: { mainboards: {...}, toolboards: {...} } } }
    """
    try:
        index = _load_boards_index()
        # 简化返回数据，去掉内部路径
        result = {}
        for brand, data in index.items():
            result[brand] = {
                'mainboards': {},
                'toolboards': {},
            }
            for bid, info in data.get('mainboards', {}).items():
                result[brand]['mainboards'][bid] = {
                    'name': info['name'],
                    'board_id': info['board_id'],
                    'mcu': info['mcu'],
                    'platform': info['platform'],
                    'drive_count': info['drive_count'],
                    'has_bed': info['has_bed'],
                    'heat_count': info['heat_count'],
                    'temp_count': info['temp_count'],
                    'fan_count': info['fan_count'],
                    'stop_count': info['stop_count'],
                    'has_probe': info['has_probe'],
                    'has_servo': info['has_servo'],
                    'pin_style': info['pin_style'],
                    'connections': info['connections'],
                }
            for bid, info in data.get('toolboards', {}).items():
                result[brand]['toolboards'][bid] = {
                    'name': info['name'],
                    'board_id': info['board_id'],
                    'mcu': info['mcu'],
                    'platform': info['platform'],
                    'drive_count': info['drive_count'],
                    'has_bed': info['has_bed'],
                    'heat_count': info['heat_count'],
                    'temp_count': info['temp_count'],
                    'fan_count': info['fan_count'],
                    'stop_count': info['stop_count'],
                    'has_probe': info['has_probe'],
                    'has_servo': info['has_servo'],
                    'pin_style': info['pin_style'],
                    'connections': info['connections'],
                }
        return jsonify({'success': True, 'brands': result})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)})


@tools_bp.route('/api/tools/boards/<board_id>/mapping', methods=['GET'])
def get_board_mapping(board_id):
    """获取指定板卡的 klipper_Mapping.json 内容和图片坐标布局

    返回: { success, mapping, layout, board_info }
    """
    try:
        if not _safe_data_id(board_id):
            return jsonify({'success': False, 'error': '非法板卡 ID'}), 400
        index = _load_boards_index()
        # 在所有品牌中查找该 board_id
        board_info = None
        mapping_dir = None
        for brand, data in index.items():
            for btype in ['mainboards', 'toolboards']:
                if board_id in data.get(btype, {}):
                    board_info = data[btype][board_id]
                    mapping_dir = board_info.get('mapping_dir', '')
                    break
            if board_info:
                break

        if not board_info:
            return jsonify({'success': False, 'error': f'未找到板卡: {board_id}'})
        if not mapping_dir:
            return jsonify({'success': False, 'error': '板卡映射目录为空'})

        mapping_file = os.path.join(BOARDS_BASE_DIR, mapping_dir, 'klipper_Mapping.json')
        if not _path_under_local(mapping_file, BOARDS_BASE_DIR):
            return jsonify({'success': False, 'error': '非法映射路径'})
        if not os.path.isfile(mapping_file):
            return jsonify({'success': False, 'error': '引脚映射文件不存在'})

        with open(mapping_file, 'r', encoding='utf-8') as f:
            mapping = json.load(f)

        layout = None
        layout_candidates = []
        if board_info.get('image'):
            layout_candidates.append(os.path.splitext(os.path.basename(board_info['image']))[0] + '.json')
        if mapping_dir:
            layout_candidates.append(os.path.basename(mapping_dir.rstrip('/')) + '.json')
        for filename in dict.fromkeys(layout_candidates):
            layout_file = os.path.join(BOARDS_BASE_DIR, mapping_dir, filename)
            if not _path_under_local(layout_file, BOARDS_BASE_DIR):
                continue
            if os.path.isfile(layout_file):
                with open(layout_file, 'r', encoding='utf-8') as f:
                    layout = json.load(f)
                break

        return jsonify({
            'success': True,
            'mapping': mapping,
            'layout': layout,
            'board_info': board_info,
        })
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)})


# ========== 机型预设 API ==========

MACHINES_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'data', 'machines')


@tools_bp.route('/api/tools/machines', methods=['GET'])
def list_machines():
    """获取所有机型预设列表

    返回: { success, machines: [{id, name, description, geometry, drive_count}] }
    """
    try:
        machines = []
        if os.path.isdir(MACHINES_DIR):
            for fname in sorted(os.listdir(MACHINES_DIR)):
                if fname.endswith('.json'):
                    fpath = os.path.join(MACHINES_DIR, fname)
                    with open(fpath, 'r', encoding='utf-8') as f:
                        data = json.load(f)
                    machines.append({
                        'id': data.get('id', fname.replace('.json', '')),
                        'name': data.get('name', ''),
                        'description': data.get('description', ''),
                        'geometry': data.get('geometry', {}),
                        'drive_count': len(data.get('drives', [])),
                    })
        return jsonify({'success': True, 'machines': machines})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)})


@tools_bp.route('/api/tools/machines/<machine_id>', methods=['GET'])
def get_machine_preset(machine_id):
    """获取指定机型的完整预设数据

    返回: { success, preset: {...} }
    """
    try:
        if not _safe_data_id(machine_id):
            return jsonify({'success': False, 'error': '非法ID'})
        fpath = os.path.join(MACHINES_DIR, f'{machine_id}.json')
        if not _path_under_local(fpath, MACHINES_DIR):
            return jsonify({'success': False, 'error': '非法路径'}), 403
        if not os.path.isfile(fpath):
            return jsonify({'success': False, 'error': f'未找到机型预设: {machine_id}'})
        with open(fpath, 'r', encoding='utf-8') as f:
            preset = json.load(f)
        return jsonify({'success': True, 'preset': preset})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)})


# ========== MCU 自动检测 API ==========

@tools_bp.route('/api/tools/detect-mcus', methods=['GET'])
def detect_mcu_devices():
    """扫描可用的 MCU 设备（串口 + CAN）

    返回: { success, devices: [{path, type, description}] }
    """
    devices = []

    # 方案1: 通过 SSH/本地扫描串口设备
    if is_ssh_mode():
        # 扫描 /dev/serial/by-id/ 目录
        cmd = 'ls -1 /dev/serial/by-id/ 2>/dev/null'
        result = run_cmd(cmd, shell=True, capture_output=True, text=True, timeout=10)
        if result.returncode == 0 and result.stdout.strip():
            for line in result.stdout.strip().split('\n'):
                line = line.strip()
                if line:
                    full_path = f'/dev/serial/by-id/{line}'
                    # 解析设备描述
                    desc = line.replace('usb-', '').replace('_', ' ')
                    dev_type = 'usb' if 'usb' in line.lower() else 'serial'
                    devices.append({
                        'path': full_path,
                        'type': dev_type,
                        'description': desc,
                    })
        # 扫描 CAN 接口
        cmd_can = 'ip -br link show 2>/dev/null | grep -i can'
        result_can = run_cmd(cmd_can, shell=True, capture_output=True, text=True, timeout=5)
        if result_can.returncode == 0 and result_can.stdout.strip():
            for line in result_can.stdout.strip().split('\n'):
                parts = line.split()
                if parts:
                    iface = parts[0]
                    devices.append({
                        'path': iface,
                        'type': 'can',
                        'description': f'CAN接口: {iface}',
                    })
    else:
        # 本地扫描
        # 扫描串口设备
        serial_patterns = [
            '/dev/serial/by-id/*',
            '/dev/ttyUSB*',
            '/dev/ttyACM*',
        ]
        for pattern in serial_patterns:
            for dev_path in sorted(glob.glob(pattern)):
                # 排除蓝牙和其他非MCU设备
                if 'bluetooth' in dev_path.lower():
                    continue
                desc = os.path.basename(dev_path).replace('usb-', '').replace('_', ' ')
                dev_type = 'usb' if 'usb' in dev_path.lower() else 'serial'
                devices.append({
                    'path': dev_path,
                    'type': dev_type,
                    'description': desc,
                })
        # 扫描 CAN 接口
        try:
            result = subprocess.run(
                ['ip', '-br', 'link', 'show'],
                capture_output=True, text=True, timeout=5
            )
            if result.returncode == 0:
                for line in result.stdout.strip().split('\n'):
                    if 'can' in line.lower() and 'can' in line.split()[0].lower():
                        iface = line.split()[0]
                        devices.append({
                            'path': iface,
                            'type': 'can',
                            'description': f'CAN接口: {iface}',
                        })
        except Exception:
            pass

    return jsonify({'success': True, 'devices': devices})
