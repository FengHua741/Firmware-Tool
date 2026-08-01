"""
板级配置管理蓝图 - 配置的增删改查
"""

from flask import Blueprint, jsonify, request
import os
import re
import json

from shared import (
    config, logger, BASE_DIR, BOARD_CONFIGS_DIR, CONFIGS_DIR,
    sanitize_manufacturer, sanitize_config_id,
    safe_error,
)

board_config_bp = Blueprint('board_config', __name__, url_prefix='/api/config')

# 预设厂家列表
PRESET_MANUFACTURERS = ["FLY", "BTT", "MKS", "Creality", "Prusa", "Voron", "自定义"]
ALLOWED_BOARD_TYPES = {'mainboard', 'toolboard', 'expansion'}
MAX_UPLOAD_CONFIG_SIZE = 512 * 1024


def _normalize_board_type(board_type):
    board_type = sanitize_config_id(str(board_type or 'mainboard'))
    return board_type if board_type in ALLOWED_BOARD_TYPES else 'mainboard'


def _is_board_config_type(board_type):
    return sanitize_config_id(board_type) == board_type and board_type in ALLOWED_BOARD_TYPES


def _path_in_board_configs(path):
    try:
        real_base = os.path.realpath(BOARD_CONFIGS_DIR)
        return os.path.commonpath([os.path.realpath(path), real_base]) == real_base
    except ValueError:
        return False

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
                if os.path.isdir(type_dir) and _is_board_config_type(board_type):
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

        return jsonify({'configs': configs, 'board_types': sorted(board_types)})
    except Exception as e:
        return jsonify({'error': safe_error(e)}), 500


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
                if not os.path.isdir(type_dir) or not _is_board_config_type(board_type):
                    continue
                filepath = os.path.join(type_dir, f"{config_id}.json")
                if os.path.exists(filepath):
                    with open(filepath, 'r', encoding='utf-8') as f:
                        cfg_data = json.load(f)
                    return jsonify(cfg_data)

        return jsonify({'error': '配置不存在'}), 404
    except Exception as e:
        return jsonify({'error': safe_error(e)}), 500


@board_config_bp.route('/create/<manufacturer>', methods=['POST'])
def create_config(manufacturer):
    """创建新配置"""
    try:
        data = request.get_json(silent=True) or {}

        if not data or 'name' not in data:
            return jsonify({'error': 'Missing required fields'}), 400

        manufacturer = sanitize_manufacturer(manufacturer)
        if not manufacturer:
            return jsonify({'error': '无效的厂家名称'}), 400

        product_type = _normalize_board_type(data.get('type', 'mainboard'))

        config_id = sanitize_config_id(data.get('id') or generate_id_from_name(data['name']))
        if not config_id:
            return jsonify({'error': '无效的配置ID'}), 400
        data['manufacturer'] = manufacturer
        data['type'] = product_type
        data['id'] = config_id

        type_dir = os.path.join(CONFIGS_DIR, manufacturer, product_type)
        if not _path_in_board_configs(type_dir):
            return jsonify({'error': '非法路径'}), 403
        os.makedirs(type_dir, exist_ok=True)

        filepath = os.path.join(type_dir, f"{config_id}.json")
        if os.path.exists(filepath):
            return jsonify({'error': '配置 ID 已存在'}), 409
        with open(filepath, 'w', encoding='utf-8') as f:
            json.dump(data, f, indent=4, ensure_ascii=False)

        logger.info(f"创建配置：{manufacturer}/{product_type}/{config_id}.json")

        return jsonify({
            'success': True,
            'id': config_id,
            'path': filepath
        })
    except Exception as e:
        return jsonify({'error': safe_error(e)}), 500


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
                if not os.path.isdir(type_dir) or not _is_board_config_type(board_type):
                    continue
                filepath = os.path.join(type_dir, f"{config_id}.json")
                if os.path.exists(filepath):
                    os.remove(filepath)
                    logger.info(f"删除配置：{filepath}")
                    return jsonify({'success': True})

        return jsonify({'error': '配置不存在'}), 404
    except Exception as e:
        return jsonify({'error': safe_error(e)}), 500


@board_config_bp.route('/upload', methods=['POST'])
def upload_config():
    """上传配置文件"""
    try:
        manufacturer = request.form.get('manufacturer', 'FLY')
        manufacturer = sanitize_manufacturer(manufacturer)
        if not manufacturer:
            return jsonify({'error': '无效的厂家名称'}), 400
        board_type = _normalize_board_type(request.form.get('type') or request.form.get('board_type') or 'mainboard')
        files = request.files.getlist('files[]')

        if not files:
            return jsonify({'error': '没有文件'}), 400

        uploaded_count = 0
        errors = []

        for file in files:
            if file.filename:
                safe_filename = os.path.basename(file.filename)
                if not safe_filename or safe_filename.startswith('.'):
                    msg = f"跳过不安全的文件名: {file.filename}"
                    errors.append(msg)
                    logger.warning(msg)
                    continue
                if not safe_filename.lower().endswith('.json'):
                    msg = f"仅支持上传 JSON 板卡配置: {safe_filename}"
                    errors.append(msg)
                    logger.warning(msg)
                    continue
                if file.content_length and file.content_length > MAX_UPLOAD_CONFIG_SIZE:
                    msg = f"配置文件过大: {safe_filename}"
                    errors.append(msg)
                    logger.warning(msg)
                    continue

                try:
                    file.stream.seek(0, os.SEEK_END)
                    size = file.stream.tell()
                    file.stream.seek(0)
                    if size > MAX_UPLOAD_CONFIG_SIZE:
                        msg = f"配置文件过大: {safe_filename}"
                        errors.append(msg)
                        logger.warning(msg)
                        continue
                    cfg_data = json.load(file.stream)
                except Exception as e:
                    msg = f"JSON 解析失败 {safe_filename}: {e}"
                    errors.append(msg)
                    logger.warning(msg)
                    continue

                config_id = sanitize_config_id(
                    cfg_data.get('id') or os.path.splitext(safe_filename)[0]
                )
                if not config_id:
                    msg = f"无效的配置 ID: {safe_filename}"
                    errors.append(msg)
                    logger.warning(msg)
                    continue

                cfg_board_type = _normalize_board_type(cfg_data.get('type') or board_type)
                cfg_data['id'] = config_id
                cfg_data['manufacturer'] = manufacturer
                cfg_data['type'] = cfg_board_type

                save_path = os.path.join(CONFIGS_DIR, manufacturer, cfg_board_type, f"{config_id}.json")

                if not _path_in_board_configs(save_path):
                    msg = f"路径遍历拦截: {save_path}"
                    errors.append(msg)
                    logger.warning(msg)
                    continue

                os.makedirs(os.path.dirname(save_path), exist_ok=True)

                with open(save_path, 'w', encoding='utf-8') as f:
                    json.dump(cfg_data, f, indent=2, ensure_ascii=False)
                uploaded_count += 1
                logger.info(f"上传文件：{save_path}")

        return jsonify({
            'success': True,
            'uploaded_count': uploaded_count,
            'errors': errors
        })
    except Exception as e:
        return jsonify({'error': safe_error(e)}), 500


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
        data = request.get_json(silent=True) or {}
        manufacturer = sanitize_manufacturer(data.get('name', '').strip())

        if not manufacturer:
            return jsonify({'success': False, 'error': '厂家名称不能为空'}), 400

        mfr_dir = os.path.join(BOARD_CONFIGS_DIR, manufacturer)
        if not _path_in_board_configs(mfr_dir):
            return jsonify({'success': False, 'error': '非法路径'}), 403

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
        return jsonify({'success': False, 'error': safe_error(e)}), 500


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
                if not os.path.isdir(type_path) or not _is_board_config_type(board_type):
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
            'error': safe_error(e)
        }), 500


@board_config_bp.route('/save', methods=['POST'])
def save_board_config():
    """保存配置（支持更新）"""
    try:
        config_data = request.get_json(silent=True) or {}
        if not isinstance(config_data, dict):
            return jsonify({'success': False, 'error': '请求体必须是 JSON 对象'}), 400

        manufacturer = sanitize_manufacturer(config_data.get('manufacturer', 'FLY'))
        board_type = _normalize_board_type(config_data.get('type', 'mainboard'))
        config_id = sanitize_config_id(config_data.get('id'))

        if not manufacturer:
            return jsonify({
                'success': False,
                'error': '无效的厂家名称'
            }), 400

        if not config_id:
            return jsonify({
                'success': False,
                'error': '缺少配置 ID'
            }), 400

        config_data['manufacturer'] = manufacturer
        config_data['type'] = board_type
        config_data['id'] = config_id

        config_dir = os.path.join(BOARD_CONFIGS_DIR, manufacturer, board_type)
        if not _path_in_board_configs(config_dir):
            return jsonify({'success': False, 'error': '非法路径'}), 403
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
            'error': safe_error(e)
        }), 500


# ==================== 配置导入/导出 ====================

@board_config_bp.route('/export-all', methods=['GET'])
def export_all_configs():
    """将所有板卡配置 + 机型预设 + 应用设置打包为 ZIP 下载"""
    import io
    import time as _time
    import zipfile
    from flask import send_file
    from shared import public_config

    try:
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as zf:
            for root, dirs, files in os.walk(BOARD_CONFIGS_DIR):
                dirs[:] = [d for d in dirs if not d.startswith('.')]
                for fname in files:
                    if fname.endswith('.json'):
                        full = os.path.join(root, fname)
                        arcname = os.path.relpath(full, BOARD_CONFIGS_DIR)
                        zf.write(full, f'board_configs/{arcname}')

            machines_dir = os.path.join(BASE_DIR, 'data', 'machines')
            if os.path.isdir(machines_dir):
                for fname in os.listdir(machines_dir):
                    if fname.endswith('.json'):
                        zf.write(os.path.join(machines_dir, fname), f'machines/{fname}')

            zf.writestr('settings.json', json.dumps(public_config(), indent=2, ensure_ascii=False))
            zf.writestr('manifest.json', json.dumps({
                'tool': 'Firmware-Tool',
                'exported_at': _time.strftime('%Y-%m-%dT%H:%M:%S'),
                'schema': 1,
            }, ensure_ascii=False))

        buf.seek(0)
        return send_file(buf, mimetype='application/zip',
                         as_attachment=True, download_name='firmware-tool-export.zip')
    except Exception as e:
        logger.error(f"导出配置失败: {e}")
        return jsonify({'success': False, 'error': safe_error(e)}), 500


@board_config_bp.route('/import-bundle', methods=['POST'])
def import_config_bundle():
    """上传 ZIP 配置包，验证后恢复板卡配置和机型预设"""
    import io
    import zipfile

    if 'file' not in request.files:
        return jsonify({'success': False, 'error': '未上传文件'}), 400
    f = request.files['file']
    if not f.filename.endswith('.zip'):
        return jsonify({'success': False, 'error': '仅支持 .zip 格式'}), 400

    try:
        data = f.read()
        if len(data) > 50 * 1024 * 1024:
            return jsonify({'success': False, 'error': '文件过大 (最大50MB)'}), 413

        zf = zipfile.ZipFile(io.BytesIO(data))
        names = zf.namelist()
        if 'manifest.json' not in names:
            return jsonify({'success': False, 'error': '无效的配置包 (缺少 manifest.json)'}), 400

        # 解压炸弹防护：限制条目数量与解压后总大小（S6）
        MAX_ZIP_ENTRIES = 2000
        MAX_ZIP_TOTAL_SIZE = 200 * 1024 * 1024
        if len(names) > MAX_ZIP_ENTRIES:
            return jsonify({'success': False, 'error': '配置包文件条目过多'}), 413
        total_unpacked = 0
        for info in zf.infolist():
            total_unpacked += info.file_size
            if total_unpacked > MAX_ZIP_TOTAL_SIZE:
                return jsonify({'success': False, 'error': '配置包解压后过大'}), 413

        restored = {'board_configs': 0, 'machines': 0}
        for name in names:
            if '..' in name or name.startswith('/'):
                continue
            if name.startswith('board_configs/') and name.endswith('.json'):
                rel = name[len('board_configs/'):]
                dest = os.path.join(BOARD_CONFIGS_DIR, rel)
                if not _path_in_board_configs(dest):
                    continue
                content = zf.read(name)
                try:
                    json.loads(content)
                except (json.JSONDecodeError, UnicodeDecodeError):
                    continue
                os.makedirs(os.path.dirname(dest), exist_ok=True)
                with open(dest, 'wb') as out:
                    out.write(content)
                restored['board_configs'] += 1
            elif name.startswith('machines/') and name.endswith('.json'):
                rel = os.path.basename(name)
                dest = os.path.join(BASE_DIR, 'data', 'machines', rel)
                content = zf.read(name)
                try:
                    json.loads(content)
                except (json.JSONDecodeError, UnicodeDecodeError):
                    continue
                os.makedirs(os.path.dirname(dest), exist_ok=True)
                with open(dest, 'wb') as out:
                    out.write(content)
                restored['machines'] += 1

        return jsonify({
            'success': True,
            'message': f'导入完成: {restored["board_configs"]} 个板卡配置, {restored["machines"]} 个机型预设',
            'restored': restored,
        })
    except zipfile.BadZipFile:
        return jsonify({'success': False, 'error': '无效的 ZIP 文件'}), 400
    except Exception as e:
        logger.error(f"导入配置失败: {e}")
        return jsonify({'success': False, 'error': safe_error(e)}), 500
