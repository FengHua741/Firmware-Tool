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
    } else if (pageId === 'firmware') {
        if (typeof initFirmwarePage === 'function') {
            initFirmwarePage();
        }
    } else if (pageId === 'firmware-update') {
        // 固件更新页面初始化
        console.log('固件更新页面已加载');
    } else if (pageId === 'config') {
        // 配置管理页面初始化
        console.log('配置管理页面已加载');
    } else if (pageId === 'settings') {
        loadSettings();
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
            container.innerHTML = data.uuids.map(d => `
                <div class="id-item">
                    <span class="id-text">
                        <span style="font-weight:600;">${d.uuid}</span>
                        <span style="font-size:11px;color:${d.app === 'Klipper' ? '#4caf50' : d.app === 'Katapult' ? '#ff9800' : '#999'};margin-left:8px;">[${d.app}]</span>
                    </span>
                    <button class="btn btn-sm btn-secondary" onclick="copyToClipboard('${d.uuid}')">复制</button>
                </div>
            `).join('');
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

// ==================== BL固件烧录 ====================

// 初始化 BL 厂家选择
async function initBLManufacturers() {
    try {
        const response = await fetch('/api/firmware/boards');
        const data = await response.json();
        
        const select = document.getElementById('blManufacturerSelect');
        select.innerHTML = '<option value="">请选择厂家...</option>';
        
        if (data.manufacturers) {
            data.manufacturers.forEach(mfr => {
                select.innerHTML += `<option value="${mfr}">${mfr}</option>`;
            });
        }
    } catch (error) {
        console.error('加载BL厂家失败:', error);
    }
}

// BL 厂家改变
async function onBLManufacturerChange() {
    const manufacturer = document.getElementById('blManufacturerSelect').value;
    const typeSelect = document.getElementById('blBoardTypeSelect');
    const firmwareSelect = document.getElementById('blFirmwareSelect');
    
    // 重置下级选择
    firmwareSelect.innerHTML = '<option value="">请先选择主板类型</option>';
    firmwareSelect.disabled = true;
    
    if (!manufacturer) {
        typeSelect.innerHTML = '<option value="">请先选择厂家</option>';
        typeSelect.disabled = true;
        return;
    }
    
    try {
        const response = await fetch('/api/firmware/boards');
        const data = await response.json();
        
        typeSelect.innerHTML = '<option value="">请选择主板类型...</option>';
        
        if (data.boards && data.boards[manufacturer]) {
            const types = Object.keys(data.boards[manufacturer]);
            types.forEach(type => {
                const label = type === 'mainboard' ? '主板' : 
                              type === 'toolboard' ? '工具板' : 
                              type === 'extensionboard' ? '扩展板' : type;
                typeSelect.innerHTML += `<option value="${type}">${label}</option>`;
            });
        }
        
        typeSelect.disabled = false;
    } catch (error) {
        console.error('加载主板类型失败:', error);
    }
}

// BL 主板类型改变
async function onBLBoardTypeChange() {
    const manufacturer = document.getElementById('blManufacturerSelect').value;
    const boardType = document.getElementById('blBoardTypeSelect').value;
    const firmwareSelect = document.getElementById('blFirmwareSelect');
    
    if (!boardType) {
        firmwareSelect.innerHTML = '<option value="">请先选择主板类型</option>';
        firmwareSelect.disabled = true;
        return;
    }
    
    try {
        const response = await fetch(`/api/firmware/bl-firmwares/${manufacturer}/${boardType}`);
        const data = await response.json();
        
        firmwareSelect.innerHTML = '<option value="">请选择BL固件...</option>';
        
        if (data.firmwares && data.firmwares.length > 0) {
            data.firmwares.forEach(fw => {
                firmwareSelect.innerHTML += `<option value="${fw.path}">${fw.name}</option>`;
            });
        } else {
            firmwareSelect.innerHTML = '<option value="">无可用BL固件</option>';
        }
        
        firmwareSelect.disabled = false;
    } catch (error) {
        console.error('加载BL固件失败:', error);
    }
}

// BL 烧录方式改变
function onBLFlashModeChange() {
    // 清空设备列表
    document.getElementById('blDeviceList').innerHTML = '<p class="empty">点击"检测设备"按钮扫描可用设备</p>';
    document.getElementById('blTargetDevice').value = '';
}

async function detectBLDevices() {
    try {
        const response = await fetch('/api/system/ids');
        const data = await response.json();
        
        const container = document.getElementById('blDeviceList');
        const flashMode = document.getElementById('blFlashMode').value;
        
        let devices = [];
        let modeText = '设备';
        
        // 根据烧录模式检测对应类型的设备
        if (flashMode === 'UF2') {
            devices = data.rp_boot || [];
            modeText = 'RP2040 BOOT设备';
        } else {
            devices = data.dfu || [];
            modeText = 'DFU设备';
        }
        
        if (devices.length > 0) {
            container.innerHTML = devices.map(device => {
                const displayText = device.formatted || device.raw || device;
                return `
                    <div class="device-item">
                        <span>${displayText}</span>
                        <button class="btn btn-sm btn-primary" onclick="selectBLDevice('${device.raw || device}')">选择</button>
                    </div>
                `;
            }).join('');
        } else {
            container.innerHTML = `<p class="empty">未找到${modeText}</p>`;
        }
    } catch (error) {
        console.error('检测设备失败:', error);
    }
}

function selectBLDevice(deviceId) {
    document.getElementById('blTargetDevice').value = deviceId;
}

async function flashBLFirmware() {
    if (blFlashInProgress) return;
    
    const firmwarePath = document.getElementById('blFirmwareSelect').value;
    const flashMode = document.getElementById('blFlashMode').value;
    const device = document.getElementById('blTargetDevice').value;
    
    if (!firmwarePath) {
        showError('请选择BL固件');
        return;
    }
    
    // UF2模式不需要设备ID
    if (!device && flashMode !== 'UF2') {
        showError('请选择或输入设备ID');
        return;
    }
    
    blFlashInProgress = true;
    const statusDiv = document.getElementById('blFlashStatus');
    
    statusDiv.innerHTML = '<span class="status-info">正在烧录BL固件...</span>';
    
    try {
        const response = await fetch('/api/firmware/bl/flash', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                bl_firmware_path: firmwarePath,
                flash_mode: flashMode,
                device: device
            })
        });
        
        const data = await response.json();
        
        if (data.success) {
            statusDiv.innerHTML = '<span class="status-success">✅ BL固件烧录成功</span>';
            showSuccess('BL固件烧录成功！');
        } else {
            statusDiv.innerHTML = `<span class="status-error">❌ 烧录失败: ${data.error}</span>`;
        }
    } catch (error) {
        statusDiv.innerHTML = `<span class="status-error">❌ 错误: ${error.message}</span>`;
    } finally {
        blFlashInProgress = false;
    }
}

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
        }
    } catch (error) {
        console.error('加载设置失败:', error);
    }
}

// 加载当前 Web 界面状态
async function loadCurrentWebUI() {
    try {
        const response = await fetch('/api/system/web-ui');
        const data = await response.json();
        
        const currentUI = data.current_ui || 'unknown';
        const statusEl = document.getElementById('currentWebUI');
        const fluiddBtn = document.getElementById('fluiddBtn');
        const mainsailBtn = document.getElementById('mainsailBtn');
        
        if (!statusEl) return;
        
        if (currentUI === 'fluidd') {
            statusEl.textContent = '当前：Fluidd (端口 80)';
            if (fluiddBtn) { fluiddBtn.classList.add('btn-success'); fluiddBtn.classList.remove('btn-primary'); }
            if (mainsailBtn) { mainsailBtn.classList.add('btn-secondary'); mainsailBtn.classList.remove('btn-primary'); }
        } else if (currentUI === 'mainsail') {
            statusEl.textContent = '当前：Mainsail (端口 81)';
            if (mainsailBtn) { mainsailBtn.classList.add('btn-success'); mainsailBtn.classList.remove('btn-secondary'); }
            if (fluiddBtn) { fluiddBtn.classList.add('btn-primary'); fluiddBtn.classList.remove('btn-success'); }
        } else {
            statusEl.textContent = '当前：未检测到';
            if (fluiddBtn) { fluiddBtn.classList.add('btn-primary'); fluiddBtn.classList.remove('btn-success'); }
            if (mainsailBtn) { mainsailBtn.classList.add('btn-secondary'); mainsailBtn.classList.remove('btn-success'); }
        }
    } catch (error) {
        console.error('加载 Web 界面状态失败:', error);
        const statusEl = document.getElementById('currentWebUI');
        if (statusEl) statusEl.textContent = '当前：检测失败';
    }
}

// 切换 Web 界面
async function switchWebUI(target) {
    try {
        const response = await fetch('/api/system/web-ui/switch', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ target: target })
        });
        
        const data = await response.json();
        
        if (data.success) {
            showSuccess(data.message);
            // 延迟刷新状态
            setTimeout(loadCurrentWebUI, 2000);
        } else {
            showError('切换失败：' + data.error);
        }
    } catch (error) {
        showError('切换失败：' + error.message);
    }
}

async function saveSettings() {
    const kp = document.getElementById('settingsKlipperPath');
    const ktp = document.getElementById('settingsKatapultPath');
    const settings = {
        klipper_path: kp ? kp.value : '~/klipper',
        katapult_path: ktp ? ktp.value : '~/katapult'
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

async function updateJsonRepo() {
    const repoUrl = document.getElementById('jsonRepoUrl').value;
    
    if (!repoUrl) {
        showError('请输入JSON仓库地址');
        return;
    }
    
    const statusDiv = document.getElementById('jsonUpdateStatus');
    if (statusDiv) statusDiv.innerHTML = '<span class="status-info">正在保存并更新...</span>';
    
    try {
        // 先保存仓库地址到配置
        const saveResponse = await fetch('/api/settings/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ json_repo_url: repoUrl })
        });
        
        const saveData = await saveResponse.json();
        if (!saveData.success) {
            statusDiv.innerHTML = `<span class="status-error">❌ 保存地址失败: ${saveData.error}</span>`;
            return;
        }
        
        // 然后更新JSON配置
        const response = await fetch('/api/settings/update-json', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ json_repo_url: repoUrl })
        });
        
        const data = await response.json();
        
        if (data.success) {
            statusDiv.innerHTML = '<span class="status-success">✅ ' + data.message + '</span>';
            document.getElementById('lastJsonUpdate').textContent = new Date().toLocaleString();
        } else {
            statusDiv.innerHTML = `<span class="status-error">❌ ${data.error}</span>`;
        }
    } catch (error) {
        statusDiv.innerHTML = `<span class="status-error">❌ 错误: ${error.message}</span>`;
    }
}

async function saveTimezone() {
    const timezone = document.getElementById('timezoneSelect').value;
    
    try {
        const response = await fetch('/api/settings/timezone', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ timezone })
        });
        
        const data = await response.json();
        
        if (data.success) {
            showSuccess('时区已保存');
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
    
    // 初始化 BL 厂家选择
    initBLManufacturers();
});

// ==================== 配置管理功能 ====================

// 导航到配置页面
function navigateToConfigPage() {
    switchPage('config');
}

// 加载配置列表
async function loadConfigList() {
    const manufacturer = document.getElementById('configManufacturer').value;
    const configList = document.getElementById('configList');
    
    try {
        configList.innerHTML = '<p class="empty">加载中...</p>';
        
        const response = await fetch(`/api/config/list/${manufacturer}`);
        const data = await response.json();
        
        if (data.configs && data.configs.length > 0) {
            let html = '';
            data.configs.forEach(config => {
                html += `
                    <div class="config-item">
                        <div class="config-item-info">
                            <div class="config-item-name">${config.name || 'Unnamed'}</div>
                            <div class="config-item-details">
                                ${config.type || 'unknown'} | 
                                ${config.mcu || 'unknown MCU'}
                            </div>
                        </div>
                        <div class="config-item-actions">
                            <button class="btn btn-secondary" onclick="editConfig('${config.id}')">✏️ Edit</button>
                            <button class="btn btn-danger" onclick="deleteConfig('${config.id}')">🗑️ Delete</button>
                        </div>
                    </div>
                `;
            });
            configList.innerHTML = html;
        } else {
            configList.innerHTML = '<p class="empty">No configs yet, please add new config or upload folder</p>';
        }
    } catch (error) {
        configList.innerHTML = `<p class="empty" style="color: var(--danger-color);">加载失败：${error.message}</p>`;
    }
}

// 创建新配置
async function createNewConfig() {
    const manufacturer = document.getElementById('configManufacturer').value;
    const boardName = document.getElementById('boardName').value.trim();
    const productType = document.getElementById('productType').value;
    const mcuModel = document.getElementById('mcuModel').value.trim();
    const crystalFreq = document.getElementById('crystalFreq').value.trim();
    const blOffset = document.getElementById('blOffset').value.trim();
    const bootPins = document.getElementById('bootPins').value.trim();
    const defaultFlash = document.getElementById('defaultFlash').value;
    
    if (!boardName || !mcuModel) {
        showError('请填写产品名称和处理器型号');
        return;
    }
    
    try {
        const configData = {
            'name': boardName,
            'type': productType,
            'mcu': mcuModel,
            'crystal': crystalFreq,
            'bl_offset': blOffset,
            'boot_pins': bootPins,
            'default_flash': defaultFlash,
            'flash_modes': [defaultFlash],
            'id': generateConfigId(boardName)
        };
        
        const response = await fetch(`/api/config/create/${manufacturer}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(configData)
        });
        
        const result = await response.json();
        
        if (result.success) {
            showSuccess('配置创建成功！');
            // 清空表单
            document.getElementById('boardName').value = '';
            document.getElementById('mcuModel').value = '';
            document.getElementById('crystalFreq').value = '';
            document.getElementById('blOffset').value = '';
            document.getElementById('bootPins').value = '';
            // 刷新列表
            loadConfigList();
        } else {
            showError('创建失败：' + result.error);
        }
    } catch (error) {
        showError('创建失败：' + error.message);
    }
}

// 编辑配置
async function editConfig(configId) {
    const manufacturer = document.getElementById('configManufacturer').value;
    
    try {
        const response = await fetch(`/api/config/get/${manufacturer}/${configId}`);
        const config = await response.json();
        
        if (config) {
            // 填充表单
            document.getElementById('boardName').value = config['名称'] || config['name'] || '';
            document.getElementById('productType').value = config['产品类型'] || config['product_type'] || 'mainboard';
            document.getElementById('mcuModel').value = config['处理器'] || config['mcu'] || '';
            document.getElementById('crystalFreq').value = config['晶振'] || config['crystal'] || '';
            document.getElementById('blOffset').value = config['BL 偏移'] || config['bl_offset'] || '';
            document.getElementById('bootPins').value = config['启动引脚'] || config['boot_pins'] || '';
            document.getElementById('defaultFlash').value = config['默认烧录'] || config['default_flash'] || 'UF2';
            
            showSuccess('配置已加载，修改后点击"创建配置"保存');
        }
    } catch (error) {
        showError('加载配置失败：' + error.message);
    }
}

// 删除配置
async function deleteConfig(configId) {
    if (!confirm('确定要删除这个配置吗？')) return;
    
    const manufacturer = document.getElementById('configManufacturer').value;
    
    try {
        const response = await fetch(`/api/config/delete/${manufacturer}/${configId}`, {
            method: 'DELETE'
        });
        
        const result = await response.json();
        
        if (result.success) {
            showSuccess('配置已删除');
            loadConfigList();
        } else {
            showError('删除失败：' + result.error);
        }
    } catch (error) {
        showError('删除失败：' + error.message);
    }
}

// 生成配置 ID
function generateConfigId(name) {
    return name.toLowerCase()
        .replace(/[^a-z0-9]/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');
}

// 文件上传功能
function initUploadArea() {
    const uploadArea = document.getElementById('uploadArea');
    const folderInput = document.getElementById('folderInput');
    
    if (!uploadArea) return;
    
    // 点击上传
    uploadArea.addEventListener('click', () => {
        folderInput.click();
    });
    
    // 文件选择
    folderInput.addEventListener('change', handleFileSelect);
    
    // 拖拽事件
    uploadArea.addEventListener('dragover', (e) => {
        e.preventDefault();
        uploadArea.classList.add('drag-over');
    });
    
    uploadArea.addEventListener('dragleave', () => {
        uploadArea.classList.remove('drag-over');
    });
    
    uploadArea.addEventListener('drop', (e) => {
        e.preventDefault();
        uploadArea.classList.remove('drag-over');
        
        const items = e.dataTransfer.items;
        const files = [];
        
        for (let i = 0; i < items.length; i++) {
            const item = items[i].webkitGetAsEntry();
            if (item) {
                files.push(item);
            }
        }
        
        if (files.length > 0) {
            uploadFiles(files);
        }
    });
}

// 处理文件选择
function handleFileSelect(event) {
    const files = Array.from(event.target.files);
    if (files.length > 0) {
        uploadFilesFromList(files);
    }
}

// 上传文件（拖拽）
async function uploadFiles(fileEntries) {
    const manufacturer = document.getElementById('configManufacturer').value;
    const progressDiv = document.getElementById('uploadProgress');
    const progressBar = progressDiv.querySelector('.progress-bar');
    const statusSpan = document.getElementById('uploadStatus');
    
    progressDiv.style.display = 'block';
    
    try {
        const formData = new FormData();
        formData.append('manufacturer', manufacturer);
        
        // 处理文件树
        for (const entry of fileEntries) {
            await addFileToFormData(entry, '', formData);
        }
        
        statusSpan.textContent = '上传中...';
        
        const response = await fetch('/api/config/upload', {
            method: 'POST',
            body: formData
        });
        
        const result = await response.json();
        
        if (result.success) {
            statusSpan.textContent = `上传成功！${result.uploaded_count} 个文件`;
            progressBar.innerHTML = '<div class="progress-bar-fill" style="width: 100%;"></div>';
            setTimeout(() => {
                progressDiv.style.display = 'none';
                loadConfigList();
            }, 2000);
        } else {
            throw new Error(result.error || '上传失败');
        }
    } catch (error) {
        statusSpan.textContent = `上传失败：${error.message}`;
        progressBar.style.backgroundColor = 'var(--danger-color)';
    }
}

// 上传文件（文件列表）
async function uploadFilesFromList(files) {
    const manufacturer = document.getElementById('configManufacturer').value;
    const progressDiv = document.getElementById('uploadProgress');
    const progressBar = progressDiv.querySelector('.progress-bar');
    const statusSpan = document.getElementById('uploadStatus');
    
    progressDiv.style.display = 'block';
    
    try {
        const formData = new FormData();
        formData.append('manufacturer', manufacturer);
        
        for (const file of files) {
            formData.append('files[]', file);
        }
        
        statusSpan.textContent = '上传中...';
        
        const response = await fetch('/api/config/upload', {
            method: 'POST',
            body: formData
        });
        
        const result = await response.json();
        
        if (result.success) {
            statusSpan.textContent = `上传成功！${result.uploaded_count} 个文件`;
            progressBar.innerHTML = '<div class="progress-bar-fill" style="width: 100%;"></div>';
            setTimeout(() => {
                progressDiv.style.display = 'none';
                loadConfigList();
            }, 2000);
        } else {
            throw new Error(result.error || '上传失败');
        }
    } catch (error) {
        statusSpan.textContent = `上传失败：${error.message}`;
        progressBar.style.backgroundColor = 'var(--danger-color)';
    }
}

// 递归添加文件到 FormData
async function addFileToFormData(entry, path, formData) {
    return new Promise((resolve) => {
        if (entry.isFile) {
            entry.file((file) => {
                formData.append('files[]', file, path + file.name);
                resolve();
            });
        } else if (entry.isDirectory) {
            const dirReader = entry.createReader();
            dirReader.readEntries(async (entries) => {
                for (const childEntry of entries) {
                    await addFileToFormData(childEntry, path + entry.name + '/', formData);
                }
                resolve();
            });
        }
    });
}

// 初始化上传区域
document.addEventListener('DOMContentLoaded', () => {
    initUploadArea();
});

// ==================== MCU 预设选择逻辑 ====================

// MCU 类型改变时触发 - 显示所有支持的型号
function onMCUTypeChange() {
    const mcuType = document.getElementById('mcuType').value;
    const modelSelect = document.getElementById('mcuModelPreset');
    
    // 清空型号选择
    modelSelect.innerHTML = '';
    
    if (!mcuType) {
        modelSelect.innerHTML = '<option value="">-- 先选择主控类型 --</option>';
        return;
    }
    
    // 获取该类型的所有型号列表
    const models = getMCUModels(mcuType);
    
    // 填充型号选项（显示完整列表）
    modelSelect.innerHTML = '<option value="">-- 请选择处理器型号 --</option>';
    models.forEach(model => {
        const option = document.createElement('option');
        option.value = model.id;
        option.textContent = model.name;
        modelSelect.appendChild(option);
    });
    
    showSuccess(`已加载 ${models.length} 个 ${mcuType} 系列型号`);
}

// 选择预设型号后自动填充参数
function onMCUPresetSelect() {
    const mcuType = document.getElementById('mcuType').value;
    const modelId = document.getElementById('mcuModelPreset').value;
    
    if (!mcuType || !modelId) return;
    
    // 获取预设配置
    const preset = getMCUPreset(mcuType, modelId);
    if (!preset) return;
    
    // 自动填充参数
    document.getElementById('mcuModel').value = modelId;
    document.getElementById('crystalFreq').value = preset.crystal;
    document.getElementById('blOffset').value = preset.bl_offset;
    
    // 更新烧录方式选项
    updateFlashModes(preset.flash_modes, preset.default_flash);
    
    showSuccess('已自动填充参数，可手动微调');
}

// 更新烧录方式选项
function updateFlashModes(modes, defaultMode) {
    const select = document.getElementById('defaultFlash');
    select.innerHTML = '';
    
    modes.forEach(mode => {
        const option = document.createElement('option');
        option.value = mode;
        option.textContent = mode;
        if (mode === defaultMode) {
            option.selected = true;
        }
        select.appendChild(option);
    });
}

// 初始化时加载 MCU 预设配置
document.addEventListener('DOMContentLoaded', () => {
    initUploadArea();
    // MCU 预设配置已在 mcu-presets.js 中定义
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
        
        // 更新网络状态
        if (current.network) {
            updateNetworkDisplay(current.network);
        }
        
    } catch (error) {
        console.error('获取系统资源失败:', error);
    }
}

// 页面切换逻辑增强 - 合并多个增强功能
(function() {
    // 保存原始函数（只保存一次）
    const _originalSwitchPage = window.switchPage || function(page) {};
    
    window.switchPage = function(page) {
        // 调用原始函数
        _originalSwitchPage(page);
        
        // 切换到资源页面时更新资源数据
        if (page === 'resources') {
            setTimeout(() => {
                updateResources();
            }, 100);
        }
        
        // 切换到设置页面时加载版本信息
        if (page === 'settings') {
            loadVersionInfo();
        }
    };
})();

// ==================== 固件批量更新功能 ====================

// 全局变量存储选中的主板
let selectedBoards = new Set();

// 厂家改变
async function onUpdateManufacturerChange() {
    const manufacturer = document.getElementById('updateManufacturer').value;
    if (!manufacturer) {
        selectedBoards.clear();
        updateSelectedList();
    }
}

// 加载配置列表
async function loadUpdateConfigs() {
    const manufacturer = document.getElementById('updateManufacturer').value;
    const listDiv = document.getElementById('availableConfigsList');
    
    if (!manufacturer) {
        showError('请选择厂家');
        return;
    }
    
    try {
        listDiv.innerHTML = '<p class="empty">加载中...</p>';
        
        const response = await fetch(`/api/config/list/${manufacturer}`);
        const data = await response.json();
        
        if (data.configs && data.configs.length > 0) {
            let html = '';
            data.configs.forEach(config => {
                const isSelected = selectedBoards.has(config.id);
                html += `
                    <div class="config-item">
                        <div class="config-item-info">
                            <div class="config-item-name">${config.name || '未命名'}</div>
                            <div class="config-item-details">
                                ${config.type || '未知类型'} | 
                                ${config.mcu || config.processor || '未知处理器'}
                            </div>
                        </div>
                        <div class="config-item-actions">
                            <label style="display: flex; align-items: center; gap: 5px;">
                                <input type="checkbox" onchange="toggleBoardSelection('${config.id}', this.checked)" 
                                    ${isSelected ? 'checked' : ''}>
                                选择
                            </label>
                        </div>
                    </div>
                `;
            });
            listDiv.innerHTML = html;
        } else {
            listDiv.innerHTML = '<p class="empty">暂无配置</p>';
        }
    } catch (error) {
        listDiv.innerHTML = `<p class="empty" style="color: var(--danger-color);">加载失败：${error.message}</p>`;
    }
}

// 切换主板选择状态
function toggleBoardSelection(boardId, isChecked) {
    if (isChecked) {
        selectedBoards.add(boardId);
    } else {
        selectedBoards.delete(boardId);
    }
    updateSelectedList();
}

// 更新已选中列表显示
function updateSelectedList() {
    const listDiv = document.getElementById('selectedBoardsList');
    const countSpan = document.getElementById('selectedCount');
    const batchBtn = document.getElementById('batchUpdateBtn');
    
    countSpan.textContent = selectedBoards.size;
    
    if (selectedBoards.size === 0) {
        listDiv.innerHTML = '<p class="empty">暂无选中的主板</p>';
        batchBtn.disabled = true;
    } else {
        let html = '';
        selectedBoards.forEach(id => {
            html += `<div class="board-item"><span>${id}</span></div>`;
        });
        listDiv.innerHTML = html;
        batchBtn.disabled = false;
    }
}

// 批量烧录固件
async function batchUpdateFirmware() {
    if (selectedBoards.size === 0) {
        showError('请选择至少一个主板');
        return;
    }
    
    const progressDiv = document.getElementById('updateProgress');
    const statusSpan = document.getElementById('updateStatus');
    const resultDiv = document.getElementById('updateResult');
    
    if (!confirm(`确定要批量烧录 ${selectedBoards.size} 个主板的固件吗？`)) return;
    
    progressDiv.style.display = 'block';
    resultDiv.innerHTML = '';
    
    let successCount = 0;
    let failCount = 0;
    let results = [];
    
    for (const boardId of selectedBoards) {
        statusSpan.textContent = `正在烧录 ${boardId}... (${successCount + failCount + 1}/${selectedBoards.size})`;
        
        try {
            // TODO: 调用烧录 API
            // 这里模拟烧录过程
            await new Promise(resolve => setTimeout(resolve, 1000));
            
            successCount++;
            results.push({ id: boardId, success: true });
        } catch (error) {
            failCount++;
            results.push({ id: boardId, success: false, error: error.message });
        }
    }
    
    statusSpan.textContent = `烧录完成！成功：${successCount}, 失败：${failCount}`;
    
    // 显示结果
    let resultHtml = '<div class="result-box">';
    results.forEach(r => {
        if (r.success) {
            resultHtml += `<p class="status-success">✅ ${r.id}: 成功</p>`;
        } else {
            resultHtml += `<p class="status-error">❌ ${r.id}: ${r.error || '失败'}</p>`;
        }
    });
    resultHtml += '</div>';
    resultDiv.innerHTML = resultHtml;
    
    showSuccess(`批量烧录完成！成功 ${successCount} 个，失败 ${failCount} 个`);
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