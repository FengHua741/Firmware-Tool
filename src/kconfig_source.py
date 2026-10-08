"""
Kconfig 源路径解析 - 让 Klipper Kconfig 解析始终针对"实际被编译的源码"

- 本地模式: 保持原有行为，解析本机 Klipper 目录
- SSH 模式: 将远端 Klipper 的 src/Kconfig 及各平台 Kconfig 同步到本地缓存目录，
  解析器读取缓存目录，保证页面选项（MCU/晶振/BL偏移/通信）与远端可编译参数一致。
  同步失败时优先回退到上一次缓存，其次回退本地路径，避免页面整体不可用。
"""

import hashlib
import json
import os
import posixpath
import shlex
import shutil
import threading
import time

from shared import config, logger, expand_klipper_path
from ssh_manager import SSHManager, is_ssh_mode, run_cmd
from klipper_kconfig_parser import KlipperKconfigParser

# 缓存根目录（与 ssh_manager.LOCAL_CACHE_DIR 同级的独立子目录）
CACHE_ROOT = '/tmp/fwtool_cache/kconfig'
# 远端签名复查最小间隔（秒），避免每个 API 请求都发起 SSH stat
REMOTE_SIGNATURE_TTL = 15
MANIFEST_NAME = '.manifest.json'

_lock = threading.Lock()
_state = {
    'cache_dir': None,
    'checked_at': 0.0,
}


def _kconfig_rel_paths():
    """需要同步的 Kconfig 相对路径（相对 Klipper 根目录）。"""
    rels = ['src/Kconfig']
    for platform_dir in KlipperKconfigParser.PLATFORM_DEFINITIONS:
        rels.append(f'src/{platform_dir}/Kconfig')
    return rels


def _local_path(base_dir, rel):
    return os.path.join(base_dir, *rel.split('/'))


def _read_manifest(cache_dir):
    path = os.path.join(cache_dir, MANIFEST_NAME)
    try:
        with open(path, 'r', encoding='utf-8') as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def _write_manifest(cache_dir, payload):
    path = os.path.join(cache_dir, MANIFEST_NAME)
    try:
        with open(path, 'w', encoding='utf-8') as f:
            json.dump(payload, f, ensure_ascii=False, indent=2)
    except OSError as exc:
        logger.warning(f'写入 Kconfig 同步清单失败: {exc}')


def _manifest_files_exist(cache_dir, manifest):
    """缓存目录中的文件是否与清单一致（远端缺失的平台不参与校验）。"""
    rels = list((manifest.get('signature') or {}).keys())
    if not rels:
        return False
    return all(os.path.isfile(_local_path(cache_dir, rel)) for rel in rels)


def _remote_signature(remote_root):
    """通过一条 SSH 命令获取远端 Kconfig 的 mtime/size 签名。

    返回 dict: {相对路径: "mtime|size"}，仅包含远端实际存在的文件。
    """
    rels = _kconfig_rel_paths()
    quoted = ' '.join(f'"{rel}"' for rel in rels)
    cmd = (
        f'cd {_shell_quote(remote_root)} && '
        f'for f in {quoted}; do if [ -f "$f" ]; then stat -c "%n|%Y|%s" "$f"; fi; done'
    )
    result = run_cmd(cmd, shell=True, capture_output=True, text=True, timeout=20)
    if result.returncode != 0:
        detail = (result.stderr or result.stdout or '').strip()[:200]
        raise RuntimeError(f'读取远端 Kconfig 签名失败: {detail}')

    signature = {}
    for line in (result.stdout or '').splitlines():
        parts = line.strip().split('|')
        if len(parts) != 3:
            continue
        rel = parts[0]
        if rel.startswith('./'):
            rel = rel[2:]
        signature[rel] = f'{parts[1]}|{parts[2]}'
    if not signature:
        raise RuntimeError(f'远端 Klipper 目录中未找到 Kconfig: {remote_root}')
    return signature


def _sync_files(remote_root, cache_dir, signature):
    """通过 SFTP 将远端 Kconfig 下载到本地缓存（先写 staging 再整体替换）。"""
    rels = sorted(signature.keys())
    if not rels:
        raise RuntimeError('没有可同步的 Kconfig 文件')

    staging_dir = cache_dir + '.staging'
    if os.path.isdir(staging_dir):
        shutil.rmtree(staging_dir, ignore_errors=True)

    manager = SSHManager.get_instance()
    sftp = manager.get_sftp()
    try:
        for rel in rels:
            remote_file = posixpath.join(remote_root, rel)
            local_file = _local_path(staging_dir, rel)
            os.makedirs(os.path.dirname(local_file), exist_ok=True)
            sftp.get(remote_file, local_file)
    except Exception:
        shutil.rmtree(staging_dir, ignore_errors=True)
        raise

    os.makedirs(CACHE_ROOT, exist_ok=True)
    backup_dir = cache_dir + '.bak'
    if os.path.isdir(backup_dir):
        shutil.rmtree(backup_dir, ignore_errors=True)
    if os.path.isdir(cache_dir):
        os.replace(cache_dir, backup_dir)
    try:
        os.replace(staging_dir, cache_dir)
    except OSError:
        # 替换失败时恢复旧缓存，保证解析仍可用
        if os.path.isdir(backup_dir) and not os.path.isdir(cache_dir):
            os.replace(backup_dir, cache_dir)
        shutil.rmtree(staging_dir, ignore_errors=True)
        raise
    if os.path.isdir(backup_dir):
        shutil.rmtree(backup_dir, ignore_errors=True)
    logger.info(f'远端 Kconfig 已同步到本地缓存: {cache_dir} ({len(rels)} 个文件)')


def _shell_quote(value):
    return shlex.quote(str(value or ''))


def _resolve_remote_synced_path(raw_path, force=False):
    """SSH 模式：返回同步了远端 Kconfig 的本地缓存目录。"""
    remote_root = expand_klipper_path(raw_path)
    cache_key = hashlib.sha1(
        f"{config.get('ssh_user')}@{config.get('ssh_host')}:"
        f"{config.get('ssh_port', 22)}:{remote_root}".encode('utf-8')
    ).hexdigest()[:12]
    cache_dir = os.path.join(CACHE_ROOT, cache_key)

    with _lock:
        now = time.time()
        fast_ok = (
            not force
            and _state['cache_dir'] == cache_dir
            and os.path.isdir(os.path.join(cache_dir, 'src'))
            and (now - _state['checked_at']) < REMOTE_SIGNATURE_TTL
        )
        if fast_ok:
            return cache_dir

        signature = _remote_signature(remote_root)
        manifest = _read_manifest(cache_dir)
        need_sync = (
            force
            or not _manifest_files_exist(cache_dir, manifest)
            or manifest.get('signature') != signature
        )
        if need_sync:
            _sync_files(remote_root, cache_dir, signature)
            _write_manifest(cache_dir, {
                'signature': signature,
                'remote_root': remote_root,
                'updated_at': now,
            })

        _state['cache_dir'] = cache_dir
        _state['checked_at'] = now
        return cache_dir


def resolve_kconfig_klipper_path(raw_path='~/klipper', force=False):
    """返回用于 Kconfig 解析的本地目录路径。

    - 本地模式: 与 expand_klipper_path(..., force_local=True) 行为一致
    - SSH 模式: 同步远端 Kconfig 到本地缓存后返回缓存目录；
      失败时优先使用旧缓存，其次回退本地路径
    - force=True: 跳过 TTL，强制核对远端签名并按需重新同步（用于"刷新数据库"）
    """
    if not is_ssh_mode():
        return expand_klipper_path(raw_path, force_local=True)

    try:
        return _resolve_remote_synced_path(raw_path, force=force)
    except Exception as exc:
        logger.warning(f'远端 Kconfig 同步失败，降级为本地解析: {exc}')
        with _lock:
            _state['checked_at'] = time.time()
            cached_dir = _state['cache_dir']
        if cached_dir and os.path.isdir(os.path.join(cached_dir, 'src')):
            return cached_dir
        return expand_klipper_path(raw_path, force_local=True)
