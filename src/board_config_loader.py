#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
主板配置加载器 - 支持厂家/类型/型号三级结构
"""

import json
import os
import logging

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CONFIGS_DIR = os.path.join(BASE_DIR, 'board_configs')
logger = logging.getLogger(__name__)
SKIP_BOARD_TYPE_DIRS = {'BL', 'firmware_update'}
BL_TYPE_DIR_ALIASES = {
    'mainboard': 'MainBoard',
    'toolboard': 'ToolBoard',
    'extension': 'ExtensionBoard',
    'extensionboard': 'ExtensionBoard',
    'screen': 'Screen',
}


def _safe_segment(value):
    value = str(value or '')
    segment = os.path.basename(os.path.normpath(value))
    return segment if segment and segment not in ('.', '..') else ''


def _path_in_configs(path):
    try:
        return os.path.commonpath([os.path.realpath(path), os.path.realpath(CONFIGS_DIR)]) == os.path.realpath(CONFIGS_DIR)
    except ValueError:
        return False


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
    """获取指定厂家的主板类型（动态读取所有子目录）"""
    types = []
    manufacturer = _safe_segment(manufacturer)
    if not manufacturer:
        return types
    manufacturer_dir = os.path.join(CONFIGS_DIR, manufacturer)
    if os.path.exists(manufacturer_dir):
        for item in os.listdir(manufacturer_dir):
            item_path = os.path.join(manufacturer_dir, item)
            # 包含所有子目录，但以 . 开头的隐藏目录和 BL 固件目录排除
            if os.path.isdir(item_path) and not item.startswith('.') and item not in SKIP_BOARD_TYPE_DIRS:
                types.append(item)
    return sorted(types)


def normalize_config(config):
    """将中文key的JSON配置转换为英文key"""
    # 中文到英文的映射
    key_mapping = {
        '产品类型': 'type',
        '名称': 'name',
        '处理器': 'processor',
        '晶振': 'clock',
        'BL偏移': 'bootloader_offset',
        '通讯方式': 'communication',
        '默认通讯': 'default_comm',
        '烧录方法': 'flash_methods',
        '默认烧录': 'default_flash',
        '启动引脚': 'boot_pins',       # 统一映射到 boot_pins
        'BL烧录': 'bl_flash_support',
        'BL默认方式': 'bl_default_method',
        'id': 'id',
        'MCU型号': 'mcu',
        'can_gpio_rx': 'can_gpio_rx',
        'can_gpio_tx': 'can_gpio_tx',
        'BL固件': 'bl_firmware',
        'BL烧录配置': 'bl_flash_config',
    }

    normalized = {}
    for cn_key, en_key in key_mapping.items():
        if cn_key in config:
            normalized[en_key] = config[cn_key]

    # 先处理处理器名称，并生成mcu字段
    is_rp2040 = False
    if 'processor' in normalized:
        processor = normalized['processor']
        if processor == 'Raspberry Pi RP2040':
            normalized['processor'] = 'RP2040'
            normalized['mcu'] = 'Raspberry Pi RP2040/RP235x'
            is_rp2040 = True
        elif processor == 'Raspberry Pi RP2350':
            normalized['processor'] = 'RP2350'
            normalized['mcu'] = 'Raspberry Pi RP2040/RP235x'
            is_rp2040 = True
        elif processor.startswith('STM32'):
            normalized['mcu'] = 'STMicroelectronics STM32'
        elif processor.startswith('GD32'):
            normalized['mcu'] = 'GigaDevice GD32'
        elif processor.startswith('CH32'):
            normalized['mcu'] = 'WCH CH32'
        elif processor.startswith('AT32'):
            normalized['mcu'] = 'ArteryTek AT32'
        elif processor.startswith('HC32'):
            normalized['mcu'] = 'HDSC HC32'
        elif processor.startswith('N32'):
            normalized['mcu'] = 'Nations N32'
        elif processor.startswith('MM32'):
            normalized['mcu'] = 'MindMotion MM32'

    # 根据处理器类型处理通讯方式映射回Klipper格式
    if 'communication' in normalized:
        if is_rp2040:
            # RP2040/RP2350 使用不带引脚的格式
            comm_map = {
                'USB': 'USBSERIAL',
                'CANBUS': 'CAN bus',
                'USB转CAN': 'USB to CAN bus bridge',
                '串口': 'UART'
            }
        else:
            # STM32等使用带引脚的格式
            comm_map = {
                'USB': 'USB (on PA11/PA12)',
                'USB转CAN': 'USB to CAN bus bridge (USB on PA11/PA12)',
                'CANBUS': 'CAN bus (on PB8/PB9)',
                '串口': 'Serial (on USART1 PA10/PA9)'
            }
        normalized['communication'] = [comm_map.get(c, c) for c in normalized['communication']]

    # 处理烧录方法映射
    if 'flash_methods' in normalized:
        method_map = {
            'TF卡': 'TF'
        }
        normalized['flash_methods'] = [method_map.get(m, m) for m in normalized['flash_methods']]

    return normalized


def load_board_config(manufacturer, board_type, board_id):
    """加载单个主板配置"""
    manufacturer = _safe_segment(manufacturer)
    board_type = _safe_segment(board_type)
    board_id = _safe_segment(board_id)
    if not manufacturer or not board_type or not board_id:
        return None
    filepath = os.path.join(CONFIGS_DIR, manufacturer, board_type, f"{board_id}.json")
    if not _path_in_configs(filepath):
        return None
    if os.path.exists(filepath):
        with open(filepath, 'r', encoding='utf-8') as f:
            config = json.load(f)
            # 标准化配置（中文key转英文）
            config = normalize_config(config)
            config['manufacturer'] = manufacturer
            config['board_type'] = board_type
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
                    try:
                        with open(filepath, 'r', encoding='utf-8') as f:
                            config = json.load(f)
                            # 标准化配置（中文key转英文）
                            config = normalize_config(config)
                            board_id = config.get('id') or filename[:-5]
                            boards[manufacturer][board_type][board_id] = config
                    except Exception as e:
                        logger.warning(f"跳过无效板卡配置 {filepath}: {e}")

    return boards


def get_board_list(manufacturer=None, board_type=None):
    """获取主板列表"""
    manufacturer = _safe_segment(manufacturer) if manufacturer else None
    board_type = _safe_segment(board_type) if board_type else None
    if manufacturer and board_type:
        # 返回指定厂家和类型的主板
        type_dir = os.path.join(CONFIGS_DIR, manufacturer, board_type)
        if not _path_in_configs(type_dir):
            return []
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


def get_bl_firmwares(manufacturer, board_type=None):
    """获取指定厂家的BL固件列表（支持按主板类型过滤）

    目录结构支持:
    1. BL/MainBoard/产品/xxx.bin  - 主板固件
    2. BL/ToolBoard/产品/xxx.uf2  - 工具板固件
    3. BL/ExtensionBoard/产品/xxx.bin - 扩展板固件
    4. BL/Screen/产品/xxx.bin - 屏幕固件
    5. BL/developer/产品/xxx.bin - 开发版固件
    6. BL/xxx.bin                   - 旧结构兼容
    """
    manufacturer = _safe_segment(manufacturer)
    board_type = _safe_segment(board_type) if board_type else None
    if not manufacturer:
        return []
    bl_dir = os.path.join(CONFIGS_DIR, manufacturer, 'BL')
    if not _path_in_configs(bl_dir):
        return []
    firmwares = []

    if not os.path.exists(bl_dir):
        return firmwares

    if board_type:
        # 指定了主板类型，只扫描该子目录
        bl_type_dir = BL_TYPE_DIR_ALIASES.get(board_type.lower(), board_type)
        type_dir = os.path.join(bl_dir, bl_type_dir)
        if os.path.exists(type_dir):
            for root, dirs, files in os.walk(type_dir):
                for filename in files:
                    if filename.lower().endswith(('.bin', '.uf2', '.hex')):
                        fw_path = os.path.join(root, filename)
                        if not _path_in_configs(fw_path):
                            continue
                        firmwares.append({
                            'name': filename,
                            'path': fw_path
                        })
    else:
        # 未指定类型，递归扫描所有子目录
        for root, dirs, files in os.walk(bl_dir):
            for filename in files:
                if filename.lower().endswith(('.bin', '.uf2', '.hex')):
                    fw_path = os.path.join(root, filename)
                    if not _path_in_configs(fw_path):
                        continue
                    firmwares.append({
                        'name': filename,
                        'path': fw_path
                    })

    # 按文件名排序
    firmwares.sort(key=lambda x: x['name'].lower())
    return firmwares
