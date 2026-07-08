#!/usr/bin/env python3
"""
Klipper Kconfig 解析器
自动读取 Klipper 源码中的 Kconfig 文件，提取 MCU 配置信息
"""

import os
import re
import json

class KlipperKconfigParser:
    PLATFORM_DEFINITIONS = {
        'stm32': {'name': 'STM32', 'arch_symbol': 'MACH_STM32'},
        'rp2040': {'name': 'RP2040', 'arch_symbol': 'MACH_RPXXXX'},
        'atsamd': {'name': 'ATSAMD', 'arch_symbol': 'MACH_ATSAMD'},
        'lpc176x': {'name': 'LPC176x', 'arch_symbol': 'MACH_LPC176X'},
        'hc32f460': {'name': 'HC32F460', 'arch_symbol': 'MACH_HC32F460'},
        'atsam': {'name': 'ATSAM', 'arch_symbol': 'MACH_ATSAM'},
        'avr': {'name': 'AVR', 'arch_symbol': 'MACH_AVR'},
    }

    def __init__(self, klipper_path='~/klipper'):
        # 处理 ~ 路径，避免 systemd root 下扩展到 /root
        if klipper_path.startswith('~'):
            home = os.path.expanduser('~')
            if home == '/root':
                # 尝试查找实际用户的 klipper 目录
                for user_dir in os.listdir('/home'):
                    candidate = os.path.join('/home', user_dir, 'klipper')
                    if os.path.exists(candidate):
                        klipper_path = candidate
                        break
            else:
                klipper_path = os.path.expanduser(klipper_path)
        self.klipper_path = klipper_path
        self.src_path = os.path.join(self.klipper_path, 'src')
        self.mcu_database = {}
        
    def parse_all_platforms(self):
        """解析所有平台的 Kconfig"""
        for platform_dir, platform_info in self.PLATFORM_DEFINITIONS.items():
            kconfig_path = os.path.join(self.src_path, platform_dir, 'Kconfig')
            if os.path.exists(kconfig_path):
                self.mcu_database[platform_info['name']] = self._parse_kconfig(
                    kconfig_path, platform_dir, platform_info
                )
        
        return self.mcu_database
    
    def _parse_kconfig(self, kconfig_path, platform_dir, platform_info=None):
        """解析单个 Kconfig 文件"""
        try:
            with open(kconfig_path, 'r') as f:
                content = f.read()
        except (IOError, OSError) as e:
            print(f"警告: 无法读取 Kconfig 文件 {kconfig_path}: {e}")
            return {
                'platform': platform_dir,
                'mcus': {},
                'flash_modes': [],
                'default_connections': []
            }
        
        result = {
            'platform': platform_dir,
            'platform_name': (platform_info or {}).get('name', platform_dir),
            'arch_config': (platform_info or {}).get('arch_symbol', ''),
            'mcus': {},
            'flash_modes': [],
            'default_connections': []
        }
        
        # 解析 MCU 型号
        result['mcus'] = self._parse_mcus(content)
        
        # 解析晶振选项
        self._parse_clock_options(content, result['mcus'])
        
        # 解析 Bootloader 偏移
        self._parse_bootloader_options(content, result['mcus'])
        
        # 解析连接方式
        result['connections'] = self._parse_connections(content)
        
        # 解析烧录模式
        result['flash_modes'] = self._infer_flash_modes(platform_dir)
        
        return result
    
    def _iter_config_blocks(self, content):
        """遍历 Kconfig 中的 config 块。"""
        lines = content.splitlines()
        i = 0
        while i < len(lines):
            stripped = lines[i].strip()
            match = re.match(r'^config\s+(\w+)', stripped)
            if not match:
                i += 1
                continue

            symbol = match.group(1)
            block = [lines[i]]
            i += 1
            while i < len(lines):
                next_stripped = lines[i].strip()
                if re.match(r'^config\s+\w+', next_stripped):
                    break
                if next_stripped in ('choice', 'endchoice', 'menu', 'endmenu', 'endif'):
                    break
                block.append(lines[i])
                i += 1
            yield symbol, block

    def _select_closure(self, symbol, select_graph):
        """计算 config symbol 通过 select 带出的符号闭包。"""
        seen = set()
        stack = [symbol]
        while stack:
            current = stack.pop()
            for selected in select_graph.get(current, []):
                if selected in seen:
                    continue
                seen.add(selected)
                stack.append(selected)
        return seen

    def _parse_mcus(self, content):
        """解析 MCU 型号列表"""
        mcus = {}
        select_graph = {}

        for config_name, block in self._iter_config_blocks(content):
            block_text = '\n'.join(block)
            selects = re.findall(r'^\s*select\s+(\w+)', block_text, re.MULTILINE)
            select_graph[config_name] = selects

            bool_match = re.search(r'^\s*bool\s+"([^"]+)"', block_text, re.MULTILINE)
            if not config_name.startswith('MACH_') or not bool_match:
                continue

            display_name = bool_match.group(1)
            # 提取 MCU ID（小写）
            mcu_id = config_name.replace('MACH_', '').lower()

            mcus[mcu_id] = {
                'id': mcu_id,
                'name': display_name,
                'config_name': config_name,
                'config_symbol': config_name,
                'selects': [],
                'capabilities': [],
                'crystals': [],
                'crystal_options': [],
                'bl_offsets': [],
                'bl_offset_options': [],
                'connections': []
            }

        for mcu in mcus.values():
            capabilities = self._select_closure(mcu['config_name'], select_graph)
            mcu['selects'] = sorted(capabilities)
            mcu['capabilities'] = sorted(set(capabilities) | {mcu['config_name']})
        
        return mcus

    def _strip_outer_parens(self, expr):
        expr = expr.strip()
        while expr.startswith('(') and expr.endswith(')'):
            depth = 0
            wraps = True
            for idx, char in enumerate(expr):
                if char == '(':
                    depth += 1
                elif char == ')':
                    depth -= 1
                    if depth == 0 and idx != len(expr) - 1:
                        wraps = False
                        break
            if not wraps:
                break
            expr = expr[1:-1].strip()
        return expr

    def _split_expr(self, expr, op):
        parts = []
        depth = 0
        current = []
        i = 0
        while i < len(expr):
            char = expr[i]
            if char == '(':
                depth += 1
                current.append(char)
            elif char == ')':
                depth -= 1
                current.append(char)
            elif depth == 0 and expr.startswith(op, i):
                parts.append(''.join(current).strip())
                current = []
                i += len(op)
                continue
            else:
                current.append(char)
            i += 1
        if current:
            parts.append(''.join(current).strip())
        return parts

    def _eval_condition(self, expr, symbols):
        """求值 Kconfig 条件表达式中的常见布尔语法。"""
        expr = self._strip_outer_parens((expr or '').strip())
        if not expr:
            return True

        or_parts = self._split_expr(expr, '||')
        if len(or_parts) > 1:
            return any(self._eval_condition(part, symbols) for part in or_parts)

        and_parts = self._split_expr(expr, '&&')
        if len(and_parts) > 1:
            return all(self._eval_condition(part, symbols) for part in and_parts)

        if expr.startswith('!'):
            return not self._eval_condition(expr[1:].strip(), symbols)

        if expr in ('y', 'Y', 'LOW_LEVEL_OPTIONS'):
            return True
        if expr in ('n', 'N'):
            return False

        token_match = re.match(r'^([A-Za-z_]\w*)$', expr)
        if token_match:
            return token_match.group(1) in symbols

        # 不支持的比较表达式保守视为不匹配，避免展示/写入错误选项。
        return False
    
    def _parse_clock_options(self, content, mcus):
        """解析晶振选项 - 支持多种格式"""
        crystals = []
        
        # 格式1: CLOCK_REF_8M (STM32)
        clock_pattern1 = r'config \w+_CLOCK_REF_(\d+)M\s+bool "(\d+) MHz crystal"'
        for match in re.finditer(clock_pattern1, content):
            freq_hz = int(match.group(1)) * 1000000
            crystals.append(str(freq_hz))
        
        # 格式2: CLOCK_REF_X8M (HC32F460)
        clock_pattern2 = r'config \w+_CLOCK_REF_X(\d+)M\s+bool "[^"]*(\d+)\s*MHz[^"]*"'
        for match in re.finditer(clock_pattern2, content):
            freq_hz = int(match.group(1)) * 1000000
            if str(freq_hz) not in crystals:
                crystals.append(str(freq_hz))
        
        # 格式3: ATSAMD 的特殊格式
        # CLOCK_REF_X32K -> 32768 Hz
        if 'CLOCK_REF_X32K' in content:
            crystals.append('32768')
        # CLOCK_REF_X12M -> 12000000 Hz
        if 'CLOCK_REF_X12M' in content:
            crystals.append('12000000')
        # CLOCK_REF_X25M -> 25000000 Hz
        if 'CLOCK_REF_X25M' in content:
            crystals.append('25000000')
        
        # 格式4: 从 CLOCK_REF_8 等提取
        clock_pattern4 = r'config CLOCK_REF_(\d+)(?:\s|$)'
        for match in re.finditer(clock_pattern4, content):
            freq_mhz = match.group(1)
            if freq_mhz in ['8', '12', '16', '20', '24', '25']:
                freq_hz = int(freq_mhz) * 1000000
                if str(freq_hz) not in crystals:
                    crystals.append(str(freq_hz))
        
        clock_options = self._parse_choice_options(content, 'Clock Reference')
        if clock_options:
            for mcu in mcus.values():
                options = []
                for option in clock_options:
                    if not self._check_condition(option['condition'], mcu):
                        continue
                    freq = self._frequency_from_prompt(option['display'])
                    if not freq:
                        continue
                    options.append({
                        'value': freq,
                        'display': option['display'],
                        'config_symbol': option['config_symbol'],
                    })
                mcu['crystal_options'] = options
                mcu['crystals'] = [opt['value'] for opt in options]
            return

        # 如果没有找到晶振选项，根据 MCU 类型添加默认值
        if not crystals:
            # 为每个 MCU 单独设置晶振
            for mcu_id, mcu in mcus.items():
                if mcu_id == 'rp2040' or mcu_id == 'rp2350':
                    mcu['crystals'] = ['12000000']  # 12MHz (RP系列都是12MHz)
                else:
                    mcu['crystals'] = ['8000000', '12000000', '16000000', '20000000', '24000000', '25000000']
        else:
            # 应用到所有 MCU（平台通用）
            for mcu in mcus.values():
                mcu['crystals'] = sorted(crystals.copy(), key=lambda x: int(x))

    def _parse_choice_options(self, content, prompt_text):
        """解析指定 prompt 的 choice 选项。"""
        lines = content.splitlines()
        choices = []
        i = 0
        while i < len(lines):
            if lines[i].strip() != 'choice':
                i += 1
                continue

            block = []
            i += 1
            while i < len(lines) and lines[i].strip() != 'endchoice':
                block.append(lines[i])
                i += 1

            block_text = '\n'.join(block)
            if prompt_text not in block_text:
                i += 1
                continue

            j = 0
            while j < len(block):
                line = block[j].strip()
                match = re.match(r'^config\s+(\w+)', line)
                if not match:
                    j += 1
                    continue

                symbol = match.group(1)
                display = ''
                conditions = []
                j += 1
                while j < len(block):
                    sline = block[j].strip()
                    if re.match(r'^config\s+\w+', sline):
                        break
                    bool_match = re.match(r'bool\s+"([^"]+)"(?:\s+if\s+(.+))?', sline)
                    if bool_match:
                        display = bool_match.group(1)
                        if bool_match.group(2):
                            conditions.append(bool_match.group(2).strip())
                    dep_match = re.match(r'depends\s+on\s+(.+)', sline)
                    if dep_match:
                        conditions.append(dep_match.group(1).strip())
                    j += 1

                if display:
                    choices.append({
                        'config_symbol': symbol,
                        'display': display,
                        'condition': ' && '.join(conditions),
                    })
            i += 1

        return choices

    def _frequency_from_prompt(self, prompt):
        """从 Kconfig prompt 中提取频率 Hz。"""
        if 'Internal clock' in prompt:
            return 'internal'
        match = re.search(r'([\d.]+)\s*([kKmM])\s*[hH]z', prompt)
        if not match:
            return None
        value = float(match.group(1))
        unit = match.group(2).lower()
        multiplier = 1000 if unit == 'k' else 1000000
        freq = int(value * multiplier)
        return str(freq)
    
    def _parse_bootloader_options(self, content, mcus):
        """解析 Bootloader 偏移选项 - 支持多种平台"""
        choice_options = self._parse_choice_options(content, 'Bootloader offset')
        if choice_options:
            for mcu in mcus.values():
                offsets = []
                option_rows = []
                for option in choice_options:
                    if not self._check_condition(option['condition'], mcu):
                        continue
                    suffix_match = re.search(r'_FLASH_START_([0-9A-Fa-f]+)$', option['config_symbol'])
                    if not suffix_match:
                        continue
                    offset = str(int(suffix_match.group(1), 16))
                    option_rows.append({
                        'offset': offset,
                        'display': option['display'],
                        'config_symbol': option['config_symbol'],
                    })
                    offsets.append(offset)
                mcu['bl_offset_options'] = option_rows
                mcu['bl_offsets'] = offsets
            return

        bl_options = []
        
        # 匹配带条件的 Bootloader offset 选项
        bl_pattern_with_if = r'config (\w+)_FLASH_START_(\w+)\s+bool "([^"]+)"(?:\s+depends on\s+([^\n]+))?\s*(?:if\s+([^\n]+))?'
        
        for match in re.finditer(bl_pattern_with_if, content):
            platform_prefix = match.group(1)
            offset_hex = match.group(2)
            description = match.group(3)
            depends_cond = match.group(4) or ''
            if_cond = match.group(5) or ''
            
            # 合并条件
            condition = if_cond if if_cond else depends_cond
            
            # 转换十六进制到十进制
            try:
                offset_dec = int(offset_hex, 16)
                bl_options.append({
                    'offset': str(offset_dec),
                    'hex': f'0x{offset_hex}',
                    'description': description,
                    'condition': condition,
                    'platform': platform_prefix
                })
            except ValueError:
                continue
        
        # 如果没有找到带条件的选项，尝试查找无条件的选项
        if not bl_options:
            bl_pattern_simple = r'config (\w+)_FLASH_START_(\w+)\s+bool "([^"]+)"'
            for match in re.finditer(bl_pattern_simple, content):
                platform_prefix = match.group(1)
                offset_hex = match.group(2)
                description = match.group(3)
                
                try:
                    offset_dec = int(offset_hex, 16)
                    bl_options.append({
                        'offset': str(offset_dec),
                        'hex': f'0x{offset_hex}',
                        'description': description,
                        'condition': '',
                        'platform': platform_prefix
                    })
                except ValueError:
                    continue
        
        # 根据 MCU 类型分配 BL 选项
        for mcu_id, mcu in mcus.items():
            mcu['bl_offsets'] = []
            for bl in bl_options:
                # 检查条件是否匹配
                should_add = False
                if bl['condition']:
                    if self._check_condition(bl['condition'], mcu):
                        should_add = True
                else:
                    # 无条件限制，添加到所有 MCU
                    should_add = True
                
                # RP2040 特殊处理：0100 (256 bytes) 是 stage2，不是真正的 bootloader
                if should_add:
                    # 过滤掉异常的 131584 (0x20200, 128.5KiB)，这不是标准的 bootloader 偏移
                    if bl['offset'] == '131584':
                        continue
                    if mcu_id == 'rp2040' and bl['offset'] == '256':
                        # RP2040 的 256 bytes 是 stage2，标记为特殊的 "256"
                        mcu['bl_offsets'].append('256')
                    elif mcu_id == 'rp2350' and bl['offset'] == '0':
                        # RP2350 的 0 是真正的无 bootloader
                        mcu['bl_offsets'].append('0')
                    else:
                        mcu['bl_offsets'].append(bl['offset'])
            
            # RP2040 特殊处理：确保只有 256 和 16384 两个选项
            if mcu_id == 'rp2040':
                # RP2040 只有 256 bytes (stage2) 和 16KB bootloader
                mcu['bl_offsets'] = ['256', '16384']
            elif mcu_id == 'rp2350':
                # RP2350 有 0 (no bootloader) 和 16KB bootloader
                mcu['bl_offsets'] = ['0', '16384']
    
    def _check_condition(self, condition, mcu):
        """检查条件是否匹配 MCU"""
        if not condition:
            return True
        symbols = set(mcu.get('capabilities') or [])
        if self._eval_condition(condition, symbols):
            return True

        # 保留旧的简单条件匹配作为兜底。
        config_name = mcu['config_name']
        base_name = config_name.replace('MACH_', '')
        mcu_id = mcu.get('id', '').lower()
        
        # 处理条件中的 || 和 &&
        conditions = [c.strip() for c in condition.split('||')]
        
        for cond in conditions:
            # 移除括号
            cond = cond.strip('()')
            # 检查是否匹配
            if cond in config_name or cond in mcu.get('selects', []):
                return True
            # 检查系列匹配（如 MACH_STM32F1 匹配 STM32F103）
            if 'MACH_STM32F1' in cond and base_name.startswith('stm32f1'):
                return True
            if 'MACH_STM32F4' in cond and base_name.startswith('stm32f4'):
                return True
            if 'MACH_STM32F0' in cond and base_name.startswith('stm32f0'):
                return True
            if 'MACH_STM32G0' in cond and base_name.startswith('stm32g0'):
                return True
            if 'MACH_STM32G4' in cond and base_name.startswith('stm32g4'):
                return True
            if 'MACH_STM32H7' in cond and base_name.startswith('stm32h7'):
                return True
            if 'MACH_STM32F7' in cond and base_name.startswith('stm32f7'):
                return True
            if 'MACH_STM32F2' in cond and base_name.startswith('stm32f2'):
                return True
            # 特殊系列匹配
            # MACH_STM32F4x5 匹配 F405, F407, F429 等
            if 'MACH_STM32F4x5' in cond:
                if base_name.startswith('stm32f405') or base_name.startswith('stm32f407') or \
                   base_name.startswith('stm32f415') or base_name.startswith('stm32f417') or \
                   base_name.startswith('stm32f427') or base_name.startswith('stm32f429') or \
                   base_name.startswith('stm32f437') or base_name.startswith('stm32f439') or \
                   mcu_id in ['stm32f405', 'stm32f407', 'stm32f415', 'stm32f417', 
                             'stm32f427', 'stm32f429', 'stm32f437', 'stm32f439']:
                    return True
            # MACH_STM32F0x2 匹配 F042, F072 等
            if 'MACH_STM32F0x2' in cond:
                if base_name.startswith('stm32f042') or base_name.startswith('stm32f072') or \
                   mcu_id in ['stm32f042', 'stm32f072']:
                    return True
        
        return False

    def get_mcu_info(self, mcu_id):
        """获取特定 MCU 的详细信息"""
        mcu_id = mcu_id.lower()

        if not self.mcu_database:
            self.parse_all_platforms()

        for platform, data in self.mcu_database.items():
            if mcu_id in data['mcus']:
                mcu = data['mcus'][mcu_id]
                return {
                    'platform': platform,
                    'platform_key': data.get('platform'),
                    'arch_config': data.get('arch_config', ''),
                    'mcu': mcu,
                    'flash_modes': data['flash_modes'],
                    'connections': data['connections']
                }

        return None

    def resolve_mcu_info(self, mcu_id, platform=None):
        """按 MCU 与可选平台名解析编译需要的 MCU 信息。"""
        mcu_id = (mcu_id or '').lower()
        platform_norm = (platform or '').lower()

        if not self.mcu_database:
            self.parse_all_platforms()

        for platform_name, data in self.mcu_database.items():
            platform_candidates = {
                platform_name.lower(),
                data.get('platform', '').lower(),
                data.get('platform_name', '').lower(),
            }
            if platform_norm and platform_norm not in platform_candidates:
                continue
            if mcu_id in data['mcus']:
                return {
                    'platform': platform_name,
                    'platform_key': data.get('platform'),
                    'arch_config': data.get('arch_config', ''),
                    'mcu': data['mcus'][mcu_id],
                    'flash_modes': data.get('flash_modes', []),
                    'connections': data.get('connections', []),
                }

        if platform_norm:
            return self.resolve_mcu_info(mcu_id)
        return None
    
    def _parse_connections(self, content):
        """解析连接方式"""
        connections = []
        
        # USB 连接
        if 'USBSERIAL' in content or 'USB' in content:
            connections.append({'type': 'USB', 'name': 'USB'})
        
        # CAN 连接
        if 'CANBUS' in content or 'CAN' in content:
            connections.append({'type': 'CAN', 'name': 'CAN Bus'})
        
        # Serial 连接
        serial_pattern = r'bool "Serial \(([^)]+)\)"'
        for match in re.finditer(serial_pattern, content):
            serial_name = match.group(1)
            connections.append({'type': 'SERIAL', 'name': f'Serial ({serial_name})'})
        
        return connections
    
    def _infer_flash_modes(self, platform_dir):
        """根据平台推断烧录模式"""
        flash_modes_map = {
            'stm32': ['DFU', 'KAT', 'CAN', 'CAN_BRIDGE_DFU', 'CAN_BRIDGE_KAT'],
            'rp2040': ['UF2', 'KAT', 'CAN'],
            'atsamd': ['UF2', 'KAT'],
            'lpc176x': ['DFU', 'KAT'],
            'hc32f460': ['DFU', 'KAT'],
            'atsam': ['DFU', 'KAT'],
            'avr': ['DFU']
        }
        return flash_modes_map.get(platform_dir, ['DFU'])
    
    def save_database(self, output_path=None):
        """保存数据库到 JSON 文件"""
        if output_path is None:
            output_path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'data', 'mcu_database.json')
        with open(output_path, 'w') as f:
            json.dump(self.mcu_database, f, indent=2)
    
    def load_database(self, input_path=None):
        """从 JSON 文件加载数据库"""
        if input_path is None:
            input_path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'data', 'mcu_database.json')
        with open(input_path, 'r') as f:
            self.mcu_database = json.load(f)
        return self.mcu_database


# 测试
if __name__ == '__main__':
    parser = KlipperKconfigParser()
    database = parser.parse_all_platforms()
    
    # 打印统计信息
    print("=== Klipper MCU 数据库 ===")
    for platform, data in database.items():
        print(f"\n{platform}: {len(data['mcus'])} 个 MCU")
        for mcu_id, mcu in data['mcus'].items():
            print(f"  - {mcu_id}: {mcu['name']}")
            print(f"    晶振: {mcu['crystals']}")
            print(f"    BL偏移: {mcu['bl_offsets'][:3]}...")  # 只显示前3个
    
    # 保存数据库
    parser.save_database()
    print("\n✓ 数据库已保存到 mcu_database.json")
