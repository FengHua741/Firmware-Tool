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
                // 使用后端推荐的 display_path（USB虚拟串口用 by-id，USB转串口用 by-path）
                const displayVal = d.display_path || d.by_id || d.path;
                const copyVal = displayVal.replace(/'/g, "\\'");
                return `
                    <div class="id-item" style="flex-direction:column;align-items:flex-start;">
                        <div style="display:flex;justify-content:space-between;width:100%;align-items:center;">
                            <span class="id-text" style="font-weight:600;">${displayVal}</span>
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

// CAN 网络诊断
async function diagnoseCanNetwork() {
    const container = document.getElementById('canDevices');
    const errDiv = document.getElementById('canSearchError');
    if (errDiv) errDiv.style.display = 'none';

    container.innerHTML = '<p class="empty">正在诊断CAN网络...</p>';
    try {
        const response = await fetch('/api/system/can-diagnose');
        const data = await response.json();

        let html = '<div style="font-size:13px;line-height:1.8;">';
        html += '<h4 style="margin:0 0 8px 0;color:#333;">CAN 网络诊断结果</h4>';

        html += `<div>内核CAN支持: <b>${data.kernel_support ? '✅ 支持' : '❌ 不支持'}</b></div>`;
        html += `<div>CAN硬件设备: <b>${data.can_device_exists ? '✅ 已检测到' : '❌ 未检测到'}</b></div>`;
        if (data.can_device_info) {
            html += `<div style="font-size:11px;color:#666;margin-left:12px;">${data.can_device_info}</div>`;
        }

        html += `<div>can0接口: <b>${data.can0_exists ? '✅ 存在' : '❌ 不存在'}</b></div>`;
        if (data.can0_state) {
            const stateColor = data.can0_state === 'UP' ? '#4caf50' : '#ff9800';
            html += `<div style="margin-left:12px;">状态: <span style="color:${stateColor};font-weight:600;">${data.can0_state}</span></div>`;
        }
        if (data.can0_bitrate) {
            html += `<div style="margin-left:12px;font-size:11px;color:#666;">${data.can0_bitrate}</div>`;
        }

        if (data.errors && data.errors.length > 0) {
            html += '<div style="margin-top:8px;color:#d32f2f;">';
            html += data.errors.map(e => `<div>❌ ${e}</div>`).join('');
            html += '</div>';
        }

        html += '</div>';
        container.innerHTML = html;
    } catch (error) {
        container.innerHTML = `<p class="empty">诊断失败: ${error.message}</p>`;
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
                const mcuLabel = d.mcu_model ? ` / ${d.mcu_model.toUpperCase()}` : '';
                const freqLabel = d.mcu_freq ? ` @ ${d.mcu_freq}` : '';
                return `
                <div class="id-item">
                    <span class="id-text">
                        <span style="font-weight:600;">${d.uuid}</span>
                        <span style="font-size:11px;color:${appColor};margin-left:8px;">[${appDisplay}${mcuLabel}${freqLabel}]</span>
                        ${d.section ? `<span style="font-size:11px;color:#666;margin-left:6px;">${d.section}</span>` : ''}
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
// 当前已加载的连接模式（用于检测模式切换）
let _loadedConnectionMode = 'local';

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
                } catch (e) {}
            }
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

// ==================== 初始化 ====================
document.addEventListener('DOMContentLoaded', () => {
    // 加载初始页面
    switchPage('resources');
    
});

// 更新资源显示
let _lastSshConnected = null;  // 缓存上一次连接状态，避免重复请求
let _sshStatusCheckInterval = 0;  // 状态检查间隔计数器

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
                    <span>SSH 连接已恢复: ${status.user}@${status.host}:${status.port}</span>
                    <span></span>
                `;
                // 3 秒后切为简洁状态
                setTimeout(() => {
                    if (bar.style.display !== 'none') {
                        content.style.background = 'rgba(76,175,80,0.05)';
                        content.innerHTML = `
                            <span style="color:#4caf50;">SSH 已连接: ${status.user}@${status.host}:${status.port}</span>
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
                    <span>SSH 已连接: ${status.user}@${status.host}:${status.port}</span>
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
                    <span style="font-weight:600;">${modeLabel} 连接已断开: ${status.host}:${status.port}</span>
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
        
        // firmware-tool 是自身服务，只显示重启按钮
        let buttonsHtml;
        if (isSelf) {
            buttonsHtml = `
                <div class="btn-group">
                    <button class="btn btn-sm btn-warning" onclick="controlService('${service.name}', 'restart')">重启</button>
                </div>
            `;
        } else {
            buttonsHtml = `
                <div class="btn-group">
                    <button class="btn btn-sm btn-success" onclick="controlService('${service.name}', 'start')">启动</button>
                    <button class="btn btn-sm btn-danger" onclick="controlService('${service.name}', 'stop')">停止</button>
                    <button class="btn btn-sm btn-warning" onclick="controlService('${service.name}', 'restart')">重启</button>
                </div>
            `;
        }
        
        const div = document.createElement('div');
        div.className = 'service-item';
        div.innerHTML = `
            <span>${service.name} 服务 <span class="${statusClass}">(${statusText})</span></span>
            ${buttonsHtml}
        `;
        container.appendChild(div);
    });
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