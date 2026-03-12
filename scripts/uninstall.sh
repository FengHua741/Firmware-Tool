#!/bin/bash

# Firmware-Tool 卸载脚本

set -e

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}=== Firmware-Tool 卸载脚本 ===${NC}"
echo ""

SERVICE_NAME="firmware-tool"
PROJECT_DIR="/home/fenghua/Firmware-Tool"

# 检查 root 权限
if [ "$EUID" -ne 0 ]; then
    echo -e "${RED}请使用 sudo 运行此脚本${NC}"
    exit 1
fi

# 停止并禁用服务
echo -e "${YELLOW}正在停止服务...${NC}"
systemctl stop $SERVICE_NAME 2>/dev/null || true
systemctl disable $SERVICE_NAME 2>/dev/null || true

# 删除 systemd 服务文件
SERVICE_FILE="/etc/systemd/system/$SERVICE_NAME.service"
if [ -f "$SERVICE_FILE" ]; then
    echo "删除 systemd 服务文件..."
    rm -f "$SERVICE_FILE"
fi

# 重新加载 systemd
systemctl daemon-reload

echo ""
read -p "是否删除项目目录 ($PROJECT_DIR)? (y/n): " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
    echo -e "${YELLOW}删除项目目录...${NC}"
    rm -rf "$PROJECT_DIR"
    echo -e "${GREEN}项目目录已删除${NC}"
else
    echo -e "${YELLOW}保留项目目录，仅卸载服务${NC}"
fi

echo ""
echo -e "${GREEN}=== 卸载完成 ===${NC}"
echo ""
echo "如需重新安装，请运行："
echo "  cd /path/to/Firmware-Tool/scripts"
echo "  ./install.sh"
echo ""
