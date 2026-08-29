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
MOONRAKER_ASVC_UPDATED=false
MOONRAKER_ASVC_FILES=()

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

unregister_moonraker_service() {
    local asvc_file
    local temp_file

    discover_moonraker_asvc_files
    for asvc_file in "${MOONRAKER_ASVC_FILES[@]}"; do
        grep -Fqx "$SERVICE_NAME" "$asvc_file" || continue
        temp_file=$(mktemp)
        awk -v service="$SERVICE_NAME" '$0 != service' "$asvc_file" > "$temp_file"
        # 覆盖原文件内容而不替换 inode，以保留 Moonraker 文件的属主和权限。
        command cat "$temp_file" > "$asvc_file"
        rm -f "$temp_file"
        MOONRAKER_ASVC_UPDATED=true
        echo -e "${GREEN}已从 Fluidd/Mainsail 服务列表移除: $asvc_file${NC}"
    done
}

reload_moonraker_service_list() {
    local moonraker_unit

    [ "$MOONRAKER_ASVC_UPDATED" = true ] || return 0
    while IFS= read -r moonraker_unit; do
        [ -n "$moonraker_unit" ] || continue
        systemctl restart "$moonraker_unit"
        echo -e "${GREEN}已重启 $moonraker_unit，Fluidd/Mainsail 服务列表已刷新${NC}"
    done < <(
        systemctl list-units --all --type=service --plain --no-legend 2>/dev/null |
            awk '$1 ~ /^moonraker([_-]?[0-9]+)?\.service$/ && $3 == "active" {print $1}'
    )
}

# 从脚本位置推断项目目录
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# 检查 root 权限
if [ "$EUID" -ne 0 ]; then
    echo -e "${RED}请使用 sudo 运行此脚本${NC}"
    exit 1
fi

# 停止并禁用服务
echo -e "${YELLOW}正在停止服务...${NC}"
systemctl stop "$SERVICE_NAME" 2>/dev/null || true
systemctl disable "$SERVICE_NAME" 2>/dev/null || true

# 删除 systemd 服务文件
SERVICE_FILE="/etc/systemd/system/$SERVICE_NAME.service"
if [ -f "$SERVICE_FILE" ]; then
    echo "删除 systemd 服务文件..."
    rm -f "$SERVICE_FILE"
fi

# 重新加载 systemd
systemctl daemon-reload
unregister_moonraker_service
reload_moonraker_service_list

echo ""
read -p "是否删除项目目录 ($PROJECT_DIR)? (y/n): " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
    case "$PROJECT_DIR" in
        ""|"/"|"/home"|"/root"|"/data")
            echo -e "${RED}拒绝删除危险目录: $PROJECT_DIR${NC}"
            exit 1
            ;;
    esac
    if [ ! -f "$PROJECT_DIR/src/app.py" ] || [ ! -d "$PROJECT_DIR/scripts" ]; then
        echo -e "${RED}目录不像 Firmware-Tool 项目，已停止删除: $PROJECT_DIR${NC}"
        exit 1
    fi
    if [ -L "$PROJECT_DIR" ]; then
        echo -e "${RED}拒绝删除符号链接目录: $PROJECT_DIR${NC}"
        exit 1
    fi
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
