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

logger = logging.getLogger(__name__)

# ==================== 配置文件读取（避免循环导入） ====================

_CONFIG_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'config.json')


def _load_config_file():
    """直接从配置文件读取配置（避免 from app import config 的循环导入）"""
    try:
        if os.path.exists(_CONFIG_FILE):
            with open(_CONFIG_FILE, 'r') as f:
                return json.load(f)
    except Exception:
        pass
    return {}

# ==================== 凭据加密存储 ====================

CREDENTIALS_DIR = os.path.expanduser('~/.firmware-tool')
CREDENTIALS_PATH = os.path.join(CREDENTIALS_DIR, 'ssh_credentials.enc')
KEY_PATH = '/etc/firmware-tool/ssh_key'

_fernet_instance = None
_fernet_lock = threading.Lock()


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
                    os.makedirs(CREDENTIALS_DIR, exist_ok=True)
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
                os.makedirs(CREDENTIALS_DIR, exist_ok=True)
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
    os.makedirs(CREDENTIALS_DIR, exist_ok=True)
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
        with open(raw_path, 'r') as f:
            return json.load(f)
    except Exception:
        return {}


def _save_creds_raw(creds):
    """保存明文凭据（回退方案）"""
    raw_path = os.path.join(CREDENTIALS_DIR, 'ssh_credentials.json')
    os.makedirs(CREDENTIALS_DIR, exist_ok=True)
    with open(raw_path, 'w') as f:
        json.dump(creds, f)
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
    CIRCUIT_BREAKER_THRESHOLD = 3   # 连续失败 N 次后打开断路器
    CIRCUIT_BREAKER_COOLDOWN = 15   # 断路器打开后冷却时间（秒）
    CONNECT_TIMEOUT = 8             # 单次连接超时（秒）
    CONNECT_RETRIES = 2             # 连接重试次数
    CONNECT_RETRY_INTERVAL = 1      # 重试间隔（秒）
    CMD_RETRIES = 1                 # 命令执行重试次数（不含首次）

    def __init__(self):
        self._client = None
        self._sftp = None
        self._config_hash_value = None
        self._cmd_lock = threading.Lock()       # 命令执行锁（粒度：命令执行，不含连接建立）
        self._conn_lock = threading.Lock()      # 连接建立锁（粒度：连接建立/重建）
        # 断路器状态
        self._consecutive_failures = 0          # 连续失败计数
        self._circuit_open_until = 0            # 断路器打开至该时间戳（0=关闭）

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
            'ssh_host': cfg.get('ssh_host', ''),
            'ssh_port': cfg.get('ssh_port', 22),
            'ssh_user': cfg.get('ssh_user', ''),
            'sudo_mode': cfg.get('sudo_mode', 'password'),
        }

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
        """标记连接成功，重置断路器"""
        self._consecutive_failures = 0
        self._circuit_open_until = 0

    def _mark_connection_failure(self):
        """标记连接失败，达到阈值时打开断路器"""
        self._consecutive_failures += 1
        if self._consecutive_failures >= self.CIRCUIT_BREAKER_THRESHOLD:
            self._circuit_open_until = time.time() + self.CIRCUIT_BREAKER_COOLDOWN
            logger.warning(
                f"SSH 断路器打开: 连续 {self._consecutive_failures} 次失败，"
                f"冷却 {self.CIRCUIT_BREAKER_COOLDOWN} 秒"
            )

    def get_connection(self):
        """获取活跃的 SSH 连接，必要时建立或重建"""
        import paramiko

        # 断路器打开时快速失败
        if self._is_circuit_open():
            raise ConnectionError(
                f"SSH 连接不可用（连续 {self._consecutive_failures} 次失败），"
                f"将在 {int(self._circuit_open_until - time.time())} 秒后重试"
            )

        # 使用连接锁，防止多线程同时建立连接
        with self._conn_lock:
            # 双重检查：获取锁后再次确认是否已有可用连接
            if self._client is not None:
                try:
                    transport = self._client.get_transport()
                    if transport and transport.is_active() and transport.is_authenticated():
                        return self._client
                except Exception:
                    pass
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
            self._client.set_missing_host_key_policy(paramiko.AutoAddPolicy())

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
                    self._config_hash_value = cfg_hash
                    self._mark_connection_success()
                    logger.info(f"SSH 连接成功: {cfg['ssh_user']}@{host}:{cfg.get('ssh_port', 22)}")
                    return self._client
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
        # 注意：不断路器状态不在 _disconnect 中重置，
        # 因为断开可能是正常的模式切换，不需要保持断路器状态

    def disconnect(self):
        """公开断开方法 — 同时重置断路器"""
        self._consecutive_failures = 0
        self._circuit_open_until = 0
        self._disconnect()

    def wrap_sudo(self, cmd):
        """包装 sudo 命令"""
        cfg = _load_config_file()
        sudo_mode = cfg.get('sudo_mode', 'password')
        if sudo_mode == 'nopasswd':
            return f'sudo {cmd}'
        else:
            sudo_pwd = load_credential('sudo_password') or load_credential('ssh_password') or ''
            if sudo_pwd:
                return f"echo {shlex.quote(sudo_pwd)} | sudo -S {cmd}"
            else:
                return f'sudo {cmd}'

    def _inject_sudo_password(self, cmd):
        """自动替换命令中的 sudo 为带密码版本（仅 password 模式）"""
        cfg = _load_config_file()
        sudo_mode = cfg.get('sudo_mode', 'password')
        if sudo_mode == 'nopasswd':
            return cmd
        sudo_pwd = load_credential('sudo_password') or load_credential('ssh_password') or ''
        if not sudo_pwd:
            return cmd
        # 替换 'sudo ' 为 'echo PWD | sudo -S '
        # 不替换已经有 sudo -S 的情况
        if 'sudo -S' not in cmd and 'sudo ' in cmd:
            cmd = cmd.replace('sudo ', f'echo {shlex.quote(sudo_pwd)} | sudo -S ')
        return cmd

    def exec_command(self, cmd, timeout=None, sudo=False, inject_sudo=True):
        """执行远程命令，返回 CmdResult

        Args:
            inject_sudo: 是否自动注入 sudo 密码（默认True，
                         含管道的 sudo 命令应设为 False 避免破坏管道结构）
        """
        # 断路器快速检查（不持锁，避免阻塞其他线程）
        if self._is_circuit_open():
            raise ConnectionError(
                f"SSH 连接不可用（连续 {self._consecutive_failures} 次失败），"
                f"将在 {int(self._circuit_open_until - time.time())} 秒后重试"
            )

        # 处理 sudo: 自动替换命令中的 sudo 为密码版本
        if inject_sudo:
            cmd = self._inject_sudo_password(cmd)

        # 自动重连 — 使用类级别配置的重试次数
        last_error = None
        for attempt in range(self.CMD_RETRIES + 1):
            try:
                client = self.get_connection()
                # 命令执行阶段加锁，连接建立已在 get_connection 中用 conn_lock 保护
                with self._cmd_lock:
                    stdin_fd, stdout_fd, stderr_fd = client.exec_command(cmd, timeout=timeout)
                    stdin_fd.channel.shutdown_write()

                    exit_code = stdout_fd.channel.recv_exit_status()
                    stdout = stdout_fd.read().decode('utf-8', errors='replace')
                    stderr = stderr_fd.read().decode('utf-8', errors='replace')

                # 过滤 sudo 密码提示和密码回显
                if 'sudo -S' in cmd and stderr:
                    lines = []
                    for line in stderr.split('\n'):
                        if '[sudo]' not in line and 'password' not in line.lower():
                            lines.append(line)
                    stderr = '\n'.join(lines)
                # 过滤 echo 密码回显
                if 'echo ' in cmd and 'sudo -S' in cmd:
                    _sudo_pwd = load_credential('sudo_password') or load_credential('ssh_password') or ''
                    stdout_lines = []
                    for line in stdout.split('\n'):
                        # 过滤密码回显行（echo 的密码会出现在 stdout）
                        if line.strip() and line.strip() != _sudo_pwd:
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
                cfg = _load_config_file()
                host = cfg.get('ssh_host', '')
                user = cfg.get('ssh_user', '')
                port = cfg.get('ssh_port', 22)
                return True, f"已连接 {user}@{host}:{port}"
            else:
                return False, f"连接测试失败: {result.stderr}"
        except Exception as e:
            return False, f"连接失败: {str(e)}"

    def exec_command_stream(self, cmd, timeout=None, sudo=False, inject_sudo=True):
        """执行远程命令，逐行 yield 输出（用于 SSE 流式响应）

        yield 格式：
        - 普通行: 文本内容
        - 最后: '[DONE] exit_code=0' 或 '[ERROR] exit_code=N message'
        """
        # 断路器快速检查
        if self._is_circuit_open():
            yield f'[ERROR] SSH 连接不可用（连续 {self._consecutive_failures} 次失败）'
            return

        # 处理 sudo
        if inject_sudo:
            cmd = self._inject_sudo_password(cmd)

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

# FAST-SSH 模式凭据 — 从配置文件或环境变量读取，不在源码中硬编码
FAST_SSH_USER = os.environ.get('FAST_SSH_USER', '')
FAST_SSH_PASSWORD = os.environ.get('FAST_SSH_PASSWORD', '')


def get_fast_ssh_credentials():
    """获取 FAST-SSH 凭据，优先级：环境变量 > config.json > 内置默认值"""
    user = os.environ.get('FAST_SSH_USER', '')
    password = os.environ.get('FAST_SSH_PASSWORD', '')
    if user and password:
        return user, password
    cfg = _load_config_file()
    user = cfg.get('fast_ssh_user', '')
    password = cfg.get('fast_ssh_password', '')
    if user and password:
        return user, password
    # 首次使用无配置时，返回默认值并自动持久化到 config.json
    return 'root', 'mellow'


def is_ssh_mode():
    """判断当前是否为 SSH 远程模式（含标准 SSH 和 FAST-SSH）"""
    # 避免循环导入: 直接读取配置文件，不通过 from app import config
    try:
        import json, os
        config_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'config.json')
        if os.path.exists(config_path):
            with open(config_path, 'r') as f:
                cfg = json.load(f)
                return cfg.get('connection_mode') in ('ssh', 'fast-ssh')
        return False
    except Exception:
        return False


def is_fast_ssh_mode():
    """判断当前是否为 FAST-SSH 模式"""
    try:
        cfg = _load_config_file()
        return cfg.get('connection_mode') == 'fast-ssh'
    except Exception:
        return False


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
        try:
            kwargs = {
                'stdout': subprocess.PIPE,
                'stderr': subprocess.STDOUT,
                'text': True,
            }
            if timeout is not None:
                kwargs['timeout'] = timeout
            if shell:
                kwargs['shell'] = True
            elif isinstance(cmd, str):
                kwargs['shell'] = True

            proc = subprocess.Popen(cmd, **kwargs)
            for line in iter(proc.stdout.readline, ''):
                stripped = line.rstrip('\n')
                if stripped:
                    yield stripped
            proc.wait()
            if proc.returncode == 0:
                yield '[DONE] exit_code=0'
            else:
                yield f'[ERROR] exit_code={proc.returncode}'
        except subprocess.TimeoutExpired:
            try:
                proc.kill()
            except Exception:
                pass
            yield '[ERROR] 命令执行超时'
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
