// ==================== 固件批量更新页面 - 重构版 ====================

let updateableConfigs = [];  // 可更新的配置列表
let selectedUpdateConfigs = new Set(); // 选中的配置 ID
let updateBoardConfigs = []; // 主板配置列表（用于选择关联）
let currentBoardConfig = null; // 当前选中的主板配置

function fuEscapeHtml(value) {
    const div = document.createElement('div');
    div.textContent = value == null ? '' : String(value);
    return div.innerHTML;
}

function fuEscapeJsString(value) {
    return String(value == null ? '' : value)
        .replace(/\\/g, '\\\\')
        .replace(/'/g, "\\'")
        .replace(/\n/g, '\\n')
        .replace(/\r/g, '\\r');
}

function fuUpdateConfigKey(config) {
    return `${config?._manufacturer || config?.manufacturer || ''}::${config?.id || ''}`;
}

function fuPruneSelectedUpdateConfigs() {
    const validKeys = new Set(updateableConfigs.map(fuUpdateConfigKey));
    selectedUpdateConfigs.forEach(key => {
        if (!validKeys.has(key)) selectedUpdateConfigs.delete(key);
    });
}

async function fuReadSseJson(response, onLog) {
    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
        return response.json();
    }
    if (!response.body || !response.body.getReader) {
        const text = await response.text();
        throw new Error(text || '浏览器不支持读取流式响应');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let finalResult = null;

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split('\n\n');
        buffer = events.pop() || '';

        for (const eventText of events) {
            const dataLines = eventText.split('\n')
                .filter(line => line.startsWith('data:'))
                .map(line => line.slice(5).trimStart());
            if (!dataLines.length) continue;
            const payload = dataLines.join('\n');
            if (payload.startsWith('[LOG]')) {
                if (onLog) onLog(payload.replace(/^\[LOG\]\s*/, ''));
                continue;
            }
            try {
                finalResult = JSON.parse(payload);
            } catch (error) {
                if (onLog) onLog(payload);
            }
        }
    }

    if (buffer.trim()) {
        const payload = buffer.split('\n')
            .filter(line => line.startsWith('data:'))
            .map(line => line.slice(5).trimStart())
            .join('\n');
        if (payload && !payload.startsWith('[LOG]')) {
            try {
                finalResult = JSON.parse(payload);
            } catch (error) {
                if (onLog) onLog(payload);
            }
        }
    }

    if (!finalResult) {
        throw new Error('流式响应未返回结果');
    }
    return finalResult;
}

// 初始化固件更新页面
async function initFirmwareUpdatePage() {
    await loadUpdateBoardManufacturers();
    await loadFirmwareUpdateConfigs();
}

// 加载厂家列表（用于选择主板配置）
async function loadUpdateBoardManufacturers() {
    try {
        const response = await fetch('/api/config/manufacturers');
        const data = await response.json();

        const select = document.getElementById('updateBoardManufacturer');
        if (data.manufacturers) {
            select.innerHTML = '<option value="">-- 选择厂家 --</option>' +
                data.manufacturers.map(mfr => `<option value="${fuEscapeHtml(mfr)}">${fuEscapeHtml(mfr)}</option>`).join('');
        }
    } catch (error) {
        console.error('加载厂家列表失败:', error);
    }
}

// 厂家选择变化
async function onUpdateBoardManufacturerChange() {
    const manufacturer = document.getElementById('updateBoardManufacturer').value;
    const typeSelect = document.getElementById('updateBoardType');
    const modelSelect = document.getElementById('updateBoardModel');

    typeSelect.innerHTML = '<option value="">-- 选择类型 --</option>';
    typeSelect.disabled = true;
    modelSelect.innerHTML = '<option value="">-- 先选择类型 --</option>';
    modelSelect.disabled = true;
    currentBoardConfig = null;

    if (!manufacturer) return;

    try {
        const response = await fetch(`/api/config/list/${encodeURIComponent(manufacturer)}`);
        const data = await response.json();
        updateBoardConfigs = data.configs || [];

        // 提取类型
        const types = [...new Set(updateBoardConfigs.map(c => c.type))];
        typeSelect.innerHTML = '<option value="">-- 选择类型 --</option>' +
            types.map(type => {
                const label = type === 'mainboard' ? '主板' :
                             type === 'toolboard' ? '工具板' : '扩展板';
                return `<option value="${fuEscapeHtml(type)}">${fuEscapeHtml(label)}</option>`;
            }).join('');
        typeSelect.disabled = false;
    } catch (error) {
        console.error('加载配置列表失败:', error);
    }
}

// 类型选择变化
function onUpdateBoardTypeChange() {
    const type = document.getElementById('updateBoardType').value;
    const modelSelect = document.getElementById('updateBoardModel');

    modelSelect.innerHTML = '<option value="">-- 选择型号 --</option>';
    modelSelect.disabled = true;
    currentBoardConfig = null;

    if (!type) return;

    const configs = updateBoardConfigs.filter(c => c.type === type);
    modelSelect.innerHTML = '<option value="">-- 选择型号 --</option>' +
        configs.map(config => `<option value="${fuEscapeHtml(config.id)}">${fuEscapeHtml(config.name)}</option>`).join('');
    modelSelect.disabled = false;
}

// 型号选择变化
async function onUpdateBoardModelChange() {
    const manufacturer = document.getElementById('updateBoardManufacturer').value;
    const configId = document.getElementById('updateBoardModel').value;

    currentBoardConfig = null;

    if (!configId) return;

    try {
        const response = await fetch(`/api/config/get/${encodeURIComponent(manufacturer)}/${encodeURIComponent(configId)}`);
        const config = await response.json();

        if (config && !config.error) {
            currentBoardConfig = config;
        }
    } catch (error) {
        console.error('加载配置失败:', error);
    }
}

// 创建固件更新配置
async function createFirmwareUpdateConfig() {
    if (!currentBoardConfig) {
        showError('请先选择主板配置');
        return;
    }

    // 打开设置弹窗，传入主板配置信息
    openUpdateSettingsForNewConfig(currentBoardConfig);
}

// 加载固件更新配置列表
async function loadFirmwareUpdateConfigs() {
    const listDiv = document.getElementById('updateableConfigsList');
    listDiv.innerHTML = '<p class="empty">加载中...</p>';

    try {
        const response = await fetch('/api/firmware-update/configs');
        const data = await response.json();

        if (data.success) {
            updateableConfigs = data.configs || [];
            fuPruneSelectedUpdateConfigs();
            document.getElementById('updateableCount').textContent = updateableConfigs.length;
            renderUpdateableConfigs();
        } else {
            listDiv.innerHTML = '<p class="empty">加载失败</p>';
        }
    } catch (error) {
        console.error('加载固件更新配置失败:', error);
        listDiv.innerHTML = '<p class="empty">加载失败</p>';
    }
}

// 加载可更新配置列表
async function loadUpdateableConfigs() {
    const manufacturer = document.getElementById('updateManufacturerFilter').value;
    const type = document.getElementById('updateTypeFilter').value;

    const listDiv = document.getElementById('updateableConfigsList');
    listDiv.innerHTML = '<p class="empty">加载中...</p>';

    try {
        let configs = [];

        if (manufacturer) {
            // 加载特定厂家的配置
            const response = await fetch(`/api/config/list/${encodeURIComponent(manufacturer)}`);
            const data = await response.json();
            configs = data.configs || [];
        } else {
            // 加载所有配置
            const response = await fetch('/api/config/all');
            const data = await response.json();
            configs = data.configs || [];
        }

        // 类型筛选
        if (type) {
            configs = configs.filter(c => c.type === type);
        }

        updateableConfigs = configs;
        fuPruneSelectedUpdateConfigs();

        // 更新计数
        document.getElementById('updateableCount').textContent = configs.length;

        // 渲染列表
        renderUpdateableConfigs();

    } catch (error) {
        console.error('加载配置失败:', error);
        listDiv.innerHTML = '<p class="empty">加载失败</p>';
    }
}

// 渲染可更新配置列表
function renderUpdateableConfigs() {
    const listDiv = document.getElementById('updateableConfigsList');

    if (updateableConfigs.length === 0) {
        listDiv.innerHTML = '<p class="empty">暂无固件更新配置，请先选择主板配置并创建</p>';
        return;
    }

    let html = '';
    updateableConfigs.forEach(config => {
        const configKey = fuUpdateConfigKey(config);
        const isSelected = selectedUpdateConfigs.has(configKey);
        const updateEnabled = config.enabled !== false;
        const deviceId = config.device_id || '';
        const mode = config.mode || '';

        // 模式简称
        const modeShortNames = {
            'CAN': 'CAN',
            'USB_DFU': 'USB-DFU',
            'USB_KATAPULT': 'USB-KAT',
            'USB_SERIAL': 'USB-SER',
            'CAN_BRIDGE_DFU': 'BR-DFU',
            'CAN_BRIDGE_KATAPULT': 'BR-KAT',
            'TF': 'TF卡',
            'HOST': 'HOST'
        };

        html += `
            <div class="config-card ${isSelected ? 'selected' : ''}" data-id="${fuEscapeHtml(configKey)}">
                <input type="checkbox" ${isSelected ? 'checked' : ''}
                       onchange="toggleUpdateSelection('${fuEscapeJsString(configKey)}')">
                <div class="info">
                    <div class="name">${fuEscapeHtml(config.id)}</div>
                    <div class="details">
                        ${updateEnabled ? '<span style="color:#28a745;">' + fuEscapeHtml(modeShortNames[mode] || mode) + '</span>' : '<span style="color:#6c757d;">已禁用</span>'}
                        ${deviceId ? '| ' + fuEscapeHtml(deviceId.substring(0, 12)) + '...' : ''}
                        ${config.board_config_id ? '| 关联: ' + fuEscapeHtml(config.board_config_id) : ''}
                    </div>
                </div>
                <div class="status">
                    <span class="status-badge ${updateEnabled ? 'enabled' : 'disabled'}">
                        ${updateEnabled ? '已启用' : '未启用'}
                    </span>
                    <button class="btn btn-sm btn-secondary" onclick="openUpdateSettings('${fuEscapeJsString(configKey)}')">
                        ⚙️ 设置
                    </button>
                    <button class="btn btn-sm btn-danger" onclick="deleteFirmwareUpdateConfig('${fuEscapeJsString(config._manufacturer)}', '${fuEscapeJsString(config.id)}')">
                        🗑️
                    </button>
                </div>
            </div>
        `;
    });

    listDiv.innerHTML = html;
}

// 删除固件更新配置
async function deleteFirmwareUpdateConfig(manufacturer, configId) {
    if (!confirm('确定要删除这个固件更新配置吗？')) {
        return;
    }

    try {
        const response = await fetch(`/api/firmware-update/config/${encodeURIComponent(manufacturer)}/${encodeURIComponent(configId)}`, {
            method: 'DELETE'
        });

        const result = await response.json();

        if (result.success) {
            showSuccess('配置已删除');
            loadFirmwareUpdateConfigs(); // 刷新列表
        } else {
            showError('删除失败: ' + (result.error || '未知错误'));
        }
    } catch (error) {
        console.error('删除配置失败:', error);
        showError('删除失败: ' + error.message);
    }
}

// 切换选择状态
function toggleUpdateSelection(configId) {
    if (selectedUpdateConfigs.has(configId)) {
        selectedUpdateConfigs.delete(configId);
    } else {
        selectedUpdateConfigs.add(configId);
    }

    renderUpdateableConfigs();
    updateSelectedUpdateList();
}

// 全选/全不选
function selectAllUpdateable(select) {
    if (select) {
        updateableConfigs.forEach(c => {
            if (c.enabled !== false) {
                selectedUpdateConfigs.add(fuUpdateConfigKey(c));
            }
        });
    } else {
        selectedUpdateConfigs.clear();
    }

    renderUpdateableConfigs();
    updateSelectedUpdateList();
}

// 更新已选中列表显示
function updateSelectedUpdateList() {
    const countSpan = document.getElementById('selectedUpdateCount');
    const listDiv = document.getElementById('selectedUpdateList');

    countSpan.textContent = selectedUpdateConfigs.size;

    if (selectedUpdateConfigs.size === 0) {
        listDiv.innerHTML = '<p class="empty">暂无选中的配置</p>';
        return;
    }

    let html = '';
    selectedUpdateConfigs.forEach(key => {
        const config = updateableConfigs.find(c => fuUpdateConfigKey(c) === key);
        if (config) {
            html += `
                <span class="selected-item">
                    ${fuEscapeHtml(config.name || config.id)}
                    <span class="remove" onclick="toggleUpdateSelection('${fuEscapeJsString(key)}')">×</span>
                </span>
            `;
        }
    });

    listDiv.innerHTML = html;
}

// 打开更新设置弹窗（用于新建配置）
function inferUpdateMode(boardConfig) {
    const fw = boardConfig.firmware_update || {};
    const flashMode = fw.flash_mode || boardConfig.default_flash || 'DFU';
    const conn = (boardConfig.default_connection || '').toUpperCase();
    const isBridge = conn.includes('BRIDGE') || conn.includes('USB转CAN') || conn.includes('USBCANBUS');
    const hasCan = conn.includes('CAN');
    const hasUsb = conn.includes('USB') && !conn.includes('转');

    if (flashMode === 'TF') {
        return 'TF';
    }

    if (flashMode === 'HOST') {
        return 'HOST';
    }

    if (flashMode === 'UF2') {
        return 'UF2';
    }

    if (isBridge) {
        if (flashMode === 'DFU') return 'CAN_BRIDGE_DFU';
        return 'CAN_BRIDGE_KATAPULT';
    }

    if (hasCan && !hasUsb) {
        return 'CAN';
    }

    if (flashMode === 'DFU') return 'USB_DFU';
    if (flashMode === 'KAT') return 'USB_KATAPULT';
    if (flashMode === 'SERIAL') return 'USB_SERIAL';

    return 'USB_DFU';
}

function openUpdateSettingsForNewConfig(boardConfig) {
    // 生成固件更新配置ID
    const updateConfigId = `update_${boardConfig.id}`;

    document.getElementById('updateSettingConfigId').value = updateConfigId;
    document.getElementById('updateSettingBoardConfigId').value = boardConfig.id;
    document.getElementById('updateSettingManufacturer').value = boardConfig.manufacturer || 'FLY';
    document.getElementById('updateSettingEnabled').value = 'true';
    document.getElementById('updateSettingMode').value = inferUpdateMode(boardConfig);
    document.getElementById('updateSettingDeviceId').value = '';
    document.getElementById('updateSettingKatapultSerial').value = '';

    // 显示关联的主板配置信息
    document.getElementById('linkedBoardConfigInfo').innerHTML = `
        <div style="background:#e3f2fd;padding:10px;border-radius:8px;margin-bottom:15px;">
            <strong>关联主板配置:</strong> ${fuEscapeHtml(boardConfig.name)}<br>
            <small>${fuEscapeHtml(boardConfig.platform)} ${fuEscapeHtml(boardConfig.mcu)} | ${fuEscapeHtml(boardConfig.type)}</small>
        </div>
    `;

    // 根据启用状态显示/隐藏选项
    toggleUpdateModeOptions();
    onUpdateModeChange();

    document.getElementById('updateSettingsModal').style.display = 'flex';
}

// 打开更新设置弹窗（用于编辑现有配置）
async function openUpdateSettings(configKey) {
    const config = updateableConfigs.find(c => fuUpdateConfigKey(c) === configKey);
    if (!config) return;

    document.getElementById('updateSettingConfigId').value = config.id;
    document.getElementById('updateSettingBoardConfigId').value = config.board_config_id || '';
    document.getElementById('updateSettingManufacturer').value = config.manufacturer || 'FLY';
    document.getElementById('updateSettingEnabled').value = (config.enabled !== false).toString();
    document.getElementById('updateSettingMode').value = config.mode || 'CAN';
    document.getElementById('updateSettingDeviceId').value = config.device_id || '';
    document.getElementById('updateSettingKatapultSerial').value = config.katapult_serial || '';

    // 显示关联的主板配置信息
    const linkedInfoDiv = document.getElementById('linkedBoardConfigInfo');
    if (config.board_config) {
        linkedInfoDiv.innerHTML = `
            <div style="background:#e3f2fd;padding:10px;border-radius:8px;margin-bottom:15px;">
                <strong>关联主板配置:</strong> ${fuEscapeHtml(config.board_config.name)}<br>
                <small>${fuEscapeHtml(config.board_config.platform)} ${fuEscapeHtml(config.board_config.mcu)} | ${fuEscapeHtml(config.board_config.type)}</small>
            </div>
        `;
    } else if (config.board_config_id) {
        // 后端未嵌入 board_config，主动获取
        linkedInfoDiv.innerHTML = `<div style="padding:10px;border-radius:8px;margin-bottom:15px;font-size:13px;color:#666;">加载关联配置信息...</div>`;
        try {
            const mfr = config._manufacturer || config.manufacturer;
            const bcResponse = await fetch(`/api/config/get/${encodeURIComponent(mfr)}/${encodeURIComponent(config.board_config_id)}`);
            const boardConfig = await bcResponse.json();
            if (boardConfig && !boardConfig.error) {
                linkedInfoDiv.innerHTML = `
                    <div style="background:#e3f2fd;padding:10px;border-radius:8px;margin-bottom:15px;">
                        <strong>关联主板配置:</strong> ${fuEscapeHtml(boardConfig.name || config.board_config_id)}<br>
                        <small>${fuEscapeHtml(boardConfig.platform || '')} ${fuEscapeHtml(boardConfig.mcu || '')} | ${fuEscapeHtml(boardConfig.type || '')}</small>
                    </div>
                `;
            } else {
                linkedInfoDiv.innerHTML = `<div style="padding:10px;border-radius:8px;margin-bottom:15px;font-size:13px;color:#888;">关联配置: ${fuEscapeHtml(config.board_config_id)}</div>`;
            }
        } catch (e) {
            linkedInfoDiv.innerHTML = `<div style="padding:10px;border-radius:8px;margin-bottom:15px;font-size:13px;color:#888;">关联配置: ${fuEscapeHtml(config.board_config_id)}</div>`;
        }
    } else {
        linkedInfoDiv.innerHTML = '';
    }

    // 根据启用状态显示/隐藏选项
    toggleUpdateModeOptions();
    onUpdateModeChange();

    document.getElementById('updateSettingsModal').style.display = 'flex';
}

// 切换更新模式选项显示
function toggleUpdateModeOptions() {
    const enabled = document.getElementById('updateSettingEnabled').value === 'true';
    const optionsDiv = document.getElementById('updateSettingOptions');
    optionsDiv.style.display = enabled ? 'block' : 'none';
}

// 更新模式变化处理
function onUpdateModeChange() {
    const mode = document.getElementById('updateSettingMode').value;
    const deviceIdRow = document.getElementById('deviceIdRow');
    const katapultSerialRow = document.getElementById('katapultSerialRow');
    const helpText = document.getElementById('modeHelpText');

    // 模式说明
    const modeDescriptions = {
        'CAN': '主板通过CAN总线连接，Klipper通讯接口为CAN，BootLoader为Katapult',
        'USB_DFU': '主板通过USB连接，Klipper通讯接口为USB，BootLoader为官方自带',
        'USB_KATAPULT': '主板通过USB连接，Klipper通讯接口为USB，BootLoader为Katapult',
        'USB_SERIAL': '主板通过USB连接，中间经过串口芯片到主控MCU',
        'CAN_BRIDGE_DFU': '主板通过USB连接，Klipper通讯接口为USB to CAN桥接，BootLoader为官方自带',
        'CAN_BRIDGE_KATAPULT': '主板通过USB连接，Klipper通讯接口为USB to CAN桥接，BootLoader为Katapult',
        'TF': '下载firmware.bin到本地，手动复制到TF卡烧录',
        'HOST': '上位机Linux进程，无需设备ID'
    };

    helpText.textContent = modeDescriptions[mode] || '';

    // 根据模式显示/隐藏字段
    if (mode === 'HOST') {
        deviceIdRow.style.display = 'none';
        katapultSerialRow.style.display = 'none';
    } else if (mode === 'TF') {
        deviceIdRow.style.display = 'none';
        katapultSerialRow.style.display = 'none';
    } else if (mode === 'USB_KATAPULT' || mode === 'CAN_BRIDGE_KATAPULT') {
        deviceIdRow.style.display = 'flex';
        katapultSerialRow.style.display = 'flex';
    } else {
        deviceIdRow.style.display = 'flex';
        katapultSerialRow.style.display = 'none';
    }
}

// 扫描设备ID
async function scanDeviceIdForUpdate() {
    const mode = document.getElementById('updateSettingMode').value;
    const deviceIdInput = document.getElementById('updateSettingDeviceId');

    deviceIdInput.placeholder = '扫描中...';

    try {
        if (mode === 'CAN') {
            // 扫描CAN设备 — 使用与资源页相同的 /api/system/can-uuid
            const response = await fetch('/api/system/can-uuid', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ iface: 'can0' })
            });
            const data = await response.json();
            if (data.uuids && data.uuids.length > 0) {
                deviceIdInput.value = data.uuids[0].uuid;
                showSuccess(`找到 ${data.uuids.length} 个CAN设备`);
            } else {
                showError(data.error || '未找到CAN设备');
            }
        } else {
            // 扫描USB设备
            const response = await fetch('/api/firmware/detect');
            const data = await response.json();
            if (data.devices && data.devices.length > 0) {
                // 优先匹配 USB 串口设备（type === 'usb_serial'），其次匹配含 by-id 的 id
                const usbDevice = data.devices.find(d => d.type === 'usb_serial')
                    || data.devices.find(d => (d.id || '').includes('by-id'))
                    || data.devices[0];
                if (usbDevice) {
                    deviceIdInput.value = usbDevice.id || usbDevice.path || usbDevice.name || '';
                    showSuccess('找到USB设备');
                } else {
                    showError('未找到USB设备');
                }
            } else {
                showError('未找到USB设备');
            }
        }
    } catch (error) {
        console.error('扫描失败:', error);
        showError('扫描失败: ' + error.message);
    } finally {
        deviceIdInput.placeholder = '例如: c5360983cdc4 或 /dev/serial/by-id/...';
    }
}

// 关闭更新设置弹窗
function closeUpdateSettingsModal() {
    document.getElementById('updateSettingsModal').style.display = 'none';
}

// 切换更新设置选项显示
function toggleUpdateSettingOptions() {
    const enabled = document.getElementById('updateSettingEnabled').value === 'true';
    const optionsDiv = document.getElementById('updateSettingOptions');
    optionsDiv.style.display = enabled ? 'block' : 'none';
}

// 监听启用状态变化
document.addEventListener('change', function(e) {
    if (e.target.id === 'updateSettingEnabled') {
        toggleUpdateSettingOptions();
    }
});

// 保存更新设置
async function saveUpdateSettings() {
    const configId = document.getElementById('updateSettingConfigId').value;
    const manufacturer = document.getElementById('updateSettingManufacturer').value;
    const boardConfigId = document.getElementById('updateSettingBoardConfigId').value;

    // 构建固件更新配置（简化版，只包含必要信息）
    const updateConfig = {
        id: configId,
        board_config_id: boardConfigId,
        manufacturer: manufacturer,
        enabled: document.getElementById('updateSettingEnabled').value === 'true',
        mode: document.getElementById('updateSettingMode').value,
        device_id: document.getElementById('updateSettingDeviceId').value,
        katapult_serial: document.getElementById('updateSettingKatapultSerial').value
    };

    try {
        const response = await fetch(`/api/firmware-update/config/${encodeURIComponent(manufacturer)}/${encodeURIComponent(configId)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(updateConfig)
        });

        const result = await response.json();

        if (result.success) {
            showSuccess('固件更新配置已保存');
            closeUpdateSettingsModal();
            loadFirmwareUpdateConfigs(); // 刷新列表
        } else {
            showError('保存失败: ' + (result.error || '未知错误'));
        }
    } catch (error) {
        console.error('保存设置失败:', error);
        showError('保存失败: ' + error.message);
    }
}

// 编译所有选中的配置
async function compileAllSelected() {
    if (selectedUpdateConfigs.size === 0) {
        showError('请先选择要编译的配置');
        return;
    }

    const configs = updateableConfigs.filter(c => selectedUpdateConfigs.has(fuUpdateConfigKey(c)));

    // 显示进度
    showBatchProgress();
    const resultsDiv = document.getElementById('batchUpdateResults');
    resultsDiv.innerHTML = '';

    let completed = 0;
    const total = configs.length;

    for (const config of configs) {
        const displayName = config.name || config.id;
        updateBatchStatus(`正在编译: ${displayName}...`);
        addBatchResult(displayName, 'running', '编译中...');

        if (!config.board_config_id) {
            addBatchResult(displayName, 'error', '未关联主板配置，无法编译');
            completed++;
            updateBatchProgress(completed, total);
            continue;
        }

        try {
            // 先获取完整的主板配置
            const mfr = config._manufacturer || config.manufacturer;
            const bcResponse = await fetch(`/api/config/get/${encodeURIComponent(mfr)}/${encodeURIComponent(config.board_config_id)}`);
            const boardConfig = await bcResponse.json();

            if (boardConfig.error) {
                addBatchResult(displayName, 'error', '获取主板配置失败: ' + boardConfig.error);
                completed++;
                updateBatchProgress(completed, total);
                continue;
            }

            // 使用完整的主板配置进行编译
            const compileResponse = await fetch('/api/firmware/compile', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ config: boardConfig })
            });

            const result = await fuReadSseJson(compileResponse);

            if (result.success) {
                addBatchResult(displayName, 'success', '编译成功');
            } else {
                addBatchResult(displayName, 'error', result.error || '编译失败');
            }
        } catch (error) {
            addBatchResult(displayName, 'error', error.message);
        }

        completed++;
        updateBatchProgress(completed, total);
    }

    updateBatchStatus('编译完成');
    setTimeout(hideBatchProgress, 3000);
}

// 一键更新所有选中的配置
async function flashAllSelected() {
    if (selectedUpdateConfigs.size === 0) {
        showError('请先选择要更新的配置');
        return;
    }

    const configs = updateableConfigs.filter(c =>
        selectedUpdateConfigs.has(fuUpdateConfigKey(c)) && c.enabled !== false
    );

    if (configs.length === 0) {
        showError('选中的配置中，没有启用固件更新的');
        return;
    }

    // 确认
    if (!confirm(`确定要更新 ${configs.length} 个配置吗？`)) {
        return;
    }

    // 显示进度
    showBatchProgress();
    const resultsDiv = document.getElementById('batchUpdateResults');
    resultsDiv.innerHTML = '';

    let completed = 0;
    const total = configs.length;

    for (const config of configs) {
        const mode = config.mode || 'CAN';
        const displayName = config.name || config.id;

        updateBatchStatus(`正在更新: ${displayName}...`);
        addBatchResult(displayName, 'running', '编译中...');

        if (!config.board_config_id) {
            addBatchResult(displayName, 'error', '未关联主板配置，无法编译');
            completed++;
            updateBatchProgress(completed, total);
            continue;
        }

        try {
            // 1. 先获取完整的主板配置
            const mfr = config._manufacturer || config.manufacturer;
            const bcResponse = await fetch(`/api/config/get/${encodeURIComponent(mfr)}/${encodeURIComponent(config.board_config_id)}`);
            const boardConfig = await bcResponse.json();

            if (boardConfig.error) {
                addBatchResult(displayName, 'error', '获取主板配置失败: ' + boardConfig.error);
                completed++;
                updateBatchProgress(completed, total);
                continue;
            }

            // 2. 使用完整的主板配置进行编译
            const compileResponse = await fetch('/api/firmware/compile', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ config: boardConfig })
            });

            const compileResult = await fuReadSseJson(compileResponse);

            if (!compileResult.success) {
                addBatchResult(displayName, 'error', '编译失败: ' + (compileResult.error || '未知错误'));
                completed++;
                updateBatchProgress(completed, total);
                continue;
            }

            // 3. 根据模式处理
            if (mode === 'TF') {
                // TF卡模式：提供下载
                addBatchResult(displayName, 'success', '编译成功，请下载firmware.bin到TF卡');
                // 自动触发下载
                const downloadUrl = `/api/firmware/download?path=${encodeURIComponent(compileResult.firmware_path)}`;
                window.open(downloadUrl, '_blank');
            } else if (mode === 'UF2') {
                // UF2模式：直接烧录
                addBatchResult(displayName, 'running', 'UF2烧录中...');
                const flashResponse = await fetch('/api/firmware/flash', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        device_id: config.device_id || '',
                        flash_mode: 'UF2',
                        firmware_path: compileResult.firmware_path
                    })
                });
                const flashResult = await fuReadSseJson(flashResponse);
                if (flashResult.success) {
                    addBatchResult(displayName, 'success', 'UF2烧录成功');
                } else {
                    addBatchResult(displayName, 'error', 'UF2烧录失败: ' + (flashResult.error || '未知错误'));
                }
            } else if (mode === 'HOST') {
                // HOST模式：安装到上位机并自动重启
                addBatchResult(displayName, 'running', '安装到上位机...');
                const installResponse = await fetch('/api/firmware/install-host', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        firmware_path: compileResult.firmware_path,
                        auto_restart: true
                    })
                });
                const installResult = await fuReadSseJson(installResponse);
                if (installResult.success) {
                    const msg = installResult.message || '安装成功';
                    addBatchResult(displayName, 'success', msg);
                } else {
                    addBatchResult(displayName, 'error', '安装失败: ' + (installResult.error || '未知错误'));
                }
            } else {
                // 其他模式：烧录
                addBatchResult(displayName, 'running', '烧录中...');

                // 将新模式映射到旧的flash_mode
                const modeToFlashMode = {
                    'CAN': 'CAN',
                    'USB_DFU': 'DFU',
                    'USB_KATAPULT': 'KAT',
                    'USB_SERIAL': 'SERIAL',
                    'CAN_BRIDGE_DFU': 'DFU',
                    'CAN_BRIDGE_KATAPULT': 'KAT'
                };

                const flashResponse = await fetch('/api/firmware/flash', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        device_id: config.device_id || '',
                        flash_mode: modeToFlashMode[mode] || 'KAT',
                        firmware_path: compileResult.firmware_path,
                        katapult_serial: config.katapult_serial || ''
                    })
                });

                const flashResult = await fuReadSseJson(flashResponse);

                if (flashResult.success) {
                    addBatchResult(displayName, 'success', '更新成功');
                } else {
                    addBatchResult(displayName, 'error', '烧录失败: ' + (flashResult.error || '未知错误'));
                }
            }

        } catch (error) {
            addBatchResult(displayName, 'error', error.message);
        }

        completed++;
        updateBatchProgress(completed, total);
    }

    updateBatchStatus('更新完成');
    setTimeout(hideBatchProgress, 5000);
}

// 显示批量进度
function showBatchProgress() {
    document.getElementById('batchUpdateProgress').style.display = 'block';
    updateBatchProgress(0, 1);
}

// 隐藏批量进度
function hideBatchProgress() {
    document.getElementById('batchUpdateProgress').style.display = 'none';
}

// 更新进度条
function updateBatchProgress(completed, total) {
    const percentage = Math.round((completed / total) * 100);
    document.getElementById('batchProgressBar').style.width = percentage + '%';
    document.getElementById('batchProgressText').textContent = percentage + '%';
}

// 更新状态文本
function updateBatchStatus(status) {
    document.getElementById('batchUpdateStatus').textContent = status;
}

// 添加批量结果
function addBatchResult(name, status, message) {
    const resultsDiv = document.getElementById('batchUpdateResults');

    // 查找是否已有该配置的结果，有则更新
    const existingItem = Array.from(resultsDiv.querySelectorAll('.update-result-item'))
        .find(el => el.dataset.name === String(name));
    if (existingItem) {
        existingItem.className = 'update-result-item';
        existingItem.innerHTML = `
            <div class="update-result-status ${status}">
                ${status === 'success' ? '✓' : status === 'error' ? '✗' : status === 'running' ? '◐' : '○'}
            </div>
            <div class="info" style="flex:1;">
                <div style="font-weight:500;">${fuEscapeHtml(name)}</div>
                <div style="font-size:13px;color:#6c757d;">${fuEscapeHtml(message)}</div>
            </div>
        `;
        return;
    }

    // 添加新结果
    const item = document.createElement('div');
    item.className = 'update-result-item';
    item.dataset.name = name;
    item.innerHTML = `
        <div class="update-result-status ${status}">
            ${status === 'success' ? '✓' : status === 'error' ? '✗' : status === 'running' ? '◐' : '○'}
        </div>
        <div class="info" style="flex:1;">
            <div style="font-weight:500;">${fuEscapeHtml(name)}</div>
            <div style="font-size:13px;color:#6c757d;">${fuEscapeHtml(message)}</div>
        </div>
    `;

    resultsDiv.insertBefore(item, resultsDiv.firstChild);
}

// 页面加载时初始化由 app.js 的 switchPage 统一调度，此处不重复注册
