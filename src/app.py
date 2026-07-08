#!/usr/bin/env python3
"""
Firmware-Tool 主入口
Flask 应用初始化 + 蓝图注册 + 启动
"""

import os
import sys

# 确保 src 目录在 Python 路径中
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from shared import app, config, logger, BASE_DIR, PORT

# 导入蓝图
from routes_system import system_bp
from routes_firmware import firmware_bp
from routes_config import board_config_bp
from routes_settings import settings_bp
from routes_klipper import klipper_bp
from routes_update import firmware_update_bp
from routes_tools import tools_bp

# 注册蓝图
app.register_blueprint(system_bp)
app.register_blueprint(firmware_bp)
app.register_blueprint(board_config_bp)
app.register_blueprint(settings_bp)
app.register_blueprint(klipper_bp)
app.register_blueprint(firmware_update_bp)
app.register_blueprint(tools_bp)

# 启动
if __name__ == '__main__':
    os.chdir(BASE_DIR)
    bind_host = os.environ.get('FIRMWARE_TOOL_HOST') or config.get('bind_host', '0.0.0.0')
    logger.info(f"Firmware-Tool 启动在 {bind_host}:{PORT}")
    app.run(host=bind_host, port=PORT, debug=False, threaded=True)
