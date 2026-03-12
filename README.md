# FLY Firmware Tool

FLY 3D打印机固件编译与烧录工具，提供 Web 界面用于管理 FLY 系列主板的固件编译、烧录和配置。

## 功能特性

### 1. 系统资源监控
- 实时显示 CPU、内存、磁盘使用率
- 网络接口状态监控
- 系统 ID 搜索（USB Serial、CANbus UUID、视频设备）

### 2. 固件编译
- **主板选择**: 三级目录结构（厂家/类型/型号）
- **自动参数填充**: 根据主板型号自动填充编译参数
  - MCU 架构
  - 处理器型号
  - Bootloader 偏移
  - 通信接口
  - 启动引脚
- **Klipper 规则集成**: 自动获取 Klipper Kconfig 规则
- **多处理器支持**: STM32、RP2040、GD32 等系列
- **通信方式**: USB、USB to CAN、CAN bus、Serial

### 3. 固件烧录
- **多种烧录方式**: DFU、UF2、Katapult、TF 卡
- **自动设备检测**: 自动检测 DFU、CAN、USB 设备
- **BL 烧录支持**: 支持 Katapult Bootloader 烧录

### 4. CAN 网络管理
- **CAN 配置**: 支持 systemd-networkd 和传统 interfaces 配置
- **速率设置**: 1M/500K/250K 可选
- **缓存设置**: txqueuelen 128-8192 可调
- **网络诊断**: 自动诊断和修复 CAN 网络问题
- **设备检测**: USB CAN 设备计数（1d50:xxxx）

### 5. 系统设置
- Klipper 路径配置
- JSON 配置仓库管理
- 服务端口号设置
- 时区设置
- 服务管理（Klipper/Moonraker 启动、重启、停止）

## 支持的硬件

### 主板 (Mainboard)
- FLY-C5/C8/C8P
- FLY-D5/D7/DP5
- FLY-D8 (F407/H723)
- FLY-E3 Ultra/V2
- FLY-F407ZG
- FLY-Gemini V3
- FLY-Micro4
- FLY-Pro X10
- FLY-RPFMEX
- FLY-Super5/Super8/Super8 Pro

### 工具板 (Toolboard)
- FLY-SB2040 / SB2040 Pro / SB2040 V3 / SB2040 Pro V3
- FLY-SHT36 / SHT36 V2 / SHT36 V3 / SHT36 Pro / SHT36 LIS3DH
- FLY-ERCF / ERCF V2
- FLY-MMU
- FLY-USB-ADXL
- FLY-Tool-Lite

## 安装

### 快速安装

```bash
cd ~
git clone https://github.com/FengHua741/Firmware-Tool.git
cd Firmware-Tool
chmod +x scripts/install.sh
./scripts/install.sh
```

### 手动安装

1. 克隆仓库
```bash
git clone https://github.com/FengHua741/Firmware-Tool.git
cd Firmware-Tool
```

2. 安装依赖
```bash
pip3 install -r requirements.txt
```

3. 运行
```bash
python3 app.py
```

4. 访问 Web 界面
```
http://<你的IP>:9999
```

## 使用说明

### 固件编译流程

1. **选择主板**: 在"固件编译"页面选择厂家、类型、型号
2. **确认参数**: 系统自动填充编译参数，可手动修改
3. **开始编译**: 点击"开始编译"按钮
4. **下载固件**: 编译完成后下载固件文件

### CAN 配置流程

1. **进入系统资源页面**: 查看 CAN 网络状态
2. **配置 CAN**: 设置速率和缓存大小
3. **应用配置**: 点击"应用配置"使设置生效
4. **诊断修复**: 如有问题可使用"诊断并修复"功能

### 固件烧录流程

1. **进入固件烧录页面**: 选择烧录方式
2. **连接设备**: 按提示进入烧录模式
3. **选择固件**: 选择要烧录的固件文件
4. **开始烧录**: 点击"开始烧录"

## 配置文件

### 主板配置

主板配置文件位于 `board_configs/` 目录，使用 JSON 格式：

```json
{
  "产品类型": "toolboard",
  "名称": "FLY-SB2040",
  "处理器": "Raspberry Pi RP2040",
  "BL偏移": "16KiB bootloader",
  "通讯方式": ["CANBUS", "USB"],
  "默认通讯": "CAN bus",
  "烧录方法": ["UF2"],
  "默认烧录": "KAT",
  "启动引脚": "gpio5",
  "BL烧录": "支持",
  "BL默认方式": "UF2",
  "id": "sb2040"
}
```

### 系统配置

系统配置文件 `config.json`：

```json
{
  "port": 9999,
  "klipper_path": "/home/fenghua/klipper",
  "json_repo_url": "https://github.com/FengHua741/board_configs.git"
}
```

## 项目结构

```
Firmware-Tool/
├── app.py                  # Flask 主应用
├── board_config_loader.py  # 主板配置加载器
├── board_configs/          # 主板配置仓库
│   ├── FLY/
│   │   ├── mainboard/     # 主板配置
│   │   ├── toolboard/     # 工具板配置
│   │   └── BL/            # Bootloader 固件
│   └── README.md
├── static/                 # 静态资源
│   ├── css/
│   ├── js/
│   └── index.html
├── scripts/                # 安装脚本
├── config.json            # 系统配置
└── README.md
```

## 技术栈

- **后端**: Python 3 + Flask
- **前端**: HTML5 + CSS3 + JavaScript (原生)
- **UI 框架**: Material Design
- **固件编译**: Klipper Make
- **烧录工具**: dfu-util, rp2040_flash, flash_can.py

## 更新日志

### 2026-03-12
- 添加主板选择后自动填充编译参数功能
- 更新 RP2040 配置，修正通讯接口描述
- 添加所有工具板启动引脚配置
- 添加 CAN 网络诊断和修复功能
- 修复系统设置保存问题

### 2026-03-11
- 添加 CAN 缓存 (txqueuelen) 显示和修改功能
- 修复 CAN 速率显示问题
- 添加 USB CAN 设备检测

## 相关链接

- [FLY 官方文档](https://docs.fly3d.cn)
- [Klipper 文档](https://www.klipper3d.org)
- [主板配置仓库](https://github.com/FengHua741/board_configs)

## 许可证

MIT License

## 致谢

- [Klipper](https://github.com/Klipper3d/klipper) - 3D打印机固件
- [Katapult](https://github.com/Arksine/katapult) - 用于 3D 打印机主板的 Bootloader
