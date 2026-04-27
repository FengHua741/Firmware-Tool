// ==================== 固件编译与烧录页面 - 重构版 ====================

let compileMcuDatabase = {};  // MCU 数据库
let currentCompileMcu = null; // 当前选中的 MCU
let compiledFirmwarePath = null; // 编译成功的固件路径
let _commGroupedOptions = {}; // 按类型分组的通信选项
let _commAllOptions = [];     // 所有通信选项（带compatible_processors）
let _bridgeCanOptions = [];   // STM32 桥接CAN引脚选项
let _rp2040CanGpio = null;    // RP2040 CAN GPIO 配置

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
            await displayCompileMcuDetails(data);
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
    const crystalGroup = crystalSelect.closest('.form-group');
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
    await loadCommunicationOptions(mcu);
    
    // 根据 MCU 预设自动设置烧录模式（自定义模式）
    const flashModeEl = document.getElementById('flashMode');
    if (flashModeEl && typeof MCU_PRESETS !== 'undefined') {
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
    
    document.getElementById('compileMcuDetails').style.display = 'block';
}

// 加载通信选项（两级选择）
async function loadCommunicationOptions(mcu) {
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
        let commOptions = [];
        _bridgeCanOptions = [];
        _rp2040CanGpio = null;
        
        if (mcuId.startsWith('STM32') && data.stm32 && data.stm32.communication_options) {
            commOptions = data.stm32.communication_options;
            // 存储桥接CAN引脚选项，按MCU过滤
            if (data.stm32.bridge_can) {
                _bridgeCanOptions = data.stm32.bridge_can.filter(opt => {
                    if (!opt.compatible_processors || opt.compatible_processors.length === 0) return true;
                    return opt.compatible_processors.includes(mcuId);
                });
            }
        } else if ((mcuId === 'RP2040' || mcuId === 'RP2350') && data.rp2040 && data.rp2040.communication_options) {
            commOptions = data.rp2040.communication_options;
            // 存储RP2040 CAN GPIO配置
            if (data.rp2040.has_canbus || data.rp2040.has_usbcanbus) {
                _rp2040CanGpio = {
                    rx_default: data.rp2040.rx_default || 4,
                    tx_default: data.rp2040.tx_default || 5,
                    range: data.rp2040.range || [0, 29]
                };
            }
        }
        
        // 过滤兼容当前MCU的选项
        const filtered = commOptions.filter(opt => {
            if (!opt.compatible_processors || opt.compatible_processors.length === 0) return true;
            return opt.compatible_processors.includes(mcuId);
        });
        
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
    const connGroup = document.getElementById('compileConnection').closest('.form-group');
    
    // 多个选项时显示第二级选择
    if (options.length > 1) {
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
            detailSelect.innerHTML += `<option value="${opt.config_symbol}" data-comm='${JSON.stringify(opt)}'>${opt.display}</option>`;
        });
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
    // 预留扩展
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
    const presetName = config.name || option.textContent;

    // 设置烧录模式：根据 flash_modes 过滤选项并默认选中 default_flash
    const flashModeEl = document.getElementById('flashMode');
    if (flashModeEl && config.flash_modes && config.flash_modes.length > 0) {
        // 保存当前值用于回退
        const prevValue = flashModeEl.value;
        // 过滤选项：只显示产品支持的烧录模式
        const supportedModes = config.flash_modes;
        Array.from(flashModeEl.options).forEach(opt => {
            opt.style.display = supportedModes.includes(opt.value) ? '' : 'none';
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
    loadCompileMcuPlatforms();

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

    // 自动填充启动引脚
    if (config.boot_pins) {
        const pinInput = document.getElementById('compileStartupPin');
        if (pinInput) pinInput.value = config.boot_pins;
    }

    // 自动选择通信方式
    if (config.default_connection) {
        _autoSelectPresetConnection(config);
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

// 刷新设备 ID 列表（含CAN检测）
async function refreshDeviceIds() {
    const select = document.getElementById('flashDeviceId');
    select.innerHTML = '<option value="">-- 正在扫描 --</option>';
    
    try {
        // 并行扫描USB和CAN设备
        const [usbResp, canResp] = await Promise.allSettled([
            fetch('/api/firmware/detect'),
            fetch('/api/firmware/detect-can')
        ]);
        
        select.innerHTML = '<option value="">-- 选择设备 --</option>';
        
        // USB设备
        if (usbResp.status === 'fulfilled') {
            const usbData = await usbResp.value.json();
            if (usbData.devices && usbData.devices.length > 0) {
                usbData.devices.forEach(device => {
                    select.innerHTML += `<option value="${device.id}">USB: ${device.name} (${device.id})</option>`;
                });
            }
        }
        
        // CAN设备
        if (canResp.status === 'fulfilled') {
            const canData = await canResp.value.json();
            if (canData.devices && canData.devices.length > 0) {
                canData.devices.forEach(device => {
                    select.innerHTML += `<option value="${device.uuid}">CAN: ${device.uuid}${device.app ? ' [' + device.app + ']' : ''}</option>`;
                });
            }
            // 显示CAN错误
            if (canData.error) {
                console.warn('CAN检测提示:', canData.error);
            }
        }
        
        if (select.options.length === 1) {
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
    } else if (flashMode === 'HOST') {
        // HOST模式：隐藏TF卡区域和设备选择，显示烧录按钮
        tfCardSection.style.display = 'none';
        flashBtn.style.display = 'inline-block';
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
    
    let firmwarePath = compiledFirmwarePath;
    
    if (flashMode === 'HOST') {
        // HOST模式：安装固件到上位机
        if (!firmwarePath) {
            firmwarePath = '~/klipper/out/klipper.bin';
        }
        return await flashHostFirmware(firmwarePath);
    }
    
    if (!deviceId) {
        showError('请选择设备 ID');
        return;
    }
    
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

// HOST模式固件安装
async function flashHostFirmware(firmwarePath) {
    const resultDiv = document.getElementById('flashResult');
    resultDiv.style.display = 'block';
    resultDiv.querySelector('.result-box').innerHTML = '<p>⏳ 正在安装固件到上位机，请稍候...</p>';
    
    try {
        const response = await fetch('/api/firmware/install-host', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                firmware_path: firmwarePath
            })
        });
        
        const result = await response.json();
        
        if (result.success) {
            resultDiv.querySelector('.result-box').innerHTML = `
                <div class="status-success">
                    <p>✅ ${result.message || '固件安装成功！'}</p>
                </div>
            `;
            showSuccess('固件安装成功！');
        } else {
            resultDiv.querySelector('.result-box').innerHTML = `
                <div class="status-error">
                    <p>❌ 安装失败</p>
                    <pre>${result.error || '未知错误'}</pre>
                </div>
            `;
            showError('安装失败: ' + (result.error || '未知错误'));
        }
    } catch (error) {
        console.error('安装失败:', error);
        resultDiv.querySelector('.result-box').innerHTML = `
            <div class="status-error">
                <p>❌ 安装请求失败</p>
                <pre>${error.message}</pre>
            </div>
        `;
        showError('安装请求失败: ' + error.message);
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
