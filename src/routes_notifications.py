"""
通知系统蓝图 - 通知存储、查询、标记已读、实时推送
"""
import json
import os
import time
import threading
from collections import deque
from flask import Blueprint, jsonify, request

from shared import config, logger, BASE_DIR

notifications_bp = Blueprint('notifications', __name__)

_notifications = deque(maxlen=100)
_notif_lock = threading.Lock()
NOTIF_PATH = os.path.join(BASE_DIR, 'data', 'notifications.json')


def _load_persisted():
    if os.path.isfile(NOTIF_PATH):
        try:
            with open(NOTIF_PATH, 'r', encoding='utf-8') as f:
                items = json.load(f)
            for item in items[-100:]:
                _notifications.append(item)
        except Exception:
            pass


def _persist():
    try:
        with open(NOTIF_PATH, 'w', encoding='utf-8') as f:
            json.dump(list(_notifications), f, ensure_ascii=False, indent=2)
    except Exception:
        pass


_load_persisted()


def push_notification(notif_type, title, message='', level='info'):
    """创建通知 + 持久化 + WebSocket 广播。可从任何模块调用。"""
    notif = {
        'id': f'{int(time.time() * 1000)}',
        'type': notif_type,
        'title': title,
        'message': message,
        'level': level,
        'read': False,
        'ts': time.strftime('%Y-%m-%dT%H:%M:%S'),
    }
    with _notif_lock:
        _notifications.appendleft(notif)
        _persist()
    try:
        from websocket_manager import broadcast
        broadcast('notification', notif)
    except Exception:
        pass
    return notif


@notifications_bp.route('/api/notifications', methods=['GET'])
def list_notifications():
    with _notif_lock:
        items = list(_notifications)
    unread = sum(1 for n in items if not n.get('read'))
    return jsonify({'success': True, 'notifications': items, 'unread': unread})


@notifications_bp.route('/api/notifications/read', methods=['POST'])
def mark_read():
    data = request.get_json(silent=True) or {}
    notif_id = data.get('id', '')
    with _notif_lock:
        if notif_id:
            for n in _notifications:
                if n['id'] == notif_id:
                    n['read'] = True
                    break
        else:
            for n in _notifications:
                n['read'] = True
        _persist()
    return jsonify({'success': True})


@notifications_bp.route('/api/notifications', methods=['DELETE'])
def clear_all():
    with _notif_lock:
        _notifications.clear()
        _persist()
    return jsonify({'success': True, 'message': '通知已清空'})
