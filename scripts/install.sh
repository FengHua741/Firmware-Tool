#!/bin/bash

# Firmware-Tool 安装脚本
# 默认端口: 9999

set -e

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}=== Firmware-Tool 安装脚本 ===${NC}"
echo ""

# 获取脚本所在目录（所有系统都需要）
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
# 安装脚本部署后默认允许通过所有网卡访问
BIND_HOST="0.0.0.0"

# 检测是否为FlyOS-Fast系统
IS_FAST=false
if [ -f /etc/issue ]; then
    if grep -q "FlyOS-Fast" /etc/issue; then
        IS_FAST=true
        echo -e "${YELLOW}检测到 FlyOS-Fast 系统${NC}"
    fi
fi

# Fast系统检查
if [ "$IS_FAST" = true ]; then
    # Fast系统必须使用root
    if [ "$EUID" -ne 0 ]; then
        echo -e "${RED}FlyOS-Fast系统必须使用root用户运行此脚本${NC}"
        exit 1
    fi
    CURRENT_USER="root"

    # Fast系统必须安装到/data目录
    PROJECT_DIR="/data/Firmware-Tool"
    echo -e "${YELLOW}Fast系统: 项目将安装到 $PROJECT_DIR${NC}"
else
    # 普通系统
    PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

    # 检查root权限
    if [ "$EUID" -ne 0 ]; then
        echo -e "${RED}请使用sudo运行此脚本${NC}"
        exit 1
    fi

    # 获取当前用户（非root）
    CURRENT_USER=${SUDO_USER:-$USER}
    if [ "$CURRENT_USER" = "root" ]; then
        # 尝试从 /home 推断实际用户
        for user_dir in /home/*; do
            if [ -d "$user_dir" ]; then
                CURRENT_USER=$(basename "$user_dir")
                break
            fi
        done
        if [ "$CURRENT_USER" = "root" ]; then
            CURRENT_USER=$(id -un 2>/dev/null || printf 'root')
            echo -e "${YELLOW}警告: 无法推断普通用户，将使用当前用户 $CURRENT_USER${NC}"
        fi
    fi
fi

SERVICE_NAME="firmware-tool"
MOONRAKER_ASVC_UPDATED=false
MOONRAKER_ASVC_FILES=()

# 收集当前系统中 Moonraker 实例的允许服务清单。优先读取运行参数中的
# data path，同时兼容常见 Linux、KIAUH 多实例和 FlyOS-Fast 目录布局。
add_moonraker_asvc_file() {
    local candidate="$1"
    local existing

    [ -f "$candidate" ] || return 0
    for existing in "${MOONRAKER_ASVC_FILES[@]}"; do
        [ "$existing" = "$candidate" ] && return 0
    done
    MOONRAKER_ASVC_FILES+=("$candidate")
}

discover_moonraker_asvc_files() {
    local data_path
    local asvc_file
    local search_roots=()

    MOONRAKER_ASVC_FILES=()
    while IFS= read -r data_path; do
        [ -n "$data_path" ] && add_moonraker_asvc_file "$data_path/moonraker.asvc"
    done < <(
        ps -eo args= 2>/dev/null | awk '
            /moonraker\.py/ {
                for (i = 1; i <= NF; i++) {
                    if (($i == "-d" || $i == "--data-path") && i < NF) {
                        print $(i + 1)
                        break
                    }
                    if ($i ~ /^--data-path=/) {
                        sub(/^--data-path=/, "", $i)
                        print $i
                        break
                    }
                }
            }
        '
    )

    for data_path in /home /root /data; do
        [ -d "$data_path" ] && search_roots+=("$data_path")
    done
    if [ "${#search_roots[@]}" -gt 0 ]; then
        while IFS= read -r asvc_file; do
            add_moonraker_asvc_file "$asvc_file"
        done < <(find "${search_roots[@]}" -maxdepth 4 -type f -name moonraker.asvc 2>/dev/null)
    fi
    add_moonraker_asvc_file "/usr/share/printer_data/moonraker.asvc"
}

register_moonraker_service() {
    local asvc_file

    discover_moonraker_asvc_files
    if [ "${#MOONRAKER_ASVC_FILES[@]}" -eq 0 ]; then
        echo -e "${YELLOW}未检测到 Moonraker 服务清单，跳过 Fluidd/Mainsail 服务集成${NC}"
        return 0
    fi

    for asvc_file in "${MOONRAKER_ASVC_FILES[@]}"; do
        if grep -Fqx "$SERVICE_NAME" "$asvc_file"; then
            echo "Moonraker 已允许管理 $SERVICE_NAME: $asvc_file"
            continue
        fi
        if [ -s "$asvc_file" ] && [ -n "$(tail -c 1 "$asvc_file" 2>/dev/null)" ]; then
            printf '\n' >> "$asvc_file"
        fi
        printf '%s\n' "$SERVICE_NAME" >> "$asvc_file"
        MOONRAKER_ASVC_UPDATED=true
        echo -e "${GREEN}已加入 Fluidd/Mainsail 服务列表: $asvc_file${NC}"
    done
}

reload_moonraker_service_list() {
    local moonraker_unit
    local restarted=false

    [ "$MOONRAKER_ASVC_UPDATED" = true ] || return 0
    while IFS= read -r moonraker_unit; do
        [ -n "$moonraker_unit" ] || continue
        systemctl restart "$moonraker_unit"
        restarted=true
        echo -e "${GREEN}已重启 $moonraker_unit，Fluidd/Mainsail 服务列表已刷新${NC}"
    done < <(
        systemctl list-units --all --type=service --plain --no-legend 2>/dev/null |
            awk '$1 ~ /^moonraker([_-]?[0-9]+)?\.service$/ && $3 == "active" {print $1}'
    )
    if [ "$restarted" = false ]; then
        echo -e "${YELLOW}Moonraker 当前未运行，下次启动后将显示 $SERVICE_NAME${NC}"
    fi
}

echo -e "${GREEN}安装用户: $CURRENT_USER${NC}"
echo -e "${GREEN}安装目录: $PROJECT_DIR${NC}"
echo ""

# 读取端口配置（默认9999）
read -p "请输入服务端口号 [默认: 9999]: " PORT
PORT=${PORT:-9999}
if ! [[ "$PORT" =~ ^[0-9]+$ ]] || [ "$PORT" -lt 1 ] || [ "$PORT" -gt 65535 ]; then
    echo -e "${RED}端口号必须是 1-65535 的数字${NC}"
    exit 1
fi

echo -e "${GREEN}使用端口: $PORT${NC}"
echo ""

# Fast系统: 如果脚本来自其他目录，则复制项目到 /data
if [ "$IS_FAST" = true ] && [ "$SOURCE_DIR" != "$PROJECT_DIR" ]; then
    echo "复制项目到 $PROJECT_DIR..."
    mkdir -p "$PROJECT_DIR"
    cp -a "$SOURCE_DIR/." "$PROJECT_DIR/"
fi

# 创建配置文件
echo "创建配置文件..."
mkdir -p "$PROJECT_DIR/data"
if [ ! -f "$PROJECT_DIR/data/config.json" ]; then
cat > "$PROJECT_DIR/data/config.json" << EOF
{
  "port": $PORT,
  "bind_host": "$BIND_HOST",
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
  "api_token": "",
  "require_csrf": true
}
EOF
else
    echo "配置文件已存在，跳过覆盖: $PROJECT_DIR/data/config.json"
fi

# 与 Fluidd 一样默认允许通过设备网络地址访问。升级时将旧的本机回环地址迁移为所有网卡，避免更新后仍只能本机访问。
CONFIG_PYTHON3_BIN="$(command -v python3 2>/dev/null || true)"
if [ -n "$CONFIG_PYTHON3_BIN" ] && [ -f "$PROJECT_DIR/data/config.json" ]; then
    "$CONFIG_PYTHON3_BIN" - "$PROJECT_DIR/data/config.json" "$BIND_HOST" <<'PY'
import json
import os
import sys

path, bind_host = sys.argv[1:3]
with open(path, 'r', encoding='utf-8') as stream:
    values = json.load(stream)
if not isinstance(values, dict):
    raise ValueError('config.json 必须是 JSON 对象')
if values.get('bind_host') != bind_host:
    values['bind_host'] = bind_host
    temp_path = path + '.tmp'
    with open(temp_path, 'w', encoding='utf-8') as stream:
        json.dump(values, stream, ensure_ascii=False, indent=2)
        stream.write('\n')
    os.replace(temp_path, path)
    print(f'已将服务监听地址设为 {bind_host}（所有网卡）')
PY
fi

chown "$CURRENT_USER:$CURRENT_USER" "$PROJECT_DIR/data/config.json"

# 安装依赖
echo "安装依赖..."

# 检测 Python3 路径
PYTHON3_BIN=$(which python3 2>/dev/null || echo /usr/bin/python3)
echo "Python3: $PYTHON3_BIN ($($PYTHON3_BIN --version 2>/dev/null || echo 'unknown'))"

# 尝试 apt 安装系统包（可能不可用，如 FAST 系统）
if command -v apt &>/dev/null; then
    echo "尝试 apt 安装系统包..."
    apt update 2>/dev/null || echo -e "${YELLOW}apt update 失败，跳过${NC}"
    apt install -y python3-pip python3-flask python3-flask-cors python3-paramiko python3-cryptography python3-psutil python3-requests 2>/dev/null || \
        echo -e "${YELLOW}apt 安装部分包失败，将通过 pip 补充${NC}"
else
    echo -e "${YELLOW}未检测到 apt，使用 pip 安装所有依赖${NC}"
fi

# 确保 pip3 可用
if ! command -v pip3 &>/dev/null && ! command -v pip &>/dev/null; then
    echo -e "${YELLOW}pip3 未安装，尝试安装...${NC}"
    $PYTHON3_BIN -m ensurepip --upgrade 2>/dev/null || true
    if ! command -v pip3 &>/dev/null; then
        echo -e "${RED}无法安装 pip3，请手动安装后重试${NC}"
        exit 1
    fi
fi

# 确定 pip 命令
PIP_CMD="pip3"
command -v pip3 &>/dev/null || PIP_CMD="pip"

# pip 安装依赖（FAST 系统需加 --break-system-packages 或使用 --user + 调整 PATH）
PIP_INSTALL_OPTS=""
if [ "$IS_FAST" = true ]; then
    # FAST 系统 site-packages 可能不可写，使用 --break-system-packages 强制安装到系统目录
    PIP_INSTALL_OPTS="--break-system-packages"
fi

if [ -f "$PROJECT_DIR/requirements.txt" ]; then
    echo "通过 pip 安装 requirements.txt 依赖..."
    $PIP_CMD install $PIP_INSTALL_OPTS -r "$PROJECT_DIR/requirements.txt" 2>&1 | tail -5
else
    $PIP_CMD install $PIP_INSTALL_OPTS flask flask-cors flask-sock psutil paramiko cryptography requests 2>&1 | tail -5
fi

# 验证关键包是否可导入
echo "验证依赖安装..."
$PYTHON3_BIN -c "import flask; import flask_cors; import psutil; import paramiko; import requests; print('依赖验证通过')" || {
    echo -e "${RED}依赖验证失败！请检查 pip 安装日志${NC}"
    exit 1
}

# 设置目录权限
echo "设置目录权限..."
chown -R "$CURRENT_USER:$CURRENT_USER" "$PROJECT_DIR"
chmod +x "$PROJECT_DIR/src/app.py"
chmod +x "$PROJECT_DIR/scripts"/*.sh 2>/dev/null || true

# 删除logs文件夹（如果存在）
if [ -d "$PROJECT_DIR/logs" ]; then
    echo "清理logs文件夹..."
    rm -rf "$PROJECT_DIR/logs"
fi

# Python 语法兼容性检查（Python < 3.12 不支持 f-string 内反斜杠）
echo "检查 Python 源文件语法..."
SYNTAX_OK=true
for pyfile in "$PROJECT_DIR"/src/*.py; do
    [ -f "$pyfile" ] || continue
    if ! $PYTHON3_BIN - "$pyfile" 2>/dev/null <<'PY'
import ast
import sys

with open(sys.argv[1], 'r', encoding='utf-8') as f:
    ast.parse(f.read(), filename=sys.argv[1])
PY
    then
        echo -e "${RED}语法错误: $pyfile${NC}"
        $PYTHON3_BIN -m py_compile "$pyfile" 2>&1 || true
        SYNTAX_OK=false
    fi
done
if [ "$SYNTAX_OK" = false ]; then
    echo -e "${RED}存在语法错误，请修复后重试。常见原因: Python < 3.12 不支持 f-string 内使用 \\n${NC}"
    exit 1
fi
echo "语法检查通过"

# 创建systemd服务文件
echo "创建systemd服务..."
SERVICE_FILE="/etc/systemd/system/$SERVICE_NAME.service"

cat > "$SERVICE_FILE" << EOF
[Unit]
Description=Firmware-Tool - 固件编译与烧录工具
After=network.target
Wants=network.target

[Service]
Type=simple
User=root
Group=root
WorkingDirectory=$PROJECT_DIR
ExecStart=$PYTHON3_BIN $PROJECT_DIR/src/app.py
Restart=on-failure
RestartSec=10
StandardOutput=journal
StandardError=journal

# 环境变量（含 pip --user 安装路径，确保 FAST 系统也能找到包）
Environment=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/root/.local/bin
Environment=PYTHONPATH=$PROJECT_DIR/src

[Install]
WantedBy=multi-user.target
EOF

# 重新加载systemd
systemctl daemon-reload
# 让 systemd 载入新单元，确保 Moonraker 重启后也能发现尚未启动的服务。
systemctl show "$SERVICE_NAME.service" -p LoadState --value >/dev/null 2>&1 || true
register_moonraker_service

echo ""
echo -e "${GREEN}=== 安装完成 ===${NC}"
echo ""
echo "服务名称: $SERVICE_NAME"
echo "端口号: $PORT"
echo "项目目录: $PROJECT_DIR"
echo ""
echo "常用命令:"
echo "  启动服务: sudo systemctl start $SERVICE_NAME"
echo "  停止服务: sudo systemctl stop $SERVICE_NAME"
echo "  重启服务: sudo systemctl restart $SERVICE_NAME"
echo "  查看状态: sudo systemctl status $SERVICE_NAME"
echo "  开机自启: sudo systemctl enable $SERVICE_NAME"
echo "  查看日志：sudo journalctl -u $SERVICE_NAME -f"
echo "  卸载程序：cd $PROJECT_DIR/scripts && sudo ./uninstall.sh"
echo ""
# 获取本机网卡 IP（兼容 FAST 系统的 BusyBox 命令）
LOCAL_IPS=""
if command -v ip &>/dev/null; then
    LOCAL_IPS=$(ip -4 -o addr show scope global 2>/dev/null | awk '{sub(/\/.*/, "", $4); if ($4 != "") {printf "%s%s", (n++ ? " " : ""), $4}}' || true)
fi
if [ -z "$LOCAL_IPS" ] && command -v hostname &>/dev/null; then
    LOCAL_IPS=$(hostname -I 2>/dev/null | awk '{for (i=1; i<=NF; i++) if ($i ~ /^[0-9]+(\.[0-9]+){3}$/) printf "%s%s", (n++ ? " " : ""), $i}' || true)
fi
if [ -z "$LOCAL_IPS" ] && command -v ifconfig &>/dev/null; then
    LOCAL_IPS=$(ifconfig 2>/dev/null | awk '/inet (addr:)?[0-9]/{for (i=1; i<=NF; i++) if ($i ~ /^(addr:)?[0-9]+\./) {sub(/^addr:/, "", $i); if ($i != "127.0.0.1") printf "%s%s", (n++ ? " " : ""), $i}}' || true)
fi
echo -e "${GREEN}网络监听地址: $BIND_HOST:$PORT（所有网卡）${NC}"
if [ -n "$LOCAL_IPS" ]; then
    for LOCAL_IP in $LOCAL_IPS; do
        echo -e "${GREEN}网络访问地址: http://$LOCAL_IP:$PORT${NC}"
    done
else
    echo -e "${YELLOW}未检测到网卡 IP，请使用设备实际 IP 访问: http://<IP>:$PORT${NC}"
fi
echo -e "${GREEN}本机回环地址: http://127.0.0.1:$PORT${NC}"
echo ""

# 询问是否启动服务
read -p "是否立即启动服务? (y/n): " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
    systemctl start $SERVICE_NAME
    systemctl enable $SERVICE_NAME
    echo -e "${GREEN}服务已启动并启用开机自启${NC}"
fi

reload_moonraker_service_list
