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
        onProcessorChange();
    }
    
    if (config.bootloader_offset) {
        document.getElementById('bootloaderOffset').value = config.bootloader_offset;
        onBootloaderOffsetChange();
    }
    
    // 更新通信方式下拉框为产品支持的所有选项
    if (config.communication && Array.isArray(config.communication)) {
        updateCommunicationOptionsFromProduct(config.communication, config.default_comm);
    }
    
    if (config.startup_pin) {
        document.getElementById('startupPin').value = config.startup_pin;
    }
    
    // 保存 can_gpio 配置到全局变量，供 onCommunicationChange 使用
    window.boardCanGpio = config.can_gpio || null;
}

// 根据产品配置更新通信方式选项
function updateCommunicationOptionsFromProduct(communicationList, defaultComm) {
    const commSelect = document.getElementById('communication');
    
    // 生成选项HTML
    commSelect.innerHTML = communicationList.map(comm => 
        `<option value="${comm}">${comm}</option>`
    ).join('');
    
    // 设置默认值
    if (defaultComm && communicationList.includes(defaultComm)) {
        commSelect.value = defaultComm;
    } else if (communicationList.length > 0) {
        commSelect.value = communicationList[0];
    }
    
    // 触发通信接口改变事件
    onCommunicationChange();
}

// Klipper规则缓存
let klipperRules = {};

// 加载Klipper规则
async function loadKlipperRules() {
    try {
        const response = await fetch('/api/firmware/rules');
        if (response.ok) {
            klipperRules = await response.json();
        }
    } catch (error) {
        console.error('加载Klipper规则失败:', error);
    }
}

// 页面加载时初始化
loadKlipperRules();

function onMcuArchChange() {
    const mcuArch = document.getElementById('mcuArch').value;
    const processorSelect = document.getElementById('processorModel');
    
    if (mcuArch === 'Raspberry Pi RP2040/RP235x') {
        processorSelect.innerHTML = `
            <option value="RP2040">RP2040</option>
            <option value="RP2350">RP2350</option>
        `;
    } else {
        processorSelect.innerHTML = `
            <option value="STM32F031">STM32F031</option>
            <option value="STM32F042">STM32F042</option>
            <option value="STM32F070">STM32F070</option>
            <option value="STM32F072">STM32F072</option>
            <option value="STM32F103">STM32F103</option>
            <option value="STM32F207">STM32F207</option>
            <option value="STM32F401">STM32F401</option>
            <option value="STM32F405">STM32F405</option>
            <option value="STM32F407">STM32F407</option>
            <option value="STM32F429">STM32F429</option>
            <option value="STM32F446">STM32F446</option>
            <option value="STM32F765">STM32F765</option>
            <option value="STM32G070">STM32G070</option>
            <option value="STM32G071">STM32G071</option>
            <option value="STM32G0B0">STM32G0B0</option>
            <option value="STM32G0B1">STM32G0B1</option>
            <option value="STM32G431">STM32G431</option>
            <option value="STM32G474">STM32G474</option>
            <option value="STM32H723">STM32H723</option>
            <option value="STM32H743">STM32H743</option>
        `;
    }
    
    // 更新处理器相关选项
    onProcessorChange();
}

// 处理器型号改变时更新选项
function onProcessorChange() {
    const processor = document.getElementById('processorModel').value;
    
    // 更新Bootloader偏移选项
    updateBootloaderOptions(processor);
    
    // 更新通信接口选项
    updateCommunicationOptions(processor);
    
    // 更新BL烧录方式
    updateBLFlashMethods(processor);
    
    // 清空启动引脚，避免不同MCU架构的引脚格式混淆
    document.getElementById('startupPin').value = '';
    
    // 隐藏/显示CAN总线接口（RP2040使用GPIO配置，不需要此选项）
    const isRP2040 = processor === 'RP2040' || processor === 'RP2350';
    const canBusInterfaceRow = document.getElementById('canBusInterfaceRow');
    if (isRP2040) {
        canBusInterfaceRow.style.display = 'none';
    }
}

// 更新Bootloader偏移选项
function updateBootloaderOptions(processor) {
    const blSelect = document.getElementById('bootloaderOffset');
    const rules = klipperRules[processor];
    
    if (rules && rules.bootloader_offsets) {
        blSelect.innerHTML = rules.bootloader_offsets.map(bl => 
            `<option value="${bl.name}">${bl.name}</option>`
        ).join('');
    }
    
    // 触发bootloader偏移改变事件，更新烧录方式
    onBootloaderOffsetChange();
}

// Bootloader偏移改变时自动切换烧录方式
function onBootloaderOffsetChange() {
    const processor = document.getElementById('processorModel').value;
    const bootloaderOffset = document.getElementById('bootloaderOffset').value;
    const flashModeSelect = document.getElementById('flashMode');
    
    // RP2040/RP2350 根据 bootloader 偏移自动选择烧录方式
    if (processor === 'RP2040' || processor === 'RP2350') {
        if (bootloaderOffset === 'No bootloader' || bootloaderOffset.includes('No ')) {
            // 无bootloader -> UF2烧录
            flashModeSelect.value = 'UF2';
        } else if (bootloaderOffset.includes('16KiB') || bootloaderOffset.includes('16K')) {
            // 16KiB bootloader -> Katapult (USB)
            flashModeSelect.value = 'KAT';
        }
        // 触发烧录模式改变事件
        onFlashModeChange();
    }
}

// 更新通信接口选项
function updateCommunicationOptions(processor) {
    const commSelect = document.getElementById('communication');
    const rules = klipperRules[processor];
    
    if (rules && rules.communication_interfaces) {
        commSelect.innerHTML = rules.communication_interfaces.map(comm => 
            `<option value="${comm}">${comm}</option>`
        ).join('');
    }
    
    // 触发通信接口改变事件
    onCommunicationChange();
}

// 更新BL烧录方式
function updateBLFlashMethods(processor) {
    const rules = klipperRules[processor];
    
    // 更新主板配置中的flash_methods
    if (rules && rules.flash_methods) {
        // 保存到全局变量供后续使用
        window.currentFlashMethods = rules.flash_methods;
    }
}

function onCommunicationChange() {
    const communication = document.getElementById('communication').value;
    const canRow = document.getElementById('canBusInterfaceRow');
    const bitrateRow = document.getElementById('canBitrateRow');
    const rp2040CanGpioRow = document.getElementById('rp2040CanGpioRow');
    const rp2040CanGpioTxRow = document.getElementById('rp2040CanGpioTxRow');
    const processor = document.getElementById('processorModel').value;
    const isRP2040 = processor === 'RP2040' || processor === 'RP2350';
    
    // USB to CAN桥接显示CAN总线接口选择（仅STM32，RP2040使用GPIO配置）
    if (communication.includes('CAN bus bridge') && !isRP2040) {
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
    
    // RP2040/RP2350选择CAN bus或USB桥接CAN时显示GPIO配置
    if (isRP2040 && (communication === 'CAN bus' || communication.includes('CAN bus bridge'))) {
        rp2040CanGpioRow.style.display = 'block';
        rp2040CanGpioTxRow.style.display = 'block';
        
        // 如果主板配置了特殊的 can_gpio，自动填充
        if (window.boardCanGpio) {
            document.getElementById('rp2040CanRxGpio').value = window.boardCanGpio.rx;
            document.getElementById('rp2040CanTxGpio').value = window.boardCanGpio.tx;
        } else {
            // 使用默认值
            document.getElementById('rp2040CanRxGpio').value = 4;
            document.getElementById('rp2040CanTxGpio').value = 5;
        }
    } else {
        rp2040CanGpioRow.style.display = 'none';
        rp2040CanGpioTxRow.style.display = 'none';
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
    
    const processor = document.getElementById('processorModel').value;
    const isRP2040 = processor === 'RP2040' || processor === 'RP2350';
    
    const config = {
        mcu_arch: document.getElementById('mcuArch').value,
        processor: processor,
        bootloader_offset: document.getElementById('bootloaderOffset').value,
        communication: document.getElementById('communication').value
    };
    
    // STM32专用参数（CAN总线接口选择）
    if (!isRP2040) {
        config.can_bus_interface = document.getElementById('canBusInterface').value;
    }
    
    // 启动引脚（需验证格式）
    const startupPin = document.getElementById('startupPin').value.trim();
    if (startupPin) {
        // 验证引脚格式与处理器匹配
        const hasSTM32Pin = /P[A-K]\d+/i.test(startupPin);  // PA0, PB9等
        const hasRP2040Pin = /gpio\d+/i.test(startupPin);   // gpio4, gpio5等
        
        if (isRP2040 && hasSTM32Pin && !hasRP2040Pin) {
            alert('RP2040/RP2350启动引脚格式应为gpio开头（如gpio5），当前包含STM32引脚格式');
            return;
        }
        if (!isRP2040 && hasRP2040Pin && !hasSTM32Pin) {
            alert('STM32启动引脚格式应为大写字母+数字（如PA2, PB9），当前包含RP2040引脚格式');
            return;
        }
        config.startup_pin = startupPin;
    }
    
    // RP2040/RP2350 CAN GPIO配置
    if (isRP2040 && (config.communication === 'CAN bus' || config.communication.includes('CAN bus bridge'))) {
        config.rp2040_can_rx_gpio = document.getElementById('rp2040CanRxGpio').value || '4';
        config.rp2040_can_tx_gpio = document.getElementById('rp2040CanTxGpio').value || '5';
    }
    
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
        let modeText = '设备';
        
        if (flashMode === 'CAN') {
            devices = data.can || [];
            modeText = 'CAN设备';
        } else if (flashMode === 'DFU') {
            devices = data.dfu || [];
            modeText = 'DFU设备';
        } else if (flashMode === 'UF2') {
            devices = data.rp_boot || [];
            modeText = 'RP2040 BOOT设备';
        } else {
            devices = data.usb || [];
            modeText = 'USB设备';
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
            container.innerHTML = `<p class="empty">未找到${modeText}</p>`;
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
        const flashMode = document.getElementById('blFlashMode').value;
        
        let devices = [];
        let modeText = '设备';
        
        // 根据烧录模式检测对应类型的设备
        if (flashMode === 'UF2') {
            devices = data.rp_boot || [];
            modeText = 'RP2040 BOOT设备';
        } else if (flashMode === 'DFU') {
            devices = data.dfu || [];
            modeText = 'DFU设备';
        } else {
            devices = data.usb || [];
            modeText = 'USB设备';
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
    
    const blSelect = document.getElementById('blFirmwareSelect').value;
    const blPath = document.getElementById('blFirmwarePath').value;
    const flashMode = document.getElementById('blFlashMode').value;
    const device = document.getElementById('blTargetDevice').value;
    
    const firmwarePath = blSelect || blPath;
    
    if (!firmwarePath) {
        showError('请选择或输入BL固件路径');
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
            document.getElementById('klipperPath').value = config.klipper_path || '~/klipper';
            document.getElementById('serverPort').value = config.port || 9999;
            document.getElementById('jsonRepoUrl').value = config.json_repo_url || '';
            document.getElementById('lastJsonUpdate').textContent = config.last_json_update || '从未';
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
// 自动诊断CAN网络（当未检测到设备时调用）
async function autoDiagnoseCan() {
    const diagnoseDiv = document.getElementById('canAutoDiagnose');
    if (!diagnoseDiv) return;
    
    diagnoseDiv.innerHTML = '<span class="status-info">🔍 正在自动诊断CAN网络...</span>';
    
    try {
        const response = await fetch('/api/system/can-diagnose');
        const data = await response.json();
        
        let html = '<div style="background: #fff3cd; padding: 10px; border-radius: 8px; border-left: 4px solid #ffc107;">';
        html += '<h4 style="margin: 0 0 10px 0; color: #856404;">⚠️ 自动诊断结果</h4>';
        
        // 检查问题
        const issues = [];
        
        if (!data.kernel_support) {
            issues.push('内核不支持CAN');
        }
        
        if (!data.can_device_exists) {
            issues.push('未检测到USB CAN设备，请检查硬件连接');
        }
        
        if (!data.can0_exists) {
            issues.push('can0接口不存在');
        } else if (data.can0_state !== 'UP') {
            issues.push(`can0接口状态: ${data.can0_state}`);
        }
        
        // 显示问题
        if (issues.length > 0) {
            html += '<ul style="margin: 5px 0; color: #856404;">';
            issues.forEach(issue => {
                html += `<li>${issue}</li>`;
            });
            html += '</ul>';
        } else {
            html += '<p style="color: #856404;">CAN网络配置正常，请检查硬件连接</p>';
        }
        
        html += '<p style="margin: 10px 0 0 0; font-size: 12px;">💡 点击"诊断网络"按钮查看详细信息</p>';
        html += '</div>';
        
        diagnoseDiv.innerHTML = html;
        
    } catch (error) {
        diagnoseDiv.innerHTML = '<span class="status-error">❌ 自动诊断失败</span>';
    }
}

async function loadCanConfig() {
    try {
        const response = await fetch('/api/system/can-config');
        const data = await response.json();
        
        const statusDiv = document.getElementById('canConfigStatus');
        const formDiv = document.getElementById('canConfigForm');
        const saveBtn = document.getElementById('saveCanBtn');
        
        if (data.exists) {
            // 后端返回的bitrate已经是完整数值（1000000, 500000, 250000）
            let bitrateStr;
            if (data.bitrate >= 1000000) {
                bitrateStr = (data.bitrate / 1000000) + 'M';
            } else if (data.bitrate >= 1000) {
                bitrateStr = (data.bitrate / 1000) + 'K';
            } else {
                bitrateStr = data.bitrate + 'bps';
            }
            const type = data.type === 'systemd' ? 'systemd-networkd' : '传统interfaces';
            
            // 获取txqueuelen显示值
            const txqueuelen = data.txqueuelen || 1024;
            
            // USB CAN设备数量
            const usbCanCount = data.usb_can_count || 0;
            const usbCanText = usbCanCount > 0 
                ? `<span style="color: green;">检测到 ${usbCanCount} 个USB CAN设备</span>`
                : '<span style="color: orange;">未检测到USB CAN设备</span>';
            
            statusDiv.innerHTML = `
                <div class="info-grid">
                    <div class="info-item">
                        <span class="info-label">CAN检查</span>
                        <span class="info-value">${usbCanText}</span>
                    </div>
                    <div class="info-item">
                        <span class="info-label">当前速率</span>
                        <span class="info-value">${bitrateStr}</span>
                    </div>
                    <div class="info-item">
                        <span class="info-label">CAN缓存</span>
                        <span class="info-value">${txqueuelen}</span>
                    </div>
                    <div class="info-item">
                        <span class="info-label">配置类型</span>
                        <span class="info-value">${type}</span>
                    </div>
                </div>
                <div id="canAutoDiagnose" style="margin-top: 10px;"></div>
            `;
            
            // 如果未检测到USB CAN设备，自动进行诊断
            if (usbCanCount === 0) {
                autoDiagnoseCan();
            }
            
            // 设置当前速率
            if (data.bitrate) {
                document.getElementById('canBitrate').value = data.bitrate.toString();
            }
            // 设置当前txqueuelen
            document.getElementById('canTxqueuelen').value = txqueuelen.toString();
            
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
    const txqueuelen = parseInt(document.getElementById('canTxqueuelen').value) || 1024;
    const messageDiv = document.getElementById('canConfigMessage');
    
    // 隐藏诊断结果，避免重叠
    document.getElementById('canDiagnoseResult').style.display = 'none';
    
    messageDiv.innerHTML = '<span class="status-info">正在保存...</span>';
    
    try {
        const response = await fetch('/api/system/can-config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                bitrate: bitrate,
                txqueuelen: txqueuelen,
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
    const messageDiv = document.getElementById('canConfigMessage');
    
    // 隐藏配置消息，避免重叠
    messageDiv.innerHTML = '';
    
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
    const messageDiv = document.getElementById('canConfigMessage');
    const bitrate = parseInt(document.getElementById('canBitrate').value) || 1000000;
    const txqueuelen = parseInt(document.getElementById('canTxqueuelen').value) || 1024;
    
    // 隐藏配置消息，避免重叠
    messageDiv.innerHTML = '';
    
    resultDiv.style.display = 'block';
    resultDiv.innerHTML = '<span class="status-info">🔧 正在修复CAN网络...</span>';
    
    try {
        const response = await fetch('/api/system/can-repair', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                bitrate: bitrate,
                txqueuelen: txqueuelen
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
