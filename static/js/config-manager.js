// ==================== 配置管理页面 - 重构版 ====================

let klipperMcuDatabase = {};  // Klipper MCU 数据库
let currentMcuInfo = null;    // 当前选中的 MCU 信息
let currentConfig = null;     // 当前编辑的配置

// 初始化配置管理页面
async function initConfigPage() {
    console.log('初始化配置管理页面...');
    await loadKlipperMcuDatabase();
    await loadPresetManufacturers();
    setupEventListeners();
}

// 加载 Klipper MCU 数据库
async function loadKlipperMcuDatabase() {
    try {
        const response = await fetch('/api/klipper/platforms');
        const data = await response.json();
        
        if (data.success) {
            // 加载完整数据库
            const dbResponse = await fetch('/api/klipper/mcu-database');
            const dbData = await dbResponse.json();
            if (dbData.success) {
                klipperMcuDatabase = dbData.database;
                console.log('✓ Klipper MCU 数据库已加载:', Object.keys(klipperMcuDatabase));
            }
        }
    } catch (error) {
        console.error('加载 MCU 数据库失败:', error);
        showError('加载 MCU 数据库失败: ' + error.message);
    }
}

// 加载预设厂家列表
async function loadPresetManufacturers() {
    try {
        const response = await fetch('/api/config/manufacturers');
        const data = await response.json();
        
        const select = document.getElementById('presetManufacturer');
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

// 配置模式切换
function onConfigModeChange() {
    const mode = document.querySelector('input[name="configMode"]:checked').value;
    const presetSection = document.getElementById('presetModeSection');
    const customSection = document.getElementById('customModeSection');
    
    if (mode === 'preset') {
        presetSection.style.display = 'block';
        customSection.style.display = 'none';
    } else {
        presetSection.style.display = 'none';
        customSection.style.display = 'block';
        loadMcuPlatforms();
    }
    
    // 重置 MCU 详情
    document.getElementById('mcuDetailSection').style.display = 'none';
    currentMcuInfo = null;
}

// 加载 MCU 平台列表
function loadMcuPlatforms() {
    const select = document.getElementById('mcuPlatform');
    select.innerHTML = '<option value="">-- 选择平台 --</option>';
    
    for (const platform in klipperMcuDatabase) {
        select.innerHTML += `<option value="${platform}">${platform}</option>`;
    }
}

// MCU 平台选择变化
async function onMcuPlatformChange() {
    const platform = document.getElementById('mcuPlatform').value;
    const modelSelect = document.getElementById('mcuModelSelect');
    
    // 重置
    modelSelect.innerHTML = '<option value="">-- 选择型号 --</option>';
    modelSelect.disabled = true;
    document.getElementById('mcuDetailSection').style.display = 'none';
    currentMcuInfo = null;
    
    if (!platform || !klipperMcuDatabase[platform]) {
        return;
    }
    
    // 加载 MCU 型号列表
    const response = await fetch(`/api/klipper/mcus/${platform}`);
    const data = await response.json();
    
    if (data.success) {
        data.mcus.forEach(mcu => {
            modelSelect.innerHTML += `<option value="${mcu.id}">${mcu.name}</option>`;
        });
        modelSelect.disabled = false;
    }
}

// MCU 型号选择变化
async function onMcuModelChange() {
    const platform = document.getElementById('mcuPlatform').value;
    const mcuId = document.getElementById('mcuModelSelect').value;
    
    if (!mcuId) {
        document.getElementById('mcuDetailSection').style.display = 'none';
        return;
    }
    
    // 获取 MCU 详细信息
    const response = await fetch(`/api/klipper/mcu-info/${mcuId}`);
    const data = await response.json();
    
    if (data.success) {
        currentMcuInfo = data;
        displayMcuDetails(data);
    }
}

// 显示 MCU 详细信息
function displayMcuDetails(data) {
    const mcu = data.mcu;
    
    // 显示处理器型号
    document.getElementById('mcuKconfigName').value = mcu.id;
    
    // 填充晶振选项
    const crystalSelect = document.getElementById('crystalFreqSelect');
    crystalSelect.innerHTML = '';
    mcu.crystals.forEach(freq => {
        const label = formatFrequency(freq);
        crystalSelect.innerHTML += `<option value="${freq}">${label}</option>`;
    });
    
    // 填充 BL 偏移选项
    const blSelect = document.getElementById('blOffsetSelect');
    blSelect.innerHTML = '';
    mcu.bl_offsets.forEach(offset => {
        const label = formatBlOffset(offset);
        blSelect.innerHTML += `<option value="${offset}">${label}</option>`;
    });
    
    // 填充连接方式
    const connContainer = document.getElementById('connectionCheckboxes');
    connContainer.innerHTML = '';
    data.connections.forEach(conn => {
        connContainer.innerHTML += `
            <label class="checkbox-item">
                <input type="checkbox" name="connection" value="${conn.type}" checked>
                <span>${conn.name}</span>
            </label>
        `;
    });
    
    // 填充烧录方式
    const flashContainer = document.getElementById('flashModeCheckboxes');
    const defaultFlashSelect = document.getElementById('defaultFlashMode');
    flashContainer.innerHTML = '';
    defaultFlashSelect.innerHTML = '<option value="">-- 选择默认 --</option>';
    
    const flashModeLabels = {
        'DFU': 'USB/DFU',
        'KAT': 'USB/KAT (Katapult)',
        'CAN': 'CAN Bus',
        'CAN_BRIDGE_DFU': 'CAN Bridge/DFU',
        'CAN_BRIDGE_KAT': 'CAN Bridge/KAT',
        'UF2': 'UF2 (USB Mass Storage)'
    };
    
    data.flash_modes.forEach(mode => {
        const label = flashModeLabels[mode] || mode;
        flashContainer.innerHTML += `
            <label class="checkbox-item">
                <input type="checkbox" name="flashMode" value="${mode}" checked>
                <span>${label}</span>
            </label>
        `;
        defaultFlashSelect.innerHTML += `<option value="${mode}">${label}</option>`;
    });
    
    // 默认选中第一个
    if (data.flash_modes.length > 0) {
        defaultFlashSelect.value = data.flash_modes[0];
    }
    
    // 显示详情区域
    document.getElementById('mcuDetailSection').style.display = 'block';
}

// 预设厂家选择变化
async function onPresetManufacturerChange() {
    const manufacturer = document.getElementById('presetManufacturer').value;
    const typeSelect = document.getElementById('presetBoardType');
    const modelSelect = document.getElementById('presetBoardModel');
    
    typeSelect.innerHTML = '<option value="">-- 选择类型 --</option>';
    typeSelect.disabled = true;
    modelSelect.innerHTML = '<option value="">-- 先选择类型 --</option>';
    modelSelect.disabled = true;
    
    if (!manufacturer) return;
    
    // 加载该厂家的配置列表
    try {
        const response = await fetch(`/api/config/list/${manufacturer}`);
        const data = await response.json();
        
        if (data.configs) {
            // 提取类型
            const types = [...new Set(data.configs.map(c => c.type))];
            types.forEach(type => {
                const label = type === 'mainboard' ? '主板' : 
                             type === 'toolboard' ? '工具板' : '扩展板';
                typeSelect.innerHTML += `<option value="${type}">${label}</option>`;
            });
            typeSelect.disabled = false;
        }
    } catch (error) {
        console.error('加载配置列表失败:', error);
    }
}

// 预设类型选择变化
async function onPresetBoardTypeChange() {
    const manufacturer = document.getElementById('presetManufacturer').value;
    const type = document.getElementById('presetBoardType').value;
    const modelSelect = document.getElementById('presetBoardModel');
    
    modelSelect.innerHTML = '<option value="">-- 选择型号 --</option>';
    modelSelect.disabled = true;
    
    if (!type) return;
    
    try {
        const response = await fetch(`/api/config/list/${manufacturer}`);
        const data = await response.json();
        
        if (data.configs) {
            const configs = data.configs.filter(c => c.type === type);
            configs.forEach(config => {
                modelSelect.innerHTML += `<option value="${config.id}">${config.name}</option>`;
            });
            modelSelect.disabled = false;
        }
    } catch (error) {
        console.error('加载型号列表失败:', error);
    }
}

// 预设型号选择变化 - 加载配置到表单
async function onPresetBoardModelChange() {
    const manufacturer = document.getElementById('presetManufacturer').value;
    const configId = document.getElementById('presetBoardModel').value;
    
    if (!configId) return;
    
    try {
        const response = await fetch(`/api/config/get/${manufacturer}/${configId}`);
        const data = await response.json();
        
        if (data.config) {
            loadConfigToForm(data.config);
        }
    } catch (error) {
        console.error('加载配置失败:', error);
    }
}

// 加载配置到表单
function loadConfigToForm(config) {
    document.getElementById('configBoardName').value = config.name || '';
    document.getElementById('configProductType').value = config.type || 'mainboard';
    document.getElementById('configManufacturerInput').value = config.manufacturer || '';
    document.getElementById('bootPins').value = config.boot_pins || '';
    
    // 如果有 MCU 信息，加载详情
    if (config.mcu && config.platform) {
        // 切换到自定义模式并加载 MCU
        document.querySelector('input[name="configMode"][value="custom"]').checked = true;
        onConfigModeChange();
        
        document.getElementById('mcuPlatform').value = config.platform;
        onMcuPlatformChange().then(() => {
            document.getElementById('mcuModelSelect').value = config.mcu;
            onMcuModelChange().then(() => {
                // 设置保存的值
                if (config.crystal) {
                    document.getElementById('crystalFreqSelect').value = config.crystal;
                }
                if (config.bl_offset) {
                    document.getElementById('blOffsetSelect').value = config.bl_offset;
                }
                if (config.default_flash) {
                    document.getElementById('defaultFlashMode').value = config.default_flash;
                }
            });
        });
    }
    
    // 加载固件更新预设
    if (config.firmware_update && config.firmware_update.enabled) {
        document.getElementById('firmwareUpdateEnabled').value = 'true';
        onFirmwareUpdateEnabledChange();
        document.getElementById('katapultMode').value = config.firmware_update.katapult_mode || 'USB';
        document.getElementById('deviceId').value = config.firmware_update.device_id || '';
        document.getElementById('updateFlashMode').value = config.firmware_update.flash_mode || 'KAT';
        document.getElementById('customCompileParams').value = config.firmware_update.custom_config || '';
    }
    
    currentConfig = config;
}

// 折叠/展开固件更新选项
function toggleFirmwareUpdateSection() {
    const section = document.getElementById('firmwareUpdateSection');
    const toggle = document.getElementById('firmwareUpdateToggle');
    
    if (section.style.display === 'none') {
        section.style.display = 'block';
        toggle.textContent = '▲';
    } else {
        section.style.display = 'none';
        toggle.textContent = '▼';
    }
}

// 固件更新启用切换
function onFirmwareUpdateEnabledChange() {
    const enabled = document.getElementById('firmwareUpdateEnabled').value === 'true';
    document.getElementById('firmwareUpdateOptions').style.display = enabled ? 'block' : 'none';
}

// 保存配置
async function saveConfig() {
    const configData = collectFormData();
    
    if (!configData.name) {
        showError('请输入产品名称');
        return;
    }
    
    if (!configData.mcu) {
        showError('请选择 MCU');
        return;
    }
    
    try {
        const manufacturer = configData.manufacturer || 'Custom';
        const url = currentConfig 
            ? `/api/config/update/${manufacturer}/${currentConfig.id}`
            : `/api/config/create/${manufacturer}`;
        
        const method = currentConfig ? 'PUT' : 'POST';
        
        const response = await fetch(url, {
            method: method,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(configData)
        });
        
        const result = await response.json();
        
        if (result.success) {
            showSuccess(currentConfig ? '配置更新成功！' : '配置创建成功！');
            resetConfigForm();
            loadConfigList();
        } else {
            showError(result.error || '保存失败');
        }
    } catch (error) {
        console.error('保存配置失败:', error);
        showError('保存配置失败: ' + error.message);
    }
}

// 收集表单数据
function collectFormData() {
    const flashModes = Array.from(document.querySelectorAll('input[name="flashMode"]:checked')).map(cb => cb.value);
    const connections = Array.from(document.querySelectorAll('input[name="connection"]:checked')).map(cb => cb.value);
    
    return {
        name: document.getElementById('configBoardName').value.trim(),
        type: document.getElementById('configProductType').value,
        manufacturer: document.getElementById('configManufacturerInput').value.trim(),
        mcu: currentMcuInfo ? currentMcuInfo.mcu.id : '',
        platform: currentMcuInfo ? currentMcuInfo.platform : '',
        crystal: document.getElementById('crystalFreqSelect').value,
        bl_offset: document.getElementById('blOffsetSelect').value,
        boot_pins: document.getElementById('bootPins').value.trim(),
        connections: connections,
        flash_modes: flashModes,
        default_flash: document.getElementById('defaultFlashMode').value,
        firmware_update: {
            enabled: document.getElementById('firmwareUpdateEnabled').value === 'true',
            katapult_mode: document.getElementById('katapultMode').value,
            device_id: document.getElementById('deviceId').value.trim(),
            flash_mode: document.getElementById('updateFlashMode').value,
            custom_config: document.getElementById('customCompileParams').value.trim()
        }
    };
}

// 预览 JSON
function previewConfigJson() {
    const data = collectFormData();
    const jsonStr = JSON.stringify(data, null, 2);
    
    // 创建弹窗显示
    const modal = document.createElement('div');
    modal.className = 'json-preview-modal';
    modal.innerHTML = `
        <div class="json-preview-content">
            <h3>配置 JSON 预览</h3>
            <pre>${jsonStr}</pre>
            <button class="btn btn-primary" onclick="this.closest('.json-preview-modal').remove()">关闭</button>
        </div>
    `;
    document.body.appendChild(modal);
}

// 重置表单
function resetConfigForm() {
    document.getElementById('configBoardName').value = '';
    document.getElementById('configProductType').value = 'mainboard';
    document.getElementById('configManufacturerInput').value = '';
    document.getElementById('bootPins').value = '';
    
    // 重置模式选择
    document.querySelector('input[name="configMode"][value="preset"]').checked = true;
    onConfigModeChange();
    
    // 重置预设选择
    document.getElementById('presetManufacturer').value = '';
    document.getElementById('presetBoardType').innerHTML = '<option value="">-- 先选择厂家 --</option>';
    document.getElementById('presetBoardType').disabled = true;
    document.getElementById('presetBoardModel').innerHTML = '<option value="">-- 先选择类型 --</option>';
    document.getElementById('presetBoardModel').disabled = true;
    
    // 重置 MCU 选择
    document.getElementById('mcuPlatform').value = '';
    document.getElementById('mcuModelSelect').innerHTML = '<option value="">-- 先选择平台 --</option>';
    document.getElementById('mcuModelSelect').disabled = true;
    
    // 隐藏详情
    document.getElementById('mcuDetailSection').style.display = 'none';
    
    // 重置固件更新
    document.getElementById('firmwareUpdateEnabled').value = 'false';
    onFirmwareUpdateEnabledChange();
    document.getElementById('deviceId').value = '';
    document.getElementById('customCompileParams').value = '';
    
    currentConfig = null;
    currentMcuInfo = null;
}

// 格式化频率显示
function formatFrequency(freq) {
    const freqNum = parseInt(freq);
    if (freqNum >= 1000000) {
        return (freqNum / 1000000) + ' MHz';
    } else if (freqNum >= 1000) {
        return (freqNum / 1000) + ' KHz';
    }
    return freq + ' Hz';
}

// 格式化 BL 偏移显示
function formatBlOffset(offset, mcuId) {
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

// 设置事件监听
function setupEventListeners() {
    // 文件上传拖拽
    const uploadArea = document.getElementById('uploadArea');
    if (uploadArea) {
        uploadArea.addEventListener('click', () => {
            document.getElementById('folderInput').click();
        });
    }
}

// 页面加载时初始化
document.addEventListener('DOMContentLoaded', () => {
    if (document.getElementById('page-config')) {
        initConfigPage();
    }
});


// 加载配置列表
async function loadConfigList() {
    const manufacturer = document.getElementById('configManufacturer')?.value || 'FLY';
    const listDiv = document.getElementById('configList');
    
    if (!listDiv) return;
    
    try {
        const response = await fetch(`/api/config/list/${manufacturer}`);
        const data = await response.json();
        
        if (data.configs && data.configs.length > 0) {
            let html = '';
            data.configs.forEach(config => {
                const typeLabel = config.type === 'mainboard' ? '主板' : 
                                 config.type === 'toolboard' ? '工具板' : '扩展板';
                const hasUpdate = config.firmware_update && config.firmware_update.enabled ? '🔄' : '';
                
                html += `
                    <div class="config-item">
                        <div class="config-item-info">
                            <div class="config-item-name">${config.name} ${hasUpdate}</div>
                            <div class="config-item-details">
                                ${typeLabel} | ${config.mcu} | ${config.manufacturer}
                            </div>
                        </div>
                        <div class="config-item-actions">
                            <button class="btn btn-sm btn-primary" onclick="editConfig('${config.manufacturer}', '${config.id}')">编辑</button>
                            <button class="btn btn-sm btn-danger" onclick="deleteConfig('${config.manufacturer}', '${config.id}')">删除</button>
                        </div>
                    </div>
                `;
            });
            listDiv.innerHTML = html;
        } else {
            listDiv.innerHTML = '<p class="empty">暂无配置，请添加新配置</p>';
        }
    } catch (error) {
        console.error('加载配置列表失败:', error);
        listDiv.innerHTML = '<p class="empty">加载失败</p>';
    }
}

// 编辑配置
async function editConfig(manufacturer, configId) {
    try {
        const response = await fetch(`/api/config/get/${manufacturer}/${configId}`);
        const data = await response.json();
        
        if (data.config) {
            loadConfigToForm(data.config);
            // 滚动到表单
            document.querySelector('.card').scrollIntoView({ behavior: 'smooth' });
        }
    } catch (error) {
        console.error('加载配置失败:', error);
        showError('加载配置失败');
    }
}

// 删除配置
async function deleteConfig(manufacturer, configId) {
    if (!confirm('确定要删除这个配置吗？')) {
        return;
    }
    
    try {
        const response = await fetch(`/api/config/delete/${manufacturer}/${configId}`, {
            method: 'DELETE'
        });
        
        const result = await response.json();
        
        if (result.success) {
            showSuccess('配置已删除');
            loadConfigList();
        } else {
            showError(result.error || '删除失败');
        }
    } catch (error) {
        console.error('删除配置失败:', error);
        showError('删除失败');
    }
}

