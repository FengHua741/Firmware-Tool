#!/usr/bin/env python3
"""
Firmware-Tool 共享资源模块
提供全局常量、配置管理、工具函数等
"""

from flask import Flask, jsonify, request
from flask_cors import CORS
from werkzeug.exceptions import HTTPException
import subprocess
import os
import shlex
import re
import json
import secrets
import time
import pwd
import base64
import logging
import sys
from urllib.parse import urlsplit

# 导入主板配置
from board_config_loader import load_all_boards, load_board_config, get_manufacturers, get_board_types, get_bl_firmwares
from kconfig_can_parser import parse_can_options
from ssh_manager import run_cmd, run_cmd_check, run_cmd_stream, path_exists, get_file_size, list_dir, is_ssh_mode, is_fast_ssh_mode, download_firmware_from_remote, upload_bl_firmware_for_remote, cleanup_remote_bl_dir, SSHManager, get_fast_ssh_credentials

# 配置日志
_log_handlers = [logging.StreamHandler()]
try:
    _file_handler = logging.FileHandler('/tmp/firmware-tool.log')
    try:
        os.chmod('/tmp/firmware-tool.log', 0o600)
    except OSError:
        pass
    _log_handlers.append(_file_handler)
except PermissionError:
    pass  # 无权限写 /tmp 时仅输出到控制台
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s',
    handlers=_log_handlers
)
logger = logging.getLogger(__name__)

# 常见 DFU 设备 VID:PID 映射
DFU_KNOWN_DEVICES = {
    '0483:df11': 'STM32',
    '314b:0106': 'APM32',
}
DFU_KNOWN_VIDPIDS = list(DFU_KNOWN_DEVICES.keys())

# CAN 相关常量
CAN_NETWORK_DIR = '/etc/systemd/network'
CAN_INTERFACES_DIR = '/etc/network/interfaces.d'
CAN_BITRATES = {
    1000000: '1M',
    500000: '500K',
    250000: '250K',
}
BITRATE_VALUES = sorted(CAN_BITRATES.keys(), reverse=True)  # [1000000, 500000, 250000]

# ==================== Flask 应用初始化 ====================
app = Flask(__name__, static_folder='../static')
app.config['SEND_FILE_MAX_AGE_DEFAULT'] = 0

@app.after_request
def add_no_cache_headers(response):
    """为静态文件添加 no-cache 头，确保开发期间始终加载最新文件"""
    if request.path.startswith('/static/'):
        response.headers['Cache-Control'] = 'no-cache, no-store, must-revalidate'
        response.headers['Pragma'] = 'no-cache'
        response.headers['Expires'] = '0'
    return response


@app.after_request
def add_security_headers(response):
    """统一安全响应头：点击劫持 / MIME 嗅探 / CSP / 来源策略"""
    response.headers.setdefault('X-Frame-Options', 'DENY')
    response.headers.setdefault('X-Content-Type-Options', 'nosniff')
    response.headers.setdefault('Referrer-Policy', 'no-referrer')
    response.headers.setdefault(
        'Content-Security-Policy',
        "default-src 'self'; img-src 'self' blob: data:; "
        "style-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com; "
        "script-src 'self' 'unsafe-inline'; "
        "connect-src 'self' ws: wss:; "
        "font-src 'self' data: https://cdnjs.cloudflare.com; "
        "frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
    )
    return response


def safe_error(e):
    """错误脱敏：业务校验类异常返回原文（截断），其余返回通用消息，详细原因仅记日志。"""
    if isinstance(e, (ValueError, ConnectionError, subprocess.TimeoutExpired)):
        return str(e)[:500]
    logger.warning(f"接口异常（响应已脱敏）: {e!r}")
    return '服务器内部错误'


@app.errorhandler(Exception)
def handle_uncaught_exception(e):
    """全局未捕获异常：统一脱敏，避免泄露内部实现细节。"""
    if isinstance(e, HTTPException):
        return e
    logger.exception('未捕获异常')
    return jsonify({'error': '服务器内部错误'}), 500

# 配置路径 - 使用动态路径，不硬编码
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CONFIG_PATH = os.path.join(BASE_DIR, 'data', 'config.json')
# 统一使用 board_configs 目录存放所有配置
BOARD_CONFIGS_DIR = os.path.join(BASE_DIR, 'board_configs')
# 保留 USER_CONFIGS_DIR 和 CONFIGS_DIR 指向同一目录，用于兼容旧代码
USER_CONFIGS_DIR = BOARD_CONFIGS_DIR
CONFIGS_DIR = BOARD_CONFIGS_DIR

# 默认配置
DEFAULT_CONFIG = {
    'port': 9999,
    'bind_host': '127.0.0.1',  # 默认仅监听本机，局域网访问需显式改为 0.0.0.0 并配置 API Token
    'klipper_path': '~/klipper',
    'katapult_path': '~/katapult',
    'json_repo_url': '',  # JSON配置仓库地址
    'last_json_update': None,
    'moonraker_host': '127.0.0.1',
    'moonraker_port': 7125,
    # SSH 远程连接配置
    'connection_mode': 'local',  # 'local', 'ssh' 或 'fast-ssh'
    'ssh_host': '',
    'ssh_port': 22,
    'ssh_user': '',
    'sudo_mode': 'password',  # 'nopasswd' 或 'password'
    # 安全开关默认保持兼容；需要收紧时可在 config.json 或环境变量中启用
    'allowed_origins': [],
    'api_token': '',
    'require_csrf': True,
}

def load_config():
    """加载配置"""
    if os.path.exists(CONFIG_PATH):
        try:
            with open(CONFIG_PATH, 'r', encoding='utf-8') as f:
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
        with open(CONFIG_PATH, 'w', encoding='utf-8') as f:
            json.dump(config, f, indent=2, ensure_ascii=False)
        return True
    except Exception as e:
        logger.error(f"保存配置失败: {e}")
        return False

config = load_config()
# 配置文件权限：仅属主可读写（可能包含 api_token 等敏感配置）
for _cfg_path in (CONFIG_PATH,):
    try:
        os.chmod(_cfg_path, 0o600)
    except OSError:
        pass
# 收紧 SSH 凭据目录/文件权限（700/600）
try:
    from ssh_manager import _ensure_credentials_dir as _ensure_creds
    _ensure_creds()
except Exception:
    pass
PORT = config.get('port', 9999)
CSRF_COOKIE_NAME = 'firmware_tool_csrf'
CSRF_HEADER_NAME = 'X-CSRF-Token'


def _configured_cors_origins():
    raw_origins = os.environ.get('FIRMWARE_TOOL_ALLOWED_ORIGINS', '')
    if raw_origins:
        origins = [item.strip() for item in raw_origins.split(',') if item.strip()]
        return origins
    origins = config.get('allowed_origins') or []
    # 默认不允许跨域（空列表 = 不添加 CORS 头，跨域请求将被浏览器拒绝）
    return origins


CORS(app, origins=_configured_cors_origins())

# WebSocket 全局事件总线
from websocket_manager import init_websocket, broadcast as ws_broadcast
init_websocket(app)


def _is_loopback_addr(addr):
    addr = (addr or '').split(',')[0].strip()
    return addr in ('127.0.0.1', '::1', 'localhost')


@app.before_request
def require_api_token():
    """API Token（可选）与同源 CSRF 校验。

    默认模式（未配置 api_token）：所有请求仅需同源 CSRF 校验（浏览器自动携带），
    无需任何手动配置；仅当用户自愿在 config.json 配置 api_token 后，
    远程（非回环）访问才强制要求 X-API-Token 请求头。
    """
    if request.method == 'OPTIONS' or request.path == '/' or request.path.startswith('/static/'):
        return None
    if not request.path.startswith('/api/'):
        return None

    # Origin/Referer 同源校验：跨站请求一律拒绝（防 CSRF 与跨站调用）
    origin = request.headers.get('Origin') or ''
    referer = request.headers.get('Referer') or ''
    for candidate in (origin, referer):
        if candidate:
            try:
                parsed = urlsplit(candidate)
                if parsed.hostname and parsed.netloc.lower() != request.host.lower():
                    return jsonify({'success': False, 'error': '跨源请求被拒绝'}), 403
            except ValueError:
                return jsonify({'success': False, 'error': '无效的请求来源'}), 403

    token = os.environ.get('FIRMWARE_TOOL_API_TOKEN') or config.get('api_token') or ''
    # Token 仅接受请求头传递（可选启用：配置了 api_token 才强制远程认证）
    supplied = request.headers.get('X-API-Token') or ''
    if token and secrets.compare_digest(supplied, token):
        return None

    if token and not _is_loopback_addr(request.remote_addr):
        return jsonify({
            'success': False,
            'error': '未授权：远程访问需要有效的 API Token（请求头 X-API-Token）'
        }), 401

    require_csrf = config.get('require_csrf', True)
    if not require_csrf:
        return None

    csrf_cookie = request.cookies.get(CSRF_COOKIE_NAME, '')
    csrf_header = request.headers.get(CSRF_HEADER_NAME, '')
    if not csrf_cookie or not csrf_header or not secrets.compare_digest(csrf_cookie, csrf_header):
        return jsonify({'success': False, 'error': '未授权或页面令牌已过期，请刷新页面'}), 401
    return None


def new_csrf_token():
    return secrets.token_urlsafe(32)


def normalize_host_value(value):
    """归一化主机输入，允许用户误填 URL，只保留 hostname/IP。"""
    raw = str(value or '').strip()
    if not raw:
        return ''

    parse_target = raw if re.match(r'^[A-Za-z][A-Za-z0-9+.-]*://', raw) else f'//{raw}'
    try:
        parsed = urlsplit(parse_target)
        if parsed.hostname:
            return parsed.hostname
    except ValueError:
        pass

    # 兜底处理畸形 URL 或裸 IPv6，去掉路径、查询和片段。
    host = re.split(r'[/?#]', raw, 1)[0].strip()
    if host.startswith('[') and ']' in host:
        return host[1:host.index(']')]
    if host.count(':') == 1:
        host = host.split(':', 1)[0]
    return host


for _host_config_key in ('moonraker_host', 'ssh_host'):
    if _host_config_key in config:
        config[_host_config_key] = normalize_host_value(config.get(_host_config_key, ''))


def public_config(raw_config=None):
    """返回可给前端使用的配置，避免泄露凭据和内部安全字段。"""
    source = raw_config or config
    hidden_keys = {
        'api_token',
        'fast_ssh_password',
        'ssh_password',
        'sudo_password',
    }
    return {k: v for k, v in source.items() if k not in hidden_keys}

# FAST-SSH 模式保障：启动时自动设置凭据
if config.get('connection_mode') == 'fast-ssh':
    from ssh_manager import save_credential as _save_cred
    _fast_user, _fast_pwd = get_fast_ssh_credentials()
    config['ssh_user'] = _fast_user
    config['sudo_mode'] = 'password'
    if _fast_pwd:
        _save_cred('ssh_password', _fast_pwd)
        _save_cred('sudo_password', _fast_pwd)
    else:
        logger.warning(
            'FAST-SSH 模式未配置密码（可通过环境变量 FAST_SSH_PASSWORD '
            '或 data/config.json 的 fast_ssh_password 设置），SSH 连接将不可用'
        )
    # 首次使用时只持久化用户名
    if not config.get('fast_ssh_user'):
        config['fast_ssh_user'] = _fast_user

# ==================== 工具函数 ====================

def get_klipper_owner(klipper_path=None):
    """获取 Klipper 安装用户的用户名和家目录"""
    if not klipper_path:
        klipper_path = config.get('klipper_path', '~/klipper')

    # SSH 模式: 通过远程命令获取 SSH 用户的 home 目录
    if is_ssh_mode():
        # FAST-SSH: klipper 安装在 /data/klipper，返回 /data 作为家目录
        if is_fast_ssh_mode() and path_exists('/data/klipper'):
            try:
                stat_info = os.stat('/data/klipper')
                pw = pwd.getpwuid(stat_info.st_uid)
                return pw.pw_name, '/data'
            except (KeyError, OSError):
                pass
        ssh_user = config.get('ssh_user', 'root')
        try:
            result = run_cmd(f'eval echo ~{ssh_user}', shell=True, capture_output=True, text=True, timeout=5)
            remote_home = result.stdout.strip()
            if remote_home and remote_home != f'~{ssh_user}':
                return ssh_user, remote_home
        except Exception:
            pass
        # 回退: 根据用户名推断 home 目录
        if ssh_user == 'root':
            return 'root', '/root'
        return ssh_user, f'/home/{ssh_user}'

    # 本地模式
    if klipper_path.startswith('~'):
        # /data/klipper 优先：FAST/嵌入式系统的常见安装路径
        if path_exists('/data/klipper'):
            klipper_path = '/data/klipper'
        else:
            for user_dir in list_dir('/home'):
                candidate = os.path.join('/home', user_dir, 'klipper')
                if path_exists(candidate):
                    klipper_path = candidate
                    break
    if path_exists(klipper_path):
        try:
            stat_info = os.stat(klipper_path)
            pw = pwd.getpwuid(stat_info.st_uid)
            # 如果 klipper 在 /data 下，使用 /data 作为基目录
            if klipper_path.startswith('/data/'):
                return pw.pw_name, '/data'
            return pw.pw_name, pw.pw_dir
        except (KeyError, OSError):
            pass
    # 回退时也检查 /data/klipper
    if path_exists('/data/klipper'):
        try:
            stat_info = os.stat('/data/klipper')
            pw = pwd.getpwuid(stat_info.st_uid)
            return pw.pw_name, '/data'
        except (KeyError, OSError):
            pass
    for entry in pwd.getpwall():
        if entry.pw_uid >= 1000 and entry.pw_name not in ('nobody', 'nogroup'):
            candidate = os.path.join(entry.pw_dir, 'klipper')
            if path_exists(candidate):
                return entry.pw_name, entry.pw_dir
    return 'fenghua', '/home/fenghua'


def get_moonraker_base_url():
    """获取 Moonraker HTTP API 基础 URL"""
    host = config.get('moonraker_host') or ('127.0.0.1' if not is_ssh_mode() else config.get('ssh_host', '127.0.0.1'))
    host = normalize_host_value(host)
    port = config.get('moonraker_port', 7125)
    return f'http://{host}:{port}'


def expand_klipper_path(path, force_local=False):
    """展开 Klipper 路径，处理 systemd root 运行时 ~ 扩展问题

    Args:
        path: 路径字符串，支持 ~ 前缀
        force_local: 强制使用本地路径解析（用于 Kconfig 解析等需要本地文件的场景）
    """
    if not path.startswith('~'):
        return os.path.expanduser(path)
    # /data/klipper 优先：FAST/嵌入式系统的常见 klipper 安装路径
    if os.path.isdir('/data/klipper'):
        return '/data' + path[1:]
    # 强制本地模式: 直接搜索本地 /home 下的 klipper 目录
    if force_local:
        try:
            for user_dir in os.listdir('/home'):
                candidate = os.path.join('/home', user_dir, 'klipper')
                if os.path.isdir(candidate):
                    return os.path.join('/home', user_dir) + path[1:]
        except OSError:
            pass
        # 回退: 查找 uid >= 1000 的用户
        for entry in pwd.getpwall():
            if entry.pw_uid >= 1000 and entry.pw_name not in ('nobody', 'nogroup'):
                candidate = os.path.join(entry.pw_dir, 'klipper')
                if os.path.isdir(candidate):
                    return entry.pw_dir + path[1:]
        return '/home/fenghua' + path[1:]
    # SSH 模式: 使用 SSH 用户的远程 home 目录
    if is_ssh_mode():
        ssh_user = config.get('ssh_user', 'root')
        if ssh_user == 'root':
            remote_home = '/root'
        else:
            remote_home = f'/home/{ssh_user}'
        try:
            result = run_cmd(f'eval echo ~{ssh_user}', shell=True, capture_output=True, text=True, timeout=5)
            resolved = result.stdout.strip()
            if resolved and resolved != f'~{ssh_user}':
                remote_home = resolved
        except Exception:
            pass
        return remote_home + path[1:]
    # 本地模式
    _, home_dir = get_klipper_owner()
    return home_dir + path[1:]


def get_klipper_python_bin(home_dir):
    """获取 Klipper 的 python 可执行文件路径"""
    # 首先尝试 klippy-env 虚拟环境
    venv_python = os.path.join(home_dir, 'klippy-env', 'bin', 'python3')
    if is_ssh_mode():
        # SSH 模式: 通过 SSH 命令快速检查
        try:
            manager = SSHManager.get_instance()
            result = manager.exec_command(f'test -x {venv_python} && echo YES', timeout=3)
            if 'YES' in result.stdout:
                return venv_python
        except Exception:
            pass
        # 回退到系统 python
        return '/usr/bin/python3'
    else:
        # 本地模式
        if os.path.exists(venv_python):
            return venv_python
        return '/usr/bin/python3'


def sanitize_manufacturer(mfr):
    """清理厂家名称，防止路径遍历"""
    if not mfr:
        return ''
    # 移除路径遍历字符和特殊字符
    safe = os.path.basename(os.path.normpath(mfr))
    # 只允许字母、数字、连字符、下划线
    safe = re.sub(r'[^a-zA-Z0-9_-]', '', safe)
    return safe

def sanitize_config_id(cid):
    """清理配置ID，防止路径遍历"""
    if not cid:
        return ''
    # 只允许字母、数字、连字符、下划线、点（不含路径分隔符）
    safe = re.sub(r'[^a-zA-Z0-9_.\-]', '', cid)
    # 禁止以点开头（防止 .. 或 .）
    safe = safe.lstrip('.')
    # 禁止包含连续点
    while '..' in safe:
        safe = safe.replace('..', '.')
    return safe


def sudo_write_file(path, content):
    """使用 sudo 写入文件内容（本地/远程兼容）"""
    if is_ssh_mode():
        # SSH 模式：两步法写入（先写临时文件，再 sudo cp 到目标）
        # sudo 密码经 stdin 传输，避免出现在远程命令行中
        encoded = base64.b64encode(content.encode()).decode()
        manager = SSHManager.get_instance()
        from ssh_manager import load_credential
        sudo_pwd = load_credential('sudo_password') or load_credential('ssh_password') or ''
        tmp_path = f'/tmp/fwtool_write_{secrets.token_hex(12)}'
        # 第1步：写入临时文件（无需sudo）
        manager.exec_command(f'echo {shlex.quote(encoded)} | base64 -d > {shlex.quote(tmp_path)}', timeout=10, inject_sudo=False)
        # 第2步：sudo cp 到目标
        if sudo_pwd:
            result = manager.exec_command(
                f"sudo -S -p '' cp {shlex.quote(tmp_path)} {shlex.quote(path)}",
                timeout=10, inject_sudo=False, sudo_password=sudo_pwd
            )
        else:
            result = manager.exec_command(f'sudo cp {shlex.quote(tmp_path)} {shlex.quote(path)}', timeout=10, inject_sudo=False)
        # 清理临时文件
        manager.exec_command(f'rm -f {shlex.quote(tmp_path)}', timeout=5, inject_sudo=False)
        if result.returncode != 0:
            raise Exception(f'写入文件失败 {path}: {result.stderr}')
    else:
        # 本地模式：保持原有 Popen 方式
        proc = subprocess.Popen(
            ['sudo', 'tee', path],
            stdin=subprocess.PIPE,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE
        )
        stdout, stderr = proc.communicate(content.encode())
        if proc.returncode != 0:
            raise Exception(f'写入文件失败 {path}: {stderr.decode()}')


def sudo_mkdir(path):
    """使用 sudo 创建目录"""
    run_cmd(f'sudo mkdir -p {shlex.quote(path)}', shell=True, capture_output=True, timeout=10)
