#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
主板配置加载器 - 支持厂家/类型/型号三级结构
"""

import json
import os

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
CONFIGS_DIR = os.path.join(BASE_DIR, 'board_configs')


def get_manufacturers():
    """获取所有厂家列表"""
    manufacturers = []
    if os.path.exists(CONFIGS_DIR):
        for item in os.listdir(CONFIGS_DIR):
            item_path = os.path.join(CONFIGS_DIR, item)
            if os.path.isdir(item_path) and not item.startswith('.'):
                manufacturers.append(item)
    return sorted(manufacturers)


def get_board_types(manufacturer):
    """获取指定厂家的主板类型"""
    types = []
    manufacturer_dir = os.path.join(CONFIGS_DIR, manufacturer)
    if os.path.exists(manufacturer_dir):
        for item in os.listdir(manufacturer_dir):
            item_path = os.path.join(manufacturer_dir, item)
            if os.path.isdir(item_path) and item in ['mainboard', 'toolboard', 'extensionboard']:
                types.append(item)
    return sorted(types)


def load_board_config(manufacturer, board_type, board_id):
    """加载单个主板配置"""
    filepath = os.path.join(CONFIGS_DIR, manufacturer, board_type, f"{board_id}.json")
    if os.path.exists(filepath):
        with open(filepath, 'r', encoding='utf-8') as f:
            config = json.load(f)
            config['manufacturer'] = manufacturer
            config['type'] = board_type
            return config
    return None


def load_all_boards():
    """加载所有主板配置"""
    boards = {}
    
    for manufacturer in get_manufacturers():
        boards[manufacturer] = {}
        for board_type in get_board_types(manufacturer):
            boards[manufacturer][board_type] = {}
            type_dir = os.path.join(CONFIGS_DIR, manufacturer, board_type)
            
            for filename in os.listdir(type_dir):
                if filename.endswith('.json'):
                    filepath = os.path.join(type_dir, filename)
                    with open(filepath, 'r', encoding='utf-8') as f:
                        config = json.load(f)
                        board_id = config.get('id') or filename[:-5]
                        boards[manufacturer][board_type][board_id] = config
    
    return boards


def get_board_list(manufacturer=None, board_type=None):
    """获取主板列表"""
    if manufacturer and board_type:
        # 返回指定厂家和类型的主板
        type_dir = os.path.join(CONFIGS_DIR, manufacturer, board_type)
        if os.path.exists(type_dir):
            boards = []
            for filename in os.listdir(type_dir):
                if filename.endswith('.json'):
                    boards.append(filename[:-5])
            return sorted(boards)
        return []
    
    elif manufacturer:
        # 返回指定厂家的所有主板
        result = {}
        for btype in get_board_types(manufacturer):
            result[btype] = get_board_list(manufacturer, btype)
        return result
    
    else:
        # 返回所有
        result = {}
        for mfr in get_manufacturers():
            result[mfr] = get_board_list(mfr)
        return result


def get_bl_firmwares(manufacturer):
    """获取指定厂家的BL固件列表"""
    bl_dir = os.path.join(CONFIGS_DIR, manufacturer, 'BL')
    firmwares = []
    
    if os.path.exists(bl_dir):
        for filename in os.listdir(bl_dir):
            if filename.endswith('.bin') or filename.endswith('.uf2'):
                firmwares.append({
                    'name': filename,
                    'path': os.path.join(bl_dir, filename)
                })
    
    return firmwares
