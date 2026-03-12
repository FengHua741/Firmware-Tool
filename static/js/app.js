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
        loadManufacturers();
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
    resourceInterval = setInterval(updateResources, 2000);
}

async function updateResources() {
    try {
        const response = await fetch('/api/system/resources');
        const data = await response.json();
        
        if (data.current) {
            document.getElementById('cpuPercent').textContent = `${data.current.cpu.percent}%`;
            document.getElementById('memPercent').textContent = `${data.current.memory.percent}%`;
            document.getElementById('diskPercent').textContent = `${data.current.disk.percent}%`;
            
            // 更新网络IP显示
            updateNetworkDisplay(data.current.network);
        }
    } catch (error) {
        console.error('获取资源信息失败:', error);
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

// ==================== ID搜索 ====================
async function refreshIds() {
    try {
        const response = await fetch('/api/system/ids');
        const data = await response.json();
        
        // USB设备 - 显示formatted格式
        const usbContainer = document.getElementById('usbDevices');
        if (data.usb && data.usb.length > 0) {
            usbContainer.innerHTML = data.usb.map(device => `
                <div class="id-item">
                    <span class="id-text">${device.formatted}</span>
                    <button class="btn btn-sm btn-secondary" onclick="copyToClipboard('${device.formatted}')">复制</button>
                </div>
            `).join('');
        } else {
            usbContainer.innerHTML = '<p class="empty">未找到USB设备</p>';
        }
        
        // CAN设备 - 显示formatted格式
        const canContainer = document.getElementById('canDevices');
        if (data.can && data.can.length > 0) {
            canContainer.innerHTML = data.can.map(device => `
                <div class="id-item">
                    <span class="id-text">${device.formatted}</span>
                    <button class="btn btn-sm btn-secondary" onclick="copyToClipboard('${device.formatted}')">复制</button>
                </div>
            `).join('');
        } else {
            canContainer.innerHTML = '<p class="empty">未找到CAN设备</p>';
        }
        
        // 摄像头设备
        const cameraContainer = document.getElementById('cameraDevices');
        if (data.camera && data.camera.length > 0) {
            cameraContainer.innerHTML = data.camera.map(device => `
                <div class="id-item">
                    <span class="id-text">${device}</span>
                    <button class="btn btn-sm btn-secondary" onclick="copyToClipboard('${device}')">复制</button>
                </div>
            `).join('');
        } else {
            cameraContainer.innerHTML = '<p class="empty">未找到摄像头</p>';
        }
    } catch (error) {
        console.error('获取ID失败:', error);
        showError('获取ID失败: ' + error.message);
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

// ==================== 主板选择（三级结构） ====================
async function loadManufacturers() {
    try {
        const response = await fetch('/api/firmware/manufacturers');
        const data = await response.json();
        
        const select = document.getElementById('manufacturerSelect');
        select.innerHTML = '<option value="">请选择...</option>';
        
        if (data.manufacturers) {
            data.manufacturers.forEach(mfr => {
                select.innerHTML += `<option value="${mfr}">${mfr}</option>`;
            });
        }
        
        // 如果有保存的选择，恢复
        if (compileParams.manufacturer) {
            select.value = compileParams.manufacturer;
            onManufacturerChange();
        }
    } catch (error) {
        console.error('加载厂家失败:', error);
    }
}

function onManufacturerChange() {
    const manufacturer = document.getElementById('manufacturerSelect').value;
    compileParams.manufacturer = manufacturer;
    
    const typeSelect = document.getElementById('boardTypeSelect');
    const modelSelect = document.getElementById('boardModelSelect');
    
    if (!manufacturer) {
        typeSelect.innerHTML = '<option value="">请先选择厂家</option>';
        typeSelect.disabled = true;
        modelSelect.innerHTML = '<option value="">请先选择类型</option>';
        modelSelect.disabled = true;
        return;
    }
    
    // 加载主板类型
    typeSelect.innerHTML = `
        <option value="">请选择...</option>
        <option value="mainboard">主控板</option>
        <option value="toolboard">工具板</option>
        <option value="extensionboard">扩展板</option>
    `;
    typeSelect.disabled = false;
    
    modelSelect.innerHTML = '<option value="">请先选择类型</option>';
    modelSelect.disabled = true;
    
    // 恢复选择
    if (compileParams.boardType) {
        typeSelect.value = compileParams.boardType;
        onBoardTypeChange();
    }
}

function onBoardTypeChange() {
    const manufacturer = document.getElementById('manufacturerSelect').value;
    const boardType = document.getElementById('boardTypeSelect').value;
    compileParams.boardType = boardType;
    
    const modelSelect = document.getElementById('boardModelSelect');
    
    if (!boardType) {
        modelSelect.innerHTML = '<option value="">请先选择类型</option>';
        modelSelect.disabled = true;
        return;
    }
    
    // 加载主板列表
    loadBoardModels(manufacturer, boardType);
}

async function loadBoardModels(manufacturer, boardType) {
    try {
        const response = await fetch('/api/firmware/boards');
        const data = await response.json();
        
        const modelSelect = document.getElementById('boardModelSelect');
        modelSelect.innerHTML = '<option value="">请选择...</option>';
        
        if (data.boards && data.boards[manufacturer] && data.boards[manufacturer][boardType]) {
            const boards = data.boards[manufacturer][boardType];
            for (const [id, config] of Object.entries(boards)) {
                const name = config.name || id;
                modelSelect.innerHTML += `<option value="${id}">${name}</option>`;
            }
        }
        
        modelSelect.disabled = false;
        
        // 恢复选择
        if (compileParams.boardModel) {
            modelSelect.value = compileParams.boardModel;
            onBoardModelChange();
        }
    } catch (error) {
        console.error('加载主板列表失败:', error);
    }
}

function onBoardModelChange() {
    const manufacturer = document.getElementById('manufacturerSelect').value;
    const boardType = document.getElementById('boardTypeSelect').value;
    const boardModel = document.getElementById('boardModelSelect').value;
    
    compileParams.boardModel = boardModel;
    
    if (boardModel) {
        loadBoardConfig(manufacturer, boardType, boardModel);
    }
}

async function loadBoardConfig(manufacturer, boardType, boardId) {
    try {
        const response = await fetch('/api/firmware/boards');
        const data = await response.json();
        
        if (data.boards && data.boards[manufacturer] && data.boards[manufacturer][boardType]) {
            const config = data.boards[manufacturer][boardType][boardId];
            if (config) {
                selectedBoard = config;
                applyBoardConfig(config);
            }
        }
    } catch (error) {
        console.error('加载主板配置失败:', error);
    }
}

function applyBoardConfig(config) {
    // 应用配置到表单
    if (config.mcu) {
        document.getElementById('mcuArch').value = config.mcu;
        onMcuArchChange();
    }
    
    if (config.processor) {
        document.getElementById('processorModel').value = config.processor;
    }
    
    if (config.bootloader_offset) {
        document.getElementById('bootloaderOffset').value = config.bootloader_offset;
    }
    
    if (config.communication) {
        document.getElementById('communication').value = config.communication;
        onCommunicationChange();
    }
    
    if (config.startup_pin) {
        document.getElementById('startupPin').value = config.startup_pin;
    }
}

function onMcuArchChange() {
    const mcuArch = document.getElementById('mcuArch').value;
    const processorSelect = document.getElementById('processorModel');
    
    if (mcuArch === 'Raspberry Pi RP2040') {
        processorSelect.innerHTML = '<option value="RP2040">RP2040</option>';
    } else {
        processorSelect.innerHTML = `
            <option value="STM32F072">STM32F072</option>
            <option value="STM32F103">STM32F103</option>
            <option value="STM32F407">STM32F407</option>
            <option value="STM32F405">STM32F405</option>
            <option value="STM32H723">STM32H723</option>
        `;
    }
}

function onCommunicationChange() {
    const communication = document.getElementById('communication').value;
    const canRow = document.getElementById('canBusInterfaceRow');
    const bitrateRow = document.getElementById('canBitrateRow');
    
    // USB to CAN桥接显示CAN总线接口选择
    if (communication.includes('CAN bus bridge')) {
        canRow.style.display = 'flex';
    } else {
        canRow.style.display = 'none';
    }
    
    // CAN或USB to CAN显示CAN速率选择
    if (communication.includes('CAN')) {
        bitrateRow.style.display = 'block';
    } else {
        bitrateRow.style.display = 'none';
    }
}

function onStartupPinInput(input) {
    const value = input.value;
    const mcuArch = document.getElementById('mcuArch').value;
    
    if (mcuArch === 'Raspberry Pi RP2040') {
        // RP2040引脚小写
        input.value = value.toLowerCase();
    } else {
        // STM32引脚大写
        input.value = value.toUpperCase();
    }
}

// ==================== 固件编译 ====================
async function compileFirmware() {
    if (compileInProgress) return;
    
    const config = {
        mcu: document.getElementById('mcuArch').value,
        processor: document.getElementById('processorModel').value,
        bootloader_offset: document.getElementById('bootloaderOffset').value,
        communication: document.getElementById('communication').value,
        can_bus_interface: document.getElementById('canBusInterface').value,
        startup_pin: document.getElementById('startupPin').value
    };
    
    compileInProgress = true;
    const statusDiv = document.getElementById('compileStatus');
    const logContainer = document.getElementById('compileLog');
    
    statusDiv.innerHTML = '<span class="status-info">正在编译...</span>';
    logContainer.style.display = 'block';
    logContainer.querySelector('pre').textContent = '开始编译...\n';
    
    try {
        const response = await fetch('/api/firmware/compile', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(config)
        });
        
        const data = await response.json();
        
        if (data.success) {
            statusDiv.innerHTML = '<span class="status-success">✅ 编译成功</span>';
            logContainer.querySelector('pre').textContent += '\n编译完成!';
        } else {
            statusDiv.innerHTML = `<span class="status-error">❌ 编译失败: ${data.error}</span>`;
            logContainer.querySelector('pre').textContent += '\n编译失败: ' + data.error;
        }
    } catch (error) {
        statusDiv.innerHTML = `<span class="status-error">❌ 错误: ${error.message}</span>`;
    } finally {
        compileInProgress = false;
    }
}

// ==================== 固件烧录 ====================
function onFlashModeChange() {
    const flashMode = document.getElementById('flashMode').value;
    const dfuGroup = document.getElementById('dfuAddressGroup');
    const scanCanBtn = document.getElementById('scanCanBtn');
    const flashBtn = document.getElementById('flashBtn');
    const downloadBtn = document.getElementById('downloadBtn');
    
    // DFU地址显示
    dfuGroup.style.display = flashMode === 'DFU' ? 'block' : 'none';
    
    // CAN扫描按钮显示
    scanCanBtn.style.display = flashMode === 'CAN' ? 'inline-flex' : 'none';
    
    // TF卡模式显示下载按钮，隐藏烧录按钮
    if (flashMode === 'TF') {
        flashBtn.style.display = 'none';
        downloadBtn.style.display = 'inline-flex';
    } else {
        flashBtn.style.display = 'inline-flex';
        downloadBtn.style.display = 'none';
    }
}

async function detectDevicesForFlash() {
    try {
        const response = await fetch('/api/system/ids');
        const data = await response.json();
        
        const container = document.getElementById('flashDeviceList');
        const flashMode = document.getElementById('flashMode').value;
        
        let devices = [];
        
        if (flashMode === 'CAN') {
            devices = data.can || [];
        } else {
            devices = data.usb || [];
        }
        
        if (devices.length > 0) {
            container.innerHTML = devices.map((device, index) => {
                const displayText = device.formatted || device.raw || device;
                return `
                    <div class="device-item">
                        <span>${displayText}</span>
                        <button class="btn btn-sm btn-primary" onclick="selectDevice('${device.raw || device}')">选择</button>
                    </div>
                `;
            }).join('');
        } else {
            container.innerHTML = '<p class="empty">未找到设备</p>';
        }
    } catch (error) {
        console.error('检测设备失败:', error);
    }
}

async function scanCanDevices() {
    try {
        const response = await fetch('/api/system/ids');
        const data = await response.json();
        
        const container = document.getElementById('canDeviceList');
        container.style.display = 'block';
        
        if (data.can && data.can.length > 0) {
            container.innerHTML = data.can.map(device => `
                <div class="device-item">
                    <span>${device.formatted}</span>
                    <button class="btn btn-sm btn-primary" onclick="selectDevice('${device.raw}')">选择</button>
                </div>
            `).join('');
        } else {
            container.innerHTML = '<p class="empty">未找到CAN设备</p>';
        }
    } catch (error) {
        console.error('扫描CAN设备失败:', error);
    }
}

function selectDevice(deviceId) {
    document.getElementById('targetDevice').value = deviceId;
}

async function flashFirmware() {
    if (flashInProgress) return;
    
    const flashMode = document.getElementById('flashMode').value;
    const device = document.getElementById('targetDevice').value;
    const dfuAddress = document.getElementById('dfuAddress').value;
    
    if (!device && flashMode !== 'TF') {
        showError('请选择或输入设备ID');
        return;
    }
    
    flashInProgress = true;
    const statusDiv = document.getElementById('flashStatus');
    const logContainer = document.getElementById('flashLog');
    
    statusDiv.innerHTML = '<span class="status-info">正在烧录...</span>';
    logContainer.style.display = 'block';
    logContainer.querySelector('pre').textContent = '开始烧录...\n';
    
    try {
        const response = await fetch('/api/firmware/flash', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                flash_mode: flashMode,
                device: device,
                dfu_address: dfuAddress
            })
        });
        
        const data = await response.json();
        
        if (data.success) {
            statusDiv.innerHTML = '<span class="status-success">✅ 烧录成功</span>';
            logContainer.querySelector('pre').textContent += '\n烧录完成!';
        } else {
            statusDiv.innerHTML = `<span class="status-error">❌ 烧录失败: ${data.error}</span>`;
            logContainer.querySelector('pre').textContent += '\n烧录失败: ' + data.error;
        }
    } catch (error) {
        statusDiv.innerHTML = `<span class="status-error">❌ 错误: ${error.message}</span>`;
    } finally {
        flashInProgress = false;
    }
}

async function downloadFirmware() {
    try {
        const response = await fetch('/api/firmware/download');
        const blob = await response.blob();
        
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'firmware.bin';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        window.URL.revokeObjectURL(url);
        
        showSuccess('固件下载成功');
    } catch (error) {
        showError('下载失败: ' + error.message);
    }
}

// ==================== BL固件烧录 ====================
async function loadBLFirmwares() {
    const manufacturer = document.getElementById('manufacturerSelect').value;
    if (!manufacturer) return;
    
    try {
        const response = await fetch(`/api/firmware/bl-firmwares/${manufacturer}`);
        const data = await response.json();
        
        const select = document.getElementById('blFirmwareSelect');
        select.innerHTML = '<option value="">请选择BL固件...</option>';
        
        if (data.firmwares) {
            data.firmwares.forEach(fw => {
                select.innerHTML += `<option value="${fw.path}">${fw.name}</option>`;
            });
        }
    } catch (error) {
        console.error('加载BL固件失败:', error);
    }
}

async function detectBLDevices() {
    try {
        const response = await fetch('/api/system/ids');
        const data = await response.json();
        
        const container = document.getElementById('blDeviceList');
        const devices = data.usb || [];
        
        if (devices.length > 0) {
            container.innerHTML = devices.map(device => `
                <div class="device-item">
                    <span>${device.formatted}</span>
                    <button class="btn btn-sm btn-primary" onclick="selectBLDevice('${device.raw}')">选择</button>
                </div>
            `).join('');
        } else {
            container.innerHTML = '<p class="empty">未找到设备</p>';
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
    
    const blSelect = document.getElementById('blFirmwareSelect').value;
    const blPath = document.getElementById('blFirmwarePath').value;
    const flashMode = document.getElementById('blFlashMode').value;
    const device = document.getElementById('blTargetDevice').value;
    
    const firmwarePath = blSelect || blPath;
    
    if (!firmwarePath) {
        showError('请选择或输入BL固件路径');
        return;
    }
    
    if (!device) {
        showError('请选择或输入设备ID');
        return;
    }
    
    blFlashInProgress = true;
    const statusDiv = document.getElementById('blFlashStatus');
    
    statusDiv.innerHTML = '<span class="status-info">正在烧录BL固件...</span>';
    
    try {
        const response = await fetch('/api/firmware/flash-bl', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                bl_firmware: firmwarePath,
                mode: flashMode,
                device: device
            })
        });
        
        const data = await response.json();
        
        if (data.success) {
            statusDiv.innerHTML = '<span class="status-success">✅ BL固件烧录成功</span>';
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
        const data = await response.json();
        
        if (data.config) {
            document.getElementById('klipperPath').value = data.config.klipper_path || '~/klipper';
            document.getElementById('serverPort').value = data.config.port || 9999;
            document.getElementById('jsonRepoUrl').value = data.config.json_repo_url || '';
            document.getElementById('lastJsonUpdate').textContent = data.config.last_json_update || '从未';
        }
    } catch (error) {
        console.error('加载设置失败:', error);
    }
}

async function saveSettings() {
    const settings = {
        klipper_path: document.getElementById('klipperPath').value,
        port: parseInt(document.getElementById('serverPort').value),
        json_repo_url: document.getElementById('jsonRepoUrl').value
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
    statusDiv.innerHTML = '<span class="status-info">正在保存并更新...</span>';
    
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

// ==================== CAN配置 ====================
async function loadCanConfig() {
    try {
        const response = await fetch('/api/system/can-config');
        const data = await response.json();
        
        const statusDiv = document.getElementById('canConfigStatus');
        const formDiv = document.getElementById('canConfigForm');
        const saveBtn = document.getElementById('saveCanBtn');
        
        if (data.exists) {
            // 后端返回的bitrate已经是M单位（1, 500, 250）或者是完整数值（1000000, 500000, 250000）
            let bitrateStr;
            if (data.bitrate >= 1000000) {
                bitrateStr = (data.bitrate / 1000000) + 'M';
            } else if (data.bitrate >= 1000) {
                bitrateStr = (data.bitrate / 1000) + 'K';
            } else if (data.bitrate === 1) {
                bitrateStr = '1M';
            } else if (data.bitrate === 500) {
                bitrateStr = '500K';
            } else if (data.bitrate === 250) {
                bitrateStr = '250K';
            } else {
                bitrateStr = data.bitrate + 'bps';
            }
            const type = data.type === 'systemd' ? 'systemd-networkd' : '传统interfaces';
            
            statusDiv.innerHTML = `
                <div class="info-grid">
                    <div class="info-item">
                        <span class="info-label">配置状态</span>
                        <span class="info-value">已配置</span>
                    </div>
                    <div class="info-item">
                        <span class="info-label">当前速率</span>
                        <span class="info-value">${bitrateStr}</span>
                    </div>
                    <div class="info-item">
                        <span class="info-label">配置类型</span>
                        <span class="info-value">${type}</span>
                    </div>
                </div>
            `;
            
            // 设置当前速率
            if (data.bitrate) {
                document.getElementById('canBitrate').value = data.bitrate.toString();
            }
            
            formDiv.style.display = 'block';
            saveBtn.style.display = 'inline-flex';
        } else {
            statusDiv.innerHTML = '<p class="empty">未检测到CAN配置</p>';
            formDiv.style.display = 'block';
            saveBtn.style.display = 'inline-flex';
        }
    } catch (error) {
        console.error('加载CAN配置失败:', error);
        document.getElementById('canConfigStatus').innerHTML = 
            '<p class="empty">加载失败: ' + error.message + '</p>';
    }
}

async function saveCanConfig() {
    const bitrate = parseInt(document.getElementById('canBitrate').value);
    const messageDiv = document.getElementById('canConfigMessage');
    
    messageDiv.innerHTML = '<span class="status-info">正在保存...</span>';
    
    try {
        const response = await fetch('/api/system/can-config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                bitrate: bitrate,
                txqueuelen: 1024,
                type: 'systemd'
            })
        });
        
        const data = await response.json();
        
        if (data.success) {
            messageDiv.innerHTML = '<span class="status-success">✅ ' + data.message + '</span>';
            loadCanConfig(); // 刷新状态
        } else {
            messageDiv.innerHTML = `<span class="status-error">❌ ${data.error || data.message}</span>`;
        }
    } catch (error) {
        messageDiv.innerHTML = `<span class="status-error">❌ 保存失败: ${error.message}</span>`;
    }
}

// ==================== CAN网络诊断与修复 ====================
async function diagnoseCanNetwork() {
    const resultDiv = document.getElementById('canDiagnoseResult');
    resultDiv.style.display = 'block';
    resultDiv.innerHTML = '<span class="status-info">🔍 正在诊断CAN网络...</span>';
    
    try {
        const response = await fetch('/api/system/can-diagnose');
        const data = await response.json();
        
        let html = '<div style="background: #f5f5f5; padding: 15px; border-radius: 8px; margin-top: 10px;">';
        html += '<h4>📊 CAN网络诊断结果</h4>';
        
        // 内核支持
        html += `<div style="margin: 8px 0;">
            <span class="info-label">内核CAN支持:</span>
            <span class="info-value" style="color: ${data.kernel_support ? 'green' : 'red'};">
                ${data.kernel_support ? '✅ 支持' : '❌ 不支持'}
            </span>
        </div>`;
        
        // USB CAN设备
        html += `<div style="margin: 8px 0;">
            <span class="info-label">USB CAN设备:</span>
            <span class="info-value" style="color: ${data.can_device_exists ? 'green' : 'red'};">
                ${data.can_device_exists ? '✅ 已连接' : '❌ 未连接'}
            </span>
            ${data.can_device_info ? `<br><small>${data.can_device_info}</small>` : ''}
        </div>`;
        
        // can0接口
        html += `<div style="margin: 8px 0;">
            <span class="info-label">can0接口:</span>
            <span class="info-value" style="color: ${data.can0_exists ? (data.can0_state === 'UP' ? 'green' : 'orange') : 'red'};">
                ${data.can0_exists ? (data.can0_state === 'UP' ? '✅ 正常' : '⚠️ 已停止') : '❌ 不存在'}
            </span>
            ${data.can0_bitrate ? `<br><small>${data.can0_bitrate}</small>` : ''}
        </div>`;
        
        // 错误信息
        if (data.errors && data.errors.length > 0) {
            html += '<div style="margin: 8px 0; color: red;"><strong>⚠️ 检测到的问题:</strong><ul>';
            data.errors.forEach(err => {
                html += `<li>${err}</li>`;
            });
            html += '</ul></div>';
        }
        
        // 建议
        if (!data.can_device_exists) {
            html += '<div style="margin: 8px 0; color: orange;">💡 请检查USB CAN设备（UTOC或刷了CAN桥接固件的主板）是否连接</div>';
        } else if (!data.can0_exists || data.can0_state !== 'UP') {
            html += '<div style="margin: 8px 0; color: orange;">💡 点击"修复网络"按钮尝试修复</div>';
        } else {
            html += '<div style="margin: 8px 0; color: green;">✅ CAN网络正常</div>';
        }
        
        html += '</div>';
        resultDiv.innerHTML = html;
        
    } catch (error) {
        resultDiv.innerHTML = `<span class="status-error">❌ 诊断失败: ${error.message}</span>`;
    }
}

async function repairCanNetwork() {
    const resultDiv = document.getElementById('canDiagnoseResult');
    const bitrate = parseInt(document.getElementById('canBitrate').value) || 1000000;
    
    resultDiv.style.display = 'block';
    resultDiv.innerHTML = '<span class="status-info">🔧 正在修复CAN网络...</span>';
    
    try {
        const response = await fetch('/api/system/can-repair', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                bitrate: bitrate,
                txqueuelen: 1024
            })
        });
        
        const data = await response.json();
        
        let html = '<div style="background: #f5f5f5; padding: 15px; border-radius: 8px; margin-top: 10px;">';
        
        if (data.success) {
            html += '<h4>✅ CAN网络修复完成</h4>';
        } else {
            html += '<h4>❌ CAN网络修复失败</h4>';
        }
        
        // 显示操作日志
        if (data.messages && data.messages.length > 0) {
            html += '<div style="margin: 10px 0;"><strong>操作日志:</strong><ul>';
            data.messages.forEach(msg => {
                html += `<li>${msg}</li>`;
            });
            html += '</ul></div>';
        }
        
        // 错误信息
        if (data.error) {
            html += `<div style="color: red; margin: 10px 0;"><strong>错误:</strong> ${data.error}</div>`;
        }
        
        // 备注
        if (data.note) {
            html += `<div style="color: blue; margin: 10px 0;">💡 ${data.note}</div>`;
        }
        
        html += '</div>';
        resultDiv.innerHTML = html;
        
        // 刷新CAN配置状态
        setTimeout(() => loadCanConfig(), 2000);
        
    } catch (error) {
        resultDiv.innerHTML = `<span class="status-error">❌ 修复失败: ${error.message}</span>`;
    }
}

// ==================== 初始化 ====================
document.addEventListener('DOMContentLoaded', () => {
    // 加载初始页面
    switchPage('resources');
    
    // 绑定BL固件选择
    document.getElementById('manufacturerSelect')?.addEventListener('change', loadBLFirmwares);
});
