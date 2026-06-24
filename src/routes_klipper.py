"""
Klipper MCU 数据库蓝图 - Kconfig 解析、MCU 查询
"""

from flask import Blueprint, jsonify

from shared import app, config, logger
from klipper_kconfig_parser import KlipperKconfigParser
from kconfig_can_parser import parse_can_options, load_cache, save_cache

klipper_bp = Blueprint('klipper', __name__, url_prefix='/api/klipper')

# 初始化解析器
klipper_parser = KlipperKconfigParser(config.get('klipper_path', '~/klipper'))
klipper_mcu_db = {}


def init_klipper_mcu_db():
    """初始化 Klipper MCU 数据库"""
    global klipper_mcu_db
    try:
        klipper_mcu_db = klipper_parser.parse_all_platforms()
        logger.info(f"✓ Klipper MCU 数据库已加载: {len(klipper_mcu_db)} 个平台")
        for platform, data in klipper_mcu_db.items():
            logger.info(f"  - {platform}: {len(data['mcus'])} 个 MCU")
    except Exception as e:
        logger.error(f"加载 Klipper MCU 数据库失败: {e}")
        klipper_mcu_db = {}


# 启动时初始化
init_klipper_mcu_db()


# 通信选项缓存（启动时加载）
_can_options_data = {}

def init_can_options():
    """初始化通信选项：优先从缓存加载，缓存不存在则从 Klipper 源码解析"""
    global _can_options_data
    try:
        cached = load_cache()
        if cached:
            _can_options_data = cached
            logger.info(f"✓ CAN 通信选项已从缓存加载: {len(cached)} 个平台")
        else:
            klipper_path = config.get('klipper_path', '~/klipper')
            _can_options_data = parse_can_options(klipper_path)
            save_cache(_can_options_data)
            logger.info(f"✓ CAN 通信选项已从 Klipper 源码解析: {len(_can_options_data)} 个平台")
    except Exception as e:
        logger.error(f"加载 CAN 通信选项失败: {e}")
        _can_options_data = {}

# 启动时初始化通信选项
init_can_options()


@klipper_bp.route('/communication-options')
def get_communication_options():
    """获取通信选项（返回按平台分类的完整数据）"""
    return jsonify(_can_options_data)


@klipper_bp.route('/mcu-database')
def get_klipper_mcu_database():
    """获取完整的 Klipper MCU 数据库"""
    return jsonify({
        'success': True,
        'platforms': list(klipper_mcu_db.keys()),
        'database': klipper_mcu_db
    })


@klipper_bp.route('/platforms')
def get_klipper_platforms():
    """获取所有 MCU 平台列表"""
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
    if platform not in klipper_mcu_db:
        return jsonify({
            'success': False,
            'error': f'未找到平台: {platform}'
        }), 404
    
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
        'mcus': mcus,
        'flash_modes': data.get('flash_modes', []),
        'connections': data.get('connections', [])
    })


@klipper_bp.route('/mcu-info/<mcu_id>')
def get_klipper_mcu_info(mcu_id):
    """获取特定 MCU 的详细信息"""
    mcu_id = mcu_id.lower()
    
    for platform, data in klipper_mcu_db.items():
        if mcu_id in data['mcus']:
            mcu = data['mcus'][mcu_id]
            return jsonify({
                'success': True,
                'platform': platform,
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
        init_klipper_mcu_db()
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
