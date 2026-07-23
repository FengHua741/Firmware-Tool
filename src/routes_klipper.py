"""
Klipper MCU 数据库蓝图 - Kconfig 解析、MCU 查询
"""

from flask import Blueprint, jsonify
import os
import threading

from shared import config, logger, expand_klipper_path
from klipper_kconfig_parser import KlipperKconfigParser
from kconfig_can_parser import parse_can_options

klipper_bp = Blueprint('klipper', __name__, url_prefix='/api/klipper')

# 初始化解析器
klipper_parser = None
klipper_mcu_db = {}
_mcu_db_signature = None
_mcu_db_lock = threading.Lock()


def _local_klipper_path():
    return expand_klipper_path(config.get('klipper_path', '~/klipper'), force_local=True)


def _kconfig_signature(klipper_path):
    """用 Kconfig 文件的 mtime/size 判断 Klipper 编译参数是否变化。"""
    src_path = os.path.join(klipper_path, 'src')
    paths = [os.path.join(src_path, 'Kconfig')]
    for platform_dir in KlipperKconfigParser.PLATFORM_DEFINITIONS.keys():
        paths.append(os.path.join(src_path, platform_dir, 'Kconfig'))

    signature = []
    for path in paths:
        try:
            stat_info = os.stat(path)
        except OSError:
            continue
        signature.append((path, stat_info.st_mtime_ns, stat_info.st_size))
    return tuple(signature)


def init_klipper_mcu_db(force=False):
    """初始化 Klipper MCU 数据库"""
    global klipper_parser, klipper_mcu_db, _mcu_db_signature
    with _mcu_db_lock:
        try:
            klipper_path = _local_klipper_path()
            signature = _kconfig_signature(klipper_path)
            if not force and klipper_mcu_db and signature == _mcu_db_signature:
                return
            klipper_parser = KlipperKconfigParser(klipper_path)
            klipper_mcu_db = klipper_parser.parse_all_platforms()
            _mcu_db_signature = signature
            logger.info(f"✓ Klipper MCU 数据库已加载: {len(klipper_mcu_db)} 个平台")
            for platform, data in klipper_mcu_db.items():
                logger.info(f"  - {platform}: {len(data['mcus'])} 个 MCU")
        except Exception as e:
            logger.error(f"加载 Klipper MCU 数据库失败: {e}")
            klipper_mcu_db = {}


# 启动时初始化
init_klipper_mcu_db()


# 通信选项缓存（按 Kconfig 文件签名自动失效）
_can_options_data = {}
_can_options_signature = None

def init_can_options(force=False):
    """初始化通信选项：从当前 Klipper Kconfig 解析，Kconfig 变化时自动刷新。"""
    global _can_options_data, _can_options_signature
    try:
        klipper_path = _local_klipper_path()
        signature = _kconfig_signature(klipper_path)
        if not force and _can_options_data and signature == _can_options_signature:
            return
        _can_options_data = parse_can_options(klipper_path)
        _can_options_signature = signature
        logger.info(f"✓ CAN 通信选项已从 Klipper 源码解析: {len(_can_options_data)} 个平台")
    except Exception as e:
        logger.error(f"加载 CAN 通信选项失败: {e}")
        _can_options_data = {}

# 启动时初始化通信选项
init_can_options()


@klipper_bp.route('/communication-options')
def get_communication_options():
    """获取通信选项（返回按平台分类的完整数据）"""
    init_can_options()
    return jsonify(_can_options_data)


@klipper_bp.route('/mcu-database')
def get_klipper_mcu_database():
    """获取完整的 Klipper MCU 数据库"""
    init_klipper_mcu_db()
    return jsonify({
        'success': True,
        'platforms': list(klipper_mcu_db.keys()),
        'database': klipper_mcu_db
    })


@klipper_bp.route('/platforms')
def get_klipper_platforms():
    """获取所有 MCU 平台列表"""
    init_klipper_mcu_db()
    platforms = []
    for platform_name, data in klipper_mcu_db.items():
        platforms.append({
            'name': platform_name,
            'mcu_count': len(data['mcus']),
            'flash_modes': data.get('flash_modes', [])
        })

    return jsonify({
        'success': True,
        'platforms': platforms
    })


@klipper_bp.route('/mcus/<platform>')
def get_klipper_mcus(platform):
    """获取指定平台的所有 MCU"""
    init_klipper_mcu_db()
    if platform in klipper_mcu_db:
        platform_key = platform
    else:
        platform_upper = platform.upper()
        if platform_upper in klipper_mcu_db:
            platform_key = platform_upper
        else:
            for key in klipper_mcu_db.keys():
                if key.upper() == platform_upper:
                    platform_key = key
                    break
            else:
                return jsonify({
                    'success': False,
                    'error': f'未找到平台: {platform}'
                }), 404

    platform = platform_key

    data = klipper_mcu_db[platform]
    mcus = []
    for mcu_id, mcu_info in data['mcus'].items():
        mcus.append({
            'id': mcu_id,
            'name': mcu_info['name'],
            'crystals': mcu_info.get('crystals', []),
            'bl_offsets': mcu_info.get('bl_offsets', []),
            'connections': mcu_info.get('connections', [])
        })

    return jsonify({
        'success': True,
        'platform': platform,
        'platform_key': data.get('platform'),
        'arch_config': data.get('arch_config', ''),
        'mcus': mcus,
        'flash_modes': data.get('flash_modes', []),
        'connections': data.get('connections', [])
    })


@klipper_bp.route('/mcu-info/<mcu_id>')
def get_klipper_mcu_info(mcu_id):
    """获取特定 MCU 的详细信息"""
    init_klipper_mcu_db()
    mcu_id = mcu_id.lower()

    for platform, data in klipper_mcu_db.items():
        if mcu_id in data['mcus']:
            mcu = data['mcus'][mcu_id]
            return jsonify({
                'success': True,
                'platform': platform,
                'platform_key': data.get('platform'),
                'arch_config': data.get('arch_config', ''),
                'mcu': mcu,
                'flash_modes': data.get('flash_modes', []),
                'connections': data.get('connections', [])
            })

    return jsonify({
        'success': False,
        'error': f'未找到 MCU: {mcu_id}'
    }), 404


@klipper_bp.route('/refresh-database', methods=['POST'])
def refresh_klipper_database():
    """强制刷新 Klipper MCU 数据库"""
    try:
        init_klipper_mcu_db(force=True)
        init_can_options(force=True)
        return jsonify({
            'success': True,
            'message': 'MCU 数据库已刷新',
            'platforms': list(klipper_mcu_db.keys()),
            'total_mcus': sum(len(d['mcus']) for d in klipper_mcu_db.values())
        })
    except Exception as e:
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500
