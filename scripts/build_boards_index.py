#!/usr/bin/env python3
"""
构建板卡索引文件 boards_index.json
从 board.zip 解压的板卡数据 + 现有 board_configs 中提取信息
"""
import json
import os
import glob

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BOARDS_DIR = os.path.join(BASE_DIR, 'data', 'boards', 'board')
CONFIGS_DIR = os.path.join(BASE_DIR, 'board_configs')
OUTPUT = os.path.join(BASE_DIR, 'data', 'boards_index.json')

# board.zip 目录名 -> board_configs 中的 id 映射
BOARD_TO_CONFIG = {
    'C5': 'fly-c5',
    'C8': 'fly-c8',
    'C8P': 'fly-c8p',
    'D5': 'fly-d5',
    'D7': 'fly-d7',
    'D8': 'fly-d8-f407',
    'D8-PRO': 'fly-d8-h723',  # D8-PRO 使用 H723
    'DP5': 'fly-dp5',
    'E3-PRO': None,  # 无对应 config
    'E3-Ultra': 'fly-e3-ultra',
    'E3-V2': 'fly-e3-v2',
    'F407ZG': 'fly-f407zg',
    'Gemini-V3': 'fly-gemini-v3',
    'Micro4': 'fly-micro4',
    'Pro-X10': 'fly-pro-x10',
    'SUPER5-PRO': 'fly-super5',
    'SUPER8': 'fly-super8',
    'SUPER8-PRO': 'fly-super8-pro',
}

# 工具板映射
TOOLBOARD_MAP = {
    'ERCF': 'ercf',
    'ERCF-V1': 'ercf',
    'ERCF-V2': 'ercfv2',
    'MMU': 'mmu',
    'SB2040PROV3': 'sb2040-pro-v3',
    'SB2040V3': 'sb2040-v3',
    'SHT36V3': 'sht36_v3',
}


def load_config_info(manufacturer, config_id):
    """从现有 board_configs 加载 MCU 等信息"""
    if not config_id:
        return None
    for board_type in ['mainboard', 'toolboard']:
        path = os.path.join(CONFIGS_DIR, manufacturer, board_type, f'{config_id}.json')
        if os.path.isfile(path):
            with open(path, 'r', encoding='utf-8') as f:
                return json.load(f)
    return None


def analyze_mapping(mapping):
    """分析 klipper_Mapping.json 的结构"""
    drive_count = sum(1 for k in mapping if k.startswith('Drives'))
    
    # 统计各类引脚
    heat_keys = [k for k in mapping if k.startswith('heat')]
    temp_keys = [k for k in mapping if k.startswith('temp')]
    fan_keys = [k for k in mapping if k.startswith('fan')]
    stop_keys = [k for k in mapping if k.startswith('stop')]
    
    has_bed = 'bed-heat' in mapping or 'BED_OUT' in mapping
    has_probe = 'probe' in mapping
    has_servo = 'servo' in mapping
    
    # 判断引脚类型（P格式 vs GPIO格式）
    pin_style = 'P'  # 默认
    for k, v in mapping.items():
        if isinstance(v, str) and v.startswith('gpio'):
            pin_style = 'gpio'
            break
        elif isinstance(v, dict) and isinstance(v.get('step_pin', ''), str) and v['step_pin'].startswith('gpio'):
            pin_style = 'gpio'
            break
    
    return {
        'drive_count': drive_count,
        'heat_count': len(heat_keys),
        'temp_count': len(temp_keys),
        'fan_count': len(fan_keys),
        'stop_count': len(stop_keys),
        'has_bed': has_bed,
        'has_probe': has_probe,
        'has_servo': has_servo,
        'pin_style': pin_style,
    }


def find_image(board_dir, board_name):
    """查找板卡图片"""
    for ext in ['.png', '.jpg', '.jpeg']:
        img_path = os.path.join(board_dir, f'{board_name}{ext}')
        if os.path.isfile(img_path):
            # 返回相对路径
            rel = os.path.relpath(img_path, os.path.join(BASE_DIR, 'data'))
            return rel.replace('\\', '/')
    return None


def build_index():
    index = {}
    
    # 目前只有 FLY 品牌
    manufacturer = 'FLY'
    index[manufacturer] = {'mainboards': {}, 'toolboards': {}}
    
    # 处理主板
    for board_name in sorted(os.listdir(BOARDS_DIR)):
        board_dir = os.path.join(BOARDS_DIR, board_name)
        if not os.path.isdir(board_dir) or board_name == 'tool_board':
            continue
        
        mapping_file = os.path.join(board_dir, 'klipper_Mapping.json')
        if not os.path.isfile(mapping_file):
            continue
        
        with open(mapping_file, 'r', encoding='utf-8') as f:
            mapping = json.load(f)
        
        info = analyze_mapping(mapping)
        config_id = BOARD_TO_CONFIG.get(board_name)
        config_info = load_config_info(manufacturer, config_id)
        
        # 生成 board_id
        board_id = f'fly-{board_name.lower().replace("-pro", "pro").replace(" ", "-")}'
        if config_info:
            board_id = config_info['id']
        
        # 确定连接方式
        connections = []
        if config_info:
            connections = config_info.get('connections', [])
        else:
            # 从 klipper_rules 推断
            mcu = config_info.get('mcu', '') if config_info else ''
            if info['pin_style'] == 'gpio':
                connections = ['USB', 'CAN']
            else:
                connections = ['USB']
        
        image = find_image(board_dir, board_name)
        
        board_data = {
            'name': config_info['name'] if config_info else f'FLY-{board_name}',
            'board_id': board_id,
            'mcu': config_info['mcu'] if config_info else 'unknown',
            'platform': config_info['platform'] if config_info else 'unknown',
            'drive_count': info['drive_count'],
            'has_bed': info['has_bed'],
            'heat_count': info['heat_count'],
            'temp_count': info['temp_count'],
            'fan_count': info['fan_count'],
            'stop_count': info['stop_count'],
            'has_probe': info['has_probe'],
            'has_servo': info['has_servo'],
            'pin_style': info['pin_style'],
            'connections': connections,
            'image': image,
            'mapping_dir': f'board/{board_name}',
        }
        
        index[manufacturer]['mainboards'][board_id] = board_data
    
    # 处理工具板
    tool_dir = os.path.join(BOARDS_DIR, 'tool_board')
    if os.path.isdir(tool_dir):
        for board_name in sorted(os.listdir(tool_dir)):
            board_dir = os.path.join(tool_dir, board_name)
            if not os.path.isdir(board_dir):
                continue
            
            mapping_file = os.path.join(board_dir, 'klipper_Mapping.json')
            if not os.path.isfile(mapping_file):
                continue
            
            with open(mapping_file, 'r', encoding='utf-8') as f:
                mapping = json.load(f)
            
            info = analyze_mapping(mapping)
            config_id = TOOLBOARD_MAP.get(board_name)
            config_info = load_config_info(manufacturer, config_id)
            
            board_id = config_info['id'] if config_info else f'fly-{board_name.lower()}'
            
            connections = config_info.get('connections', ['CAN', 'USB']) if config_info else ['CAN', 'USB']
            image = find_image(board_dir, board_name)
            
            board_data = {
                'name': config_info['name'] if config_info else f'FLY-{board_name}',
                'board_id': board_id,
                'mcu': config_info['mcu'] if config_info else 'rp2040',
                'platform': config_info['platform'] if config_info else 'RP2040',
                'drive_count': info['drive_count'],
                'has_bed': info['has_bed'],
                'heat_count': info['heat_count'],
                'temp_count': info['temp_count'],
                'fan_count': info['fan_count'],
                'stop_count': info['stop_count'],
                'has_probe': info['has_probe'],
                'has_servo': info['has_servo'],
                'pin_style': info['pin_style'],
                'connections': connections,
                'image': image,
                'mapping_dir': f'board/tool_board/{board_name}',
            }
            
            index[manufacturer]['toolboards'][board_id] = board_data
    
    with open(OUTPUT, 'w', encoding='utf-8') as f:
        json.dump(index, f, indent=2, ensure_ascii=False)
    
    print(f'索引已生成: {OUTPUT}')
    print(f'  主板: {len(index[manufacturer]["mainboards"])} 块')
    print(f'  工具板: {len(index[manufacturer]["toolboards"])} 块')


if __name__ == '__main__':
    build_index()
