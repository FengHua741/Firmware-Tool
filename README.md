# Firmware-Tool

Klipper 固件编译与烧录工具，提供 Web 界面管理 3D 打印机主板固件。

## 功能特性

### 📊 系统资源监控
- CPU / 内存 / 磁盘使用率实时监控
- 网络接口状态显示
- ID 搜索：USB 设备、CAN 设备、摄像头
- CAN 网络配置、诊断与修复

### 🔨 固件编译与烧录
- **主板选择**：按厂家/类型/型号快速选择主板配置
- **编译参数**：
  - 微控制器架构 (STM32 / RP2040 / RP2350)
  - 处理器型号、Bootloader 偏移
  - 通信接口 (USB / CAN / UART / USB转CAN桥接)
  - 启动引脚配置
- **固件烧录**：
  - 多种烧录方式：DFU / Katapult (USB/CAN) / UF2 / TF卡
  - 自动设备检测
- **BL 固件烧录**：Katapult/Bootloader 固件刷写

### ⚙️ 系统设置
- Klipper 路径配置
- JSON 配置仓库管理（支持 Git 远程更新）
- 时区设置
- 服务管理 (Klipper / Moonraker)

## 支持的主板

- **STM32 系列**：F0/F1/F2/F4/G0/G4/H7 等
- **RP2040/RP2350 系列**：Raspberry Pi Pico 等

## 安装

```bash
# 克隆项目
git clone https://github.com/your-repo/Firmware-Tool.git
cd Firmware-Tool

# 安装依赖
pip install flask flask-cors psutil requests

# 运行服务
python3 app.py
```

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
