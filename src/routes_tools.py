"""
工具页面 API - Klipper配置解析器/生成器的后端接口
"""

import os
import re
import json
import shlex
import fnmatch
import requests
from flask import Blueprint, jsonify, request, send_from_directory

from shared import config, logger
from ssh_manager import run_cmd, is_ssh_mode

tools_bp = Blueprint('tools_api', __name__)


def get_moonraker_base_url():
    """获取 Moonraker HTTP API 基础 URL"""
    if is_ssh_mode():
        host = config.get('ssh_host', '127.0.0.1')
    else:
        host = '127.0.0.1'
    port = config.get('moonraker_port', 7125)
    return f'http://{host}:{port}'


def get_klipper_config_dir():
    """获取 Klipper 配置文件目录路径"""
    klipper_path = config.get('klipper_path', '~/klipper')
    # 常见配置目录: ~/klipper_config, ~/printer_data/config, ~/klipper/config
    if is_ssh_mode():
        ssh_user = config.get('ssh_user', '')
        home = f'/home/{ssh_user}' if ssh_user and ssh_user != 'root' else '/root'
        base = home + klipper_path.lstrip('~') if klipper_path.startswith('~') else klipper_path
    else:
        home = os.path.expanduser('~')
        base = os.path.expanduser(klipper_path)

    candidates = [
        os.path.join(home, 'printer_data', 'config'),
        os.path.join(home, 'klipper_config'),
        os.path.join(base, 'config'),
        base,
    ]
    return candidates


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


def _static_validate_klipper_config(content):
    sections = _parse_cfg_sections(content)
    section_map = {sec['name']: sec for sec in sections}
    seen = {}
    errors = []
    warnings = []

    for sec in sections:
        seen.setdefault(sec['name'], []).append(sec['line'])
        for key, value in sec.get('options', {}).items():
            if not (key.endswith('_pin') or key == 'pin'):
                continue
            m = re.search(r'[!^~]?\b([A-Za-z_][\w.-]*):[A-Za-z0-9_.-]+', value)
            if not m:
                continue
            mcu = m.group(1)
            if mcu not in ('mcu', 'probe') and f'mcu {mcu}' not in section_map:
                errors.append(f'[{sec["name"]}] {key} 使用 {mcu}: 前缀，但缺少 [mcu {mcu}]')

    for name, lines in seen.items():
        if len(lines) > 1:
            errors.append(f'重复 section [{name}]，行号: {", ".join(map(str, lines))}')

    if 'mcu' not in section_map:
        warnings.append('未发现 [mcu] 主控 section')

    return {'ok': not errors, 'errors': errors, 'warnings': warnings, 'method': 'static'}


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
    data = request.json or {}
    pattern = data.get('pattern', '').strip()
    if not pattern:
        return jsonify({'success': False, 'error': '未指定通配符模式'})
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
    data = request.json or {}
    content = data.get('content', '')
    if not content.strip():
        return jsonify({'success': False, 'error': '配置内容为空'})
    result = _static_validate_klipper_config(content)
    return jsonify({'success': True, **result})


@tools_bp.route('/api/tools/config-content', methods=['POST'])
def read_config_content():
    """读取指定配置文件的完整内容

    请求体: { path: "config/printer.cfg" }  (Moonraker来源)
            或 { path: "/home/pi/printer_data/config/printer.cfg" }  (SSH/本地来源)
    返回: { success, content, filename, source }
    """
    data = request.json or {}
    file_path = data.get('path', '').strip()
    if not file_path:
        return jsonify({'success': False, 'error': '未指定文件路径'})

    # 防止路径遍历
    if '..' in file_path:
        return jsonify({'success': False, 'error': '非法路径'})

    # 方案1: Moonraker API 读取 (path 以 "config/" 开头)
    if file_path.startswith('config/'):
        base = get_moonraker_base_url()
        try:
            r = requests.get(f'{base}/server/files/{file_path}', timeout=10)
            if r.status_code == 200:
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
    if is_ssh_mode():
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
        import re
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

        mapping_file = os.path.join(BOARDS_BASE_DIR, mapping_dir, 'klipper_Mapping.json')
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
        # 防止路径遍历
        if '..' in machine_id or '/' in machine_id:
            return jsonify({'success': False, 'error': '非法ID'})
        fpath = os.path.join(MACHINES_DIR, f'{machine_id}.json')
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
        import glob
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
            import subprocess
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
