"""
板级配置管理蓝图 - 配置的增删改查
"""

from flask import Blueprint, jsonify, request
import os
import json

from shared import (
    app, config, logger, BASE_DIR, BOARD_CONFIGS_DIR, CONFIGS_DIR,
    sanitize_manufacturer, sanitize_config_id,
)

board_config_bp = Blueprint('board_config', __name__, url_prefix='/api/config')

# 预设厂家列表
PRESET_MANUFACTURERS = ["FLY", "BTT", "MKS", "Creality", "Prusa", "Voron", "自定义"]

KLIPPER_MCU_LIST = {
    "STM32": {
        "platform": "stm32",
        "mcus": [
            {"id": "stm32f103", "name": "STM32F103", "crystal": ["8000000", "12000000"], "bl_offset": ["0", "8192", "16384"]},
            {"id": "stm32f207", "name": "STM32F207", "crystal": ["8000000", "12000000", "25000000"], "bl_offset": ["0", "16384"]},
            {"id": "stm32f401", "name": "STM32F401", "crystal": ["8000000", "12000000", "25000000"], "bl_offset": ["0", "16384"]},
            {"id": "stm32f405", "name": "STM32F405", "crystal": ["8000000", "12000000", "25000000"], "bl_offset": ["0", "16384", "32768"]},
            {"id": "stm32f407", "name": "STM32F407", "crystal": ["8000000", "12000000", "25000000"], "bl_offset": ["0", "16384", "32768"]},
            {"id": "stm32f429", "name": "STM32F429", "crystal": ["8000000", "12000000", "25000000"], "bl_offset": ["0", "16384"]},
            {"id": "stm32f446", "name": "STM32F446", "crystal": ["8000000", "12000000", "25000000"], "bl_offset": ["0", "16384"]},
            {"id": "stm32f765", "name": "STM32F765", "crystal": ["8000000", "12000000", "25000000"], "bl_offset": ["0", "16384"]},
            {"id": "stm32f031", "name": "STM32F031", "crystal": ["8000000"], "bl_offset": ["0"]},
            {"id": "stm32f042", "name": "STM32F042", "crystal": ["8000000"], "bl_offset": ["0", "4096"]},
            {"id": "stm32f070", "name": "STM32F070", "crystal": ["8000000"], "bl_offset": ["0"]},
            {"id": "stm32f072", "name": "STM32F072", "crystal": ["8000000"], "bl_offset": ["0", "4096"]},
            {"id": "stm32g070", "name": "STM32G070", "crystal": ["8000000", "16000000"], "bl_offset": ["0", "2048"]},
            {"id": "stm32g071", "name": "STM32G071", "crystal": ["8000000", "16000000"], "bl_offset": ["0", "2048"]},
            {"id": "stm32g0b0", "name": "STM32G0B0", "crystal": ["8000000", "16000000"], "bl_offset": ["0", "2048"]},
            {"id": "stm32g0b1", "name": "STM32G0B1", "crystal": ["8000000", "16000000"], "bl_offset": ["0", "2048"]},
            {"id": "stm32g431", "name": "STM32G431", "crystal": ["8000000", "16000000", "24000000"], "bl_offset": ["0", "2048"]},
            {"id": "stm32g474", "name": "STM32G474", "crystal": ["8000000", "16000000", "24000000"], "bl_offset": ["0", "2048"]},
            {"id": "stm32h723", "name": "STM32H723", "crystal": ["8000000", "25000000"], "bl_offset": ["0", "16384", "32768"]},
            {"id": "stm32h743", "name": "STM32H743", "crystal": ["8000000", "25000000"], "bl_offset": ["0", "16384", "32768"]},
            {"id": "stm32h750", "name": "STM32H750", "crystal": ["8000000", "25000000"], "bl_offset": ["0", "16384"]},
        ],
        "flash_modes": ["DFU", "KAT", "CAN", "CAN_BRIDGE_DFU", "CAN_BRIDGE_KAT"]
    },
    "RP2040": {
        "platform": "rp2040",
        "mcus": [
            {"id": "rp2040", "name": "RP2040", "crystal": ["12000000"], "bl_offset": ["0", "256", "16384"]},
            {"id": "rp2350", "name": "RP2350", "crystal": ["12000000"], "bl_offset": ["0", "256", "16384"]},
        ],
        "flash_modes": ["UF2", "KAT", "CAN"]
    },
    "ATSAMD": {
        "platform": "atsamd",
        "mcus": [
            {"id": "samc21g18", "name": "SAMC21G18", "crystal": ["8000000", "16000000"], "bl_offset": ["0", "8192"]},
            {"id": "samd21g18", "name": "SAMD21G18", "crystal": ["8000000", "16000000"], "bl_offset": ["0", "8192"]},
            {"id": "samd21e18", "name": "SAMD21E18", "crystal": ["8000000", "16000000"], "bl_offset": ["0", "8192"]},
            {"id": "samd51g19", "name": "SAMD51G19", "crystal": ["8000000", "16000000"], "bl_offset": ["0", "16384"]},
            {"id": "samd51j19", "name": "SAMD51J19", "crystal": ["8000000", "16000000"], "bl_offset": ["0", "16384"]},
            {"id": "same51j19", "name": "SAME51J19", "crystal": ["8000000", "16000000"], "bl_offset": ["0", "16384"]},
        ],
        "flash_modes": ["UF2", "KAT"]
    },
    "LPC176x": {
        "platform": "lpc176x",
        "mcus": [
            {"id": "lpc1768", "name": "LPC1768 (100MHz)", "crystal": ["8000000", "12000000"], "bl_offset": ["0", "16384"]},
            {"id": "lpc1769", "name": "LPC1769 (120MHz)", "crystal": ["8000000", "12000000"], "bl_offset": ["0", "16384"]},
        ],
        "flash_modes": ["DFU", "KAT"]
    },
    "HC32F460": {
        "platform": "hc32f460",
        "mcus": [
            {"id": "hc32f460", "name": "HC32F460", "crystal": ["8000000", "16000000"], "bl_offset": ["0", "0x8000", "0xC000", "0x10000"]},
        ],
        "flash_modes": ["DFU", "KAT"]
    },
    "ATSAM": {
        "platform": "atsam",
        "mcus": [
            {"id": "sam3x8e", "name": "SAM3X8E", "crystal": ["8000000", "16000000"], "bl_offset": ["0", "8192"]},
            {"id": "sam4s8c", "name": "SAM4S8C", "crystal": ["8000000", "16000000"], "bl_offset": ["0", "8192"]},
            {"id": "same70q20b", "name": "SAME70Q20B", "crystal": ["8000000", "12000000"], "bl_offset": ["0", "8192"]},
        ],
        "flash_modes": ["DFU", "KAT"]
    },
    "AVR": {
        "platform": "avr",
        "mcus": [
            {"id": "atmega2560", "name": "ATmega2560", "crystal": ["8000000", "16000000"], "bl_offset": ["0"]},
            {"id": "atmega328p", "name": "ATmega328P", "crystal": ["8000000", "16000000"], "bl_offset": ["0"]},
            {"id": "at90usb1286", "name": "AT90USB1286", "crystal": ["8000000", "16000000"], "bl_offset": ["0"]},
        ],
        "flash_modes": ["DFU"]
    }
}


def generate_id_from_name(name):
    """从名称生成 ID"""
    import re
    config_id = name.lower()
    config_id = re.sub(r'[^a-z0-9]', '-', config_id)
    config_id = re.sub(r'-+', '-', config_id)
    config_id = config_id.strip('-')
    return config_id


@board_config_bp.route('/list/<manufacturer>', methods=['GET'])
def list_configs(manufacturer):
    """获取指定厂家的所有配置"""
    try:
        manufacturer = sanitize_manufacturer(manufacturer)
        if not manufacturer:
            return jsonify({'error': '无效的厂家名称'}), 400
        configs = []
        board_types = []
        
        mfr_dir = os.path.join(BOARD_CONFIGS_DIR, manufacturer)
        if os.path.exists(mfr_dir):
            for board_type in os.listdir(mfr_dir):
                type_dir = os.path.join(mfr_dir, board_type)
                if os.path.isdir(type_dir) and not board_type.startswith('.') and board_type != 'BL':
                    board_types.append(board_type)
                    for filename in os.listdir(type_dir):
                        if filename.endswith('.json') and not filename.endswith('.bak'):
                            filepath = os.path.join(type_dir, filename)
                            try:
                                with open(filepath, 'r', encoding='utf-8') as f:
                                    cfg_data = json.load(f)
                                    config_id = filename.replace('.json', '')
                                    cfg_data['id'] = config_id
                                    cfg_data['type'] = board_type
                                    configs.append(cfg_data)
                            except Exception as e:
                                logger.error(f"读取配置失败 {filename}: {e}")
        
        configs.sort(key=lambda x: x.get('name', ''))
        
        return jsonify({'configs': configs, 'board_types': board_types})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@board_config_bp.route('/get/<manufacturer>/<config_id>', methods=['GET'])
def get_config(manufacturer, config_id):
    """获取单个配置详情"""
    try:
        manufacturer = sanitize_manufacturer(manufacturer)
        if not manufacturer:
            return jsonify({'error': '无效的厂家名称'}), 400
        config_id = sanitize_config_id(config_id)
        if not config_id:
            return jsonify({'error': '无效的配置ID'}), 400
        mfr_dir = os.path.join(BOARD_CONFIGS_DIR, manufacturer)
        if os.path.exists(mfr_dir):
            for board_type in os.listdir(mfr_dir):
                type_dir = os.path.join(mfr_dir, board_type)
                if not os.path.isdir(type_dir) or board_type.startswith('.'):
                    continue
                filepath = os.path.join(type_dir, f"{config_id}.json")
                if os.path.exists(filepath):
                    with open(filepath, 'r', encoding='utf-8') as f:
                        cfg_data = json.load(f)
                    return jsonify(cfg_data)
        
        return jsonify({'error': '配置不存在'}), 404
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@board_config_bp.route('/create/<manufacturer>', methods=['POST'])
def create_config(manufacturer):
    """创建新配置"""
    try:
        data = request.get_json()
        
        if not data or 'name' not in data:
            return jsonify({'error': 'Missing required fields'}), 400
        
        product_type = data.get('type', 'mainboard')
        if product_type not in ['mainboard', 'toolboard', 'expansion']:
            product_type = 'mainboard'
        
        config_id = data.get('id', generate_id_from_name(data['name']))
        
        type_dir = os.path.join(CONFIGS_DIR, manufacturer, product_type)
        os.makedirs(type_dir, exist_ok=True)
        
        filepath = os.path.join(type_dir, f"{config_id}.json")
        with open(filepath, 'w', encoding='utf-8') as f:
            json.dump(data, f, indent=4, ensure_ascii=False)
        
        logger.info(f"创建配置：{manufacturer}/{product_type}/{config_id}.json")
        
        return jsonify({
            'success': True,
            'id': config_id,
            'path': filepath
        })
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@board_config_bp.route('/delete/<manufacturer>/<config_id>', methods=['DELETE'])
def delete_config(manufacturer, config_id):
    """删除配置"""
    try:
        manufacturer = sanitize_manufacturer(manufacturer)
        if not manufacturer:
            return jsonify({'error': '无效的厂家名称'}), 400
        config_id = sanitize_config_id(config_id)
        if not config_id:
            return jsonify({'error': '无效的配置ID'}), 400
        mfr_dir = os.path.join(BOARD_CONFIGS_DIR, manufacturer)
        
        if os.path.exists(mfr_dir):
            for board_type in os.listdir(mfr_dir):
                type_dir = os.path.join(mfr_dir, board_type)
                if not os.path.isdir(type_dir) or board_type.startswith('.'):
                    continue
                filepath = os.path.join(type_dir, f"{config_id}.json")
                if os.path.exists(filepath):
                    os.remove(filepath)
                    logger.info(f"删除配置：{filepath}")
                    return jsonify({'success': True})
        
        return jsonify({'error': '配置不存在'}), 404
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@board_config_bp.route('/upload', methods=['POST'])
def upload_config():
    """上传配置文件"""
    try:
        manufacturer = request.form.get('manufacturer', 'FLY')
        manufacturer = sanitize_manufacturer(manufacturer)
        if not manufacturer:
            return jsonify({'error': '无效的厂家名称'}), 400
        files = request.files.getlist('files[]')
        
        if not files:
            return jsonify({'error': '没有文件'}), 400
        
        uploaded_count = 0
        
        for file in files:
            if file.filename:
                safe_filename = os.path.basename(file.filename)
                if not safe_filename or safe_filename.startswith('.'):
                    logger.warning(f"跳过不安全的文件名: {file.filename}")
                    continue
                save_path = os.path.join(CONFIGS_DIR, manufacturer, safe_filename)
                
                real_save = os.path.realpath(save_path)
                real_base = os.path.realpath(CONFIGS_DIR)
                if not real_save.startswith(real_base + os.sep):
                    logger.warning(f"路径遍历拦截: {save_path}")
                    continue
                
                os.makedirs(os.path.dirname(save_path), exist_ok=True)
                
                file.save(save_path)
                uploaded_count += 1
                logger.info(f"上传文件：{save_path}")
        
        return jsonify({
            'success': True,
            'uploaded_count': uploaded_count
        })
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@board_config_bp.route('/mcu-list', methods=['GET'])
def get_mcu_list():
    """获取 Klipper 支持的 MCU 列表"""
    return jsonify({
        'success': True,
        'mcu_types': list(KLIPPER_MCU_LIST.keys()),
        'mcu_details': KLIPPER_MCU_LIST
    })


@board_config_bp.route('/manufacturers', methods=['GET'])
def get_preset_manufacturers():
    """获取厂家列表（从board_configs目录动态读取）"""
    try:
        manufacturers = set()
        
        if os.path.exists(BOARD_CONFIGS_DIR):
            for item in os.listdir(BOARD_CONFIGS_DIR):
                item_path = os.path.join(BOARD_CONFIGS_DIR, item)
                if os.path.isdir(item_path) and not item.startswith('.'):
                    manufacturers.add(item)
        
        if not manufacturers:
            manufacturers = set(PRESET_MANUFACTURERS)
        
        return jsonify({
            'success': True,
            'manufacturers': sorted(list(manufacturers))
        })
    except Exception as e:
        logger.error(f"获取厂家列表失败: {e}")
        return jsonify({
            'success': True,
            'manufacturers': PRESET_MANUFACTURERS
        })


@board_config_bp.route('/create-manufacturer', methods=['POST'])
def create_manufacturer():
    """创建新厂家目录"""
    try:
        data = request.get_json()
        manufacturer = data.get('name', '').strip()

        if not manufacturer:
            return jsonify({'success': False, 'error': '厂家名称不能为空'}), 400

        if not manufacturer.replace('-', '').replace('_', '').isalnum():
            return jsonify({'success': False, 'error': '厂家名称只能包含字母、数字、连字符和下划线'}), 400

        mfr_dir = os.path.join(BOARD_CONFIGS_DIR, manufacturer)

        if os.path.exists(mfr_dir):
            return jsonify({'success': False, 'error': '厂家已存在'}), 400

        os.makedirs(os.path.join(mfr_dir, 'mainboard'), exist_ok=True)
        os.makedirs(os.path.join(mfr_dir, 'toolboard'), exist_ok=True)

        logger.info(f"创建新厂家目录：{manufacturer}")

        return jsonify({
            'success': True,
            'message': f'厂家 {manufacturer} 创建成功',
            'manufacturer': manufacturer
        })
    except Exception as e:
        logger.error(f"创建厂家失败: {e}")
        return jsonify({'success': False, 'error': str(e)}), 500


@board_config_bp.route('/all', methods=['GET'])
def get_all_configs():
    """获取所有配置（不分厂家）"""
    all_configs = []
    
    try:
        for manufacturer in os.listdir(BOARD_CONFIGS_DIR):
            manufacturer_path = os.path.join(BOARD_CONFIGS_DIR, manufacturer)
            if not os.path.isdir(manufacturer_path) or manufacturer.startswith('.'):
                continue
                
            for board_type in os.listdir(manufacturer_path):
                type_path = os.path.join(manufacturer_path, board_type)
                if not os.path.isdir(type_path) or board_type.startswith('.') or board_type == 'BL':
                    continue
                    
                for filename in os.listdir(type_path):
                    if not filename.endswith('.json'):
                        continue
                        
                    config_path = os.path.join(type_path, filename)
                    try:
                        with open(config_path, 'r', encoding='utf-8') as f:
                            cfg_data = json.load(f)
                            cfg_data['manufacturer'] = manufacturer
                            all_configs.append(cfg_data)
                    except Exception as e:
                        logger.error(f"读取配置失败 {config_path}: {e}")
        
        return jsonify({
            'success': True,
            'configs': all_configs,
            'count': len(all_configs)
        })
    except Exception as e:
        logger.error(f"获取所有配置失败: {e}")
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500


@board_config_bp.route('/save', methods=['POST'])
def save_board_config():
    """保存配置（支持更新）"""
    try:
        config_data = request.json
        
        manufacturer = config_data.get('manufacturer', 'FLY')
        board_type = config_data.get('type', 'mainboard')
        config_id = config_data.get('id')
        
        if not config_id:
            return jsonify({
                'success': False,
                'error': '缺少配置 ID'
            }), 400
        
        config_dir = os.path.join(BOARD_CONFIGS_DIR, manufacturer, board_type)
        os.makedirs(config_dir, exist_ok=True)
        
        config_path = os.path.join(config_dir, f"{config_id}.json")
        with open(config_path, 'w', encoding='utf-8') as f:
            json.dump(config_data, f, ensure_ascii=False, indent=2)
        
        return jsonify({
            'success': True,
            'message': '配置已保存',
            'path': config_path
        })
        
    except Exception as e:
        logger.error(f"保存配置失败: {e}")
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500
