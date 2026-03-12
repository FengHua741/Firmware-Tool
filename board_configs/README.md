# FLY 主板配置仓库

这是 FLY 3D打印机主板配置文件仓库，包含所有 FLY 系列主板和工具板的配置信息。

## 仓库结构

```
board_configs/
├── FLY/
│   ├── mainboard/      # 主板配置
│   │   ├── fly-c5.json
│   │   ├── fly-c8.json
│   │   ├── fly-d5.json
│   │   └── ...
│   ├── toolboard/      # 工具板配置
│   │   ├── sb2040.json
│   │   ├── sht36.json
│   │   ├── ercf.json
│   │   └── ...
│   └── BL/             # Bootloader 固件
└── README.md
```

## JSON 配置字段说明

| 字段名 | 说明 | 示例 |
|--------|------|------|
| `产品类型` | 产品分类：mainboard/toolboard/extensionboard | `mainboard` |
| `名称` | 产品显示名称 | `FLY-SB2040` |
| `处理器` | 主控芯片型号 | `STM32F407` / `Raspberry Pi RP2040` |
| `晶振` | 晶振频率 | `8 MHz crystal` |
| `BL偏移` | Bootloader 偏移地址 | `32KiB bootloader` |
| `通讯方式` | 支持的通信接口列表 | `["USB", "USB转CAN"]` |
| `默认通讯` | 默认通信接口 | `USB` |
| `烧录方法` | 支持的烧录方式 | `["DFU", "UF2"]` |
| `默认烧录` | 默认烧录方式 | `DFU` |
| `启动引脚` | 启动时需要设置的 GPIO | `gpio5` / `!PC13` |
| `BL烧录` | 是否支持 BL 烧录 | `支持` |
| `BL默认方式` | BL 烧录默认方式 | `DFU` |
| `id` | 配置文件唯一标识 | `fly-f407zg` |

## 通讯方式选项

- `USB` - USB 通信
- `USB转CAN` - USB 转 CAN 桥接
- `CANBUS` - CAN 总线通信
- `串口` - 串口通信 (USART)

## 烧录方法选项

- `DFU` - Device Firmware Update
- `UF2` - USB Flashing Format (RP2040)
- `KAT` - Katapult 烧录
- `TF` - TF 卡烧录

## 处理器系列

### STM32 系列
- STM32F072
- STM32F103
- STM32F405
- STM32F407
- STM32H723

### RP2040 系列
- Raspberry Pi RP2040
- Raspberry Pi RP2350

## 启动引脚参考

| 主板型号 | 处理器 | 启动引脚 |
|---------|--------|---------|
| SB2040 系列 | RP2040 | `gpio5` |
| SHT36 V3/Pro | RP2040 | `!gpio5` |
| SHT36/SHT36 V2 | STM32F072/F103 | `!PC13` |
| ERCF/ERCF V2 | RP2040 | `gpio17` |
| MMU | STM32H723 | `!PA15` |
| Tool-Lite | RP2040 | `!gpio18` |

## 使用说明

此配置文件用于 FLY Firmware Tool 固件编译工具，用于：
1. 自动填充编译参数
2. 确定 Bootloader 偏移地址
3. 配置通信接口
4. 设置启动引脚

## 更新记录

- 2026-03-12: 更新 RP2040 配置，修正通讯接口描述，添加启动引脚
- 2026-03-12: 添加 STM32 系列工具板启动引脚配置

## 相关链接

- [FLY 官方文档](https://docs.fly3d.cn)
- [FLY Firmware Tool](https://github.com/FengHua741/Firmware-Tool)
