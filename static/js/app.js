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
    } else if (pageId === 'settings') {
        loadSettings();
        loadVersionInfo();
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
                    <span class="network-name">${iface.name}</span>
                    <span class="network-ips">${iface.ips.join(', ')}</span>
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
        const data = await response.json();
        if (data.devices && data.devices.length > 0) {
            container.innerHTML = data.devices.map(d => {
                const info = [d.model, d.vendor].filter(Boolean).join(' - ');
                const ids = [d.vid, d.pid].filter(Boolean).join(':');
                const copyVal = (d.link || d.devname || d.path).replace(/'/g, "\\'");
                return `
                    <div class="id-item" style="flex-direction:column;align-items:flex-start;">
                        <div style="display:flex;justify-content:space-between;width:100%;align-items:center;">
                            <span class="id-text" style="font-weight:600;">${d.link || d.devname || d.path}</span>
                            <button class="btn btn-sm btn-secondary" onclick="copyToClipboard('${copyVal}')">复制</button>
                        </div>
                        <div style="font-size:11px;color:#888;margin-top:3px;">
                            ${info ? info : ''}${ids ? ' [' + ids + ']' : ''}${d.driver ? ' (' + d.driver + ')' : ''}
                        </div>
                    </div>`;
            }).join('');
        } else {
            container.innerHTML = '<p class="empty">未找到串口设备</p>';
        }
    } catch (error) {
        container.innerHTML = `<p class="empty">搜索失败: ${error.message}</p>`;
    }
}

// CAN接口刷新
async function refreshCanIfaces() {
    const select = document.getElementById('canIfaceSelect');
    select.innerHTML = '<option value="">加载中...</option>';
    try {
        const response = await fetch('/api/system/can-iface');
        const data = await response.json();
        select.innerHTML = '<option value="">选择CAN接口</option>';
        if (data.ifaces && data.ifaces.length > 0) {
            data.ifaces.forEach(iface => {
                const state = iface.operstate === 'UP' ? '✅' : '⚠️';
                select.innerHTML += `<option value="${iface.ifname}">${state} ${iface.ifname} (${iface.operstate})</option>`;
            });
            if (data.ifaces.length === 1) select.selectedIndex = 1;
        } else {
            select.innerHTML += '<option value="" disabled>未找到CAN接口</option>';
        }
    } catch (error) {
        select.innerHTML = '<option value="">加载失败</option>';
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
    container.innerHTML = '<p class="empty">搜索中（约2.5秒）...</p>';
    try {
        const response = await fetch('/api/system/can-uuid', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ iface: select.value })
        });
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
                const appColor = d.app === 'Klipper' ? '#4caf50' : d.app === 'Katapult' ? '#ff9800' : d.app === 'Klipper (config)' ? '#1976d2' : '#999';
                return `
                <div class="id-item">
                    <span class="id-text">
                        <span style="font-weight:600;">${d.uuid}</span>
                        ${d.section ? `<span style="font-size:11px;color:#666;margin-left:6px;">${d.section}</span>` : ''}
                        <span style="font-size:11px;color:${appColor};margin-left:8px;">[${d.app}]</span>
                    </span>
                    <button class="btn btn-sm btn-secondary" onclick="copyToClipboard('${d.uuid}')">复制</button>
                </div>
            `}).join('');
            container.innerHTML = html;
        } else {
            container.innerHTML = '<p class="empty">未找到CAN设备</p>';
            if (data.error && errDiv) {
                errDiv.style.display = 'block';
                errDiv.innerHTML = `<div style="background:#fff3cd;padding:10px;border-radius:6px;border-left:4px solid #ffc107;margin-top:8px;font-size:13px;color:#856404;">⚠️ ${data.error}</div>`;
            }
        }
    } catch (error) {
        container.innerHTML = `<p class="empty">搜索失败: ${error.message}</p>`;
    }
}

// 摄像头搜索
async function searchCamera() {
    const container = document.getElementById('cameraDevices');
    container.innerHTML = '<p class="empty">搜索中...</p>';
    try {
        const response = await fetch('/api/system/video');
        const data = await response.json();
        if (data.videos && data.videos.length > 0) {
            container.innerHTML = data.videos.map(d => {
                const copyVal = d.path.replace(/'/g, "\\'");
                return `
                    <div class="id-item">
                        <span class="id-text">
                            <span style="font-weight:600;">${d.path}</span>
                            <span style="font-size:11px;color:#666;margin-left:8px;">${d.name}${d.index ? ' (index:' + d.index + ')' : ''}</span>
                        </span>
                        <button class="btn btn-sm btn-secondary" onclick="copyToClipboard('${copyVal}')">复制</button>
                    </div>`;
            }).join('');
        } else {
            container.innerHTML = '<p class="empty">未找到摄像头</p>';
        }
    } catch (error) {
        container.innerHTML = `<p class="empty">搜索失败: ${error.message}</p>`;
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
        const data = await res.json();

        let html = '';

        if (data.system === 'flyos_fast') {
            // FlyOS-FAST: 只读占位
            const liveBitrate = data.live && data.live.bitrate ? formatBitrate(data.live.bitrate) : (data.bitrate_display || '--');
            const liveState = data.live && data.live.exists ? (data.live.state || '--') : '--';
            html = `
                <div style="padding:4px 0;">
                    <div style="background:rgba(33,150,243,0.08);padding:12px;border-radius:6px;border-left:4px solid #2196F3;margin-bottom:12px;font-size:13px;">
                        FlyOS-Fast 系统，CAN 通过 /config/config.txt 配置
                    </div>
                    <div class="status-info" style="margin-bottom:12px;">
                        <div style="display:flex;gap:20px;flex-wrap:wrap;font-size:13px;">
                            <span>接口状态: <strong>${liveState}</strong></span>
                            <span>当前速率: <strong>${liveBitrate}</strong></span>
                        </div>
                    </div>
                    <div style="font-size:12px;color:#888;padding:8px;background:var(--bg-color);border-radius:4px;">
                        FlyOS-Fast 系统 CAN 速率修改将在后续版本支持，当前为只读
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
                        <span>接口: <strong>${data.live && data.live.interface || 'can0'}</strong></span>
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
        body.innerHTML = `<p class="empty">加载失败: ${error.message}</p>`;
    }
}

async function applyCanHostConfig() {
    const statusDiv = document.getElementById('canHostApplyStatus');
    if (!statusDiv) return;

    const rateSelect = document.getElementById('canHostRate');
    const txqueueInput = document.getElementById('canHostTxqueue');

    if (!rateSelect || !txqueueInput) return;

    const bitrate = parseInt(rateSelect.value);
    const txqueuelen = parseInt(txqueueInput.value);

    if (isNaN(txqueuelen) || txqueuelen < 128 || txqueuelen > 8192) {
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
        const data = await res.json();

        if (data.success) {
            statusDiv.innerHTML = `<div class="status-area show" style="display:block;background:rgba(76,175,80,0.1);color:#4caf50;border:1px solid rgba(76,175,80,0.3);padding:10px;border-radius:6px;font-size:13px;">${data.message}</div>`;
            // 刷新状态
            setTimeout(loadCanHostConfig, 1500);
        } else {
            statusDiv.innerHTML = `<div class="status-area show" style="display:block;background:rgba(244,67,54,0.1);color:#d32f2f;border:1px solid rgba(244,67,54,0.3);padding:10px;border-radius:6px;font-size:13px;">${data.error || '应用失败'}</div>`;
        }
    } catch (error) {
        statusDiv.innerHTML = `<div class="status-area show" style="display:block;background:rgba(244,67,54,0.1);color:#d32f2f;border:1px solid rgba(244,67,54,0.3);padding:10px;border-radius:6px;font-size:13px;">请求失败: ${error.message}</div>`;
    }
}

async function searchLsusb() {
    const filter = document.getElementById('lsusbFilter').value.trim();
    const container = document.getElementById('lsusbDevices');
    container.innerHTML = '<p class="empty">搜索中...</p>';
    try {
        const url = filter ? `/api/system/lsusb?search=${encodeURIComponent(filter)}` : '/api/system/lsusb';
        const response = await fetch(url);
        const data = await response.json();
        if (data.devices && data.devices.length > 0) {
            container.innerHTML = data.devices.map(d => `
                <div class="id-item">
                    <span class="id-text" style="font-size:12px;">${d.formatted || d.name}</span>
                    <button class="btn btn-sm btn-secondary" onclick="copyToClipboard('${(d.formatted || d.name).replace(/'/g, "\\'")}')">复制</button>
                </div>
            `).join('');
        } else {
            container.innerHTML = '<p class="empty">未找到设备</p>';
        }
    } catch (error) {
        container.innerHTML = `<p class="empty">搜索失败: ${error.message}</p>`;
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


// 初始化 BL 厂家选择

// BL 厂家改变

// BL 主板类型改变

// BL 烧录方式改变




// ==================== 系统设置 ====================
async function loadSettings() {
    try {
        const response = await fetch('/api/settings/config');
        const config = await response.json();
        
        if (config) {
            const kp = document.getElementById('settingsKlipperPath');
            if (kp) kp.value = config.klipper_path || '~/klipper';
            const ktp = document.getElementById('settingsKatapultPath');
            if (ktp) ktp.value = config.katapult_path || '~/katapult';
            const mrHost = document.getElementById('settingsMoonrakerHost');
            if (mrHost) mrHost.value = config.moonraker_host || '127.0.0.1';
            const mrPort = document.getElementById('settingsMoonrakerPort');
            if (mrPort) mrPort.value = config.moonraker_port || 7125;
        }
    } catch (error) {
        console.error('加载设置失败:', error);
    }
}

// 加载当前 Web 界面状态

// 切换 Web 界面

async function saveSettings() {
    const kp = document.getElementById('settingsKlipperPath');
    const ktp = document.getElementById('settingsKatapultPath');
    const mrHost = document.getElementById('settingsMoonrakerHost');
    const mrPort = document.getElementById('settingsMoonrakerPort');
    const settings = {
        klipper_path: kp ? kp.value : '~/klipper',
        katapult_path: ktp ? ktp.value : '~/katapult',
        moonraker_host: mrHost ? mrHost.value : '127.0.0.1',
        moonraker_port: mrPort ? parseInt(mrPort.value) || 7125 : 7125,
    };
    
    try {
        const response = await fetch('/api/settings/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(settings)
        });
        
        const data = await response.json();
        
        if (data.success) {
            showSuccess('设置已保存');
        } else {
            showError('保存失败: ' + data.error);
        }
    } catch (error) {
        showError('保存失败: ' + error.message);
    }
}



async function manageService(service, action) {
    try {
        const response = await fetch(`/api/settings/service/${action}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ service })
        });
        
        const data = await response.json();
        
        if (data.success) {
            showSuccess(`${service} ${action} 成功`);
        } else {
            showError(`${service} ${action} 失败: ${data.error}`);
        }
    } catch (error) {
        showError('操作失败: ' + error.message);
    }
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

// ==================== 初始化 ====================
document.addEventListener('DOMContentLoaded', () => {
    // 加载初始页面
    switchPage('resources');
    
});

// 更新资源显示
async function updateResources() {
    try {
        const response = await fetch('/api/system/resources');
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
        
    } catch (error) {
        console.error('获取系统资源失败:', error);
    }
}

// ==================== 系统设置页面功能 ====================

// 控制服务
async function controlService(serviceName, action) {
    try {
        const response = await fetch('/api/system/service', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ service: serviceName, action: action })
        });
        
        const data = await response.json();
        
        if (data.success) {
            showSuccess(`${serviceName} 服务${action === 'start' ? '启动' : action === 'stop' ? '停止' : '重启'}成功`);
        } else {
            showError(`${serviceName} 服务操作失败: ${data.error}`);
        }
    } catch (error) {
        showError(`服务操作失败: ${error.message}`);
    }
}

// 加载版本信息
async function loadVersionInfo() {
    try {
        const response = await fetch('/api/system/versions');
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
        const data = await response.json();
        
        if (data.error) {
            statusDiv.textContent = '检查更新失败: ' + data.error;
            return;
        }
        
        if (data.has_update) {
            updateAvailable = true;
            updateInfo = data;
            statusDiv.innerHTML = `<span style="color:#28a745;">发现新版本！</span><br>当前: ${data.current_version} → 最新: ${data.latest_version}<br>更新时间: ${data.update_time}`;
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