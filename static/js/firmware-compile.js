// ==================== 固件编译与烧录页面 - 重构版 ====================

let compileMcuDatabase = {};  // MCU 数据库
let currentCompileMcu = null; // 当前选中的 MCU
let compiledFirmwarePath = null; // 编译成功的固件路径

// 初始化固件编译页面
async function initFirmwarePage() {
    console.log('初始化固件编译页面...');
    await loadCompileMcuDatabase();
    await loadCompilePresetManufacturers();
}

// 加载 MCU 数据库
async function loadCompileMcuDatabase() {
    try {
        const response = await fetch('/api/klipper/mcu-database');
        const data = await response.json();
        
        if (data.success) {
            compileMcuDatabase = data.database;
            console.log('✓ MCU 数据库已加载:', Object.keys(compileMcuDatabase));
        }
    } catch (error) {
        console.error('加载 MCU 数据库失败:', error);
    }
}

// 加载预设厂家列表
async function loadCompilePresetManufacturers() {
    try {
        const response = await fetch('/api/config/manufacturers');
        const data = await response.json();
        
        const select = document.getElementById('compilePresetManufacturer');
        select.innerHTML = '<option value="">-- 选择厂家 --</option>';
        
        if (data.manufacturers) {
            data.manufacturers.forEach(mfr => {
                if (mfr !== '自定义') {
                    select.innerHTML += `<option value="${mfr}">${mfr}</option>`;
                }
            });
        }
    } catch (error) {
        console.error('加载厂家列表失败:', error);
    }
}

// 编译模式切换
function onCompileModeChange() {
    const mode = document.querySelector('input[name="compileMode"]:checked').value;
    const presetSection = document.getElementById('compilePresetSection');
    const customSection = document.getElementById('compileCustomSection');
    
    if (mode === 'preset') {
        presetSection.style.display = 'block';
        customSection.style.display = 'none';
    } else {
        presetSection.style.display = 'none';
        customSection.style.display = 'block';
        loadCompileMcuPlatforms();
    }
    
    // 重置
    currentCompileMcu = null;
    document.getElementById('compileMcuDetails').style.display = 'none';
}

// 加载 MCU 平台列表
function loadCompileMcuPlatforms() {
    const select = document.getElementById('compileMcuPlatform');
    select.innerHTML = '<option value="">-- 选择平台 --</option>';
    
    for (const platform in compileMcuDatabase) {
        select.innerHTML += `<option value="${platform}">${platform}</option>`;
    }
}

// MCU 平台选择变化
async function onCompileMcuPlatformChange() {
    const platform = document.getElementById('compileMcuPlatform').value;
    const modelSelect = document.getElementById('compileMcuModel');
    
    modelSelect.innerHTML = '<option value="">-- 选择型号 --</option>';
    modelSelect.disabled = true;
    document.getElementById('compileMcuDetails').style.display = 'none';
    currentCompileMcu = null;
    
    if (!platform) return;
    
    try {
        const response = await fetch(`/api/klipper/mcus/${platform}`);
        const data = await response.json();
        
        if (data.success) {
            data.mcus.forEach(mcu => {
                modelSelect.innerHTML += `<option value="${mcu.id}">${mcu.name}</option>`;
            });
            modelSelect.disabled = false;
        }
    } catch (error) {
        console.error('加载 MCU 列表失败:', error);
    }
}

// MCU 型号选择变化
async function onCompileMcuModelChange() {
    const mcuId = document.getElementById('compileMcuModel').value;
    
    if (!mcuId) {
        document.getElementById('compileMcuDetails').style.display = 'none';
        return;
    }
    
    try {
        const response = await fetch(`/api/klipper/mcu-info/${mcuId}`);
        const data = await response.json();
        
        if (data.success) {
            currentCompileMcu = data;
            displayCompileMcuDetails(data);
        }
    } catch (error) {
        console.error('加载 MCU 详情失败:', error);
    }
}

// 显示 MCU 详细参数
function displayCompileMcuDetails(data) {
    const mcu = data.mcu;
    
    // 晶振选项 - RP2040/RP2350 固定时钟，隐藏选择
    const crystalSelect = document.getElementById('compileCrystal');
    const crystalGroup = crystalSelect.closest('.form-group');
    crystalSelect.innerHTML = '';
    mcu.crystals.forEach(freq => {
        const label = formatCompileFrequency(freq);
        crystalSelect.innerHTML += `<option value="${freq}">${label}</option>`;
    });
    // RP2040/RP2350 只有一个晶振选项，隐藏选择框
    if (mcu.id === 'rp2040' || mcu.id === 'rp2350' || mcu.crystals.length <= 1) {
        crystalGroup.style.display = 'none';
    } else {
        crystalGroup.style.display = 'block';
    }
    
    // BL 偏移选项
    const blSelect = document.getElementById('compileBlOffset');
    blSelect.innerHTML = '';
    mcu.bl_offsets.forEach(offset => {
        const label = formatCompileBlOffset(offset, mcu.id);
        blSelect.innerHTML += `<option value="${offset}">${label}</option>`;
    });
    
    // 连接方式
    const connSelect = document.getElementById('compileConnection');
    connSelect.innerHTML = '';
    data.connections.forEach(conn => {
        connSelect.innerHTML += `<option value="${conn.type}">${conn.name}</option>`;
    });
    // 添加 CAN 桥接选项
    connSelect.innerHTML += `<option value="CAN_BRIDGE">USB转CAN桥接</option>`;
    
    document.getElementById('compileMcuDetails').style.display = 'block';
}

// 连接方式变化处理
function onCompileConnectionChange() {
    const connection = document.getElementById('compileConnection').value;
    const canBridgeOptions = document.getElementById('compileCanBridgeOptions');
    
    if (connection === 'CAN_BRIDGE') {
        canBridgeOptions.style.display = 'flex';
    } else {
        canBridgeOptions.style.display = 'none';
    }
}

// 预设厂家选择变化
async function onCompilePresetManufacturerChange() {
    const manufacturer = document.getElementById('compilePresetManufacturer').value;
    const typeSelect = document.getElementById('compilePresetType');
    const modelSelect = document.getElementById('compilePresetModel');
    
    typeSelect.innerHTML = '<option value="">-- 选择类型 --</option>';
    typeSelect.disabled = true;
    modelSelect.innerHTML = '<option value="">-- 先选择类型 --</option>';
    modelSelect.disabled = true;
    
    if (!manufacturer) return;
    
    try {
        const response = await fetch(`/api/config/list/${manufacturer}`);
        const data = await response.json();
        
        if (data.configs) {
            const types = [...new Set(data.configs.map(c => c.type))];
            types.forEach(type => {
                const label = type === 'mainboard' ? '主板' : 
                             type === 'toolboard' ? '工具板' : '扩展板';
                typeSelect.innerHTML += `<option value="${type}">${label}</option>`;
            });
            typeSelect.disabled = false;
        }
    } catch (error) {
        console.error('加载类型列表失败:', error);
    }
}

// 预设类型选择变化
async function onCompilePresetTypeChange() {
    const manufacturer = document.getElementById('compilePresetManufacturer').value;
    const type = document.getElementById('compilePresetType').value;
    const modelSelect = document.getElementById('compilePresetModel');
    
    modelSelect.innerHTML = '<option value="">-- 选择型号 --</option>';
    modelSelect.disabled = true;
    
    if (!type) return;
    
    try {
        const response = await fetch(`/api/config/list/${manufacturer}`);
        const data = await response.json();
        
        if (data.configs) {
            const configs = data.configs.filter(c => c.type === type);
            configs.forEach(config => {
                modelSelect.innerHTML += `<option value="${config.id}" data-config='${JSON.stringify(config)}'>${config.name}</option>`;
            });
            modelSelect.disabled = false;
        }
    } catch (error) {
        console.error('加载型号列表失败:', error);
    }
}

// 预设型号选择变化
function onCompilePresetModelChange() {
    const modelSelect = document.getElementById('compilePresetModel');
    const option = modelSelect.options[modelSelect.selectedIndex];
    const advancedSection = document.getElementById('compilePresetAdvanced');
    
    if (option.dataset.config) {
        const config = JSON.parse(option.dataset.config);
        // 自动设置烧录模式
        if (config.default_flash) {
            document.getElementById('flashMode').value = config.default_flash;
        }
        // 显示高级选项
        advancedSection.style.display = 'block';
    } else {
        advancedSection.style.display = 'none';
    }
}

// 编译固件
async function compileFirmware() {
    const mode = document.querySelector('input[name="compileMode"]:checked').value;
    
    let compileParams = {
        klipper_path: document.getElementById('klipperPath')?.value || '~/klipper'
    };
    
    if (mode === 'preset') {
        const modelSelect = document.getElementById('compilePresetModel');
        const option = modelSelect.options[modelSelect.selectedIndex];
        
        if (!option.dataset.config) {
            showError('请选择预设配置');
            return;
        }
        
        const config = JSON.parse(option.dataset.config);
        
        // 检查是否有覆盖的连接方式
        const overrideConnection = document.getElementById('compilePresetConnection').value;
        if (overrideConnection) {
            config.default_connection = overrideConnection;
        }
        
        // 检查是否有启动引脚
        const startupPin = document.getElementById('compilePresetStartupPin').value;
        if (startupPin) {
            config.boot_pins = startupPin;
        }
        
        compileParams.config = config;
    } else {
        if (!currentCompileMcu) {
            showError('请选择 MCU 型号');
            return;
        }
        
        compileParams.mcu = currentCompileMcu.mcu.id;
        compileParams.platform = currentCompileMcu.platform;
        compileParams.crystal = document.getElementById('compileCrystal').value;
        compileParams.bl_offset = document.getElementById('compileBlOffset').value;
        compileParams.connection = document.getElementById('compileConnection').value;
        compileParams.startup_pin = document.getElementById('compileStartupPin').value;
        
        // 如果是 CAN 桥接，添加 CAN 接口参数
        if (compileParams.connection === 'CAN_BRIDGE') {
            compileParams.can_bus_interface = 'CAN bus (on ' + document.getElementById('compileCanInterface').value + ')';
        }
    }
    
    // 显示编译中
    const resultDiv = document.getElementById('compileResult');
    resultDiv.style.display = 'block';
    resultDiv.querySelector('.result-box').innerHTML = '<p>⏳ 正在编译，请稍候...</p>';
    
    try {
        const response = await fetch('/api/firmware/compile', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(compileParams)
        });
        
        const result = await response.json();
        
        if (result.success) {
            compiledFirmwarePath = result.firmware_path;
            resultDiv.querySelector('.result-box').innerHTML = `
                <div class="status-success">
                    <p>✅ 编译成功！</p>
                    <p>固件路径: ${result.firmware_path}</p>
                    <p>固件大小: ${result.firmware_size || '未知'}</p>
                </div>
            `;
            showSuccess('固件编译成功！');
        } else {
            resultDiv.querySelector('.result-box').innerHTML = `
                <div class="status-error">
                    <p>❌ 编译失败</p>
                    <pre>${result.error || '未知错误'}</pre>
                </div>
            `;
            showError('编译失败: ' + (result.error || '未知错误'));
        }
    } catch (error) {
        console.error('编译失败:', error);
        resultDiv.querySelector('.result-box').innerHTML = `
            <div class="status-error">
                <p>❌ 编译请求失败</p>
                <pre>${error.message}</pre>
            </div>
        `;
        showError('编译请求失败: ' + error.message);
    }
}

// 刷新设备 ID 列表
async function refreshDeviceIds() {
    const select = document.getElementById('flashDeviceId');
    select.innerHTML = '<option value="">-- 正在扫描 --</option>';
    
    try {
        const response = await fetch('/api/firmware/detect');
        const data = await response.json();
        
        select.innerHTML = '<option value="">-- 选择设备 --</option>';
        
        if (data.devices && data.devices.length > 0) {
            data.devices.forEach(device => {
                select.innerHTML += `<option value="${device.id}">${device.name} (${device.id})</option>`;
            });
        } else {
            select.innerHTML += '<option value="" disabled>未找到设备</option>';
        }
    } catch (error) {
        console.error('扫描设备失败:', error);
        select.innerHTML = '<option value="">-- 扫描失败 --</option>';
    }
}

// 固件来源变化
function onFirmwareSourceChange() {
    const source = document.getElementById('firmwareSource').value;
    const uploadArea = document.getElementById('firmwareUploadArea');
    
    if (source === 'upload') {
        uploadArea.style.display = 'block';
    } else {
        uploadArea.style.display = 'none';
    }
}

// 烧录模式变化处理
function onFlashModeChange() {
    const flashMode = document.getElementById('flashMode').value;
    const tfCardSection = document.getElementById('tfCardSection');
    const flashBtn = document.getElementById('flashFirmwareBtn');
    const deviceIdGroup = document.getElementById('flashDeviceId').closest('.form-group');
    
    if (flashMode === 'TF') {
        // TF卡模式：显示下载区域，隐藏烧录按钮和设备选择
        tfCardSection.style.display = 'block';
        flashBtn.style.display = 'none';
        deviceIdGroup.style.display = 'none';
    } else {
        // 其他模式：正常显示
        tfCardSection.style.display = 'none';
        flashBtn.style.display = 'inline-block';
        deviceIdGroup.style.display = 'block';
    }
}

// 下载 firmware.bin 用于 TF 卡烧录
async function downloadFirmwareForTF() {
    if (!compiledFirmwarePath) {
        showError('请先编译固件');
        return;
    }
    
    try {
        // 调用 API 获取固件文件
        const response = await fetch(`/api/firmware/download?path=${encodeURIComponent(compiledFirmwarePath)}`);
        if (!response.ok) {
            throw new Error('下载失败');
        }
        
        const blob = await response.blob();
        
        // 创建下载链接
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'firmware.bin';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        window.URL.revokeObjectURL(url);
        
        showSuccess('firmware.bin 下载成功！请复制到TF卡中。');
    } catch (error) {
        console.error('下载失败:', error);
        showError('下载失败: ' + error.message);
    }
}

// 烧录固件
async function flashFirmware() {
    const deviceId = document.getElementById('flashDeviceId').value;
    const flashMode = document.getElementById('flashMode').value;
    
    if (flashMode === 'TF') {
        // TF卡模式不需要烧录
        return;
    }
    
    if (!deviceId) {
        showError('请选择设备 ID');
        return;
    }
    
    let firmwarePath = compiledFirmwarePath;
    
    if (!firmwarePath) {
        // 如果没有编译过，尝试使用默认路径
        firmwarePath = '~/klipper/out/klipper.bin';
    }
    
    const resultDiv = document.getElementById('flashResult');
    resultDiv.style.display = 'block';
    resultDiv.querySelector('.result-box').innerHTML = '<p>⏳ 正在烧录，请稍候...</p>';
    
    try {
        const response = await fetch('/api/firmware/flash', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                device_id: deviceId,
                flash_mode: flashMode,
                firmware_path: firmwarePath
            })
        });
        
        const result = await response.json();
        
        if (result.success) {
            resultDiv.querySelector('.result-box').innerHTML = `
                <div class="status-success">
                    <p>✅ 烧录成功！</p>
                </div>
            `;
            showSuccess('固件烧录成功！');
        } else {
            resultDiv.querySelector('.result-box').innerHTML = `
                <div class="status-error">
                    <p>❌ 烧录失败</p>
                    <pre>${result.error || '未知错误'}</pre>
                </div>
            `;
            showError('烧录失败: ' + (result.error || '未知错误'));
        }
    } catch (error) {
        console.error('烧录失败:', error);
        resultDiv.querySelector('.result-box').innerHTML = `
            <div class="status-error">
                <p>❌ 烧录请求失败</p>
                <pre>${error.message}</pre>
            </div>
        `;
        showError('烧录请求失败: ' + error.message);
    }
}

// 展开/折叠 BL 烧录区域
function toggleBlFlashSection() {
    const section = document.getElementById('blFlashSection');
    const toggle = document.getElementById('blFlashToggle');
    
    if (section.style.display === 'none') {
        section.style.display = 'block';
        toggle.textContent = '▲';
        loadBlFiles();
    } else {
        section.style.display = 'none';
        toggle.textContent = '▼';
    }
}

// 加载 BL 文件列表
async function loadBlFiles() {
    try {
        const response = await fetch('/api/firmware/bl-firmwares');
        const data = await response.json();
        
        const select = document.getElementById('blFileSelect');
        select.innerHTML = '<option value="">-- 选择 BL 文件 --</option>';
        
        if (data.files) {
            data.files.forEach(file => {
                select.innerHTML += `<option value="${file.path}">${file.name}</option>`;
            });
        }
    } catch (error) {
        console.error('加载 BL 文件列表失败:', error);
    }
}

// 烧录 Bootloader
async function flashBootloader() {
    const blFile = document.getElementById('blFileSelect').value;
    const address = document.getElementById('blFlashAddress').value;
    const tool = document.getElementById('blFlashTool').value;
    
    if (!blFile) {
        showError('请选择 BL 文件');
        return;
    }
    
    const resultDiv = document.getElementById('blFlashResult');
    resultDiv.style.display = 'block';
    resultDiv.querySelector('.result-box').innerHTML = '<p>⏳ 正在烧录 BL，请稍候...</p>';
    
    try {
        const response = await fetch('/api/firmware/bl/flash', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                bl_file: blFile,
                address: address,
                tool: tool
            })
        });
        
        const result = await response.json();
        
        if (result.success) {
            resultDiv.querySelector('.result-box').innerHTML = `
                <div class="status-success">
                    <p>✅ BL 烧录成功！</p>
                </div>
            `;
            showSuccess('BL 烧录成功！');
        } else {
            resultDiv.querySelector('.result-box').innerHTML = `
                <div class="status-error">
                    <p>❌ BL 烧录失败</p>
                    <pre>${result.error || '未知错误'}</pre>
                </div>
            `;
            showError('BL 烧录失败: ' + (result.error || '未知错误'));
        }
    } catch (error) {
        console.error('BL 烧录失败:', error);
        resultDiv.querySelector('.result-box').innerHTML = `
            <div class="status-error">
                <p>❌ BL 烧录请求失败</p>
                <pre>${error.message}</pre>
            </div>
        `;
        showError('BL 烧录请求失败: ' + error.message);
    }
}

// 重置编译表单
function resetCompileForm() {
    document.querySelector('input[name="compileMode"][value="preset"]').checked = true;
    onCompileModeChange();
    
    document.getElementById('compilePresetManufacturer').value = '';
    document.getElementById('compilePresetType').innerHTML = '<option value="">-- 先选择厂家 --</option>';
    document.getElementById('compilePresetType').disabled = true;
    document.getElementById('compilePresetModel').innerHTML = '<option value="">-- 先选择类型 --</option>';
    document.getElementById('compilePresetModel').disabled = true;
    
    document.getElementById('compileMcuPlatform').value = '';
    document.getElementById('compileMcuModel').innerHTML = '<option value="">-- 先选择平台 --</option>';
    document.getElementById('compileMcuModel').disabled = true;
    document.getElementById('compileMcuDetails').style.display = 'none';
    
    document.getElementById('compileResult').style.display = 'none';
    document.getElementById('flashResult').style.display = 'none';
    
    compiledFirmwarePath = null;
    currentCompileMcu = null;
}

// 格式化频率
function formatCompileFrequency(freq) {
    const freqNum = parseInt(freq);
    if (freqNum >= 1000000) {
        return (freqNum / 1000000) + ' MHz';
    } else if (freqNum >= 1000) {
        return (freqNum / 1000) + ' KHz';
    }
    return freq + ' Hz';
}

// 格式化 BL 偏移
function formatCompileBlOffset(offset, mcuId) {
    const offsetNum = parseInt(offset);
    // RP2040: 256 是 stage2，显示为 NO BL
    if (mcuId === 'rp2040' && offsetNum === 256) {
        return 'NO BL';
    }
    if (offsetNum === 0) {
        return 'NO BL';
    }
    if (offsetNum === 256) {
        return '256 bytes';
    }
    if (offsetNum < 1024) {
        return offsetNum + ' bytes';
    }
    const kb = offsetNum / 1024;
    if (Number.isInteger(kb)) {
        return kb + ' KB';
    }
    return kb.toFixed(1) + ' KB';
}

// 页面加载时初始化
document.addEventListener('DOMContentLoaded', () => {
    if (document.getElementById('page-firmware')) {
        initFirmwarePage();
    }
});
