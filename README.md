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
- MCU 型号、通信接口、晶振频率与 Bootloader 偏移从 Klipper Kconfig 实时解析
- 通信接口支持：USB / UART / Serial / CAN / USB-CAN 桥接
- 启动引脚（CONFIG_INITIAL_PINS）配置
- 晶振频率与 Bootloader 偏移量设置

#### 编译过程
- SSE 流式输出，实时显示编译日志
- 固件下载（.bin / .uf2）
- 编译成功后生成 `~/klipper/out/firmware-tool-manifest.json`，记录板卡、MCU、连接方式、Bootloader 偏移、固件路径与校验信息

### 固件烧录
- 基于最近一次编译 manifest、固件后缀与当前设备状态生成烧录推荐
- 烧录前预检固件文件、设备选择、CAN 接口与 DFU 地址，发现阻塞问题时默认停止烧录

#### DFU 模式（STM32）
- Klipper 主固件 DFU 烧录仅用于 NOBL（无 Bootloader 偏移）固件
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
- 根据当前选择的板卡过滤并优先展示匹配的 BL 固件
- 选择 BL 固件后自动填充推荐烧录工具与默认地址
- 烧录地址/偏移从当前 MCU 的 Klipper Kconfig 规则生成（NO BL / 8 KB / 16 KB 等）
- 全片擦除默认开启，执行前需要二次确认；擦除失败时停止 BL 烧录
- 支持 DFU / UF2 烧录方式
- 嵌套目录结构：`BL/mainboard/产品/xxx.bin`

### 配置管理
- 主板配置创建 / 编辑 / 删除 / 上传
- MCU 型号数据库（自动从 Klipper 源码解析）
- JSON 配置文件版本管理

### Klipper 配置生成器
- 6 个选项卡引导式配置：机器设置 / 轴分配与TMC / 限位与调平 / 归位与调平 / 温控与冷却 / 生成配置
- 生成配置页内置配置解析器，可上传或远程加载 printer.cfg 及 include 文件
- 解析器可识别引脚分配、驱动器配置、传感器型号，并执行重复 section、引脚冲突与 Mainsail 宏基准比对
- 主板与打印机型号选择，自动匹配引脚映射与运动学参数
- 驱动器轴分配与 TMC 驱动配置（TMC2209/5160/2240 等），采样电阻/rref 动态切换
- Z 限位/调平传感器三种模式：仅物理限位 / 物理限位+探针 / 探针替代 Z 限位(probe:z_virtual_endstop)
- BL-Touch、Voron Tap、电感/微动类探针支持，可选择主板或工具板作为探针来源并自动生成 MCU 前缀
- 探针上拉/反相 pin 修饰符、safe_z_home 联动、bed_mesh/safe_z_home/z_tilt/screws_tilt_adjust 可达区域检查
- 启用探针时生成 QUERY_PROBE、PROBE_CALIBRATE、BLTouch 调试等检查清单注释
- 工具板按子 MCU 管理，轴、限位、探针、加热、风扇、断料/堵料检测在对应选项卡中直接选择主板或工具板接口
- 工具板 serial/canbus_uuid 可留空，填写后才检查格式；新增工具板型号后默认将首个驱动、HE、TH 分配给挤出机
- 工具板驱动电流、驱动类型、采样电阻/Rref 可在轴分配页配置
- 对应选项卡内按坐标 JSON 显示板卡接口热区，支持悬停高亮、点击查看物理位置/真实 pin，并提供常用快捷分配
- 生成前检查跨功能引脚冲突，按实际 MCU pin 识别加热、热敏、风扇、限位、探针、断料/堵料、ADXL 与 DIAG 占用
- 断料/堵料检测支持 switch/motion 两种传感器、上拉/反相、event_delay、pause_delay、runout/insert gcode
- 支持完整配置、仅工具板片段、仅主板片段、与现有配置合并建议四种输出模式
- 导入旧 printer.cfg 后识别 `[mcu xxx]`、工具板前缀 pin、serial/canbus_uuid，并提供 section 级 diff
- 生成后可执行本地结构校验，检查重复 section 与缺失 MCU 前缀定义
- DIAG 传感器限位（含 DIAG0/DIAG1 通道选择）
- 原点位置驱动归位方向与限位位置统一设置，手动限位位置独立可调
- 配置输出自动对齐注释至第 49 列，段落标题可视宽度对齐
- 一键下载/复制配置，生成后自动跳转至预览选项卡

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
- 安装 Python 依赖（flask, flask-cors, psutil, paramiko, cryptography, requests）
- 首次安装时创建 `data/config.json`，已有配置文件时不会覆盖
- 创建 systemd 服务
- 配置开机自启
- 设置默认端口（9999）

### 方法二：手动安装

```bash
git clone https://github.com/FengHua741/Firmware-Tool.git
cd Firmware-Tool

pip install -r requirements.txt
```

复制并编辑 `data/config.json` 基础配置：
```bash
cp data/config.example.json data/config.json
```

```json
{
  "klipper_path": "~/klipper",
  "port": 9999,
  "bind_host": "0.0.0.0"
}
```

```bash
python3 src/app.py
```

### 可选安全配置

`data/config.json` 支持以下可选安全项：
- `bind_host`：服务监听地址，默认 `0.0.0.0`
- `allowed_origins`：CORS 允许来源列表，空列表表示兼容旧行为
- `api_token`：设置后 API 请求需要携带 `X-API-Token` 请求头；网页可通过 `http://设备IP:端口/?token=你的Token` 写入浏览器本地存储

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
├── src/                          # 后端源码（Flask 蓝图模块）
│   ├── app.py                    # 主入口 - 应用初始化与蓝图注册
│   ├── shared.py                 # 共享资源 - 全局常量、配置、工具函数
│   ├── routes_system.py          # 系统管理蓝图 - 资源监控、设备检测、服务管理
│   ├── routes_firmware.py        # 固件蓝图 - 编译、烧录、下载
│   ├── routes_tools.py           # 工具蓝图 - 配置解析器、配置生成器、板卡/机型API
│   ├── routes_config.py          # 板级配置蓝图 - 配置增删改查
│   ├── routes_settings.py        # 系统设置蓝图 - SSH配置、CAN配置诊断、时区
│   ├── routes_klipper.py         # Klipper MCU 数据库蓝图 - Kconfig 解析
│   ├── routes_update.py          # 固件更新蓝图 - 更新配置管理
│   ├── ssh_manager.py            # SSH 远程执行管理
│   ├── kconfig_can_parser.py     # Klipper Kconfig CAN 解析
│   └── klipper_kconfig_parser.py # Klipper Kconfig 全平台解析
├── data/                         # 数据文件
│   ├── config.json               # 运行时配置
│   ├── klipper_rules.json        # 旧版 Klipper 编译规则数据（兼容 API）
│   └── mcu_database.json         # MCU 芯片数据库
├── board_configs/                # 主板固件与配置
│   └── FLY/
│       ├── mainboard/            # 主板 JSON 配置
│       ├── toolboard/            # 工具板 JSON 配置
│       └── BL/                   # Bootloader 固件
├── static/                       # 前端静态资源
│   ├── index.html                # 主页面
│   ├── pages/                    # 子页面
│   ├── js/                       # 前端逻辑
│   └── css/                      # 样式
└── scripts/
    ├── install.sh                # 安装脚本
    └── uninstall.sh              # 卸载脚本
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
| `/api/firmware/current-config` | GET | 读取 Klipper `.config` 并返回可回填的编译参数 |
| `/api/firmware/compile` | POST | 编译固件（SSE 流式） |
| `/api/firmware/manifest` | GET | 最近一次编译生成的固件 manifest |
| `/api/firmware/flash/plan` | POST | 生成烧录推荐与预检结果 |
| `/api/firmware/flash` | POST | 烧录固件（SSE 流式） |
| `/api/firmware/install-host` | POST | 安装 HOST 固件（SSE 流式） |
| `/api/firmware/detect` | GET | 检测可烧录设备 |
| `/api/firmware/bl-firmwares` | GET | BL 固件列表，支持厂家、板卡类型与型号过滤 |
| `/api/firmware/bl/address-options` | GET | 根据 Klipper Kconfig 生成 BL 烧录地址/偏移选项 |
| `/api/klipper/communication-options` | GET | 全平台通信接口选项 |
| `/api/klipper/mcu-database` | GET | MCU 数据库 |
| `/api/tools/boards` | GET | 板卡索引 |
| `/api/tools/boards/<id>/mapping` | GET | 板卡引脚映射 |
| `/api/tools/boards/<id>/image` | GET | 板卡图片 |
| `/api/tools/machines` | GET | 机型预设列表 |
| `/api/tools/machines/<id>` | GET | 机型预设详情 |
| `/api/tools/validate-klipper-config` | POST | 校验生成的 Klipper 配置结构 |
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
