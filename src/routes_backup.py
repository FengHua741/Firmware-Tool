"""
配置备份与回滚蓝图 - 整个 Klipper config 目录 ZIP 备份、恢复、下载与删除。

新版备份保存为包含 ``config/`` 顶层目录的 ZIP。旧版仅保存
``printer.cfg`` 的备份仍可列出、对比、下载和恢复。
"""

import difflib
import hashlib
import json
import os
import posixpath
import shutil
import stat
import time
import urllib.parse
import zipfile

import requests
from flask import Blueprint, jsonify, request, send_file

from shared import (
    config, logger, BASE_DIR,
    get_moonraker_base_url, get_klipper_owner,
    is_ssh_mode, sudo_write_file,
    SSHManager,
    safe_error,
)


backup_bp = Blueprint('backup_api', __name__)

BACKUP_DIR = os.path.join(BASE_DIR, 'data', 'backups')
BACKUP_FORMAT = 'klipper-config-folder-zip-v1'
MAX_ARCHIVE_FILE_COUNT = 20000
MAX_ARCHIVE_UNCOMPRESSED_BYTES = 8 * 1024 * 1024 * 1024
COPY_CHUNK_SIZE = 1024 * 1024


def _ensure_backup_dir():
    os.makedirs(BACKUP_DIR, exist_ok=True)


def _config_root_candidates():
    """返回常见 Klipper/Moonraker config 目录，保持顺序并去重。"""
    _, home_dir = get_klipper_owner()
    candidates = [
        os.path.join(home_dir, 'printer_data', 'config'),
        os.path.join(home_dir, 'klipper_config', 'config'),
        os.path.join(home_dir, 'klipper_config'),
        '/usr/share/printer_data/config',
        '/data/printer_data/config',
    ]
    result = []
    for path in candidates:
        if path not in result:
            result.append(path)
    return result


def _find_local_config_root(require_existing=True):
    candidates = _config_root_candidates()
    for root in candidates:
        expanded = os.path.expanduser(root)
        if os.path.isfile(os.path.join(expanded, 'printer.cfg')):
            return expanded
    if require_existing:
        return None
    return os.path.expanduser(candidates[0]) if candidates else None


def _find_sftp_config_root(sftp):
    for root in _config_root_candidates():
        try:
            attrs = sftp.stat(posixpath.join(root, 'printer.cfg'))
            if stat.S_ISREG(attrs.st_mode):
                return root
        except Exception:
            continue
    return None


def _read_printer_cfg_content():
    """3 层读取 printer.cfg 内容: Moonraker → SSH → Local。"""
    base = get_moonraker_base_url()
    try:
        response = requests.get(
            f'{base}/server/files/config/printer.cfg', timeout=10
        )
        if response.status_code == 200:
            return response.text, 'moonraker', None
    except Exception:
        pass

    if is_ssh_mode():
        try:
            manager = SSHManager.get_instance()
            sftp = manager.get_sftp()
            root = _find_sftp_config_root(sftp)
            if root:
                path = posixpath.join(root, 'printer.cfg')
                with sftp.open(path, 'rb') as stream:
                    return stream.read().decode('utf-8', errors='replace'), 'ssh', path
        except Exception:
            pass
    else:
        root = _find_local_config_root()
        if root:
            path = os.path.join(root, 'printer.cfg')
            try:
                with open(path, 'r', encoding='utf-8', errors='replace') as stream:
                    return stream.read(), 'local', path
            except Exception:
                pass

    return None, None, '未找到 printer.cfg'


def _write_printer_cfg(content):
    """兼容旧备份：通过 Moonraker 上传或 SSH/本地写入 printer.cfg。"""
    base = get_moonraker_base_url()
    try:
        response = requests.get(f'{base}/server/info', timeout=3)
        if response.status_code == 200:
            files = {
                'file': ('printer.cfg', content.encode('utf-8'), 'text/plain')
            }
            data = {'root': 'config', 'path': ''}
            response = requests.post(
                f'{base}/server/files/upload', files=files, data=data, timeout=30
            )
            if response.status_code == 200:
                return True, 'moonraker'
            return False, f'Moonraker 上传失败: HTTP {response.status_code}'
    except Exception:
        pass

    if is_ssh_mode():
        try:
            manager = SSHManager.get_instance()
            sftp = manager.get_sftp()
            root = _find_sftp_config_root(sftp)
            if not root:
                return False, '未找到远程 config 目录'
            target = posixpath.join(root, 'printer.cfg')
            sudo_write_file(target, content)
            return True, 'ssh'
        except Exception as exc:
            return False, safe_error(exc)

    try:
        root = _find_local_config_root(require_existing=False)
        if not root:
            return False, '未找到本地 config 目录'
        os.makedirs(root, exist_ok=True)
        with open(os.path.join(root, 'printer.cfg'), 'w', encoding='utf-8') as stream:
            stream.write(content)
        return True, 'local'
    except Exception as exc:
        return False, safe_error(exc)


def _backup_meta_path(backup_id):
    return os.path.join(BACKUP_DIR, backup_id + '.meta')


def _load_backup_meta(backup_id):
    meta_path = _backup_meta_path(backup_id)
    if not os.path.isfile(meta_path):
        return None
    try:
        with open(meta_path, 'r', encoding='utf-8') as stream:
            return json.load(stream)
    except Exception:
        return None


def _save_backup_meta(backup_id, meta):
    with open(_backup_meta_path(backup_id), 'w', encoding='utf-8') as stream:
        json.dump(meta, stream, ensure_ascii=False, indent=2)


def _is_safe_backup_id(backup_id):
    return bool(backup_id) and '..' not in backup_id and '/' not in backup_id and '\\' not in backup_id


def _normalize_config_relpath(path):
    """规范 ZIP/Moonraker 路径，拒绝绝对路径与目录穿越。"""
    path = str(path or '').strip()
    if not path or '\\' in path or '\x00' in path or path.startswith('/'):
        return ''
    normalized = posixpath.normpath(path)
    if normalized in ('', '.', '..') or normalized.startswith('../'):
        return ''
    return normalized


def _moonraker_file_entries(payload):
    """兼容 Moonraker 新版 list 以及旧版 {files: []} 响应。"""
    result = payload.get('result') if isinstance(payload, dict) else None
    if isinstance(result, list):
        items = result
    elif isinstance(result, dict):
        items = result.get('files', [])
    else:
        return []

    entries = {}
    for item in items:
        if not isinstance(item, dict):
            continue
        raw_path = item.get('path') or item.get('filename') or ''
        path = _normalize_config_relpath(raw_path)
        if not path:
            continue
        entries[path] = {
            'path': path,
            'size': max(0, int(item.get('size') or 0)),
            'modified': float(item.get('modified') or 0),
        }
    return [entries[path] for path in sorted(entries)]


def _archive_file_members(archive):
    """校验 ZIP 成员并返回安全的 config 文件成员。"""
    members = []
    seen = set()
    total_size = 0
    for info in archive.infolist():
        name = info.filename
        if '\\' in name or '\x00' in name or name.startswith('/'):
            raise ValueError('ZIP 中包含非法路径')
        normalized = posixpath.normpath(name)
        if normalized in ('', '.', '..') or normalized.startswith('../'):
            raise ValueError('ZIP 中包含目录穿越路径')
        if normalized == 'config':
            continue
        if not normalized.startswith('config/'):
            raise ValueError('ZIP 缺少 config 顶层目录')
        relative = _normalize_config_relpath(normalized[len('config/'):])
        if not relative:
            if info.is_dir():
                continue
            raise ValueError('ZIP 中包含非法配置路径')
        unix_mode = (info.external_attr >> 16) & 0xFFFF
        if unix_mode and stat.S_ISLNK(unix_mode):
            raise ValueError('ZIP 中不允许符号链接')
        if info.is_dir():
            continue
        if relative in seen:
            raise ValueError(f'ZIP 中存在重复文件: {relative}')
        seen.add(relative)
        total_size += info.file_size
        if len(seen) > MAX_ARCHIVE_FILE_COUNT:
            raise ValueError('ZIP 中的文件数量过多')
        if total_size > MAX_ARCHIVE_UNCOMPRESSED_BYTES:
            raise ValueError('ZIP 解压后体积超过安全限制')
        members.append((relative, info))
    if 'printer.cfg' not in seen:
        raise ValueError('ZIP 中缺少 config/printer.cfg')
    return members, total_size


def _inspect_config_archive(path):
    try:
        with zipfile.ZipFile(path, 'r') as archive:
            members, total_size = _archive_file_members(archive)
            bad_member = archive.testzip()
            if bad_member:
                raise ValueError(f'ZIP 校验失败: {bad_member}')
            return {'file_count': len(members), 'uncompressed_size': total_size}
    except zipfile.BadZipFile as exc:
        raise ValueError('备份 ZIP 已损坏') from exc


def _sha256_file(path):
    digest = hashlib.sha256()
    with open(path, 'rb') as stream:
        while True:
            chunk = stream.read(COPY_CHUNK_SIZE)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()


def _download_moonraker_archive(base, remote_name, backup_path):
    encoded = urllib.parse.quote(f'config/{remote_name}', safe='/')
    with requests.get(
        f'{base}/server/files/{encoded}', stream=True, timeout=(10, 300)
    ) as response:
        if response.status_code != 200:
            raise ValueError(f'Moonraker 下载 ZIP 失败: HTTP {response.status_code}')
        with open(backup_path, 'wb') as stream:
            for chunk in response.iter_content(COPY_CHUNK_SIZE):
                if chunk:
                    stream.write(chunk)


def _create_moonraker_archive_direct(base, entries, backup_path):
    """Moonraker 无 ZIP API 时逐文件流式生成本地 ZIP。"""
    with zipfile.ZipFile(
        backup_path, 'w', compression=zipfile.ZIP_DEFLATED, allowZip64=True
    ) as archive:
        archive.writestr('config/', b'')
        for entry in entries:
            relative = entry['path']
            encoded = urllib.parse.quote(f'config/{relative}', safe='/')
            with requests.get(
                f'{base}/server/files/{encoded}', stream=True, timeout=(10, 300)
            ) as response:
                if response.status_code != 200:
                    raise ValueError(
                        f'Moonraker 读取 {relative} 失败: HTTP {response.status_code}'
                    )
                info = zipfile.ZipInfo(f'config/{relative}')
                info.compress_type = zipfile.ZIP_DEFLATED
                info.external_attr = 0o100600 << 16
                with archive.open(info, 'w', force_zip64=True) as target:
                    for chunk in response.iter_content(COPY_CHUNK_SIZE):
                        if chunk:
                            target.write(chunk)


def _try_create_moonraker_archive(backup_path):
    """通过 Moonraker 备份 config；不可用时返回 None 供文件系统回退。"""
    base = get_moonraker_base_url()
    try:
        response = requests.get(
            f'{base}/server/files/list?root=config', timeout=15
        )
    except Exception:
        return None
    if response.status_code != 200:
        return None

    try:
        entries = _moonraker_file_entries(response.json())
    except Exception as exc:
        logger.debug(f'Moonraker config 文件列表解析失败: {exc}')
        return None
    if not entries or not any(item['path'] == 'printer.cfg' for item in entries):
        raise ValueError('Moonraker config 目录中未找到 printer.cfg')

    remote_name = f'.firmware-tool-backup-{os.urandom(8).hex()}.zip'
    remote_path = f'config/{remote_name}'
    items = [f"config/{item['path']}" for item in entries]
    created_remote = False
    try:
        try:
            response = requests.post(
                f'{base}/server/files/zip',
                json={'dest': remote_path, 'items': items, 'store_only': False},
                timeout=600,
            )
            if response.status_code == 200:
                created_remote = True
                _download_moonraker_archive(base, remote_name, backup_path)
            else:
                logger.info(
                    'Moonraker ZIP API 返回 HTTP %s，改用逐文件打包',
                    response.status_code,
                )
                _create_moonraker_archive_direct(base, entries, backup_path)
        except requests.RequestException as exc:
            logger.info(f'Moonraker ZIP API 不可用，改用逐文件打包: {exc}')
            _create_moonraker_archive_direct(base, entries, backup_path)
        stats = _inspect_config_archive(backup_path)
        return 'moonraker', stats
    finally:
        if created_remote:
            encoded = urllib.parse.quote(remote_path, safe='/')
            try:
                requests.delete(f'{base}/server/files/{encoded}', timeout=30)
            except Exception:
                logger.warning(f'清理 Moonraker 临时 ZIP 失败: {remote_path}')


def _write_sftp_archive(backup_path):
    manager = SSHManager.get_instance()
    sftp = manager.get_sftp()
    root = _find_sftp_config_root(sftp)
    if not root:
        raise ValueError('未找到远程 Klipper config 目录')

    file_count = 0
    with zipfile.ZipFile(
        backup_path, 'w', compression=zipfile.ZIP_DEFLATED, allowZip64=True
    ) as archive:
        archive.writestr('config/', b'')

        def walk(remote_dir, relative_dir=''):
            nonlocal file_count
            for attrs in sorted(sftp.listdir_attr(remote_dir), key=lambda item: item.filename):
                if attrs.filename in ('.', '..'):
                    continue
                remote_path = posixpath.join(remote_dir, attrs.filename)
                relative = posixpath.join(relative_dir, attrs.filename)
                archive_name = f'config/{relative}'
                mode = attrs.st_mode
                if stat.S_ISDIR(mode):
                    archive.writestr(archive_name.rstrip('/') + '/', b'')
                    walk(remote_path, relative)
                elif stat.S_ISREG(mode):
                    info = zipfile.ZipInfo(archive_name)
                    info.compress_type = zipfile.ZIP_DEFLATED
                    info.external_attr = (mode & 0xFFFF) << 16
                    with sftp.open(remote_path, 'rb') as source:
                        with archive.open(info, 'w', force_zip64=True) as target:
                            shutil.copyfileobj(source, target, COPY_CHUNK_SIZE)
                    file_count += 1
                    if file_count > MAX_ARCHIVE_FILE_COUNT:
                        raise ValueError('config 目录中的文件数量过多')

        walk(root)
    return 'ssh', _inspect_config_archive(backup_path)


def _write_local_archive(backup_path):
    root = _find_local_config_root()
    if not root:
        raise ValueError('未找到本地 Klipper config 目录')
    backup_real = os.path.realpath(backup_path)
    file_count = 0
    with zipfile.ZipFile(
        backup_path, 'w', compression=zipfile.ZIP_DEFLATED, allowZip64=True
    ) as archive:
        archive.writestr('config/', b'')
        for current_dir, dirs, files in os.walk(root, followlinks=False):
            dirs[:] = sorted(
                name for name in dirs
                if not os.path.islink(os.path.join(current_dir, name))
            )
            relative_dir = os.path.relpath(current_dir, root)
            if relative_dir != '.':
                archive.writestr(
                    f"config/{relative_dir.replace(os.sep, '/')}/", b''
                )
            for filename in sorted(files):
                source_path = os.path.join(current_dir, filename)
                if os.path.islink(source_path) or not os.path.isfile(source_path):
                    continue
                if os.path.realpath(source_path) == backup_real:
                    continue
                relative = os.path.relpath(source_path, root).replace(os.sep, '/')
                archive.write(source_path, f'config/{relative}')
                file_count += 1
                if file_count > MAX_ARCHIVE_FILE_COUNT:
                    raise ValueError('config 目录中的文件数量过多')
    return 'local', _inspect_config_archive(backup_path)


def _create_config_folder_archive(backup_path):
    moonraker_result = _try_create_moonraker_archive(backup_path)
    if moonraker_result is not None:
        return moonraker_result
    if is_ssh_mode():
        return _write_sftp_archive(backup_path)
    return _write_local_archive(backup_path)


def _create_backup_record():
    _ensure_backup_dir()
    timestamp_id = time.strftime('%Y%m%d_%H%M%S')
    backup_id = f'{timestamp_id}_{os.urandom(3).hex()}_config.zip'
    backup_path = os.path.join(BACKUP_DIR, backup_id)
    try:
        source, stats = _create_config_folder_archive(backup_path)
        archive_size = os.path.getsize(backup_path)
        meta = {
            'filename': 'config.zip',
            'timestamp': time.strftime('%Y-%m-%dT%H:%M:%S%z'),
            'source': source,
            'format': BACKUP_FORMAT,
            'sha256': _sha256_file(backup_path),
            'size': archive_size,
            'uncompressed_size': stats['uncompressed_size'],
            'file_count': stats['file_count'],
        }
        _save_backup_meta(backup_id, meta)
        max_backups = max(1, int(config.get('backup', {}).get('max_backups', 10)))
        _prune_old_backups(max_backups)
        return backup_id, meta
    except Exception:
        for path in (backup_path, _backup_meta_path(backup_id)):
            if os.path.isfile(path):
                os.remove(path)
        raise


def _ordered_archive_members(members):
    """恢复 printer.cfg 最后写入，降低 include 尚未恢复时的短暂不一致。"""
    return sorted(members, key=lambda item: (item[0] == 'printer.cfg', item[0]))


def _try_restore_via_moonraker(backup_path):
    base = get_moonraker_base_url()
    try:
        response = requests.get(f'{base}/server/info', timeout=5)
    except Exception:
        return None
    if response.status_code != 200:
        return None

    with zipfile.ZipFile(backup_path, 'r') as archive:
        members, _ = _archive_file_members(archive)
        restored = 0
        for relative, info in _ordered_archive_members(members):
            payload = archive.read(info)
            files = {
                'file': (
                    posixpath.basename(relative), payload, 'application/octet-stream'
                )
            }
            data = {
                'root': 'config',
                'path': posixpath.dirname(relative),
            }
            response = requests.post(
                f'{base}/server/files/upload', files=files, data=data, timeout=300
            )
            if response.status_code != 200:
                return False, (
                    f'Moonraker 写入 {relative} 失败: HTTP {response.status_code}'
                ), restored
            restored += 1
    return True, 'moonraker', restored


def _sftp_makedirs(sftp, path):
    current = '/' if path.startswith('/') else ''
    for part in path.strip('/').split('/'):
        if not part:
            continue
        current = posixpath.join(current, part)
        try:
            attrs = sftp.stat(current)
            if not stat.S_ISDIR(attrs.st_mode):
                raise ValueError(f'远程路径不是目录: {current}')
        except FileNotFoundError:
            sftp.mkdir(current)
        except OSError:
            try:
                sftp.mkdir(current)
            except OSError:
                attrs = sftp.stat(current)
                if not stat.S_ISDIR(attrs.st_mode):
                    raise


def _restore_via_sftp(backup_path):
    manager = SSHManager.get_instance()
    sftp = manager.get_sftp()
    root = _find_sftp_config_root(sftp)
    if not root:
        raise ValueError('未找到远程 Klipper config 目录')

    with zipfile.ZipFile(backup_path, 'r') as archive:
        members, _ = _archive_file_members(archive)
        restored = 0
        for relative, info in _ordered_archive_members(members):
            target = posixpath.join(root, relative)
            _sftp_makedirs(sftp, posixpath.dirname(target))
            with archive.open(info, 'r') as source:
                with sftp.open(target, 'wb') as output:
                    shutil.copyfileobj(source, output, COPY_CHUNK_SIZE)
            restored += 1
    return True, 'ssh', restored


def _restore_locally(backup_path):
    root = _find_local_config_root(require_existing=False)
    if not root:
        raise ValueError('未找到本地 Klipper config 目录')
    root_abs = os.path.abspath(root)
    os.makedirs(root_abs, exist_ok=True)
    root_real = os.path.realpath(root_abs)

    with zipfile.ZipFile(backup_path, 'r') as archive:
        members, _ = _archive_file_members(archive)
        restored = 0
        for relative, info in _ordered_archive_members(members):
            target = os.path.abspath(os.path.join(root_abs, *relative.split('/')))
            parent = os.path.dirname(target)
            try:
                if os.path.commonpath([root_abs, target]) != root_abs:
                    raise ValueError('ZIP 中包含越界路径')
                # 防止当前 config 目录中已存在的符号链接将恢复目标引向目录外。
                if os.path.commonpath([root_real, os.path.realpath(parent)]) != root_real:
                    raise ValueError('config 目录中的符号链接指向了外部路径')
                if os.path.lexists(target) and os.path.islink(target):
                    raise ValueError(f'恢复目标是符号链接: {relative}')
            except ValueError as exc:
                raise ValueError('ZIP 中包含越界路径') from exc
            os.makedirs(parent, exist_ok=True)
            with archive.open(info, 'r') as source:
                with open(target, 'wb') as output:
                    shutil.copyfileobj(source, output, COPY_CHUNK_SIZE)
            restored += 1
    return True, 'local', restored


def _restore_config_archive(backup_path):
    _inspect_config_archive(backup_path)
    moonraker_result = _try_restore_via_moonraker(backup_path)
    if moonraker_result is not None:
        return moonraker_result
    if is_ssh_mode():
        return _restore_via_sftp(backup_path)
    return _restore_locally(backup_path)


def _read_backup_printer_cfg(backup_id):
    path = os.path.join(BACKUP_DIR, backup_id)
    if not os.path.isfile(path):
        raise FileNotFoundError(path)
    if zipfile.is_zipfile(path):
        with zipfile.ZipFile(path, 'r') as archive:
            members, _ = _archive_file_members(archive)
            printer_info = next(
                (info for relative, info in members if relative == 'printer.cfg'),
                None,
            )
            if printer_info is None:
                raise ValueError('ZIP 中缺少 config/printer.cfg')
            return archive.read(printer_info).decode('utf-8', errors='replace')
    with open(path, 'r', encoding='utf-8', errors='replace') as stream:
        return stream.read()


def _delete_backup_files(backup_id):
    deleted = False
    for path in (os.path.join(BACKUP_DIR, backup_id), _backup_meta_path(backup_id)):
        if os.path.isfile(path):
            os.remove(path)
            deleted = True
    return deleted


@backup_bp.route('/api/backup/config', methods=['POST'])
def create_backup():
    """将整个 Klipper config 目录打包为 ZIP。"""
    try:
        backup_id, meta = _create_backup_record()
        try:
            from routes_notifications import push_notification
            push_notification(
                'backup_created', '配置目录备份已创建',
                f"{backup_id}（{meta['file_count']} 个文件）", 'info'
            )
        except Exception:
            pass
        return jsonify({
            'success': True,
            'backup_id': backup_id,
            'size': meta['size'],
            'uncompressed_size': meta['uncompressed_size'],
            'file_count': meta['file_count'],
            'source': meta['source'],
        })
    except ValueError as exc:
        logger.warning(f'创建配置目录 ZIP 失败: {exc}')
        return jsonify({'success': False, 'error': str(exc)}), 400
    except Exception as exc:
        logger.exception('创建配置目录 ZIP 失败')
        return jsonify({'success': False, 'error': safe_error(exc)}), 500


@backup_bp.route('/api/backup/list')
def list_backups():
    """列出所有新旧格式备份。"""
    try:
        _ensure_backup_dir()
        backups = []
        for filename in sorted(os.listdir(BACKUP_DIR), reverse=True):
            if not filename.endswith('.meta'):
                continue
            backup_id = filename[:-5]
            meta = _load_backup_meta(backup_id)
            if meta:
                meta['id'] = backup_id
                backups.append(meta)
            else:
                path = os.path.join(BACKUP_DIR, backup_id)
                if os.path.isfile(path):
                    backups.append({
                        'id': backup_id,
                        'filename': backup_id,
                        'timestamp': '',
                        'source': 'unknown',
                        'size': os.path.getsize(path),
                        'file_count': 1,
                    })
        return jsonify({'success': True, 'backups': backups})
    except Exception as exc:
        logger.exception('列出备份失败')
        return jsonify({'success': False, 'error': safe_error(exc)}), 500


@backup_bp.route('/api/backup/<backup_id>/download')
def download_backup(backup_id):
    """下载 ZIP 或兼容的旧版单文件备份。"""
    if not _is_safe_backup_id(backup_id):
        return jsonify({'success': False, 'error': '无效的备份ID'}), 400
    path = os.path.join(BACKUP_DIR, backup_id)
    if not os.path.isfile(path):
        return jsonify({'success': False, 'error': '备份不存在'}), 404
    return send_file(path, as_attachment=True, download_name=backup_id)


@backup_bp.route('/api/backup/rollback', methods=['POST'])
def rollback_backup():
    """恢复整目录 ZIP；旧版备份只恢复 printer.cfg。"""
    try:
        data = request.get_json(silent=True) or {}
        backup_id = str(data.get('backup_id', '')).strip()
        if not _is_safe_backup_id(backup_id):
            return jsonify({'success': False, 'error': '无效的备份ID'}), 400
        backup_path = os.path.join(BACKUP_DIR, backup_id)
        if not os.path.isfile(backup_path):
            return jsonify({'success': False, 'error': '备份文件不存在'}), 404

        if zipfile.is_zipfile(backup_path):
            ok, result, restored = _restore_config_archive(backup_path)
            if ok:
                return jsonify({
                    'success': True,
                    'message': f'已恢复 config 目录中的 {restored} 个文件',
                    'source': result,
                    'file_count': restored,
                })
            return jsonify({
                'success': False,
                'error': result,
                'restored_count': restored,
            }), 500

        if backup_id.lower().endswith('.zip'):
            return jsonify({'success': False, 'error': '备份 ZIP 已损坏'}), 400
        content = _read_backup_printer_cfg(backup_id)
        ok, result = _write_printer_cfg(content)
        if ok:
            return jsonify({
                'success': True,
                'message': '旧版备份已恢复到 printer.cfg',
                'source': result,
                'file_count': 1,
            })
        return jsonify({'success': False, 'error': f'写入失败: {result}'}), 500
    except ValueError as exc:
        return jsonify({'success': False, 'error': str(exc)}), 400
    except Exception as exc:
        logger.exception('恢复备份失败')
        return jsonify({'success': False, 'error': safe_error(exc)}), 500


@backup_bp.route('/api/backup/<backup_id>', methods=['DELETE'])
def delete_backup(backup_id):
    """删除指定备份及其元数据。"""
    try:
        if not _is_safe_backup_id(backup_id):
            return jsonify({'success': False, 'error': '无效的备份ID'}), 400
        if _delete_backup_files(backup_id):
            return jsonify({'success': True, 'message': '备份已删除'})
        return jsonify({'success': False, 'error': '备份不存在'}), 404
    except Exception as exc:
        logger.exception('删除备份失败')
        return jsonify({'success': False, 'error': safe_error(exc)}), 500


@backup_bp.route('/api/backup/settings')
def get_backup_settings():
    backup_cfg = config.get('backup', {})
    return jsonify({
        'success': True,
        'auto_backup': backup_cfg.get('auto_backup', False),
        'max_backups': backup_cfg.get('max_backups', 10),
    })


@backup_bp.route('/api/backup/settings', methods=['POST'])
def update_backup_settings():
    try:
        data = request.get_json(silent=True) or {}
        backup_cfg = config.get('backup', {})
        if 'auto_backup' in data:
            backup_cfg['auto_backup'] = bool(data['auto_backup'])
        if 'max_backups' in data:
            backup_cfg['max_backups'] = max(1, int(data['max_backups']))
        config['backup'] = backup_cfg

        config_path = os.path.join(BASE_DIR, 'data', 'config.json')
        with open(config_path, 'w', encoding='utf-8') as stream:
            json.dump(config, stream, ensure_ascii=False, indent=2)
        return jsonify({'success': True, 'settings': backup_cfg})
    except Exception as exc:
        logger.exception('更新备份设置失败')
        return jsonify({'success': False, 'error': safe_error(exc)}), 500


def _prune_old_backups(max_count):
    """保留最近 max_count 个备份，删除多余的。"""
    try:
        _ensure_backup_dir()
        backup_ids = []
        for filename in os.listdir(BACKUP_DIR):
            if filename.endswith('.meta'):
                backup_id = filename[:-5]
                if os.path.isfile(os.path.join(BACKUP_DIR, backup_id)):
                    backup_ids.append(backup_id)
        backup_ids.sort(reverse=True)
        for old_id in backup_ids[max_count:]:
            _delete_backup_files(old_id)
    except Exception:
        logger.warning('清理旧配置备份失败', exc_info=True)


@backup_bp.route('/api/backup/diff', methods=['POST'])
def diff_backups():
    """对比 ZIP/旧备份中的 printer.cfg。"""
    try:
        data = request.get_json(silent=True) or {}
        backup_id_a = str(data.get('backup_id_a', '')).strip()
        backup_id_b = str(data.get('backup_id_b', '')).strip()
        compare_current = bool(data.get('current', False))
        if not _is_safe_backup_id(backup_id_a):
            return jsonify({'success': False, 'error': '无效的备份ID A'}), 400
        try:
            content_a = _read_backup_printer_cfg(backup_id_a)
        except FileNotFoundError:
            return jsonify({'success': False, 'error': '备份A不存在'}), 404

        if compare_current:
            content_b, source, error = _read_printer_cfg_content()
            if content_b is None:
                return jsonify({
                    'success': False,
                    'error': error or '无法读取当前配置',
                }), 404
            label_b = f'current (printer.cfg via {source})'
        else:
            if not _is_safe_backup_id(backup_id_b):
                return jsonify({'success': False, 'error': '无效的备份ID B'}), 400
            try:
                content_b = _read_backup_printer_cfg(backup_id_b)
            except FileNotFoundError:
                return jsonify({'success': False, 'error': '备份B不存在'}), 404
            label_b = backup_id_b

        diff_lines = list(difflib.unified_diff(
            content_a.splitlines(keepends=True),
            content_b.splitlines(keepends=True),
            fromfile=backup_id_a,
            tofile=label_b,
        ))
        return jsonify({
            'success': True,
            'diff': diff_lines,
            'has_changes': bool(diff_lines),
        })
    except ValueError as exc:
        return jsonify({'success': False, 'error': str(exc)}), 400
    except Exception as exc:
        logger.exception('配置对比失败')
        return jsonify({'success': False, 'error': safe_error(exc)}), 500


def auto_backup_printer_cfg():
    """供烧录流程调用：自动备份整个 config 目录，保留旧函数名兼容调用方。"""
    try:
        backup_id, meta = _create_backup_record()
        logger.info(
            '自动备份 config 目录完成: %s (%s 个文件)',
            backup_id,
            meta['file_count'],
        )
        return backup_id
    except Exception as exc:
        logger.warning(f'自动备份 config 目录异常: {exc}')
        return None
