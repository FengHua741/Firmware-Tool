"""
系统设置 + CAN管理蓝图 - SSH配置、CAN配置诊断、时区、服务管理等
"""

from flask import Blueprint, jsonify, request
import subprocess
import os
import re
import time
import shlex

from shared import (
    app, config, logger, BASE_DIR,
    CAN_NETWORK_DIR, CAN_INTERFACES_DIR, CAN_BITRATES, BITRATE_VALUES,
    run_cmd, is_ssh_mode,
    expand_klipper_path, sudo_write_file, sudo_mkdir,
    SSHManager, get_fast_ssh_credentials, public_config,
)
from routes_system import _ssh_connection_status, _update_ssh_disconnect_status, _normalize_service_name

settings_bp = Blueprint('settings', __name__)


def _coerce_port(value, name):
    try:
        port = int(value)
    except (TypeError, ValueError):
        raise ValueError(f'{name} 必须是数字')
    if port < 1 or port > 65535:
        raise ValueError(f'{name} 范围必须是 1-65535')
    return port


def _clean_setting_string(value, name, max_len=300):
    value = str(value or '').strip()
    if len(value) > max_len:
        raise ValueError(f'{name} 过长')
    if '\n' in value or '\r' in value or '\x00' in value:
        raise ValueError(f'{name} 包含非法字符')
    return value


def _clean_secret(value, name, max_len=1000):
    value = str(value or '')
    if len(value) > max_len:
        raise ValueError(f'{name} 过长')
    if '\x00' in value:
        raise ValueError(f'{name} 包含非法字符')
    return value


# ==================== 系统设置 API ====================
@settings_bp.route('/api/settings/config', methods=['GET', 'POST'])
def handle_config():
    """获取或更新系统配置"""
    from shared import config as _config, save_config, PORT

    if request.method == 'GET':
        return jsonify(public_config(_config))
    else:
        data = request.get_json(silent=True) or {}
        old_mode = _config.get('connection_mode', 'local')

        try:
            if 'port' in data:
                _config['port'] = _coerce_port(data['port'], '服务端口')
            if 'moonraker_port' in data:
                _config['moonraker_port'] = _coerce_port(data['moonraker_port'], 'Moonraker 端口')
            if 'ssh_port' in data:
                _config['ssh_port'] = _coerce_port(data['ssh_port'], 'SSH 端口')

            for key, label in [
                ('klipper_path', 'Klipper 路径'),
                ('katapult_path', 'Katapult 路径'),
                ('json_repo_url', 'JSON 仓库地址'),
                ('bind_host', '监听地址'),
                ('moonraker_host', 'Moonraker 地址'),
                ('ssh_host', 'SSH 地址'),
                ('ssh_user', 'SSH 用户'),
            ]:
                if key in data:
                    _config[key] = _clean_setting_string(data[key], label)

            if 'bind_host' in data and not re.match(r'^[A-Za-z0-9:_.-]{1,120}$', _config['bind_host']):
                raise ValueError('监听地址格式无效')

            if 'connection_mode' in data:
                mode = _clean_setting_string(data['connection_mode'], '连接模式', 20)
                if mode not in ('local', 'ssh', 'fast-ssh'):
                    raise ValueError('连接模式无效')
                _config['connection_mode'] = mode

            if 'sudo_mode' in data:
                sudo_mode = _clean_setting_string(data['sudo_mode'], 'sudo 模式', 20)
                if sudo_mode not in ('password', 'nopasswd'):
                    raise ValueError('sudo 模式无效')
                _config['sudo_mode'] = sudo_mode
        except ValueError as e:
            return jsonify({'success': False, 'error': str(e)}), 400

        if 'port' in data:
            global PORT
            PORT = _config['port']

        new_mode = _config.get('connection_mode', old_mode)

        if _config.get('connection_mode') == 'fast-ssh':
            from ssh_manager import save_credential
            _fast_user, _fast_pwd = get_fast_ssh_credentials()
            _config['ssh_user'] = _fast_user
            _config['sudo_mode'] = 'password'
            save_credential('ssh_password', _fast_pwd)
            save_credential('sudo_password', _fast_pwd)
            if not _config.get('fast_ssh_user'):
                _config['fast_ssh_user'] = _fast_user
            _config.pop('fast_ssh_password', None)

        if new_mode == 'local' and old_mode in ('ssh', 'fast-ssh'):
            try:
                manager = SSHManager.get_instance()
                manager.disconnect()
                logger.info(f"连接模式从 {old_mode} 切换到 local，已断开 SSH 连接")
            except Exception as e:
                logger.warning(f"断开 SSH 连接时出错: {e}")

        import routes_system
        routes_system._remote_flyos_version = None
        routes_system._remote_board_name = None

        if save_config(_config):
            return jsonify({'success': True, 'message': '配置已保存', 'config': public_config(_config)})
        else:
            return jsonify({'error': '保存配置失败'}), 500


# ==================== SSH 远程连接 API ====================
@settings_bp.route('/api/settings/ssh-credentials', methods=['GET', 'POST'])
def handle_ssh_credentials():
    """设置或查询 SSH 凭据（加密存储）"""
    from ssh_manager import save_credential, load_credential, has_credential, clear_credentials

    if request.method == 'GET':
        return jsonify({
            'has_ssh_password': has_credential('ssh_password'),
            'has_sudo_password': has_credential('sudo_password')
        })
    else:
        data = request.get_json(silent=True) or {}
        if data.get('clear_all'):
            clear_credentials()
            return jsonify({'success': True, 'message': '凭据已清除'})
        try:
            if data.get('ssh_password') is not None:
                save_credential('ssh_password', _clean_secret(data['ssh_password'], 'SSH 密码'))
            if data.get('sudo_password') is not None:
                save_credential('sudo_password', _clean_secret(data['sudo_password'], 'sudo 密码'))
        except ValueError as e:
            return jsonify({'success': False, 'error': str(e)}), 400
        return jsonify({'success': True, 'message': '凭据已保存'})


@settings_bp.route('/api/settings/resolve-paths', methods=['GET'])
def resolve_paths():
    """解析路径中的 ~ 为当前模式下的实际绝对路径"""
    try:
        paths = request.args.getlist('path') or ['~/klipper', '~/katapult']
        resolved = {}
        for p in paths:
            if p.startswith('~'):
                resolved[p] = expand_klipper_path(p)
            else:
                resolved[p] = p
        return jsonify({'resolved': resolved, 'mode': config.get('connection_mode', 'local')})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@settings_bp.route('/api/settings/local-test', methods=['POST'])
def test_local_connection():
    """测试本地执行环境"""
    try:
        checks = []
        all_ok = True

        # 1. 检查 Klipper 路径
        klipper_path = expand_klipper_path(config.get('klipper_path', '~/klipper'))
        if os.path.isdir(klipper_path):
            checks.append({'name': 'Klipper 路径', 'status': 'ok', 'detail': klipper_path})
        else:
            checks.append({'name': 'Klipper 路径', 'status': 'fail', 'detail': f'{klipper_path} 不存在'})
            all_ok = False

        # 2. 检查 Klipper 服务状态
        try:
            r = run_cmd(['systemctl', 'is-active', 'klipper'], capture_output=True, text=True, timeout=5)
            if r.returncode == 0:
                checks.append({'name': 'Klipper 服务', 'status': 'ok', 'detail': '运行中'})
            else:
                checks.append({'name': 'Klipper 服务', 'status': 'warn', 'detail': '未运行'})
        except Exception:
            checks.append({'name': 'Klipper 服务', 'status': 'warn', 'detail': '无法检测'})

        # 3. 检查 Katapult 路径（可选）
        katapult_path = expand_klipper_path(config.get('katapult_path', '~/katapult'))
        if os.path.isdir(katapult_path):
            checks.append({'name': 'Katapult 路径', 'status': 'ok', 'detail': katapult_path})
        else:
            checks.append({'name': 'Katapult 路径', 'status': 'warn', 'detail': f'{katapult_path} 不存在（可选）'})

        # 4. 系统信息
        try:
            r = run_cmd(['uname', '-r'], capture_output=True, text=True, timeout=5)
            kernel = r.stdout.strip() if r.returncode == 0 else '未知'
            checks.append({'name': '系统内核', 'status': 'ok', 'detail': kernel})
        except Exception:
            checks.append({'name': '系统内核', 'status': 'ok', 'detail': '未知'})

        return jsonify({
            'success': all_ok,
            'message': '本地环境检测通过' if all_ok else '本地环境存在问题',
            'checks': checks
        })
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 200


@settings_bp.route('/api/settings/ssh-test', methods=['POST'])
def test_ssh_connection():
    """测试 SSH 连接"""
    try:
        manager = SSHManager.get_instance()
        manager.disconnect()
        success, message = manager.test_connection()
        if success:
            return jsonify({'success': True, 'message': message})
        else:
            return jsonify({'success': False, 'error': message}), 200
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 200


@settings_bp.route('/api/ssh/status')
def get_ssh_connection_status():
    """获取 SSH 连接状态"""
    if not is_ssh_mode():
        return jsonify({'mode': 'local', 'connected': None})
    try:
        manager = SSHManager.get_instance()
        status = manager.get_connection_status()
        status['mode'] = config.get('connection_mode', 'ssh')
        status['last_disconnect_time'] = _ssh_connection_status.get('last_disconnect_time')
        status['reconnect_attempts'] = _ssh_connection_status.get('reconnect_attempts', 0)
        return jsonify(status)
    except Exception as e:
        return jsonify({
            'mode': config.get('connection_mode', 'ssh'),
            'connected': False,
            'error': str(e)
        })


@settings_bp.route('/api/ssh/reconnect', methods=['POST'])
def reconnect_ssh():
    """手动触发 SSH 重连"""
    global _ssh_connection_status
    if not is_ssh_mode():
        return jsonify({'success': False, 'error': '当前不是 SSH 模式'}), 400
    try:
        manager = SSHManager.get_instance()
        success, message = manager.force_reconnect()
        if success:
            _ssh_connection_status.update({
                'connected': True,
                'circuit_open': False,
                'consecutive_failures': 0,
                'cooldown_remaining': 0,
                'cooldown_level': 0,
                'reconnect_attempts': 0,
                'last_disconnect_time': None,
            })
            return jsonify({'success': True, 'message': message})
        else:
            _update_ssh_disconnect_status()
            return jsonify({'success': False, 'error': message}), 200
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 200


# ==================== CAN 辅助函数 ====================
def format_bitrate(bitrate):
    """将 bitrate 数值转为友好显示格式"""
    for val, label in CAN_BITRATES.items():
        if bitrate == val:
            return label
    if bitrate >= 1000000:
        return f"{bitrate // 1000000}M"
    elif bitrate >= 1000:
        return f"{bitrate // 1000}K"
    return str(bitrate)


def get_can_live_status():
    """获取当前 CAN0 接口实时状态"""
    result = {
        'interface': 'can0',
        'exists': False,
        'state': None,
        'bitrate': None,
        'txqueuelen': None,
    }
    try:
        r = run_cmd(
            'ip -details link show can0 2>/dev/null',
            shell=True, capture_output=True, text=True, timeout=5
        )
        output = r.stdout.strip()
        if not output:
            return result
        result['exists'] = True
        m = re.search(r'state\s+(\S+)', output)
        if m:
            result['state'] = m.group(1).upper()
        m = re.search(r'bitrate\s+(\d+)', output)
        if m:
            result['bitrate'] = int(m.group(1))
        m = re.search(r'txqueuelen\s+(\d+)', output)
        if m:
            result['txqueuelen'] = int(m.group(1))
    except:
        pass
    return result


def detect_os_type():
    """检测系统类型"""
    try:
        with open('/etc/os-release', 'r') as f:
            content = f.read()
            if 'Debian' in content or 'Ubuntu' in content:
                return 'debian'
    except:
        pass
    try:
        with open('/etc/issue', 'r') as f:
            content = f.read()
            if 'Debian' in content or 'Ubuntu' in content:
                return 'debian'
    except:
        pass
    return 'other'


def detect_can_config():
    """智能检测 CAN 配置（三模式：flyos_fast / systemd / interfaces / none）"""
    result = {
        'system': 'none',
        'network_file': None,
        'link_file': None,
        'interfaces_file': None,
        'bitrate': None,
        'txqueuelen': None,
    }

    # 1. 检测 FlyOS-FAST
    try:
        if is_ssh_mode():
            r = run_cmd('cat /etc/issue 2>/dev/null || echo ""', shell=True, capture_output=True, text=True, timeout=5)
            issue_content = r.stdout or ''
        else:
            with open('/etc/issue', 'r') as f:
                issue_content = f.read()

        if 'FlyOS-Fast' in issue_content:
            result['system'] = 'flyos_fast'
            config_txt = '/config/config.txt'
            try:
                if is_ssh_mode():
                    r = run_cmd(f'cat {config_txt} 2>/dev/null || echo ""', shell=True, capture_output=True, text=True, timeout=5)
                    cfg_content = r.stdout or ''
                else:
                    if os.path.exists(config_txt):
                        with open(config_txt, 'r') as f2:
                            cfg_content = f2.read()
                    else:
                        cfg_content = ''
                for line in cfg_content.split('\n'):
                    m = re.match(r'canbus_bitrate\s*=\s*(\d+)', line.strip())
                    if m:
                        result['bitrate'] = int(m.group(1))
                        break
            except:
                pass
            return result
    except:
        pass

    # 2. 检测 systemd-networkd
    if is_ssh_mode():
        try:
            r = run_cmd(f'ls {CAN_NETWORK_DIR}/*can*.network 2>/dev/null | head -1 || echo ""', shell=True, capture_output=True, text=True, timeout=5)
            network_file = r.stdout.strip() if r.stdout else ''
            if network_file:
                result['network_file'] = network_file
        except:
            pass
        try:
            r = run_cmd(f'ls {CAN_NETWORK_DIR}/*can*.link 2>/dev/null | head -1 || echo ""', shell=True, capture_output=True, text=True, timeout=5)
            link_file = r.stdout.strip() if r.stdout else ''
            if link_file:
                result['link_file'] = link_file
        except:
            pass
    else:
        if os.path.exists(CAN_NETWORK_DIR):
            files = os.listdir(CAN_NETWORK_DIR)
            for fname in files:
                if 'can' in fname.lower() and fname.endswith('.network'):
                    result['network_file'] = os.path.join(CAN_NETWORK_DIR, fname)
                    break
            for fname in files:
                if 'can' in fname.lower() and fname.endswith('.link'):
                    result['link_file'] = os.path.join(CAN_NETWORK_DIR, fname)
                    break

    if result['network_file']:
        result['system'] = 'systemd'
        try:
            if is_ssh_mode():
                r = run_cmd(f'cat "{result["network_file"]}" 2>/dev/null', shell=True, capture_output=True, text=True, timeout=5)
                content = r.stdout or ''
            else:
                with open(result['network_file'], 'r') as f:
                    content = f.read()
            m = re.search(r'BitRate\s*=\s*(\d+)', content)
            if m:
                bitrate_val = int(m.group(1))
                if bitrate_val == 1:
                    result['bitrate'] = 1000000
                elif bitrate_val == 500:
                    result['bitrate'] = 500000
                elif bitrate_val == 250:
                    result['bitrate'] = 250000
                else:
                    result['bitrate'] = bitrate_val
        except:
            pass
        if result['link_file']:
            try:
                if is_ssh_mode():
                    r = run_cmd(f'cat "{result["link_file"]}" 2>/dev/null', shell=True, capture_output=True, text=True, timeout=5)
                    link_content = r.stdout or ''
                else:
                    with open(result['link_file'], 'r') as f:
                        link_content = f.read()
                m = re.search(r'TxQueueLength\s*=\s*(\d+)', link_content)
                if m:
                    result['txqueuelen'] = int(m.group(1))
            except:
                pass
        return result

    # 3. 检测传统 interfaces
    if is_ssh_mode():
        try:
            r = run_cmd(f'ls {CAN_INTERFACES_DIR}/can* 2>/dev/null | head -1 || echo ""', shell=True, capture_output=True, text=True, timeout=5)
            iface_file = r.stdout.strip() if r.stdout else ''
            if iface_file:
                result['interfaces_file'] = iface_file
                result['system'] = 'interfaces'
                r2 = run_cmd(f'cat "{iface_file}" 2>/dev/null', shell=True, capture_output=True, text=True, timeout=5)
                content = r2.stdout or ''
                m = re.search(r'bitrate\s+(\d+)', content)
                if m:
                    result['bitrate'] = int(m.group(1))
                m = re.search(r'txqueuelen\s+(\d+)', content)
                if m:
                    result['txqueuelen'] = int(m.group(1))
        except:
            pass
    else:
        if os.path.exists(CAN_INTERFACES_DIR):
            for fname in os.listdir(CAN_INTERFACES_DIR):
                if fname.lower().startswith('can'):
                    result['interfaces_file'] = os.path.join(CAN_INTERFACES_DIR, fname)
                    result['system'] = 'interfaces'
                    try:
                        with open(result['interfaces_file'], 'r') as f:
                            content = f.read()
                        m = re.search(r'bitrate\s+(\d+)', content)
                        if m:
                            result['bitrate'] = int(m.group(1))
                        m = re.search(r'txqueuelen\s+(\d+)', content)
                        if m:
                            result['txqueuelen'] = int(m.group(1))
                    except:
                        pass
                    return result

    return result


def get_usb_can_count():
    """检测 USB CAN 适配器数量"""
    try:
        r = run_cmd(
            'lsusb | grep "1d50:" || echo ""',
            shell=True, capture_output=True, text=True, timeout=5
        )
        devices = []
        for line in r.stdout.strip().split('\n'):
            if not line.strip():
                continue
            if 'stm32f072' in line.lower() or 'stm32f446' in line.lower():
                continue
            devices.append(line)
        return len(devices)
    except:
        return 0


# ==================== CAN 配置 API ====================
@settings_bp.route('/api/system/can-config', methods=['GET'])
def get_can_config():
    """获取当前CAN配置（三模式自适应）"""
    try:
        cfg = detect_can_config()
        live = get_can_live_status()

        result = {
            'exists': cfg['system'] != 'none',
            'system': cfg['system'],
            'bitrate': cfg['bitrate'],
            'txqueuelen': cfg['txqueuelen'],
            'network_file': cfg['network_file'],
            'link_file': cfg['link_file'],
            'interfaces_file': cfg['interfaces_file'],
            'live': live,
        }

        if cfg['bitrate']:
            result['bitrate_display'] = format_bitrate(cfg['bitrate'])
        if live['bitrate']:
            result['live']['bitrate_display'] = format_bitrate(live['bitrate'])

        if cfg['system'] == 'flyos_fast':
            result['config_txt'] = '/config/config.txt'

        result['usb_can_count'] = get_usb_can_count()

        return jsonify(result)

    except Exception as e:
        return jsonify({'error': str(e)}), 500


@settings_bp.route('/api/system/can-config', methods=['POST'])
def set_can_config():
    """设置CAN配置（三模式自适应，支持自动生成）"""
    try:
        data = request.get_json(silent=True) or {}
        try:
            bitrate = int(data.get('bitrate', 1000000))
        except (TypeError, ValueError):
            return jsonify({'error': '速率必须是数字'}), 400
        txqueuelen = data.get('txqueuelen', 1024)

        if bitrate not in CAN_BITRATES:
            return jsonify({
                'error': f'不支持的速率: {bitrate}，仅支持 {", ".join(CAN_BITRATES.values())}'
            }), 400

        try:
            txqueuelen = int(txqueuelen)
        except (TypeError, ValueError):
            return jsonify({'error': '缓存大小必须是数字'}), 400
        if txqueuelen < 128 or txqueuelen > 8192:
            return jsonify({'error': '缓存大小范围: 128-8192'}), 400

        bitrate_str = CAN_BITRATES[bitrate]
        cfg = detect_can_config()

        # FlyOS-FAST
        if cfg['system'] == 'flyos_fast':
            config_txt = '/config/config.txt'
            try:
                sed_cmd = f"sed -i 's/^canbus_bitrate=.*/canbus_bitrate={bitrate}/' {config_txt}"
                r = run_cmd(sed_cmd, shell=True, capture_output=True, text=True, timeout=10)
                if r.returncode != 0:
                    return jsonify({'success': False, 'error': f'写入 config.txt 失败: {r.stderr}'}), 500

                r2 = run_cmd(f'grep "^canbus_bitrate=" {config_txt}', shell=True, capture_output=True, text=True, timeout=5)
                if str(bitrate) not in (r2.stdout or ''):
                    append_cmd = f"echo 'canbus_bitrate={bitrate}' >> {config_txt}"
                    r3 = run_cmd(append_cmd, shell=True, capture_output=True, text=True, timeout=5)
                    if r3.returncode != 0:
                        return jsonify({'success': False, 'error': '写入失败，config.txt 可能为只读'}), 500
                    r4 = run_cmd(f'grep "^canbus_bitrate=" {config_txt}', shell=True, capture_output=True, text=True, timeout=5)
                    if str(bitrate) not in (r4.stdout or ''):
                        return jsonify({'success': False, 'error': '写入验证失败，config.txt 可能为只读'}), 500

                run_cmd('sudo ip link set can0 down 2>/dev/null', shell=True, capture_output=True, timeout=10)
                time.sleep(0.5)
                run_cmd(f'sudo ip link set can0 type can bitrate {bitrate} 2>/dev/null', shell=True, capture_output=True, timeout=10)
                time.sleep(0.3)
                run_cmd('sudo ip link set can0 up 2>/dev/null', shell=True, capture_output=True, timeout=10)
                time.sleep(1)

                return jsonify({
                    'success': True,
                    'message': f'FlyOS-Fast CAN 配置已更新: canbus_bitrate={bitrate}，接口已重启'
                })
            except Exception as e:
                return jsonify({'success': False, 'error': f'FlyOS-Fast CAN 配置修改失败: {str(e)}'}), 500

        systemd_mode = cfg['system'] in ('systemd', 'none')

        if systemd_mode:
            network_file = cfg.get('network_file')
            if not network_file:
                network_file = os.path.join(CAN_NETWORK_DIR, '99-can.network')
            link_file = cfg.get('link_file')
            if not link_file:
                link_file = os.path.join(CAN_NETWORK_DIR, '99-can.link')

            sudo_mkdir(CAN_NETWORK_DIR)

            network_content = f"""[Match]
Name=can*

[CAN]
BitRate={bitrate_str}
"""
            sudo_write_file(network_file, network_content)

            link_content = f"""[Match]
OriginalName=can*

[Link]
TxQueueLength={txqueuelen}
"""
            sudo_write_file(link_file, link_content)

        else:
            interfaces_file = cfg.get('interfaces_file')
            if not interfaces_file:
                interfaces_file = os.path.join(CAN_INTERFACES_DIR, 'can0')

            sudo_mkdir(CAN_INTERFACES_DIR)

            interfaces_content = f"""allow-hotplug can0
iface can0 can static
    bitrate {bitrate}
    up ifconfig $IFACE txqueuelen {txqueuelen}
    pre-up ip link set can0 type can bitrate {bitrate}
    pre-up ip link set can0 txqueuelen {txqueuelen}
"""
            sudo_write_file(interfaces_file, interfaces_content)

        if systemd_mode:
            run_cmd(
                'sudo systemctl restart systemd-networkd',
                shell=True, capture_output=True, timeout=30
            )
            time.sleep(3)
        else:
            try:
                run_cmd('sudo ip link set can0 down', shell=True, capture_output=True, timeout=10)
                time.sleep(0.5)
                run_cmd(f'sudo ip link set can0 type can bitrate {bitrate}', shell=True, capture_output=True, timeout=10)
                time.sleep(0.3)
                run_cmd(f'sudo ip link set can0 txqueuelen {txqueuelen}', shell=True, capture_output=True, timeout=10)
                time.sleep(0.3)
            except:
                pass

        try:
            check = run_cmd(
                'ip link show can0 2>&1',
                shell=True, capture_output=True, text=True, timeout=5
            )
            if 'does not exist' not in check.stdout:
                detail = run_cmd(
                    'ip -details link show can0 2>/dev/null',
                    shell=True, capture_output=True, text=True, timeout=5
                )
                if 'state DOWN' in detail.stdout or 'state UNKNOWN' in detail.stdout:
                    run_cmd('sudo ip link set can0 up', shell=True, capture_output=True, timeout=10)
        except:
            pass

        return jsonify({
            'success': True,
            'message': f'CAN配置已更新，速率: {bitrate_str}，缓存: {txqueuelen}'
        })

    except Exception as e:
        return jsonify({'error': str(e)}), 500


@settings_bp.route('/api/system/can-diagnose', methods=['GET'])
def diagnose_can_network():
    """诊断CAN网络状态"""
    try:
        result = {
            'can_device_exists': False,
            'can_device_info': '',
            'can0_exists': False,
            'can0_state': '',
            'can0_bitrate': '',
            'kernel_support': False,
            'errors': []
        }

        if is_ssh_mode():
            cmd = (
                'echo "===MODPROBE==="; sudo modprobe can 2>/dev/null && echo "OK" || echo "FAIL"; '
                'echo "===LSUSB==="; lsusb 2>/dev/null | grep -iE "(GS_USB|CAN|UTOC|can)"; '
                'echo "===CAN0==="; ip link show can0 2>&1; '
                'echo "===CAN0_DETAILS==="; ip -details link show can0 2>/dev/null | grep bitrate; '
                'echo "===END==="'
            )
            out = run_cmd(cmd, shell=True, capture_output=True, text=True, timeout=10)
            output = out.stdout or ''

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

            modprobe_lines = sections.get('MODPROBE', [])
            result['kernel_support'] = any('OK' in l for l in modprobe_lines)
            if not result['kernel_support']:
                result['errors'].append('内核CAN模块加载失败')

            lsusb_lines = sections.get('LSUSB', [])
            if lsusb_lines:
                result['can_device_exists'] = True
                result['can_device_info'] = '\n'.join(lsusb_lines)

            can0_lines = sections.get('CAN0', [])
            can0_output = '\n'.join(can0_lines)
            if can0_lines and 'can0' in can0_output and 'does not exist' not in can0_output:
                result['can0_exists'] = True
                if 'state UP' in can0_output:
                    result['can0_state'] = 'UP'
                elif 'state DOWN' in can0_output:
                    result['can0_state'] = 'DOWN'
                else:
                    result['can0_state'] = 'UNKNOWN'
                details_lines = sections.get('CAN0_DETAILS', [])
                if details_lines:
                    result['can0_bitrate'] = details_lines[0]
            else:
                result['can0_exists'] = False
                result['errors'].append('can0接口不存在')
        else:
            try:
                modprobe_result = run_cmd('sudo modprobe can && echo "OK" || echo "FAIL"', shell=True, capture_output=True, text=True)
                result['kernel_support'] = 'OK' in modprobe_result.stdout
            except:
                result['errors'].append('内核CAN模块检查失败')

            try:
                lsusb_result = run_cmd('lsusb | grep -E "(GS_USB|CAN|UTOC|can)" || echo ""', shell=True, capture_output=True, text=True)
                if lsusb_result.stdout.strip():
                    result['can_device_exists'] = True
                    result['can_device_info'] = lsusb_result.stdout.strip()
            except:
                pass

            try:
                can0_result = run_cmd('ip link show can0 2>&1', shell=True, capture_output=True, text=True)
                if 'can0' in can0_result.stdout and 'does not exist' not in can0_result.stdout:
                    result['can0_exists'] = True
                    if 'state UP' in can0_result.stdout:
                        result['can0_state'] = 'UP'
                    elif 'state DOWN' in can0_result.stdout:
                        result['can0_state'] = 'DOWN'
                    else:
                        result['can0_state'] = 'UNKNOWN'
                    details_result = run_cmd('ip -details link show can0 2>&1 | grep bitrate || echo ""', shell=True, capture_output=True, text=True)
                    if details_result.stdout.strip():
                        result['can0_bitrate'] = details_result.stdout.strip()
                else:
                    result['can0_exists'] = False
                    result['errors'].append('can0接口不存在')
            except:
                result['errors'].append('can0接口检查失败')

        return jsonify(result)

    except Exception as e:
        return jsonify({'error': str(e)}), 500


@settings_bp.route('/api/system/can-repair', methods=['POST'])
def repair_can_network():
    """修复CAN网络"""
    try:
        data = request.get_json(silent=True) or {}
        try:
            bitrate = int(data.get('bitrate', 1000000))
        except (TypeError, ValueError):
            return jsonify({'error': '速率必须是数字'}), 400
        txqueuelen = data.get('txqueuelen', 1024)

        if bitrate not in CAN_BITRATES:
            return jsonify({
                'error': f'不支持的速率: {bitrate}，仅支持 {", ".join(CAN_BITRATES.values())}'
            }), 400
        try:
            txqueuelen = int(txqueuelen)
        except (TypeError, ValueError):
            return jsonify({'error': '缓存大小必须是数字'}), 400
        if txqueuelen < 128 or txqueuelen > 8192:
            return jsonify({'error': '缓存大小范围: 128-8192'}), 400

        messages = []

        try:
            run_cmd('sudo modprobe can', shell=True, capture_output=True)
            run_cmd('sudo modprobe can_raw', shell=True, capture_output=True)
            run_cmd('sudo modprobe gs_usb', shell=True, capture_output=True)
            messages.append('CAN内核模块已加载')
        except:
            messages.append('CAN内核模块加载失败')

        lsusb_result = run_cmd(
            'lsusb | grep -E "(GS_USB|CAN|UTOC)" || echo ""',
            shell=True, capture_output=True, text=True
        )

        if not lsusb_result.stdout.strip():
            return jsonify({
                'success': False,
                'error': '未检测到USB CAN设备，请检查硬件连接',
                'messages': messages
            }), 400

        try:
            sudo_mkdir(CAN_NETWORK_DIR)

            if bitrate >= 1000000:
                bitrate_str = f"{bitrate // 1000000}M"
            elif bitrate >= 1000:
                bitrate_str = f"{bitrate // 1000}K"
            else:
                bitrate_str = str(bitrate)

            config_content = f"""[Match]
Name=can*

[CAN]
BitRate={bitrate_str}
"""
            sudo_write_file(os.path.join(CAN_NETWORK_DIR, '99-can.network'), config_content)

            link_content = f"""[Match]
OriginalName=can*

[Link]
TxQueueLength={txqueuelen}
"""
            sudo_write_file(os.path.join(CAN_NETWORK_DIR, '99-can.link'), link_content)

            messages.append(f'CAN配置文件已创建（速率: {bitrate_str}）')
        except Exception as e:
            messages.append(f'配置文件创建失败: {str(e)}')

        try:
            run_cmd('sudo systemctl restart systemd-networkd', shell=True, capture_output=True, check=True)
            messages.append('systemd-networkd已重启')
        except:
            messages.append('systemd-networkd重启失败')

        time.sleep(2)

        try:
            can0_check = run_cmd('ip link show can0 2>&1', shell=True, capture_output=True, text=True)

            if 'does not exist' in can0_check.stdout:
                messages.append('can0接口不存在，尝试手动创建...')
                can_devs = run_cmd('ls /sys/bus/usb/devices/*/can* 2>/dev/null || echo ""', shell=True, capture_output=True, text=True)
                messages.append(f'找到的CAN设备: {can_devs.stdout.strip() or "无"}')
            else:
                run_cmd('sudo ip link set can0 up', shell=True, capture_output=True, check=True)
                messages.append('can0接口已启动')
        except Exception as e:
            messages.append(f'can0启动失败: {str(e)}')

        return jsonify({
            'success': True,
            'messages': messages,
            'note': '修复完成，请刷新页面查看状态。如果仍有问题，请检查硬件连接或重启系统。'
        })

    except Exception as e:
        return jsonify({'error': str(e)}), 500


# ==================== 时区设置 API ====================
@settings_bp.route('/api/settings/timezone', methods=['GET', 'POST'])
def handle_timezone():
    """获取或设置时区"""
    if request.method == 'GET':
        try:
            result = run_cmd(['timedatectl', 'show', '--property=Timezone'], capture_output=True, text=True)
            timezone = result.stdout.strip().replace('Timezone=', '')
            return jsonify({'timezone': timezone})
        except:
            return jsonify({'timezone': 'Unknown'})
    else:
        data = request.get_json(silent=True) or {}
        new_timezone = data.get('timezone', 'Asia/Shanghai')
        if not re.match(r'^[A-Za-z0-9_+./-]{1,80}$', str(new_timezone or '')):
            return jsonify({'error': '时区格式无效'}), 400
        try:
            run_cmd(['sudo', 'timedatectl', 'set-timezone', new_timezone], check=True, capture_output=True)
            return jsonify({'success': True, 'message': f'时区已设置为 {new_timezone}'})
        except Exception as e:
            return jsonify({'error': str(e)}), 500


# ==================== 服务管理 API ====================
@settings_bp.route('/api/settings/service/<action>', methods=['POST'])
def manage_service(action):
    """管理服务"""
    valid_actions = ['restart', 'stop', 'start', 'status']
    if action not in valid_actions:
        return jsonify({'error': '无效的操作'}), 400

    data = request.get_json(silent=True) or {}
    requested_service = data.get('service', '')
    service = _normalize_service_name(requested_service)

    if not requested_service:
        return jsonify({'error': '未指定服务'}), 400
    if not service:
        return jsonify({'error': '不允许控制该服务'}), 400

    try:
        if action == 'status':
            result = run_cmd(['systemctl', 'is-active', service], capture_output=True, text=True)
            is_active = result.returncode == 0
            return jsonify({'service': service, 'active': is_active})
        else:
            result = run_cmd(['sudo', 'systemctl', action, service], capture_output=True, text=True)
            if result.returncode == 0:
                return jsonify({'success': True, 'message': f'{service} {action}成功'})
            else:
                return jsonify({'error': result.stderr}), 500
    except Exception as e:
        return jsonify({'error': str(e)}), 500
