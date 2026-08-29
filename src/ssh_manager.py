#!/usr/bin/env python3
"""
SSH 远程执行管理模块
- CmdResult: 统一命令执行结果
- SSHManager: SSH 连接管理（复用、重连、线程安全）
- run_cmd: 统一命令执行函数（自动路由本地/远程）
- 凭据加密存储（Fernet）
- 文件传输（SFTP）
"""

import os
import json
import shlex
import time
import threading
import logging
import subprocess
import re
import paramiko
from urllib.parse import urlsplit

logger = logging.getLogger(__name__)

# ==================== 配置文件读取（避免循环导入） ====================

_CONFIG_FILE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'data', 'config.json')


def _load_config_file():
    """直接从配置文件读取配置（避免 from app import config 的循环导入）"""
    try:
        if os.path.exists(_CONFIG_FILE):
            with open(_CONFIG_FILE, 'r', encoding='utf-8') as f:
                cfg = json.load(f)
                # 兼容尚未由 shared.py 写回磁盘的旧版配置。
                if cfg.get('connection_mode') == 'fast-ssh':
                    cfg['connection_mode'] = 'ssh'
                    cfg['ssh_user'] = (
                        cfg.get('ssh_user')
                        or os.environ.get('FAST_SSH_USER')
                        or cfg.get('fast_ssh_user')
                        or 'root'
                    )
                return cfg
    except Exception:
        pass
    return {}


def _normalize_host_value(value):
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
    host = re.split(r'[/?#]', raw, 1)[0].strip()
    if host.startswith('[') and ']' in host:
        return host[1:host.index(']')]
    if host.count(':') == 1:
        host = host.split(':', 1)[0]
    return host

# ==================== 凭据加密存储 ====================

CREDENTIALS_DIR = os.path.expanduser('~/.firmware-tool')
CREDENTIALS_PATH = os.path.join(CREDENTIALS_DIR, 'ssh_credentials.enc')
KEY_PATH = '/etc/firmware-tool/ssh_key'
KNOWN_HOSTS_PATH = os.path.join(CREDENTIALS_DIR, 'known_hosts')


class _TrustOnFirstUsePolicy(paramiko.MissingHostKeyPolicy):
    """首次连接信任并持久化主机密钥；后续连接由 paramiko 严格校验。

    替代 AutoAddPolicy（任意接受，存在中间人风险）。
    直接操作 client._host_keys（paramiko 2.x/3.x 均存在），兼容两种版本。
    """

    def __init__(self, known_hosts_path):
        self._known_hosts_path = known_hosts_path

    def missing_host_key(self, client, hostname, key):
        with threading.Lock():
            try:
                host_keys = getattr(client, '_host_keys', None)
                if host_keys is None:
                    return
                host_keys.add(hostname, key.get_name(), key)
                try:
                    host_keys.save(self._known_hosts_path)
                except Exception:
                    pass
            except Exception:
                pass


def clear_host_keys():
    """清除已保存的主机密钥信任（主机密钥变更后使用）"""
    try:
        if os.path.exists(KNOWN_HOSTS_PATH):
            os.remove(KNOWN_HOSTS_PATH)
        return True, '主机密钥信任已清除'
    except Exception as e:
        return False, f'清除失败: {e}'

_fernet_instance = None
_fernet_lock = threading.Lock()


def _ensure_credentials_dir():
    os.makedirs(CREDENTIALS_DIR, exist_ok=True)
    for attempt in range(2):
        try:
            os.chmod(CREDENTIALS_DIR, 0o700)
            break
        except PermissionError:
            pass
    try:
        for _f in (CREDENTIALS_PATH, os.path.join(CREDENTIALS_DIR, 'ssh_credentials.json')):
            if os.path.exists(_f):
                os.chmod(_f, 0o600)
    except OSError:
        pass


def _get_fernet():
    """获取或创建 Fernet 加密实例"""
    global _fernet_instance
    with _fernet_lock:
        if _fernet_instance is not None:
            return _fernet_instance
        try:
            from cryptography.fernet import Fernet
        except ImportError:
            logger.error("cryptography 库未安装，无法加密存储凭据")
            return None

        fallback_key_path = os.path.join(CREDENTIALS_DIR, 'ssh_key')
        if os.path.exists(KEY_PATH):
            try:
                with open(KEY_PATH, 'rb') as f:
                    key = f.read()
            except PermissionError:
                # 无权读取 /etc 下的密钥，回退到用户目录
                if os.path.exists(fallback_key_path):
                    with open(fallback_key_path, 'rb') as f:
                        key = f.read()
                else:
                    key = Fernet.generate_key()
                    _ensure_credentials_dir()
                    with open(fallback_key_path, 'wb') as f:
                        f.write(key)
                    os.chmod(fallback_key_path, 0o600)
        else:
            key = Fernet.generate_key()
            try:
                os.makedirs(os.path.dirname(KEY_PATH), exist_ok=True)
                with open(KEY_PATH, 'wb') as f:
                    f.write(key)
                os.chmod(KEY_PATH, 0o600)
            except PermissionError:
                # 非 root 用户无法写入 /etc，回退到用户目录
                _ensure_credentials_dir()
                with open(fallback_key_path, 'wb') as f:
                    f.write(key)
                os.chmod(fallback_key_path, 0o600)

        _fernet_instance = Fernet(key)
        return _fernet_instance


def save_credential(field, value):
    """加密保存凭据字段"""
    fernet = _get_fernet()
    if fernet is None:
        logger.warning("无法加密存储凭据，使用明文（不推荐）")
        creds = _load_creds_raw()
        creds[field] = value
        _save_creds_raw(creds)
        return

    creds = _load_creds_encrypted(fernet) or {}
    creds[field] = value
    encrypted = fernet.encrypt(json.dumps(creds).encode())
    _ensure_credentials_dir()
    with open(CREDENTIALS_PATH, 'wb') as f:
        f.write(encrypted)
    try:
        os.chmod(CREDENTIALS_PATH, 0o600)
    except PermissionError:
        pass


def load_credential(field):
    """解密读取凭据字段"""
    fernet = _get_fernet()
    if fernet is None:
        creds = _load_creds_raw()
        return creds.get(field, '')

    creds = _load_creds_encrypted(fernet)
    if creds is None:
        # 尝试明文回退
        creds = _load_creds_raw()
        return creds.get(field, '')
    return creds.get(field, '')


def has_credential(field):
    """检查凭据字段是否已设置（不返回值）"""
    val = load_credential(field)
    return bool(val)


def _load_creds_encrypted(fernet):
    """从加密文件加载凭据"""
    if not os.path.exists(CREDENTIALS_PATH):
        return {}
    try:
        with open(CREDENTIALS_PATH, 'rb') as f:
            decrypted = fernet.decrypt(f.read())
        return json.loads(decrypted.decode())
    except Exception as e:
        logger.error(f"解密凭据失败: {e}")
        return None


def _load_creds_raw():
    """从明文文件加载凭据（回退方案）"""
    raw_path = os.path.join(CREDENTIALS_DIR, 'ssh_credentials.json')
    if not os.path.exists(raw_path):
        return {}
    try:
        with open(raw_path, 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return {}


def _save_creds_raw(creds):
    """保存明文凭据（回退方案）"""
    raw_path = os.path.join(CREDENTIALS_DIR, 'ssh_credentials.json')
    _ensure_credentials_dir()
    with open(raw_path, 'w', encoding='utf-8') as f:
        json.dump(creds, f, ensure_ascii=False)
    try:
        os.chmod(raw_path, 0o600)
    except PermissionError:
        pass


def clear_credentials():
    """清除所有已保存的凭据"""
    for path in [CREDENTIALS_PATH,
                 os.path.join(CREDENTIALS_DIR, 'ssh_credentials.json')]:
        if os.path.exists(path):
            try:
                os.remove(path)
            except Exception:
                pass


# ==================== CmdResult ====================

class CmdResult:
    """统一命令执行结果，兼容 subprocess.CompletedProcess 接口"""

    def __init__(self, returncode=0, stdout='', stderr=''):
        self.returncode = returncode
        self.stdout = stdout if isinstance(stdout, str) else stdout.decode('utf-8', errors='replace')
        self.stderr = stderr if isinstance(stderr, str) else stderr.decode('utf-8', errors='replace')

    def check_returncode(self):
        if self.returncode != 0:
            raise subprocess.CalledProcessError(
                self.returncode, '', self.stdout, self.stderr)


# ==================== SSHManager ====================

class SSHManager:
    """SSH 连接管理器 — 单连接复用、线程安全、自动重连、断路器保护"""

    _instance = None
    _instance_lock = threading.Lock()

    # 断路器参数
    CIRCUIT_BREAKER_THRESHOLD = 3       # 连续失败 N 次后打开断路器
    CIRCUIT_BREAKER_COOLDOWN_BASE = 15  # 断路器基础冷却时间（秒）
    CIRCUIT_BREAKER_COOLDOWN_MAX = 300  # 断路器最大冷却时间（秒），5 分钟
    CONNECT_TIMEOUT = 8                 # 单次连接超时（秒）
    CONNECT_RETRIES = 2                 # 连接重试次数
    CONNECT_RETRY_INTERVAL = 1          # 重试间隔（秒）
    CMD_RETRIES = 1                     # 命令执行重试次数（不含首次）
    KEEPALIVE_INTERVAL = 15            # SSH keepalive 间隔（秒）
    KEEPALIVE_COUNT_MAX = 3             # keepalive 最大无响应次数
    TRANSPORT_PROBE_TIMEOUT = 5         # 传输层探测超时（秒）

    def __init__(self):
        self._client = None
        self._sftp = None
        self._config_hash_value = None
        self._remote_system = 'unknown'
        self._cmd_lock = threading.Lock()       # 命令执行锁（粒度：命令执行，不含连接建立）
        self._conn_lock = threading.Lock()      # 连接建立锁（粒度：连接建立/重建）
        # 断路器状态（支持指数退避）
        self._consecutive_failures = 0          # 连续失败计数
        self._circuit_open_until = 0            # 断路器打开至该时间戳（0=关闭）
        self._circuit_cooldown_level = 0        # 退避级别，每次断路打开递增

    @classmethod
    def get_instance(cls):
        if cls._instance is None:
            with cls._instance_lock:
                if cls._instance is None:
                    cls._instance = cls()
        return cls._instance

    def _current_ssh_config(self):
        """从配置文件获取当前 SSH 配置"""
        cfg = _load_config_file()
        return {
            'ssh_host': _normalize_host_value(cfg.get('ssh_host', '')),
            'ssh_port': cfg.get('ssh_port', 22),
            'ssh_user': cfg.get('ssh_user', ''),
            'sudo_mode': cfg.get('sudo_mode', 'password'),
        }

    @staticmethod
    def _detect_remote_system(client):
        """通过已认证的 SSH 连接识别远端系统类型。"""
        command = (
            "if grep -qi 'FlyOS-Fast' /etc/issue 2>/dev/null || "
            "command -v flyos-fast-ota >/dev/null 2>&1; "
            "then printf 'flyos-fast'; else printf 'linux'; fi"
        )
        try:
            _, stdout, _ = client.exec_command(command, timeout=5)
            detected = stdout.read(64).decode('utf-8', errors='replace').strip()
            return 'flyos-fast' if detected == 'flyos-fast' else 'linux'
        except Exception as e:
            logger.warning(f"远端系统类型检测失败，按普通 Linux 处理: {e}")
            return 'linux'

    def get_remote_system(self, connect=True):
        """返回远端系统类型；未知时可自动建立 SSH 连接完成检测。"""
        if not is_ssh_mode():
            return 'local'
        if self._remote_system == 'unknown' and connect:
            try:
                self.get_connection()
            except Exception:
                return 'unknown'
        return self._remote_system

    def is_fast_remote(self, connect=True):
        """当前 SSH 目标是否被自动识别为 FlyOS-Fast。"""
        return self.get_remote_system(connect=connect) == 'flyos-fast'

    def _config_hash(self, cfg):
        """计算配置哈希，用于检测变更"""
        return hash(frozenset(cfg.items()))

    def _is_circuit_open(self):
        """检查断路器是否打开（快速失败）"""
        if self._circuit_open_until <= 0:
            return False
        if time.time() < self._circuit_open_until:
            return True
        # 冷却期已过，半开状态：允许尝试
        self._circuit_open_until = 0
        return False

    def _mark_connection_success(self):
        """标记连接成功，重置断路器和退避级别"""
        self._consecutive_failures = 0
        self._circuit_open_until = 0
        self._circuit_cooldown_level = 0

    def _mark_connection_failure(self):
        """标记连接失败，达到阈值时打开断路器（指数退避）"""
        self._consecutive_failures += 1
        if self._consecutive_failures >= self.CIRCUIT_BREAKER_THRESHOLD:
            # 指数退避: cooldown = base * 2^level，上限为 max
            cooldown = min(
                self.CIRCUIT_BREAKER_COOLDOWN_BASE * (2 ** self._circuit_cooldown_level),
                self.CIRCUIT_BREAKER_COOLDOWN_MAX
            )
            self._circuit_open_until = time.time() + cooldown
            self._circuit_cooldown_level += 1
            logger.warning(
                f"SSH 断路器打开: 连续 {self._consecutive_failures} 次失败，"
                f"冷却 {cooldown} 秒（退避级别 {self._circuit_cooldown_level}）"
            )

    def _is_transport_alive(self):
        """深度检测传输层是否真正存活（解决 stale transport 问题）

        检查逻辑：
        1. transport 对象存在
        2. is_active() 返回 True（TCP 层面连接存在）
        3. is_authenticated() 返回 True（已通过认证）
        4. 主动发送 ignore 消息探测（检测半开连接）
        """
        if self._client is None:
            return False
        try:
            transport = self._client.get_transport()
            if transport is None:
                return False
            if not (transport.is_active() and transport.is_authenticated()):
                return False
            # 主动探测: 发送 ignore 消息，如果连接已死会立即触发异常
            try:
                transport.send_ignore()
            except Exception:
                return False
            return True
        except Exception:
            return False

    def get_connection(self):
        """获取活跃的 SSH 连接，必要时建立或重建"""
        import paramiko

        # 断路器打开时快速失败
        if self._is_circuit_open():
            remaining = int(self._circuit_open_until - time.time()) if self._circuit_open_until > 0 else 0
            raise ConnectionError(
                f"SSH 连接不可用（连续 {self._consecutive_failures} 次失败），"
                f"将在 {remaining} 秒后重试"
            )

        # 使用连接锁，防止多线程同时建立连接
        with self._conn_lock:
            # 双重检查：获取锁后再次确认是否已有可用连接
            if self._client is not None:
                if self._is_transport_alive():
                    return self._client
                # 传输层已死，强制断开
                logger.info("SSH 传输层已失效，断开并准备重连")
                self._disconnect()

            cfg = self._current_ssh_config()
            cfg_hash = self._config_hash(cfg)

            # 配置变更 → 断开重建
            if self._config_hash_value is not None and self._config_hash_value != cfg_hash:
                self._disconnect()

            # 建立新连接
            host = cfg.get('ssh_host', '')
            if not host:
                raise ConnectionError("SSH 主机地址未配置")

            self._client = paramiko.SSHClient()
            # 主机密钥校验：优先使用已保存的 known_hosts（严格校验），
            # 首次连接时信任并持久化（TOFU），替代 AutoAddPolicy 的任意接受策略。
            # 兼容 paramiko 2.x（load_host_keys）与 3.x（set_host_keys）
            if os.path.exists(KNOWN_HOSTS_PATH):
                try:
                    if hasattr(self._client, 'load_host_keys'):
                        self._client.load_host_keys(KNOWN_HOSTS_PATH)
                    elif hasattr(self._client, 'set_host_keys'):
                        host_keys = paramiko.HostKeys()
                        try:
                            host_keys.load(KNOWN_HOSTS_PATH)
                        except Exception:
                            pass
                        self._client.set_host_keys(host_keys)
                except Exception:
                    logger.warning("known_hosts 解析失败，将重新建立信任")
            self._client.set_missing_host_key_policy(
                _TrustOnFirstUsePolicy(KNOWN_HOSTS_PATH)
            )

            password = load_credential('ssh_password')

            connect_kwargs = {
                'hostname': host,
                'port': cfg.get('ssh_port', 22),
                'username': cfg.get('ssh_user', ''),
                'password': password or None,
                'timeout': self.CONNECT_TIMEOUT,
                'banner_timeout': self.CONNECT_TIMEOUT,
                'auth_timeout': self.CONNECT_TIMEOUT,
            }

            # 有限重试
            last_error = None
            for attempt in range(self.CONNECT_RETRIES):
                try:
                    self._client.connect(**connect_kwargs)
                    # 设置 keepalive：定期发送心跳包，检测死连接
                    transport = self._client.get_transport()
                    if transport:
                        transport.set_keepalive(self.KEEPALIVE_INTERVAL)
                    self._config_hash_value = cfg_hash
                    self._remote_system = self._detect_remote_system(self._client)
                    self._mark_connection_success()
                    logger.info(
                        f"SSH 连接成功: {cfg['ssh_user']}@{host}:{cfg.get('ssh_port', 22)} "
                        f"(远端系统: {self._remote_system})"
                    )
                    return self._client
                except paramiko.BadHostKeyException as e:
                    # 主机密钥不匹配：目标设备可能已更换/重装系统
                    last_error = ConnectionError(
                        f"SSH 连接失败: 主机密钥不匹配 — 设备 {host} 的密钥已变更。"
                        f"请在设置页点击“清除主机密钥”，确认设备身份后重新连接；"
                        f"也可在服务主机运行 'sudo ssh-keygen -f {KNOWN_HOSTS_PATH} -R {host}'。"
                    )
                    logger.warning(f"SSH Host key mismatch for {host}")
                    break  # 主机密钥错误不会因重试而解决，直接跳出
                except paramiko.SSHException as e:
                    err_str = str(e)
                    # SSH 协议层错误，区分不同场景给出诊断建议
                    if 'Error reading SSH protocol banner' in err_str:
                        # 连接建立后被远端重置（RST），通常表示 SSH 服务过载/重启中
                        last_error = ConnectionError(
                            f"SSH 连接失败: 与 {host}:{cfg.get('ssh_port', 22)} 建立连接后"
                            f"被远端重置 — 目标设备 SSH 服务可能过载、正在重启或端口上运行的不是 SSH 服务。"
                            f"请稍后重试。"
                        )
                        logger.warning(f"SSH protocol banner read failed for {host}: {err_str}")
                        # 这类错误不因立即重试而解决，但仍尝试一次
                    elif 'Authentication failed' in err_str or 'authentication' in err_str.lower():
                        last_error = ConnectionError(
                            f"SSH 认证失败: 用户名或密码错误 ({cfg.get('ssh_user', '')}@{host})"
                        )
                        break  # 认证错误重试无意义
                    else:
                        last_error = e
                        logger.warning(f"SSH 连接尝试 {attempt + 1}/{self.CONNECT_RETRIES} 失败: {e}")
                    if attempt < self.CONNECT_RETRIES - 1:
                        time.sleep(self.CONNECT_RETRY_INTERVAL)
                except (TimeoutError, OSError) as e:
                    # 网络层错误（超时、拒绝连接等）
                    err_str = str(e)
                    if 'Connection refused' in err_str or 'Errno 111' in err_str:
                        last_error = ConnectionError(
                            f"SSH 连接失败: {host}:{cfg.get('ssh_port', 22)} 端口未开放，"
                            f"请检查目标设备是否在线及 SSH 服务是否运行。"
                        )
                    elif 'No route to host' in err_str or 'Errno 113' in err_str:
                        last_error = ConnectionError(
                            f"SSH 连接失败: 无法到达 {host}，请检查网络连接及 IP 地址是否正确。"
                        )
                    elif 'timed out' in err_str.lower() or 'Timeout' in err_str:
                        last_error = ConnectionError(
                            f"SSH 连接超时: {host}:{cfg.get('ssh_port', 22)} 无响应，"
                            f"请检查网络及防火墙设置。"
                        )
                    else:
                        last_error = e
                    logger.warning(f"SSH 连接尝试 {attempt + 1}/{self.CONNECT_RETRIES} 失败: {e}")
                    if attempt < self.CONNECT_RETRIES - 1:
                        time.sleep(self.CONNECT_RETRY_INTERVAL)
                except Exception as e:
                    last_error = e
                    logger.warning(f"SSH 连接尝试 {attempt + 1}/{self.CONNECT_RETRIES} 失败: {e}")
                    if attempt < self.CONNECT_RETRIES - 1:
                        time.sleep(self.CONNECT_RETRY_INTERVAL)

            self._client = None
            self._mark_connection_failure()
            raise ConnectionError(f"SSH 连接失败: {last_error}")

    def get_sftp(self):
        """获取 SFTP 会话"""
        if self._sftp is not None:
            try:
                self._sftp.stat('.')  # 活性检查
                return self._sftp
            except Exception:
                self._sftp = None

        client = self.get_connection()
        self._sftp = client.open_sftp()
        return self._sftp

    def _disconnect(self):
        """断开 SSH 连接"""
        if self._sftp:
            try:
                self._sftp.close()
            except Exception:
                pass
            self._sftp = None
        if self._client:
            try:
                self._client.close()
            except Exception:
                pass
            self._client = None
        self._config_hash_value = None
        self._remote_system = 'unknown'
        # 注意：不断路器状态不在 _disconnect 中重置，
        # 因为断开可能是正常的模式切换，不需要保持断路器状态

    def disconnect(self):
        """公开断开方法 — 同时重置断路器"""
        self._consecutive_failures = 0
        self._circuit_open_until = 0
        if hasattr(self, '_circuit_cooldown_level'):
            self._circuit_cooldown_level = 0
        self._disconnect()

    def force_reconnect(self):
        """强制重连：断开现有连接并重置断路器，然后尝试重新连接

        返回: (success, message)
        """
        # 先完整重置状态
        self.disconnect()
        logger.info("SSH 强制重连: 已重置连接状态，尝试重新连接")
        try:
            self.get_connection()
            cfg = self._current_ssh_config()
            host = cfg.get('ssh_host', '')
            user = cfg.get('ssh_user', '')
            port = cfg.get('ssh_port', 22)
            system_label = '，已识别 FlyOS-Fast' if self.is_fast_remote(connect=False) else ''
            return True, f"重连成功: {user}@{host}:{port}{system_label}"
        except ConnectionError as e:
            return False, f"重连失败: {e}"
        except Exception as e:
            return False, f"重连异常: {e}"

    def get_connection_status(self):
        """获取当前连接状态信息

        返回 dict: {
            'connected': bool,
            'circuit_open': bool,
            'consecutive_failures': int,
            'cooldown_remaining': int (秒),
            'cooldown_level': int,
            'host': str,
            'last_error': str or None
        }
        """
        cfg = self._current_ssh_config()
        is_alive = self._is_transport_alive()
        circuit_open = self._circuit_open_until > 0 and time.time() < self._circuit_open_until
        cooldown_remaining = 0
        if circuit_open and self._circuit_open_until > 0:
            cooldown_remaining = max(0, int(self._circuit_open_until - time.time()))

        return {
            'connected': is_alive,
            'circuit_open': circuit_open,
            'consecutive_failures': self._consecutive_failures,
            'cooldown_remaining': cooldown_remaining,
            'cooldown_level': getattr(self, '_circuit_cooldown_level', 0),
            'host': cfg.get('ssh_host', ''),
            'port': cfg.get('ssh_port', 22),
            'user': cfg.get('ssh_user', ''),
            'remote_system': self._remote_system,
            'is_fast': self._remote_system == 'flyos-fast',
        }

    def wrap_sudo(self, cmd):
        """包装 sudo 命令（密码经 stdin 传输，避免出现在命令行）"""
        cfg = _load_config_file()
        sudo_mode = cfg.get('sudo_mode', 'password')
        if sudo_mode == 'nopasswd':
            return f'sudo {cmd}'
        else:
            return f"sudo -S -p '' {cmd}"

    def _inject_sudo_password(self, cmd):
        """将命令中的 sudo 替换为 sudo -S -p ''，密码经 stdin 传输。

        返回 (cmd, sudo_password)；无需注入时 sudo_password 为 None。
        """
        cfg = _load_config_file()
        sudo_mode = cfg.get('sudo_mode', 'password')
        if sudo_mode == 'nopasswd':
            return cmd, None
        sudo_pwd = load_credential('sudo_password') or load_credential('ssh_password') or ''
        if not sudo_pwd:
            return cmd, None
        if 'sudo -S' in cmd:
            # 已显式使用 sudo -S，由调用方通过 sudo_password 参数提供密码
            return cmd, None
        if not re.search(r'(^|\s)sudo(\s|$)', cmd):
            # 命令中不包含 sudo，无需注入密码
            return cmd, None
        if 'sudo ' in cmd:
            cmd = cmd.replace('sudo ', "sudo -S -p '' ")
        return cmd, sudo_pwd

    def exec_command(self, cmd, timeout=None, sudo=False, inject_sudo=True, sudo_password=None):
        """执行远程命令，返回 CmdResult

        Args:
            inject_sudo: 是否自动注入 sudo 密码（默认True，
                         含管道的 sudo 命令应设为 False 避免破坏管道结构）
            sudo_password: 显式提供 sudo 密码（用于已含 'sudo -S' 的命令）
        """
        # 断路器快速检查（不持锁，避免阻塞其他线程）
        if self._is_circuit_open():
            raise ConnectionError(
                f"SSH 连接不可用（连续 {self._consecutive_failures} 次失败），"
                f"将在 {int(self._circuit_open_until - time.time())} 秒后重试"
            )

        # 处理 sudo: 自动替换命令中的 sudo 为密码版本（密码经 stdin 传输）
        if inject_sudo:
            cmd, injected_pwd = self._inject_sudo_password(cmd)
            if sudo_password is None:
                sudo_password = injected_pwd

        # 自动重连 — 使用类级别配置的重试次数
        last_error = None
        for attempt in range(self.CMD_RETRIES + 1):
            try:
                client = self.get_connection()
                # 命令执行阶段加锁，连接建立已在 get_connection 中用 conn_lock 保护
                with self._cmd_lock:
                    stdin_fd, stdout_fd, stderr_fd = client.exec_command(cmd, timeout=timeout)
                    if sudo_password:
                        try:
                            stdin_fd.write(sudo_password + '\n')
                            stdin_fd.flush()
                        except Exception:
                            pass
                    stdin_fd.channel.shutdown_write()

                    exit_code = stdout_fd.channel.recv_exit_status()
                    stdout = stdout_fd.read().decode('utf-8', errors='replace')
                    stderr = stderr_fd.read().decode('utf-8', errors='replace')

                # 过滤 sudo 密码提示和密码回显
                if sudo_password and stderr:
                    lines = []
                    for line in stderr.split('\n'):
                        if '[sudo]' not in line and 'password' not in line.lower():
                            lines.append(line)
                    stderr = '\n'.join(lines)
                # 过滤密码回显
                if sudo_password and stdout:
                    stdout_lines = []
                    for line in stdout.split('\n'):
                        if line.strip() and line.strip() != sudo_password:
                            stdout_lines.append(line)
                    if stdout_lines:
                        stdout = '\n'.join(stdout_lines)

                return CmdResult(returncode=exit_code, stdout=stdout, stderr=stderr)

            except ConnectionError as e:
                # 断路器拒绝或连接失败，不重试
                if '断路器' in str(e) or '不可用' in str(e):
                    raise
                last_error = e
                if attempt < self.CMD_RETRIES:
                    logger.warning(f"SSH 命令执行失败，尝试重连: {e}")
                    self._disconnect()
                else:
                    raise ConnectionError(f"SSH 命令执行失败: {e}")
            except Exception as e:
                last_error = e
                if attempt < self.CMD_RETRIES:
                    logger.warning(f"SSH 命令执行异常，重试: {e}")
                    self._disconnect()
                else:
                    raise ConnectionError(f"SSH 命令执行失败: {e}")

        raise ConnectionError(f"SSH 命令执行失败: {last_error}")

    def test_connection(self):
        """测试 SSH 连接，返回 (success, message)"""
        try:
            result = self.exec_command('echo OK', timeout=5)
            if result.returncode == 0 and 'OK' in result.stdout:
                cfg = self._current_ssh_config()
                host = cfg.get('ssh_host', '')
                user = cfg.get('ssh_user', '')
                port = cfg.get('ssh_port', 22)
                system_label = '，已识别 FlyOS-Fast' if self.is_fast_remote(connect=False) else ''
                return True, f"已连接 {user}@{host}:{port}{system_label}"
            else:
                return False, f"连接测试失败: {result.stderr}"
        except Exception as e:
            return False, f"连接失败: {str(e)}"

    def exec_command_stream(self, cmd, timeout=None, sudo=False, inject_sudo=True, sudo_password=None):
        """执行远程命令，逐行 yield 输出（用于 SSE 流式响应）

        yield 格式：
        - 普通行: 文本内容
        - 最后: '[DONE] exit_code=0' 或 '[ERROR] exit_code=N message'
        """
        # 断路器快速检查
        if self._is_circuit_open():
            yield f'[ERROR] SSH 连接不可用（连续 {self._consecutive_failures} 次失败）'
            return

        # 处理 sudo（密码经 stdin 传输）
        if inject_sudo:
            cmd, injected_pwd = self._inject_sudo_password(cmd)
            if sudo_password is None:
                sudo_password = injected_pwd

        try:
            client = self.get_connection()
            transport = client.get_transport()
            if not transport:
                yield '[ERROR] SSH transport 不可用'
                return

            channel = transport.open_session()
            if timeout:
                channel.settimeout(timeout)
            # 合并 stderr 到 stdout，简化读取
            channel.set_combine_stderr(True)
            channel.exec_command(cmd)
            if sudo_password:
                try:
                    channel.send(sudo_password + '\n')
                except Exception:
                    pass

            stdout = channel.makefile('r', -1)
            buf = ''
            exit_code = -1

            while True:
                if channel.exit_status_ready() and not channel.recv_ready():
                    exit_code = channel.recv_exit_status()
                    # 读取残留数据
                    while channel.recv_ready():
                        chunk = channel.recv(4096)
                        if chunk:
                            buf += chunk.decode('utf-8', errors='replace')
                        else:
                            break
                    break

                if channel.recv_ready():
                    chunk = channel.recv(4096)
                    if chunk:
                        buf += chunk.decode('utf-8', errors='replace')

                # 输出完整行
                while '\n' in buf:
                    line, buf = buf.split('\n', 1)
                    if line.strip():
                        yield line

                time.sleep(0.05)

            # 输出剩余缓冲
            if buf.strip():
                yield buf.strip()

            if exit_code == 0:
                yield '[DONE] exit_code=0'
            else:
                yield f'[ERROR] exit_code={exit_code}'

        except ConnectionError as e:
            yield f'[ERROR] {e}'
        except Exception as e:
            logger.warning(f"SSH 流式命令执行失败: {e}")
            self._disconnect()
            yield f'[ERROR] {e}'


# ==================== 统一命令执行函数 ====================

def is_ssh_mode():
    """判断当前是否为 SSH 远程模式。"""
    try:
        cfg = _load_config_file()
        return cfg.get('connection_mode') == 'ssh'
    except Exception:
        return False


def is_fast_remote():
    """SSH 建连后自动判断当前远端是否为 FlyOS-Fast。"""
    if not is_ssh_mode():
        return False
    return SSHManager.get_instance().is_fast_remote()


def run_cmd(cmd, shell=False, capture_output=True, text=True,
            timeout=None, sudo=False, env=None, check=False):
    """
    统一命令执行函数 — 根据 connection_mode 自动路由到本地或远程执行。

    参数与 subprocess.run 兼容，新增 sudo 参数。
    """
    if not is_ssh_mode():
        # 本地模式 — 直接 subprocess.run
        kwargs = {
            'capture_output': capture_output,
            'text': text,
        }
        if timeout is not None:
            kwargs['timeout'] = timeout
        if env is not None:
            kwargs['env'] = env
        if shell:
            kwargs['shell'] = True

        if isinstance(cmd, list) and not shell:
            return subprocess.run(cmd, **kwargs)
        else:
            kwargs['shell'] = True
            return subprocess.run(cmd, **kwargs)
    else:
        # SSH 远程模式
        manager = SSHManager.get_instance()

        # 构造远程命令字符串
        if isinstance(cmd, list):
            remote_cmd = ' '.join(shlex.quote(c) for c in cmd)
        else:
            remote_cmd = cmd

        # 环境变量前缀
        if env:
            env_prefix = ' '.join(f'{k}={shlex.quote(v)}' for k, v in env.items())
            remote_cmd = f'env {env_prefix} {remote_cmd}'

        return manager.exec_command(remote_cmd, timeout=timeout, sudo=sudo)


def run_cmd_stream(cmd, shell=False, timeout=None, sudo=False):
    """统一流式命令执行函数 — 根据 connection_mode 自动路由到本地 Popen 或 SSH 流式执行。

    yield 格式（与 SSE 配合使用）:
    - 普通行: 文本内容
    - 最后: '[DONE] exit_code=0' 或 '[ERROR] exit_code=N message'
    """
    if not is_ssh_mode():
        # 本地模式 — subprocess.Popen 逐行读取
        # 注意: Popen 不支持 timeout 参数，需要手动跟踪时间
        try:
            kwargs = {
                'stdout': subprocess.PIPE,
                'stderr': subprocess.STDOUT,
                'text': True,
            }
            if shell:
                kwargs['shell'] = True
            elif isinstance(cmd, str):
                kwargs['shell'] = True

            proc = subprocess.Popen(cmd, **kwargs)
            start_time = time.time()
            for line in iter(proc.stdout.readline, ''):
                # 检查超时
                if timeout and (time.time() - start_time) > timeout:
                    proc.kill()
                    proc.wait()
                    yield '[ERROR] 命令执行超时'
                    return
                stripped = line.rstrip('\n')
                if stripped:
                    yield stripped
            proc.wait()
            if proc.returncode == 0:
                yield '[DONE] exit_code=0'
            else:
                yield f'[ERROR] exit_code={proc.returncode}'
        except Exception as e:
            yield f'[ERROR] {e}'
    else:
        # SSH 远程模式
        manager = SSHManager.get_instance()
        if isinstance(cmd, list):
            remote_cmd = ' '.join(shlex.quote(c) for c in cmd)
        else:
            remote_cmd = cmd
        yield from manager.exec_command_stream(remote_cmd, timeout=timeout, sudo=sudo)


def run_cmd_check(cmd, **kwargs):
    """类似 subprocess.check_output — 失败时抛出 CalledProcessError"""
    result = run_cmd(cmd, **kwargs)
    if result.returncode != 0:
        raise subprocess.CalledProcessError(
            result.returncode, cmd, result.stdout, result.stderr)
    return result.stdout


# ==================== 文件系统替代函数 ====================

def path_exists(path):
    """路径存在性检查 — 自动适配本地/远程"""
    if not is_ssh_mode():
        return os.path.exists(path)

    manager = SSHManager.get_instance()
    try:
        sftp = manager.get_sftp()
        sftp.stat(path)
        return True
    except FileNotFoundError:
        return False
    except IOError:
        return False
    except Exception:
        # SFTP 不可用时回退到命令行
        result = manager.exec_command(f'test -e {shlex.quote(path)} && echo YES || echo NO', timeout=5)
        return 'YES' in result.stdout


def get_file_size(path):
    """获取文件大小 — 自动适配本地/远程"""
    if not is_ssh_mode():
        return os.path.getsize(path)

    manager = SSHManager.get_instance()
    try:
        sftp = manager.get_sftp()
        return sftp.stat(path).st_size
    except Exception:
        result = manager.exec_command(f'stat -c %s {shlex.quote(path)} 2>/dev/null || echo 0', timeout=5)
        try:
            return int(result.stdout.strip())
        except ValueError:
            return 0


def list_dir(path):
    """列出目录内容 — 自动适配本地/远程"""
    if not is_ssh_mode():
        return os.listdir(path)

    manager = SSHManager.get_instance()
    try:
        sftp = manager.get_sftp()
        return sftp.listdir(path)
    except Exception:
        result = manager.exec_command(f'ls -1 {shlex.quote(path)} 2>/dev/null', timeout=5)
        return [f for f in result.stdout.strip().split('\n') if f]


# ==================== 文件传输 ====================

LOCAL_CACHE_DIR = '/tmp/fwtool_cache'
REMOTE_BL_DIR = '/tmp/fwtool_bl'


def ssh_download(remote_path, local_path=None):
    """从远程下载文件到本地"""
    if local_path is None:
        # 默认下载到本地缓存目录
        filename = os.path.basename(remote_path)
        os.makedirs(LOCAL_CACHE_DIR, exist_ok=True)
        local_path = os.path.join(LOCAL_CACHE_DIR, filename)

    manager = SSHManager.get_instance()
    sftp = manager.get_sftp()

    os.makedirs(os.path.dirname(local_path), exist_ok=True)
    sftp.get(remote_path, local_path)
    logger.info(f"SSH 下载: {remote_path} -> {local_path}")
    return local_path


def ssh_upload(local_path, remote_path=None):
    """从本地上传文件到远程"""
    if remote_path is None:
        # 默认上传到远程临时目录
        filename = os.path.basename(local_path)
        remote_path = os.path.join(REMOTE_BL_DIR, filename)

    manager = SSHManager.get_instance()

    # 确保远程目录存在
    manager.exec_command(f'mkdir -p {shlex.quote(os.path.dirname(remote_path))}', timeout=5)

    sftp = manager.get_sftp()
    sftp.put(local_path, remote_path)
    logger.info(f"SSH 上传: {local_path} -> {remote_path}")
    return remote_path


def download_firmware_from_remote(firmware_path):
    """
    从远程下载编译产物到本地缓存。
    返回本地缓存路径（本地模式直接返回原路径）。
    """
    if not is_ssh_mode():
        return firmware_path

    filename = os.path.basename(firmware_path)
    os.makedirs(LOCAL_CACHE_DIR, exist_ok=True)
    local_path = os.path.join(LOCAL_CACHE_DIR, filename)
    ssh_download(firmware_path, local_path)
    return local_path


def upload_bl_firmware_for_remote(local_bl_path):
    """
    将本地 BL 固件上传到远程临时目录。
    返回远程路径（本地模式直接返回原路径）。
    """
    if not is_ssh_mode():
        return local_bl_path

    filename = os.path.basename(local_bl_path)
    remote_path = f'{REMOTE_BL_DIR}/{filename}'
    ssh_upload(local_bl_path, remote_path)
    return remote_path


def cleanup_remote_bl_dir():
    """清理远程 BL 临时目录"""
    if not is_ssh_mode():
        return
    try:
        manager = SSHManager.get_instance()
        manager.exec_command(f'rm -rf {shlex.quote(REMOTE_BL_DIR)}', timeout=5)
    except Exception:
        pass
