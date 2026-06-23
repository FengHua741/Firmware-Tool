"""
固件更新配置蓝图 - 固件更新配置的增删改查
"""

from flask import Blueprint, jsonify, request
import os
import json

from shared import (
    app, config, logger, BASE_DIR, BOARD_CONFIGS_DIR,
    sanitize_manufacturer, sanitize_config_id,
)

firmware_update_bp = Blueprint('firmware_update', __name__, url_prefix='/api/firmware-update')


@firmware_update_bp.route('/configs', methods=['GET'])
def list_firmware_update_configs():
    """列出所有固件更新配置"""
    try:
        configs = []
        
        if os.path.exists(BOARD_CONFIGS_DIR):
            for manufacturer in os.listdir(BOARD_CONFIGS_DIR):
                mfr_dir = os.path.join(BOARD_CONFIGS_DIR, manufacturer)
                if not os.path.isdir(mfr_dir) or manufacturer.startswith('.'):
                    continue
                    
                update_dir = os.path.join(mfr_dir, 'firmware_update')
                if not os.path.exists(update_dir):
                    continue
                
                for filename in os.listdir(update_dir):
                    if filename.endswith('.json'):
                        filepath = os.path.join(update_dir, filename)
                        try:
                            with open(filepath, 'r', encoding='utf-8') as f:
                                cfg_data = json.load(f)
                                cfg_data['_filepath'] = filepath
                                cfg_data['_manufacturer'] = manufacturer
                                configs.append(cfg_data)
                        except Exception as e:
                            logger.warning(f"读取固件更新配置失败 {filepath}: {e}")
        
        return jsonify({
            'success': True,
            'configs': configs
        })
        
    except Exception as e:
        logger.error(f"列出固件更新配置失败: {e}")
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500


@firmware_update_bp.route('/config/<manufacturer>/<config_id>', methods=['GET'])
def get_firmware_update_config(manufacturer, config_id):
    """获取固件更新配置"""
    try:
        manufacturer = sanitize_manufacturer(manufacturer)
        if not manufacturer:
            return jsonify({'success': False, 'error': '无效的厂家名称'}), 400
        config_id = sanitize_config_id(config_id)
        if not config_id:
            return jsonify({'success': False, 'error': '无效的配置ID'}), 400
        filepath = os.path.join(BOARD_CONFIGS_DIR, manufacturer, 'firmware_update', f"{config_id}.json")
        
        if not os.path.exists(filepath):
            return jsonify({
                'success': False,
                'error': '配置不存在'
            }), 404
        
        with open(filepath, 'r', encoding='utf-8') as f:
            cfg_data = json.load(f)
        
        return jsonify({
            'success': True,
            'config': cfg_data
        })
        
    except Exception as e:
        logger.error(f"获取固件更新配置失败: {e}")
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500


@firmware_update_bp.route('/config/<manufacturer>/<config_id>', methods=['POST', 'PUT'])
def save_firmware_update_config(manufacturer, config_id):
    """保存固件更新配置"""
    try:
        manufacturer = sanitize_manufacturer(manufacturer)
        if not manufacturer:
            return jsonify({'success': False, 'error': '无效的厂家名称'}), 400
        config_id = sanitize_config_id(config_id)
        if not config_id:
            return jsonify({'success': False, 'error': '无效的配置ID'}), 400
        config_data = request.json
        
        update_dir = os.path.join(BOARD_CONFIGS_DIR, manufacturer, 'firmware_update')
        os.makedirs(update_dir, exist_ok=True)
        
        filepath = os.path.join(update_dir, f"{config_id}.json")
        with open(filepath, 'w', encoding='utf-8') as f:
            json.dump(config_data, f, ensure_ascii=False, indent=2)
        
        return jsonify({
            'success': True,
            'message': '固件更新配置已保存',
            'path': filepath
        })
        
    except Exception as e:
        logger.error(f"保存固件更新配置失败: {e}")
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500


@firmware_update_bp.route('/config/<manufacturer>/<config_id>', methods=['DELETE'])
def delete_firmware_update_config(manufacturer, config_id):
    """删除固件更新配置"""
    try:
        manufacturer = sanitize_manufacturer(manufacturer)
        if not manufacturer:
            return jsonify({'success': False, 'error': '无效的厂家名称'}), 400
        config_id = sanitize_config_id(config_id)
        if not config_id:
            return jsonify({'success': False, 'error': '无效的配置ID'}), 400
        filepath = os.path.join(BOARD_CONFIGS_DIR, manufacturer, 'firmware_update', f"{config_id}.json")
        
        if not os.path.exists(filepath):
            return jsonify({
                'success': False,
                'error': '配置不存在'
            }), 404
        
        os.remove(filepath)
        
        return jsonify({
            'success': True,
            'message': '固件更新配置已删除'
        })
        
    except Exception as e:
        logger.error(f"删除固件更新配置失败: {e}")
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500
