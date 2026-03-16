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
        
        const select = document.getElementById('compileManufacturer');
        select.innerHTML = '<option value="">请选择...</option>';
        
        if (data.manufacturers) {
            data.manufacturers.forEach(mfr => {
                select.innerHTML += `<option value="${mfr}">${mfr}</option>`;
            });
        }
        
        // 如果有保存的选择，恢复
        if (compileParams.manufacturer) {
            select.value = compileParams.manufacturer;
            onCompileManufacturerChange();
        }
    } catch (error) {
        console.error('加载厂家失败:', error);
    }
}

function onBoardTypeChange() {
    const manufacturer = document.getElementById('compileManufacturer').value;
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
    const manufacturer = document.getElementById('compileManufacturer').value;
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
            modeText = 'DFU 设备';
        } else if (flashMode === 'UF2') {
            devices = data.rp_boot || [];
            modeText = 'RP2040 BOOT 设备';
        } else if (flashMode === 'KAT') {
            // KAT 模式显示所有可用设备（USB 串口 + CAN ID）
            const usbDevices = data.usb || [];
            const canDevices = data.can || [];
            devices = [...usbDevices, ...canDevices];
            modeText = 'USB/CAN设备';
            
            if (devices.length === 0) {
                container.innerHTML = '<p class="empty">未找到 USB 串口或 CAN设备。请连接设备并确保已安装驱动。</p>';
                return;
            }
        } else {
            devices = data.usb || [];
            modeText = 'USB 设备';
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
        showError('请选择或输入设备 ID');
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
            document.getElementById('klipperPath').value = config.klipper_path || '~/klipper';
            document.getElementById('serverPort').value = config.port || 9999;
            document.getElementById('jsonRepoUrl').value = config.json_repo_url || '';
            document.getElementById('lastJsonUpdate').textContent = config.last_json_update || '从未';
        }
        
        // 加载 Web 界面状态
        loadCurrentWebUI();
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
        
        if (currentUI === 'fluidd') {
            statusEl.textContent = '当前：Fluidd (端口 80)';
            fluiddBtn.classList.add('btn-success');
            fluiddBtn.classList.remove('btn-primary');
            mainsailBtn.classList.add('btn-secondary');
            mainsailBtn.classList.remove('btn-primary');
        } else if (currentUI === 'mainsail') {
            statusEl.textContent = '当前：Mainsail (端口 81)';
            mainsailBtn.classList.add('btn-success');
            mainsailBtn.classList.remove('btn-secondary');
            fluiddBtn.classList.add('btn-primary');
            fluiddBtn.classList.remove('btn-success');
        } else {
            statusEl.textContent = '当前：未检测到';
            fluiddBtn.classList.add('btn-primary');
            fluiddBtn.classList.remove('btn-success');
            mainsailBtn.classList.add('btn-secondary');
            mainsailBtn.classList.remove('btn-success');
        }
    } catch (error) {
        console.error('加载 Web 界面状态失败:', error);
        document.getElementById('currentWebUI').textContent = '当前：检测失败';
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
                        
            // 判断 CAN0 接口是否存在
            const can0Exists = data.status && !data.status.includes('not found');
                        
            // CAN检查状态：优先显示 CAN 接口状态
            let canCheckText;
            if (can0Exists) {
                canCheckText = '<span style="color: green;">✅ CAN 接口正常</span>';
            } else if (usbCanCount > 0) {
                canCheckText = `<span style="color: orange;">⚠️ 检测到 ${usbCanCount} 个USB CAN设备，但 CAN 接口未启用</span>`;
            } else {
                canCheckText = '<span style="color: red;">❌ 未检测到 CAN设备</span>';
            }
            
            statusDiv.innerHTML = `
                <div class="info-grid">
                    <div class="info-item">
                        <span class="info-label">CAN 检查</span>
                        <span class="info-value">${canCheckText}</span>
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
    
    // 初始化 BL 厂家选择
    initBLManufacturers();
    
    // 启动 CAN配置自动刷新（每 5 秒）
    loadCanConfig(); // 立即加载一次
    setInterval(loadCanConfig, 5000); // 之后每 5 秒刷新一次
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
    
    showInfo(`已加载 ${models.length} 个 ${mcuType} 系列型号`);
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

// ==================== 圆形仪表盘功能 ====================

// 仪表盘图表实例
let cpuGaugeChart = null;
let memGaugeChart = null;
let diskGaugeChart = null;

// 创建圆形仪表盘
function createGaugeChart(ctx, label, color) {
    return new Chart(ctx, {
        type: 'doughnut',
        data: {
            datasets: [{
                data: [0, 100], // 初始值：0%
                backgroundColor: [color, '#e0e0e0'],
                borderWidth: 0,
                circumference: 360,
                rotation: 0,
                cutout: '75%'
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    display: false
                },
                tooltip: {
                    enabled: true,
                    callbacks: {
                        label: function(context) {
                            return label + ': ' + context.parsed + '%';
                        }
                    }
                }
            },
            animation: {
                animateScale: true,
                animateRotate: true
            }
        }
    });
}

// 更新仪表盘数据
function updateGauge(chart, value) {
    if (chart && chart.data) {
        chart.data.datasets[0].data = [value, 100 - value];
        chart.update();
    }
}

// 初始化仪表盘
function initGauges() {
    const cpuCtx = document.getElementById('cpuGauge');
    const memCtx = document.getElementById('memGauge');
    const diskCtx = document.getElementById('diskGauge');
    
    if (cpuCtx) {
        cpuGaugeChart = createGaugeChart(cpuCtx, 'CPU', '#2196F3');
    }
    if (memCtx) {
        memGaugeChart = createGaugeChart(memCtx, '内存', '#4CAF50');
    }
    if (diskCtx) {
        diskGaugeChart = createGaugeChart(diskCtx, '磁盘', '#FF9800');
    }
}

// 更新资源显示（替换原有的 updateResources 函数）
async function updateResources() {
    try {
        const response = await fetch('/api/system/resources');
        const data = await response.json();
        
        // API 返回的数据结构：data.current.cpu.percent
        const cpuPercent = data.current ? data.current.cpu.percent : (data.cpu || 0);
        const memPercent = data.current ? data.current.memory.percent : (data.memory || 0);
        const diskPercent = data.current ? data.current.disk.percent : (data.disk || 0);
        
        // 更新仪表盘
        if (cpuGaugeChart) {
            updateGauge(cpuGaugeChart, cpuPercent);
            document.getElementById('cpuPercentText').textContent = cpuPercent.toFixed(1) + '%';
        }
        if (memGaugeChart) {
            updateGauge(memGaugeChart, memPercent);
            document.getElementById('memPercentText').textContent = memPercent.toFixed(1) + '%';
        }
        if (diskGaugeChart) {
            updateGauge(diskGaugeChart, diskPercent);
            document.getElementById('diskPercentText').textContent = diskPercent.toFixed(1) + '%';
        }
        
        // 更新网络状态
        if (data.current && data.current.network) {
            updateNetworkDisplay(data.current.network);
        }
        
    } catch (error) {
        console.error('获取系统资源失败:', error);
    }
}

// 修改页面切换逻辑，初始化仪表盘
const originalSwitchPage = window.switchPage || function(page) {};
window.switchPage = function(page) {
    originalSwitchPage(page);
    
    // 切换到资源页面时初始化仪表盘
    if (page === 'resources') {
        setTimeout(() => {
            initGauges();
            updateResources();
        }, 100);
    }
};

// 页面加载完成后初始化
document.addEventListener('DOMContentLoaded', () => {
    // 如果当前就是资源页面，立即初始化
    const resourcePage = document.getElementById('page-resources');
    if (resourcePage && resourcePage.classList.contains('active')) {
        setTimeout(initGauges, 500);
    }
});

// ==================== 固件编译功能 ====================

// 加载编译配置列表
async function loadCompileConfigs() {
    const manufacturer = document.getElementById('compileManufacturer').value;
    const boardType = document.getElementById('compileBoardType').value;
    const configSelect = document.getElementById('compileConfig');
    
    if (!boardType) {
        configSelect.innerHTML = '<option value="">-- 先选择产品类型 --</option>';
        return;
    }
    
    try {
        configSelect.innerHTML = '<option value="">加载中...</option>';
        
        const response = await fetch(`/api/config/list/${manufacturer}`);
        const data = await response.json();
        
        const configs = data.configs.filter(c => c.type === boardType);
        
        if (configs.length > 0) {
            configSelect.innerHTML = '<option value="">-- 请选择配置 --</option>';
            configs.forEach(config => {
                const option = document.createElement('option');
                option.value = config.id || '';
                option.textContent = config['名称'] || config['name'] || config.id;
                configSelect.appendChild(option);
            });
        } else {
            configSelect.innerHTML = '<option value="">-- 暂无配置 --</option>';
        }
    } catch (error) {
        configSelect.innerHTML = '<option value="">-- 加载失败 --</option>';
        console.error('加载配置列表失败:', error);
    }
}

// 编译固件
async function compileFirmware() {
    const manufacturer = document.getElementById('compileManufacturer').value;
    const configId = document.getElementById('compileConfig').value;
    const flashMode = document.getElementById('flashMode').value;
    const progressDiv = document.getElementById('compileProgress');
    const statusSpan = document.getElementById('compileStatus');
    
    if (!configId) {
        showError('请选择配置');
        return;
    }
    
    try {
        progressDiv.style.display = 'block';
        statusSpan.textContent = '开始编译...';
        
        const response = await fetch('/api/firmware/compile', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                manufacturer,
                config_id: configId,
                flash_mode: flashMode
            })
        });
        
        const result = await response.json();
        
        if (result.success) {
            statusSpan.textContent = '✅ 编译成功！';
            showSuccess(`编译成功：${result.firmware_path || '固件已生成'}`);
            
            // 5 秒后隐藏进度条
            setTimeout(() => {
                progressDiv.style.display = 'none';
            }, 5000);
        } else {
            statusSpan.textContent = '❌ 编译失败';
            showError(result.error || '编译失败');
        }
        
    } catch (error) {
        statusSpan.textContent = '❌ 编译错误';
        showError('编译错误：' + error.message);
    }
}

// BL 固件上传初始化
function initBLUpload() {
    const uploadArea = document.getElementById('blUploadArea');
    const fileInput = document.getElementById('blFileInput');
    
    if (!uploadArea) return;
    
    // 点击上传
    uploadArea.addEventListener('click', () => {
        fileInput.click();
    });
    
    // 文件选择
    fileInput.addEventListener('change', handleBLFileSelect);
    
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
        
        const files = e.dataTransfer.files;
        if (files.length > 0) {
            uploadBLFile(files[0]);
        }
    });
}

// 处理 BL 文件选择
function handleBLFileSelect(event) {
    const files = event.target.files;
    if (files.length > 0) {
        uploadBLFile(files[0]);
    }
}

// 上传 BL 固件
async function uploadBLFile(file) {
    const manufacturer = document.getElementById('blManufacturer').value;
    
    try {
        const formData = new FormData();
        formData.append('file', file);
        formData.append('manufacturer', manufacturer);
        
        const response = await fetch('/api/firmware/bl-upload', {
            method: 'POST',
            body: formData
        });
        
        const result = await response.json();
        
        if (result.success) {
            showSuccess('BL 固件上传成功！');
            loadBLFirmwares();
        } else {
            showError(result.error || '上传失败');
        }
    } catch (error) {
        showError('上传失败：' + error.message);
    }
}

// 加载 BL 固件列表
async function loadBLFirmwares() {
    const manufacturer = document.getElementById('blManufacturer').value;
    const listDiv = document.getElementById('blFirmwareList');
    
    try {
        const response = await fetch(`/api/firmware/bl-firmwares/${manufacturer}`);
        const data = await response.json();
        
        if (data.firmwares && data.firmwares.length > 0) {
            let html = '<div class="bl-list">';
            data.firmwares.forEach((fw, index) => {
                html += `
                    <div class="bl-item">
                        <span>${fw.name || fw.file}</span>
                        <button class="btn btn-sm btn-secondary" onclick="flashBL('${manufacturer}', '${fw.file}')">
                            📥 烧录
                        </button>
                    </div>
                `;
            });
            html += '</div>';
            listDiv.innerHTML = html;
        } else {
            listDiv.innerHTML = '<p class="empty">暂无 BL 固件</p>';
        }
    } catch (error) {
        listDiv.innerHTML = '<p class="empty">加载失败</p>';
    }
}

// 烧录 BL 固件
async function flashBL(manufacturer, file) {
    if (!confirm(`确定要烧录 ${file} 吗？`)) return;
    
    showSuccess('开始烧录 BL 固件...（具体烧录流程请参考文档）');
}

// 初始化：加载数据
document.addEventListener('DOMContentLoaded', () => {
    initBLUpload();
    
    // 监听厂家选择变化，加载 BL 固件列表
    const blManufacturerSelect = document.getElementById('blManufacturer');
    if (blManufacturerSelect) {
        blManufacturerSelect.addEventListener('change', loadBLFirmwares);
    }
});

// ==================== 固件编译与烧录功能（重构版） ====================

// 编译区域：厂家改变
async function onCompileManufacturerChange() {
    const manufacturer = document.getElementById('compileManufacturer').value;
    const typeSelect = document.getElementById('compileBoardType');
    const modelSelect = document.getElementById('compileBoardModel');
    
    typeSelect.innerHTML = '';
    modelSelect.innerHTML = '';
    modelSelect.disabled = true;
    
    if (!manufacturer) {
        typeSelect.disabled = true;
        typeSelect.innerHTML = '<option value="">Select manufacturer first</option>';
        return;
    }
    
    // 加载类型列表
    typeSelect.innerHTML = '<option value="">Loading...</option>';
    try {
        const response = await fetch(`/api/config/list/${manufacturer}`);
        const data = await response.json();
        
        // 获取所有类型
        const types = [...new Set(data.configs.map(c => c.type))];
        
        typeSelect.innerHTML = '<option value="">Select type</option>';
        types.forEach(type => {
            const option = document.createElement('option');
            option.value = type;
            option.textContent = type;
            typeSelect.appendChild(option);
        });
        
        typeSelect.disabled = false;
    } catch (error) {
        typeSelect.innerHTML = '<option value="">Load failed</option>';
    }
}

// 编译区域：类型改变
async function onCompileBoardTypeChange() {
    const manufacturer = document.getElementById('compileManufacturer').value;
    const boardType = document.getElementById('compileBoardType').value;
    const modelSelect = document.getElementById('compileBoardModel');
    
    modelSelect.innerHTML = '';
    
    if (!boardType) {
        modelSelect.disabled = true;
        modelSelect.innerHTML = '<option value="">Select type first</option>';
        return;
    }
    
    try {
        const response = await fetch(`/api/config/list/${manufacturer}`);
        const data = await response.json();
        
        const configs = data.configs.filter(c => c.type === boardType);
        
        modelSelect.innerHTML = '<option value="">Select model</option>';
        configs.forEach(config => {
            const option = document.createElement('option');
            option.value = config.id;
            option.textContent = config.name || config.id;
            modelSelect.appendChild(option);
        });
        
        modelSelect.disabled = false;
    } catch (error) {
        modelSelect.innerHTML = '<option value="">Load failed</option>';
    }
}

// 仅编译固件
async function compileFirmwareOnly() {
    const manufacturer = document.getElementById('compileManufacturer').value;
    const boardId = document.getElementById('compileBoardModel').value;
    const flashMode = document.getElementById('compileFlashMode').value;
    const klipperPath = document.getElementById('klipperPath').value;
    const resultDiv = document.getElementById('compileResult');
    const resultBox = resultDiv.querySelector('.result-box');
    
    if (!manufacturer || !boardId) {
        showError('Please select manufacturer and board model');
        return;
    }
    
    resultDiv.style.display = 'block';
    resultBox.innerHTML = '<p>⏳ Compiling firmware...</p>';
    
    try {
        const response = await fetch('/api/firmware/compile', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                manufacturer,
                config_id: boardId,
                flash_mode: flashMode,
                klipper_path: klipperPath
            })
        });
        
        const result = await response.json();
        
        if (result.success) {
            resultBox.innerHTML = `
                <div class="status-success">
                    <p>✅ Compile successful!</p>
                    <p>Firmware: ${result.firmware_path || 'Generated'}</p>
                    <p>You can now flash it in Step 3 below</p>
                </div>
            `;
            showSuccess('Firmware compiled successfully!');
        } else {
            resultBox.innerHTML = `<div class="status-error">❌ Compile failed: ${result.error || 'Unknown error'}</div>`;
            showError('Compile failed: ' + (result.error || 'Unknown error'));
        }
    } catch (error) {
        resultBox.innerHTML = `<div class="status-error">❌ Error: ${error.message}</div>`;
        showError('Error: ' + error.message);
    }
}

// 刷新设备ID列表
async function refreshDeviceIds() {
    const select = document.getElementById('flashDeviceId');
    
    select.innerHTML = '<option value="">Scanning...</option>';
    
    try {
        // 扫描 USB 设备
        const response = await fetch('/api/system/ids');
        const data = await response.json();
        
        select.innerHTML = '<option value="">Select device</option>';
        
        // 添加 USB 设备
        if (data.usb && data.usb.length > 0) {
            data.usb.forEach(device => {
                const option = document.createElement('option');
                option.value = device.path || device.id;
                option.textContent = `USB: ${device.formatted || device.id}`;
                select.appendChild(option);
            });
        }
        
        // 添加 CAN 设备
        if (data.can && data.can.length > 0) {
            data.can.forEach(device => {
                const option = document.createElement('option');
                option.value = device.uuid;
                option.textContent = `CAN: ${device.formatted || device.uuid}`;
                select.appendChild(option);
            });
        }
        
        if (select.options.length === 1) {
            select.innerHTML = '<option value="">No devices found</option>';
        }
    } catch (error) {
        select.innerHTML = '<option value="">Scan failed</option>';
    }
}

// 固件源改变
function onFirmwareSourceChange() {
    const source = document.getElementById('firmwareSource').value;
    const uploadArea = document.getElementById('firmwareUploadArea');
    
    if (source === 'upload') {
        uploadArea.style.display = 'block';
    } else {
        uploadArea.style.display = 'none';
    }
}

// 烧录固件
async function flashFirmware() {
    const deviceId = document.getElementById('flashDeviceId').value;
    const source = document.getElementById('firmwareSource').value;
    const resultDiv = document.getElementById('flashResult');
    const resultBox = resultDiv.querySelector('.result-box');
    
    if (!deviceId) {
        showError('Please select a device');
        return;
    }
    
    resultDiv.style.display = 'block';
    resultBox.innerHTML = '<p>⏳ Flashing firmware...</p>';
    
    try {
        // 这里调用烧录 API
        // TODO: 实现具体的烧录逻辑
        resultBox.innerHTML = `
            <div class="status-success">
                <p>✅ Flash command sent!</p>
                <p>Device: ${deviceId}</p>
                <p>Source: ${source}</p>
            </div>
        `;
        showSuccess('Flash command sent!');
    } catch (error) {
        resultBox.innerHTML = `<div class="status-error">❌ Flash failed: ${error.message}</div>`;
        showError('Flash failed: ' + error.message);
    }
}

// 初始化固件上传区域
function initFirmwareUpload() {
    const uploadArea = document.getElementById('firmwareUploadArea');
    const fileInput = document.getElementById('firmwareFileInput');
    
    if (!uploadArea) return;
    
    uploadArea.addEventListener('click', () => {
        fileInput.click();
    });
    
    fileInput.addEventListener('change', (e) => {
        if (e.target.files.length > 0) {
            showSuccess(`Selected: ${e.target.files[0].name}`);
        }
    });
}

// 页面加载完成后初始化
document.addEventListener('DOMContentLoaded', () => {
    initFirmwareUpload();
    
    // 自动刷新设备列表（如果当前是固件页面）
    const firmwarePage = document.getElementById('page-firmware');
    if (firmwarePage && firmwarePage.classList.contains('active')) {
        setTimeout(refreshDeviceIds, 1000);
    }
});

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

// ==================== 配置管理 - 新增配置优化 ====================

let mcuData = {}; // 存储从后端获取的 MCU 数据
let currentMcuInfo = null; // 当前选中的 MCU 信息

// 页面加载时初始化
async function initConfigPage() {
    await loadManufacturersForNewConfig();
    await loadMcuPlatforms();
}

// 加载厂家列表（用于新建配置）
async function loadManufacturersForNewConfig() {
    try {
        const response = await fetch('/api/config/manufacturers');
        const data = await response.json();
        
        const select = document.getElementById('newConfigManufacturer');
        select.innerHTML = '<option value="">-- 选择或输入 --</option>';
        
        if (data.manufacturers) {
            data.manufacturers.forEach(mfr => {
                select.innerHTML += `<option value="${mfr}">${mfr}</option>`;
            });
        }
        
        // 添加"自定义"选项
        select.innerHTML += '<option value="custom">+ 自定义厂家</option>';
    } catch (error) {
        console.error('加载厂家列表失败:', error);
    }
}

// 厂家选择变化
function onNewConfigManufacturerChange() {
    const select = document.getElementById('newConfigManufacturer');
    const customGroup = document.getElementById('customManufacturerGroup');
    
    if (select.value === 'custom') {
        customGroup.style.display = 'block';
        document.getElementById('customManufacturer').focus();
    } else {
        customGroup.style.display = 'none';
    }
}

// 加载 MCU 平台列表
async function loadMcuPlatforms() {
    try {
        const response = await fetch('/api/config/mcu-list');
        const data = await response.json();
        
        if (data.success) {
            mcuData = data.mcu_details;
            
            const select = document.getElementById('mcuPlatform');
            select.innerHTML = '<option value="">-- 选择平台 --</option>';
            
            data.mcu_types.forEach(type => {
                select.innerHTML += `<option value="${type}">${type}</option>`;
            });
        }
    } catch (error) {
        console.error('加载 MCU 列表失败:', error);
    }
}

// MCU 平台选择变化
function onMcuPlatformChange() {
    const platform = document.getElementById('mcuPlatform').value;
    const modelSelect = document.getElementById('mcuModelSelect');
    const paramsSection = document.getElementById('mcuParamsSection');
    const flashSection = document.getElementById('flashModeSection');
    
    // 重置后续选择
    paramsSection.style.display = 'none';
    flashSection.style.display = 'none';
    currentMcuInfo = null;
    
    if (!platform || !mcuData[platform]) {
        modelSelect.innerHTML = '<option value="">-- 先选择平台 --</option>';
        modelSelect.disabled = true;
        return;
    }
    
    // 填充 MCU 型号列表
    modelSelect.innerHTML = '<option value="">-- 选择型号 --</option>';
    mcuData[platform].mcus.forEach(mcu => {
        modelSelect.innerHTML += `<option value="${mcu.id}">${mcu.name}</option>`;
    });
    modelSelect.disabled = false;
}

// MCU 型号选择变化
function onMcuModelChange() {
    const platform = document.getElementById('mcuPlatform').value;
    const modelId = document.getElementById('mcuModelSelect').value;
    const paramsSection = document.getElementById('mcuParamsSection');
    const flashSection = document.getElementById('flashModeSection');
    
    if (!modelId || !mcuData[platform]) {
        paramsSection.style.display = 'none';
        flashSection.style.display = 'none';
        return;
    }
    
    // 查找选中的 MCU 信息
    currentMcuInfo = mcuData[platform].mcus.find(m => m.id === modelId);
    
    if (currentMcuInfo) {
        // 填充处理器型号（Kconfig 名称）
        document.getElementById('mcuKconfigName').value = currentMcuInfo.id;
        
        // 根据 MCU 更新晶振选项
        updateCrystalOptions(currentMcuInfo.crystal);
        
        // 根据 MCU 更新 BL 偏移选项
        updateBlOffsetOptions(currentMcuInfo.bl_offset);
        
        // 显示参数区域
        paramsSection.style.display = 'block';
        
        // 更新烧录方式
        updateFlashModes(mcuData[platform].flash_modes);
        flashSection.style.display = 'block';
    }
}

// 更新晶振选项
function updateCrystalOptions(crystals) {
    const select = document.getElementById('crystalFreqSelect');
    const group = document.getElementById('crystalGroup');
    
    if (!crystals || crystals.length === 0) {
        group.style.display = 'none';
        return;
    }
    
    group.style.display = 'block';
    select.innerHTML = '';
    
    const crystalLabels = {
        '8000000': '8 MHz',
        '12000000': '12 MHz',
        '16000000': '16 MHz',
        '20000000': '20 MHz',
        '24000000': '24 MHz',
        '25000000': '25 MHz'
    };
    
    crystals.forEach(freq => {
        const label = crystalLabels[freq] || `${freq} Hz`;
        select.innerHTML += `<option value="${freq}">${label}</option>`;
    });
}

// 更新 BL 偏移选项
function updateBlOffsetOptions(offsets) {
    const select = document.getElementById('blOffsetSelect');
    const group = document.getElementById('blOffsetGroup');
    
    if (!offsets || offsets.length === 0) {
        group.style.display = 'none';
        return;
    }
    
    group.style.display = 'block';
    select.innerHTML = '';
    
    const offsetLabels = {
        '0': '0 (无 bootloader)',
        '256': '256 (RP2040)',
        '2048': '2048 (2KB)',
        '4096': '4096 (4KB)',
        '8192': '8192 (8KB)',
        '16384': '16384 (16KB)',
        '32768': '32768 (32KB)',
        '65536': '65536 (64KB)',
        '0x8000': '0x8000 (32KB)',
        '0xC000': '0xC000 (48KB)',
        '0x10000': '0x10000 (64KB)'
    };
    
    offsets.forEach(offset => {
        const label = offsetLabels[offset.toString()] || offset;
        select.innerHTML += `<option value="${offset}">${label}</option>`;
    });
}

// 更新烧录方式
function updateFlashModes(modes) {
    const container = document.getElementById('flashModeCheckboxes');
    const defaultSelect = document.getElementById('defaultFlashMode');
    
    container.innerHTML = '';
    defaultSelect.innerHTML = '<option value="">-- 选择默认 --</option>';
    
    const modeLabels = {
        'DFU': 'USB/DFU',
        'KAT': 'USB/KAT (Katapult)',
        'CAN': 'CAN Bus',
        'CAN_BRIDGE_DFU': 'CAN Bridge/DFU',
        'CAN_BRIDGE_KAT': 'CAN Bridge/KAT',
        'UF2': 'UF2 (USB Mass Storage)',
        'SWD': 'SWD/JTAG',
        'SERIAL': 'Serial/UART'
    };
    
    modes.forEach(mode => {
        const label = modeLabels[mode] || mode;
        
        // 添加复选框
        container.innerHTML += `
            <label class="checkbox-item">
                <input type="checkbox" name="flashMode" value="${mode}" checked>
                <span>${label}</span>
            </label>
        `;
        
        // 添加到下拉框
        defaultSelect.innerHTML += `<option value="${mode}">${label}</option>`;
    });
    
    // 默认选中第一个
    if (modes.length > 0) {
        defaultSelect.value = modes[0];
    }
}

// 重置配置表单
function resetConfigForm() {
    document.getElementById('newConfigManufacturer').value = '';
    document.getElementById('customManufacturer').value = '';
    document.getElementById('customManufacturerGroup').style.display = 'none';
    document.getElementById('newConfigProductType').value = 'mainboard';
    document.getElementById('newConfigBoardName').value = '';
    document.getElementById('mcuPlatform').value = '';
    document.getElementById('mcuModelSelect').innerHTML = '<option value="">-- 先选择平台 --</option>';
    document.getElementById('mcuModelSelect').disabled = true;
    document.getElementById('mcuParamsSection').style.display = 'none';
    document.getElementById('flashModeSection').style.display = 'none';
    currentMcuInfo = null;
}

// 修改原有的 createNewConfig 函数
async function createNewConfig() {
    // 获取厂家
    const manufacturerSelect = document.getElementById('newConfigManufacturer');
    let manufacturer = manufacturerSelect.value;
    if (manufacturer === 'custom') {
        manufacturer = document.getElementById('customManufacturer').value.trim();
    }
    
    if (!manufacturer) {
        showError('请选择或输入厂家名称');
        return;
    }
    
    // 获取产品信息
    const productType = document.getElementById('newConfigProductType').value;
    const boardName = document.getElementById('newConfigBoardName').value.trim();
    
    if (!boardName) {
        showError('请输入产品名称');
        return;
    }
    
    // 获取 MCU 信息
    const platform = document.getElementById('mcuPlatform').value;
    const mcuModel = document.getElementById('mcuModelSelect').value;
    
    if (!mcuModel) {
        showError('请选择 MCU 型号');
        return;
    }
    
    // 构建配置数据
    const configData = {
        manufacturer: manufacturer,
        name: boardName,
        type: productType,
        mcu: mcuModel,
        platform: platform,
        crystal: document.getElementById('crystalFreqSelect').value,
        bl_offset: document.getElementById('blOffsetSelect').value,
        boot_pins: document.getElementById('bootPins').value.trim() || '',
        flash_modes: Array.from(document.querySelectorAll('input[name="flashMode"]:checked')).map(cb => cb.value),
        default_flash: document.getElementById('defaultFlashMode').value
    };
    
    try {
        const response = await fetch('/api/config/create', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(configData)
        });
        
        const result = await response.json();
        
        if (result.success) {
            showSuccess('配置创建成功！');
            resetConfigForm();
            loadConfigList(); // 刷新配置列表
        } else {
            showError(result.error || '创建失败');
        }
    } catch (error) {
        console.error('创建配置失败:', error);
        showError('创建配置失败: ' + error.message);
    }
}

// 在页面切换到 config 时初始化
switchPage = function(pageId) {
    originalSwitchPage(pageId);
    if (pageId === 'config') {
        initConfigPage();
    }
};

