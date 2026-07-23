// ==================== 通知系统前端 ====================
let _notifData = [];
let _notifUnread = 0;

function initNotifications() {
    loadNotifications();
    if (typeof wsOn === 'function') {
        wsOn('notification', (notif) => {
            _notifData.unshift(notif);
            if (_notifData.length > 100) _notifData.pop();
            _notifUnread++;
            renderNotifBadge();
            renderNotifList();
        });
    }
}

async function loadNotifications() {
    try {
        const resp = await fetch('/api/notifications');
        const data = await resp.json();
        if (data.success) {
            _notifData = data.notifications || [];
            _notifUnread = data.unread || 0;
            renderNotifBadge();
            renderNotifList();
        }
    } catch (e) {}
}

function renderNotifBadge() {
    const badge = document.getElementById('notifBadge');
    if (!badge) return;
    if (_notifUnread > 0) {
        badge.style.display = 'inline-flex';
        badge.textContent = _notifUnread > 99 ? '99+' : _notifUnread;
    } else {
        badge.style.display = 'none';
    }
}

function toggleNotificationPanel() {
    const panel = document.getElementById('notificationPanel');
    if (!panel) return;
    const visible = panel.style.display !== 'none';
    panel.style.display = visible ? 'none' : 'block';
    if (!visible) renderNotifList();
}

function renderNotifList() {
    const list = document.getElementById('notifList');
    if (!list) return;
    if (_notifData.length === 0) {
        list.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-secondary);font-size:13px;">暂无通知</div>';
        return;
    }
    const icons = {
        compile_complete: '🔨', flash_complete: '✅', flash_failed: '❌',
        ssh_disconnected: '🔌', backup_created: '💾', service_stopped: '⚠️',
    };
    const colors = { success: 'var(--success-color)', error: 'var(--danger-color)', warning: 'var(--warning-color)', info: 'var(--primary-color)' };
    list.innerHTML = _notifData.slice(0, 30).map(n => `
        <div class="notif-item ${n.read ? '' : 'unread'}" style="border-left:3px solid ${colors[n.level] || colors.info}">
            <div style="display:flex;align-items:center;gap:6px;">
                <span>${icons[n.type] || '📢'}</span>
                <strong style="font-size:13px;">${escHtml(n.title)}</strong>
                <span style="margin-left:auto;font-size:11px;color:var(--text-secondary);">${escHtml(n.ts)}</span>
            </div>
            ${n.message ? `<div style="font-size:12px;color:var(--text-secondary);margin-top:2px;">${escHtml(n.message)}</div>` : ''}
        </div>
    `).join('');
}

function escHtml(s) {
    const d = document.createElement('div');
    d.textContent = s || '';
    return d.innerHTML;
}

async function markAllNotifRead() {
    try {
        const resp = await fetch('/api/notifications/read', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: '{}' });
        if (!resp.ok) return;
        _notifData.forEach(n => n.read = true);
        _notifUnread = 0;
        renderNotifBadge();
        renderNotifList();
    } catch (e) {}
}

async function clearAllNotif() {
    try {
        const resp = await fetch('/api/notifications', { method: 'DELETE' });
        if (!resp.ok) return;
        _notifData = [];
        _notifUnread = 0;
        renderNotifBadge();
        renderNotifList();
    } catch (e) {}
}

document.addEventListener('DOMContentLoaded', initNotifications);
