// 全局状态
let currentPage = 'resources';
let boardConfigs = {};
let selectedBoard = null;
let compileInProgress = false;
let flashInProgress = false;
let blFlashInProgress = false;
let detectedDevices = [];
let compileParams = {
    manufacturer: '',
    boardType: '',
    boardModel: ''
};

// 可选 API Token：访问 /?token=xxx 后写入本地存储，后续 fetch 自动带上请求头。
(function setupApiTokenFetch() {
    function getStoredToken() {
        try {
            return localStorage.getItem('firmwareToolApiToken') || '';
        } catch (error) {
            return '';
        }
    }
    function setStoredToken(token) {
        try {
            localStorage.setItem('firmwareToolApiToken', token);
        } catch (error) {
            console.warn('API Token 无法写入本地存储:', error);
        }
    }
    const params = new URLSearchParams(window.location.search);
    const tokenFromUrl = params.get('token');
    if (tokenFromUrl) {
        setStoredToken(tokenFromUrl);
        params.delete('token');
        const cleanQuery = params.toString();
        const cleanUrl = `${window.location.pathname}${cleanQuery ? `?${cleanQuery}` : ''}${window.location.hash}`;
        window.history.replaceState({}, document.title, cleanUrl);
    }
    function readCookie(name) {
        const prefix = `${name}=`;
        const found = document.cookie.split(';').map(v => v.trim()).find(v => v.startsWith(prefix));
        try {
            return found ? decodeURIComponent(found.slice(prefix.length)) : '';
        } catch (error) {
            return '';
        }
    }
    const originalFetch = window.fetch.bind(window);
    window.fetch = function(resource, options = {}) {
        const apiToken = getStoredToken();
        const headers = new Headers(options.headers || (resource instanceof Request ? resource.headers : undefined));
        if (apiToken) headers.set('X-API-Token', apiToken);
        const csrf = readCookie('firmware_tool_csrf');
        if (csrf) headers.set('X-CSRF-Token', csrf);
        return originalFetch(resource, { ...options, headers });
    };
})();

// ==================== 主题管理 ====================
function initTheme() {
    const saved = localStorage.getItem('firmwareToolTheme');
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const theme = saved || (prefersDark ? 'dark' : 'light');
    document.documentElement.setAttribute('data-theme', theme);
    updateThemeIcon(theme);
}
function toggleTheme() {
    const current = document.documentElement.getAttribute('data-theme');
    const next = current === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('firmwareToolTheme', next);
    updateThemeIcon(next);
}
function updateThemeIcon(theme) {
    const icon = document.querySelector('#themeToggle i');
    if (icon) icon.className = theme === 'dark' ? 'fas fa-sun' : 'fas fa-moon';
}
initTheme();

// ==================== WebSocket 全局事件总线 ====================
let _ws = null;
let _wsReconnectTimer = null;
const _wsListeners = {};

function wsConnect() {
    if (_wsReconnectTimer) { clearTimeout(_wsReconnectTimer); _wsReconnectTimer = null; }
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    try {
        _ws = new WebSocket(`${proto}//${location.host}/ws`);
        _ws.onmessage = (e) => {
            try {
                const msg = JSON.parse(e.data);
                wsDispatch(msg.type, msg.data);
            } catch (err) {}
        };
        _ws.onclose = () => {
            _wsReconnectTimer = setTimeout(wsConnect, 3000);
        };
        _ws.onerror = () => { if (_ws) _ws.close(); };
    } catch (e) {
        _wsReconnectTimer = setTimeout(wsConnect, 5000);
    }
}

function wsDispatch(type, data) {
    if (type === 'compile_complete') showSuccess(t('toast.compile_done'));
    if (type === 'flash_complete') showSuccess(t('toast.flash_done'));
    if (type === 'flash_failed') showError(t('toast.flash_failed'));
    (_wsListeners[type] || []).forEach(fn => { try { fn(data); } catch(e) {} });
}

function wsOn(type, fn) {
    if (!_wsListeners[type]) _wsListeners[type] = [];
    _wsListeners[type].push(fn);
}

// ==================== 页面切换 ====================
function switchPage(pageId) {
    currentPage = pageId;

    // 更新导航
    document.querySelectorAll('.nav-item').forEach(item => {
        item.classList.remove('active');
        if (item.dataset.page === pageId) {
            item.classList.add('active');
        }
    });

    // 更新页面
    document.querySelectorAll('.page').forEach(page => {
        page.classList.remove('active');
    });
    document.getElementById(`page-${pageId}`).classList.add('active');

    // 离开资源页面时停止轮询
    if (pageId !== 'resources' && resourceInterval) {
        clearInterval(resourceInterval);
        resourceInterval = null;
    }

    // 页面特定初始化
    if (pageId === 'resources') {
        startResourceMonitoring();
        loadCanHostConfig();
    } else if (pageId === 'firmware') {
        if (typeof initFirmwarePage === 'function') {
            initFirmwarePage();
        }
    } else if (pageId === 'firmware-update') {
        if (typeof initFirmwareUpdatePage === 'function') {
            initFirmwareUpdatePage();
        }
    } else if (pageId === 'config') {
        if (typeof initConfigManager === 'function') {
            initConfigManager();
        }
        loadBackupList();
        loadBackupSettings();
    } else if (pageId === 'settings') {
        loadSettings();
        loadVersionInfo();
        loadAvailableServices();
    } else if (pageId === 'klipper-parser') {
        if (typeof initKlipperParser === 'function') {
            initKlipperParser();
        }
    } else if (pageId === 'config-generator') {
        if (typeof initConfigGenerator === 'function') {
            initConfigGenerator();
        }
    }
}

// 绑定导航点击事件
document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', (e) => {
        e.preventDefault();
        switchPage(item.dataset.page);
    });
});

// ==================== 系统资源监控 ====================
let resourceInterval = null;

function startResourceMonitoring() {
    updateResources();
    if (resourceInterval) clearInterval(resourceInterval);
    resourceInterval = setInterval(updateResources, 1000);
}

// 更新进度条填充（带 2% 迟滞防止闪烁）
function setProgressFill(elementId, percent) {
    const el = document.getElementById(elementId);
    if (!el) return;

    el.style.width = Math.min(percent, 100) + '%';

    // 获取当前颜色类
    const prevClass = el.dataset.prevColor || 'green';
    let newClass;
    if (percent >= 90) {
        newClass = 'red';
    } else if (percent >= 70) {
        newClass = 'yellow';
    } else {
        newClass = 'green';
    }

    // 2% 迟滞：只有当变化超过阈值时才切换
    if (newClass !== prevClass) {
        const threshold = newClass === 'green' ? 68 : (newClass === 'yellow' ? 70 : 88);
        const diff = Math.abs(percent - threshold);
        if (diff > 2) {
            el.classList.remove('green', 'yellow', 'red');
            el.classList.add(newClass);
            el.dataset.prevColor = newClass;
        }
    }
}

function updateNetworkDisplay(network) {
    const container = document.getElementById('networkInterfaces');

    if (network && network.interfaces && network.interfaces.length > 0) {
        let html = '<div class="network-list">';
        network.interfaces.forEach(iface => {
            html += `
                <div class="network-item">
                    <span class="network-name">${escapeHtml(iface.name)}</span>
                    <span class="network-ips">${escapeHtml((iface.ips || []).join(', '))}</span>
                </div>
            `;
        });
        html += '</div>';
        container.innerHTML = html;
    } else {
        container.innerHTML = '<p class="empty">未检测到网络接口</p>';
    }
}

// ==================== 设备搜索 ====================

// 串口设备搜索
async function searchSerial() {
    const container = document.getElementById('serialDevices');
    container.innerHTML = '<p class="empty">搜索中...</p>';
    try {
        const response = await fetch('/api/system/serial');
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        if (data.devices && data.devices.length > 0) {
            container.innerHTML = data.devices.map(d => {
                const info = [d.model, d.vendor].filter(Boolean).join(' - ');
                const ids = [d.vid, d.pid].filter(Boolean).join(':');
                // 使用后端推荐的 display_path（USB虚拟串口用 by-id，USB转串口用 by-path）
                const displayVal = d.display_path || d.by_id || d.path;
                const copyVal = escapeJsString(displayVal);
                return `
                    <div class="id-item" style="flex-direction:column;align-items:flex-start;">
                        <div style="display:flex;justify-content:space-between;width:100%;align-items:center;">
                            <span class="id-text" style="font-weight:600;">${escapeHtml(displayVal)}</span>
                            <button class="btn btn-sm btn-secondary" onclick="copyToClipboard('${copyVal}')">复制</button>
                        </div>
                        <div style="font-size:11px;color:#888;margin-top:3px;">
                            ${escapeHtml(info ? info : '')}${ids ? ' [' + escapeHtml(ids) + ']' : ''}${d.driver ? ' (' + escapeHtml(d.driver) + ')' : ''}
                        </div>
                    </div>`;
            }).join('');
        } else {
            container.innerHTML = '<p class="empty">未找到串口设备</p>';
        }
    } catch (error) {
        container.innerHTML = `<p class="empty">搜索失败: ${escapeHtml(error.message)}</p>`;
    }
}

// CAN接口刷新
async function refreshCanIfaces() {
    const select = document.getElementById('canIfaceSelect');
    select.innerHTML = '<option value="">加载中...</option>';
    try {
        const response = await fetch('/api/system/can-iface');
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        select.innerHTML = '<option value="">选择CAN接口</option>';
        if (data.ifaces && data.ifaces.length > 0) {
            const opts = data.ifaces.map(iface => {
                const state = iface.operstate === 'UP' ? '✅' : '⚠️';
                return `<option value="${escapeHtml(iface.ifname)}">${state} ${escapeHtml(iface.ifname)} (${escapeHtml(iface.operstate)})</option>`;
            }).join('');
            select.innerHTML = '<option value="">选择CAN接口</option>' + opts;
            if (data.ifaces.length === 1) select.selectedIndex = 1;
        } else {
            select.innerHTML = '<option value="">选择CAN接口</option><option value="" disabled>未找到CAN接口</option>';
        }
    } catch (error) {
        select.innerHTML = '<option value="">加载失败</option>';
    }
}

// CAN 网络诊断
async function diagnoseCanNetwork() {
    const container = document.getElementById('canDevices');
    const errDiv = document.getElementById('canSearchError');
    if (errDiv) errDiv.style.display = 'none';

    container.innerHTML = '<p class="empty">正在诊断CAN网络...</p>';
    try {
        const response = await fetch('/api/system/can-diagnose');
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();

        let html = '<div style="font-size:13px;line-height:1.8;">';
        html += '<h4 style="margin:0 0 8px 0;color:#333;">CAN 网络诊断结果</h4>';

        html += `<div>内核CAN支持: <b>${data.kernel_support ? '✅ 支持' : '❌ 不支持'}</b></div>`;
        html += `<div>CAN硬件设备: <b>${data.can_device_exists ? '✅ 已检测到' : '❌ 未检测到'}</b></div>`;
        if (data.can_device_info) {
            html += `<div style="font-size:11px;color:#666;margin-left:12px;">${escapeHtml(data.can_device_info)}</div>`;
        }

        html += `<div>can0接口: <b>${data.can0_exists ? '✅ 存在' : '❌ 不存在'}</b></div>`;
        if (data.can0_state) {
            const stateColor = data.can0_state === 'UP' ? '#4caf50' : '#ff9800';
            html += `<div style="margin-left:12px;">状态: <span style="color:${stateColor};font-weight:600;">${escapeHtml(data.can0_state)}</span></div>`;
        }
        if (data.can0_bitrate) {
            html += `<div style="margin-left:12px;font-size:11px;color:#666;">${escapeHtml(data.can0_bitrate)}</div>`;
        }

        if (data.errors && data.errors.length > 0) {
            html += '<div style="margin-top:8px;color:#d32f2f;">';
            html += data.errors.map(e => `<div>❌ ${escapeHtml(e)}</div>`).join('');
            html += '</div>';
        }

        html += '</div>';
        container.innerHTML = html;
    } catch (error) {
        container.innerHTML = `<p class="empty">诊断失败: ${escapeHtml(error.message)}</p>`;
    }
}

// CAN UUID搜索
async function searchCanUuid() {
    const select = document.getElementById('canIfaceSelect');
    const container = document.getElementById('canDevices');
    const errDiv = document.getElementById('canSearchError');
    if (errDiv) errDiv.style.display = 'none';

    if (!select.value) {
        await refreshCanIfaces();
        if (!select.value) {
            container.innerHTML = '<p class="empty">请先选择CAN接口</p>';
            return;
        }
    }
    container.innerHTML = '<p class="empty">搜索中...</p>';
    try {
        const response = await fetch('/api/system/can-uuid', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ iface: select.value })
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        if (data.uuids && data.uuids.length > 0) {
            let html = '';
            // printer.cfg 来源时显示说明
            if (data.source === 'printer_cfg') {
                html += '<div style="margin-bottom:10px;font-size:12px;color:#666;background:#f5f5f5;padding:6px 10px;border-radius:4px;">以下设备来自 Klipper 配置文件 (printer.cfg)</div>';
                // 显示连接状态验证结果
                if (data.verified === false) {
                    html += '<div style="margin-bottom:8px;font-size:12px;color:#856404;background:#fff3cd;padding:6px 10px;border-radius:4px;">⚠ Moonraker 不可达，无法验证设备连接状态</div>';
                } else if (data.skipped > 0) {
                    html += `<div style="margin-bottom:8px;font-size:12px;color:#856404;background:#fff3cd;padding:6px 10px;border-radius:4px;">ℹ ${data.skipped} 个配置文件中的设备未连接，已自动过滤</div>`;
                }
            }
            html += data.uuids.map(d => {
                const appDisplay = d.app === 'Unknown' ? '未知' : d.app;
                const appColor = d.app === 'Klipper' ? '#4caf50' : d.app === 'Katapult' ? '#ff9800' : d.app === 'Klipper (config)' ? '#1976d2' : '#999';
                // 从 mcu_model 提取可读型号（如 stm32f407xx → STM32F407）
                const mcuLabel = d.mcu_model ? ` / ${String(d.mcu_model).toUpperCase()}` : '';
                const freqLabel = d.mcu_freq ? ` @ ${d.mcu_freq}` : '';
                const versionLabel = d.mcu_version ? ` / ${d.mcu_version}` : '';
                const uuid = escapeHtml(d.uuid);
                return `
                <div class="id-item">
                    <span class="id-text">
                        <span style="font-weight:600;">${uuid}</span>
                        <span style="font-size:11px;color:${appColor};margin-left:8px;">[${escapeHtml(appDisplay + mcuLabel + freqLabel + versionLabel)}]</span>
                        ${d.section ? `<span style="font-size:11px;color:#666;margin-left:6px;">${escapeHtml(d.section)}</span>` : ''}
                    </span>
                    <button class="btn btn-sm btn-secondary" onclick="copyToClipboard('${escapeJsString(d.uuid)}')">复制</button>
                </div>
            `}).join('');
            container.innerHTML = html;
        } else {
            container.innerHTML = '<p class="empty">未找到CAN设备</p>';
            if (data.error && errDiv) {
                errDiv.style.display = 'block';
                errDiv.innerHTML = `<div style="background:#fff3cd;padding:10px;border-radius:6px;border-left:4px solid #ffc107;margin-top:8px;font-size:13px;color:#856404;">⚠️ ${escapeHtml(data.error)}</div>`;
            }
        }
    } catch (error) {
        container.innerHTML = `<p class="empty">搜索失败: ${escapeHtml(error.message)}</p>`;
    }
}

// 摄像头搜索
async function searchCamera() {
    const container = document.getElementById('cameraDevices');
    container.innerHTML = '<p class="empty">搜索中...</p>';
    try {
        const response = await fetch('/api/system/video');
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        if (data.videos && data.videos.length > 0) {
            container.innerHTML = data.videos.map(d => {
                const copyVal = escapeJsString(d.path);
                return `
                    <div class="id-item">
                        <span class="id-text">
                            <span style="font-weight:600;">${escapeHtml(d.path)}</span>
                            <span style="font-size:11px;color:#666;margin-left:8px;">${escapeHtml(d.name)}${d.index ? ' (index:' + escapeHtml(d.index) + ')' : ''}</span>
                        </span>
                        <button class="btn btn-sm btn-secondary" onclick="copyToClipboard('${copyVal}')">复制</button>
                    </div>`;
            }).join('');
        } else {
            container.innerHTML = '<p class="empty">未找到摄像头</p>';
        }
    } catch (error) {
        container.innerHTML = `<p class="empty">搜索失败: ${escapeHtml(error.message)}</p>`;
    }
}

// ==================== 上位机 CAN 配置 ====================

function formatBitrate(val) {
    if (val === 1000000) return '1M';
    if (val === 500000) return '500K';
    if (val === 250000) return '250K';
    if (val >= 1000000) return (val / 1000000) + 'M';
    if (val >= 1000) return (val / 1000) + 'K';
    return String(val);
}

async function loadCanHostConfig() {
    const body = document.getElementById('canHostConfigBody');
    if (!body) return;
    body.innerHTML = '<p class="empty">加载中...</p>';

    try {
        const res = await fetch('/api/system/can-config');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();

        let html = '';

        if (data.system === 'flyos_fast') {
            // FlyOS-FAST: 可编辑 canbus_bitrate
            const liveBitrate = data.live && data.live.bitrate ? formatBitrate(data.live.bitrate) : '--';
            const liveState = data.live && data.live.exists ? (data.live.state || '--') : '--';
            const cfgBitrate = data.bitrate || 1000000;
            const bitrateOptions = [1000000, 500000, 250000];
            const bitrateLabels = { 1000000: '1M', 500000: '500K', 250000: '250K' };

            html = `
                <div style="padding:4px 0;">
                    <div style="background:rgba(33,150,243,0.08);padding:12px;border-radius:6px;border-left:4px solid #2196F3;margin-bottom:12px;font-size:13px;">
                        FlyOS-Fast 系统，CAN 速率通过 /config/config.txt 配置
                    </div>
                    <div class="status-info" style="margin-bottom:12px;">
                        <div style="display:flex;gap:20px;flex-wrap:wrap;font-size:13px;">
                            <span>接口状态: <strong>${liveState}</strong></span>
                            <span>实际速率: <strong>${liveBitrate}</strong></span>
                        </div>
                    </div>

                    <div class="form-row">
                        <div class="form-group">
                            <label class="form-label">CAN 速率 (canbus_bitrate)</label>
                            <select class="form-control form-select" id="canHostRate" style="min-width:140px;">
                                ${bitrateOptions.map(v => `
                                    <option value="${v}" ${v === cfgBitrate ? 'selected' : ''}>${bitrateLabels[v]}</option>
                                `).join('')}
                            </select>
                        </div>
                    </div>

                    <button class="btn btn-sm btn-primary" onclick="applyCanHostConfig()">应用修改</button>
                    <div id="canHostApplyStatus" style="margin-top:8px;"></div>

                    <div style="margin-top:12px;font-size:12px;color:#888;padding:8px;background:var(--bg-color);border-radius:4px;">
                        修改后会同时更新 /config/config.txt 并重启 CAN 接口，上位机速率必须与工具板固件的 CAN 速率一致
                    </div>
                </div>`;
        } else if (data.system === 'systemd' || data.system === 'interfaces') {
            // 已配置: 可编辑
            const liveState = data.live && data.live.exists ? (data.live.state || '--') : '不存在';
            const liveBitrate = data.live && data.live.bitrate ? formatBitrate(data.live.bitrate) : '--';
            const cfgBitrate = data.bitrate_display || '--';
            const cfgTxqueue = data.txqueuelen || '1024';
            const configLabel = data.system === 'systemd' ? 'systemd-networkd' : 'interfaces.d';
            const configFile = data.network_file || data.interfaces_file || '--';

            const bitrateOptions = [1000000, 500000, 250000];
            const bitrateLabels = { 1000000: '1M', 500000: '500K', 250000: '250K' };
            const currentBitrate = data.bitrate || 1000000;

            html = `
                <div style="padding:4px 0;">
                    <div style="display:flex;gap:16px;flex-wrap:wrap;margin-bottom:12px;font-size:13px;">
                        <span>配置方式: <strong>${configLabel}</strong></span>
                        <span style="color:#666;font-size:12px;">${configFile}</span>
                    </div>
                    <div style="background:rgba(76,175,80,0.06);padding:10px 14px;border-radius:6px;border-left:4px solid #4caf50;margin-bottom:14px;font-size:13px;display:flex;gap:20px;flex-wrap:wrap;">
                        <span>接口: <strong>${escapeHtml(data.live && data.live.interface || 'can0')}</strong></span>
                        <span>状态: <strong>${liveState}</strong></span>
                        <span>实际速率: <strong>${liveBitrate}</strong></span>
                    </div>

                    <div class="form-row">
                        <div class="form-group">
                            <label class="form-label">修改速率</label>
                            <select class="form-control form-select" id="canHostRate" style="min-width:140px;">
                                ${bitrateOptions.map(v => `
                                    <option value="${v}" ${v === currentBitrate ? 'selected' : ''}>${bitrateLabels[v]}</option>
                                `).join('')}
                            </select>
                        </div>
                        <div class="form-group">
                            <label class="form-label">缓存大小 (TxQueueLen)</label>
                            <input type="number" class="form-control" id="canHostTxqueue" value="${cfgTxqueue}" min="128" max="8192" style="max-width:140px;">
                            <span class="form-hint">范围: 128-8192</span>
                        </div>
                    </div>

                    <button class="btn btn-sm btn-primary" onclick="applyCanHostConfig()">应用修改</button>
                    <div id="canHostApplyStatus" style="margin-top:8px;"></div>

                    <div style="margin-top:12px;font-size:12px;color:#888;padding:8px;background:var(--bg-color);border-radius:4px;">
                        上位机 CAN 速率必须与工具板固件的 CAN 速率一致
                    </div>
                </div>`;
        } else {
            // 无配置: 自动生成
            const liveExists = data.live && data.live.exists;
            const liveState = data.live && data.live.state ? data.live.state : 'DOWN';
            const liveDetail = liveExists ? `can0 (${liveState})` : '无 CAN 接口';
            const usbInfo = data.usb_can_count > 0 ? `检测到 ${data.usb_can_count} 个 USB CAN 适配器` : '未检测到 USB CAN 适配器';

            html = `
                <div style="padding:4px 0;">
                    <div style="background:rgba(255,152,0,0.08);padding:12px;border-radius:6px;border-left:4px solid #ff9800;margin-bottom:12px;font-size:13px;">
                        未检测到 CAN 配置文件
                        <div style="margin-top:4px;font-size:12px;color:#666;">${usbInfo} | 接口: ${liveDetail}</div>
                    </div>

                    <div class="form-row">
                        <div class="form-group">
                            <label class="form-label">选择速率</label>
                            <select class="form-control form-select" id="canHostRate" style="min-width:140px;">
                                <option value="1000000" selected>1M</option>
                                <option value="500000">500K</option>
                                <option value="250000">250K</option>
                            </select>
                        </div>
                        <div class="form-group">
                            <label class="form-label">缓存大小 (TxQueueLen)</label>
                            <input type="number" class="form-control" id="canHostTxqueue" value="1024" min="128" max="8192" style="max-width:140px;">
                            <span class="form-hint">范围: 128-8192</span>
                        </div>
                    </div>

                    <button class="btn btn-sm btn-success" onclick="applyCanHostConfig()">生成并应用配置</button>
                    <div id="canHostApplyStatus" style="margin-top:8px;"></div>
                </div>`;
        }

        body.innerHTML = html;
    } catch (error) {
        body.innerHTML = `<p class="empty">加载失败: ${escapeHtml(error.message)}</p>`;
    }
}

async function applyCanHostConfig() {
    const statusDiv = document.getElementById('canHostApplyStatus');
    if (!statusDiv) return;

    const rateSelect = document.getElementById('canHostRate');
    const txqueueInput = document.getElementById('canHostTxqueue');

    if (!rateSelect) return;

    const bitrate = parseInt(rateSelect.value);
    // FlyOS-Fast 模式没有 txqueueInput，默认为 1024
    const txqueuelen = txqueueInput ? parseInt(txqueueInput.value) : 1024;

    if (txqueueInput && (isNaN(txqueuelen) || txqueuelen < 128 || txqueuelen > 8192)) {
        statusDiv.innerHTML = '<div class="status-area show" style="display:block;background:rgba(244,67,54,0.1);color:#d32f2f;border:1px solid rgba(244,67,54,0.3);padding:10px;border-radius:6px;font-size:13px;">缓存大小必须在 128-8192 之间</div>';
        return;
    }

    statusDiv.innerHTML = '<div style="padding:10px;font-size:13px;color:#666;">正在应用...</div>';

    try {
        const res = await fetch('/api/system/can-config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ bitrate, txqueuelen })
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();

        if (data.success) {
            statusDiv.innerHTML = `<div class="status-area show" style="display:block;background:rgba(76,175,80,0.1);color:#4caf50;border:1px solid rgba(76,175,80,0.3);padding:10px;border-radius:6px;font-size:13px;">${escapeHtml(data.message)}</div>`;
            // 刷新状态
            setTimeout(loadCanHostConfig, 1500);
        } else {
            statusDiv.innerHTML = `<div class="status-area show" style="display:block;background:rgba(244,67,54,0.1);color:#d32f2f;border:1px solid rgba(244,67,54,0.3);padding:10px;border-radius:6px;font-size:13px;">${escapeHtml(data.error || '应用失败')}</div>`;
        }
    } catch (error) {
        statusDiv.innerHTML = `<div class="status-area show" style="display:block;background:rgba(244,67,54,0.1);color:#d32f2f;border:1px solid rgba(244,67,54,0.3);padding:10px;border-radius:6px;font-size:13px;">请求失败: ${escapeHtml(error.message)}</div>`;
    }
}

async function searchLsusb() {
    const filter = document.getElementById('lsusbFilter').value.trim();
    const container = document.getElementById('lsusbDevices');
    container.innerHTML = '<p class="empty">搜索中...</p>';
    try {
        const url = filter ? `/api/system/lsusb?search=${encodeURIComponent(filter)}` : '/api/system/lsusb';
        const response = await fetch(url);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        if (data.devices && data.devices.length > 0) {
            container.innerHTML = data.devices.map(d => `
                <div class="id-item">
                    <span class="id-text" style="font-size:12px;">${escapeHtml(d.formatted || d.name)}</span>
                    <button class="btn btn-sm btn-secondary" onclick="copyToClipboard('${escapeJsString(d.formatted || d.name)}')">复制</button>
                </div>
            `).join('');
        } else {
            container.innerHTML = '<p class="empty">未找到设备</p>';
        }
    } catch (error) {
        container.innerHTML = `<p class="empty">搜索失败: ${escapeHtml(error.message)}</p>`;
    }
}

function copyToClipboard(text) {
    // 方案1: 使用现代Clipboard API
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(() => {
            showSuccess('已复制到剪贴板');
        }).catch(err => {
            console.error('Clipboard API失败:', err);
            // 失败时使用降级方案
            fallbackCopyToClipboard(text);
        });
    } else {
        // 方案2: 降级方案（兼容旧浏览器和非安全上下文）
        fallbackCopyToClipboard(text);
    }
}

function fallbackCopyToClipboard(text) {
    try {
        // 创建临时textarea元素
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.style.position = 'fixed';
        textarea.style.left = '-9999px';
        textarea.style.top = '0';
        document.body.appendChild(textarea);

        // 选择并复制
        textarea.focus();
        textarea.select();

        const successful = document.execCommand('copy');
        document.body.removeChild(textarea);

        if (successful) {
            showSuccess('已复制到剪贴板');
        } else {
            showError('复制失败，请手动复制');
            console.error('execCommand copy failed');
        }
    } catch (err) {
        showError('复制失败，请手动复制');
        console.error('降级复制失败:', err);
    }
}

function escapeHtml(value) {
    const div = document.createElement('div');
    div.textContent = value == null ? '' : String(value);
    return div.innerHTML;
}

function escapeJsString(value) {
    return String(value == null ? '' : value)
        .replace(/\\/g, '\\\\')
        .replace(/'/g, "\\'")
        .replace(/\n/g, '\\n')
        .replace(/\r/g, '\\r');
}


// ==================== 系统设置 ====================
// 当前已加载的连接模式（用于检测模式切换）
let _loadedConnectionMode = 'local';

async function loadSettings() {
    try {
        const response = await fetch('/api/settings/config');
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const config = await response.json();

        if (config) {
            const kp = document.getElementById('settingsKlipperPath');
            if (kp) kp.value = config.klipper_path || '~/klipper';
            const ktp = document.getElementById('settingsKatapultPath');
            if (ktp) ktp.value = config.katapult_path || '~/katapult';
            const mrHost = document.getElementById('settingsMoonrakerHost');
            if (mrHost) mrHost.value = config.moonraker_host || '127.0.0.1';
            // 记住原始 Moonraker 地址，用于模式切换后恢复
            _savedMoonrakerHost = config.moonraker_host || '127.0.0.1';
            const mrPort = document.getElementById('settingsMoonrakerPort');
            if (mrPort) mrPort.value = config.moonraker_port || 7125;

            // 加载连接模式
            const mode = config.connection_mode || 'local';
            _loadedConnectionMode = mode;  // 记录加载时的模式
            const radios = document.querySelectorAll('input[name="connectionMode"]');
            radios.forEach(r => r.checked = r.value === mode);

            // 标准 SSH 字段
            const sshHost = document.getElementById('settingsSshHost');
            if (sshHost) sshHost.value = config.ssh_host || '';
            const sshPort = document.getElementById('settingsSshPort');
            if (sshPort) sshPort.value = config.ssh_port || 22;
            const sshUser = document.getElementById('settingsSshUser');
            if (sshUser) sshUser.value = config.ssh_user || '';
            const sudoMode = document.getElementById('settingsSudoMode');
            if (sudoMode) sudoMode.value = config.sudo_mode || 'password';

            // FAST-SSH IP 地址
            const fastSshHost = document.getElementById('settingsFastSshHost');
            if (fastSshHost) fastSshHost.value = config.ssh_host || '';

            toggleSshConfig();

            // 加载凭据状态（仅标准 SSH 模式显示）
            if (mode === 'ssh') {
                try {
                    const credResp = await fetch('/api/settings/ssh-credentials');
                    const credData = await credResp.json();
                    const sshPwd = document.getElementById('settingsSshPassword');
                    const sudoPwd = document.getElementById('settingsSudoPassword');
                    if (sshPwd) sshPwd.placeholder = credData.has_ssh_password ? '已保存 (留空保持不变)' : '输入SSH密码';
                    if (sudoPwd) sudoPwd.placeholder = credData.has_sudo_password ? '已保存 (留空保持不变)' : '与SSH密码相同则留空';
                } catch (e) { console.warn('加载 SSH 凭据状态失败:', e); }
            }
        }
    } catch (error) {
        console.error('加载设置失败:', error);
    }
}

async function saveSettings() {
    const kp = document.getElementById('settingsKlipperPath');
    const ktp = document.getElementById('settingsKatapultPath');
    const mrHost = document.getElementById('settingsMoonrakerHost');
    const mrPort = document.getElementById('settingsMoonrakerPort');

    // 获取连接模式
    const modeRadio = document.querySelector('input[name="connectionMode"]:checked');
    const connectionMode = modeRadio ? modeRadio.value : 'local';

    // 根据模式收集 SSH 配置
    const sshHost = document.getElementById('settingsSshHost');
    const sshPort = document.getElementById('settingsSshPort');
    const sshUser = document.getElementById('settingsSshUser');
    const sudoMode = document.getElementById('settingsSudoMode');
    const fastSshHost = document.getElementById('settingsFastSshHost');

    const settings = {
        klipper_path: kp ? kp.value : '~/klipper',
        katapult_path: ktp ? ktp.value : '~/katapult',
        moonraker_host: mrHost ? mrHost.value : '127.0.0.1',
        moonraker_port: mrPort ? parseInt(mrPort.value) || 7125 : 7125,
        connection_mode: connectionMode,
    };

    if (connectionMode === 'ssh') {
        settings.ssh_host = sshHost ? sshHost.value : '';
        settings.ssh_port = sshPort ? parseInt(sshPort.value) || 22 : 22;
        settings.ssh_user = sshUser ? sshUser.value : '';
        settings.sudo_mode = sudoMode ? sudoMode.value : 'password';
    } else if (connectionMode === 'fast-ssh') {
        settings.ssh_host = fastSshHost ? fastSshHost.value : '';
        settings.ssh_port = 22;
        // ssh_user 和 sudo_mode 由后端自动设置固定值
    } else {
        // local 模式: 保留 ssh_host/port 的值以便将来切换回来
        settings.ssh_host = sshHost ? sshHost.value : '';
        settings.ssh_port = sshPort ? parseInt(sshPort.value) || 22 : 22;
        settings.ssh_user = '';
    }

    try {
        const response = await fetch('/api/settings/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(settings)
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const data = await response.json();

        if (data.success) {
            // 标准 SSH 模式保存凭据（如果有输入）
            if (connectionMode === 'ssh') {
                const sshPwd = document.getElementById('settingsSshPassword');
                const sudoPwd = document.getElementById('settingsSudoPassword');
                if (sshPwd?.value || sudoPwd?.value) {
                    const creds = {};
                    if (sshPwd && sshPwd.value) creds.ssh_password = sshPwd.value;
                    if (sudoPwd && sudoPwd.value) creds.sudo_password = sudoPwd.value;
                    if (Object.keys(creds).length > 0) {
                        await fetch('/api/settings/ssh-credentials', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify(creds)
                        });
                    }
                }
            }
            // FAST-SSH 模式凭据由后端自动保存，前端无需处理
            showSuccess('设置已保存');

            // 模式切换时刷新页面，确保后台线程和前端状态同步
            if (connectionMode !== _loadedConnectionMode) {
                setTimeout(() => { location.reload(); }, 800);
            }
        } else {
            showError('保存失败: ' + data.error);
        }
    } catch (error) {
        showError('保存失败: ' + error.message);
    }
}

// 切换 SSH/FAST-SSH 配置区显隐
function toggleSshConfig() {
    const modeRadio = document.querySelector('input[name="connectionMode"]:checked');
    const mode = modeRadio ? modeRadio.value : 'local';
    const sshSection = document.getElementById('sshConfigSection');
    const fastSshSection = document.getElementById('fastSshConfigSection');
    const localSection = document.getElementById('localConfigSection');

    // 标准 SSH 配置区
    if (sshSection) {
        sshSection.style.display = mode === 'ssh' ? 'block' : 'none';
    }
    // FAST-SSH 配置区
    if (fastSshSection) {
        fastSshSection.style.display = mode === 'fast-ssh' ? 'block' : 'none';
    }
    // 本地执行确认区
    if (localSection) {
        localSection.style.display = mode === 'local' ? 'block' : 'none';
    }

    // 联动 Moonraker 地址
    updateMoonrakerHostFromSsh();
    // 更新路径解析提示
    updatePathHints();
}

// 更新路径解析提示 — 显示 ~ 在当前模式下的实际路径
async function updatePathHints() {
    const kpInput = document.getElementById('settingsKlipperPath');
    const ktpInput = document.getElementById('settingsKatapultPath');
    const kpHint = document.getElementById('klipperPathHint');
    const ktpHint = document.getElementById('katapultPathHint');

    if (!kpInput || !kpHint) return;

    const kpVal = kpInput.value || '~/klipper';
    const ktpVal = ktpInput ? ktpInput.value : '~/katapult';

    // 如果路径不含 ~，直接显示原路径无提示
    if (!kpVal.startsWith('~')) {
        kpHint.textContent = '';
    }
    if (!ktpVal.startsWith('~')) {
        if (ktpHint) ktpHint.textContent = '';
    }

    // 从后端解析实际路径
    try {
        const params = new URLSearchParams();
        params.append('path', kpVal);
        if (ktpVal && ktpVal !== kpVal) params.append('path', ktpVal);

        const resp = await fetch('/api/settings/resolve-paths?' + params.toString());
        if (!resp.ok) return;
        const data = await resp.json();

        if (data.resolved) {
            const resolvedKp = data.resolved[kpVal];
            const resolvedKtp = data.resolved[ktpVal];
            const mode = data.mode || 'local';
            const modeLabel = mode === 'local' ? '本地' : mode.toUpperCase();

            if (resolvedKp && kpVal.startsWith('~')) {
                kpHint.textContent = `${modeLabel} 模式实际路径: ${resolvedKp}`;
                kpHint.style.color = mode === 'local' ? '#888' : '#1976D2';
            } else if (kpHint) {
                kpHint.textContent = '';
            }

            if (ktpHint && resolvedKtp && ktpVal.startsWith('~')) {
                ktpHint.textContent = `${modeLabel} 模式实际路径: ${resolvedKtp}`;
                ktpHint.style.color = mode === 'local' ? '#888' : '#1976D2';
            } else if (ktpHint) {
                ktpHint.textContent = '';
            }
        }
    } catch (e) {
        // 解析失败时静默
    }
}

// SSH/FAST-SSH 模式下自动将 Moonraker 地址同步为远程主机地址
let _savedMoonrakerHost = ''; // 记住加载时的 Moonraker 地址

function updateMoonrakerHostFromSsh() {
    const modeRadio = document.querySelector('input[name="connectionMode"]:checked');
    const mode = modeRadio ? modeRadio.value : 'local';
    const mrHost = document.getElementById('settingsMoonrakerHost');
    const sshHost = document.getElementById('settingsSshHost');
    const fastSshHost = document.getElementById('settingsFastSshHost');

    if (!mrHost) return;

    // 确定当前远程主机 IP
    let remoteHost = '';
    if (mode === 'ssh') {
        remoteHost = sshHost ? sshHost.value : '';
    } else if (mode === 'fast-ssh') {
        remoteHost = fastSshHost ? fastSshHost.value : '';
    }

    if ((mode === 'ssh' || mode === 'fast-ssh') && remoteHost) {
        // 首次进入远程模式时记住原始地址
        if (!_savedMoonrakerHost) {
            _savedMoonrakerHost = mrHost.value;
        }
        mrHost.value = remoteHost;
        mrHost.readOnly = true;
        mrHost.style.backgroundColor = '#f0f0f0';
        mrHost.title = `${mode.toUpperCase()} 模式下自动使用远程主机地址`;
    } else {
        // 恢复本地模式的原始地址
        if (_savedMoonrakerHost) {
            mrHost.value = _savedMoonrakerHost;
            _savedMoonrakerHost = '';
        }
        mrHost.readOnly = false;
        mrHost.style.backgroundColor = '';
        mrHost.title = '';
    }
}

// 测试本地执行环境
async function testLocalConnection() {
    const resultEl = document.getElementById('localTestResult');
    const btnEl = document.getElementById('btnTestLocal');
    if (!resultEl) return;

    resultEl.textContent = '检测中...';
    resultEl.style.color = '#888';
    if (btnEl) btnEl.disabled = true;

    // 先保存当前设置
    await saveSettings();

    try {
        const response = await fetch('/api/settings/local-test', { method: 'POST' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        if (data.success) {
            const detail = (data.checks || []).map(c => `${c.name}: ${c.detail}`).join(' | ');
            resultEl.textContent = data.message || '本地环境检测通过';
            if (detail) resultEl.textContent += ' (' + detail + ')';
            resultEl.style.color = '#28a745';
        } else {
            const failItems = (data.checks || []).filter(c => c.status === 'fail' || c.status === 'warn');
            const detail = failItems.map(c => `${c.name}: ${c.detail}`).join('; ');
            resultEl.textContent = (data.message || '本地环境存在问题') + (detail ? ' — ' + detail : '');
            resultEl.style.color = '#dc3545';
        }
    } catch (error) {
        resultEl.textContent = '测试失败: ' + error.message;
        resultEl.style.color = '#dc3545';
    }
    if (btnEl) btnEl.disabled = false;
}

// 测试 SSH 连接（支持标准 SSH 和 FAST-SSH）
async function testSshConnection() {
    const modeRadio = document.querySelector('input[name="connectionMode"]:checked');
    const mode = modeRadio ? modeRadio.value : 'local';

    // 根据模式选择结果显示元素
    let resultEl, btnEl;
    if (mode === 'fast-ssh') {
        resultEl = document.getElementById('fastSshTestResult');
        btnEl = document.getElementById('btnTestFastSsh');
    } else {
        resultEl = document.getElementById('sshTestResult');
        btnEl = document.getElementById('btnTestSsh');
    }
    if (!resultEl) return;

    resultEl.textContent = '连接测试中...';
    resultEl.style.color = '#888';
    if (btnEl) btnEl.disabled = true;

    // 先保存当前设置（后端会自动设置 FAST-SSH 凭据）
    await saveSettings();

    try {
        const response = await fetch('/api/settings/ssh-test', { method: 'POST' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        if (data.success) {
            resultEl.textContent = data.message || '连接成功';
            resultEl.style.color = '#28a745';
        } else {
            resultEl.textContent = data.error || '连接失败';
            resultEl.style.color = '#dc3545';
        }
    } catch (error) {
        resultEl.textContent = '测试失败: ' + error.message;
        resultEl.style.color = '#dc3545';
    }
    if (btnEl) btnEl.disabled = false;
}

// ==================== 工具函数 ====================
function showSuccess(message) {
    // 简单的成功提示
    const div = document.createElement('div');
    div.className = 'toast toast-success';
    div.textContent = message;
    document.body.appendChild(div);
    setTimeout(() => div.remove(), 3000);
}

function showError(message) {
    // 简单的错误提示
    const div = document.createElement('div');
    div.className = 'toast toast-error';
    div.textContent = message;
    document.body.appendChild(div);
    setTimeout(() => div.remove(), 3000);
}

// ==================== 配置 Diff 对比 ====================
async function showBackupDiff(backupIdA, backupIdB, compareCurrent) {
    try {
        const resp = await fetch('/api/backup/diff', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({backup_id_a: backupIdA, backup_id_b: backupIdB || '', current: !!compareCurrent})
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.json();
        if (data.success) renderDiffModal(data.diff, data.has_changes);
        else showError(data.error || '对比失败');
    } catch (e) { showError('对比请求失败'); }
}

function renderDiffModal(diffLines, hasChanges) {
    const modal = document.getElementById('diffModal');
    const content = document.getElementById('diffContent');
    if (!modal || !content) return;
    if (!hasChanges || !diffLines || diffLines.length === 0) {
        content.innerHTML = '<span style="color:var(--text-secondary);">' + t('diff.no_changes') + '</span>';
    } else {
        content.innerHTML = diffLines.map(line => {
            const escaped = line.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
            if (line.startsWith('+++') || line.startsWith('---')) return `<span style="font-weight:bold;color:var(--text-primary);">${escaped}</span>`;
            if (line.startsWith('@@')) return `<span style="color:var(--primary-color);background:rgba(33,150,243,0.1);display:block;">${escaped}</span>`;
            if (line.startsWith('+')) return `<span style="color:var(--success-color);background:rgba(76,175,80,0.12);display:block;">${escaped}</span>`;
            if (line.startsWith('-')) return `<span style="color:var(--danger-color);background:rgba(244,67,54,0.12);display:block;">${escaped}</span>`;
            return `<span>${escaped}</span>`;
        }).join('\n');
    }
    modal.style.display = 'flex';
}

function closeDiffModal() {
    const modal = document.getElementById('diffModal');
    if (modal) modal.style.display = 'none';
}

// ==================== 配置导入/导出 ====================
function exportAllConfigs() {
    window.location.href = '/api/config/export-all';
}

async function importConfigBundle(input) {
    const file = input.files[0];
    if (!file) return;
    const formData = new FormData();
    formData.append('file', file);
    try {
        const resp = await fetch('/api/config/import-bundle', {method: 'POST', body: formData});
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.json();
        if (data.success) showSuccess(data.message || '导入成功');
        else showError('导入失败: ' + (data.error || '未知错误'));
    } catch (e) { showError('导入请求失败'); }
    input.value = '';
}

// ==================== 初始化 ====================
document.addEventListener('DOMContentLoaded', async () => {
    if (typeof I18n !== 'undefined') await I18n.init();
    wsConnect();
    switchPage('resources');
});

// 更新资源显示
let _lastSshConnected = null;  // 缓存上一次连接状态，避免重复请求
let _sshStatusCheckInterval = 0;  // 状态检查间隔计数器

async function updateResources() {
    try {
        const response = await fetch('/api/system/resources?no_history=1');
        if (!response.ok) return;
        const data = await response.json();

        const current = data.current || data;
        const cpu = current.cpu || {};
        const memory = current.memory || {};
        const disk = current.disk || {};

        const cpuPercent = cpu.percent || 0;
        const memPercent = memory.percent || 0;
        const diskPercent = disk.percent || 0;

        // 更新 CPU
        document.getElementById('cpuPercentText').textContent = cpuPercent.toFixed(1) + '%';
        const cpuDetail = document.getElementById('cpuDetailText');
        if (cpuDetail) {
            const cores = cpu.count || '--';
            const freq = cpu.freq ? cpu.freq.toFixed(2) + ' GHz' : '--';
            cpuDetail.textContent = cores + ' 核 @ ' + freq;
        }

        // 更新内存
        document.getElementById('memPercentText').textContent = memPercent.toFixed(1) + '%';
        const memDetail = document.getElementById('memDetailText');
        if (memDetail && memory.used !== undefined && memory.total !== undefined) {
            memDetail.textContent = memory.used.toFixed(1) + ' / ' + memory.total.toFixed(1) + ' GB';
        }

        // 更新磁盘
        document.getElementById('diskPercentText').textContent = diskPercent.toFixed(1) + '%';
        const diskDetail = document.getElementById('diskDetailText');
        if (diskDetail && disk.used !== undefined && disk.total !== undefined) {
            diskDetail.textContent = disk.used.toFixed(1) + ' / ' + disk.total.toFixed(1) + ' GB';
        }

        // 更新进度条
        setProgressFill('cpuProgressFill', cpuPercent);
        setProgressFill('memProgressFill', memPercent);
        setProgressFill('diskProgressFill', diskPercent);

        // 更新网络状态
        if (current.network) {
            updateNetworkDisplay(current.network);
        }

        // 更新 FlyOS 版本信息（仅 FAST-SSH 模式显示）
        const flyosBar = document.getElementById('flyosVersionBar');
        const flyosText = document.getElementById('flyosVersionText');
        if (flyosBar && flyosText) {
            if (current.flyos_version) {
                flyosText.textContent = current.flyos_version;
                flyosBar.style.display = 'flex';
            } else {
                flyosBar.style.display = 'none';
            }
        }

        // 更新主板型号信息（仅 FAST-SSH 模式显示）
        const boardBar = document.getElementById('flyosBoardBar');
        const boardText = document.getElementById('flyosBoardText');
        if (boardBar && boardText) {
            if (current.board_name) {
                boardText.textContent = current.board_name;
                boardBar.style.display = 'flex';
            } else {
                boardBar.style.display = 'none';
            }
        }

        // 每 3 秒检查一次 SSH 连接状态（非本地模式时）
        _sshStatusCheckInterval++;
        if (_sshStatusCheckInterval >= 3) {
            _sshStatusCheckInterval = 0;
            updateSshConnectionStatus();
        }

    } catch (error) {
        console.error('获取系统资源失败:', error);
    }
}

// 更新 SSH 连接状态栏
async function updateSshConnectionStatus() {
    const bar = document.getElementById('sshConnectionBar');
    const content = document.getElementById('sshConnectionContent');
    if (!bar || !content) return;

    try {
        const resp = await fetch('/api/ssh/status');
        if (!resp.ok) return;
        const status = await resp.json();

        // 本地模式不显示
        if (status.mode === 'local' || status.connected === null) {
            bar.style.display = 'none';
            _lastSshConnected = null;
            return;
        }

        bar.style.display = 'block';

        if (status.connected) {
            // 连接正常
            if (_lastSshConnected === false) {
                // 从断连恢复
                content.style.background = 'rgba(76,175,80,0.1)';
                content.style.color = '#4caf50';
                content.style.border = '1px solid rgba(76,175,80,0.3)';
                content.innerHTML = `
                    <span>SSH 连接已恢复: ${escapeHtml(status.user)}@${escapeHtml(status.host)}:${escapeHtml(status.port)}</span>
                    <span></span>
                `;
                // 3 秒后切为简洁状态
                setTimeout(() => {
                    if (bar.style.display !== 'none') {
                        content.style.background = 'rgba(76,175,80,0.05)';
                        content.innerHTML = `
                            <span style="color:#4caf50;">SSH 已连接: ${escapeHtml(status.user)}@${escapeHtml(status.host)}:${escapeHtml(status.port)}</span>
                            <span></span>
                        `;
                    }
                }, 3000);
            } else {
                // 持续正常
                content.style.background = 'rgba(76,175,80,0.05)';
                content.style.color = '#4caf50';
                content.style.border = '1px solid rgba(76,175,80,0.2)';
                content.innerHTML = `
                    <span>SSH 已连接: ${escapeHtml(status.user)}@${escapeHtml(status.host)}:${escapeHtml(status.port)}</span>
                    <span></span>
                `;
            }
            _lastSshConnected = true;
        } else {
            // 连接断开
            _lastSshConnected = false;
            const modeLabel = status.mode === 'fast-ssh' ? 'FAST-SSH' : 'SSH';
            let detailHtml = '';

            if (status.circuit_open) {
                detailHtml = `<span style="color:#e65100;">断路器已打开，冷却 ${status.cooldown_remaining} 秒后自动重试</span>`;
            } else if (status.reconnect_attempts > 0) {
                detailHtml = `<span style="color:#856404;">已自动重连 ${status.reconnect_attempts} 次</span>`;
            } else {
                detailHtml = '<span style="color:#856404;">连接中断，正在尝试恢复...</span>';
            }

            content.style.background = 'rgba(244,67,54,0.08)';
            content.style.color = '#d32f2f';
            content.style.border = '1px solid rgba(244,67,54,0.25)';
            content.innerHTML = `
                <div style="display:flex;flex-direction:column;gap:4px;">
                    <span style="font-weight:600;">${modeLabel} 连接已断开: ${escapeHtml(status.host)}:${escapeHtml(status.port)}</span>
                    ${detailHtml}
                </div>
                <button onclick="manualReconnect()" style="padding:6px 16px;border:1px solid rgba(244,67,54,0.5);border-radius:4px;background:rgba(244,67,54,0.1);color:#d32f2f;cursor:pointer;font-size:13px;white-space:nowrap;">重新连接</button>
            `;
        }
    } catch (error) {
        // 请求失败时不显示状态栏
        console.debug('SSH 状态检查失败:', error);
    }
}

// 手动重连
async function manualReconnect() {
    const content = document.getElementById('sshConnectionContent');
    if (!content) return;

    // 显示正在重连状态
    content.style.background = 'rgba(33,150,243,0.08)';
    content.style.color = '#1976d2';
    content.style.border = '1px solid rgba(33,150,243,0.25)';
    content.innerHTML = '<span>正在重新连接...</span><span></span>';

    try {
        const resp = await fetch('/api/ssh/reconnect', { method: 'POST' });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.json();

        if (data.success) {
            _lastSshConnected = true;
            content.style.background = 'rgba(76,175,80,0.1)';
            content.style.color = '#4caf50';
            content.style.border = '1px solid rgba(76,175,80,0.3)';
            content.innerHTML = `<span>${data.message}</span><span></span>`;
        } else {
            _lastSshConnected = false;
            content.style.background = 'rgba(244,67,54,0.08)';
            content.style.color = '#d32f2f';
            content.style.border = '1px solid rgba(244,67,54,0.25)';
            content.innerHTML = `
                <div style="display:flex;flex-direction:column;gap:4px;">
                    <span style="font-weight:600;">重连失败</span>
                    <span style="font-size:12px;">${data.error || '未知错误'}</span>
                </div>
                <button onclick="manualReconnect()" style="padding:6px 16px;border:1px solid rgba(244,67,54,0.5);border-radius:4px;background:rgba(244,67,54,0.1);color:#d32f2f;cursor:pointer;font-size:13px;white-space:nowrap;">重新连接</button>
            `;
        }
    } catch (error) {
        content.style.background = 'rgba(244,67,54,0.08)';
        content.style.color = '#d32f2f';
        content.style.border = '1px solid rgba(244,67,54,0.25)';
        content.innerHTML = `
            <span>重连请求失败: ${error.message}</span>
            <button onclick="manualReconnect()" style="padding:6px 16px;border:1px solid rgba(244,67,54,0.5);border-radius:4px;background:rgba(244,67,54,0.1);color:#d32f2f;cursor:pointer;font-size:13px;white-space:nowrap;">重新连接</button>
        `;
    }
}

// ==================== 系统设置页面功能 ====================

// 控制服务
async function controlService(serviceName, action) {
    const isSelfRestart = serviceName === 'firmware-tool' && action === 'restart';
    try {
        const response = await fetch('/api/system/service', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ service: serviceName, action: action })
        });
        if (!response.ok && !isSelfRestart) throw new Error(`HTTP ${response.status}`);

        const data = await response.json();

        if (data.success) {
            if (isSelfRestart) {
                showSuccess('firmware-tool 正在重启，请稍候...');
                // 自身重启后需要等更久才能恢复
                setTimeout(loadAvailableServices, 5000);
            } else {
                showSuccess(`${serviceName} 服务${action === 'start' ? '启动' : action === 'stop' ? '停止' : '重启'}成功`);
                // 延迟刷新服务列表以更新状态
                setTimeout(loadAvailableServices, 1000);
            }
        } else {
            showError(`${serviceName} 服务操作失败: ${data.error}`);
        }
    } catch (error) {
        if (isSelfRestart) {
            // 自身重启时可能会因为服务断开导致请求失败，这是正常的
            showSuccess('firmware-tool 正在重启，请稍候...');
            setTimeout(loadAvailableServices, 5000);
        } else {
            showError(`服务操作失败: ${error.message}`);
        }
    }
}

// 加载可用服务列表
async function loadAvailableServices() {
    const container = document.getElementById('serviceList');
    if (!container) return;

    try {
        const response = await fetch('/api/system/services');
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        renderServiceButtons(data.services || []);
    } catch (error) {
        console.error('加载服务列表失败:', error);
        container.innerHTML = '<p class="text-muted">加载服务列表失败</p>';
    }
}

// 渲染服务按钮
function renderServiceButtons(services) {
    const container = document.getElementById('serviceList');
    if (!container) return;

    if (services.length === 0) {
        container.innerHTML = '<p class="text-muted">未检测到可用服务</p>';
        return;
    }

    container.innerHTML = '';
    services.forEach(service => {
        const statusText = service.active ? '运行中' : '已停止';
        const statusClass = service.active ? 'text-success' : 'text-danger';
        const isSelf = service.self_service === true;
        const displayName = escapeHtml(service.name || '');
        const controlName = service.control_name || service.name || '';
        const controlArg = escapeJsString(controlName);

        // firmware-tool 是自身服务，只显示重启按钮
        let buttonsHtml;
        if (isSelf) {
            buttonsHtml = `
                <div class="btn-group">
                    <button class="btn btn-sm btn-warning" onclick="controlService('${controlArg}', 'restart')">重启</button>
                </div>
            `;
        } else if (service.controllable === false || !controlName) {
            buttonsHtml = '<span style="font-size:12px;color:#888;">不可控制</span>';
        } else {
            buttonsHtml = `
                <div class="btn-group">
                    <button class="btn btn-sm btn-success" onclick="controlService('${controlArg}', 'start')">启动</button>
                    <button class="btn btn-sm btn-danger" onclick="controlService('${controlArg}', 'stop')">停止</button>
                    <button class="btn btn-sm btn-warning" onclick="controlService('${controlArg}', 'restart')">重启</button>
                </div>
            `;
        }

        const div = document.createElement('div');
        div.className = 'service-item';
        div.innerHTML = `
            <span>${displayName} 服务 <span class="${statusClass}">(${statusText})</span></span>
            ${buttonsHtml}
        `;
        container.appendChild(div);
    });
}

// 加载版本信息
async function loadVersionInfo() {
    try {
        const response = await fetch('/api/system/versions');
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();

        const klipperVersionEl = document.getElementById('klipperVersion');
        if (klipperVersionEl) {
            klipperVersionEl.textContent = data.klipper_version || '未安装';
        }
    } catch (error) {
        console.error('加载版本信息失败:', error);
        const klipperVersionEl = document.getElementById('klipperVersion');
        if (klipperVersionEl) {
            klipperVersionEl.textContent = '加载失败';
        }
    }
}

// 检查更新
let updateAvailable = false;
let updateInfo = null;

async function checkForUpdates() {
    const statusDiv = document.getElementById('updateStatus');
    const updateBtn = document.getElementById('updateBtn');

    statusDiv.textContent = '正在检查更新...';
    updateBtn.style.display = 'none';

    try {
        const response = await fetch('/api/system/check-update');
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();

        if (data.error) {
            statusDiv.textContent = '检查更新失败: ' + data.error;
            return;
        }

        if (data.has_update) {
            updateAvailable = true;
            updateInfo = data;
            statusDiv.innerHTML = `<span style="color:#28a745;">发现新版本！</span><br>当前: ${escapeHtml(data.current_version)} → 最新: ${escapeHtml(data.latest_version)}<br>更新时间: ${escapeHtml(data.update_time)}`;
            updateBtn.style.display = 'inline-block';
        } else {
            updateAvailable = false;
            statusDiv.textContent = '当前已是最新版本 (' + data.current_version + ')';
        }
    } catch (error) {
        statusDiv.textContent = '检查更新失败: ' + error.message;
    }
}

// 更新项目
async function updateProject() {
    if (!updateAvailable) {
        showError('没有可用的更新');
        return;
    }

    const logDiv = document.getElementById('updateLog');
    const logPre = logDiv.querySelector('pre');
    const updateBtn = document.getElementById('updateBtn');

    logDiv.style.display = 'block';
    logPre.textContent = '开始更新...\n';
    updateBtn.disabled = true;
    updateBtn.textContent = '更新中...';

    try {
        const response = await fetch('/api/system/update', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const reader = response.body.getReader();
        const decoder = new TextDecoder();

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            const text = decoder.decode(value, { stream: true });
            logPre.textContent += text;
            logPre.scrollTop = logPre.scrollHeight;
        }

        logPre.textContent += '\n\n✅ 更新完成！请刷新页面。';
        showSuccess('项目更新成功！请刷新页面');

    } catch (error) {
        logPre.textContent += '\n\n❌ 更新失败: ' + error.message;
        showError('更新失败: ' + error.message);
    } finally {
        updateBtn.disabled = false;
        updateBtn.textContent = '🔄 立即更新';
    }
}

// ==================== 配置备份管理 ====================
async function createConfigBackup() {
    try {
        const response = await fetch('/api/backup/config', { method: 'POST' });
        const data = await response.json();
        if (!response.ok || !data.success) {
            throw new Error(data.error || '备份失败');
        }
        showSuccess(`备份成功 (${data.backup_id})`);
        loadBackupList();
    } catch (error) {
        showError('备份失败: ' + error.message);
    }
}

async function loadBackupList() {
    const listEl = document.getElementById('backupList');
    if (!listEl) return;
    try {
        const response = await fetch('/api/backup/list');
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        if (!data.success) throw new Error(data.error || '加载失败');
        const backups = data.backups || [];
        if (backups.length === 0) {
            listEl.innerHTML = '<p class="empty">暂无备份记录</p>';
            return;
        }
        listEl.innerHTML = backups.map(b => {
            const ts = b.timestamp || b.id.replace(/_/g, ' ').replace(/(\d{8})/, (_, m) => `${m.slice(0,4)}-${m.slice(4,6)}-${m.slice(6,8)}`);
            const sizeKb = ((b.size || 0) / 1024).toFixed(1);
            const sourceLabel = {moonraker: 'Moonraker', ssh: 'SSH', local: '本地', auto: '自动'}[b.source] || b.source;
            return `<div class="backup-item">
                <div class="backup-meta">
                    <span class="backup-name">${escapeHtml(b.filename || b.id)}</span>
                    <span class="backup-info">${escapeHtml(ts)} · ${sizeKb} KB · ${escapeHtml(sourceLabel)}</span>
                </div>
                <div class="backup-actions">
                    <button class="btn btn-sm btn-warning" onclick="rollbackBackup('${escapeHtml(b.id)}')">恢复</button>
                    <button class="btn btn-sm btn-danger" onclick="deleteBackup('${escapeHtml(b.id)}')">删除</button>
                </div>
            </div>`;
        }).join('');
    } catch (error) {
        listEl.innerHTML = `<p class="empty">加载失败: ${escapeHtml(error.message)}</p>`;
    }
}

async function rollbackBackup(backupId) {
    if (!confirm('确定要恢复此备份？当前 printer.cfg 将被覆盖。')) return;
    try {
        const response = await fetch('/api/backup/rollback', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ backup_id: backupId })
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        if (!data.success) throw new Error(data.error || '恢复失败');
        showSuccess('配置已恢复');
    } catch (error) {
        showError('恢复失败: ' + error.message);
    }
}

async function deleteBackup(backupId) {
    if (!confirm('确定要删除此备份？')) return;
    try {
        const response = await fetch(`/api/backup/${encodeURIComponent(backupId)}`, { method: 'DELETE' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        if (!data.success) throw new Error(data.error || '删除失败');
        loadBackupList();
    } catch (error) {
        showError('删除失败: ' + error.message);
    }
}

async function loadBackupSettings() {
    const toggle = document.getElementById('autoBackupToggle');
    if (!toggle) return;
    try {
        const response = await fetch('/api/backup/settings');
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        if (data.success) toggle.checked = !!data.auto_backup;
    } catch (error) {
        console.error('加载备份设置失败:', error);
    }
}

async function toggleAutoBackup() {
    const toggle = document.getElementById('autoBackupToggle');
    if (!toggle) return;
    try {
        const resp = await fetch('/api/backup/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ auto_backup: toggle.checked })
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    } catch (error) {
        showError('更新设置失败: ' + error.message);
        toggle.checked = !toggle.checked;
    }
}

// ==================== CAN 总线拓扑可视化 ====================
async function refreshCanTopology() {
    const vizEl = document.getElementById('canTopologyViz');
    if (!vizEl) return;
    const iface = document.getElementById('canIfaceSelect')?.value || 'can0';
    vizEl.innerHTML = '<p class="empty">正在扫描 CAN 总线...</p>';
    try {
        const response = await fetch(`/api/system/can-topology?iface=${encodeURIComponent(iface)}`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        if (!data.success) throw new Error(data.error || '加载失败');
        renderCanTopology(data, vizEl);
    } catch (error) {
        vizEl.innerHTML = `<p class="empty">加载失败: ${escapeHtml(error.message)}</p>`;
    }
}

function renderCanTopology(data, container) {
    const devices = data.devices || [];
    const iface = data.interface || {};
    const klipperState = data.klipper_state || 'unknown';

    if (devices.length === 0) {
        container.innerHTML = `<div class="can-topology-empty">
            <i class="fas fa-search" style="font-size:24px;color:#ccc;margin-bottom:8px;display:block;"></i>
            <p>未检测到 CAN 设备</p>
            <p style="font-size:12px;color:#999;">接口: ${escapeHtml(iface.name)} · 状态: ${escapeHtml(iface.state)}</p>
        </div>`;
        return;
    }

    const stateColors = {
        connected: '#4caf50',
        katapult: '#ff9800',
        lost: '#f44336',
        unknown: '#9e9e9e',
    };
    const stateLabels = {
        connected: '已连接',
        katapult: 'Katapult',
        lost: '已丢失',
        unknown: '未知',
    };

    const busStateColor = iface.state === 'UP' ? '#4caf50' : '#ff9800';
    const bitrateStr = iface.bitrate ? `${(iface.bitrate / 1000000).toFixed(1)} Mbps` : '';

    let html = `<div class="can-topology-header">
        <span class="can-topology-iface" style="color:${busStateColor}">
            <i class="fas fa-${iface.state === 'UP' ? 'check-circle' : 'exclamation-circle'}"></i>
            ${escapeHtml(iface.name)}
        </span>
        <span class="can-topology-meta">${escapeHtml(iface.state)}${bitrateStr ? ' · ' + escapeHtml(bitrateStr) : ''} · Klipper: ${escapeHtml(klipperState)} · ${devices.length} 设备</span>
    </div>`;

    html += '<div class="can-bus-line">';
    html += '<div class="can-bus-label">CAN BUS</div>';

    devices.forEach((dev, idx) => {
        const status = dev.connection_status || 'unknown';
        const color = stateColors[status] || stateColors.unknown;
        const mcuModel = dev.mcu_model ? String(dev.mcu_model).toUpperCase() : '';
        const mcuVersion = dev.mcu_version || '';
        const uuidShort = (dev.uuid || '').substring(0, 8);
        const section = dev.section || '';
        const appLabel = dev.app || 'Unknown';
        const leftPct = devices.length === 1 ? 50 : (10 + (idx / (devices.length - 1)) * 80);

        html += `<div class="can-node can-node-${status}" style="left:${leftPct}%" onclick="showCanNodeDetail(this, ${JSON.stringify(JSON.stringify(dev))})">
            <div class="can-node-connector" style="background:${color}"></div>
            <div class="can-node-card" style="border-left:3px solid ${color}">
                <div class="can-node-icon"><i class="fas fa-microchip"></i></div>
                <div class="can-node-info">
                    <div class="can-node-title">${escapeHtml(mcuModel || appLabel)}</div>
                    <div class="can-node-detail">${escapeHtml(uuidShort)}${section ? ' · [' + escapeHtml(section) + ']' : ''}</div>
                    ${mcuVersion ? `<div class="can-node-detail">${escapeHtml(mcuVersion)}</div>` : ''}
                </div>
                <div class="can-node-status" style="color:${color}">
                    <i class="fas fa-${status === 'connected' ? 'check-circle' : status === 'katapult' ? 'download' : status === 'lost' ? 'times-circle' : 'question-circle'}"></i>
                    ${escapeHtml(stateLabels[status] || status)}
                </div>
            </div>
        </div>`;
    });

    html += '</div>';
    container.innerHTML = html;
}

function showCanNodeDetail(el, devJson) {
    const dev = JSON.parse(devJson);
    const lines = [
        `UUID: ${dev.uuid || 'N/A'}`,
        `应用: ${dev.app || 'Unknown'}`,
        dev.mcu_model ? `MCU: ${String(dev.mcu_model).toUpperCase()}` : '',
        dev.mcu_freq ? `频率: ${dev.mcu_freq}` : '',
        dev.mcu_version ? `固件: ${dev.mcu_version}` : '',
        dev.section ? `配置: [${dev.section}]` : '',
        `状态: ${dev.connection_status || 'unknown'}`,
    ].filter(Boolean);

    const existing = document.querySelector('.can-node-detail-popup');
    if (existing) existing.remove();

    const popup = document.createElement('div');
    popup.className = 'can-node-detail-popup';
    popup.innerHTML = `
        <div style="font-weight:600;margin-bottom:6px;">设备详情</div>
        ${lines.map(l => `<div style="font-size:12px;padding:2px 0;">${escapeHtml(l)}</div>`).join('')}
        <button class="btn btn-sm btn-secondary" style="margin-top:8px;" onclick="this.parentElement.remove()">关闭</button>
    `;
    popup.style.cssText = 'position:fixed;background:#fff;border:1px solid #ddd;border-radius:8px;padding:12px;box-shadow:0 4px 12px rgba(0,0,0,0.15);z-index:1000;max-width:280px;';
    const rect = el.getBoundingClientRect();
    popup.style.left = Math.min(rect.left, window.innerWidth - 300) + 'px';
    popup.style.top = (rect.bottom + 8) + 'px';
    document.body.appendChild(popup);

    setTimeout(() => {
        document.addEventListener('click', function handler(e) {
            if (!popup.contains(e.target) && !el.contains(e.target)) {
                popup.remove();
                document.removeEventListener('click', handler);
            }
        });
    }, 100);
}
