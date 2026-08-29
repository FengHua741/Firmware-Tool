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

from klipper_kconfig_parser import KlipperKconfigParser

logger = logging.getLogger(__name__)

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


def _dynamic_processor_capabilities(klipper_path):
    """从当前 Klipper Kconfig 生成平台 -> MCU -> 能力符号映射。"""
    parser = KlipperKconfigParser(klipper_path)
    database = parser.parse_all_platforms()
    capabilities = {}
    for platform_data in database.values():
        platform_key = platform_data.get('platform', '')
        if not platform_key:
            continue
        platform_capabilities = capabilities.setdefault(platform_key, {})
        for mcu_id, mcu in (platform_data.get('mcus') or {}).items():
            processor = str(mcu_id or '').upper()
            if not processor:
                continue
            symbols = set(mcu.get('capabilities') or [])
            symbols.add(mcu.get('config_symbol') or mcu.get('config_name', ''))
            symbols.discard('')
            platform_capabilities[processor] = symbols
    return parser, capabilities


def _annotate_compatibility(options, processor_capabilities, parser):
    """给 Kconfig 选项标注由实时能力闭包计算出的兼容 MCU。"""
    resolved = bool(processor_capabilities)
    for option in options:
        depends = option.pop('depends', '')
        visibility = option.pop('visibility', '')
        compatible = []
        if resolved:
            for processor, symbols in processor_capabilities.items():
                if (parser._eval_condition(depends, symbols)
                        and parser._eval_condition(visibility, symbols)):
                    compatible.append(processor)
        option['compatible_processors'] = sorted(compatible)
        option['compatibility_resolved'] = resolved
    return options


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

    with open(kconfig_path, 'r', encoding='utf-8', errors='replace') as f:
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

    with open(kconfig_path, 'r', encoding='utf-8', errors='replace') as f:
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


def _join_conditions(*conditions):
    parts = [str(condition).strip() for condition in conditions if str(condition).strip()]
    return ' && '.join(f'({part})' for part in parts)


def _condition_symbols(condition):
    return set(re.findall(r'\b[A-Za-z_][A-Za-z0-9_]*\b', condition or '')) - {
        'if', 'y', 'n', 'Y', 'N', 'LOW_LEVEL_OPTIONS',
    }


def _parse_kconfig_choice_blocks(kconfig_path):
    """解析 Kconfig choice，保留作用域条件和每个选项的条件。"""
    if not os.path.exists(kconfig_path):
        return []
    with open(kconfig_path, 'r', encoding='utf-8', errors='replace') as source:
        lines = source.readlines()

    choices = []
    outer_if_stack = []
    index = 0
    choice_number = 0
    while index < len(lines):
        stripped = lines[index].strip()
        if_match = re.match(r'^if\s+(.+)$', stripped)
        if if_match:
            outer_if_stack.append(if_match.group(1).strip())
            index += 1
            continue
        if stripped == 'endif':
            if outer_if_stack:
                outer_if_stack.pop()
            index += 1
            continue
        if not re.match(r'^choice\b', stripped):
            index += 1
            continue

        choice_number += 1
        choice_id = f'choice_{choice_number}'
        choice_prompt = ''
        choice_conditions = list(outer_if_stack)
        local_if_stack = []
        options = []
        current = None

        def flush_current():
            nonlocal current
            if current and current.get('display'):
                current['condition'] = _join_conditions(
                    *choice_conditions,
                    *current.pop('scope_conditions', []),
                    *current.pop('conditions', []),
                )
                options.append(current)
            current = None

        index += 1
        while index < len(lines):
            line = lines[index].strip()
            if line == 'endchoice':
                flush_current()
                break

            nested_if = re.match(r'^if\s+(.+)$', line)
            if nested_if:
                flush_current()
                local_if_stack.append(nested_if.group(1).strip())
                index += 1
                continue
            if line == 'endif':
                flush_current()
                if local_if_stack:
                    local_if_stack.pop()
                index += 1
                continue

            config_match = re.match(r'^config\s+(\w+)', line)
            if config_match:
                flush_current()
                current = {
                    'config_symbol': config_match.group(1),
                    'display': '',
                    'select': '',
                    'scope_conditions': list(local_if_stack),
                    'conditions': [],
                }
                index += 1
                continue

            prompt_match = re.match(r'^prompt\s+"([^"]+)"(?:\s+if\s+(.+))?$', line)
            if prompt_match and current is None:
                choice_prompt = prompt_match.group(1)
                if prompt_match.group(2):
                    choice_conditions.append(prompt_match.group(2).strip())
                index += 1
                continue

            depends_match = re.match(r'^depends\s+on\s+(.+)$', line)
            if depends_match:
                target = current['conditions'] if current is not None else choice_conditions
                target.append(depends_match.group(1).strip())
                index += 1
                continue

            if current is not None:
                bool_match = re.match(r'^bool\s+"([^"]+)"(?:\s+if\s+(.+))?$', line)
                if bool_match:
                    current['display'] = bool_match.group(1)
                    if bool_match.group(2):
                        current['conditions'].append(bool_match.group(2).strip())
                select_match = re.match(r'^select\s+(\w+)(?:\s+if\s+(.+))?$', line)
                if select_match:
                    current['select'] = select_match.group(1)
                    if select_match.group(2):
                        current['conditions'].append(select_match.group(2).strip())
            index += 1

        if options:
            choices.append({
                'id': choice_id,
                'prompt': choice_prompt or choice_id,
                'condition': _join_conditions(*choice_conditions),
                'options': options,
                '_order': choice_number,
            })
        index += 1
    return choices


def _parse_communication_subchoices(kconfig_path, communication_options, bridge_options):
    """找出由通信主选项或其子选项控制的任意嵌套 choice。"""
    communication_symbols = {
        option.get('config_symbol', '') for option in communication_options
    }
    communication_symbols.update(
        option.get('select', '') for option in communication_options
    )
    bridge_symbols = {option.get('config', '') for option in bridge_options}
    roots = (communication_symbols | bridge_symbols) - {''}

    candidates = []
    for choice in _parse_kconfig_choice_blocks(kconfig_path):
        option_symbols = {
            option.get('config_symbol', '') for option in choice.get('options', [])
        }
        # 主通信 choice 与现有 CAN 引脚 choice 已有专门 UI，不重复输出。
        if option_symbols & communication_symbols:
            continue
        if option_symbols and all('CMENU_CANBUS' in symbol for symbol in option_symbols):
            continue
        candidates.append(choice)

    included = []
    reachable = set(roots)
    pending = list(candidates)
    while pending:
        progressed = False
        remaining = []
        for choice in pending:
            references = _condition_symbols(choice.get('condition', ''))
            for option in choice.get('options', []):
                references.update(_condition_symbols(option.get('condition', '')))
            if not (references & reachable):
                remaining.append(choice)
                continue
            included.append(choice)
            reachable.update(
                option.get('config_symbol', '')
                for option in choice.get('options', [])
            )
            reachable.discard('')
            progressed = True
        if not progressed:
            break
        pending = remaining

    for choice in included:
        choice.pop('_order', None)
    return included


def _parse_rp2040_kconfig(kconfig_path):
    """解析 RP2040 Kconfig 文件，提取 CAN 相关配置"""
    if not os.path.exists(kconfig_path):
        logger.warning(f"Kconfig 文件不存在: {kconfig_path}")
        return None

    with open(kconfig_path, 'r', encoding='utf-8', errors='replace') as f:
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
    capability_parser, capabilities_by_platform = _dynamic_processor_capabilities(
        klipper_path
    )

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

        processor_capabilities = capabilities_by_platform.get(result_key, {})
        _annotate_compatibility(
            comm_options, processor_capabilities, capability_parser
        )

        platform_data = {
            'communication_options': comm_options,
            'processor_capabilities': {
                processor: sorted(symbols)
                for processor, symbols in processor_capabilities.items()
            },
            'capability_source': 'klipper-kconfig',
        }

        # STM32 特有: 直接 CAN 和桥接 CAN 引脚选项
        if platform_dir == 'stm32':
            direct_can, bridge_can = _parse_stm32_kconfig(kconfig_path)
            _annotate_compatibility(
                direct_can + bridge_can,
                processor_capabilities,
                capability_parser,
            )
            platform_data['direct_can'] = direct_can
            platform_data['bridge_can'] = bridge_can

        # RP2040 特有: CAN GPIO 配置
        if platform_dir == 'rp2040':
            rp2040_options = _parse_rp2040_kconfig(kconfig_path)
            if rp2040_options:
                platform_data.update(rp2040_options)

        # ATSAMD 特有: 桥接 CAN 引脚选项
        if platform_dir == 'atsamd':
            _, bridge_can = _parse_generic_bridge_can(kconfig_path, 'ATSAMD')
            _annotate_compatibility(
                bridge_can, processor_capabilities, capability_parser
            )
            platform_data['bridge_can'] = bridge_can

        # ATSAM 特有: 桥接 CAN 引脚选项
        if platform_dir == 'atsam':
            _, bridge_can = _parse_generic_bridge_can(kconfig_path, 'ATSAM')
            _annotate_compatibility(
                bridge_can, processor_capabilities, capability_parser
            )
            platform_data['bridge_can'] = bridge_can

        platform_data['communication_subchoices'] = _parse_communication_subchoices(
            kconfig_path,
            comm_options,
            platform_data.get('bridge_can', []),
        )

        result[result_key] = platform_data

    return result


def _parse_generic_bridge_can(kconfig_path, prefix):
    """通用桥接 CAN 解析 (ATSAMD/ATSAM 等)"""
    if not os.path.exists(kconfig_path):
        return [], []

    with open(kconfig_path, 'r', encoding='utf-8', errors='replace') as f:
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
        cache_path = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                  'can_options_cache.json')
    with open(cache_path, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    logger.info(f"CAN 选项缓存已保存到: {cache_path}")


def load_cache(cache_path=None):
    """从缓存文件加载解析结果"""
    if cache_path is None:
        cache_path = os.path.join(os.path.dirname(os.path.abspath(__file__)),
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
