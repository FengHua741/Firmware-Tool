#!/usr/bin/env python3
"""
Klipper Kconfig 解析器
自动读取 Klipper 源码中的 Kconfig 文件，提取 MCU 配置信息
"""

import os
import re
import json
from pathlib import Path

class KlipperKconfigParser:
    def __init__(self, klipper_path='~/klipper'):
        self.klipper_path = os.path.expanduser(klipper_path)
        self.src_path = os.path.join(self.klipper_path, 'src')
        self.mcu_database = {}
        
    def parse_all_platforms(self):
        """解析所有平台的 Kconfig"""
        platforms = {
            'stm32': 'STM32',
            'rp2040': 'RP2040',
            'atsamd': 'ATSAMD',
            'lpc176x': 'LPC176x',
            'hc32f460': 'HC32F460',
            'atsam': 'ATSAM',
            'avr': 'AVR'
        }
        
        for platform_dir, platform_name in platforms.items():
            kconfig_path = os.path.join(self.src_path, platform_dir, 'Kconfig')
            if os.path.exists(kconfig_path):
                self.mcu_database[platform_name] = self._parse_kconfig(kconfig_path, platform_dir)
        
        return self.mcu_database
    
    def _parse_kconfig(self, kconfig_path, platform_dir):
        """解析单个 Kconfig 文件"""
        with open(kconfig_path, 'r') as f:
            content = f.read()
        
        result = {
            'platform': platform_dir,
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
    
    def _parse_mcus(self, content):
        """解析 MCU 型号列表"""
        mcus = {}
        
        # 匹配 config MACH_XXX 和 bool "名称"
        pattern = r'config (MACH_\w+)\s+bool "([^"]+)"(?:\s+select\s+(\w+))?(?:\s+select\s+(\w+))?'
        
        for match in re.finditer(pattern, content):
            config_name = match.group(1)
            display_name = match.group(2)
            select1 = match.group(3)
            select2 = match.group(4)
            
            # 提取 MCU ID（小写）
            mcu_id = config_name.replace('MACH_', '').lower()
            
            mcus[mcu_id] = {
                'id': mcu_id,
                'name': display_name,
                'config_name': config_name,
                'selects': [s for s in [select1, select2] if s],
                'crystals': [],
                'bl_offsets': [],
                'connections': []
            }
        
        return mcus
    
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
    
    def _parse_bootloader_options(self, content, mcus):
        """解析 Bootloader 偏移选项 - 支持多种平台"""
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
        # 简单的条件匹配
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
    
    def get_mcu_info(self, mcu_id):
        """获取特定 MCU 的详细信息"""
        mcu_id = mcu_id.lower()
        
        for platform, data in self.mcu_database.items():
            if mcu_id in data['mcus']:
                mcu = data['mcus'][mcu_id]
                return {
                    'platform': platform,
                    'mcu': mcu,
                    'flash_modes': data['flash_modes'],
                    'connections': data['connections']
                }
        
        return None
    
    def save_database(self, output_path='mcu_database.json'):
        """保存数据库到 JSON 文件"""
        with open(output_path, 'w') as f:
            json.dump(self.mcu_database, f, indent=2)
    
    def load_database(self, input_path='mcu_database.json'):
        """从 JSON 文件加载数据库"""
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
