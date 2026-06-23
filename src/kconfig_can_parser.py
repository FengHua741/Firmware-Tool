#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Kconfig 选项解析器
从 Klipper 的 Kconfig 文件中动态提取通信接口和 CAN 总线引脚选项
"""

import re
import os
import json
import logging

logger = logging.getLogger(__name__)

# 处理器 -> 能力标志 映射 (从 Kconfig 定义推导)
PROCESSOR_CAPABILITIES = {
    # STM32F0x2 系列 (USBFS via F0x2)
    'STM32F042': ['MACH_STM32F042', 'MACH_STM32F0x2', 'MACH_STM32F0', 'HAVE_STM32_USBFS', 'HAVE_STM32_CANBUS', 'HAVE_STM32_USBCANBUS'],
    'STM32F072': ['MACH_STM32F072', 'MACH_STM32F0x2', 'MACH_STM32F0', 'HAVE_STM32_USBFS', 'HAVE_STM32_CANBUS', 'HAVE_STM32_USBCANBUS'],
    # STM32F1 系列 (USBFS via F1, 假设外部时钟; 无 USBCANBUS 因 !MACH_STM32F1)
    'STM32F103': ['MACH_STM32F103', 'MACH_STM32F1', 'HAVE_STM32_USBFS', 'HAVE_STM32_CANBUS'],
    # STM32F2 系列 (USBOTG)
    'STM32F207': ['MACH_STM32F207', 'MACH_STM32F2', 'HAVE_STM32_USBOTG', 'HAVE_STM32_CANBUS'],
    # STM32F4 系列 (USBOTG)
    'STM32F401': ['MACH_STM32F401', 'MACH_STM32F4', 'HAVE_STM32_USBOTG'],
    'STM32F405': ['MACH_STM32F405', 'MACH_STM32F4', 'MACH_STM32F4x5', 'HAVE_STM32_USBOTG', 'HAVE_STM32_CANBUS', 'HAVE_STM32_USBCANBUS'],
    'STM32F407': ['MACH_STM32F407', 'MACH_STM32F4', 'MACH_STM32F4x5', 'HAVE_STM32_USBOTG', 'HAVE_STM32_CANBUS', 'HAVE_STM32_USBCANBUS'],
    'STM32F429': ['MACH_STM32F429', 'MACH_STM32F4', 'MACH_STM32F4x5', 'HAVE_STM32_USBOTG', 'HAVE_STM32_CANBUS', 'HAVE_STM32_USBCANBUS'],
    'STM32F446': ['MACH_STM32F446', 'MACH_STM32F4', 'HAVE_STM32_USBOTG', 'HAVE_STM32_CANBUS', 'HAVE_STM32_USBCANBUS'],
    # STM32G0 系列 (USBFS via G0Bx)
    'STM32G0B1': ['MACH_STM32G0B1', 'MACH_STM32G0', 'MACH_STM32G0Bx', 'HAVE_STM32_USBFS', 'HAVE_STM32_FDCANBUS', 'HAVE_STM32_USBCANBUS'],
    # STM32G4 系列 (USBFS via G4)
    'STM32G431': ['MACH_STM32G431', 'MACH_STM32G4', 'HAVE_STM32_USBFS', 'HAVE_STM32_FDCANBUS', 'HAVE_STM32_USBCANBUS'],
    'STM32G474': ['MACH_STM32G474', 'MACH_STM32G4', 'HAVE_STM32_USBFS', 'HAVE_STM32_FDCANBUS', 'HAVE_STM32_USBCANBUS'],
    # STM32H7 系列 (USBOTG)
    'STM32H723': ['MACH_STM32H723', 'MACH_STM32H7', 'HAVE_STM32_USBOTG', 'HAVE_STM32_FDCANBUS', 'HAVE_STM32_USBCANBUS'],
    'STM32H743': ['MACH_STM32H743', 'MACH_STM32H7', 'HAVE_STM32_USBOTG', 'HAVE_STM32_FDCANBUS', 'HAVE_STM32_USBCANBUS'],
    'STM32H750': ['MACH_STM32H750', 'MACH_STM32H7', 'HAVE_STM32_USBOTG', 'HAVE_STM32_FDCANBUS', 'HAVE_STM32_USBCANBUS'],
    # STM32 无USB系列
    'STM32F031': ['MACH_STM32F031', 'MACH_STM32F0'],
    'STM32F070': ['MACH_STM32F070', 'MACH_STM32F0'],
    'STM32G070': ['MACH_STM32G070', 'MACH_STM32G0', 'MACH_STM32G07x', 'HAVE_STM32_FDCANBUS'],
    'STM32G0B0': ['MACH_STM32G0B0', 'MACH_STM32G0', 'MACH_STM32G0Bx', 'HAVE_STM32_USBFS', 'HAVE_STM32_FDCANBUS'],
    'STM32F765': ['MACH_STM32F765', 'MACH_STM32F7', 'HAVE_STM32_USBOTG', 'HAVE_STM32_FDCANBUS'],
    'STM32L412': ['MACH_STM32L412', 'MACH_STM32L4', 'HAVE_STM32_USBOTG'],
    'N32G452': ['MACH_N32G452', 'MACH_N32G45x', 'MACH_STM32F1', 'HAVE_STM32_USBFS', 'HAVE_STM32_CANBUS'],
    'N32G455': ['MACH_N32G455', 'MACH_N32G45x', 'MACH_STM32F1', 'HAVE_STM32_USBFS', 'HAVE_STM32_CANBUS'],
    # RP2040 系列
    'RP2040': ['MACH_RPXXXX', 'MACH_RP2040'],
    'RP2350': ['MACH_RPXXXX', 'MACH_RP2350'],
    # ATSAMD 系列
    'SAMD21G18': ['MACH_SAMD21G18', 'MACH_SAMD21', 'HAVE_SAMD_USB', 'HAVE_SAMD_CANBUS'],
    'SAMD21E18': ['MACH_SAMD21E18', 'MACH_SAMD21', 'HAVE_SAMD_USB', 'HAVE_SAMD_CANBUS'],
    'SAMD21J18': ['MACH_SAMD21J18', 'MACH_SAMD21', 'HAVE_SAMD_USB', 'HAVE_SAMD_CANBUS'],
    'SAMD21E15': ['MACH_SAMD21E15', 'MACH_SAMD21', 'HAVE_SAMD_USB', 'HAVE_SAMD_CANBUS'],
    'SAMC21G18': ['MACH_SAMC21G18', 'MACH_SAMC21', 'HAVE_SAMD_CANBUS'],
    'SAMD51G19': ['MACH_SAMD51G19', 'MACH_SAMD51', 'HAVE_SAMD_USB', 'HAVE_SAMD_CANBUS'],
    'SAMD51J19': ['MACH_SAMD51J19', 'MACH_SAMD51', 'HAVE_SAMD_USB', 'HAVE_SAMD_CANBUS'],
    'SAMD51N19': ['MACH_SAMD51N19', 'MACH_SAMD51', 'HAVE_SAMD_USB', 'HAVE_SAMD_CANBUS'],
    'SAMD51P20': ['MACH_SAMD51P20', 'MACH_SAMD51', 'HAVE_SAMD_USB', 'HAVE_SAMD_CANBUS'],
    'SAME51J19': ['MACH_SAME51J19', 'MACH_SAME51', 'HAVE_SAMD_USB', 'HAVE_SAMD_CANBUS'],
    'SAME51N19': ['MACH_SAME51N19', 'MACH_SAME51', 'HAVE_SAMD_USB', 'HAVE_SAMD_CANBUS'],
    'SAME54P20': ['MACH_SAME54P20', 'MACH_SAME54', 'HAVE_SAMD_USB', 'HAVE_SAMD_CANBUS'],
    # LPC176x 系列
    'LPC1768': ['MACH_LPC1768'],
    'LPC1769': ['MACH_LPC1769'],
    # HC32F460 系列
    'HC32F460': ['MACH_HC32F460'],
    # ATSAM 系列
    'SAM3X8E': ['MACH_SAM3X8E', 'MACH_SAM3X', 'HAVE_SAM_CANBUS'],
    'SAM3X8C': ['MACH_SAM3X8C', 'MACH_SAM3X', 'HAVE_SAM_CANBUS'],
    'SAM4S8C': ['MACH_SAM4S8C', 'MACH_SAM4S'],
    'SAM4E8E': ['MACH_SAM4E8E', 'MACH_SAM4E', 'HAVE_SAM_CANBUS'],
    'SAME70Q20B': ['MACH_SAME70Q20B', 'MACH_SAME70', 'HAVE_SAM_CANBUS'],
    # AVR 系列
    'ATMEGA2560': ['MACH_atmega2560'],
    'ATMEGA1280': ['MACH_atmega1280'],
    'AT90USB1286': ['MACH_at90usb1286'],
    'AT90USB646': ['MACH_at90usb646'],
    'ATMEGA32U4': ['MACH_atmega32u4'],
    'ATMEGA1284P': ['MACH_atmega1284p'],
    'ATMEGA644P': ['MACH_atmega644p'],
    'ATMEGA328P': ['MACH_atmega328p'],
    'ATMEGA328': ['MACH_atmega328'],
    'ATMEGA168': ['MACH_atmega168'],
    'LGT8F328P': ['MACH_lgt8f328p'],
}

# select 值到 comm_type 的映射
SELECT_TO_COMM_TYPE = {
    'USBSERIAL': 'usb',
    'SERIAL': 'serial',
    'CANSERIAL': 'can',
    'USBCANBUS': 'usbcanbridge',
}


# 固件编译器中始终启用的选项，解析时视为 true 并忽略
ALWAYS_TRUE_OPTIONS = {'LOW_LEVEL_OPTIONS'}


def _split_by_op(expr, op):
    """括号感知地按操作符分割表达式"""
    parts = []
    depth = 0
    current = ''
    i = 0
    while i < len(expr):
        if expr[i] == '(':
            depth += 1
            current += expr[i]
        elif expr[i] == ')':
            depth -= 1
            current += expr[i]
        elif depth == 0 and expr[i:i+len(op)] == op:
            parts.append(current.strip())
            current = ''
            i += len(op)
            continue
        else:
            current += expr[i]
        i += 1
    if current.strip():
        parts.append(current.strip())
    return parts


def _parse_depends(depends_str):
    """
    解析 depends on 条件表达式，返回简化的条件列表
    例如: "(MACH_STM32F4 && HAVE_STM32_CANBUS) || HAVE_STM32_FDCANBUS"
    返回: [["MACH_STM32F4", "HAVE_STM32_CANBUS"], ["HAVE_STM32_FDCANBUS"]]
    每个内部列表是 AND 关系，外部列表是 OR 关系
    """
    if not depends_str:
        return []

    # 清理字符串
    depends_str = depends_str.strip()

    # 按 || 分割为 OR 子句
    or_clauses = []
    # 简单的括号感知分割
    depth = 0
    current = ''
    for char in depends_str:
        if char == '(':
            depth += 1
            current += char
        elif char == ')':
            depth -= 1
            current += char
        elif char == '|' and depth == 0:
            if current.endswith('|'):
                # 这是 ||
                or_clauses.append(current[:-1].strip())
                current = ''
                continue
            current += char
        else:
            current += char
    if current.strip():
        or_clauses.append(current.strip())

    result = []
    for clause in or_clauses:
        # 去除外层括号
        clause = clause.strip()
        while clause.startswith('(') and clause.endswith(')'):
            clause = clause[1:-1].strip()

        # 按 && 分割为 AND 条件（括号感知）
        and_parts_raw = _split_by_op(clause, '&&')
        and_parts = [p.strip().strip('()').strip() for p in and_parts_raw]
        # 过滤掉始终为 true 的选项和空项
        and_parts = [p for p in and_parts if p and p not in ALWAYS_TRUE_OPTIONS]

        # 展开含有 || 的 AND 部分
        # 例如: A && (B || C) -> [A, B] or [A, C]
        expanded = [[]]
        for part in and_parts:
            if '||' in part:
                # 去除外层括号后按 || 分割
                inner = part.strip()
                while inner.startswith('(') and inner.endswith(')'):
                    inner = inner[1:-1].strip()
                sub_or = [s.strip() for s in inner.split('||')]
                new_expanded = []
                for existing in expanded:
                    for s in sub_or:
                        s = s.strip()
                        if s and s not in ALWAYS_TRUE_OPTIONS:
                            new_expanded.append(existing + [s])
                        elif not s or s in ALWAYS_TRUE_OPTIONS:
                            new_expanded.append(existing[:])
                expanded = new_expanded
            else:
                for existing in expanded:
                    existing.append(part)

        for combo in expanded:
            if combo:
                result.append(combo)
            elif and_parts_raw:
                # 所有条件都被过滤掉了，该子句始终为 true
                result.append([])

        if not and_parts and clause:
            result.append([])

    return result


def _check_processor_match(processor, depends_conditions):
    """
    检查处理器是否满足依赖条件
    depends_conditions: OR 列表 of AND 列表
    """
    if not depends_conditions:
        return True

    caps = PROCESSOR_CAPABILITIES.get(processor, [])

    for and_clause in depends_conditions:
        # 所有 AND 条件都必须满足
        all_met = True
        for cond in and_clause:
            if cond.startswith('!'):
                # 否定条件: !MACH_STM32F0 表示不能有此标志
                if cond[1:] in caps:
                    all_met = False
                    break
            else:
                if cond not in caps:
                    all_met = False
                    break
        if all_met:
            return True

    return False


def _parse_communication_choice(kconfig_path, arch_prefix):
    """
    解析 Kconfig 中 "Communication interface" choice 块的所有选项。

    Args:
        kconfig_path: Kconfig 文件路径
        arch_prefix: 架构前缀 (如 'STM32_' 或 'RPXXXX_')

    Returns:
        list: 通信选项列表
    """
    if not os.path.exists(kconfig_path):
        return []

    with open(kconfig_path, 'r') as f:
        lines = f.readlines()

    options = []
    in_comm_choice = False
    i = 0
    while i < len(lines):
        line = lines[i].strip()

        # 定位 Communication interface/Interface choice 块
        if line.startswith('prompt') and 'ommunication' in line and 'nterface' in line:
            in_comm_choice = True
            i += 1
            continue

        if in_comm_choice and line == 'endchoice':
            break

        if in_comm_choice and line.startswith('config '):
            config_symbol = line.split()[1]
            display = ''
            depends = ''
            visibility = ''
            select_val = ''

            # 读取此 config 块的后续行
            j = i + 1
            while j < len(lines):
                sline = lines[j].strip()
                if sline.startswith('config ') or sline == 'endchoice':
                    break

                bool_match = re.match(r'bool\s+"([^"]+)"(?:\s+if\s+(.+))?', sline)
                if bool_match:
                    display = bool_match.group(1)
                    if bool_match.group(2):
                        visibility = bool_match.group(2).strip()

                dep_match = re.match(r'depends\s+on\s+(.+)', sline)
                if dep_match:
                    if depends:
                        depends += ' && ' + dep_match.group(1).strip()
                    else:
                        depends = dep_match.group(1).strip()

                sel_match = re.match(r'select\s+(\w+)', sline)
                if sel_match:
                    select_val = sel_match.group(1)

                j += 1

            if display or select_val:
                comm_type = SELECT_TO_COMM_TYPE.get(select_val, 'unknown')
                options.append({
                    'config_symbol': config_symbol,
                    'display': display or config_symbol,
                    'depends': depends,
                    'visibility': visibility,
                    'select': select_val,
                    'comm_type': comm_type,
                })

        i += 1

    return options


def _parse_stm32_kconfig(kconfig_path):
    """解析 STM32 Kconfig 文件，提取 CAN 相关配置"""
    if not os.path.exists(kconfig_path):
        logger.warning(f"Kconfig 文件不存在: {kconfig_path}")
        return [], []

    with open(kconfig_path, 'r') as f:
        content = f.read()

    direct_can = []  # 直接 CAN 通信选项
    bridge_can = []  # USB 桥接 CAN 接口选项

    # 解析每个 config 块
    # 匹配模式: config NAME\n    bool "prompt" ...\n    depends on ...
    lines = content.split('\n')
    i = 0
    while i < len(lines):
        line = lines[i].strip()

        # 匹配 CAN 相关的 config 行
        match = re.match(r'^config\s+(STM32_(?:CANBUS|MMENU_CANBUS|CMENU_CANBUS)_\w+)', line)
        if match:
            config_name = match.group(1)
            prompt = ''
            depends = ''

            # 读取后续行获取 bool 提示和 depends
            visibility_cond = ''
            j = i + 1
            while j < len(lines) and lines[j].strip() and not lines[j].strip().startswith('config '):
                sline = lines[j].strip()

                # 提取 bool 提示 (含可选的 if 可见性条件)
                # 例如: bool "CAN bus (on PH13/PH14)" if MACH_STM32H743
                bool_match = re.match(r'bool\s+"([^"]+)"(?:\s+if\s+(.+))?', sline)
                if bool_match:
                    prompt = bool_match.group(1)
                    if bool_match.group(2):
                        visibility_cond = bool_match.group(2).strip()

                # 提取 depends on
                dep_match = re.match(r'depends\s+on\s+(.+)', sline)
                if dep_match:
                    depends = dep_match.group(1).strip()

                j += 1

            if prompt:
                # 分别存储 depends 和 visibility 条件，不做字符串合并
                # 提取引脚对
                pins_match = re.search(r'on\s+(\w+/\w+)', prompt)
                pins = pins_match.group(1) if pins_match else ''

                entry = {
                    'pins': pins,
                    'config': config_name,
                    'display': prompt,
                    'depends': depends,
                    'visibility': visibility_cond,
                }

                if 'CMENU_CANBUS' in config_name:
                    bridge_can.append(entry)
                else:
                    direct_can.append(entry)

        i += 1

    return direct_can, bridge_can


def _parse_rp2040_kconfig(kconfig_path):
    """解析 RP2040 Kconfig 文件，提取 CAN 相关配置"""
    if not os.path.exists(kconfig_path):
        logger.warning(f"Kconfig 文件不存在: {kconfig_path}")
        return None

    with open(kconfig_path, 'r') as f:
        content = f.read()

    result = {
        'type': 'gpio_integer',
        'rx_config': 'RPXXXX_CANBUS_GPIO_RX',
        'tx_config': 'RPXXXX_CANBUS_GPIO_TX',
        'rx_default': 4,
        'tx_default': 5,
        'range': [0, 29],
        'has_canbus': False,
        'has_usbcanbus': False,
    }

    # 检查是否有 CAN 选项
    if 'RPXXXX_CANBUS' in content:
        result['has_canbus'] = True
    if 'RPXXXX_USBCANBUS' in content:
        result['has_usbcanbus'] = True

    # 提取 GPIO 默认值和范围
    rx_default = re.search(r'config\s+RPXXXX_CANBUS_GPIO_RX.*?default\s+(\d+)', content, re.DOTALL)
    if rx_default:
        result['rx_default'] = int(rx_default.group(1))

    tx_default = re.search(r'config\s+RPXXXX_CANBUS_GPIO_TX.*?default\s+(\d+)', content, re.DOTALL)
    if tx_default:
        result['tx_default'] = int(tx_default.group(1))

    range_match = re.search(r'range\s+(\d+)\s+(\d+)', content)
    if range_match:
        result['range'] = [int(range_match.group(1)), int(range_match.group(2))]

    return result


def parse_can_options(klipper_path='~/klipper'):
    """
    从 Klipper Kconfig 中解析所有平台的通信接口选项

    Args:
        klipper_path: Klipper 源码目录路径

    Returns:
        dict: 包含各平台通信选项的结构化数据
    """
    klipper_path = os.path.expanduser(klipper_path)

    # 平台定义: (目录名, 架构前缀, 结果键名)
    PLATFORMS = [
        ('stm32',   'STM32_',   'stm32'),
        ('rp2040',  'RPXXXX_',  'rp2040'),
        ('atsamd',  'ATSAMD_',  'atsamd'),
        ('lpc176x', 'LPC_',     'lpc176x'),
        ('hc32f460','HC32F460_','hc32f460'),
        ('atsam',   'ATSAM_',   'atsam'),
        ('avr',     'AVR_',     'avr'),
    ]

    result = {}

    for platform_dir, arch_prefix, result_key in PLATFORMS:
        kconfig_path = os.path.join(klipper_path, 'src', platform_dir, 'Kconfig')
        if not os.path.exists(kconfig_path):
            logger.warning(f"Kconfig 文件不存在: {kconfig_path}")
            continue

        # 解析通信接口选项
        comm_options = _parse_communication_choice(kconfig_path, arch_prefix)

        # 获取该平台对应的处理器列表
        platform_processors = _get_platform_processors(result_key)

        # 为每个选项计算兼容的处理器列表
        for option in comm_options:
            depends_conditions = _parse_depends(option.get('depends', ''))
            visibility_conditions = _parse_depends(option.get('visibility', ''))
            compatible = []
            for proc in platform_processors:
                if (_check_processor_match(proc, depends_conditions) and
                        _check_processor_match(proc, visibility_conditions)):
                    compatible.append(proc)
            option['compatible_processors'] = compatible
            del option['depends']
            del option['visibility']

        platform_data = {
            'communication_options': comm_options,
        }

        # STM32 特有: 直接 CAN 和桥接 CAN 引脚选项
        if platform_dir == 'stm32':
            direct_can, bridge_can = _parse_stm32_kconfig(kconfig_path)
            stm32_procs = [p for p in PROCESSOR_CAPABILITIES.keys() if p.startswith('STM32')]
            for option in direct_can + bridge_can:
                depends_conditions = _parse_depends(option.get('depends', ''))
                visibility_conditions = _parse_depends(option.get('visibility', ''))
                compatible = []
                for proc in stm32_procs:
                    if (_check_processor_match(proc, depends_conditions) and
                            _check_processor_match(proc, visibility_conditions)):
                        compatible.append(proc)
                option['compatible_processors'] = compatible
                del option['depends']
                del option['visibility']
            platform_data['direct_can'] = direct_can
            platform_data['bridge_can'] = bridge_can
            processor_capabilities = {p: c for p, c in PROCESSOR_CAPABILITIES.items() if p.startswith('STM32')}
            platform_data['processor_capabilities'] = processor_capabilities

        # RP2040 特有: CAN GPIO 配置
        if platform_dir == 'rp2040':
            rp2040_options = _parse_rp2040_kconfig(kconfig_path)
            if rp2040_options:
                platform_data.update(rp2040_options)

        # ATSAMD 特有: 桥接 CAN 引脚选项
        if platform_dir == 'atsamd':
            _, bridge_can = _parse_generic_bridge_can(kconfig_path, 'ATSAMD')
            platform_data['bridge_can'] = bridge_can

        # ATSAM 特有: 桥接 CAN 引脚选项
        if platform_dir == 'atsam':
            _, bridge_can = _parse_generic_bridge_can(kconfig_path, 'ATSAM')
            platform_data['bridge_can'] = bridge_can

        result[result_key] = platform_data

    return result


def _get_platform_processors(result_key):
    """根据平台键名获取对应的处理器列表"""
    prefix_map = {
        'stm32':    lambda p: p.startswith('STM32') or p.startswith('N32'),
        'rp2040':   lambda p: p in ('RP2040', 'RP2350'),
        'atsamd':   lambda p: p.startswith('SAM') and p[3] in ('D', 'C', 'E') and not p.startswith('SAM3') and not p.startswith('SAM4') and not p.startswith('SAME7'),
        'lpc176x':  lambda p: p.startswith('LPC'),
        'hc32f460': lambda p: p.startswith('HC32'),
        'atsam':    lambda p: p.startswith('SAM3') or p.startswith('SAM4') or p.startswith('SAME7'),
        'avr':      lambda p: p.startswith('AT') or p.startswith('LGT'),
    }
    matcher = prefix_map.get(result_key, lambda p: False)
    return [p for p in PROCESSOR_CAPABILITIES.keys() if matcher(p)]


def _parse_generic_bridge_can(kconfig_path, prefix):
    """通用桥接 CAN 解析 (ATSAMD/ATSAM 等)"""
    if not os.path.exists(kconfig_path):
        return [], []

    with open(kconfig_path, 'r') as f:
        content = f.read()

    direct_can = []
    bridge_can = []
    lines = content.split('\n')
    i = 0
    while i < len(lines):
        line = lines[i].strip()
        match = re.match(rf'^config\s+{prefix}_(?:CANBUS|MMENU_CANBUS|CMENU_CANBUS)_\w+', line)
        if match:
            config_name = match.group(0).split()[1]
            prompt = ''
            depends = ''
            visibility_cond = ''
            j = i + 1
            while j < len(lines) and lines[j].strip() and not lines[j].strip().startswith('config '):
                sline = lines[j].strip()
                bool_match = re.match(r'bool\s+"([^"]+)"(?:\s+if\s+(.+))?', sline)
                if bool_match:
                    prompt = bool_match.group(1)
                    if bool_match.group(2):
                        visibility_cond = bool_match.group(2).strip()
                dep_match = re.match(r'depends\s+on\s+(.+)', sline)
                if dep_match:
                    depends = dep_match.group(1).strip()
                j += 1
            if prompt:
                pins_match = re.search(r'on\s+(\w+/\w+)', prompt)
                pins = pins_match.group(1) if pins_match else ''
                entry = {
                    'pins': pins, 'config': config_name,
                    'display': prompt, 'depends': depends,
                    'visibility': visibility_cond,
                }
                if 'CMENU_CANBUS' in config_name:
                    bridge_can.append(entry)
                else:
                    direct_can.append(entry)
        i += 1
    return direct_can, bridge_can


def save_cache(data, cache_path=None):
    """保存解析结果到缓存文件"""
    if cache_path is None:
        cache_path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                                  'can_options_cache.json')
    with open(cache_path, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    logger.info(f"CAN 选项缓存已保存到: {cache_path}")


def load_cache(cache_path=None):
    """从缓存文件加载解析结果"""
    if cache_path is None:
        cache_path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                                  'can_options_cache.json')
    if os.path.exists(cache_path):
        with open(cache_path, 'r', encoding='utf-8') as f:
            return json.load(f)
    return None


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser(description='从 Klipper Kconfig 解析 CAN 选项')
    parser.add_argument('--klipper-path', default='~/klipper',
                        help='Klipper 源码目录路径')
    parser.add_argument('--output', default=None,
                        help='输出 JSON 文件路径')
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO)

    data = parse_can_options(args.klipper_path)
    save_cache(data, args.output)

    # 打印摘要
    for platform_key, platform_data in data.items():
        comm_opts = platform_data.get('communication_options', [])
        print(f"\n=== {platform_key} 通信选项: {len(comm_opts)} 个 ===")
        for opt in comm_opts:
            print(f"  {opt['display']} -> {opt['config_symbol']} [{opt.get('comm_type', '?')}]")
            compat = opt.get('compatible_processors', [])
            if compat:
                print(f"    兼容: {', '.join(compat)}")
        direct_can = platform_data.get('direct_can', [])
        bridge_can = platform_data.get('bridge_can', [])
        if direct_can:
            print(f"\n  直接 CAN: {len(direct_can)} 个")
        if bridge_can:
            print(f"  桥接 CAN: {len(bridge_can)} 个")
