"""
配置备份与回滚蓝图 - printer.cfg 备份、列表、恢复、删除
"""

import os
import json
import time
import shlex
import hashlib
import difflib
import requests
from flask import Blueprint, jsonify, request

from shared import (
    config, logger, BASE_DIR,
    get_moonraker_base_url, get_klipper_owner,
    is_ssh_mode, sudo_write_file,
    SSHManager,
)

backup_bp = Blueprint('backup_api', __name__)

BACKUP_DIR = os.path.join(BASE_DIR, 'data', 'backups')


def _ensure_backup_dir():
    os.makedirs(BACKUP_DIR, exist_ok=True)


def _read_printer_cfg_content():
    """3 层读取 printer.cfg 内容: Moonraker → SSH → Local"""
    base = get_moonraker_base_url()
    try:
        r = requests.get(f'{base}/server/files/config/printer.cfg', timeout=10)
        if r.status_code == 200:
            return r.text, 'moonraker', None
    except Exception:
        pass

    _, home_dir = get_klipper_owner()
    candidates = [
        os.path.join(home_dir, 'printer_data', 'config', 'printer.cfg'),
        os.path.join(home_dir, 'klipper_config', 'config', 'printer.cfg'),
        os.path.join(home_dir, 'klipper_config', 'printer.cfg'),
        os.path.join(home_dir, 'printer.cfg'),
    ]

    if is_ssh_mode():
        manager = SSHManager.get_instance()
        for path in candidates:
            try:
                result = manager.exec_command(
                    f'cat {shlex.quote(path)} 2>/dev/null', timeout=10, inject_sudo=False
                )
                if result.returncode == 0 and result.stdout.strip():
                    return result.stdout, 'ssh', path
            except Exception:
                continue
    else:
        for path in candidates:
            expanded = os.path.expanduser(path)
            if os.path.isfile(expanded):
                try:
                    with open(expanded, 'r', encoding='utf-8', errors='replace') as f:
                        return f.read(), 'local', expanded
                except Exception:
                    continue

    return None, None, '未找到 printer.cfg'


def _write_printer_cfg(content):
    """通过 Moonraker 上传或 SSH/本地写入 printer.cfg"""
    base = get_moonraker_base_url()
    try:
        r = requests.get(f'{base}/server/info', timeout=3)
        if r.status_code == 200:
            files = {'file': ('printer.cfg', content.encode('utf-8'), 'text/plain')}
            data = {'root': 'config', 'path': ''}
            r = requests.post(f'{base}/server/files/upload', files=files, data=data, timeout=15)
            if r.status_code == 200:
                return True, 'moonraker'
    except Exception:
        pass

    _, home_dir = get_klipper_owner()
    target = os.path.join(home_dir, 'printer_data', 'config', 'printer.cfg')

    if is_ssh_mode():
        try:
            sudo_write_file(target, content)
            return True, 'ssh'
        except Exception as e:
            return False, str(e)
    else:
        try:
            expanded = os.path.expanduser(target)
            os.makedirs(os.path.dirname(expanded), exist_ok=True)
            with open(expanded, 'w', encoding='utf-8') as f:
                f.write(content)
            return True, 'local'
        except Exception as e:
            return False, str(e)


def _backup_meta_path(backup_id):
    return os.path.join(BACKUP_DIR, backup_id + '.meta')


def _load_backup_meta(backup_id):
    meta_path = _backup_meta_path(backup_id)
    if not os.path.isfile(meta_path):
        return None
    try:
        with open(meta_path, 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return None


def _save_backup_meta(backup_id, meta):
    meta_path = _backup_meta_path(backup_id)
    with open(meta_path, 'w', encoding='utf-8') as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)


@backup_bp.route('/api/backup/config', methods=['POST'])
def create_backup():
    """创建 printer.cfg 备份"""
    try:
        _ensure_backup_dir()
        content, source, err = _read_printer_cfg_content()
        if content is None:
            return jsonify({'success': False, 'error': err or '无法读取 printer.cfg'}), 404

        ts = time.strftime('%Y%m%d_%H%M%S')
        backup_id = f'{ts}_{os.urandom(3).hex()}_printer.cfg'
        backup_path = os.path.join(BACKUP_DIR, backup_id)

        with open(backup_path, 'w', encoding='utf-8') as f:
            f.write(content)

        sha = hashlib.sha256(content.encode('utf-8')).hexdigest()
        meta = {
            'filename': 'printer.cfg',
            'timestamp': time.strftime('%Y-%m-%dT%H:%M:%S%z'),
            'source': source or 'unknown',
            'sha256': sha,
            'size': len(content.encode('utf-8')),
        }
        _save_backup_meta(backup_id, meta)

        max_backups = config.get('backup', {}).get('max_backups', 10)
        _prune_old_backups(max_backups)

        try:
            from routes_notifications import push_notification
            push_notification('backup_created', '配置备份已创建', backup_id, 'info')
        except Exception:
            pass

        return jsonify({
            'success': True,
            'backup_id': backup_id,
            'size': len(content.encode('utf-8')),
            'source': source,
        })
    except Exception as e:
        logger.exception('创建备份失败')
        return jsonify({'success': False, 'error': str(e)}), 500


@backup_bp.route('/api/backup/list')
def list_backups():
    """列出所有备份"""
    try:
        _ensure_backup_dir()
        backups = []
        for fname in sorted(os.listdir(BACKUP_DIR), reverse=True):
            if not fname.endswith('.meta'):
                continue
            backup_id = fname[:-5]
            meta = _load_backup_meta(backup_id)
            if meta:
                meta['id'] = backup_id
                backups.append(meta)
            else:
                fpath = os.path.join(BACKUP_DIR, backup_id)
                if os.path.isfile(fpath):
                    backups.append({
                        'id': backup_id,
                        'filename': backup_id.split('_', 3)[-1] if backup_id.count('_') >= 3 else backup_id,
                        'timestamp': '',
                        'source': 'unknown',
                        'size': os.path.getsize(fpath),
                    })
        return jsonify({'success': True, 'backups': backups})
    except Exception as e:
        logger.exception('列出备份失败')
        return jsonify({'success': False, 'error': str(e)}), 500


@backup_bp.route('/api/backup/rollback', methods=['POST'])
def rollback_backup():
    """恢复指定备份到 printer.cfg"""
    try:
        data = request.get_json(silent=True) or {}
        backup_id = data.get('backup_id', '').strip()
        if not backup_id or '..' in backup_id or '/' in backup_id:
            return jsonify({'success': False, 'error': '无效的备份ID'}), 400

        backup_path = os.path.join(BACKUP_DIR, backup_id)
        if not os.path.isfile(backup_path):
            return jsonify({'success': False, 'error': '备份文件不存在'}), 404

        with open(backup_path, 'r', encoding='utf-8') as f:
            content = f.read()

        ok, result = _write_printer_cfg(content)
        if ok:
            return jsonify({'success': True, 'message': '配置已恢复', 'source': result})
        else:
            return jsonify({'success': False, 'error': f'写入失败: {result}'}), 500
    except Exception as e:
        logger.exception('恢复备份失败')
        return jsonify({'success': False, 'error': str(e)}), 500


@backup_bp.route('/api/backup/<backup_id>', methods=['DELETE'])
def delete_backup(backup_id):
    """删除指定备份"""
    try:
        if '..' in backup_id or '/' in backup_id:
            return jsonify({'success': False, 'error': '无效的备份ID'}), 400

        backup_path = os.path.join(BACKUP_DIR, backup_id)
        meta_path = _backup_meta_path(backup_id)
        deleted = False
        if os.path.isfile(backup_path):
            os.remove(backup_path)
            deleted = True
        if os.path.isfile(meta_path):
            os.remove(meta_path)
            deleted = True

        if deleted:
            return jsonify({'success': True, 'message': '备份已删除'})
        else:
            return jsonify({'success': False, 'error': '备份不存在'}), 404
    except Exception as e:
        logger.exception('删除备份失败')
        return jsonify({'success': False, 'error': str(e)}), 500


@backup_bp.route('/api/backup/settings')
def get_backup_settings():
    """获取自动备份设置"""
    backup_cfg = config.get('backup', {})
    return jsonify({
        'success': True,
        'auto_backup': backup_cfg.get('auto_backup', False),
        'max_backups': backup_cfg.get('max_backups', 10),
    })


@backup_bp.route('/api/backup/settings', methods=['POST'])
def update_backup_settings():
    """更新自动备份设置"""
    try:
        data = request.get_json(silent=True) or {}
        backup_cfg = config.get('backup', {})
        if 'auto_backup' in data:
            backup_cfg['auto_backup'] = bool(data['auto_backup'])
        if 'max_backups' in data:
            backup_cfg['max_backups'] = max(1, int(data['max_backups']))
        config['backup'] = backup_cfg

        config_path = os.path.join(BASE_DIR, 'data', 'config.json')
        with open(config_path, 'w', encoding='utf-8') as f:
            json.dump(config, f, ensure_ascii=False, indent=2)

        return jsonify({'success': True, 'settings': backup_cfg})
    except Exception as e:
        logger.exception('更新备份设置失败')
        return jsonify({'success': False, 'error': str(e)}), 500


def _prune_old_backups(max_count):
    """保留最近 max_count 个备份，删除多余的"""
    try:
        _ensure_backup_dir()
        metas = []
        for fname in os.listdir(BACKUP_DIR):
            if fname.endswith('.meta'):
                backup_id = fname[:-5]
                if os.path.isfile(os.path.join(BACKUP_DIR, backup_id)):
                    metas.append(backup_id)
        metas.sort(reverse=True)
        for old_id in metas[max_count:]:
            old_path = os.path.join(BACKUP_DIR, old_id)
            old_meta = _backup_meta_path(old_id)
            if os.path.isfile(old_path):
                os.remove(old_path)
            if os.path.isfile(old_meta):
                os.remove(old_meta)
    except Exception:
        pass


@backup_bp.route('/api/backup/diff', methods=['POST'])
def diff_backups():
    """生成两个备份版本之间（或备份与当前配置之间）的 unified diff"""
    try:
        data = request.get_json(silent=True) or {}
        backup_id_a = data.get('backup_id_a', '').strip()
        backup_id_b = data.get('backup_id_b', '').strip()
        compare_current = data.get('current', False)

        if not backup_id_a or '..' in backup_id_a or '/' in backup_id_a:
            return jsonify({'success': False, 'error': '无效的备份ID A'}), 400

        path_a = os.path.join(BACKUP_DIR, backup_id_a)
        if not os.path.isfile(path_a):
            return jsonify({'success': False, 'error': '备份A不存在'}), 404
        with open(path_a, 'r', encoding='utf-8') as f:
            content_a = f.read()

        if compare_current:
            content_b, source, err = _read_printer_cfg_content()
            if content_b is None:
                return jsonify({'success': False, 'error': err or '无法读取当前配置'}), 404
            label_b = f'current (printer.cfg via {source})'
        else:
            if not backup_id_b or '..' in backup_id_b or '/' in backup_id_b:
                return jsonify({'success': False, 'error': '无效的备份ID B'}), 400
            path_b = os.path.join(BACKUP_DIR, backup_id_b)
            if not os.path.isfile(path_b):
                return jsonify({'success': False, 'error': '备份B不存在'}), 404
            with open(path_b, 'r', encoding='utf-8') as f:
                content_b = f.read()
            label_b = backup_id_b

        diff_lines = list(difflib.unified_diff(
            content_a.splitlines(keepends=True),
            content_b.splitlines(keepends=True),
            fromfile=backup_id_a,
            tofile=label_b,
        ))
        return jsonify({'success': True, 'diff': diff_lines, 'has_changes': len(diff_lines) > 0})
    except Exception as e:
        logger.exception('配置对比失败')
        return jsonify({'success': False, 'error': str(e)}), 500


def auto_backup_printer_cfg():
    """供其他模块调用的自动备份函数（烧录前使用）"""
    try:
        _ensure_backup_dir()
        content, source, err = _read_printer_cfg_content()
        if content is None:
            logger.warning(f'自动备份失败: {err}')
            return None

        ts = time.strftime('%Y%m%d_%H%M%S')
        backup_id = f'{ts}_{os.urandom(3).hex()}_printer.cfg'
        backup_path = os.path.join(BACKUP_DIR, backup_id)

        with open(backup_path, 'w', encoding='utf-8') as f:
            f.write(content)

        sha = hashlib.sha256(content.encode('utf-8')).hexdigest()
        meta = {
            'filename': 'printer.cfg',
            'timestamp': time.strftime('%Y-%m-%dT%H:%M:%S%z'),
            'source': source or 'auto',
            'sha256': sha,
            'size': len(content.encode('utf-8')),
        }
        _save_backup_meta(backup_id, meta)

        max_backups = config.get('backup', {}).get('max_backups', 10)
        _prune_old_backups(max_backups)

        logger.info(f'自动备份完成: {backup_id}')
        return backup_id
    except Exception as e:
        logger.warning(f'自动备份异常: {e}')
        return None
