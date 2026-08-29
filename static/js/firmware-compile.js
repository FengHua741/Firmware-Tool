// ==================== 固件编译与烧录页面 - 重构版 ====================

let compileMcuDatabase = {};  // MCU 数据库
let currentCompileMcu = null; // 当前选中的 MCU
let compiledFirmwarePath = null; // 编译成功的固件路径
let compiledFirmwareManifest = null; // 编译成功的固件元数据
let _lastBlFiles = [];
let _lastBlAddressOptions = [];
let _lastBlDetectedDevices = [];
let _lastBlToolStatus = {};
let _blDeviceScanRequestId = 0;
let _blDetectionState = { status: 'idle', message: '点击“检测”扫描 BL 烧录设备' };
let _commGroupedOptions = {}; // 按类型分组的通信选项
let _commAllOptions = [];     // 所有通信选项（带compatible_processors）
let _bridgeCanOptions = [];   // STM32 桥接CAN引脚选项
let _rp2040CanGpio = null;    // RP2040 CAN GPIO 配置
let _communicationSubchoices = []; // Kconfig 动态通信子选项
let _communicationProcessorCapabilities = {}; // 当前平台 MCU 能力闭包
let _communicationSubchoiceValues = {}; // 动态子选项当前值
let _lastDetectedCanDevicesByUuid = {}; // 烧录设备列表中识别到的 CAN 节点详情
let _compileMcuPlatformRequestId = 0; // 忽略快速切换平台时返回的过期请求
let _deviceScanRequestId = 0; // 忽略烧录模式/CAN接口切换后的过期扫描
let _firmwarePageInitPromise = null;
let _firmwarePageInitialized = false;
let _lastFlashPlan = null;
let _compileRequestActive = false;
let _flashRequestActive = false;
let _blFlashRequestActive = false;
let _compilePresetAdvancedExpanded = false;

const CAN_BITRATE_DEFAULT = '1000000';
const CAN_BITRATE_LABELS = {
    '1000000': '1M',
    '500000': '500K',
    '250000': '250K',
};

async function processSSEStream(resp, logEl) {
    if (!resp.ok) {
        let errMsg = `HTTP ${resp.status}`;
        try {
            const errData = await resp.json();
            errMsg = errData.error || errMsg;
        } catch {}
        if (logEl) { logEl.textContent += `请求失败: ${errMsg}\n`; logEl.scrollTop = logEl.scrollHeight; }
        return { error: errMsg };
    }
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
                    if (data.log) {
                        if (logEl) { logEl.textContent += data.log + '\n'; logEl.scrollTop = logEl.scrollHeight; }
                        continue;
                    }
                    lastResult = data;
                    if (data.error) {
                        if (logEl) { logEl.textContent += (data.detail || data.error) + '\n'; logEl.scrollTop = logEl.scrollHeight; }
                    }
                } catch { if (logEl) { logEl.textContent += msg + '\n'; logEl.scrollTop = logEl.scrollHeight; } }
            }
        }
    }
    return lastResult;
}

// 初始化固件编译页面
async function initFirmwarePage() {
    if (_firmwarePageInitialized) return;
    if (_firmwarePageInitPromise) return _firmwarePageInitPromise;
    _firmwarePageInitPromise = (async () => {
        await loadCompileMcuDatabase();
        await loadCompilePresetManufacturers();
        await refreshFlashCanIfaces();
        initBlUploadArea();
        resetBlDeviceDetection();
        // 初始化时根据默认烧录模式隐藏 CAN 接口选择框，并恢复最近一次编译信息。
        onFlashModeChange(true);
        await refreshFlashPlan(false);
        _firmwarePageInitialized = true;
    })();
    try {
        await _firmwarePageInitPromise;
    } finally {
        _firmwarePageInitPromise = null;
    }
}

// 刷新固件烧录页的CAN接口列表
// 返回 true 表示有多个CAN接口
async function refreshFlashCanIfaces() {
    const select = document.getElementById('flashCanIface');
    if (!select) return false;
    try {
        const response = await fetch('/api/system/can-iface');
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        select.innerHTML = '';
        let ifaceCount = 0;
        if (data.ifaces && data.ifaces.length > 0) {
            select.innerHTML = data.ifaces.map(iface => `<option value="${escapeHtml(iface.ifname)}">${escapeHtml(iface.ifname)}</option>`).join('');
            ifaceCount = data.ifaces.length;
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
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();

        if (data.success) {
            compileMcuDatabase = data.database;
        }
    } catch (error) {
        console.error('加载 MCU 数据库失败:', error);
    }
}

// 加载预设厂家列表
async function loadCompilePresetManufacturers() {
    try {
        const response = await fetch('/api/config/manufacturers');
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();

        const select = document.getElementById('compilePresetManufacturer');
        select.innerHTML = '<option value="">-- 选择厂家 --</option>';

        if (data.manufacturers) {
            select.innerHTML += data.manufacturers.filter(mfr => mfr !== '自定义').map(mfr => `<option value="${escapeHtml(mfr)}">${escapeHtml(mfr)}</option>`).join('');
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

function _isCompilePresetMode() {
    return document.querySelector('input[name="compileMode"]:checked')?.value === 'preset';
}

function _setCompilePresetConnectionWarning(message, append = false) {
    const warning = document.getElementById('compilePresetConnectionWarning');
    if (!warning) return;
    if (!_isCompilePresetMode() || !window._selectedCompileBoardConfig || !message) {
        if (!append || !message) {
            warning.textContent = '';
            warning.style.display = 'none';
        }
        return;
    }
    const nextMessage = append && warning.textContent
        ? `${warning.textContent}；${message}`
        : message;
    warning.textContent = nextMessage;
    warning.style.display = 'block';
}

function _applyCompilePresetView() {
    const presetWithBoard = _isCompilePresetMode() && Boolean(window._selectedCompileBoardConfig);
    const showAdvanced = !presetWithBoard || _compilePresetAdvancedExpanded;
    const toggle = document.getElementById('compilePresetAdvancedToggle');
    const button = document.getElementById('compilePresetAdvancedBtn');
    const customSection = document.getElementById('compileCustomSection');

    if (toggle) toggle.style.display = presetWithBoard ? 'flex' : 'none';
    if (button) {
        button.setAttribute('aria-expanded', _compilePresetAdvancedExpanded ? 'true' : 'false');
        button.textContent = _compilePresetAdvancedExpanded ? '⚙️ 收起高级选项' : '⚙️ 高级选项';
    }
    if (customSection) {
        customSection.style.display = presetWithBoard
            ? (_compilePresetAdvancedExpanded ? 'block' : 'none')
            : (_isCompilePresetMode() ? 'none' : 'block');
    }
    document.querySelectorAll('.compile-preset-advanced-only').forEach(element => {
        element.style.display = showAdvanced ? (element.dataset.mcuDisplay || '') : 'none';
    });
    if (!presetWithBoard) {
        _setCompilePresetConnectionWarning('');
    }
}

function toggleCompilePresetAdvanced() {
    if (!_isCompilePresetMode() || !window._selectedCompileBoardConfig) return;
    _compilePresetAdvancedExpanded = !_compilePresetAdvancedExpanded;
    _applyCompilePresetView();
}

function _normalizePresetConnectionType(value) {
    const normalized = String(value || '').trim().toUpperCase().replace(/\s+/g, '');
    if (!normalized) return '';
    if (normalized.includes('USB转CAN') || normalized.includes('USBCAN') ||
        normalized.includes('BRIDGE') || (normalized.includes('USB') && normalized.includes('CAN'))) {
        return 'usbcanbridge';
    }
    if (normalized.includes('CAN')) return 'can';
    if (normalized.includes('SERIAL') || normalized.includes('UART') || normalized.includes('RS232') || normalized.includes('串口')) return 'serial';
    if (normalized.includes('USB')) return 'usb';
    return '';
}

function _presetCommunicationTypeLabel(type, fallback) {
    if (!_isCompilePresetMode() || !window._selectedCompileBoardConfig) return fallback;
    const declared = Array.isArray(window._selectedCompileBoardConfig.connections)
        ? window._selectedCompileBoardConfig.connections
        : [];
    const raw = declared.find(value => _normalizePresetConnectionType(value) === type);
    if (!raw) return fallback;
    if (type === 'serial' && String(raw).toUpperCase().includes('RS232')) return 'RS232 (UART)';
    return fallback;
}

function _getCompilePresetConnectionProfile(commType) {
    if (!_isCompilePresetMode() || !window._selectedCompileBoardConfig) return null;
    const profiles = window._selectedCompileBoardConfig.connection_profiles;
    if (!profiles || typeof profiles !== 'object' || Array.isArray(profiles)) return null;
    const profile = profiles[commType];
    return profile && typeof profile === 'object' && !Array.isArray(profile) ? profile : null;
}

function _applyCompilePresetConnectionProfile(commType) {
    const profile = _getCompilePresetConnectionProfile(commType);
    if (!profile) return;

    const detailSelect = document.getElementById('compileConnectionDetail');
    const requestedSymbol = _normalizeCompileSymbol(profile.config_symbol);
    if (detailSelect && requestedSymbol) {
        const matched = [...detailSelect.options].find(option =>
            _normalizeCompileSymbol(option.value) === requestedSymbol
        );
        if (matched) {
            detailSelect.value = matched.value;
        } else {
            _setCompilePresetConnectionWarning(
                `预设通信接口 ${profile.config_symbol} 不受当前 Klipper 支持，请检查版本。`,
                true
            );
        }
    }

    const blSelect = document.getElementById('compileBlOffset');
    if (blSelect && profile.bl_offset !== undefined) {
        const requestedOffset = String(profile.bl_offset);
        const matched = [...blSelect.options].find(option => option.value === requestedOffset);
        if (matched) {
            blSelect.value = requestedOffset;
        } else {
            _setCompilePresetConnectionWarning(
                `预设 BL 偏移 ${requestedOffset} 不受当前 MCU 支持，请检查 Klipper 版本。`,
                true
            );
        }
    }

    const canGpio = profile.can_gpio;
    if (canGpio && typeof canGpio === 'object') {
        const rxInput = document.getElementById('compileRp2040CanRx');
        const txInput = document.getElementById('compileRp2040CanTx');
        if (rxInput && canGpio.rx !== undefined) rxInput.value = canGpio.rx;
        if (txInput && canGpio.tx !== undefined) txInput.value = canGpio.tx;
    }
    if (profile.canbus_frequency !== undefined) {
        _setSelectedCanBitrate(profile.canbus_frequency);
    }

    const flashMode = String(profile.flash_mode || '');
    const flashModeEl = document.getElementById('flashMode');
    if (flashModeEl && flashMode && [...flashModeEl.options].some(option => option.value === flashMode)) {
        if (flashModeEl.value !== flashMode) {
            flashModeEl.value = flashMode;
            onFlashModeChange();
        }
    }
}

function _filterPresetCommunicationOptions(options) {
    if (!_isCompilePresetMode() || !window._selectedCompileBoardConfig) {
        _setCompilePresetConnectionWarning('');
        return options;
    }

    const config = window._selectedCompileBoardConfig;
    if (options.length === 0) {
        _setCompilePresetConnectionWarning('当前 Klipper 未解析出此 MCU 的兼容连接方式，请检查 Kconfig 后再编译。');
        return [];
    }
    const declared = Array.isArray(config.connections) ? config.connections.filter(Boolean) : [];
    if (declared.length === 0) {
        _setCompilePresetConnectionWarning(`预设「${config.name || config.id || '未命名板卡'}」未声明连接方式，已回退显示 MCU 支持的全部方式。`);
        return options;
    }

    const declaredTypes = new Set(declared.map(_normalizePresetConnectionType).filter(Boolean));
    if (declaredTypes.size === 0) {
        _setCompilePresetConnectionWarning(`预设「${config.name || config.id || '未命名板卡'}」的连接方式无法识别，已回退显示 MCU 支持的全部方式。`);
        return options;
    }

    const declaredOrder = new Map([...declaredTypes].map((type, index) => [type, index]));
    const restricted = options
        .filter(option => declaredTypes.has(option.comm_type))
        .sort((left, right) => declaredOrder.get(left.comm_type) - declaredOrder.get(right.comm_type));
    if (restricted.length === 0) {
        _setCompilePresetConnectionWarning(`预设声明的连接方式与当前 MCU 能力不匹配，已回退显示 MCU 支持的全部方式。`);
        return options;
    }

    const availableTypes = new Set(restricted.map(option => option.comm_type));
    const unavailable = [...declaredTypes].filter(type => !availableTypes.has(type));
    if (unavailable.length > 0) {
        const labels = { usb: 'USB', usbcanbridge: 'USB桥接CAN', can: 'CAN', serial: 'UART' };
        _setCompilePresetConnectionWarning(`部分声明方式不受当前 MCU 支持：${unavailable.map(type => labels[type] || type).join('、')}`);
    } else {
        _setCompilePresetConnectionWarning('');
    }
    return restricted;
}

// 编译模式切换
async function onCompileModeChange() {
    const modeEl = document.querySelector('input[name="compileMode"]:checked');
    const mode = modeEl ? modeEl.value : 'preset';
    const presetSection = document.getElementById('compilePresetSection');
    const customSection = document.getElementById('compileCustomSection');

    if (mode === 'preset') {
        presetSection.style.display = 'block';
        const modelSelect = document.getElementById('compilePresetModel');
        const selectedOption = modelSelect?.options?.[modelSelect.selectedIndex];
        if (selectedOption?.dataset?.config) {
            onCompilePresetModelChange();
            return;
        }
        customSection.style.display = 'none';
    } else {
        _clearSelectedCompileBoard();
        presetSection.style.display = 'none';
        customSection.style.display = 'block';
        _compilePresetAdvancedExpanded = false;
        _applyCompilePresetView();
        currentCompileMcu = null;
        document.getElementById('compileMcuDetails').style.display = 'none';
        await loadCompileMcuPlatforms();

        // 默认平台加载完成后，浏览器会自动选中首个 MCU。此时必须执行与
        // 手动选择型号相同的联动，才能展开并填充 MCU 详细参数。
        const currentMode = document.querySelector('input[name="compileMode"]:checked')?.value;
        const modelSelect = document.getElementById('compileMcuModel');
        if (currentMode === 'custom' && modelSelect?.value) {
            await onCompileMcuModelChange();
        }
        return;
    }

    // 重置
    currentCompileMcu = null;
    document.getElementById('compileMcuDetails').style.display = 'none';
    _compilePresetAdvancedExpanded = false;
    _applyCompilePresetView();
}

// 加载 MCU 平台列表
function loadCompileMcuPlatforms(autoDefault = true) {
    const select = document.getElementById('compileMcuPlatform');
    const opts = Object.keys(compileMcuDatabase).map(platform => `<option value="${escapeHtml(platform)}">${escapeHtml(platform)}</option>`).join('');
    select.innerHTML = '<option value="">-- 选择平台 --</option>' + opts;
    // 默认选中 STM32
    if (autoDefault && compileMcuDatabase['STM32']) {
        select.value = 'STM32';
        return onCompileMcuPlatformChange();
    }
    return Promise.resolve();
}

// MCU 平台选择变化
async function onCompileMcuPlatformChange() {
    const requestId = ++_compileMcuPlatformRequestId;
    const platform = document.getElementById('compileMcuPlatform').value;
    const modelSelect = document.getElementById('compileMcuModel');

    modelSelect.innerHTML = '<option value="">-- 选择型号 --</option>';
    modelSelect.disabled = true;
    document.getElementById('compileMcuDetails').style.display = 'none';
    currentCompileMcu = null;

    if (!platform) return;

    try {
        const response = await fetch(`/api/klipper/mcus/${platform}`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();

        // 用户可能已切换到其他平台，不能让较慢的旧响应覆盖当前型号列表。
        if (requestId !== _compileMcuPlatformRequestId) return;

        if (data.success) {
            modelSelect.innerHTML = data.mcus.map(mcu => `<option value="${escapeHtml(mcu.id)}">${escapeHtml(mcu.name)}</option>`).join('');
            modelSelect.disabled = false;
        }
    } catch (error) {
        if (requestId !== _compileMcuPlatformRequestId) return;
        console.error('加载 MCU 列表失败:', error);
    }
}

// MCU 型号选择变化
async function onCompileMcuModelChange() {
    const modelSelect = document.getElementById('compileMcuModel');
    const mcuId = modelSelect.value;
    const selectedOption = modelSelect.options[modelSelect.selectedIndex];

    if (!mcuId) {
        document.getElementById('compileMcuDetails').style.display = 'none';
        return;
    }

    if (selectedOption?.dataset?.detectedMcu) {
        try {
            const data = JSON.parse(selectedOption.dataset.detectedMcu);
            currentCompileMcu = data;
            await displayCompileMcuDetails(data);
            const selectedDev = _lastDetectedCanDevicesByUuid[String(document.getElementById('flashDeviceId')?.value || '').toLowerCase()];
            _renderFlashDeviceCompare(selectedDev || null);
        } catch (error) {
            console.error('加载识别 MCU 详情失败:', error);
            showError(`加载识别 MCU 详情失败: ${error.message || error}`);
        }
        return;
    }

    try {
        const response = await fetch(`/api/klipper/mcu-info/${mcuId}`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();

        if (data.success) {
            currentCompileMcu = data;
            await displayCompileMcuDetails(data);
            const blSection = document.getElementById('blFlashSection');
            if (blSection && blSection.style.display !== 'none') {
                await loadBlAddressOptions();
            }
            const selectedDev = _lastDetectedCanDevicesByUuid[String(document.getElementById('flashDeviceId')?.value || '').toLowerCase()];
            _renderFlashDeviceCompare(selectedDev || null);
        } else {
            showError(`加载 MCU 详情失败: ${data.error || mcuId}`);
        }
    } catch (error) {
        console.error('加载 MCU 详情失败:', error);
        showError(`加载 MCU 详情失败: ${error.message || error}`);
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
    let crystalOptionHtml = '';
    (mcu.crystals || []).forEach(freq => {
        const label = formatCompileFrequency(freq);
        crystalOptionHtml += `<option value="${escapeHtml(freq)}">${escapeHtml(label)}</option>`;
    });
    crystalSelect.innerHTML = crystalOptionHtml;
    const showCrystal = mcu.id !== 'rp2040' && mcu.id !== 'rp2350' && (mcu.crystals || []).length > 1;
    crystalGroup.dataset.mcuDisplay = showCrystal ? 'block' : 'none';
    crystalGroup.style.display = showCrystal ? 'block' : 'none';

    // BL 偏移选项
    const blSelect = document.getElementById('compileBlOffset');
    blSelect.innerHTML = '';
    let blOptionHtml = '';
    (mcu.bl_offsets || []).forEach(offset => {
        const label = formatCompileBlOffset(offset, mcu.id);
        blOptionHtml += `<option value="${escapeHtml(offset)}">${escapeHtml(label)}</option>`;
    });
    blSelect.innerHTML = blOptionHtml;

    // 连接方式 - 两级选择（从Kconfig动态获取）
    await loadCommunicationOptions(mcu, data.platform_key);

    // 根据 MCU 预设自动设置烧录模式（自定义模式）
    // 如果从预设产品切换过来，保留预设配置的烧录模式，不覆盖
    const flashModeEl = document.getElementById('flashMode');
    if (flashModeEl && typeof MCU_PRESETS !== 'undefined' && !window._fromPreset && !window._preserveFlashMode) {
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
    if (window._preserveFlashMode) {
        window._preserveFlashMode = false;
    }

    document.getElementById('compileMcuDetails').style.display = 'block';
    _applyCompilePresetView();
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
    'STM32H503': 'stm32',
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
    connSelect.disabled = true;

    // 隐藏子选项区域
    const canBridgeOptions = document.getElementById('compileCanBridgeOptions');
    if (canBridgeOptions) canBridgeOptions.style.display = 'none';
    let subContainer = document.getElementById('compileConnectionSub');
    if (subContainer) subContainer.remove();

    try {
        const response = await fetch('/api/klipper/communication-options');
        if (!response.ok) { _fallbackConnectionOptions(connSelect); return; }
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
        _communicationSubchoices = [];
        _communicationProcessorCapabilities = {};
        _communicationSubchoiceValues = {};

        if (platformData && platformData.communication_options) {
            commOptions = platformData.communication_options;
            // 存储桥接CAN引脚选项，按MCU过滤
            if (platformData.bridge_can) {
                _bridgeCanOptions = platformData.bridge_can.filter(opt => {
                    const compatible = opt.compatible_processors || [];
                    if (opt.compatibility_resolved === true) return compatible.includes(mcuId);
                    return compatible.length > 0 && compatible.includes(mcuId);
                });
            }
            _communicationSubchoices = platformData.communication_subchoices || [];
            _communicationProcessorCapabilities = platformData.processor_capabilities || {};
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
            const compatible = opt.compatible_processors || [];
            if (opt.compatibility_resolved === true) return compatible.includes(mcuId);
            return compatible.length > 0 && compatible.includes(mcuId);
        });

        filtered = _filterPresetCommunicationOptions(filtered);
        _commAllOptions = filtered;
        _commGroupedOptions = {};
        filtered.forEach(opt => {
            const type = opt.comm_type || 'unknown';
            if (!_commGroupedOptions[type]) _commGroupedOptions[type] = [];
            _commGroupedOptions[type].push(opt);
        });

        // 第一级：通信类型
        const typeLabels = { 'usb': 'USB', 'serial': 'Serial/UART', 'can': 'CAN', 'usbcanbridge': 'USB转CAN桥接' };
        connSelect.innerHTML = filtered.length
            ? '<option value="">-- 选择通信类型 --</option>'
            : '<option value="">-- 当前 MCU 没有已确认的连接方式 --</option>';
        const typeOpts = Object.keys(_commGroupedOptions).map(type => {
            const label = _presetCommunicationTypeLabel(type, typeLabels[type] || type);
            return `<option value="${escapeHtml(type)}">${escapeHtml(label)}</option>`;
        }).join('');
        connSelect.innerHTML += typeOpts;
        connSelect.disabled = filtered.length === 0;
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
    connSelect.innerHTML = '<option value="">-- 连接能力加载失败，请检查 Klipper Kconfig --</option>';
    connSelect.disabled = true;
    _commGroupedOptions = {};
    _commAllOptions = [];
    _setCompilePresetConnectionWarning('连接能力加载失败，未回退到未经确认的平台选项。');
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
    let bitrateContainer = document.getElementById('compileCanBitrateSub');
    if (bitrateContainer) bitrateContainer.remove();
    document.getElementById('compileCommunicationSubchoices')?.remove();

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

        subContainer.innerHTML = `<label>${escapeHtml(label)}</label><select id="compileConnectionDetail" class="form-control" onchange="onCompileConnectionDetailChange()"></select>`;
        connGroup.parentNode.insertBefore(subContainer, connGroup.nextSibling);

        const detailSelect = document.getElementById('compileConnectionDetail');
        const detailOptsHtml = options.map(opt => {
            const dataComm = escapeHtml(JSON.stringify(opt)).replace(/'/g, '&apos;');
            return `<option value="${escapeHtml(opt.config_symbol)}" data-comm='${dataComm}'>${escapeHtml(opt.display)}</option>`;
        }).join('');
        detailSelect.innerHTML = `<option value="">-- 选择${escapeHtml(label)} --</option>` + detailOptsHtml;
        if (commType === 'can') {
            _selectCanPinsOption(detailSelect, options, 'config_symbol');
        }
        // 只有1个选项时自动选中
        if (!detailSelect.value && options.length === 1) {
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

    if (commType === 'can' || commType === 'usbcanbridge') {
        _showCanBitrateSelector(connGroup);
    }
    _applyCompilePresetConnectionProfile(commType);
    _renderCommunicationSubchoices();
    const selectedDev = _lastDetectedCanDevicesByUuid[String(document.getElementById('flashDeviceId')?.value || '').toLowerCase()];
    _renderFlashDeviceCompare(selectedDev || null);
}

function _insertAfterCompileConnectionOptions(connGroup, container) {
    const insertAfter = document.getElementById('compileCanPinSub') ||
        document.getElementById('compileConnectionSub') ||
        connGroup;
    insertAfter.parentNode.insertBefore(container, insertAfter.nextSibling);
}

// 显示STM32桥接CAN引脚选择器
function _showBridgeCanPinSelector(connGroup) {
    const pinContainer = document.createElement('div');
    pinContainer.id = 'compileCanPinSub';
    pinContainer.className = 'form-group';
    pinContainer.style.marginTop = '10px';

    pinContainer.innerHTML = `<label>CAN总线引脚</label><select id="compileBridgeCanPin" class="form-control" onchange="onCompileBridgeCanPinChange()"></select>`;

    _insertAfterCompileConnectionOptions(connGroup, pinContainer);

    const pinSelect = document.getElementById('compileBridgeCanPin');
    const pinOptsHtml = _bridgeCanOptions.map(opt => `<option value="${escapeHtml(opt.config)}">${escapeHtml(opt.display)}</option>`).join('');
    pinSelect.innerHTML = '<option value="">-- 选择CAN引脚 --</option>' + pinOptsHtml;
    _selectCanPinsOption(pinSelect, _bridgeCanOptions, 'config');
}

function _selectCanPinsOption(select, options, valueKey) {
    if (!select || !Array.isArray(options)) return false;
    const preferred = options.find(opt => {
        const text = [
            opt.pins,
            opt.display,
            opt[valueKey],
            opt.config,
            opt.config_symbol,
        ].map(v => String(v || '').toUpperCase()).join(' ');
        return text.includes('PB8/PB9') || text.includes('PB8_PB9');
    });
    if (!preferred) return false;
    select.value = preferred[valueKey] || preferred.config || preferred.config_symbol || '';
    return Boolean(select.value);
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

function _showCanBitrateSelector(connGroup) {
    const bitrateContainer = document.createElement('div');
    bitrateContainer.id = 'compileCanBitrateSub';
    bitrateContainer.className = 'form-group';
    bitrateContainer.style.marginTop = '10px';
    bitrateContainer.innerHTML = `
        <label>CAN 速率</label>
        <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;">
            <select id="compileCanBitrate" class="form-control form-select" style="max-width:160px;" onchange="onCompileCanBitrateChange()">
                <option value="1000000" selected>1M</option>
                <option value="500000">500K</option>
                <option value="250000">250K</option>
                <option value="custom">自定义</option>
            </select>
            <input type="number" id="compileCanBitrateCustom" class="form-control" style="display:none;max-width:180px;" min="10000" max="5000000" step="10000" placeholder="例如 800000">
        </div>
    `;
    _insertAfterCompileConnectionOptions(connGroup, bitrateContainer);
}

function onCompileCanBitrateChange() {
    const select = document.getElementById('compileCanBitrate');
    const customInput = document.getElementById('compileCanBitrateCustom');
    if (!select || !customInput) return;
    customInput.style.display = select.value === 'custom' ? '' : 'none';
    if (select.value === 'custom' && !customInput.value) {
        customInput.value = CAN_BITRATE_DEFAULT;
    }
    const selectedDev = _lastDetectedCanDevicesByUuid[String(document.getElementById('flashDeviceId')?.value || '').toLowerCase()];
    _renderFlashDeviceCompare(selectedDev || null);
}

function _normalizeCanBitrate(value) {
    const raw = String(value || '').trim().toLowerCase();
    if (!raw) return '';
    const match = raw.match(/^(\d+(?:\.\d+)?)\s*([km])?$/);
    if (!match) return raw;
    const number = Number(match[1]);
    if (!Number.isFinite(number) || number <= 0) return raw;
    const multiplier = match[2] === 'm' ? 1000000 : match[2] === 'k' ? 1000 : 1;
    return String(Math.round(number * multiplier));
}

function _getSelectedCanBitrate() {
    const select = document.getElementById('compileCanBitrate');
    if (!select) return CAN_BITRATE_DEFAULT;
    if (select.value !== 'custom') return select.value || CAN_BITRATE_DEFAULT;
    return _normalizeCanBitrate(document.getElementById('compileCanBitrateCustom')?.value) || CAN_BITRATE_DEFAULT;
}

function _setSelectedCanBitrate(value) {
    const bitrate = _normalizeCanBitrate(value) || CAN_BITRATE_DEFAULT;
    const select = document.getElementById('compileCanBitrate');
    const customInput = document.getElementById('compileCanBitrateCustom');
    if (!select) return;
    if (CAN_BITRATE_LABELS[bitrate]) {
        select.value = bitrate;
        if (customInput) customInput.style.display = 'none';
        return;
    }
    select.value = 'custom';
    if (customInput) {
        customInput.value = bitrate;
        customInput.style.display = '';
    }
}

function _compileSourceLabel(source) {
    const labels = {
        klipper_identify: '实读',
        moonraker_mcu_constants: '实读',
        katapult_protocol: 'KAT读取',
        firmware_inferred: '固件推断',
        board_config_inferred: '数据库推断',
        mcu_can_default: '默认',
    };
    return labels[source] || source || '';
}

function _compileFormatFrequency(value) {
    if (value === 'internal') return 'Internal clock';
    const num = Number(value);
    if (!Number.isFinite(num) || num <= 0) return String(value || '');
    if (num >= 1000000) return `${(num / 1000000).toFixed(2).replace(/\.?0+$/, '')} MHz`;
    if (num >= 1000) return `${(num / 1000).toFixed(2).replace(/\.?0+$/, '')} kHz`;
    return `${num} Hz`;
}

function _compileFormatBitrate(value) {
    const bitrate = _normalizeCanBitrate(value);
    const num = Number(bitrate);
    if (!Number.isFinite(num) || num <= 0) return String(value || '');
    if (num >= 1000000) return `${(num / 1000000).toFixed(2).replace(/\.?0+$/, '')} Mbps`;
    if (num >= 1000) return `${(num / 1000).toFixed(2).replace(/\.?0+$/, '')} kbps`;
    return `${num} bps`;
}

function _compileNormalizeMcu(value) {
    return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '').replace(/xx$/, '');
}

function _compileBaseMcuKey(value) {
    const normalized = _compileNormalizeMcu(value);
    if (!normalized) return '';
    const stm32 = normalized.match(/^(stm32[a-z]\d[a-z0-9]{2})/);
    if (stm32) return stm32[1];
    const n32 = normalized.match(/^(n32[a-z]\d{3})/);
    if (n32) return n32[1];
    return normalized;
}

function _compileMcuNamesCompatible(a, b) {
    const aNorm = _compileNormalizeMcu(a);
    const bNorm = _compileNormalizeMcu(b);
    if (!aNorm || !bNorm) return false;
    if (aNorm === bNorm) return true;
    const aBase = _compileBaseMcuKey(aNorm);
    const bBase = _compileBaseMcuKey(bNorm);
    if (aBase && bBase && aBase === bBase) return true;
    return (aNorm.startsWith(bNorm) && aNorm.length <= bNorm.length + 4)
        || (bNorm.startsWith(aNorm) && bNorm.length <= aNorm.length + 4);
}

function _findCompileMcuMatch(mcuModel) {
    const target = _compileNormalizeMcu(mcuModel);
    if (!target) return null;
    let compatibleMatch = null;
    for (const [platform, platformData] of Object.entries(compileMcuDatabase || {})) {
        const mcus = platformData?.mcus || {};
        for (const [mcuId, mcuInfo] of Object.entries(mcus)) {
            const names = [
                mcuId,
                mcuInfo?.id,
                mcuInfo?.name,
                mcuInfo?.config_symbol,
            ];
            if (names.some(name => _compileNormalizeMcu(name) === target)) {
                return { platform, mcuId, match_type: 'exact' };
            }
            if (!compatibleMatch && names.some(name => _compileMcuNamesCompatible(name, target))) {
                compatibleMatch = { platform, mcuId, match_type: 'compatible' };
            }
        }
    }
    return compatibleMatch;
}

function _inferCompilePlatformFromMcu(mcuModel) {
    const normalized = _compileNormalizeMcu(mcuModel);
    if (!normalized) return null;
    if (normalized.startsWith('stm32') || normalized.startsWith('n32')) {
        return { platform: 'STM32', platform_key: 'stm32' };
    }
    if (normalized.startsWith('rp2040') || normalized.startsWith('rp2350')) {
        return { platform: 'RP2040', platform_key: 'rp2040' };
    }
    if (normalized.startsWith('samd') || normalized.startsWith('samc') || normalized.startsWith('same')) {
        return { platform: 'ATSAMD', platform_key: 'atsamd' };
    }
    if (normalized.startsWith('lpc176')) {
        return { platform: 'LPC176x', platform_key: 'lpc176x' };
    }
    if (normalized.startsWith('hc32f460')) {
        return { platform: 'HC32F460', platform_key: 'hc32f460' };
    }
    if (normalized.startsWith('sam3') || normalized.startsWith('sam4') || normalized.startsWith('same70')) {
        return { platform: 'ATSAM', platform_key: 'atsam' };
    }
    if (normalized.startsWith('atmega') || normalized.startsWith('at90') || normalized.startsWith('lgt8')) {
        return { platform: 'AVR', platform_key: 'avr' };
    }
    return null;
}

function _makeDetectedCompileMcuDetails(dev, platformInfo) {
    const normalized = _compileNormalizeMcu(dev?.mcu_model);
    const displayName = dev?.mcu_model ? String(dev.mcu_model).toUpperCase() : normalized.toUpperCase();
    return {
        success: true,
        platform: platformInfo.platform,
        platform_key: platformInfo.platform_key,
        detected_fallback: true,
        mcu: {
            id: normalized,
            name: `${displayName} (识别)`,
            crystals: dev?.crystal ? [String(dev.crystal)] : [],
            bl_offsets: dev?.bl_offset ? [String(dev.bl_offset)] : []
        },
        flash_modes: [],
        connections: []
    };
}

function _ensureCompileOption(select, value, label, dataset = {}) {
    if (!select || !value) return null;
    let option = [...select.options].find(opt => opt.value === value);
    if (!option) {
        option = new Option(label || value, value);
        select.appendChild(option);
    } else if (label) {
        option.textContent = label;
    }
    Object.entries(dataset || {}).forEach(([key, val]) => {
        option.dataset[key] = val;
    });
    return option;
}

function _compileConnectionTypeFromDetected(value) {
    const raw = String(value || '').toLowerCase();
    if (!raw) return '';
    if (raw.includes('usb') && raw.includes('can')) return 'usbcanbridge';
    if (raw.includes('can')) return 'can';
    if (raw.includes('usb')) return 'usb';
    if (raw.includes('serial') || raw.includes('uart') || raw.includes('串口')) return 'serial';
    return '';
}

function _compileConnectionDisplay(type) {
    const labels = {
        usbcanbridge: 'USB桥接CAN',
        can: 'CANBUS',
        usb: 'USB',
        serial: '串口/UART',
    };
    return labels[type] || type || '-';
}

function _formatMcuSection(value) {
    const section = String(value || '').trim().replace(/^\[+|\]+$/g, '');
    return section ? `[${section}]` : '';
}

function _compileCanPinsParts(value) {
    if (!value) return [];
    return String(value).split(',').map(v => v.trim()).filter(Boolean);
}

function _compileNormalizePin(value) {
    return String(value || '').trim().toLowerCase().replace(/^[!^~]+/, '').replace(/^gpio/, '');
}

function _compileSelectOptionByPins(select, pins) {
    if (!select || !pins || pins.length < 2) return false;
    const pinText = pins.map(p => String(p || '').toUpperCase().replace(/^[!^~]+/, '')).join('/');
    const pinCompact = pinText.replace(/[^A-Z0-9]/g, '');
    for (let i = 0; i < select.options.length; i++) {
        const opt = select.options[i];
        const text = [
            opt.textContent,
            opt.value,
            opt.dataset ? opt.dataset.comm : '',
        ].map(v => String(v || '').toUpperCase()).join(' ');
        const compact = text.replace(/[^A-Z0-9]/g, '');
        if (text.includes(pinText) || compact.includes(pinCompact)) {
            select.value = opt.value;
            return true;
        }
    }
    return false;
}

async function _selectCompileMcuFromDetected(dev, changes) {
    if (!compileMcuDatabase || Object.keys(compileMcuDatabase).length === 0) {
        await loadCompileMcuDatabase();
    }
    let match = _findCompileMcuMatch(dev?.mcu_model);
    const platformInfo = !match ? _inferCompilePlatformFromMcu(dev?.mcu_model) : null;
    if (!match) {
        if (!platformInfo) {
            if (dev) dev._compile_match_error = `未能从 ${dev?.mcu_model || ''} 推断编译平台`;
            return false;
        }
        const detectedDetails = _makeDetectedCompileMcuDetails(dev, platformInfo);
        match = {
            platform: platformInfo.platform,
            mcuId: detectedDetails.mcu.id,
            match_type: 'detected_fallback',
            detected_details: detectedDetails
        };
    }
    if (dev) {
        dev._compile_match_error = '';
        dev._compile_match_type = match.match_type || '';
    }

    _clearSelectedCompileBoard();
    const customMode = document.querySelector('input[name="compileMode"][value="custom"]');
    if (customMode) customMode.checked = true;
    const presetSection = document.getElementById('compilePresetSection');
    const customSection = document.getElementById('compileCustomSection');
    if (presetSection) presetSection.style.display = 'none';
    if (customSection) customSection.style.display = 'block';

    const platformSelect = document.getElementById('compileMcuPlatform');
    const modelSelect = document.getElementById('compileMcuModel');
    if (!platformSelect || !modelSelect) return false;
    if (!platformSelect.options.length || ![...platformSelect.options].some(opt => opt.value === match.platform)) {
        loadCompileMcuPlatforms(false);
    }
    if (![...platformSelect.options].some(opt => opt.value === match.platform)) {
        _ensureCompileOption(platformSelect, match.platform, `${match.platform} (识别)`);
    }
    if (platformSelect.value !== match.platform) {
        platformSelect.value = match.platform;
        await onCompileMcuPlatformChange();
        changes.push(`MCU平台 ${match.platform}`);
    } else if (![...modelSelect.options].some(opt => opt.value === match.mcuId)) {
        await onCompileMcuPlatformChange();
    }
    if (match.detected_details) {
        _ensureCompileOption(
            modelSelect,
            match.mcuId,
            `${match.detected_details.mcu.name}`,
            { detectedMcu: JSON.stringify(match.detected_details) }
        );
        modelSelect.disabled = false;
    }
    // RP2040 平台的首个选项通常就是 rp2040。平台列表加载后浏览器会自动
    // 选中它，但这不代表型号详情、通信方式等已经初始化完成。除了比较
    // 下拉框值，还必须确认 currentCompileMcu 已加载为目标型号。
    const selectedMcuId = currentCompileMcu?.mcu?.id;
    const detailsReady = selectedMcuId && _compileMcuNamesCompatible(selectedMcuId, match.mcuId);
    if (modelSelect.value !== match.mcuId || !detailsReady) {
        modelSelect.value = match.mcuId;
        window._preserveFlashMode = true;
        await onCompileMcuModelChange();
        const suffix = match.match_type === 'detected_fallback' ? ' (识别值)' : '';
        changes.push(`MCU ${match.mcuId.toUpperCase()}${suffix}`);
    }
    return true;
}

function _setCompileDetectedStartupPin(dev, changes) {
    const input = document.getElementById('compileStartupPin');
    if (!input || !dev?.startup_pin) return false;
    if (input.value === String(dev.startup_pin)) return false;
    input.value = String(dev.startup_pin);
    changes.push(`启动引脚 ${dev.startup_pin}`);
    return true;
}

function _setCompileDetectedBlOffset(dev, changes) {
    const select = document.getElementById('compileBlOffset');
    const value = dev?.bl_offset;
    if (!select || value === undefined || value === null || value === '') return false;
    const before = select.value;
    const label = dev.bl_offset_label || formatCompileBlOffset(value, currentCompileMcu?.mcu?.id || '');
    const changed = _setCompileSelectValue(select, String(value), `${label} (识别)`);
    if (changed && before !== select.value) {
        changes.push(`BL偏移 ${label}`);
        return true;
    }
    return false;
}

function _setCompileDetectedCrystal(dev, changes) {
    const select = document.getElementById('compileCrystal');
    const value = dev?.crystal;
    if (!select || value === undefined || value === null || value === '') return false;
    const before = select.value;
    const label = dev.crystal_label || _compileFormatFrequency(value);
    const changed = _setCompileSelectValue(select, String(value), `${label} (实读)`);
    const crystalGroup = select.closest('.form-group');
    if (crystalGroup && select.options.length > 1) {
        crystalGroup.style.display = 'block';
    }
    if (changed && before !== select.value) {
        changes.push(`晶振 ${label}`);
        return true;
    }
    return false;
}

function _applyDetectedCanDeviceToCompile(dev) {
    if (!dev || !currentCompileMcu) return [];
    const changes = [];
    const detectedMcu = _compileNormalizeMcu(dev.mcu_model);
    const selectedMcu = _compileNormalizeMcu(currentCompileMcu.mcu?.id);
    if (detectedMcu && selectedMcu && !_compileMcuNamesCompatible(detectedMcu, selectedMcu)) return [];

    const desiredComm = _compileConnectionTypeFromDetected(dev.inferred_connection);
    const connSelect = document.getElementById('compileConnection');
    if (!desiredComm || !connSelect || ![...connSelect.options].some(opt => opt.value === desiredComm)) {
        _setCompileDetectedCrystal(dev, changes);
        _setCompileDetectedStartupPin(dev, changes);
        _setCompileDetectedBlOffset(dev, changes);
        return changes;
    }

    if (connSelect.value !== desiredComm) {
        connSelect.value = desiredComm;
        onCompileConnectionChange();
        changes.push(`连接方式 ${_compileConnectionDisplay(desiredComm)}`);
    }

    const pins = _compileCanPinsParts(dev.can_pins);
    if (desiredComm === 'usbcanbridge') {
        if (_compileSelectOptionByPins(document.getElementById('compileBridgeCanPin'), pins)) {
            changes.push(`桥接CAN引脚 ${dev.can_pins}`);
        }
    } else if (desiredComm === 'can') {
        if (_compileSelectOptionByPins(document.getElementById('compileConnectionDetail'), pins)) {
            changes.push(`CAN引脚 ${dev.can_pins}`);
        }
    }

    if (_rp2040CanGpio && pins.length >= 2) {
        const rxInput = document.getElementById('compileRp2040CanRx');
        const txInput = document.getElementById('compileRp2040CanTx');
        const rx = _compileNormalizePin(pins[0]);
        const tx = _compileNormalizePin(pins[1]);
        if (rxInput && rx && rxInput.value !== rx) {
            rxInput.value = rx;
            changes.push(`CAN RX gpio${rx}`);
        }
        if (txInput && tx && txInput.value !== tx) {
            txInput.value = tx;
            changes.push(`CAN TX gpio${tx}`);
        }
    }

    if (dev.canbus_frequency && (desiredComm === 'can' || desiredComm === 'usbcanbridge')) {
        const before = _getSelectedCanBitrate();
        _setSelectedCanBitrate(dev.canbus_frequency);
        if (_getSelectedCanBitrate() !== before) {
            changes.push(`CAN速率 ${_compileFormatBitrate(dev.canbus_frequency)}`);
        }
    }
    _setCompileDetectedStartupPin(dev, changes);
    _setCompileDetectedBlOffset(dev, changes);
    _setCompileDetectedCrystal(dev, changes);
    return changes;
}

async function _applyDetectedCanDeviceParams(dev) {
    const changes = [];
    if (!dev) return changes;
    dev._compile_match_error = '';

    if (dev.mcu_model) {
        const selectedMcu = currentCompileMcu?.mcu?.id;
        if (!selectedMcu || !_compileMcuNamesCompatible(selectedMcu, dev.mcu_model)) {
            await _selectCompileMcuFromDetected(dev, changes);
        }
    }

    const applied = _applyDetectedCanDeviceToCompile(dev);
    if (Array.isArray(applied)) {
        applied.forEach(item => {
            if (item && !changes.includes(item)) changes.push(item);
        });
    }
    return changes;
}

function _renderFlashDeviceCompare(dev) {
    const hint = document.getElementById('flashDeviceCompareHint');
    if (!hint) return;
    if (!dev) {
        hint.style.display = 'none';
        hint.innerHTML = '';
        return;
    }

    const lines = [];
    const warnings = [];
    const fieldSources = dev.field_sources || {};
    const detectedMcu = dev.mcu_model ? String(dev.mcu_model).toUpperCase() : '';
    const selectedMcu = currentCompileMcu?.mcu?.id || '';
    const detectedComm = _compileConnectionTypeFromDetected(dev.inferred_connection);
    const selectedComm = document.getElementById('compileConnection')?.value || '';

    if (detectedMcu) lines.push(`识别 MCU: ${detectedMcu}`);
    if (dev.mcu_version) lines.push(`固件: ${dev.mcu_version}`);
    if (dev.inferred_connection) {
        const src = _compileSourceLabel(fieldSources.inferred_connection);
        lines.push(`连接方式: ${dev.inferred_connection}${src ? ` (${src})` : ''}`);
    }
    if (dev.canbus_frequency) lines.push(`CAN速率: ${_compileFormatBitrate(dev.canbus_frequency)}`);
    if (dev.can_pins) lines.push(`CAN引脚: ${dev.can_pins}`);
    if (dev.startup_pin) lines.push(`启动引脚: ${dev.startup_pin}`);
    if (dev.bl_offset_label) lines.push(`BL偏移: ${dev.bl_offset_label}`);
    if (dev.crystal) {
        const src = _compileSourceLabel(fieldSources.crystal);
        const label = dev.crystal_label || _compileFormatFrequency(dev.crystal);
        lines.push(`晶振: ${label}${src ? ` (${src})` : ''}`);
    }
    if (dev.mcu_freq) lines.push(`主频: ${_compileFormatFrequency(dev.mcu_freq)}`);

    if (selectedMcu && detectedMcu && !_compileMcuNamesCompatible(selectedMcu, detectedMcu)) {
        warnings.push(`当前编译 MCU 为 ${selectedMcu}，与设备 ${detectedMcu} 不一致`);
    } else if (dev._compile_match_error) {
        warnings.push(dev._compile_match_error);
    } else if (dev._compile_match_type === 'detected_fallback') {
        warnings.push('编译 MCU 数据库无精确型号，已按设备识别值填入自定义参数');
    } else if (!selectedMcu && detectedMcu) {
        warnings.push('当前尚未选择编译 MCU，仅显示设备固件信息用于对照');
    }
    if (selectedComm && detectedComm && selectedComm !== detectedComm) {
        warnings.push(`当前连接方式为 ${_compileConnectionDisplay(selectedComm)}，设备识别为 ${_compileConnectionDisplay(detectedComm)}`);
    }
    if ((selectedComm === 'can' || selectedComm === 'usbcanbridge') && dev.canbus_frequency) {
        const selectedBitrate = _getSelectedCanBitrate();
        const detectedBitrate = _normalizeCanBitrate(dev.canbus_frequency);
        if (selectedBitrate && detectedBitrate && selectedBitrate !== detectedBitrate) {
            warnings.push(`当前 CAN 速率为 ${_compileFormatBitrate(selectedBitrate)}，设备识别为 ${_compileFormatBitrate(detectedBitrate)}`);
        }
    }
    const selectedStartupPin = document.getElementById('compileStartupPin')?.value || '';
    if (selectedStartupPin && dev.startup_pin && selectedStartupPin !== String(dev.startup_pin)) {
        warnings.push(`当前启动引脚为 ${selectedStartupPin}，设备识别为 ${dev.startup_pin}`);
    }
    const selectedBlOffset = document.getElementById('compileBlOffset')?.value || '';
    if (selectedBlOffset && dev.bl_offset && String(selectedBlOffset) !== String(dev.bl_offset)) {
        warnings.push(`当前 BL 偏移为 ${formatCompileBlOffset(selectedBlOffset, selectedMcu)}，设备识别为 ${dev.bl_offset_label || dev.bl_offset}`);
    }
    const selectedCrystal = document.getElementById('compileCrystal')?.value || '';
    if (selectedCrystal && dev.crystal && String(selectedCrystal) !== String(dev.crystal)) {
        warnings.push(`当前晶振为 ${_compileFormatFrequency(selectedCrystal)}，设备识别为 ${dev.crystal_label || _compileFormatFrequency(dev.crystal)}`);
    }

    hint.style.display = 'block';
    hint.style.borderLeftColor = warnings.length ? 'var(--warning-color)' : 'var(--success-color)';
    hint.style.background = warnings.length ? 'rgba(255,193,7,.12)' : 'rgba(76,175,80,.10)';
    hint.innerHTML = [
        `<div><strong>固件识别对照</strong>: ${lines.map(escapeHtml).join(' · ') || escapeHtml(dev.uuid || '')}</div>`,
        warnings.length ? `<div style="color:var(--warning-color);margin-top:4px;">${warnings.map(escapeHtml).join('；')}</div>` : ''
    ].filter(Boolean).join('');
}

async function _matchSelectedFlashDevice(notify = true) {
    const select = document.getElementById('flashDeviceId');
    const dev = select ? _lastDetectedCanDevicesByUuid[String(select.value || '').toLowerCase()] : null;
    const changes = await _applyDetectedCanDeviceParams(dev);
    _renderFlashDeviceCompare(dev);
    if (notify && changes.length) {
        showSuccess(`已按所选 CAN ID 匹配: ${changes.join('、')}`);
    }
    return changes;
}

async function onFlashDeviceIdChange() {
    await _matchSelectedFlashDevice(true);
    refreshFlashPlan(false);
}

function _clearSelectedCompileBoard() {
    window._selectedCompileBoardConfig = null;
    _compilePresetAdvancedExpanded = false;
    _lastBlFiles = [];
    const blFileSelect = document.getElementById('blFileSelect');
    if (blFileSelect) {
        blFileSelect.innerHTML = '<option value="">-- 选择 BL 文件 --</option>';
    }
    resetBlDeviceDetection();
    _applyCompilePresetView();
}

function onCompileConnectionDetailChange() {
    _communicationSubchoiceValues = {};
    _renderCommunicationSubchoices();
}

function onCompileBridgeCanPinChange() {
    _communicationSubchoiceValues = {};
    _renderCommunicationSubchoices();
}

function _evalCompileKconfigCondition(condition, activeSymbols) {
    const expression = String(condition || '').trim();
    if (!expression) return true;
    const tokens = expression.match(/&&|\|\||!|\(|\)|[A-Za-z_][A-Za-z0-9_]*/g) || [];
    if (tokens.join('').toUpperCase() !== expression.replace(/\s+/g, '').toUpperCase()) {
        return false;
    }
    let position = 0;
    const parsePrimary = () => {
        const token = tokens[position++];
        if (token === '(') {
            const value = parseOr();
            if (tokens[position] !== ')') return false;
            position += 1;
            return value;
        }
        if (!token) return false;
        if (token.toLowerCase() === 'y' || token === 'LOW_LEVEL_OPTIONS') return true;
        if (token.toLowerCase() === 'n') return false;
        return activeSymbols.has(token);
    };
    const parseUnary = () => {
        if (tokens[position] === '!') {
            position += 1;
            return !parseUnary();
        }
        return parsePrimary();
    };
    const parseAnd = () => {
        let value = parseUnary();
        while (tokens[position] === '&&') {
            position += 1;
            const right = parseUnary();
            value = value && right;
        }
        return value;
    };
    const parseOr = () => {
        let value = parseAnd();
        while (tokens[position] === '||') {
            position += 1;
            const right = parseAnd();
            value = value || right;
        }
        return value;
    };
    const result = parseOr();
    return position === tokens.length && result;
}

function _compileCommunicationActiveSymbols() {
    const mcuId = String(currentCompileMcu?.mcu?.id || '').toUpperCase();
    const active = new Set(_communicationProcessorCapabilities[mcuId] || []);
    active.add('LOW_LEVEL_OPTIONS');

    const commSymbol = document.getElementById('compileConnectionDetail')?.value || '';
    if (commSymbol) {
        active.add(_normalizeCompileSymbol(commSymbol));
        const option = _commAllOptions.find(row =>
            _normalizeCompileSymbol(row.config_symbol) === _normalizeCompileSymbol(commSymbol)
        );
        if (option?.select) active.add(_normalizeCompileSymbol(option.select));
    }
    const bridgeSymbol = document.getElementById('compileBridgeCanPin')?.value || '';
    if (bridgeSymbol) active.add(_normalizeCompileSymbol(bridgeSymbol));
    return active;
}

function _renderCommunicationSubchoices() {
    document.getElementById('compileCommunicationSubchoices')?.remove();
    if (!_communicationSubchoices.length) return false;

    const connGroup = document.getElementById('compileConnection')?.closest('.form-group');
    if (!connGroup) return false;
    const active = _compileCommunicationActiveSymbols();
    const rendered = [];

    for (const choice of _communicationSubchoices) {
        const options = (choice.options || []).filter(option =>
            _evalCompileKconfigCondition(option.condition, active)
        );
        if (!options.length || !_evalCompileKconfigCondition(choice.condition, active)) continue;

        const previous = _communicationSubchoiceValues[choice.id];
        const selected = options.some(option => option.config_symbol === previous)
            ? previous
            : options[0].config_symbol;
        _communicationSubchoiceValues[choice.id] = selected;
        active.add(_normalizeCompileSymbol(selected));
        const selectedOption = options.find(option => option.config_symbol === selected);
        if (selectedOption?.select) active.add(_normalizeCompileSymbol(selectedOption.select));
        rendered.push({ choice, options, selected });
    }

    if (!rendered.length) return false;
    const container = document.createElement('div');
    container.id = 'compileCommunicationSubchoices';
    container.className = 'form-group';
    container.style.marginTop = '10px';
    container.innerHTML = rendered.map(({ choice, options, selected }) => {
        const optionHtml = options.map(option =>
            `<option value="${escapeHtml(option.config_symbol)}"${option.config_symbol === selected ? ' selected' : ''}>${escapeHtml(option.display)}</option>`
        ).join('');
        return `<div style="margin-top:8px;"><label>${escapeHtml(choice.prompt || '通信子选项')}</label>` +
            `<select class="form-control compileCommunicationSubchoice" data-choice-id="${escapeHtml(choice.id)}" onchange="onCompileCommunicationSubchoiceChange(this)">${optionHtml}</select></div>`;
    }).join('');
    const anchor = document.getElementById('compileCanPinSub') ||
        document.getElementById('compileConnectionSub') || connGroup;
    anchor.parentNode.insertBefore(container, anchor.nextSibling);
    return true;
}

function onCompileCommunicationSubchoiceChange(select) {
    const choiceId = select?.dataset?.choiceId;
    if (choiceId) _communicationSubchoiceValues[choiceId] = select.value;
    _renderCommunicationSubchoices();
}

function _getCommunicationExtraSymbols() {
    return [...document.querySelectorAll('.compileCommunicationSubchoice')]
        .map(select => select.value)
        .filter(Boolean);
}

function _restoreCommunicationExtraSymbols(symbols) {
    const normalized = new Set((Array.isArray(symbols) ? symbols : []).map(_normalizeCompileSymbol));
    _communicationSubchoiceValues = {};
    for (const choice of _communicationSubchoices) {
        const selected = (choice.options || []).find(option =>
            normalized.has(_normalizeCompileSymbol(option.config_symbol))
        );
        if (selected) _communicationSubchoiceValues[choice.id] = selected.config_symbol;
    }
    _renderCommunicationSubchoices();
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
    _clearSelectedCompileBoard();
    document.getElementById('compileCustomSection').style.display = 'none';
    document.getElementById('compileMcuDetails').style.display = 'none';
    currentCompileMcu = null;

    if (!manufacturer) return;

    try {
        const response = await fetch(`/api/config/list/${encodeURIComponent(manufacturer)}`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();

        if (data.configs) {
            const types = [...new Set(data.configs.map(c => c.type))];
            const typeOptsHtml = types.map(type => {
                const label = type === 'mainboard' ? '主板' :
                             type === 'toolboard' ? '工具板' : '扩展板';
                return `<option value="${escapeHtml(type)}">${escapeHtml(label)}</option>`;
            }).join('');
            typeSelect.innerHTML += typeOptsHtml;
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
    _clearSelectedCompileBoard();
    document.getElementById('compileCustomSection').style.display = 'none';
    document.getElementById('compileMcuDetails').style.display = 'none';
    currentCompileMcu = null;

    if (!type) return;

    try {
        const response = await fetch(`/api/config/list/${encodeURIComponent(manufacturer)}`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();

        if (data.configs) {
            const configs = data.configs.filter(c => c.type === type);
            const modelOptsHtml = configs.map(config => {
                const dataConfig = escapeHtml(JSON.stringify(config)).replace(/'/g, '&apos;');
                return `<option value="${escapeHtml(config.id)}" data-config='${dataConfig}'>${escapeHtml(config.name)}</option>`;
            }).join('');
            modelSelect.innerHTML += modelOptsHtml;
            modelSelect.disabled = false;
        }
    } catch (error) {
        console.error('加载型号列表失败:', error);
    }
}

// 预设型号选择变化 - 保留预设身份并填充可编辑的完整字段
async function onCompilePresetModelChange() {
    const modelSelect = document.getElementById('compilePresetModel');
    const option = modelSelect.options[modelSelect.selectedIndex];

    if (!option || !option.dataset.config) {
        _clearSelectedCompileBoard();
        document.getElementById('compileCustomSection').style.display = 'none';
        document.getElementById('compileMcuDetails').style.display = 'none';
        return;
    }

    const config = JSON.parse(option.dataset.config);
    window._selectedCompileBoardConfig = config;
    _compilePresetAdvancedExpanded = false;
    document.getElementById('compileMcuDetails').style.display = 'none';
    _setCompilePresetConnectionWarning('');
    const presetName = config.name || option.textContent;

    // 设置烧录模式：默认选中 default_flash，但保留所有选项可编辑
    const flashModeEl = document.getElementById('flashMode');
    if (flashModeEl && config.flash_modes && config.flash_modes.length > 0) {
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
        const availableModes = supportedModes.filter(mode =>
            [...flashModeEl.options].some(opt => opt.value === mode)
        );
        const targetMode = availableModes.includes(config.default_flash)
            ? config.default_flash
            : availableModes[0];
        if (targetMode) {
            flashModeEl.value = targetMode;
            onFlashModeChange();
        } else {
            showError(`预设「${presetName}」没有可用的烧录模式`);
        }
    }

    // 保留预设模式与板卡身份；默认仅展示声明的连接方式，高级参数按需展开。
    document.querySelector('input[name="compileMode"][value="preset"]').checked = true;
    document.getElementById('compilePresetSection').style.display = 'block';
    _applyCompilePresetView();

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

    // 自动选择默认通信方式；未声明默认值时选择首个板卡可用方式。
    _autoSelectPresetConnection(config);

    const blSection = document.getElementById('blFlashSection');
    if (blSection && blSection.style.display !== 'none') {
        await loadBlFiles();
    }

    _applyCompilePresetView();
    showSuccess(`已加载预设「${presetName}」，连接方式已按板卡声明过滤；需要调整底层参数时可展开高级选项`);
}

// 自动匹配预设的通信方式到两级通信选择
function _autoSelectPresetConnection(config) {
    const connSelect = document.getElementById('compileConnection');
    if (!connSelect) return;

    const commType = _normalizePresetConnectionType(config.default_connection);

    // 选择第一级：通信类型
    let found = false;
    if (commType) {
        for (let i = 0; i < connSelect.options.length; i++) {
            if (connSelect.options[i].value === commType) {
                connSelect.value = commType;
                found = true;
                break;
            }
        }
    }
    if (!found && connSelect.options.length > 1) {
        connSelect.selectedIndex = 1;
        found = true;
        if (config.default_connection) {
            _setCompilePresetConnectionWarning(
                `默认连接方式「${config.default_connection}」不可用，已选择首个已声明方式。`,
                true
            );
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
        _clearSelectedCompileBoard();
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
        _restoreCommunicationExtraSymbols(current.comm_extra_symbols);
        if (current.canbus_frequency) {
            _setSelectedCanBitrate(current.canbus_frequency);
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
    if (_compileRequestActive) {
        showError('固件正在编译，请勿重复提交');
        return;
    }
    const modeEl = document.querySelector('input[name="compileMode"]:checked');
    const mode = modeEl ? modeEl.value : 'preset';

    const compileParams = {
        klipper_path: document.getElementById('klipperPath')?.value || '~/klipper'
    };

    if (mode === 'preset') {
        if (!window._selectedCompileBoardConfig) {
            showError('请选择预设配置');
            return;
        }
        const boardMcu = window._selectedCompileBoardConfig.mcu || '';
        if (boardMcu && currentCompileMcu?.mcu?.id
            && !_compileMcuNamesCompatible(boardMcu, currentCompileMcu.mcu.id)) {
            showError(`预设板卡 MCU (${boardMcu}) 与当前选择 (${currentCompileMcu.mcu.id}) 不一致，请重新选择预设或切换到自定义模式`);
            return;
        }
        // 编译仍使用用户可见的完整参数，但额外保留板卡身份供 manifest、历史和推荐使用。
        compileParams.board_config = { ...window._selectedCompileBoardConfig };
    }

    if (!currentCompileMcu) {
        showError('请选择 MCU 型号');
        return;
    }

    compileParams.mcu = currentCompileMcu.mcu.id;
    compileParams.platform = currentCompileMcu.platform;
    compileParams.crystal = document.getElementById('compileCrystal').value;
    compileParams.bl_offset = document.getElementById('compileBlOffset').value;
    compileParams.startup_pin = document.getElementById('compileStartupPin').value;
    compileParams.flash_mode = document.getElementById('flashMode')?.value || '';

    const commType = document.getElementById('compileConnection').value;
    if (!commType) {
        showError('请选择通信方式');
        return;
    }
    compileParams.comm_type = commType;

    const detailSelect = document.getElementById('compileConnectionDetail');
    const options = _commGroupedOptions[commType] || [];
    if (detailSelect && detailSelect.value) {
        compileParams.comm_config_symbol = detailSelect.value;
    } else if (options.length === 1) {
        compileParams.comm_config_symbol = options[0].config_symbol;
    } else if (options.length > 1) {
        showError('请选择具体的接口');
        return;
    } else {
        showError('当前 MCU 没有可用的通信接口，请重新选择');
        return;
    }

    if (commType === 'usbcanbridge') {
        const bridgePinSelect = document.getElementById('compileBridgeCanPin');
        if (_bridgeCanOptions.length > 0 && (!bridgePinSelect || !bridgePinSelect.value)) {
            showError('请选择 USB 转 CAN 桥接引脚');
            return;
        }
        if (bridgePinSelect?.value) compileParams.bridge_can_config = bridgePinSelect.value;
    }

    const communicationExtraSymbols = _getCommunicationExtraSymbols();
    if (communicationExtraSymbols.length) {
        compileParams.comm_extra_symbols = communicationExtraSymbols;
    }

    if (commType === 'can' || commType === 'usbcanbridge') {
        const bitrate = Number(_getSelectedCanBitrate());
        if (!Number.isInteger(bitrate) || bitrate < 10000 || bitrate > 5000000) {
            showError('CAN 速率必须是 10000 到 5000000 之间的整数');
            return;
        }
        compileParams.canbus_frequency = String(bitrate);
    }

    if (_rp2040CanGpio && (commType === 'can' || commType === 'usbcanbridge')) {
        const rxInput = document.getElementById('compileRp2040CanRx');
        const txInput = document.getElementById('compileRp2040CanTx');
        const rx = Number(rxInput?.value);
        const tx = Number(txInput?.value);
        const [min, max] = _rp2040CanGpio.range;
        if (!Number.isInteger(rx) || !Number.isInteger(tx) || rx < min || rx > max || tx < min || tx > max) {
            showError(`RP2040 CAN GPIO 必须是 ${min} 到 ${max} 之间的整数`);
            return;
        }
        if (rx === tx) {
            showError('RP2040 CAN RX 与 TX 不能使用同一个 GPIO');
            return;
        }
        compileParams.rp2040_can_rx_gpio = String(rx);
        compileParams.rp2040_can_tx_gpio = String(tx);
    }

    // 显示编译中
    _compileRequestActive = true;
    const compileButton = document.getElementById('compileFirmwareBtn');
    if (compileButton) compileButton.disabled = true;
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
        const lastResult = await processSSEStream(resp, logEl);

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
    } finally {
        _compileRequestActive = false;
        if (compileButton) compileButton.disabled = false;
    }
}

// 刷新设备 ID 列表（USB + CAN，CAN使用与资源页相同的搜索方式）
async function refreshDeviceIds() {
    const requestId = ++_deviceScanRequestId;
    const select = document.getElementById('flashDeviceId');
    if (!select) return;
    const canIfaceSelect = document.getElementById('flashCanIface');
    const canErrDiv = document.getElementById('flashCanSearchError');
    const previousValue = select.value;
    const canIface = canIfaceSelect ? canIfaceSelect.value : 'can0';
    _lastDetectedCanDevicesByUuid = {};

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
        if (requestId !== _deviceScanRequestId) return;
        const [usbResp, canResp] = results;

        select.innerHTML = '<option value="">-- 选择设备 --</option>';

        let usbCount = 0;
        let canCount = 0;

        // USB设备 - 添加分组标题
        if (usbResp.status === 'fulfilled') {
            if (!usbResp.value.ok) throw new Error(`USB设备扫描失败: HTTP ${usbResp.value.status}`);
            const usbData = await usbResp.value.json();
            if (requestId !== _deviceScanRequestId) return;
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
                    let usbOptsHtml = `<option disabled>━━━━━━━━ USB 设备 ━━━━━━━━</option>`;

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
                    usbOptsHtml += `<option value="${escapeHtml(device.id)}">${icon} [${escapeHtml(typeLabel)}] ${escapeHtml(shortName)}</option>`;
                    usbCount++;
                });
                    select.innerHTML += usbOptsHtml;
                } // end if filteredDevices.length > 0
            }
        }

        // CAN设备 - 仅在 KAT/CAN 模式下且有设备时显示分组
        if (canResp && canResp.status === 'fulfilled') {
            if (!canResp.value.ok) throw new Error(`CAN设备扫描失败: HTTP ${canResp.value.status}`);
            const canData = await canResp.value.json();
            if (requestId !== _deviceScanRequestId) return;

            if (canData.error && canErrDiv) {
                canErrDiv.style.display = 'block';
                canErrDiv.innerHTML = `<div style="margin-top:6px;font-size:12px;color:var(--danger-color);background:rgba(244,67,54,.10);padding:6px 10px;border-radius:4px;">${escapeHtml(canData.error)}</div>`;
            }

            // 只在有CAN设备时才显示CAN分组标题和设备
            if (canData.uuids && canData.uuids.length > 0) {
                // 添加CAN分组标题和设备
                let canOptsHtml = `<option disabled>━━━━━━━━ CAN 设备 (${escapeHtml(canIface)}) ━━━━━━━━</option>`;

                canData.uuids.forEach(d => {
                    if (d.uuid) {
                        _lastDetectedCanDevicesByUuid[String(d.uuid).toLowerCase()] = d;
                    }
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
                        const mcuName = String(d.mcu_model).toUpperCase();
                        const mcuDisplay = d.mcu_freq ? `${mcuName} @ ${_compileFormatFrequency(d.mcu_freq)}` : mcuName;
                        parts.push(mcuDisplay);
                    }
                    if (d.mcu_version) {
                        parts.push(d.mcu_version);
                    }
                    if (d.crystal) {
                        parts.push(`晶振${d.crystal_label || _compileFormatFrequency(d.crystal)}`);
                    }
                    if (d.inferred_connection) {
                        const src = _compileSourceLabel((d.field_sources || {}).inferred_connection);
                        parts.push(`${d.inferred_connection}${src ? `(${src})` : ''}`);
                    }
                    if (d.canbus_frequency) {
                        parts.push(_compileFormatBitrate(d.canbus_frequency));
                    }
                    const bracketInfo = parts.length > 0 ? ` [${parts.join(' / ')}]` : '';

                    // 第三部分：section 名称（如 [mcu SHT36]）
                    const sectionInfo = d.section ? ` ${_formatMcuSection(d.section)}` : '';

                    const label = `${d.uuid}${bracketInfo}${sectionInfo}`;
                    canOptsHtml += `<option value="${escapeHtml(d.uuid)}">${escapeHtml(icon)} ${escapeHtml(label)}</option>`;
                    canCount++;
                });
                select.innerHTML += canOptsHtml;
            }

            // 显示来源提示
            if (canData.source === 'printer_cfg' && canData.skipped > 0 && canErrDiv) {
                canErrDiv.style.display = 'block';
                canErrDiv.innerHTML = `<div style="margin-top:6px;font-size:12px;color:var(--warning-color);background:rgba(255,193,7,.12);padding:6px 10px;border-radius:4px;">${escapeHtml(canData.skipped)} 个配置文件中的设备未连接，已自动过滤</div>`;
            }
        }

        // 添加统计信息
        if (usbCount > 0 || canCount > 0) {
            select.innerHTML += `<option disabled>━━━━━━━━━━━━━━━━━━━━━━━━</option>`;
            const statsText = `共找到 ${usbCount + canCount} 个设备 (USB: ${usbCount}, CAN: ${canCount})`;
            select.innerHTML += `<option disabled style="color:var(--text-secondary);font-style:italic;">${statsText}</option>`;
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
        const selectedDev = _lastDetectedCanDevicesByUuid[String(select.value || '').toLowerCase()];
        if (selectedDev) {
            await _matchSelectedFlashDevice(true);
        } else {
            _renderFlashDeviceCompare(null);
        }
    } catch (error) {
        if (requestId !== _deviceScanRequestId) return;
        console.error('扫描设备失败:', error);
        select.innerHTML = '<option value="">-- 扫描失败 --</option>';
        if (canErrDiv) {
            canErrDiv.style.display = 'block';
            canErrDiv.textContent = error.message || String(error);
        }
        _renderFlashDeviceCompare(null);
    }
}

async function onFlashCanIfaceChange() {
    _deviceScanRequestId++;
    const deviceSelect = document.getElementById('flashDeviceId');
    if (deviceSelect) deviceSelect.innerHTML = '<option value="">-- 正在扫描 --</option>';
    _lastDetectedCanDevicesByUuid = {};
    _renderFlashDeviceCompare(null);
    await refreshDeviceIds();
    await refreshFlashPlan(false);
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
    if (!response.ok) throw new Error(`烧录计划请求失败: HTTP ${response.status}`);
    const data = await response.json();
    if (data.manifest) compiledFirmwareManifest = data.manifest;
    _lastFlashPlan = data.plan || null;
    if (!compiledFirmwarePath && _lastFlashPlan?.manifest_valid && _lastFlashPlan.firmware_path) {
        compiledFirmwarePath = _lastFlashPlan.firmware_path;
    }
    return _lastFlashPlan;
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
    const firmwarePath = compiledFirmwarePath || _lastFlashPlan?.firmware_path || '';
    if (!firmwarePath) {
        showError('请先编译固件');
        return;
    }
    if (!String(firmwarePath).toLowerCase().endsWith('.bin')) {
        showError('TF 卡模式只允许下载 .bin 固件，当前固件格式不匹配');
        return;
    }

    try {
        // 调用 API 获取固件文件
        const response = await fetch(`/api/firmware/download?path=${encodeURIComponent(firmwarePath)}`);
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
    if (_flashRequestActive) {
        showError('固件正在烧录，请勿重复提交');
        return;
    }
    const deviceId = document.getElementById('flashDeviceId').value;
    const flashMode = document.getElementById('flashMode').value;

    if (flashMode === 'TF') {
        // TF卡模式不需要烧录
        showSuccess('TF卡模式：编译后可下载固件复制到TF卡');
        return;
    }

    let firmwarePath = compiledFirmwarePath || _lastFlashPlan?.firmware_path || '';

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
                firmwarePath = '~/klipper/out/klipper.elf';
            }
        }
        return await flashHostFirmware(firmwarePath);
    }

    if (!deviceId && ['DFU', 'KAT', 'CAN', 'CAN_BRIDGE_DFU', 'CAN_BRIDGE_KAT', 'UF2'].includes(flashMode)) {
        showError('请选择设备 ID');
        return;
    }

    try {
        const precheck = await fetchFlashPlan();
        if (precheck) {
            renderFlashPlan(precheck);
            if (precheck.errors && precheck.errors.length > 0) {
                showError('烧录前预检失败: ' + precheck.errors.join('；'));
                return;
            }
            firmwarePath = firmwarePath || precheck.firmware_path || '';
        }
    } catch (error) {
        showError('烧录前预检请求失败: ' + (error.message || error));
        return;
    }

    _flashRequestActive = true;
    const flashButton = document.getElementById('flashFirmwareBtn');
    if (flashButton) flashButton.disabled = true;
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
        const lastResult = await processSSEStream(resp, logEl);

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
    } finally {
        _flashRequestActive = false;
        if (flashButton) flashButton.disabled = false;
    }
}

// HOST模式固件安装
async function flashHostFirmware(firmwarePath) {
    if (_flashRequestActive) {
        showError('固件正在烧录，请勿重复提交');
        return;
    }
    _flashRequestActive = true;
    const flashButton = document.getElementById('flashFirmwareBtn');
    if (flashButton) flashButton.disabled = true;
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
        const lastResult = await processSSEStream(resp, logEl);

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
    } finally {
        _flashRequestActive = false;
        if (flashButton) flashButton.disabled = false;
    }
}

// ==================== HOST 固件源 & 文件浏览器 ====================

let _hostBrowserParent = null;
let _hostBrowserDefaultDir = null;

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

function buildHostInfoParams() {
    const params = new URLSearchParams();
    const mcuId = currentCompileMcu ? currentCompileMcu.mcu.id : '';
    const commType = document.getElementById('compileConnection')?.value || '';
    const blOffset = document.getElementById('compileBlOffset')?.value || '';

    if (mcuId) params.set('mcu', mcuId);
    if (commType) params.set('comm_type', commType);
    if (blOffset) params.set('bl_offset', blOffset);
    return params;
}

// 自动检测 HOST 预构建固件路径
async function autoDetectHostFirmwarePath() {
    const pathInput = document.getElementById('hostPrebuiltPath');
    if (!pathInput) return;

    const mcuId = currentCompileMcu ? currentCompileMcu.mcu.id : '';

    try {
        const resp = await fetch('/api/firmware/host-info?' + buildHostInfoParams().toString());
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const info = await resp.json();
        _hostBrowserDefaultDir = info.default_browser_dir || info.firmware_dir || _hostBrowserDefaultDir;

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
async function openHostFileBrowser() {
    const browser = document.getElementById('hostFileBrowser');
    if (!browser) return;
    browser.style.display = 'block';
    loadHostBrowserDir(await resolveHostBrowserStartDir());
}

async function resolveHostBrowserStartDir() {
    const selectedPath = document.getElementById('hostPrebuiltPath')?.value?.trim();
    if (selectedPath && selectedPath.includes('/')) {
        return selectedPath.replace(/\/[^/]*$/, '') || '/';
    }
    if (_hostBrowserDefaultDir) {
        return _hostBrowserDefaultDir;
    }

    try {
        const resp = await fetch('/api/firmware/host-info?' + buildHostInfoParams().toString());
        if (resp.ok) {
            const info = await resp.json();
            _hostBrowserDefaultDir = info.default_browser_dir || info.firmware_dir || null;
            if (_hostBrowserDefaultDir) return _hostBrowserDefaultDir;
        }
    } catch (err) {
        console.warn('获取 HOST 默认固件目录失败:', err);
    }
    return '~/klipper/out';
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
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.json();

        if (data.error) {
            listEl.innerHTML = `<div class="browser-empty">${escapeHtml(data.error)}</div>`;
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
            const escapedPath = escapeJsString(entry.path);
            html += `<div class="browser-item${dirClass}" onclick="onHostBrowserClick(this, '${escapedPath}', ${entry.is_dir})">
                <span class="item-icon">${icon}</span>
                <span class="item-name">${escapeHtml(entry.name)}</span>
                <span class="item-size">${sizeStr}</span>
            </div>`;
        }
        listEl.innerHTML = html;
    } catch (err) {
        listEl.innerHTML = `<div class="browser-empty">浏览失败: ${escapeHtml(err.message)}</div>`;
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
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
}

function initBlUploadArea() {
    const area = document.getElementById('blUploadArea');
    const input = document.getElementById('blFileInput');
    if (!area || !input || area.dataset.bound === '1') return;
    area.dataset.bound = '1';
    area.addEventListener('click', () => input.click());
    area.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            input.click();
        }
    });
    area.addEventListener('dragover', event => {
        event.preventDefault();
        area.classList.add('dragover');
    });
    area.addEventListener('dragleave', () => area.classList.remove('dragover'));
    area.addEventListener('drop', event => {
        event.preventDefault();
        area.classList.remove('dragover');
        const file = event.dataTransfer?.files?.[0];
        if (file) uploadBlFile(file);
    });
    input.addEventListener('change', () => {
        const file = input.files?.[0];
        input.value = '';
        if (file) uploadBlFile(file);
    });
}

async function uploadBlFile(file) {
    if (!file || !/\.(bin|uf2)$/i.test(file.name)) {
        showError('仅支持 .bin 或 .uf2 BL 文件');
        return;
    }
    if (file.size <= 0 || file.size > 4 * 1024 * 1024) {
        showError('BL 文件大小必须在 1 byte 到 4 MB 之间');
        return;
    }
    const form = new FormData();
    form.append('file', file);
    try {
        const response = await fetch('/api/firmware/bl/upload', { method: 'POST', body: form });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || !data.success || !data.file) {
            throw new Error(data.error || `HTTP ${response.status}`);
        }
        _lastBlFiles = _lastBlFiles.filter(item => item.path !== data.file.path);
        _lastBlFiles.unshift(data.file);
        const select = document.getElementById('blFileSelect');
        if (select) {
            const option = new Option(`${data.file.name}（已上传）`, data.file.path);
            select.appendChild(option);
            select.value = data.file.path;
            await onBlFileChange();
        }
        showSuccess(`BL 文件 ${file.name} 上传成功`);
    } catch (error) {
        showError('BL 文件上传失败: ' + (error.message || error));
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
    resetBlDeviceDetection();
    try {
        const board = window._selectedCompileBoardConfig || {};
        const params = new URLSearchParams();
        if (board.manufacturer) params.set('manufacturer', board.manufacturer);
        if (board.board_type || board.type) params.set('board_type', board.board_type || board.type);
        if (board.id) params.set('board_id', board.id);
        if (board.name) params.set('board_name', board.name);
        const response = await fetch('/api/firmware/bl-firmwares' + (params.toString() ? '?' + params.toString() : ''));
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
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
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
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
        refreshBlDeviceCompatibilityOptions();
        return;
    }
    const toolEl = document.getElementById('blFlashTool');
    if (toolEl && selected.recommended_tool &&
            [...toolEl.options].some(option => option.value === selected.recommended_tool)) {
        toolEl.value = selected.recommended_tool;
    }
    await loadBlAddressOptions();
    refreshBlDeviceCompatibilityOptions();
}

function _normalizeBlPlatformKey(value) {
    const raw = String(value || '').trim().toLowerCase().replace(/[_-]/g, '');
    if (raw.includes('rp2350')) return 'rp2350';
    if (raw.includes('rp2040') || raw === 'rp2') return 'rp2040';
    if (raw.includes('stm32')) return 'stm32';
    return raw;
}

function _selectedBlFileMeta() {
    const select = document.getElementById('blFileSelect');
    const path = select?.value || '';
    const known = _lastBlFiles.find(file => file.path === path) || {};
    const match = String(path).match(/\.[A-Za-z0-9]+$/);
    return {
        ...known,
        path,
        ext: String(known.ext || match?.[0] || '').toLowerCase(),
    };
}

function _selectedBlContext(toolOverride = '', deviceOverride = null) {
    const addressSelect = document.getElementById('blFlashAddress');
    const addressOption = addressSelect?.options?.[addressSelect.selectedIndex];
    const board = window._selectedCompileBoardConfig || {};
    const tool = toolOverride || document.getElementById('blFlashTool')?.value || '';
    const deviceSelect = document.getElementById('blDeviceSelect');
    const device = deviceOverride || _lastBlDetectedDevices.find(item => item.id === deviceSelect?.value) || null;
    const platformKey = _normalizeBlPlatformKey(
        addressOption?.dataset?.platformKey ||
        currentCompileMcu?.platform_key || currentCompileMcu?.platform ||
        board.platform || ''
    );
    return {
        tool,
        device,
        file: _selectedBlFileMeta(),
        platformKey,
        address: addressSelect?.value || '',
        mcuId: currentCompileMcu?.mcu?.id || board.mcu || '',
    };
}

function _buildBlCompatibility(toolOverride = '', deviceOverride = null) {
    const context = _selectedBlContext(toolOverride, deviceOverride);
    const { tool, device, file, platformKey, address, mcuId } = context;
    const errors = [];
    const toolStatus = _lastBlToolStatus[tool];

    if (!file.path) errors.push('请选择 BL 文件');
    if (!tool) errors.push('请选择烧录工具');
    if (!device) errors.push('请先检测并选择 BL 烧录设备');
    if (toolStatus && toolStatus.available === false) {
        errors.push(`${tool} 未安装或不可用`);
    }
    if (device && Array.isArray(device.supported_tools) && !device.supported_tools.includes(tool)) {
        errors.push(`所选设备不支持 ${tool}`);
    }

    if (tool === 'rp2040_flash') {
        if (device && device.type !== 'uf2') errors.push('rp2040_flash 必须选择 BOOTSEL 设备');
        if (!['rp2040', 'rp2350'].includes(platformKey)) errors.push('当前 MCU 平台不是 RP2040/RP2350');
        if (file.path && file.ext !== '.uf2') errors.push('BOOTSEL 烧录必须使用 .uf2 BL 文件');
    } else if (tool === 'dfu-util') {
        if (device && device.type !== 'dfu') errors.push('dfu-util 必须选择 DFU 设备');
        if (platformKey !== 'stm32') errors.push('DFU BL 烧录仅支持 STM32 平台');
        if (file.path && file.ext !== '.bin') errors.push('DFU BL 烧录必须使用 .bin 文件');
    } else if (tool === 'st-flash') {
        if (device && device.type !== 'stlink') errors.push('st-flash 必须选择 ST-Link');
        if (platformKey !== 'stm32') errors.push('st-flash 仅支持 STM32 平台');
        if (file.path && file.ext !== '.bin') errors.push('st-flash 必须使用 .bin 文件');
    } else if (tool === 'openocd') {
        if (device && device.type !== 'stlink') errors.push('OpenOCD 必须选择 ST-Link');
        if (platformKey !== 'stm32') errors.push('OpenOCD BL 烧录仅支持 STM32 平台');
        if (file.path && !['.bin', '.hex'].includes(file.ext)) errors.push('OpenOCD 仅支持 .bin 或 .hex 文件');
        const normalizedMcu = String(mcuId || '').toLowerCase().replace(/[_-]/g, '');
        if (mcuId && !/^stm32(?:f[0-47]|f7|g[04]|h7|l[04])/.test(normalizedMcu)) {
            errors.push(`OpenOCD 不支持自动匹配当前 MCU：${mcuId}`);
        }
    }

    if (tool !== 'rp2040_flash' && !/^0x[0-9a-f]+$/i.test(address)) {
        errors.push('BL 烧录地址无效');
    }
    return {...context, errors, ok: errors.length === 0};
}

function _setBlDeviceHint(message, kind = 'info') {
    const hint = document.getElementById('blDeviceDetectHint');
    if (!hint) return;
    const colors = {
        success: ['var(--success-color)', 'rgba(76,175,80,.10)'],
        warning: ['var(--warning-color)', 'rgba(255,193,7,.12)'],
        error: ['var(--danger-color)', 'rgba(244,67,54,.10)'],
        info: ['var(--info-color)', 'rgba(33,150,243,.10)'],
    };
    const [border, background] = colors[kind] || colors.info;
    hint.style.display = 'block';
    hint.style.borderLeftColor = border;
    hint.style.background = background;
    hint.textContent = message;
}

function _applyBlToolAvailability() {
    const toolSelect = document.getElementById('blFlashTool');
    if (!toolSelect) return;
    [...toolSelect.options].forEach(option => {
        if (!option.dataset.baseLabel) option.dataset.baseLabel = option.textContent;
        const status = _lastBlToolStatus[option.value];
        option.disabled = Boolean(status && status.available === false);
        option.textContent = option.dataset.baseLabel + (option.disabled ? '（未安装）' : '');
    });
}

function resetBlDeviceDetection(message = '点击“检测”扫描 DFU 与 BOOTSEL 设备') {
    _blDeviceScanRequestId += 1;
    _lastBlDetectedDevices = [];
    _lastBlToolStatus = {};
    _blDetectionState = {status: 'idle', message};
    const select = document.getElementById('blDeviceSelect');
    if (select) select.innerHTML = '<option value="">-- 点击检测设备 --</option>';
    const toolSelect = document.getElementById('blFlashTool');
    if (toolSelect) {
        [...toolSelect.options].forEach(option => {
            if (option.dataset.baseLabel) option.textContent = option.dataset.baseLabel;
            option.disabled = false;
        });
    }
    renderBlFlashCompatibility();
}

function _compatibleBlToolsForDevice(device) {
    const file = _selectedBlFileMeta();
    const toolSelect = document.getElementById('blFlashTool');
    const currentTool = toolSelect?.value || '';
    const visibleTools = new Set([...toolSelect?.options || []].map(option => option.value));
    const preferred = [file.recommended_tool, currentTool, ...(device.supported_tools || [])].filter(Boolean);
    return [...new Set(preferred)].filter(tool =>
        visibleTools.has(tool) && (device.supported_tools || []).includes(tool) &&
        _buildBlCompatibility(tool, device).ok
    );
}

function _renderDetectedBlDevices() {
    const select = document.getElementById('blDeviceSelect');
    if (!select) return [];
    select.innerHTML = '<option value="">-- 选择检测到的设备 --</option>';
    const usable = [];
    for (const device of _lastBlDetectedDevices) {
        const compatibleTools = _compatibleBlToolsForDevice(device);
        const typeLabel = device.type === 'dfu' ? 'DFU' : device.type === 'uf2' ? 'BOOTSEL' : 'ST-Link';
        const suffix = compatibleTools.length ? compatibleTools.join('/') : '与当前配置不兼容';
        const option = new Option(`[${typeLabel}] ${device.name} — ${suffix}`, device.id);
        option.disabled = compatibleTools.length === 0;
        select.appendChild(option);
        if (compatibleTools.length) usable.push({device, tools: compatibleTools});
    }
    return usable;
}

function refreshBlDeviceCompatibilityOptions() {
    const select = document.getElementById('blDeviceSelect');
    if (!select || _lastBlDetectedDevices.length === 0) {
        renderBlFlashCompatibility();
        return;
    }
    const previous = select.value;
    const usable = _renderDetectedBlDevices();
    const previousOption = [...select.options].find(option => option.value === previous);
    select.value = previousOption && !previousOption.disabled ? previous : '';
    if (select.value) {
        const selected = usable.find(item => item.device.id === select.value);
        const toolSelect = document.getElementById('blFlashTool');
        if (selected?.tools?.length && toolSelect && !selected.tools.includes(toolSelect.value)) {
            toolSelect.value = selected.tools[0];
        }
    }
    renderBlFlashCompatibility();
}

async function detectBlFlashDevices() {
    if (_blFlashRequestActive) {
        showError('BL 正在烧录，暂时不能重新检测设备');
        return;
    }
    const requestId = ++_blDeviceScanRequestId;
    const button = document.getElementById('detectBlDevicesBtn');
    const select = document.getElementById('blDeviceSelect');
    if (!button || !select) return;
    button.disabled = true;
    button.textContent = '⏳ 检测中';
    select.innerHTML = '<option value="">-- 正在检测 --</option>';
    _blDetectionState = {status: 'scanning', message: '正在检测烧录工具与设备…'};
    renderBlFlashCompatibility();

    try {
        const [deviceResult, programmerResult] = await Promise.allSettled([
            fetch('/api/firmware/detect', {cache: 'no-store'}).then(async response => {
                const data = await response.json().catch(() => ({}));
                if (!response.ok) throw new Error(data.error || `设备检测 HTTP ${response.status}`);
                return data;
            }),
            fetch('/api/firmware/bl/detect', {cache: 'no-store'}).then(async response => {
                const data = await response.json().catch(() => ({}));
                if (!response.ok || !data.success) throw new Error(data.error || `烧录器检测 HTTP ${response.status}`);
                return data;
            }),
        ]);
        if (requestId !== _blDeviceScanRequestId) return;

        const errors = [];
        const devices = [];
        if (programmerResult.status === 'fulfilled') {
            _lastBlToolStatus = programmerResult.value.tools || {};
            for (const programmer of programmerResult.value.programmers || []) {
                const visibleTools = new Set([
                    ...document.getElementById('blFlashTool')?.options || []
                ].map(option => option.value));
                if ((programmer.supported_tools || []).some(tool => visibleTools.has(tool))) {
                    devices.push({...programmer, type: 'stlink'});
                }
            }
        } else {
            const toolError = programmerResult.reason?.message || String(programmerResult.reason || '未知错误');
            _lastBlToolStatus = Object.fromEntries(
                ['dfu-util', 'rp2040_flash', 'st-flash', 'openocd'].map(tool => [
                    tool, {available: false, error: toolError}
                ])
            );
            errors.push(`烧录工具检测失败：${toolError}`);
        }
        if (deviceResult.status === 'fulfilled') {
            for (const item of deviceResult.value.devices || []) {
                const id = String(item.id || '');
                if (item.type === 'dfu' || id.startsWith('dfu:')) {
                    devices.push({...item, type: 'dfu', supported_tools: ['dfu-util']});
                } else if (id === 'rp2040_boot') {
                    devices.push({...item, type: 'uf2', supported_tools: ['rp2040_flash']});
                }
            }
        } else {
            errors.push(`USB 启动设备检测失败：${deviceResult.reason?.message || deviceResult.reason}`);
        }

        const seen = new Set();
        _lastBlDetectedDevices = devices.filter(device => {
            if (!device.id || seen.has(device.id)) return false;
            seen.add(device.id);
            return true;
        });
        _applyBlToolAvailability();
        const usable = _renderDetectedBlDevices();
        const toolSelect = document.getElementById('blFlashTool');

        if (_lastBlDetectedDevices.length === 1 && usable.length === 1) {
            select.value = usable[0].device.id;
            if (toolSelect) toolSelect.value = usable[0].tools[0];
            _blDetectionState = {
                status: 'done',
                message: `已检测并选择 ${usable[0].device.name}，烧录工具：${usable[0].tools[0]}`,
            };
        } else if (usable.length > 0) {
            select.value = '';
            _blDetectionState = {
                status: 'done',
                message: `检测到 ${_lastBlDetectedDevices.length} 个设备，其中 ${usable.length} 个兼容，请手动选择`,
            };
        } else if (_lastBlDetectedDevices.length > 0) {
            _blDetectionState = {
                status: 'done',
                message: `检测到 ${_lastBlDetectedDevices.length} 个设备，但没有设备兼容当前 BL 文件、MCU 平台和烧录工具`,
            };
        } else {
            _blDetectionState = {
                status: 'done',
                message: '未检测到 DFU 或 BOOTSEL 设备，请先让主板进入对应烧录模式',
            };
        }
        if (errors.length) _blDetectionState.message += `；${errors.join('；')}`;
        renderBlFlashCompatibility();
    } catch (error) {
        if (requestId !== _blDeviceScanRequestId) return;
        _lastBlDetectedDevices = [];
        _blDetectionState = {status: 'error', message: `BL 设备检测失败：${error.message || error}`};
        select.innerHTML = '<option value="">-- 检测失败 --</option>';
        renderBlFlashCompatibility();
    } finally {
        if (requestId === _blDeviceScanRequestId) {
            button.disabled = false;
            button.textContent = '🔍 检测';
        }
    }
}

function onBlDeviceChange() {
    const select = document.getElementById('blDeviceSelect');
    const device = _lastBlDetectedDevices.find(item => item.id === select?.value);
    if (device) {
        const tools = _compatibleBlToolsForDevice(device);
        const toolSelect = document.getElementById('blFlashTool');
        if (tools.length && toolSelect && !tools.includes(toolSelect.value)) {
            toolSelect.value = tools[0];
        }
    }
    renderBlFlashCompatibility();
}

function onBlFlashToolChange() {
    renderBlFlashCompatibility();
}

function onBlFlashAddressChange() {
    refreshBlDeviceCompatibilityOptions();
}

function renderBlFlashCompatibility() {
    const button = document.getElementById('flashBootloaderBtn');
    const deviceId = document.getElementById('blDeviceSelect')?.value || '';
    const device = _lastBlDetectedDevices.find(item => item.id === deviceId) || null;
    const plan = _buildBlCompatibility('', device);
    if (button) button.disabled = _blFlashRequestActive || !plan.ok;

    if (plan.ok) {
        _setBlDeviceHint(
            `校验通过：${plan.device.name} · ${plan.tool} · ${plan.file.ext || '未知格式'} · ${plan.platformKey.toUpperCase()}`,
            'success'
        );
    } else if (device) {
        _setBlDeviceHint(`暂不可烧录：${plan.errors.join('；')}`, 'warning');
    } else {
        const kind = _blDetectionState.status === 'error' ? 'error' :
            _blDetectionState.status === 'done' && _lastBlDetectedDevices.length === 0 ? 'warning' : 'info';
        _setBlDeviceHint(_blDetectionState.message, kind);
    }
    return plan;
}

// 烧录 Bootloader
async function flashBootloader() {
    if (_blFlashRequestActive) {
        showError('BL 正在烧录，请勿重复提交');
        return;
    }
    const blFileEl = document.getElementById('blFileSelect');
    if (!blFileEl) return;
    const blFile = blFileEl.value;
    const addressSelect = document.getElementById('blFlashAddress');
    if (!addressSelect) return;
    const selectedAddress = addressSelect.options[addressSelect.selectedIndex];
    const address = addressSelect.value;
    const dfuOffset = selectedAddress?.dataset.offset || '';
    const tool = document.getElementById('blFlashTool').value;
    const eraseFlash = document.getElementById('blEraseFlash').checked;
    const deviceId = document.getElementById('blDeviceSelect')?.value || '';
    const compatibility = renderBlFlashCompatibility();

    if (!compatibility.ok) {
        showError('BL 烧录预检未通过：' + compatibility.errors.join('；'));
        return;
    }
    if (eraseFlash && !confirm('擦除整个 Flash 会清除当前固件，确认继续烧录 BL？')) {
        return;
    }
    if (!eraseFlash && !confirm('不擦除整个 Flash 可能保留旧固件并与 BL 偏移规则冲突，确认继续？')) {
        return;
    }

    _blFlashRequestActive = true;
    const blButton = document.getElementById('flashBootloaderBtn');
    if (blButton) blButton.disabled = true;
    const detectButton = document.getElementById('detectBlDevicesBtn');
    if (detectButton) detectButton.disabled = true;
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
                platform_key: compatibility.platformKey,
                mcu_id: compatibility.mcuId,
                flash_mode: tool === 'dfu-util' ? 'DFU' : tool === 'rp2040_flash' ? 'UF2' : tool === 'st-flash' ? 'st-flash' : 'openocd',
                device_id: deviceId,
                erase_flash: eraseFlash
            })
        });

        if (!response.ok) {
            const errData = await response.json().catch(() => ({}));
            throw new Error(errData.error || `HTTP ${response.status}`);
        }

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
                    <pre>${escapeHtml(result.error || '未知错误')}</pre>
                    ${result.output ? '<details><summary>详细输出</summary><pre>' + escapeHtml(result.output) + '</pre></details>' : ''}
                </div>
            `;
            showError('BL 烧录失败: ' + (result.error || '未知错误'));
        }
    } catch (error) {
        console.error('BL 烧录失败:', error);
        resultDiv.querySelector('.result-box').innerHTML = `
            <div class="status-error">
                <p>❌ BL 烧录请求失败</p>
                <pre>${escapeHtml(error.message)}</pre>
            </div>
        `;
        showError('BL 烧录请求失败: ' + error.message);
    } finally {
        _blFlashRequestActive = false;
        if (detectButton) detectButton.disabled = false;
        renderBlFlashCompatibility();
    }
}

// 重置编译表单
async function resetCompileForm() {
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
    document.getElementById('blFlashResult').style.display = 'none';

    // 清理两级通信子选项和CAN引脚选项
    let subContainer = document.getElementById('compileConnectionSub');
    if (subContainer) subContainer.remove();
    let pinContainer = document.getElementById('compileCanPinSub');
    if (pinContainer) pinContainer.remove();
    let bitrateContainer = document.getElementById('compileCanBitrateSub');
    if (bitrateContainer) bitrateContainer.remove();
    _commGroupedOptions = {};
    _commAllOptions = [];
    _bridgeCanOptions = [];
    _rp2040CanGpio = null;

    // 清理启动引脚
    const startupPin = document.getElementById('compileStartupPin');
    if (startupPin) startupPin.value = '';

    compiledFirmwarePath = null;
    compiledFirmwareManifest = null;
    _lastFlashPlan = null;
    currentCompileMcu = null;
    _clearSelectedCompileBoard();
    window._fromPreset = false;
    _lastBlAddressOptions = [];
    loadBlAddressFallback();

    _deviceScanRequestId++;
    _lastDetectedCanDevicesByUuid = {};
    const deviceSelect = document.getElementById('flashDeviceId');
    if (deviceSelect) deviceSelect.innerHTML = '<option value="">-- 点击刷新扫描 --</option>';
    const flashMode = document.getElementById('flashMode');
    if (flashMode) flashMode.value = 'DFU';
    const planHint = document.getElementById('flashPlanHint');
    if (planHint) planHint.style.display = 'none';
    _renderFlashDeviceCompare(null);
    await loadCompilePresetManufacturers();
    onFlashModeChange(true);
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
            statusEl.innerHTML = `<p style="color:red">检测失败: ${escapeHtml(data.error)}</p>`;
            return;
        }
        const rows = data.dependencies.map(dep => {
            const icon = dep.installed ? '&#10003;' : '&#10007;';
            const color = dep.installed ? '#4caf50' : '#f44336';
            const ver = dep.installed ? `<span style="color:var(--text-secondary);font-size:12px">${escapeHtml(dep.version)}</span>` : `<span style="color:var(--danger-color)">未安装 (${escapeHtml(dep.pkg)})</span>`;
            return `<div style="display:flex;align-items:center;gap:8px;margin:4px 0">
                      <span style="color:${color};font-weight:bold;font-size:16px">${icon}</span>
                      <span style="font-family:monospace">${escapeHtml(dep.name)}</span>
                      ${ver}
                    </div>`;
        }).join('');
        const summary = data.all_ok
            ? '<p style="color:var(--success-color);font-weight:bold">所有依赖已就绪</p>'
            : '<p style="color:var(--danger-color)">存在缺失依赖，请点击"安装依赖"</p>';
        statusEl.innerHTML = summary + rows;
    } catch (e) {
        statusEl.innerHTML = `<p style="color:red">请求失败: ${escapeHtml(e.message)}</p>`;
    }
}

async function installDependencies() {
    const statusEl = document.getElementById('depsStatus');
    if (!statusEl) return;
    statusEl.innerHTML = '<p>正在安装依赖，请稍候...</p><pre id="depsLog" style="background:#111;color:#eee;padding:10px;max-height:300px;overflow-y:auto;font-size:12px"></pre>';
    const logEl = document.getElementById('depsLog');
    try {
        const resp = await fetch('/api/firmware/dependencies/install', { method: 'POST' });
        if (!resp.ok) {
            const errData = await resp.json().catch(() => ({}));
            throw new Error(errData.error || `HTTP ${resp.status}`);
        }
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

// ==================== 编译配置导入/导出 ====================
async function exportCompileConfig() {
    const klipperPath = document.getElementById('klipperPath')?.value || '~/klipper';
    try {
        const params = new URLSearchParams({ klipper_path: klipperPath });
        const response = await fetch('/api/firmware/export-config?' + params.toString());
        const data = await response.json();
        if (!response.ok || !data.success) {
            throw new Error(data.error || '导出配置失败');
        }
        const blob = new Blob([JSON.stringify(data.config, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        const boardId = data.config.board?.id || 'custom';
        const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        a.href = url;
        a.download = `firmware-config-${boardId}-${ts}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        showSuccess('编译配置已导出');
    } catch (error) {
        console.error('导出配置失败:', error);
        showError('导出配置失败: ' + error.message);
    }
}

async function importCompileConfig(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    try {
        const text = await file.text();
        const json = JSON.parse(text);
        if (json.schema !== 1) {
            throw new Error('不支持的配置版本: ' + json.schema);
        }
        const response = await fetch('/api/firmware/import-config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(json)
        });
        const data = await response.json();
        if (!response.ok || !data.success) {
            throw new Error(data.error || '导入配置失败');
        }

        const current = data.params || {};
        const boardConfig = data.board_config;

        if (boardConfig) {
            const presetMode = document.querySelector('input[name="compileMode"][value="preset"]');
            if (presetMode) presetMode.checked = true;
            document.getElementById('compilePresetSection').style.display = '';
            document.getElementById('compileCustomSection').style.display = 'none';

            await loadCompilePresetManufacturers();
            const mfrSelect = document.getElementById('compilePresetManufacturer');
            if (_selectCompileOption(mfrSelect, boardConfig.manufacturer)) {
                await onCompilePresetManufacturerChange();
                const typeSelect = document.getElementById('compilePresetType');
                if (_selectCompileOption(typeSelect, boardConfig.board_type || boardConfig.type)) {
                    await onCompilePresetTypeChange();
                    const modelSelect = document.getElementById('compilePresetModel');
                    _selectCompileOption(modelSelect, boardConfig.id);
                    await onCompilePresetModelChange();
                }
            }
        } else {
            const customMode = document.querySelector('input[name="compileMode"][value="custom"]');
            if (customMode) customMode.checked = true;
            _clearSelectedCompileBoard();
            document.getElementById('compilePresetSection').style.display = 'none';
            document.getElementById('compileCustomSection').style.display = 'block';
            document.getElementById('compileMcuDetails').style.display = 'none';
            currentCompileMcu = null;
            await loadCompileMcuPlatforms(false);

            const platformSelect = document.getElementById('compileMcuPlatform');
            const platformValue = current.platform || current.platform_key;
            if (platformValue && _selectCompileOption(platformSelect, platformValue)) {
                await onCompileMcuPlatformChange();
                const modelSelect = document.getElementById('compileMcuModel');
                if (current.mcu && _selectCompileOption(modelSelect, current.mcu)) {
                    await onCompileMcuModelChange();
                }
            }
        }

        _setCompileSelectValue(document.getElementById('compileCrystal'), current.crystal);
        _setCompileSelectValue(document.getElementById('compileBlOffset'), current.bl_offset);

        const startupPin = document.getElementById('compileStartupPin');
        if (startupPin) startupPin.value = current.startup_pin || '';

        if (current.comm_type) {
            const connSelect = document.getElementById('compileConnection');
            if (_selectCompileOption(connSelect, current.comm_type)) {
                onCompileConnectionChange();
                if (current.comm_config_symbol) {
                    _selectCompileSymbol(document.getElementById('compileConnectionDetail'), current.comm_config_symbol);
                }
            }
        }
        if (current.bridge_can_config) {
            _selectCompileSymbol(document.getElementById('compileBridgeCanPin'), current.bridge_can_config);
        }
        _restoreCommunicationExtraSymbols(current.comm_extra_symbols);
        if (current.canbus_frequency) {
            _setSelectedCanBitrate(current.canbus_frequency);
        }
        if (current.rp2040_can_rx_gpio) {
            const rxInput = document.getElementById('compileRp2040CanRx');
            if (rxInput) rxInput.value = current.rp2040_can_rx_gpio;
        }
        if (current.rp2040_can_tx_gpio) {
            const txInput = document.getElementById('compileRp2040CanTx');
            if (txInput) txInput.value = current.rp2040_can_tx_gpio;
        }

        const warningText = (data.warnings || []).length ? `（${data.warnings.join('；')}）` : '';
        showSuccess('编译配置已导入' + warningText);
    } catch (error) {
        console.error('导入配置失败:', error);
        showError('导入配置失败: ' + error.message);
    }
}

// ==================== 编译历史 ====================
function _escFh(s) { const d = document.createElement('div'); d.textContent = s || ''; return d.innerHTML; }

async function loadFirmwareHistory() {
    const container = document.getElementById('firmwareHistoryList');
    if (!container) return;
    try {
        const resp = await fetch('/api/firmware/history');
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.json();
        if (!data.success || !data.history || data.history.length === 0) {
            container.innerHTML = '<span style="color:var(--text-secondary);">暂无编译记录</span>';
            return;
        }
        container.innerHTML = `<table style="width:100%;border-collapse:collapse;font-size:12px;">
            <thead><tr style="border-bottom:1px solid var(--border-color);text-align:left;">
                <th style="padding:6px 8px;">时间</th><th style="padding:6px 8px;">板卡</th>
                <th style="padding:6px 8px;">MCU</th><th style="padding:6px 8px;">大小</th>
                <th style="padding:6px 8px;">操作</th>
            </tr></thead><tbody>${data.history.slice(0, 20).map(h => `
                <tr style="border-bottom:1px solid var(--border-color);">
                    <td style="padding:6px 8px;">${_escFh(h.timestamp)}</td>
                    <td style="padding:6px 8px;">${_escFh((h.board && h.board.name) || (h.board && h.board.id) || '-')}</td>
                    <td style="padding:6px 8px;">${_escFh((h.mcu && h.mcu.id) || '-')}</td>
                    <td style="padding:6px 8px;">${h.firmware_size ? (h.firmware_size / 1024).toFixed(1) + 'KB' : '-'}</td>
                    <td style="padding:6px 8px;">
                        <button onclick="downloadFirmwareHistory('${_escFh(h.id)}')" style="background:none;border:none;color:var(--primary-color);cursor:pointer;margin-right:8px;" title="下载"><i class="fas fa-download"></i></button>
                        <button onclick="deleteFirmwareHistory('${_escFh(h.id)}')" style="background:none;border:none;color:var(--danger-color);cursor:pointer;" title="删除"><i class="fas fa-trash"></i></button>
                    </td>
                </tr>`).join('')}
            </tbody></table>`;
    } catch (e) {
        container.innerHTML = '<span style="color:var(--danger-color);">加载失败</span>';
    }
}

async function downloadFirmwareHistory(id) {
    // 使用 fetch 下载（自动携带 CSRF 认证头）。
    // 不能用 <a href> 直接跳转：页面跳转不携带 X-CSRF-Token 头，会被 CSRF 校验拦截返回 401。
    try {
        const resp = await fetch(`/api/firmware/history/${encodeURIComponent(id)}/download`);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const blob = await resp.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        const cd = resp.headers.get('Content-Disposition') || '';
        const m = cd.match(/filename="?([^";]+)"?/);
        a.download = m ? m[1] : `firmware-${id}.bin`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    } catch (e) {
        console.error('下载固件失败:', e);
        showError('下载失败: ' + (e.message || e));
    }
}

async function deleteFirmwareHistory(id) {
    if (!confirm('确定删除此编译记录？')) return;
    try {
        const resp = await fetch(`/api/firmware/history/${encodeURIComponent(id)}`, {method: 'DELETE'});
        if (!resp.ok) {
            const errData = await resp.json().catch(() => ({}));
            showError(errData.error || `删除失败: HTTP ${resp.status}`);
            return;
        }
        const data = await resp.json();
        if (data.success) { showSuccess('已删除'); loadFirmwareHistory(); }
        else showError(data.error || '删除失败');
    } catch (e) { showError('删除请求失败'); }
}
