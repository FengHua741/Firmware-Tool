// ==================== 固件编译与烧录页面 - 重构版 ====================

let compileMcuDatabase = {};  // MCU 数据库
let currentCompileMcu = null; // 当前选中的 MCU
let compiledFirmwarePath = null; // 编译成功的固件路径
let compiledFirmwareManifest = null; // 编译成功的固件元数据
let _lastBlFiles = [];
let _lastBlAddressOptions = [];
let _commGroupedOptions = {}; // 按类型分组的通信选项
let _commAllOptions = [];     // 所有通信选项（带compatible_processors）
let _bridgeCanOptions = [];   // STM32 桥接CAN引脚选项
let _rp2040CanGpio = null;    // RP2040 CAN GPIO 配置

// 初始化固件编译页面
async function initFirmwarePage() {
    console.log('初始化固件编译页面...');
    await loadCompileMcuDatabase();
    await loadCompilePresetManufacturers();
    await refreshFlashCanIfaces();
    // 初始化时根据默认烧录模式隐藏 CAN 接口选择框
    onFlashModeChange(true);
}

// 刷新固件烧录页的CAN接口列表
// 返回 true 表示有多个CAN接口
async function refreshFlashCanIfaces() {
    const select = document.getElementById('flashCanIface');
    if (!select) return false;
    try {
        const response = await fetch('/api/system/can-iface');
        const data = await response.json();
        select.innerHTML = '';
        let ifaceCount = 0;
        if (data.ifaces && data.ifaces.length > 0) {
            data.ifaces.forEach(iface => {
                select.innerHTML += `<option value="${iface.ifname}">${iface.ifname}</option>`;
                ifaceCount++;
            });
        }
        // 至少保证有 can0
        if (ifaceCount === 0) {
            select.innerHTML = '<option value="can0">can0</option>';
            ifaceCount = 1;
        }
        // 只有一个CAN接口时隐藏选择框，默认用第一个
        const hasMultiple = ifaceCount > 1;
        select.style.display = hasMultiple ? '' : 'none';
        return hasMultiple;
    } catch (error) {
        select.innerHTML = '<option value="can0">can0</option>';
        select.style.display = 'none';
        return false;
    }
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
        // 默认选中 FLY 并自动加载类型
        if ([...select.options].some(o => o.value === 'FLY')) {
            select.value = 'FLY';
            await onCompilePresetManufacturerChange();
        }
    } catch (error) {
        console.error('加载厂家列表失败:', error);
    }
}

// 编译模式切换
function onCompileModeChange() {
    const modeEl = document.querySelector('input[name="compileMode"]:checked');
    const mode = modeEl ? modeEl.value : 'preset';
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
function loadCompileMcuPlatforms(autoDefault = true) {
    const select = document.getElementById('compileMcuPlatform');
    select.innerHTML = '<option value="">-- 选择平台 --</option>';
    
    for (const platform in compileMcuDatabase) {
        select.innerHTML += `<option value="${platform}">${platform}</option>`;
    }
    // 默认选中 STM32
    if (autoDefault && compileMcuDatabase['STM32']) {
        select.value = 'STM32';
        onCompileMcuPlatformChange();
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
            await displayCompileMcuDetails(data);
            const blSection = document.getElementById('blFlashSection');
            if (blSection && blSection.style.display !== 'none') {
                await loadBlAddressOptions();
            }
        }
    } catch (error) {
        console.error('加载 MCU 详情失败:', error);
    }
}

// 显示 MCU 详细参数
async function displayCompileMcuDetails(data) {
    const mcu = data.mcu;
    
    // 晶振选项 - RP2040/RP2350 固定时钟，隐藏选择
    const crystalSelect = document.getElementById('compileCrystal');
    const crystalGroup = crystalSelect ? crystalSelect.closest('.form-group') : null;
    if (!crystalSelect) return;
    crystalSelect.innerHTML = '';
    mcu.crystals.forEach(freq => {
        const label = formatCompileFrequency(freq);
        crystalSelect.innerHTML += `<option value="${freq}">${label}</option>`;
    });
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
    
    // 连接方式 - 两级选择（从Kconfig动态获取）
    await loadCommunicationOptions(mcu, data.platform_key);
    
    // 根据 MCU 预设自动设置烧录模式（自定义模式）
    // 如果从预设产品切换过来，保留预设配置的烧录模式，不覆盖
    const flashModeEl = document.getElementById('flashMode');
    if (flashModeEl && typeof MCU_PRESETS !== 'undefined' && !window._fromPreset) {
        let defaultFlash = null;
        for (const platform in MCU_PRESETS) {
            const found = MCU_PRESETS[platform].find(m => m.id === mcu.id);
            if (found && found.default_flash) {
                defaultFlash = found.default_flash;
                break;
            }
        }
        if (defaultFlash) {
            // 恢复所有选项可见
            Array.from(flashModeEl.options).forEach(opt => {
                opt.style.display = '';
            });
            flashModeEl.value = defaultFlash;
            onFlashModeChange();
        }
    }
    if (window._fromPreset) {
        window._fromPreset = false;
    }
    
    document.getElementById('compileMcuDetails').style.display = 'block';
}

// MCU ID -> 平台键名映射 (用于从 communication-options API 获取对应平台数据)
const MCU_PLATFORM_MAP = {
    // STM32 系列
    'STM32F103': 'stm32', 'STM32F207': 'stm32', 'STM32F401': 'stm32', 'STM32F405': 'stm32',
    'STM32F407': 'stm32', 'STM32F429': 'stm32', 'STM32F446': 'stm32', 'STM32F765': 'stm32',
    'STM32F031': 'stm32', 'STM32F042': 'stm32', 'STM32F070': 'stm32', 'STM32F072': 'stm32',
    'STM32G070': 'stm32', 'STM32G071': 'stm32', 'STM32G0B0': 'stm32', 'STM32G0B1': 'stm32',
    'STM32G431': 'stm32', 'STM32G474': 'stm32',
    'STM32H723': 'stm32', 'STM32H743': 'stm32', 'STM32H750': 'stm32',
    'STM32L412': 'stm32',
    'N32G452': 'stm32', 'N32G455': 'stm32',
    // RP2040 系列
    'RP2040': 'rp2040', 'RP2350': 'rp2040',
    // ATSAMD 系列
    'SAMC21G18': 'atsamd', 'SAMD21G18': 'atsamd', 'SAMD21E18': 'atsamd',
    'SAMD21J18': 'atsamd', 'SAMD21E15': 'atsamd',
    'SAMD51G19': 'atsamd', 'SAMD51J19': 'atsamd', 'SAMD51N19': 'atsamd', 'SAMD51P20': 'atsamd',
    'SAME51J19': 'atsamd', 'SAME51N19': 'atsamd', 'SAME54P20': 'atsamd',
    // LPC176x 系列
    'LPC1768': 'lpc176x', 'LPC1769': 'lpc176x',
    // HC32F460 系列
    'HC32F460': 'hc32f460',
    // ATSAM 系列
    'SAM3X8E': 'atsam', 'SAM3X8C': 'atsam', 'SAM4S8C': 'atsam',
    'SAM4E8E': 'atsam', 'SAME70Q20B': 'atsam',
    // AVR 系列
    'ATMEGA2560': 'avr', 'ATMEGA1280': 'avr', 'AT90USB1286': 'avr',
    'AT90USB646': 'avr', 'ATMEGA32U4': 'avr', 'ATMEGA1284P': 'avr',
    'ATMEGA644P': 'avr', 'ATMEGA328P': 'avr', 'ATMEGA328': 'avr',
    'ATMEGA168': 'avr', 'LGT8F328P': 'avr',
};

// 加载通信选项（两级选择）
async function loadCommunicationOptions(mcu, platformKeyFromApi) {
    const connSelect = document.getElementById('compileConnection');
    connSelect.innerHTML = '<option value="">加载中...</option>';
    
    // 隐藏子选项区域
    const canBridgeOptions = document.getElementById('compileCanBridgeOptions');
    if (canBridgeOptions) canBridgeOptions.style.display = 'none';
    let subContainer = document.getElementById('compileConnectionSub');
    if (subContainer) subContainer.remove();
    
    try {
        const response = await fetch('/api/klipper/communication-options');
        const data = await response.json();
        
        if (data.error) {
            _fallbackConnectionOptions(connSelect);
            return;
        }
        
        const mcuId = mcu.id.toUpperCase();
        // 通过映射找到平台键名，再获取该平台的通信选项
        const platformKey = platformKeyFromApi || MCU_PLATFORM_MAP[mcuId] || mcuId.toLowerCase();
        const platformData = data[platformKey];
        let commOptions = [];
        _bridgeCanOptions = [];
        _rp2040CanGpio = null;
        
        if (platformData && platformData.communication_options) {
            commOptions = platformData.communication_options;
            // 存储桥接CAN引脚选项，按MCU过滤
            if (platformData.bridge_can) {
                _bridgeCanOptions = platformData.bridge_can.filter(opt => {
                    if (!opt.compatible_processors || opt.compatible_processors.length === 0) return true;
                    return opt.compatible_processors.includes(mcuId);
                });
                if (_bridgeCanOptions.length === 0) {
                    _bridgeCanOptions = platformData.bridge_can;
                }
            }
            // RP2040 CAN GPIO配置
            if (platformKey === 'rp2040' && (platformData.has_canbus || platformData.has_usbcanbus)) {
                _rp2040CanGpio = {
                    rx_default: platformData.rx_default || 4,
                    tx_default: platformData.tx_default || 5,
                    range: platformData.range || [0, 29]
                };
            }
        }
        
        // 过滤兼容当前MCU的选项
        let filtered = commOptions.filter(opt => {
            if (!opt.compatible_processors || opt.compatible_processors.length === 0) return true;
            return opt.compatible_processors.includes(mcuId);
        });
        if (filtered.length === 0 && commOptions.length > 0) {
            filtered = commOptions;
        }
        
        _commAllOptions = filtered;
        _commGroupedOptions = {};
        filtered.forEach(opt => {
            const type = opt.comm_type || 'unknown';
            if (!_commGroupedOptions[type]) _commGroupedOptions[type] = [];
            _commGroupedOptions[type].push(opt);
        });
        
        // 第一级：通信类型
        const typeLabels = { 'usb': 'USB', 'serial': 'Serial/UART', 'can': 'CAN', 'usbcanbridge': 'USB转CAN桥接' };
        connSelect.innerHTML = '<option value="">-- 选择通信类型 --</option>';
        for (const type in _commGroupedOptions) {
            connSelect.innerHTML += `<option value="${type}">${typeLabels[type] || type}</option>`;
        }
        // 默认选中 USB（如果可用，但从预设加载时跳过，由 _autoSelectPresetConnection 处理）
        if (_commGroupedOptions['usb'] && !window._fromPreset) {
            connSelect.value = 'usb';
            onCompileConnectionChange();
        }
    } catch (error) {
        console.error('加载通信选项失败:', error);
        _fallbackConnectionOptions(connSelect);
    }
}

function _fallbackConnectionOptions(connSelect) {
    connSelect.innerHTML = '<option value="">-- 选择通信类型 --</option>';
    connSelect.innerHTML += '<option value="usb">USB</option>';
    connSelect.innerHTML += '<option value="serial">Serial/UART</option>';
    connSelect.innerHTML += '<option value="can">CAN</option>';
    connSelect.innerHTML += '<option value="usbcanbridge">USB转CAN桥接</option>';
    _commGroupedOptions = {};
    _commAllOptions = [];
}

// 连接方式变化处理（两级选择第二级 + CAN引脚）
function onCompileConnectionChange() {
    const commType = document.getElementById('compileConnection').value;
    const canBridgeOptions = document.getElementById('compileCanBridgeOptions');
    if (canBridgeOptions) canBridgeOptions.style.display = 'none';
    
    // 移除旧的子选项和引脚选项
    let subContainer = document.getElementById('compileConnectionSub');
    if (subContainer) subContainer.remove();
    let pinContainer = document.getElementById('compileCanPinSub');
    if (pinContainer) pinContainer.remove();
    
    if (!commType || !_commGroupedOptions[commType]) return;
    
    const options = _commGroupedOptions[commType];
    const connEl = document.getElementById('compileConnection');
    const connGroup = connEl ? connEl.closest('.form-group') : null;
    if (!connGroup) return;
    
    // 有选项时显示第二级选择
    if (options.length >= 1) {
        subContainer = document.createElement('div');
        subContainer.id = 'compileConnectionSub';
        subContainer.className = 'form-group';
        subContainer.style.marginTop = '10px';
        
        let label = '接口';
        if (commType === 'serial') label = 'UART接口';
        else if (commType === 'can') label = 'CAN引脚';
        else if (commType === 'usbcanbridge') label = 'USB接口';
        else if (commType === 'usb') label = 'USB接口';
        
        subContainer.innerHTML = `<label>${label}</label><select id="compileConnectionDetail" class="form-control" onchange="onCompileConnectionDetailChange()"></select>`;
        connGroup.parentNode.insertBefore(subContainer, connGroup.nextSibling);
        
        const detailSelect = document.getElementById('compileConnectionDetail');
        detailSelect.innerHTML = `<option value="">-- 选择${label} --</option>`;
        options.forEach(opt => {
            detailSelect.innerHTML += `<option value="${opt.config_symbol}" data-comm='${JSON.stringify(opt).replace(/'/g, '&apos;')}'>${opt.display}</option>`;
        });
        // 只有1个选项时自动选中
        if (options.length === 1) {
            detailSelect.value = options[0].config_symbol;
        }
    }
    
    // USB-CAN桥接(STM32)：显示CAN引脚选择
    if (commType === 'usbcanbridge' && _bridgeCanOptions.length > 0) {
        _showBridgeCanPinSelector(connGroup);
    }
    
    // RP2040 CAN/桥接：显示GPIO引脚配置
    if (_rp2040CanGpio && (commType === 'can' || commType === 'usbcanbridge')) {
        _showRp2040CanGpioSelector(connGroup);
    }
}

// 显示STM32桥接CAN引脚选择器
function _showBridgeCanPinSelector(connGroup) {
    const pinContainer = document.createElement('div');
    pinContainer.id = 'compileCanPinSub';
    pinContainer.className = 'form-group';
    pinContainer.style.marginTop = '10px';
    
    pinContainer.innerHTML = `<label>CAN总线引脚</label><select id="compileBridgeCanPin" class="form-control"></select>`;
    
    // 插入到最后一个子选项之后
    const lastSub = document.getElementById('compileConnectionSub');
    const insertAfter = lastSub || connGroup;
    insertAfter.parentNode.insertBefore(pinContainer, insertAfter.nextSibling);
    
    const pinSelect = document.getElementById('compileBridgeCanPin');
    pinSelect.innerHTML = '<option value="">-- 选择CAN引脚 --</option>';
    _bridgeCanOptions.forEach(opt => {
        pinSelect.innerHTML += `<option value="${opt.config}">${opt.display}</option>`;
    });
}

// 显示RP2040 CAN GPIO引脚选择器
function _showRp2040CanGpioSelector(connGroup) {
    const pinContainer = document.createElement('div');
    pinContainer.id = 'compileCanPinSub';
    pinContainer.className = 'form-group';
    pinContainer.style.marginTop = '10px';
    
    const min = _rp2040CanGpio.range[0];
    const max = _rp2040CanGpio.range[1];
    
    pinContainer.innerHTML = `
        <label>CAN GPIO 引脚</label>
        <div style="display:flex;gap:10px;">
            <div style="flex:1;">
                <small>RX GPIO</small>
                <input type="number" id="compileRp2040CanRx" class="form-control" 
                    value="${_rp2040CanGpio.rx_default}" min="${min}" max="${max}">
            </div>
            <div style="flex:1;">
                <small>TX GPIO</small>
                <input type="number" id="compileRp2040CanTx" class="form-control" 
                    value="${_rp2040CanGpio.tx_default}" min="${min}" max="${max}">
            </div>
        </div>
    `;
    
    const lastSub = document.getElementById('compileConnectionSub') || connGroup;
    lastSub.parentNode.insertBefore(pinContainer, lastSub.nextSibling);
}

function onCompileConnectionDetailChange() {
    // 编译时读取 detailSelect.value（见 compileFirmware 方法）
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
            // 默认选中主板
            if ([...typeSelect.options].some(o => o.value === 'mainboard')) {
                typeSelect.value = 'mainboard';
                await onCompilePresetTypeChange();
            }
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
                modelSelect.innerHTML += `<option value="${config.id}" data-config='${JSON.stringify(config).replace(/'/g, '&apos;')}'>${config.name}</option>`;
            });
            modelSelect.disabled = false;
        }
    } catch (error) {
        console.error('加载型号列表失败:', error);
    }
}

// 预设型号选择变化 - 自动切换到自定义模式并填充所有字段
async function onCompilePresetModelChange() {
    const modelSelect = document.getElementById('compilePresetModel');
    const option = modelSelect.options[modelSelect.selectedIndex];
    const advancedSection = document.getElementById('compilePresetAdvanced');

    if (!option || !option.dataset.config) {
        advancedSection.style.display = 'none';
        return;
    }

    const config = JSON.parse(option.dataset.config);
    window._selectedCompileBoardConfig = config;
    const presetName = config.name || option.textContent;

    // 设置烧录模式：默认选中 default_flash，但保留所有选项可编辑
    const flashModeEl = document.getElementById('flashMode');
    if (flashModeEl && config.flash_modes && config.flash_modes.length > 0) {
        // 恢复所有选项可见（用户可手动覆盖）
        const supportedModes = config.flash_modes;
        Array.from(flashModeEl.options).forEach(opt => {
            opt.style.display = '';
            // 标记推荐模式
            if (supportedModes.includes(opt.value)) {
                opt.textContent = opt.textContent.replace(/\s*\(推荐\)$/, '') + ' (\u63A8\u8350)';
            } else {
                opt.textContent = opt.textContent.replace(/\s*\(推荐\)$/, '');
            }
        });
        // 设置默认值
        if (config.default_flash && supportedModes.includes(config.default_flash)) {
            flashModeEl.value = config.default_flash;
        } else {
            flashModeEl.value = supportedModes[0];
        }
        onFlashModeChange();
    }

    // 隐藏预设高级选项
    advancedSection.style.display = 'none';

    // 切换到自定义模式，展示完整配置界面
    document.querySelector('input[name="compileMode"][value="custom"]').checked = true;
    document.getElementById('compilePresetSection').style.display = 'none';
    document.getElementById('compileCustomSection').style.display = 'block';

    // 加载MCU平台列表
    loadCompileMcuPlatforms(false);

    // 选择预设对应的平台
    const platformSelect = document.getElementById('compileMcuPlatform');
    const targetPlatform = (config.platform || '').toUpperCase();
    let platformFound = false;
    for (let i = 0; i < platformSelect.options.length; i++) {
        const optVal = platformSelect.options[i].value.toUpperCase();
        if (!optVal) continue;  // 跳过空占位项
        if (optVal === targetPlatform || optVal.includes(targetPlatform) || targetPlatform.includes(optVal)) {
            platformSelect.value = platformSelect.options[i].value;
            platformFound = true;
            break;
        }
    }
    if (!platformFound) {
        showError(`预设平台 ${config.platform} 未找到，请手动选择`);
        return;
    }

    // 加载该平台的MCU列表
    await onCompileMcuPlatformChange();

    // 选择预设对应的MCU型号
    const mcuModelSelect = document.getElementById('compileMcuModel');
    const targetMcu = (config.mcu || '').toLowerCase();
    let mcuFound = false;
    for (let i = 0; i < mcuModelSelect.options.length; i++) {
        if (mcuModelSelect.options[i].value.toLowerCase() === targetMcu) {
            mcuModelSelect.value = mcuModelSelect.options[i].value;
            mcuFound = true;
            break;
        }
    }
    if (!mcuFound) {
        showError(`预设MCU型号 ${config.mcu} 未找到，请手动选择`);
        return;
    }

    // 标记为从预设切换，避免 displayCompileMcuDetails 覆盖烧录模式
    window._fromPreset = true;
    
    // 加载MCU详细参数（晶振选项、BL偏移选项、通信选项）
    await onCompileMcuModelChange();

    // 自动填充晶振频率
    if (config.crystal) {
        const crystalSelect = document.getElementById('compileCrystal');
        if (crystalSelect) crystalSelect.value = config.crystal;
    }

    // 自动填充BL偏移（带回退：如果预设值不在列表中则动态添加）
    if (config.bl_offset) {
        const blSelect = document.getElementById('compileBlOffset');
        if (blSelect) {
            blSelect.value = config.bl_offset;
            if (blSelect.value !== config.bl_offset) {
                const mcuId = currentCompileMcu ? currentCompileMcu.mcu.id : '';
                const label = formatCompileBlOffset(config.bl_offset, mcuId) + ' (\u9884\u8bbe)';
                const opt = document.createElement('option');
                opt.value = config.bl_offset;
                opt.textContent = label;
                blSelect.appendChild(opt);
                blSelect.value = config.bl_offset;
            }
        }
    }

    // 自动填充启动引脚（始终更新，避免切换预设时残留旧值）
    const pinInput = document.getElementById('compileStartupPin');
    if (pinInput) pinInput.value = config.boot_pins || '';

    // 自动选择通信方式
    if (config.default_connection) {
        _autoSelectPresetConnection(config);
    }

    const blSection = document.getElementById('blFlashSection');
    if (blSection && blSection.style.display !== 'none') {
        await loadBlFiles();
    }

    showSuccess(`已从预设「${presetName}」加载完整配置，所有参数已自动填充，可修改后编译`);
}

// 自动匹配预设的通信方式到两级通信选择
function _autoSelectPresetConnection(config) {
    const connStr = (config.default_connection || '').toUpperCase();
    const connSelect = document.getElementById('compileConnection');
    if (!connSelect) return;

    // 判断通信类型
    let commType = '';
    if (connStr.includes('BRIDGE') || connStr.includes('USB转CAN') || connStr.includes('USBCANBUS') ||
        (connStr.includes('USB') && connStr.includes('CAN') && !connStr.includes('(ON'))) {
        commType = 'usbcanbridge';
    } else if (connStr.includes('CAN')) {
        commType = 'can';
    } else if (connStr.includes('USB') || connStr.includes('USBSERIAL')) {
        commType = 'usb';
    } else if (connStr.includes('SERIAL') || connStr.includes('UART')) {
        commType = 'serial';
    }

    if (!commType) return;

    // 选择第一级：通信类型
    let found = false;
    for (let i = 0; i < connSelect.options.length; i++) {
        if (connSelect.options[i].value === commType) {
            connSelect.value = commType;
            found = true;
            break;
        }
    }
    if (!found) return;

    // 触发第二级选项生成
    onCompileConnectionChange();

    // 匹配第二级子选项
    const detailSelect = document.getElementById('compileConnectionDetail');
    if (detailSelect) {
        const connDisplay = config.default_connection;
        let matched = false;
        for (let i = 1; i < detailSelect.options.length; i++) {
            const optText = detailSelect.options[i].textContent;
            // 匹配引脚格式如 PA11/PA12
            const pinMatch = connDisplay.match(/P[A-K]\d+\/P[A-K]\d+/i);
            if (pinMatch && optText.toUpperCase().includes(pinMatch[0].toUpperCase())) {
                detailSelect.value = detailSelect.options[i].value;
                matched = true;
                break;
            }
            // 匹配文本
            if (optText.includes(connDisplay) || connDisplay.includes(optText)) {
                detailSelect.value = detailSelect.options[i].value;
                matched = true;
                break;
            }
        }
        // 只有一个选项则自动选中
        if (!matched && detailSelect.options.length === 2) {
            detailSelect.selectedIndex = 1;
        }
    }

    // RP2040 CAN GPIO引脚
    if (config.can_gpio) {
        const rxInput = document.getElementById('compileRp2040CanRx');
        const txInput = document.getElementById('compileRp2040CanTx');
        if (rxInput) rxInput.value = config.can_gpio.rx;
        if (txInput) txInput.value = config.can_gpio.tx;
    }
}

function _normalizeCompileSymbol(symbol) {
    return String(symbol || '').replace(/^CONFIG_/, '').toUpperCase();
}

function _selectCompileOption(select, value) {
    if (!select || value === undefined || value === null || value === '') return false;
    const target = String(value);
    for (let i = 0; i < select.options.length; i++) {
        if (select.options[i].value === target) {
            select.value = select.options[i].value;
            return true;
        }
    }
    const targetLower = target.toLowerCase();
    for (let i = 0; i < select.options.length; i++) {
        if (select.options[i].value.toLowerCase() === targetLower) {
            select.value = select.options[i].value;
            return true;
        }
    }
    return false;
}

function _setCompileSelectValue(select, value, label) {
    if (!select || value === undefined || value === null || value === '') return false;
    if (_selectCompileOption(select, value)) return true;
    const opt = document.createElement('option');
    opt.value = String(value);
    opt.textContent = label || String(value);
    select.appendChild(opt);
    select.value = opt.value;
    return true;
}

function _selectCompileSymbol(select, symbol) {
    if (!select || !symbol) return false;
    const target = _normalizeCompileSymbol(symbol);
    for (let i = 0; i < select.options.length; i++) {
        if (_normalizeCompileSymbol(select.options[i].value) === target) {
            select.value = select.options[i].value;
            return true;
        }
    }
    return false;
}

async function loadCurrentCompileConfig() {
    const klipperPath = document.getElementById('klipperPath')?.value || '~/klipper';
    try {
        const params = new URLSearchParams({ klipper_path: klipperPath });
        const response = await fetch('/api/firmware/current-config?' + params.toString());
        const data = await response.json();
        if (!response.ok || !data.success) {
            throw new Error(data.error || '读取当前编译参数失败');
        }

        const current = data.params || {};
        if (!current.mcu) {
            throw new Error((data.warnings && data.warnings[0]) || '当前 .config 未识别到 MCU');
        }

        const customMode = document.querySelector('input[name="compileMode"][value="custom"]');
        if (customMode) customMode.checked = true;
        document.getElementById('compilePresetSection').style.display = 'none';
        document.getElementById('compileCustomSection').style.display = 'block';
        document.getElementById('compileMcuDetails').style.display = 'none';
        currentCompileMcu = null;
        loadCompileMcuPlatforms(false);

        const platformSelect = document.getElementById('compileMcuPlatform');
        const platformValue = current.platform || current.platform_key;
        if (!_selectCompileOption(platformSelect, platformValue)) {
            throw new Error(`当前 .config 的平台 ${platformValue || ''} 不在 MCU 数据库中`);
        }
        await onCompileMcuPlatformChange();

        const modelSelect = document.getElementById('compileMcuModel');
        if (!_selectCompileOption(modelSelect, current.mcu)) {
            throw new Error(`当前 .config 的 MCU ${current.mcu} 不在平台 ${platformSelect.value} 中`);
        }
        await onCompileMcuModelChange();

        _setCompileSelectValue(
            document.getElementById('compileCrystal'),
            current.crystal,
            current.crystal_display || formatCompileFrequency(current.crystal)
        );
        _setCompileSelectValue(
            document.getElementById('compileBlOffset'),
            current.bl_offset,
            current.bl_offset_display || formatCompileBlOffset(current.bl_offset, current.mcu)
        );

        const startupPin = document.getElementById('compileStartupPin');
        if (startupPin) startupPin.value = current.startup_pin || '';

        let commType = current.comm_type || '';
        if (!commType && current.comm_config_symbol) {
            const matched = _commAllOptions.find(opt =>
                _normalizeCompileSymbol(opt.config_symbol) === _normalizeCompileSymbol(current.comm_config_symbol)
            );
            commType = matched ? matched.comm_type : '';
        }
        const connSelect = document.getElementById('compileConnection');
        if (commType && _selectCompileOption(connSelect, commType)) {
            onCompileConnectionChange();
            _selectCompileSymbol(document.getElementById('compileConnectionDetail'), current.comm_config_symbol);
        }
        if (current.bridge_can_config) {
            _selectCompileSymbol(document.getElementById('compileBridgeCanPin'), current.bridge_can_config);
        }
        if (current.rp2040_can_rx_gpio !== undefined) {
            const rxInput = document.getElementById('compileRp2040CanRx');
            if (rxInput) rxInput.value = current.rp2040_can_rx_gpio;
        }
        if (current.rp2040_can_tx_gpio !== undefined) {
            const txInput = document.getElementById('compileRp2040CanTx');
            if (txInput) txInput.value = current.rp2040_can_tx_gpio;
        }

        const warningText = (data.warnings || []).length ? `（${data.warnings.join('；')}）` : '';
        showSuccess(`已读取当前 Klipper 编译参数${warningText}`);
    } catch (error) {
        console.error('读取当前编译参数失败:', error);
        showError('读取当前编译参数失败: ' + error.message);
    }
}

// 编译固件
async function compileFirmware() {
    const modeEl = document.querySelector('input[name="compileMode"]:checked');
    const mode = modeEl ? modeEl.value : 'preset';
    
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
        
        // 如果 MCU 详情区域可见，用用户修改后的值覆盖预设
        const mcuDetailsEl = document.getElementById('compileMcuDetails');
        if (mcuDetailsEl && mcuDetailsEl.style.display !== 'none') {
            const crystalVal = document.getElementById('compileCrystal')?.value;
            const blOffsetVal = document.getElementById('compileBlOffset')?.value;
            const startupPinVal = document.getElementById('compileStartupPin')?.value;
            if (crystalVal) config.crystal = crystalVal;
            if (blOffsetVal) config.bl_offset = blOffsetVal;
            config.boot_pins = startupPinVal || null;
        }
        
        // 检查是否有覆盖的连接方式
        const overrideConnection = document.getElementById('compilePresetConnection')?.value;
        if (overrideConnection) {
            // 将简单值映射到Kconfig符号格式
            const connMap = {
                'USB': 'USB (on PA11/PA12)',
                'CAN': 'CAN bus (on PB8/PB9)',
                'SERIAL': 'Serial (on USART1 PA10/PA9)',
                'CAN_BRIDGE': 'USB to CAN bus bridge (USB on PA11/PA12)'
            };
            config.default_connection = connMap[overrideConnection] || overrideConnection;
        }
        
        // 检查是否有启动引脚
        const startupPin = document.getElementById('compilePresetStartupPin')?.value;
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
        compileParams.startup_pin = document.getElementById('compileStartupPin').value;
        
        // 两级通信选择
        const commType = document.getElementById('compileConnection').value;
        compileParams.comm_type = commType;
        
        const detailSelect = document.getElementById('compileConnectionDetail');
        const options = _commGroupedOptions[commType] || [];
        
        if (detailSelect && detailSelect.value) {
            // 有第二级选择
            compileParams.comm_config_symbol = detailSelect.value;
        } else if (options.length === 1) {
            // 只有一个选项，直接使用
            compileParams.comm_config_symbol = options[0].config_symbol;
        } else if (options.length > 1) {
            showError('请选择具体的接口');
            return;
        }
        
        // STM32 USB-CAN桥接：传递CAN引脚
        if (commType === 'usbcanbridge') {
            const bridgePinSelect = document.getElementById('compileBridgeCanPin');
            if (bridgePinSelect && bridgePinSelect.value) {
                compileParams.bridge_can_config = bridgePinSelect.value;
            }
        }
        
        // RP2040 CAN/桥接：传递GPIO引脚
        if (_rp2040CanGpio && (commType === 'can' || commType === 'usbcanbridge')) {
            const rxInput = document.getElementById('compileRp2040CanRx');
            const txInput = document.getElementById('compileRp2040CanTx');
            if (rxInput) compileParams.rp2040_can_rx_gpio = rxInput.value;
            if (txInput) compileParams.rp2040_can_tx_gpio = txInput.value;
        }
    }
    
    // 显示编译中
    const resultDiv = document.getElementById('compileResult');
    resultDiv.style.display = 'block';
    const resultBox = resultDiv.querySelector('.result-box');
    resultBox.innerHTML = '<p id="compileStatusMsg">⏳ 正在编译，请稍候...</p><pre id="compileLogOutput" style="background:#1a1a2e;color:#e0e0e0;padding:10px;max-height:400px;overflow-y:auto;font-size:12px;margin-top:8px;white-space:pre-wrap"></pre>';
    const logEl = document.getElementById('compileLogOutput');
    const statusMsg = document.getElementById('compileStatusMsg');
    
    try {
        const resp = await fetch('/api/firmware/compile', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(compileParams)
        });
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        let lastResult = null;
        
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            const lines = buf.split('\n');
            buf = lines.pop();
            for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                const msg = line.slice(6);
                if (msg.startsWith('[LOG] ')) {
                    if (logEl) { logEl.textContent += msg.slice(6) + '\n'; logEl.scrollTop = logEl.scrollHeight; }
                } else {
                    try {
                        const data = JSON.parse(msg);
                        lastResult = data;
                        if (data.error) {
                            if (logEl) { logEl.textContent += (data.detail || data.error) + '\n'; logEl.scrollTop = logEl.scrollHeight; }
                        }
                    } catch { if (logEl) { logEl.textContent += msg + '\n'; logEl.scrollTop = logEl.scrollHeight; } }
                }
            }
        }
        
        if (lastResult && lastResult.success) {
            compiledFirmwarePath = lastResult.firmware_path;
            compiledFirmwareManifest = lastResult.manifest || null;
            statusMsg.textContent = '✅ 编译成功！';
            statusMsg.style.color = '#4caf50';
            if (logEl) logEl.textContent += `\n固件路径: ${lastResult.firmware_path}\n固件大小: ${lastResult.firmware_size || '未知'}\n`;
            showSuccess('固件编译成功！');
            await refreshFlashPlan(true);
        } else if (lastResult && lastResult.error) {
            statusMsg.textContent = '❌ ' + lastResult.error;
            statusMsg.style.color = '#f44336';
            showError('编译失败: ' + lastResult.error);
        } else {
            statusMsg.textContent = '❌ 编译异常结束';
            statusMsg.style.color = '#f44336';
            showError('编译异常结束');
        }
    } catch (error) {
        console.error('编译失败:', error);
        if (statusMsg) { statusMsg.textContent = '❌ 编译请求失败'; statusMsg.style.color = '#f44336'; }
        if (logEl) logEl.textContent = error.message;
        showError('编译请求失败: ' + error.message);
    }
}

// 刷新设备 ID 列表（USB + CAN，CAN使用与资源页相同的搜索方式）
async function refreshDeviceIds() {
    const select = document.getElementById('flashDeviceId');
    const canIfaceSelect = document.getElementById('flashCanIface');
    const canErrDiv = document.getElementById('flashCanSearchError');
    const previousValue = select.value;
    const canIface = canIfaceSelect ? canIfaceSelect.value : 'can0';

    if (canErrDiv) canErrDiv.style.display = 'none';
    select.innerHTML = '<option value="">-- 正在扫描 --</option>';
    
    try {
        // 根据烧录模式决定是否需要扫描 CAN 设备
        const currentFlashMode = document.getElementById('flashMode')?.value || '';
        const needCan = (currentFlashMode === 'KAT' || currentFlashMode === 'CAN' || currentFlashMode === 'CAN_BRIDGE_KAT');
        
        // 并行：USB检测 + (可选)CAN UUID搜索
        const fetches = [fetch('/api/firmware/detect')];
        if (needCan) {
            fetches.push(fetch('/api/system/can-uuid', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ iface: canIface })
            }));
        }
        const results = await Promise.allSettled(fetches);
        const [usbResp, canResp] = results;
        
        select.innerHTML = '<option value="">-- 选择设备 --</option>';
        
        let usbCount = 0;
        let canCount = 0;
        
        // USB设备 - 添加分组标题
        if (usbResp.status === 'fulfilled') {
            const usbData = await usbResp.value.json();
            if (usbData.devices && usbData.devices.length > 0) {
                // 根据烧录模式过滤USB设备类型
                const filteredDevices = usbData.devices.filter(device => {
                    if (currentFlashMode === 'DFU' || currentFlashMode === 'CAN_BRIDGE_DFU') {
                        // DFU模式：只显示DFU设备
                        return device.type === 'dfu';
                    } else if (currentFlashMode === 'UF2') {
                        // UF2模式：只显示UF2设备
                        return device.id === 'rp2040_boot';
                    } else if (currentFlashMode === 'KAT' || currentFlashMode === 'CAN_BRIDGE_KAT') {
                        // KAT模式：只显示 by-id 串口设备（完整路径），过滤 ttyACM/ttyUSB
                        return device.type === 'usb_serial';
                    } else if (currentFlashMode === 'CAN') {
                        // CAN模式：不显示USB设备（只用CAN UUID）
                        return false;
                    }
                    return true;
                });
                
                if (filteredDevices.length > 0) {
                    // 添加USB分组标题（禁用选项）
                    select.innerHTML += `<option disabled>━━━━━━━━ USB 设备 ━━━━━━━━</option>`;
                    
                    filteredDevices.forEach(device => {
                    // 根据设备类型显示不同图标
                    let icon = '🔌';
                    let typeLabel = '';
                    
                    if (device.type === 'usb_serial') {
                        icon = '🔌';
                        typeLabel = 'USB';
                    } else if (device.type === 'usb_acm') {
                        icon = '📡';
                        typeLabel = 'ACM';
                    } else if (device.type === 'usb_ftdi') {
                        icon = '🔧';
                        typeLabel = 'FTDI';
                    } else if (device.type === 'dfu') {
                        icon = '⚡';
                        typeLabel = 'DFU';
                    } else if (device.id === 'rp2040_boot') {
                        icon = '💾';
                        typeLabel = 'UF2';
                    }
                    
                    // 简化显示：类型 + 设备名
                    const shortName = device.name.length > 40 ? device.name.substring(0, 40) + '...' : device.name;
                    select.innerHTML += `<option value="${device.id}">${icon} [${typeLabel}] ${shortName}</option>`;
                    usbCount++;
                });
                } // end if filteredDevices.length > 0
            }
        }
        
        // CAN设备 - 仅在 KAT/CAN 模式下且有设备时显示分组
        if (canResp && canResp.status === 'fulfilled') {
            const canData = await canResp.value.json();
            
            // 只在有CAN设备时才显示CAN分组标题和设备
            if (canData.uuids && canData.uuids.length > 0) {
                // 添加CAN分组标题（禁用选项）
                select.innerHTML += `<option disabled>━━━━━━━━ CAN 设备 (${canIface}) ━━━━━━━━</option>`;
                
                canData.uuids.forEach(d => {
                    // 根据应用类型和来源构建标签
                    let icon = '';
                    let appLabel = '';
                    
                    if (d.app === 'Klipper') {
                        icon = '';
                        appLabel = d.source === 'moonraker' || d.source === 'filesystem' ? 'Klipper (config)' : 'Klipper';
                    } else if (d.app === 'Katapult') {
                        icon = '';
                        appLabel = 'Katapult';
                    } else if (d.app && d.app !== 'Unknown') {
                        icon = '';
                        appLabel = d.app;
                    } else {
                        appLabel = '';
                    }
                    
                    // 构建完整显示信息
                    let parts = [];
                    // 第一部分：应用类型
                    if (appLabel) {
                        parts.push(appLabel);
                    }
                    // 第二部分：MCU 型号和频率
                    if (d.mcu_model) {
                        const mcuDisplay = d.mcu_freq ? `${d.mcu_model} @ ${d.mcu_freq}` : d.mcu_model;
                        parts.push(mcuDisplay);
                    }
                    const bracketInfo = parts.length > 0 ? ` [${parts.join(' / ')}]` : '';
                    
                    // 第三部分：section 名称（如 [mcu SHT36]）
                    const sectionInfo = d.section ? ` [${d.section}]` : '';
                    
                    const label = `${d.uuid}${bracketInfo}${sectionInfo}`;
                    select.innerHTML += `<option value="${d.uuid}">${icon} ${label}</option>`;
                    canCount++;
                });
            }
            
            // 显示来源提示
            if (canData.source === 'printer_cfg' && canData.skipped > 0 && canErrDiv) {
                canErrDiv.style.display = 'block';
                canErrDiv.innerHTML = `<div style="margin-top:6px;font-size:12px;color:#856404;background:#fff3cd;padding:6px 10px;border-radius:4px;">${canData.skipped} 个配置文件中的设备未连接，已自动过滤</div>`;
            }
        }

        // 添加统计信息
        if (usbCount > 0 || canCount > 0) {
            select.innerHTML += `<option disabled>━━━━━━━━━━━━━━━━━━━━━━━━</option>`;
            const statsText = `共找到 ${usbCount + canCount} 个设备 (USB: ${usbCount}, CAN: ${canCount})`;
            select.innerHTML += `<option disabled style="color:#6c757d;font-style:italic;">${statsText}</option>`;
        }
        
        if (select.options.length === 1) {
            select.innerHTML += '<option value="" disabled>未找到设备</option>';
        }
        
        // 恢复之前的选择（如果仍然有效）
        if (previousValue) {
            for (let i = 0; i < select.options.length; i++) {
                if (select.options[i].value === previousValue) {
                    select.selectedIndex = i;
                    break;
                }
            }
        }
    } catch (error) {
        console.error('扫描设备失败:', error);
        select.innerHTML = '<option value="">-- 扫描失败 --</option>';
    }
}

// 烧录模式变化处理
function onFlashModeChange(skipRefresh = false) {
    const flashModeEl = document.getElementById('flashMode');
    if (!flashModeEl) return;
    const flashMode = flashModeEl.value;
    const tfCardSection = document.getElementById('tfCardSection');
    const flashBtn = document.getElementById('flashFirmwareBtn');
    const deviceIdEl = document.getElementById('flashDeviceId');
    const deviceIdGroup = deviceIdEl ? deviceIdEl.closest('.form-group') : null;
    const canIfaceEl = document.getElementById('flashCanIface');
    const needCan = (flashMode === 'KAT' || flashMode === 'CAN' || flashMode === 'CAN_BRIDGE_KAT');
    
    if (flashMode === 'TF') {
        // TF卡模式：显示下载区域，隐藏烧录按钮和设备选择
        tfCardSection.style.display = 'block';
        flashBtn.style.display = 'none';
        deviceIdGroup.style.display = 'none';
    } else if (flashMode === 'HOST') {
        // HOST模式：隐藏TF卡区域和设备选择，显示烧录按钮和固件源选择
        tfCardSection.style.display = 'none';
        flashBtn.style.display = 'inline-block';
        deviceIdGroup.style.display = 'none';
        // 显示 HOST 固件源卡片
        const hostCard = document.getElementById('hostFirmwareSourceCard');
        if (hostCard) hostCard.style.display = 'block';
    } else {
        // 其他模式：正常显示
        tfCardSection.style.display = 'none';
        flashBtn.style.display = 'inline-block';
        deviceIdGroup.style.display = 'block';
        // 隐藏 HOST 固件源卡片
        const hostCard2 = document.getElementById('hostFirmwareSourceCard');
        if (hostCard2) hostCard2.style.display = 'none';
    }
    // CAN接口选择框只在 KAT/CAN 模式 且 有多个接口时显示
    if (canIfaceEl && needCan) {
        const optionCount = canIfaceEl.options ? canIfaceEl.options.length : 0;
        canIfaceEl.style.display = optionCount > 1 ? '' : 'none';
    } else if (canIfaceEl) {
        canIfaceEl.style.display = 'none';
    }
    // 切换模式后刷新设备列表（过滤 CAN/USB 设备显示）
    if (!skipRefresh) {
        refreshDeviceIds();
        refreshFlashPlan(false);
    }
}

async function fetchFlashPlan() {
    const flashMode = document.getElementById('flashMode')?.value || '';
    const deviceId = document.getElementById('flashDeviceId')?.value || '';
    const canIface = document.getElementById('flashCanIface')?.value || 'can0';
    let firmwarePath = compiledFirmwarePath;
    if (flashMode === 'HOST') {
        const source = document.getElementById('hostFirmwareSource')?.value || 'compiled';
        if (source === 'prebuilt') {
            firmwarePath = document.getElementById('hostPrebuiltPath')?.value?.trim() || '';
        }
    }
    const response = await fetch('/api/firmware/flash/plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            firmware_path: firmwarePath || '',
            flash_mode: flashMode,
            device_id: deviceId,
            can_iface: canIface
        })
    });
    const data = await response.json();
    if (data.manifest) compiledFirmwareManifest = data.manifest;
    return data.plan || null;
}

function renderFlashPlan(plan) {
    const hint = document.getElementById('flashPlanHint');
    if (!hint || !plan) return;
    if (!plan.firmware_path && !compiledFirmwareManifest && !compiledFirmwarePath) {
        hint.style.display = 'none';
        return;
    }
    const warnings = plan.warnings && plan.warnings.length ? `；提示：${plan.warnings.join('；')}` : '';
    const errors = plan.errors && plan.errors.length ? `；需处理：${plan.errors.join('；')}` : '';
    hint.style.display = 'block';
    hint.style.background = plan.ok ? '#eef7ff' : '#fff3cd';
    hint.style.borderLeftColor = plan.ok ? '#2196f3' : '#ff9800';
    hint.textContent = `推荐烧录方式：${plan.recommended_mode || '-'}${warnings}${errors}`;
}

async function refreshFlashPlan(applyRecommendation = false) {
    try {
        let plan = await fetchFlashPlan();
        if (!plan) return;
        const flashModeEl = document.getElementById('flashMode');
        if (applyRecommendation && flashModeEl && plan.recommended_mode) {
            const hasMode = [...flashModeEl.options].some(opt => opt.value === plan.recommended_mode);
            if (hasMode && flashModeEl.value !== plan.recommended_mode) {
                flashModeEl.value = plan.recommended_mode;
                onFlashModeChange(true);
                await refreshDeviceIds();
                plan = await fetchFlashPlan();
            }
        }
        renderFlashPlan(plan);
    } catch (err) {
        console.warn('刷新烧录推荐失败:', err);
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
        showSuccess('TF卡模式：编译后可下载固件复制到TF卡');
        return;
    }
    
    let firmwarePath = compiledFirmwarePath;
    
    if (flashMode === 'HOST') {
        // HOST模式：根据固件源选择文件
        const source = document.getElementById('hostFirmwareSource')?.value || 'compiled';
        if (source === 'prebuilt') {
            const prebuiltPath = document.getElementById('hostPrebuiltPath')?.value?.trim();
            if (!prebuiltPath) {
                showError('请选择或输入预构建固件文件路径');
                return;
            }
            firmwarePath = prebuiltPath;
        } else {
            if (!firmwarePath) {
                firmwarePath = '~/klipper/out/klipper.bin';
            }
        }
        return await flashHostFirmware(firmwarePath);
    }
    
    if (!deviceId && (flashMode === 'KAT' || flashMode === 'CAN' || flashMode === 'CAN_BRIDGE_KAT')) {
        showError('请选择设备 ID');
        return;
    }
    
    if (!firmwarePath) {
        // 如果没有编译过，尝试使用默认路径
        firmwarePath = '~/klipper/out/klipper.bin';
    }

    const precheck = await fetchFlashPlan();
    if (precheck) {
        renderFlashPlan(precheck);
        if (precheck.errors && precheck.errors.length > 0) {
            showError('烧录前预检失败: ' + precheck.errors.join('；'));
            return;
        }
    }
    
    const resultDiv = document.getElementById('flashResult');
    resultDiv.style.display = 'block';
    const resultBox = resultDiv.querySelector('.result-box');
    resultBox.innerHTML = '<p id="flashStatusMsg">⏳ 正在烧录，请稍候...</p><pre id="flashLogOutput" style="background:#1a1a2e;color:#e0e0e0;padding:10px;max-height:400px;overflow-y:auto;font-size:12px;margin-top:8px;white-space:pre-wrap"></pre>';
    const logEl = document.getElementById('flashLogOutput');
    const statusMsg = document.getElementById('flashStatusMsg');
    
    try {
        const canIfaceEl = document.getElementById('flashCanIface');
        const canIface = canIfaceEl ? canIfaceEl.value : 'can0';
        const resp = await fetch('/api/firmware/flash', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                device_id: deviceId,
                flash_mode: flashMode,
                firmware_path: firmwarePath,
                can_iface: canIface
            })
        });
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        let lastResult = null;
        
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            const lines = buf.split('\n');
            buf = lines.pop();
            for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                const msg = line.slice(6);
                if (msg.startsWith('[LOG] ')) {
                    if (logEl) { logEl.textContent += msg.slice(6) + '\n'; logEl.scrollTop = logEl.scrollHeight; }
                } else {
                    try {
                        const data = JSON.parse(msg);
                        lastResult = data;
                        if (data.error) {
                            if (logEl) { logEl.textContent += data.error + '\n'; logEl.scrollTop = logEl.scrollHeight; }
                        }
                    } catch { if (logEl) { logEl.textContent += msg + '\n'; logEl.scrollTop = logEl.scrollHeight; } }
                }
            }
        }
        
        if (lastResult && lastResult.success) {
            statusMsg.textContent = '✅ 烧录成功！';
            statusMsg.style.color = '#4caf50';
            if (lastResult.output && logEl) logEl.textContent += '\n' + lastResult.output;
            showSuccess('固件烧录成功！');
        } else if (lastResult && lastResult.error) {
            statusMsg.textContent = '❌ ' + lastResult.error;
            statusMsg.style.color = '#f44336';
            if (lastResult.output && logEl) logEl.textContent += '\n' + lastResult.output;
            showError('烧录失败: ' + lastResult.error);
        } else {
            statusMsg.textContent = '❌ 烧录异常结束';
            statusMsg.style.color = '#f44336';
            showError('烧录异常结束');
        }
    } catch (error) {
        console.error('烧录失败:', error);
        if (statusMsg) { statusMsg.textContent = '❌ 烧录请求失败'; statusMsg.style.color = '#f44336'; }
        if (logEl) logEl.textContent = error.message;
        showError('烧录请求失败: ' + error.message);
    }
}

// HOST模式固件安装
async function flashHostFirmware(firmwarePath) {
    const resultDiv = document.getElementById('flashResult');
    resultDiv.style.display = 'block';
    const resultBox = resultDiv.querySelector('.result-box');
    resultBox.innerHTML = '<p id="hostStatusMsg">⏳ 正在烧录固件，请稍候...</p><pre id="hostLogOutput" style="background:#1a1a2e;color:#e0e0e0;padding:10px;max-height:400px;overflow-y:auto;font-size:12px;margin-top:8px;white-space:pre-wrap"></pre>';
    const logEl = document.getElementById('hostLogOutput');
    const statusMsg = document.getElementById('hostStatusMsg');
    
    try {
        const resp = await fetch('/api/firmware/install-host', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ firmware_path: firmwarePath })
        });
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        let lastResult = null;
        
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            const lines = buf.split('\n');
            buf = lines.pop();
            for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                const msg = line.slice(6);
                if (msg.startsWith('[LOG] ')) {
                    if (logEl) { logEl.textContent += msg.slice(6) + '\n'; logEl.scrollTop = logEl.scrollHeight; }
                } else {
                    try {
                        const data = JSON.parse(msg);
                        lastResult = data;
                        if (data.error) {
                            if (logEl) { logEl.textContent += data.error + '\n'; logEl.scrollTop = logEl.scrollHeight; }
                        }
                    } catch { if (logEl) { logEl.textContent += msg + '\n'; logEl.scrollTop = logEl.scrollHeight; } }
                }
            }
        }
        
        if (lastResult && lastResult.success) {
            statusMsg.textContent = '✅ ' + (lastResult.message || '固件烧录成功');
            statusMsg.style.color = '#4caf50';
            if (lastResult.flash_output && logEl) logEl.textContent += '\n' + lastResult.flash_output;
            showSuccess('固件烧录成功');
        } else if (lastResult && lastResult.error) {
            statusMsg.textContent = '❌ ' + lastResult.error;
            statusMsg.style.color = '#f44336';
            showError('烧录失败: ' + lastResult.error);
        } else {
            statusMsg.textContent = '❌ 烧录异常结束';
            statusMsg.style.color = '#f44336';
            showError('烧录异常结束');
        }
    } catch (error) {
        console.error('烧录失败:', error);
        if (statusMsg) { statusMsg.textContent = '❌ 烧录请求失败'; statusMsg.style.color = '#f44336'; }
        if (logEl) logEl.textContent = error.message;
        showError('烧录请求失败: ' + error.message);
    }
}

// ==================== HOST 固件源 & 文件浏览器 ====================

// 固件源切换
function onHostSourceChange() {
    const source = document.getElementById('hostFirmwareSource')?.value;
    const prebuiltSection = document.getElementById('hostPrebuiltSection');
    if (prebuiltSection) {
        prebuiltSection.style.display = (source === 'prebuilt') ? 'block' : 'none';
    }
    // 切换到预构建时自动检测路径
    if (source === 'prebuilt') {
        autoDetectHostFirmwarePath();
    }
}

// 自动检测 HOST 预构建固件路径
async function autoDetectHostFirmwarePath() {
    const pathInput = document.getElementById('hostPrebuiltPath');
    if (!pathInput) return;
    
    // 收集当前 MCU 和通信参数
    const mcuId = currentCompileMcu ? currentCompileMcu.mcu.id : '';
    const commType = document.getElementById('compileConnection')?.value || '';
    const blOffset = document.getElementById('compileBlOffset')?.value || '';
    
    try {
        const params = new URLSearchParams();
        if (mcuId) params.set('mcu', mcuId);
        if (commType) params.set('comm_type', commType);
        if (blOffset) params.set('bl_offset', blOffset);
        
        const resp = await fetch('/api/firmware/host-info?' + params.toString());
        const info = await resp.json();
        
        if (info.best_match && info.best_score > 0) {
            pathInput.value = info.best_match.path;
            const sizeStr = info.best_match.size ? ` (${formatFileSize(info.best_match.size)})` : '';
            showSuccess(`已匹配固件: ${info.best_match.name}${sizeStr}`);
        } else if (info.firmware_files && info.firmware_files.length > 0) {
            // 没有精确匹配，但有固件文件
            showSuccess(`找到 ${info.firmware_files.length} 个预构建固件，请手动选择`);
            // 如果只有一个 MCU 类型的固件，自动选中第一个
            const mcuFiles = info.firmware_files.filter(f => f.fw_mcu === mcuId.toLowerCase());
            if (mcuFiles.length === 1) {
                pathInput.value = mcuFiles[0].path;
                showSuccess(`已自动选择: ${mcuFiles[0].name}`);
            }
        } else {
            showSuccess('远程设备未找到预构建固件，请手动选择');
        }
    } catch (err) {
        console.warn('检测 HOST 固件路径失败:', err);
    }
}

// 打开文件浏览器
let _hostBrowserParent = null;

function openHostFileBrowser() {
    const browser = document.getElementById('hostFileBrowser');
    if (!browser) return;
    browser.style.display = 'block';
    // 默认打开预构建固件目录
    loadHostBrowserDir('/usr/lib/firmware/klipper');
}

function hostBrowserGoUp() {
    if (_hostBrowserParent) {
        loadHostBrowserDir(_hostBrowserParent);
    }
}

async function loadHostBrowserDir(path) {
    const listEl = document.getElementById('hostBrowserList');
    const pathEl = document.getElementById('hostBrowserPath');
    const upBtn = document.getElementById('hostBrowserUpBtn');
    if (!listEl) return;
    
    listEl.innerHTML = '<div class="browser-empty">加载中...</div>';
    
    try {
        const params = path ? `?path=${encodeURIComponent(path)}` : '';
        const resp = await fetch(`/api/remote/browse${params}`);
        const data = await resp.json();
        
        if (data.error) {
            listEl.innerHTML = `<div class="browser-empty">${data.error}</div>`;
            return;
        }
        
        _hostBrowserParent = data.parent;
        if (pathEl) pathEl.textContent = data.path;
        if (upBtn) upBtn.style.display = data.parent ? '' : 'none';
        
        if (!data.entries || data.entries.length === 0) {
            listEl.innerHTML = '<div class="browser-empty">目录为空</div>';
            return;
        }
        
        let html = '';
        for (const entry of data.entries) {
            const icon = entry.is_dir ? '&#x1F4C1;' : '&#x1F4C4;';
            const sizeStr = entry.is_dir ? '' : formatFileSize(entry.size);
            const dirClass = entry.is_dir ? ' is-dir' : '';
            const escapedPath = entry.path.replace(/'/g, "\\'");
            html += `<div class="browser-item${dirClass}" onclick="onHostBrowserClick(this, '${escapedPath}', ${entry.is_dir})">
                <span class="item-icon">${icon}</span>
                <span class="item-name">${escapeHtml(entry.name)}</span>
                <span class="item-size">${sizeStr}</span>
            </div>`;
        }
        listEl.innerHTML = html;
    } catch (err) {
        listEl.innerHTML = `<div class="browser-empty">浏览失败: ${err.message}</div>`;
    }
}

function onHostBrowserClick(el, path, isDir) {
    if (isDir) {
        loadHostBrowserDir(path);
    } else {
        document.querySelectorAll('.browser-item.selected').forEach(e => e.classList.remove('selected'));
        el.classList.add('selected');
        const pathInput = document.getElementById('hostPrebuiltPath');
        if (pathInput) pathInput.value = path;
    }
}

function formatFileSize(bytes) {
    if (!bytes || bytes <= 0) return '';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function escapeHtml(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
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
        const board = window._selectedCompileBoardConfig || {};
        const params = new URLSearchParams();
        if (board.manufacturer) params.set('manufacturer', board.manufacturer);
        if (board.board_type || board.type) params.set('board_type', board.board_type || board.type);
        if (board.id) params.set('board_id', board.id);
        if (board.name) params.set('board_name', board.name);
        const response = await fetch('/api/firmware/bl-firmwares' + (params.toString() ? '?' + params.toString() : ''));
        const data = await response.json();
        
        const select = document.getElementById('blFileSelect');
        select.innerHTML = '<option value="">-- 选择 BL 文件 --</option>';
        _lastBlFiles = data.files || [];
        
        if (_lastBlFiles.length > 0) {
            _lastBlFiles.forEach(file => {
                const label = file.relative_path || file.name;
                select.appendChild(new Option(label, file.path));
            });
            select.selectedIndex = 1;
            await onBlFileChange();
        } else {
            loadBlAddressFallback();
        }
    } catch (error) {
        console.error('加载 BL 文件列表失败:', error);
        loadBlAddressFallback();
    }
}

function loadBlAddressFallback() {
    const select = document.getElementById('blFlashAddress');
    if (!select) return;
    select.innerHTML = '';
    const option = new Option('NO BL - 0x08000000', '0x08000000');
    option.dataset.offset = '0';
    option.dataset.platformKey = 'stm32';
    select.appendChild(option);
    _lastBlAddressOptions = [{
        offset: '0',
        address: '0x08000000',
        label: 'NO BL',
        platform_key: 'stm32'
    }];
}

function fillBlAddressOptions(data) {
    const select = document.getElementById('blFlashAddress');
    if (!select) return;
    const options = data.options || [];
    select.innerHTML = '';
    _lastBlAddressOptions = options;
    if (options.length === 0) {
        loadBlAddressFallback();
        return;
    }
    options.forEach(item => {
        const label = `${item.label || item.offset} - ${item.address}`;
        const option = new Option(label, item.address);
        option.dataset.offset = item.offset || '';
        option.dataset.platformKey = data.platform_key || '';
        option.dataset.configSymbol = item.config_symbol || '';
        select.appendChild(option);
    });
    const defaultOption = options.find(item => item.offset === data.default_offset)
        || options.find(item => item.recommended_for_bl)
        || options[0];
    if (defaultOption) {
        select.value = defaultOption.address;
    }
}

async function loadBlAddressOptions() {
    const board = window._selectedCompileBoardConfig || {};
    const params = new URLSearchParams();
    if (currentCompileMcu?.mcu?.id) {
        params.set('mcu', currentCompileMcu.mcu.id);
    } else if (board.mcu) {
        params.set('mcu', board.mcu);
    }
    if (currentCompileMcu?.platform_key) {
        params.set('platform', currentCompileMcu.platform_key);
    } else if (currentCompileMcu?.platform) {
        params.set('platform', currentCompileMcu.platform);
    } else if (board.platform) {
        params.set('platform', board.platform);
    }
    if (board.manufacturer) params.set('manufacturer', board.manufacturer);
    if (board.board_type || board.type) params.set('board_type', board.board_type || board.type);
    if (board.id) params.set('board_id', board.id);

    if (!params.has('mcu')) {
        loadBlAddressFallback();
        return;
    }

    try {
        const response = await fetch('/api/firmware/bl/address-options?' + params.toString());
        const data = await response.json();
        if (!data.success) {
            throw new Error(data.error || '无法加载 BL 烧录地址');
        }
        fillBlAddressOptions(data);
    } catch (error) {
        console.warn('加载 BL 烧录地址失败:', error);
        loadBlAddressFallback();
    }
}

async function onBlFileChange() {
    const select = document.getElementById('blFileSelect');
    const selected = _lastBlFiles.find(file => file.path === select.value);
    if (!selected) {
        await loadBlAddressOptions();
        return;
    }
    const toolEl = document.getElementById('blFlashTool');
    if (toolEl && selected.recommended_tool) {
        toolEl.value = selected.recommended_tool;
    }
    await loadBlAddressOptions();
}

// 烧录 Bootloader
async function flashBootloader() {
    const blFile = document.getElementById('blFileSelect').value;
    const addressSelect = document.getElementById('blFlashAddress');
    const selectedAddress = addressSelect.options[addressSelect.selectedIndex];
    const address = addressSelect.value;
    const dfuOffset = selectedAddress?.dataset.offset || '';
    const platformKey = selectedAddress?.dataset.platformKey || '';
    const tool = document.getElementById('blFlashTool').value;
    const eraseFlash = document.getElementById('blEraseFlash').checked;
    
    if (!blFile) {
        showError('请选择 BL 文件');
        return;
    }
    if (!address && tool !== 'rp2040_flash') {
        showError('请选择 BL 烧录地址');
        return;
    }
    if (eraseFlash && !confirm('擦除整个 Flash 会清除当前固件，确认继续烧录 BL？')) {
        return;
    }
    if (!eraseFlash && !confirm('不擦除整个 Flash 可能保留旧固件并与 BL 偏移规则冲突，确认继续？')) {
        return;
    }
    
    const resultDiv = document.getElementById('blFlashResult');
    resultDiv.style.display = 'block';
    resultDiv.querySelector('.result-box').innerHTML = eraseFlash
        ? '<p>⏳ 正在擦除 Flash 并烧录 BL，请稍候...</p>'
        : '<p>⏳ 正在烧录 BL，请稍候...</p>';
    
    try {
        const response = await fetch('/api/firmware/bl/flash', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                bl_firmware_path: blFile,
                dfu_address: address,
                dfu_offset: dfuOffset,
                platform_key: platformKey,
                flash_mode: tool === 'dfu-util' ? 'DFU' : tool === 'rp2040_flash' ? 'UF2' : tool === 'st-flash' ? 'st-flash' : 'openocd',
                device_id: document.getElementById('flashDeviceId').value || '',
                erase_flash: eraseFlash
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
                    ${result.output ? '<details><summary>详细输出</summary><pre>' + result.output + '</pre></details>' : ''}
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
    
    // 清理两级通信子选项和CAN引脚选项
    let subContainer = document.getElementById('compileConnectionSub');
    if (subContainer) subContainer.remove();
    let pinContainer = document.getElementById('compileCanPinSub');
    if (pinContainer) pinContainer.remove();
    _commGroupedOptions = {};
    _commAllOptions = [];
    _bridgeCanOptions = [];
    _rp2040CanGpio = null;
    
    // 清理启动引脚
    const startupPin = document.getElementById('compileStartupPin');
    if (startupPin) startupPin.value = '';
    
    compiledFirmwarePath = null;
    compiledFirmwareManifest = null;
    currentCompileMcu = null;
    window._selectedCompileBoardConfig = null;
    window._fromPreset = false;
    _lastBlAddressOptions = [];
    loadBlAddressFallback();
}

// 格式化频率
function formatCompileFrequency(freq) {
    if (String(freq).toLowerCase() === 'internal') {
        return 'Internal clock';
    }
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

// ==================== 编译依赖检测 ====================
async function checkDependencies() {
    const statusEl = document.getElementById('depsStatus');
    if (!statusEl) return;
    statusEl.innerHTML = '<p>检测中...</p>';
    try {
        const resp = await fetch('/api/firmware/dependencies');
        const data = await resp.json();
        if (data.error) {
            statusEl.innerHTML = `<p style="color:red">检测失败: ${data.error}</p>`;
            return;
        }
        const rows = data.dependencies.map(dep => {
            const icon = dep.installed ? '&#10003;' : '&#10007;';
            const color = dep.installed ? '#4caf50' : '#f44336';
            const ver = dep.installed ? `<span style="color:#888;font-size:12px">${dep.version}</span>` : `<span style="color:#f44336">未安装 (${dep.pkg})</span>`;
            return `<div style="display:flex;align-items:center;gap:8px;margin:4px 0">
                      <span style="color:${color};font-weight:bold;font-size:16px">${icon}</span>
                      <span style="font-family:monospace">${dep.name}</span>
                      ${ver}
                    </div>`;
        }).join('');
        const summary = data.all_ok
            ? '<p style="color:#4caf50;font-weight:bold">所有依赖已就绪</p>'
            : '<p style="color:#f44336">存在缺失依赖，请点击"安装依赖"</p>';
        statusEl.innerHTML = summary + rows;
    } catch (e) {
        statusEl.innerHTML = `<p style="color:red">请求失败: ${e.message}</p>`;
    }
}

async function installDependencies() {
    const statusEl = document.getElementById('depsStatus');
    if (!statusEl) return;
    statusEl.innerHTML = '<p>正在安装依赖，请稍候...</p><pre id="depsLog" style="background:#111;color:#eee;padding:10px;max-height:300px;overflow-y:auto;font-size:12px"></pre>';
    const logEl = document.getElementById('depsLog');
    try {
        const resp = await fetch('/api/firmware/dependencies/install', { method: 'POST' });
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            const lines = buf.split('\n');
            buf = lines.pop();
            for (const line of lines) {
                if (line.startsWith('data: ')) {
                    const msg = line.slice(6);
                    if (logEl) { logEl.textContent += msg + '\n'; logEl.scrollTop = logEl.scrollHeight; }
                    if (msg.startsWith('[DONE]')) {
                        statusEl.querySelector('p').textContent = '安装完成，重新检测中...';
                        setTimeout(checkDependencies, 1000);
                    } else if (msg.startsWith('[ERROR]')) {
                        statusEl.querySelector('p').style.color = 'red';
                        statusEl.querySelector('p').textContent = msg;
                    }
                }
            }
        }
    } catch (e) {
        if (statusEl.querySelector('p')) statusEl.querySelector('p').textContent = `安装失败: ${e.message}`;
    }
}
