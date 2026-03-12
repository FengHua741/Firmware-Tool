# Firmware-Tool

Klipper 固件编译与烧录工具，提供 Web 界面管理 3D 打印机主板固件。

## 功能特性

### 📊 系统资源监控
- **实时监控**：CPU / 内存 / 磁盘使用率
- **网络接口**：网络状态显示
- **ID 搜索**：USB 设备、CAN设备、摄像头
- **CAN 网络**：配置、诊断与修复（支持 systemd-networkd）

### 🔨 固件编译
- **主板选择**：按厂家 → 类型 → 型号快速选择
- **编译参数**：
  - 微控制器架构 (STM32 / RP2040 / RP2350)
  - 处理器型号、Bootloader 偏移量
  - 通信接口 (USB / CAN / UART / USB转 CAN桥接)
  - 启动引脚配置
- **输出格式**：自动生成 .bin / .uf2 固件

### 💾 固件烧录

#### 1. DFU 模式 (STM32)
- 支持 STM32 DFU  bootloader
- 可自定义 DFU 地址偏移
- 自动擦除后烧录

#### 2. Katapult 模式 (USB/CAN)
- **USB 方式**：检测 USB 串口设备直接烧录
- **CAN 方式**：通过 CAN 总线重置 → USB 枚举 → 烧录
- **自动判断**：根据设备类型智能选择烧录方式
- **支持场景**：
  - Klipper USB 模式
  - Katapult USB 模式
  - Katapult CAN 模式
  - Klipper CAN 模式

#### 3. UF2 模式 (RP2040/RP2350)
- 自动检测 RP2040 BOOT 设备
- 自动挂载 → 复制 UF2 → 同步 → 卸载
- 无需手动操作

#### 4. TF 卡模式
- 下载固件到本地
- 手动复制到 TF卡烧录

### 🔌 BL固件烧录
- **三级选择**：厂家 → 主板类型 (mainboard/toolboard) → BL固件
- **烧录方式**：DFU (STM32) / UF2 (RP2040)
- **嵌套目录支持**：BL/mainboard/产品/xxx.bin

### ⚙️ 系统设置
- Klipper 路径配置
- JSON 配置仓库管理（支持 Git 远程更新）
- 时区设置
- 服务管理 (Klipper / Moonraker)
- CAN 网络配置（速率、txqueuelen）

### ⚙️ 系统设置
- Klipper 路径配置
- JSON 配置仓库管理（支持 Git 远程更新）
- 时区设置
- 服务管理 (Klipper / Moonraker)

## 支持的主板

- **STM32 系列**：F0/F1/F2/F4/G0/G4/H7 等
- **RP2040/RP2350 系列**：Raspberry Pi Pico 等

## 安装方法

### 方法一：使用安装脚本（推荐）

```bash
# 克隆项目
git clone https://github.com/FengHua741/Firmware-Tool.git
cd Firmware-Tool/scripts

# 运行安装脚本
sudo ./install.sh
```

安装脚本会自动：
- ✅ 检测系统类型（FlyOS-Fast / 普通 Linux）
- ✅ 安装 Python 依赖（flask, flask-cors, psutil）
- ✅ 创建 systemd 服务
- ✅ 配置开机自启
- ✅ 设置默认端口（9999）

### 方法二：手动安装

```bash
# 克隆项目
git clone https://github.com/FengHua741/Firmware-Tool.git
cd Firmware-Tool

# 安装依赖
pip install flask flask-cors psutil requests

# 创建配置文件
cp config.json.example config.json

# 编辑配置
nano config.json

# 运行服务
python3 app.py
```

## 卸载方法

```bash
cd Firmware-Tool/scripts
sudo ./uninstall.sh
```

卸载脚本会：
- ❌ 停止并禁用 systemd 服务
- ❌ 删除服务配置文件
- ❌ 可选删除项目目录

## 服务管理

```bash
# 启动服务
sudo systemctl start firmware-tool

# 停止服务
sudo systemctl stop firmware-tool

# 重启服务
sudo systemctl restart firmware-tool

# 查看状态
sudo systemctl status firmware-tool

# 开机自启
sudo systemctl enable firmware-tool

# 查看日志
sudo journalctl -u firmware-tool -f
```

## 访问 Web 界面

打开浏览器访问：`http://<你的 IP>:9999`

例如：
- 本地访问：`http://localhost:9999`
- 远程访问：`http://192.168.1.100:9999`

## 配置

编辑 `config.json` 配置文件：

```json
{
  "klipper_path": "~/klipper",
  "port": 9999
}
```

## 主板配置

在 `board_configs/` 目录下按厂家组织 JSON 配置文件：

```
board_configs/
├── FLY/
│   ├── mainboard/
│   │   └── fly-c8.json
│   ├── toolboard/
│   │   └── sb2040-v3.json
│   └── BL/
│       └── katapult.bin
└── klipper_rules.json
```

## API 端点

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/system/resources` | GET | 获取系统资源信息 |
| `/api/system/ids` | GET | 搜索 USB/CAN/摄像头设备 |
| `/api/firmware/boards` | GET | 获取主板配置列表 |
| `/api/firmware/compile` | POST | 编译固件 |
| `/api/firmware/flash` | POST | 烧录固件 |
| `/api/firmware/bl/flash` | POST | 烧录 BL 固件 |
| `/api/can/config` | GET/POST | CAN 配置管理 |

## 许可证

MIT License
