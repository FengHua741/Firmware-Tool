// ==================== 固件批量更新页面 - 重构版 ====================

let updateableConfigs = [];  // 可更新的配置列表
let selectedUpdateConfigs = new Set(); // 选中的配置 ID
let boardConfigs = []; // 主板配置列表（用于选择关联）
let currentBoardConfig = null; // 当前选中的主板配置

// 初始化固件更新页面
async function initFirmwareUpdatePage() {
    console.log('初始化固件更新页面...');
    await loadUpdateBoardManufacturers();
    await loadFirmwareUpdateConfigs();
}

// 加载厂家列表（用于选择主板配置）
async function loadUpdateBoardManufacturers() {
    try {
        const response = await fetch('/api/config/manufacturers');
        const data = await response.json();
        
        const select = document.getElementById('updateBoardManufacturer');
        select.innerHTML = '<option value="">-- 选择厂家 --</option>';
        
        if (data.manufacturers) {
            data.manufacturers.forEach(mfr => {
                select.innerHTML += `<option value="${mfr}">${mfr}</option>`;
            });
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
        const response = await fetch(`/api/config/list/${manufacturer}`);
        const data = await response.json();
        boardConfigs = data.configs || [];
        
        // 提取类型
        const types = [...new Set(boardConfigs.map(c => c.type))];
        types.forEach(type => {
            const label = type === 'mainboard' ? '主板' : 
                         type === 'toolboard' ? '工具板' : '扩展板';
            typeSelect.innerHTML += `<option value="${type}">${label}</option>`;
        });
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
    
    const configs = boardConfigs.filter(c => c.type === type);
    configs.forEach(config => {
        modelSelect.innerHTML += `<option value="${config.id}">${config.name}</option>`;
    });
    modelSelect.disabled = false;
}

// 型号选择变化
async function onUpdateBoardModelChange() {
    const manufacturer = document.getElementById('updateBoardManufacturer').value;
    const configId = document.getElementById('updateBoardModel').value;
    
    currentBoardConfig = null;
    
    if (!configId) return;
    
    try {
        const response = await fetch(`/api/config/get/${manufacturer}/${configId}`);
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
            const response = await fetch(`/api/config/list/${manufacturer}`);
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
        const isSelected = selectedUpdateConfigs.has(config.id);
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
            <div class="config-card ${isSelected ? 'selected' : ''}" data-id="${config.id}">
                <input type="checkbox" ${isSelected ? 'checked' : ''} 
                       onchange="toggleUpdateSelection('${config.id}')">
                <div class="info">
                    <div class="name">${config.id}</div>
                    <div class="details">
                        ${updateEnabled ? '<span style="color:#28a745;">' + (modeShortNames[mode] || mode) + '</span>' : '<span style="color:#6c757d;">已禁用</span>'}
                        ${deviceId ? '| ' + deviceId.substring(0, 12) + '...' : ''}
                        ${config.board_config_id ? '| 关联: ' + config.board_config_id : ''}
                    </div>
                </div>
                <div class="status">
                    <span class="status-badge ${updateEnabled ? 'enabled' : 'disabled'}">
                        ${updateEnabled ? '已启用' : '未启用'}
                    </span>
                    <button class="btn btn-sm btn-secondary" onclick="openUpdateSettings('${config.id}')">
                        ⚙️ 设置
                    </button>
                    <button class="btn btn-sm btn-danger" onclick="deleteFirmwareUpdateConfig('${config._manufacturer}', '${config.id}')">
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
        const response = await fetch(`/api/firmware-update/config/${manufacturer}/${configId}`, {
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
        updateableConfigs.forEach(c => selectedUpdateConfigs.add(c.id));
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
    selectedUpdateConfigs.forEach(id => {
        const config = updateableConfigs.find(c => c.id === id);
        if (config) {
            html += `
                <span class="selected-item">
                    ${config.name}
                    <span class="remove" onclick="toggleUpdateSelection('${id}')">×</span>
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

    if (flashMode === 'UF2') {
        return 'TF';
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
            <strong>关联主板配置:</strong> ${boardConfig.name}<br>
            <small>${boardConfig.platform} ${boardConfig.mcu} | ${boardConfig.type}</small>
        </div>
    `;
    
    // 根据启用状态显示/隐藏选项
    toggleUpdateModeOptions();
    onUpdateModeChange();
    
    document.getElementById('updateSettingsModal').style.display = 'flex';
}

// 打开更新设置弹窗（用于编辑现有配置）
function openUpdateSettings(configId) {
    const config = updateableConfigs.find(c => c.id === configId);
    if (!config) return;
    
    document.getElementById('updateSettingConfigId').value = config.id;
    document.getElementById('updateSettingBoardConfigId').value = config.board_config_id || '';
    document.getElementById('updateSettingManufacturer').value = config.manufacturer || 'FLY';
    document.getElementById('updateSettingEnabled').value = (config.enabled !== false).toString();
    document.getElementById('updateSettingMode').value = config.mode || 'CAN';
    document.getElementById('updateSettingDeviceId').value = config.device_id || '';
    document.getElementById('updateSettingKatapultSerial').value = config.katapult_serial || '';
    
    // 显示关联的主板配置信息
    if (config.board_config) {
        document.getElementById('linkedBoardConfigInfo').innerHTML = `
            <div style="background:#e3f2fd;padding:10px;border-radius:8px;margin-bottom:15px;">
                <strong>关联主板配置:</strong> ${config.board_config.name}<br>
                <small>${config.board_config.platform} ${config.board_config.mcu} | ${config.board_config.type}</small>
            </div>
        `;
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
            // 扫描CAN设备
            const response = await fetch('/api/firmware/can/scan');
            const data = await response.json();
            if (data.success && data.devices && data.devices.length > 0) {
                deviceIdInput.value = data.devices[0].uuid;
                showSuccess(`找到 ${data.devices.length} 个CAN设备`);
            } else {
                showError('未找到CAN设备');
            }
        } else {
            // 扫描USB设备
            const response = await fetch('/api/firmware/detect');
            const data = await response.json();
            if (data.devices && data.devices.length > 0) {
                // 查找匹配的USB设备
                const usbDevice = data.devices.find(d => d.includes('by-id'));
                if (usbDevice) {
                    deviceIdInput.value = usbDevice;
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
        const response = await fetch(`/api/firmware-update/config/${manufacturer}/${configId}`, {
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
    
    const configs = updateableConfigs.filter(c => selectedUpdateConfigs.has(c.id));
    
    // 显示进度
    showBatchProgress();
    const resultsDiv = document.getElementById('batchUpdateResults');
    resultsDiv.innerHTML = '';
    
    let completed = 0;
    const total = configs.length;
    
    for (const config of configs) {
        updateBatchStatus(`正在编译: ${config.name}...`);
        addBatchResult(config.name, 'running', '编译中...');
        
        try {
            const response = await fetch('/api/firmware/compile', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ config: config })
            });
            
            const result = await response.json();
            
            if (result.success) {
                addBatchResult(config.name, 'success', '编译成功');
            } else {
                addBatchResult(config.name, 'error', result.error || '编译失败');
            }
        } catch (error) {
            addBatchResult(config.name, 'error', error.message);
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
        selectedUpdateConfigs.has(c.id) && c.firmware_update?.enabled
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
        const updateSettings = config.firmware_update;
        const mode = updateSettings.mode || 'CAN';
        
        updateBatchStatus(`正在更新: ${config.name}...`);
        addBatchResult(config.name, 'running', '编译中...');
        
        try {
            // 1. 先编译
            const compileResponse = await fetch('/api/firmware/compile', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ config: config })
            });
            
            const compileResult = await compileResponse.json();
            
            if (!compileResult.success) {
                addBatchResult(config.name, 'error', '编译失败: ' + (compileResult.error || '未知错误'));
                completed++;
                updateBatchProgress(completed, total);
                continue;
            }
            
            // 2. 根据模式处理
            if (mode === 'TF') {
                // TF卡模式：提供下载
                addBatchResult(config.name, 'success', '编译成功，请下载firmware.bin到TF卡');
                // 自动触发下载
                const downloadUrl = `/api/firmware/download?path=${encodeURIComponent(compileResult.firmware_path)}`;
                window.open(downloadUrl, '_blank');
            } else if (mode === 'HOST') {
                // HOST模式：复制到klipper目录
                addBatchResult(config.name, 'running', '安装到上位机...');
                const installResponse = await fetch('/api/firmware/install-host', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        firmware_path: compileResult.firmware_path
                    })
                });
                const installResult = await installResponse.json();
                if (installResult.success) {
                    addBatchResult(config.name, 'success', '安装成功，请重启Klipper');
                } else {
                    addBatchResult(config.name, 'error', '安装失败: ' + (installResult.error || '未知错误'));
                }
            } else {
                // 其他模式：烧录
                addBatchResult(config.name, 'running', '烧录中...');
                
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
                        device_id: updateSettings.device_id,
                        flash_mode: modeToFlashMode[mode] || 'KAT',
                        firmware_path: compileResult.firmware_path,
                        katapult_serial: updateSettings.katapult_serial
                    })
                });
                
                const flashResult = await flashResponse.json();
                
                if (flashResult.success) {
                    addBatchResult(config.name, 'success', '更新成功');
                } else {
                    addBatchResult(config.name, 'error', '烧录失败: ' + (flashResult.error || '未知错误'));
                }
            }
            
        } catch (error) {
            addBatchResult(config.name, 'error', error.message);
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
    const existingItem = resultsDiv.querySelector(`[data-name="${name}"]`);
    if (existingItem) {
        existingItem.className = 'update-result-item';
        existingItem.innerHTML = `
            <div class="update-result-status ${status}">
                ${status === 'success' ? '✓' : status === 'error' ? '✗' : status === 'running' ? '◐' : '○'}
            </div>
            <div class="info" style="flex:1;">
                <div style="font-weight:500;">${name}</div>
                <div style="font-size:13px;color:#6c757d;">${message}</div>
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
            <div style="font-weight:500;">${name}</div>
            <div style="font-size:13px;color:#6c757d;">${message}</div>
        </div>
    `;
    
    resultsDiv.insertBefore(item, resultsDiv.firstChild);
}

// 页面加载时初始化
document.addEventListener('DOMContentLoaded', () => {
    if (document.getElementById('page-firmware-update')) {
        initFirmwareUpdatePage();
    }
});
