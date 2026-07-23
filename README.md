# Firmware-Tool

Klipper 固件编译与烧录工具，提供 Web 界面管理 3D 打印机主板固件。支持本地模式与 SSH 远程模式，可在远程设备上直接编译和烧录固件。

## 目录

- [功能特性](#功能特性)
- [环境要求](#环境要求)
- [运行模式](#运行模式)
- [安装方法](#安装方法)
- [服务管理](#服务管理)
- [访问 Web 界面](#访问-web-界面)
- [运行时文件](#运行时文件)
- [数据维护](#数据维护)
- [烧录模式速查](#烧录模式速查)
- [路径访问限制](#路径访问限制)
- [项目结构](#项目结构)
- [主要 API](#主要-api)
- [API 使用约定](#api-使用约定)
- [常见问题](#常见问题)
- [技术栈](#技术栈)

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
- 通过 dfu-util 直接写入固件
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
- FAST-SSH / FlyOS 场景使用 fly-flash 烧录 HOST 固件并尝试重启 Klipper
- 普通本地 / SSH 模式将固件复制到 Klipper out 目录，便于后续手动处理

### BL 固件烧录
- 三级选择：厂家 -> 主板类型（mainboard/toolboard）-> BL 固件
- 根据当前选择的板卡过滤并优先展示匹配的 BL 固件
- 选择 BL 固件后自动填充推荐烧录工具与默认地址
- 烧录地址/偏移从当前 MCU 的 Klipper Kconfig 规则生成（NO BL / 8 KB / 16 KB 等）
- 全片擦除默认开启，执行前需要二次确认；擦除失败时停止 BL 烧录
- 支持 DFU / UF2 / Katapult 烧录方式，接口层也支持 `st-flash` 与 `openocd`
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
- 驱动器轴分配与 TMC 驱动配置（TMC2209/5160/2240 等），采样电阻/Rref 动态切换
- Z 限位/调平传感器三种模式：仅物理限位 / 物理限位 + 探针 / 探针替代 Z 限位（`probe:z_virtual_endstop`）
- BL-Touch、Voron Tap、电感/微动类探针支持，可选择主板或工具板作为探针来源并自动生成 MCU 前缀
- 探针上拉/反相 pin 修饰符、`safe_z_home` 联动、`bed_mesh` / `safe_z_home` / `z_tilt` / `screws_tilt_adjust` 可达区域检查
- 启用探针时生成 `QUERY_PROBE`、`PROBE_CALIBRATE`、BLTouch 调试等检查清单注释
- 工具板按子 MCU 管理，轴、限位、探针、加热、风扇、断料/堵料检测在对应选项卡中直接选择主板或工具板接口
- 工具板 `serial` / `canbus_uuid` 可留空，填写后才检查格式；新增工具板型号后默认将首个驱动、HE、TH 分配给挤出机
- 工具板驱动电流、驱动类型、采样电阻/Rref 可在轴分配页配置
- 对应选项卡内按坐标 JSON 显示板卡接口热区，支持悬停高亮、点击查看物理位置/真实 pin，并提供常用快捷分配
- 生成前检查跨功能引脚冲突，按实际 MCU pin 识别加热、热敏、风扇、限位、探针、断料/堵料、ADXL 与 DIAG 占用
- 断料/堵料检测支持 `switch` / `motion` 两种传感器、上拉/反相、`event_delay`、`pause_delay`、`runout_gcode` / `insert_gcode`
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

## 环境要求

- Python 3
- Linux / FlyOS-Fast 环境
- systemd（使用安装脚本部署服务时需要）
- Klipper 源码目录，默认 `~/klipper`
- 可选 Katapult 源码目录，默认 `~/katapult`
- 固件烧录相关工具按模式依赖 `dfu-util`、Klipper `flash_can.py`、`rp2040_flash` 或 FlyOS `fly-flash`
- CAN 相关功能依赖系统 CAN 接口与 `ip`、`python-can` 等 Klipper/CAN 环境

Python 依赖来自 `requirements.txt`：

```text
flask
flask-cors
psutil
paramiko
cryptography
requests
```

## 运行模式

### 本地模式
Firmware-Tool 与 Klipper 运行在同一台设备上，直接执行本地命令。

### SSH 远程模式
Firmware-Tool 通过 SSH 连接到运行 Klipper 的远程设备，所有编译、烧录、设备检测操作均在远程设备上执行。支持 SSH 密钥认证与密码认证。

SSH 模式会通过远程命令访问 Klipper、Katapult、系统设备与配置文件；部分本地静态资源（如板卡数据库、机型预设、Mainsail 基准配置）仍由 Firmware-Tool 本项目目录提供。

### FAST-SSH 模式
`connection_mode` 设置为 `fast-ssh` 时会使用 FlyOS-Fast 约定的 SSH 凭据，并按 `/data/klipper`、`/data` 等路径习惯处理远程环境。

## 安装方法

### 方法一：使用安装脚本（推荐）

```bash
git clone https://github.com/FengHua741/Firmware-Tool.git
cd Firmware-Tool/scripts

sudo ./install.sh
```

安装脚本会自动：
- 检测系统类型（FlyOS-Fast / 普通 Linux）
- FlyOS-Fast 环境中要求 root 用户运行，并将项目安装到 `/data/Firmware-Tool`
- 安装 Python 依赖（flask, flask-cors, psutil, paramiko, cryptography, requests）
- 首次安装时创建 `data/config.json` 并生成 `api_token`，已有配置文件时不会覆盖
- 创建 systemd 服务
- 在用户确认后启动服务并配置开机自启
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
  "port": 9999,
  "bind_host": "127.0.0.1",
  "klipper_path": "~/klipper",
  "katapult_path": "~/katapult",
  "json_repo_url": "",
  "last_json_update": null,
  "moonraker_host": "127.0.0.1",
  "moonraker_port": 7125,
  "connection_mode": "local",
  "ssh_host": "",
  "ssh_port": 22,
  "ssh_user": "",
  "sudo_mode": "password",
  "allowed_origins": [],
  "api_token": "请生成随机 Token 后填写",
  "require_csrf": true
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
- `require_csrf`：默认开启同源页面令牌校验；关闭前建议先配置 `api_token`

手动安装并监听局域网地址时，建议先生成并填写 `api_token`。未配置 `api_token` 时，请不要把服务直接暴露到不可信网络。

### 配置项说明

| 配置项 | 说明 |
|--------|------|
| `port` | Web 服务端口，默认 `9999` |
| `bind_host` | Web 服务监听地址，安装脚本生成的配置默认监听 `0.0.0.0`，样例配置默认 `127.0.0.1` |
| `klipper_path` | Klipper 源码目录，用于编译、读取 `.config`、调用 Klipper 脚本 |
| `katapult_path` | Katapult 源码目录，用于 Katapult 相关烧录流程 |
| `moonraker_host` / `moonraker_port` | Moonraker 地址，用于读取配置文件和版本信息 |
| `connection_mode` | 连接模式，可用值为 `local`、`ssh`、`fast-ssh` |
| `ssh_host` / `ssh_port` / `ssh_user` | SSH 远程模式的目标设备信息 |
| `sudo_mode` | 远程或本地提权方式，可用值为 `password`、`nopasswd` |
| `allowed_origins` | CORS 允许来源列表 |
| `api_token` | API 访问令牌，安装脚本首次创建配置时会自动生成 |
| `require_csrf` | 是否启用同源页面令牌校验 |

### 环境变量

| 环境变量 | 说明 |
|----------|------|
| `FIRMWARE_TOOL_HOST` | 覆盖 `bind_host`，用于临时指定监听地址 |
| `FIRMWARE_TOOL_API_TOKEN` | 覆盖 `api_token`，用于不修改配置文件时启用接口令牌 |
| `FIRMWARE_TOOL_ALLOWED_ORIGINS` | 覆盖 `allowed_origins`，多个来源用英文逗号分隔 |

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

systemd 服务文件由安装脚本写入 `/etc/systemd/system/firmware-tool.service`，默认以 root 运行，并设置 `WorkingDirectory` 为项目目录、`PYTHONPATH` 为项目的 `src` 目录。

## 访问 Web 界面

`http://<设备 IP>:9999`

如果配置了 `api_token`，可使用 `http://<设备 IP>:9999/?token=<你的 Token>` 让前端写入浏览器本地存储，之后接口请求会携带 `X-API-Token`。

## 运行时文件

- `data/config.json`：运行时配置文件，首次安装时由安装脚本创建；手动安装时可从 `data/config.example.json` 复制。
- `data/boards_index.json`：板卡索引，供板卡选择和引脚映射接口使用。
- `data/mcu_database.json`：MCU 数据库，来自 Klipper Kconfig 解析结果。
- `src/can_options_cache.json`：CAN 通信选项缓存。
- `data/mainsail_baseline.cfg`：Mainsail 宏基准，用于配置解析器对比。
- `~/klipper/out/firmware-tool-manifest.json`：最近一次固件编译 manifest。
- `/tmp/firmware-tool.log`：后端运行日志文件；无权限写入时仅输出到控制台或 systemd journal。

## 数据维护

`scripts/build_boards_index.py` 用于从板卡 JSON 与映射文件生成 `data/boards_index.json`。当新增或调整 `board_configs/`、`data/boards/board/` 下的板卡数据后，应同步更新索引文件。

板卡 JSON 数据主要分两类：
- `board_configs/FLY/mainboard/` 与 `board_configs/FLY/toolboard/`：用于固件编译预设。
- `data/boards/board/`：用于配置生成器的板卡元数据、图片路径与 Klipper/RRF 引脚映射。

固件文件主要存放在 `board_configs/FLY/BL/` 下，目录名区分 MainBoard、ToolBoard、ExtensionBoard、Screen 等类别。

## 烧录模式速查

| 模式 | 主要用途 | 关键依赖 |
|------|----------|----------|
| `DFU` | STM32/APM32 等 DFU 设备烧录 | `dfu-util` 与正确 DFU 地址 |
| `KAT` / `CAN` | Katapult/CanBoot 设备通过 USB 或 CAN 烧录 | Katapult `flashtool.py` 或 Klipper `flash_can.py` |
| `UF2` | RP2040/RP2350 BOOTSEL 设备烧录 | Klipper `lib/rp2040_flash/rp2040_flash` |
| `TF` | 生成可下载固件后由用户复制到 TF 卡 | 浏览器下载固件文件 |

BL 固件接口还接受 `st-flash` 与 `openocd` 模式，调用本机对应命令执行 ST-Link/OpenOCD 烧录。

## 路径访问限制

- 固件下载和主固件烧录只允许访问 Klipper `out` 目录、`/data/klipper/out`、项目 `board_configs/` 和项目 `out/`。
- BL 固件烧录只允许使用项目 `board_configs/` 下的固件文件。
- 远程浏览接口限制在 Klipper 目录、Klipper `out` 目录、项目 `board_configs/`、Klipper 所属用户家目录、`/data` 与 `/tmp`。
- 板卡图片接口只允许读取项目 `data/` 目录下由索引指向的图片文件。

## 项目结构

```
Firmware-Tool/
├── src/                          # 后端源码（Flask 蓝图模块）
│   ├── app.py                    # 主入口 - 应用初始化与蓝图注册
│   ├── canbus_query.py           # 增强 CAN UUID 查询脚本，本地模式优先用于 CAN 扫描
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
│   ├── config.example.json       # 配置文件样例
│   ├── config.json               # 运行时配置（安装或手动复制后生成）
│   ├── boards_index.json         # 板卡索引
│   ├── machines/                 # 机型预设
│   ├── boards/                   # 板卡元数据与引脚映射
│   ├── mainsail_baseline.cfg     # Mainsail 宏基准配置
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
    ├── build_boards_index.py     # 生成板卡索引
    ├── install.sh                # 安装脚本
    └── uninstall.sh              # 卸载脚本
```

## 主要 API

接口按当前蓝图分组如下。SSE 接口会持续返回流式文本或事件，前端用于展示执行进度。启用 `api_token` 时，API 请求需携带 `X-API-Token` 请求头或 `token` 查询参数；未使用 token 时，同源页面请求需通过 CSRF Cookie 与 `X-CSRF-Token` 请求头校验。

### 系统与设备

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/system/resources` | GET | 系统资源信息 |
| `/api/system/serial` | GET | 串口设备列表 |
| `/api/system/lsusb` | GET | USB 设备列表 |
| `/api/system/can-iface` | GET | CAN 接口列表 |
| `/api/system/can-uuid` | POST | CAN 设备 UUID 扫描；Klipper 节点可返回 MCU 型号与固件版本 |
| `/api/system/video` | GET | 摄像头设备 |
| `/api/system/ids` | GET | 汇总 USB、CAN、摄像头、Katapult USB 与 RP BOOT 设备 |
| `/api/system/versions` | GET | 系统版本信息 |
| `/api/system/services` | GET | 可管理服务列表与状态 |
| `/api/system/service` | POST | 控制允许列表中的服务启动、停止、重启或查询状态 |
| `/api/system/check-update` | GET | 检查项目更新 |
| `/api/system/update` | POST | 在线更新项目（流式输出） |
| `/api/system/can-config` | GET/POST | CAN 网络配置 |
| `/api/system/can-diagnose` | GET | CAN 网络诊断 |
| `/api/system/can-repair` | POST | 尝试修复 CAN 网络配置 |
| `/api/firmware/detect-can` | GET | 为固件烧录检测 CAN 设备 |

### 固件编译与烧录

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/firmware/boards` | GET | 固件编译板卡预设列表 |
| `/api/firmware/manufacturers` | GET | 固件编译厂家列表 |
| `/api/firmware/rules` | GET | 旧版 Klipper 编译规则 |
| `/api/firmware/rules/<processor>` | GET | 指定处理器的旧版编译规则 |
| `/api/firmware/current-config` | GET | 读取 Klipper `.config` 并返回可回填的编译参数 |
| `/api/firmware/dependencies` | GET | 检查编译依赖 |
| `/api/firmware/dependencies/install` | POST | 安装编译依赖（SSE 流式） |
| `/api/firmware/compile` | POST | 编译固件（SSE 流式） |
| `/api/firmware/manifest` | GET | 最近一次编译生成的固件 manifest |
| `/api/firmware/flash/plan` | POST | 生成烧录推荐与预检结果 |
| `/api/firmware/flash` | POST | 烧录固件（SSE 流式） |
| `/api/firmware/install-host` | POST | 安装 HOST 固件（SSE 流式） |
| `/api/firmware/host-info` | GET | HOST MCU 编译与安装状态信息 |
| `/api/firmware/detect` | GET | 检测可烧录设备 |
| `/api/firmware/can/scan` | GET | 扫描 CAN 烧录设备 |
| `/api/firmware/download` | GET | 下载允许目录内的固件文件 |
| `/api/firmware/bl-firmwares` | GET | BL 固件列表，支持厂家、板卡类型与型号过滤 |
| `/api/firmware/bl-firmwares/<manufacturer>` | GET | 指定厂家 BL 固件列表 |
| `/api/firmware/bl-firmwares/<manufacturer>/<board_type>` | GET | 指定厂家与板卡类型 BL 固件列表 |
| `/api/firmware/bl/address-options` | GET | 根据 Klipper Kconfig 生成 BL 烧录地址/偏移选项 |
| `/api/firmware/bl/flash` | POST | 烧录 BL 固件 |
| `/api/remote/browse` | GET | 浏览允许目录内的本地或远程文件 |

### Klipper MCU 数据

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/klipper/communication-options` | GET | 全平台通信接口选项 |
| `/api/klipper/mcu-database` | GET | MCU 数据库 |
| `/api/klipper/platforms` | GET | MCU 平台列表 |
| `/api/klipper/mcus/<platform>` | GET | 指定平台 MCU 列表 |
| `/api/klipper/mcu-info/<mcu_id>` | GET | 指定 MCU 详情 |
| `/api/klipper/refresh-database` | POST | 重新解析并刷新 Klipper MCU 数据库 |

### 配置生成器与板卡数据

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/tools/config-files` | GET | 列出 Klipper 配置目录中的配置文件 |
| `/api/tools/config-wildcard` | POST | 按通配符列出 include 文件 |
| `/api/tools/config-content` | POST | 读取指定配置文件内容 |
| `/api/tools/mainsail-config` | GET | 获取 Mainsail 配置或本地基准 |
| `/api/tools/mainsail-config/update` | POST | 从目标环境更新 Mainsail 基准 |
| `/api/tools/boards` | GET | 板卡索引 |
| `/api/tools/boards/<id>/mapping` | GET | 板卡引脚映射 |
| `/api/tools/boards/<id>/image` | GET | 板卡图片 |
| `/api/tools/machines` | GET | 机型预设列表 |
| `/api/tools/machines/<id>` | GET | 机型预设详情 |
| `/api/tools/validate-klipper-config` | POST | 校验生成的 Klipper 配置结构 |
| `/api/tools/detect-mcus` | GET | 检测配置生成器可用 MCU 设备 |

### 板卡配置管理

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/config/list/<manufacturer>` | GET | 列出指定厂家的板卡配置 |
| `/api/config/get/<manufacturer>/<config_id>` | GET | 读取指定板卡配置 |
| `/api/config/create/<manufacturer>` | POST | 创建板卡配置 |
| `/api/config/delete/<manufacturer>/<config_id>` | DELETE | 删除板卡配置 |
| `/api/config/upload` | POST | 上传板卡配置 JSON |
| `/api/config/mcu-list` | GET | MCU 型号列表 |
| `/api/config/manufacturers` | GET | 板卡配置厂家列表 |
| `/api/config/create-manufacturer` | POST | 创建厂家目录 |
| `/api/config/all` | GET | 获取全部板卡配置 |
| `/api/config/save` | POST | 保存板卡配置 |

### 系统设置与 SSH

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/settings/config` | GET/POST | 系统配置 |
| `/api/settings/ssh-credentials` | GET/POST | SSH 凭据读取与保存 |
| `/api/settings/resolve-paths` | GET | 解析当前模式下的关键路径 |
| `/api/settings/local-test` | POST | 测试本地 Klipper/Katapult 路径 |
| `/api/settings/ssh-test` | POST | 测试 SSH 连接 |
| `/api/ssh/status` | GET | SSH 连接状态 |
| `/api/ssh/reconnect` | POST | 重新建立 SSH 连接 |
| `/api/settings/timezone` | GET/POST | 读取或设置系统时区 |
| `/api/settings/service/<action>` | POST | 管理允许列表中的系统服务 |

### 固件更新配置

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/firmware-update/configs` | GET | 固件更新配置列表 |
| `/api/firmware-update/config/<manufacturer>/<config_id>` | GET | 读取固件更新配置 |
| `/api/firmware-update/config/<manufacturer>/<config_id>` | POST/PUT | 保存固件更新配置 |
| `/api/firmware-update/config/<manufacturer>/<config_id>` | DELETE | 删除固件更新配置 |

### CAN UUID 扫描

`src/canbus_query.py` 由 `/api/system/can-uuid` 在本地模式优先调用；SSH/FAST-SSH 模式会临时上传到远端 `/tmp/firmware-tool-canbus_query.py` 后执行。脚本通过 Python 直接运行，无单独构建步骤。

MCU 型号和固件版本来自 Klipper 节点的 identify 字典。CanBoot/Katapult 节点通常只能返回 UUID 与应用类型。

## API 使用约定

- 返回 JSON 的接口通常包含 `success`、`error`、`message` 或业务数据字段；错误时会返回 4xx/5xx 状态码或 `success: false`。
- `/api/firmware/compile`、`/api/firmware/flash`、`/api/firmware/install-host`、`/api/firmware/dependencies/install` 使用 `text/event-stream`。
- `/api/system/update` 使用流式文本输出。
- 需要路径参数的接口会做路径白名单校验，非法路径返回 403。

## 常见问题

- 服务无法访问：检查 `data/config.json` 中的 `bind_host` 与 `port`，并确认 systemd 服务已启动。
- API 返回未授权：确认前端地址带有 `?token=<你的 Token>`，或请求头包含 `X-API-Token`。
- 手动运行正常但服务运行异常：检查 `sudo journalctl -u firmware-tool -f` 输出，以及 systemd 服务中的 `WorkingDirectory` 和 `PYTHONPATH`。
- CAN 扫描无结果：先确认 CAN 接口存在并处于 UP 状态，再使用 CAN 诊断/修复接口检查 bitrate 与 txqueuelen。
- DFU 烧录失败：重新让主板进入 DFU 模式，并确认 DFU 地址与编译时 Bootloader 偏移匹配。
- RP2040/RP2350 UF2 烧录失败：确认设备已进入 BOOTSEL/BOOT 模式，并检查挂载权限。
- SSH 模式路径解析异常：检查 `/api/settings/resolve-paths` 返回的解析路径，并确认远端 Klipper/Katapult 目录存在。
- Mainsail 基准更新失败：确认 Moonraker 可访问，或在 SSH 模式下确认远端配置目录中存在 `mainsail.cfg`。
- BL 固件被拒绝烧录：确认选择的固件位于项目 `board_configs/` 目录内。

## 技术栈

- 后端：Python 3 + Flask + Paramiko（SSH）
- 前端：原生 HTML / CSS / JavaScript
- 流式输出：SSE（Server-Sent Events）
- 服务管理：systemd

## 许可证

MIT License
