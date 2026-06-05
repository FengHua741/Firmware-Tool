# SSH 远程执行功能实现计划

## Context

Firmware-Tool 当前所有操作（编译、烧录、设备检测）都在本地执行。用户需要通过 SSH 远程控制其他机器上的 Klipper 编译和烧录。在系统设置中添加连接模式切换（本地/SSH），配置远程机器 IP/用户名/密码后，所有命令自动通过 SSH 执行。

## 关键决策

- 认证方式：**仅密码认证**（最简单，用户名+密码即可）
- sudo 处理：**支持 sudo 密码输入**（通过 sudo -S stdin 传递）
- 密码存储：**Fernet 加密存储**，config.json 中无明文

## 修改文件清单

| 文件 | 变更类型 | 说明 |
|------|---------|------|
| `ssh_manager.py` | 新增 | SSH管理器、run_cmd、文件传输、凭据加密 |
| `app.py` | 修改 | 74处 subprocess 替换、config 扩展、新增 API |
| `static/index.html` | 修改 | 设置页新增连接模式卡片 |
| `static/js/app.js` | 修改 | 设置保存/加载、模式切换、测试连接 |
| `scripts/install.sh` | 修改 | 新增 paramiko/cryptography 依赖 |

## 实现步骤

### Step 1: 新建 ssh_manager.py

创建 SSH 管理模块，包含：

**1.1 CmdResult 类** -- 兼容 subprocess.CompletedProcess 接口
```
CmdResult(returncode, stdout, stderr)
```

**1.2 SSHManager 类** -- 单连接复用、线程安全、自动重连
- `get_connection()` -- 获取活跃连接，必要时建立/重建
- `_connect()` -- paramiko SSHClient 密码连接
- `wrap_sudo(cmd)` -- sudo -S 包装，从加密凭据读密码
- `get_sftp()` -- 获取 SFTP 会话

**1.3 统一执行函数**
- `run_cmd(cmd, shell=False, capture_output=True, text=True, timeout=None, sudo=False)` -- 根据 connection_mode 自动路由本地/远程
- `path_exists(path)` -- os.path.exists 的本地/远程替代
- `get_file_size(path)` -- os.path.getsize 的本地/远程替代

**1.4 文件传输**
- `ssh_download(remote_path, local_path)` -- SFTP 下载
- `ssh_upload(local_path, remote_path)` -- SFTP 上传

**1.5 凭据加密存储**
- `save_credential(field, value)` -- Fernet 加密保存到 ~/.firmware-tool/ssh_credentials.enc
- `load_credential(field)` -- 解密读取
- 加密密钥文件: /etc/firmware-tool/ssh_key (root-only 0600)

### Step 2: 扩展 config.json 和 API

**2.1 DEFAULT_CONFIG 新增字段：**
```python
'connection_mode': 'local',   # 'local' 或 'ssh'
'ssh_host': '',               # 远程主机 IP
'ssh_port': 22,               # SSH 端口
'ssh_user': '',               # SSH 用户名
'sudo_mode': 'password',      # 'nopasswd' 或 'password'
```

**2.2 handle_config API 字段白名单扩展** (app.py 第2013行)

**2.3 新增 API 端点：**
- `POST /api/settings/ssh-credentials` -- 设置 SSH 密码/sudo 密码（加密存储）
- `GET /api/settings/ssh-credentials` -- 返回是否已设置（不返回明文）
- `POST /api/settings/ssh-test` -- 测试 SSH 连接

### Step 3: 替换 app.py 中的 subprocess 调用

按优先级替换：

**3.1 编译流程（3处）**
- 第1081行: `subprocess.run(f'cd {klipper_path} && rm -rf .config out', ...)` -> `run_cmd()`
- 第1401行: `make olddefconfig` -> `run_cmd(timeout=60)`
- 第1414行: `make -j4` -> `run_cmd(timeout=300)`

**3.2 烧录流程（~10处）**
- DFU 擦除/烧录 (第1733-1737行)
- KAT USB 烧录 (第1798行)
- CAN 烧录 (第1806行)
- RP2040 UF2 烧录 (第1836行)
- KAT CAN 重置 (第1766行)
- 设备轮询 (第1774行)
- BL 烧录各分支 (第1948-1988行)

**3.3 设备检测（15处）**
- /dev/serial/by-id 扫描 (第821/1539行)
- dfu-util 检测 (第839/1583行)
- ttyACM/ttyUSB 扫描 (第1552/1566行)
- lsblk/lsusb (第893/907行)
- /dev/video (第879行)

**3.4 CAN 扫描（2处）**
- canbus_query.py (第518/695行)

**3.5 系统管理（~5处）**
- systemctl (第257行)
- git 操作 (第3470-3572行) -- 注意项目自身更新强制本地执行

### Step 4: 替换 os.path.exists 调用

关键替换点：
- 第1077行: klipper_path 存在性检查
- 第1522/1705行: 固件文件检查
- 第1803/1829行: 烧录脚本/工具检查
- 第57/60/71行: get_klipper_owner() 路径查找

不替换的（始终本地）：
- config.json 读写
- board_configs/ 目录操作
- psutil 资源监控改为远程命令

### Step 5: 文件传输集成

**5.1 编译产物下载**
- 编译成功后自动 `ssh_download()` 远程 `~/klipper/out/klipper.bin` 到本地 `/tmp/fwtool_cache/`
- `/api/firmware/download` API 从缓存路径 `send_file()`

**5.2 BL 固件上传**
- BL 烧录前 `ssh_upload()` 本地 BL 文件到远程 `/tmp/fwtool_bl/`
- 烧录命令中固件路径改为远程临时路径

### Step 6: 前端设置页面

**6.1 index.html 新增连接模式卡片** (在路径设置卡片之前)

UI 元素：
- 连接模式单选：本地执行 / SSH 远程执行
- SSH 配置区（仅远程模式可见）：
  - 远程主机 IP
  - SSH 端口
  - 用户名
  - SSH 密码
  - sudo 密码
  - sudo 模式选择（NOPASSWD/需要密码）
- 测试连接按钮 + 状态显示
- 保存设置按钮

**6.2 app.js 新增函数**
- `loadConnectionMode()` -- 加载连接模式和 SSH 配置
- `saveConnectionMode()` -- 保存连接模式
- `toggleSshConfig()` -- 切换 SSH 配置区显隐
- `testSshConnection()` -- 测试 SSH 连接
- `saveSshCredentials()` -- 保存 SSH/sudo 密码到加密 API

**6.3 交互逻辑**
- 选择"本地执行"：SSH 配置区折叠
- 选择"SSH远程执行"：SSH 配置区展开
- 切换模式后自动刷新资源监控和设备列表
- 远程模式下设备列表标注"远程设备"

### Step 7: 资源监控适配

SSH 模式下 psutil 改为远程命令采集：
```python
# 合并为一个 SSH 命令减少往返
script = '''
echo "CPU:$(grep 'cpu ' /proc/stat)"
echo "MEM:$(free -m | grep Mem)"
echo "DISK:$(df -h / | tail -1)"
echo "UPTIME:$(uptime -p)"
echo "TEMP:$(cat /sys/class/thermal/thermal_zone0/temp 2>/dev/null || echo N/A)"
'''
```

## 验证方案

1. 本地模式：所有功能无变化（回归测试）
2. SSH 模式基本连接：测试连接按钮成功
3. SSH 模式编译：远程 make 编译 + 产物下载
4. SSH 模式设备检测：远程 lsusb/dfu-util 扫描
5. SSH 模式烧录：远程 dfu-util/flashtool 烧录
6. 模式切换：本地->SSH->本地 切换后功能正常
7. 密码安全：config.json 中无明文密码
8. 连接断开恢复：断网后重连自动恢复
