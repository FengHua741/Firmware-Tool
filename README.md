# Firmware-Tool

Klipper 固件编译与烧录工具，提供 Web 界面管理 3D 打印机主板固件。支持本地模式与 SSH 远程模式，可在远程设备上直接编译和烧录固件。

## 功能特性

### 系统资源监控
- CPU / 内存 / 磁盘使用率实时显示
- 网络接口状态与 IP 地址
- 系统版本信息（Klipper / Moonraker / Firmware-Tool）
- 服务在线状态检测与一键重启

### 设备搜索
- USB 串口设备（by-id / by-path，智能识别 Klipper/Katapult 设备）
- CAN 总线设备 UUID 扫描
- USB 设备列表（lsusb）
- 摄像头设备
- CAN 接口列表

### CAN 网络管理
- 配置 CAN 接口（波特率、txqueuelen）
- 支持 systemd-networkd 配置
- CAN 总线诊断与自动修复
- 在线修改 CAN 波特率（无需重启 Klipper）

### 固件编译

#### 预设模式
- 三级选择：厂家 -> 主板类型 -> 型号
- 自动填充 MCU 参数（处理器、偏移量、连接方式）
- 页面加载自动选中 FLY 厂家 + 主板类型

#### 自定义模式
- 手动选择 MCU 平台与型号
- 支持全平台 MCU：
  - STM32 系列（F0/F1/F2/F4/G0/G4/H7 等）
  - RP2040 / RP2350
  - ATSAMD 系列（D21/D51/E5x 等）
  - LPC176x 系列
  - HC32F460
  - ATSAM 系列（SAM3X8E/SAM4E/SAME70 等）
  - AVR 系列（ATmega2560 等）
- 通信接口从 Klipper Kconfig 实时解析，支持：USB / UART / Serial / CAN / USB-CAN 桥接
- 启动引脚（CONFIG_INITIAL_PINS）配置
- 晶振频率与 Bootloader 偏移量设置

#### 编译过程
- SSE 流式输出，实时显示编译日志
- 固件下载（.bin / .uf2）

### 固件烧录

#### DFU 模式（STM32）
- 自动检测 DFU 设备（含 lsusb 兜底）
- 自定义地址偏移
- 自动擦除后烧录
- 烧录失败时提示重新进入 DFU 模式

#### Katapult 模式（USB / CAN）
- USB 方式：直接通过 USB 串口烧录
- CAN 方式：CAN 总线重置 -> USB 枚举 -> 烧录
- 支持 Klipper / Katapult 运行状态的智能判断

#### UF2 模式（RP2040 / RP2350）
- 自动检测 RP2040 BOOT 设备
- 自动挂载 -> 复制 UF2 -> 同步 -> 卸载

#### TF 卡模式
- 下载固件到本地，手动复制到 TF 卡烧录

#### HOST MCU 烧录
- 支持本地 / SSH 远程烧录 HOST 固件
- 使用 fly-flash 命令（FlyOS）或 dfu-util

### BL 固件烧录
- 三级选择：厂家 -> 主板类型（mainboard/toolboard）-> BL 固件
- 支持 DFU / UF2 烧录方式
- 嵌套目录结构：`BL/mainboard/产品/xxx.bin`

### 配置管理
- 主板配置创建 / 编辑 / 删除 / 上传
- MCU 型号数据库（自动从 Klipper 源码解析）
- JSON 配置文件版本管理

### 系统设置
- Klipper 路径配置
- SSH 凭据管理（SSH 远程模式）
- 时区设置
- 服务管理（Klipper / Moonraker / Firmware-Tool 重启）
- 固件更新检查与在线升级

## 运行模式

### 本地模式
Firmware-Tool 与 Klipper 运行在同一台设备上，直接执行本地命令。

### SSH 远程模式
Firmware-Tool 通过 SSH 连接到运行 Klipper 的远程设备，所有编译、烧录、设备检测操作均在远程设备上执行。支持 SSH 密钥认证与密码认证。

## 安装方法

### 方法一：使用安装脚本（推荐）

```bash
git clone https://github.com/FengHua741/Firmware-Tool.git
cd Firmware-Tool/scripts

sudo ./install.sh
```

安装脚本会自动：
- 检测系统类型（FlyOS-Fast / 普通 Linux）
- 安装 Python 依赖（flask, flask-cors, psutil, paramiko）
- 创建 systemd 服务
- 配置开机自启
- 设置默认端口（9999）

### 方法二：手动安装

```bash
git clone https://github.com/FengHua741/Firmware-Tool.git
cd Firmware-Tool

pip install flask flask-cors psutil paramiko requests

nano config.json
```

`config.json` 基础配置：
```json
{
  "klipper_path": "~/klipper",
  "port": 9999
}
```

```bash
python3 app.py
```

## 卸载方法

```bash
cd Firmware-Tool/scripts
sudo ./uninstall.sh
```

## 服务管理

```bash
sudo systemctl start firmware-tool
sudo systemctl stop firmware-tool
sudo systemctl restart firmware-tool
sudo systemctl status firmware-tool
sudo journalctl -u firmware-tool -f
```

## 访问 Web 界面

`http://<设备 IP>:9999`

## 项目结构

```
Firmware-Tool/
├── app.py                    # Flask 主程序
├── ssh_manager.py            # SSH 远程执行管理
├── kconfig_can_parser.py     # Klipper Kconfig 解析（全平台）
├── board_config_loader.py    # 主板配置加载
├── mcu_database.json         # MCU 数据库
├── klipper_rules.json        # Klipper 编译规则
├── config.json               # 运行时配置
├── board_configs/            # 主板固件与配置
│   └── FLY/
│       ├── mainboard/        # 主板 JSON 配置
│       ├── toolboard/        # 工具板 JSON 配置
│       └── BL/               # Bootloader 固件
├── static/
│   ├── index.html            # 主页面
│   ├── pages/                # 子页面
│   ├── js/                   # 前端逻辑
│   └── css/                  # 样式
└── scripts/
    ├── install.sh            # 安装脚本
    └── uninstall.sh          # 卸载脚本
```

## 主要 API

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/system/resources` | GET | 系统资源信息 |
| `/api/system/serial` | GET | 串口设备列表 |
| `/api/system/lsusb` | GET | USB 设备列表 |
| `/api/system/can-iface` | GET | CAN 接口列表 |
| `/api/system/can-uuid` | POST | CAN 设备 UUID 扫描 |
| `/api/system/video` | GET | 摄像头设备 |
| `/api/firmware/compile` | POST | 编译固件（SSE 流式） |
| `/api/firmware/flash` | POST | 烧录固件（SSE 流式） |
| `/api/firmware/install-host` | POST | 安装 HOST 固件（SSE 流式） |
| `/api/firmware/detect` | GET | 检测可烧录设备 |
| `/api/klipper/communication-options` | GET | 全平台通信接口选项 |
| `/api/klipper/mcu-database` | GET | MCU 数据库 |
| `/api/settings/config` | GET/POST | 系统配置 |
| `/api/system/can-config` | GET/POST | CAN 网络配置 |
| `/api/system/versions` | GET | 系统版本信息 |

## 技术栈

- 后端：Python 3 + Flask + Paramiko（SSH）
- 前端：原生 HTML / CSS / JavaScript
- 流式输出：SSE（Server-Sent Events）
- 服务管理：systemd

## 许可证

MIT License
