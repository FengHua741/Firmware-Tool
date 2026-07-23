"""
固件版本历史管理 - 记录每次编译产物，支持回溯下载
"""
import json
import os
import time
import hashlib
import shutil
from flask import Blueprint, jsonify, send_file

from shared import config, logger, BASE_DIR

firmware_history_bp = Blueprint('firmware_history', __name__)

HISTORY_DIR = os.path.join(BASE_DIR, 'data', 'firmware_history')
HISTORY_INDEX = os.path.join(HISTORY_DIR, 'index.json')
MAX_HISTORY = 50


def _ensure_dir():
    os.makedirs(HISTORY_DIR, exist_ok=True)


def _load_index():
    if os.path.isfile(HISTORY_INDEX):
        try:
            with open(HISTORY_INDEX, 'r', encoding='utf-8') as f:
                return json.load(f)
        except Exception:
            pass
    return []


def _save_index(index):
    _ensure_dir()
    with open(HISTORY_INDEX, 'w', encoding='utf-8') as f:
        json.dump(index, f, ensure_ascii=False, indent=2)


def record_compile(manifest, firmware_path):
    """编译成功后调用，复制固件并记录元数据"""
    try:
        if not firmware_path or not os.path.isfile(firmware_path):
            return None
        _ensure_dir()
        entry_id = time.strftime('%Y%m%d_%H%M%S') + '_' + os.urandom(3).hex()
        entry_dir = os.path.join(HISTORY_DIR, entry_id)
        os.makedirs(entry_dir, exist_ok=True)

        fw_name = os.path.basename(firmware_path)
        dest = os.path.join(entry_dir, fw_name)
        shutil.copy2(firmware_path, dest)

        with open(firmware_path, 'rb') as f:
            fw_hash = hashlib.sha256(f.read()).hexdigest()

        entry = {
            'id': entry_id,
            'timestamp': time.strftime('%Y-%m-%dT%H:%M:%S'),
            'git_commit': manifest.get('git_commit', ''),
            'board': manifest.get('board', {}),
            'mcu': manifest.get('mcu', {}),
            'params': manifest.get('compile_params', {}),
            'firmware_file': fw_name,
            'firmware_hash': f'sha256:{fw_hash}',
            'firmware_size': os.path.getsize(dest),
        }

        index = _load_index()
        index.insert(0, entry)
        if len(index) > MAX_HISTORY:
            for old in index[MAX_HISTORY:]:
                old_dir = os.path.join(HISTORY_DIR, old['id'])
                shutil.rmtree(old_dir, ignore_errors=True)
            index = index[:MAX_HISTORY]
        _save_index(index)
        logger.info(f"固件历史已记录: {entry_id}")
        return entry_id
    except Exception as e:
        logger.warning(f"记录固件历史失败: {e}")
        return None


@firmware_history_bp.route('/api/firmware/history', methods=['GET'])
def list_history():
    index = _load_index()
    return jsonify({'success': True, 'history': index})


@firmware_history_bp.route('/api/firmware/history/<entry_id>', methods=['GET'])
def get_history_detail(entry_id):
    if '..' in entry_id or '/' in entry_id:
        return jsonify({'success': False, 'error': '无效ID'}), 400
    index = _load_index()
    for entry in index:
        if entry['id'] == entry_id:
            return jsonify({'success': True, 'entry': entry})
    return jsonify({'success': False, 'error': '记录不存在'}), 404


@firmware_history_bp.route('/api/firmware/history/<entry_id>/download', methods=['GET'])
def download_history_firmware(entry_id):
    if '..' in entry_id or '/' in entry_id:
        return jsonify({'success': False, 'error': '无效ID'}), 400
    index = _load_index()
    entry = None
    for e in index:
        if e['id'] == entry_id:
            entry = e
            break
    if not entry:
        return jsonify({'success': False, 'error': '记录不存在'}), 404
    fw_path = os.path.join(HISTORY_DIR, entry_id, entry['firmware_file'])
    if not os.path.isfile(fw_path):
        return jsonify({'success': False, 'error': '固件文件不存在'}), 404
    return send_file(fw_path, as_attachment=True, download_name=entry['firmware_file'])


@firmware_history_bp.route('/api/firmware/history/<entry_id>', methods=['DELETE'])
def delete_history_entry(entry_id):
    if '..' in entry_id or '/' in entry_id:
        return jsonify({'success': False, 'error': '无效ID'}), 400
    index = _load_index()
    new_index = [e for e in index if e['id'] != entry_id]
    if len(new_index) == len(index):
        return jsonify({'success': False, 'error': '记录不存在'}), 404
    _save_index(new_index)
    entry_dir = os.path.join(HISTORY_DIR, entry_id)
    shutil.rmtree(entry_dir, ignore_errors=True)
    return jsonify({'success': True, 'message': '历史记录已删除'})
