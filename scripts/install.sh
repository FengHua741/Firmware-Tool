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
    SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
    
    # 检查root权限
    if [ "$EUID" -ne 0 ]; then
        echo -e "${RED}请使用sudo运行此脚本${NC}"
        exit 1
    fi
    
    # 获取当前用户（非root）
    CURRENT_USER=${SUDO_USER:-$USER}
    if [ "$CURRENT_USER" = "root" ]; then
        echo -e "${YELLOW}警告: 当前用户为root，建议使用普通用户运行${NC}"
        CURRENT_USER="fenghua"
    fi
fi

SERVICE_NAME="firmware-tool"

echo -e "${GREEN}安装用户: $CURRENT_USER${NC}"
echo -e "${GREEN}安装目录: $PROJECT_DIR${NC}"
echo ""

# 读取端口配置（默认9999）
read -p "请输入服务端口号 [默认: 9999]: " PORT
PORT=${PORT:-9999}

echo -e "${GREEN}使用端口: $PORT${NC}"
echo ""

# Fast系统: 如果当前目录不是PROJECT_DIR，则复制项目
if [ "$IS_FAST" = true ] && [ "$(pwd)" != "$PROJECT_DIR" ]; then
    echo "复制项目到 $PROJECT_DIR..."
    mkdir -p "$PROJECT_DIR"
    cp -r "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"/* "$PROJECT_DIR/"
fi

# 创建配置文件
echo "创建配置文件..."
cat > "$PROJECT_DIR/config.json" << EOF
{
  "port": $PORT,
  "klipper_path": "~/klipper",
  "json_repo_url": "",
  "last_json_update": null
}
EOF

chown $CURRENT_USER:$CURRENT_USER "$PROJECT_DIR/config.json"

# 设置目录权限
echo "设置目录权限..."
chown -R $CURRENT_USER:$CURRENT_USER "$PROJECT_DIR"
chmod +x "$PROJECT_DIR/app.py"
chmod +x "$SCRIPT_DIR"/*.sh 2>/dev/null || true

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
User=$CURRENT_USER
Group=$CURRENT_USER
WorkingDirectory=$PROJECT_DIR
ExecStart=/usr/bin/python3 $PROJECT_DIR/app.py
Restart=on-failure
RestartSec=10
StandardOutput=journal
StandardError=journal

# 环境变量
Environment=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
Environment=PYTHONPATH=$PROJECT_DIR

[Install]
WantedBy=multi-user.target
EOF

# 重新加载systemd
systemctl daemon-reload

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
echo "  查看日志: sudo journalctl -u $SERVICE_NAME -f"
echo ""
echo -e "${GREEN}访问地址: http://$(hostname -I | awk '{print $1}'):$PORT${NC}"
echo ""

# 询问是否启动服务
read -p "是否立即启动服务? (y/n): " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
    systemctl start $SERVICE_NAME
    systemctl enable $SERVICE_NAME
    echo -e "${GREEN}服务已启动并启用开机自启${NC}"
fi
