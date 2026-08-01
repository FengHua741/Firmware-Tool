"""
WebSocket 全局事件总线 - 跨页面推送通知
"""
import json
import time
import threading
import logging
from urllib.parse import urlsplit

logger = logging.getLogger(__name__)

sock = None
_clients = []
_clients_lock = threading.Lock()


def _origin_allowed(environ):
    """校验 WebSocket 握手 Origin 与 Host 同源；无 Origin（非浏览器客户端）拒绝。

    浏览器 WebSocket 握手会自动携带 Origin 头，跨站页面无法伪造同源 Origin。
    """
    origin = environ.get('HTTP_ORIGIN', '')
    if not origin:
        return False
    host = environ.get('HTTP_HOST', '')
    try:
        parsed = urlsplit(origin)
        if parsed.hostname and parsed.netloc.lower() == host.lower():
            return True
    except ValueError:
        pass
    return False


def init_websocket(app):
    global sock
    try:
        from flask_sock import Sock
        sock = Sock(app)

        @sock.route('/ws')
        def ws_endpoint(ws):
            environ = getattr(ws, 'environ', {}) or {}
            if not _origin_allowed(environ):
                logger.warning("WebSocket 连接被拒绝（Origin 校验失败）")
                try:
                    ws.close()
                except Exception:
                    pass
                return
            with _clients_lock:
                _clients.append(ws)
            try:
                while True:
                    data = ws.receive(timeout=120)
                    if data is None:
                        break
            except Exception:
                pass
            finally:
                with _clients_lock:
                    if ws in _clients:
                        _clients.remove(ws)

        logger.info("WebSocket 事件总线已初始化")
    except ImportError:
        logger.warning("flask-sock 未安装，WebSocket 功能不可用")


def broadcast(event_type, payload=None):
    """线程安全广播，可从任何路由或后台线程调用"""
    msg = json.dumps({
        'type': event_type,
        'data': payload or {},
        'ts': time.time()
    }, ensure_ascii=False)
    dead = []
    with _clients_lock:
        for ws in _clients:
            try:
                ws.send(msg)
            except Exception:
                dead.append(ws)
        for ws in dead:
            _clients.remove(ws)
