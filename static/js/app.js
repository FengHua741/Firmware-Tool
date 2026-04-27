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

// 加载配置列表

// 创建新配置

// 编辑配置

// 删除配置

// 生成配置 ID

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