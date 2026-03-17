// ==================== 配置管理页面 - 重构版 ====================

let klipperMcuDatabase = {};  // Klipper MCU 数据库
let configManagerMcuInfo = null;    // 当前选中的 MCU 信息（配置管理专用）
let currentConfig = null;     // 当前编辑的配置

// 初始化配置管理页面
async function initConfigPage() {
    console.log('初始化配置管理页面...');
    await loadKlipperMcuDatabase();
    loadMcuPlatforms(); // 加载MCU平台列表到主表单
    await refreshManufacturerList(); // 加载厂家列表到datalist
    setupEventListeners();
}

// 刷新厂家列表（用于datalist）
async function refreshManufacturerList() {
    try {
        const response = await fetch('/api/config/manufacturers');
        const data = await response.json();
        
        const datalist = document.getElementById('manufacturerList');
        datalist.innerHTML = '';
        
        if (data.manufacturers) {
            data.manufacturers.forEach(mfr => {
                datalist.innerHTML += `<option value="${mfr}">`;
            });
        }
        console.log('✓ 厂家列表已刷新');
    } catch (error) {
        console.error('刷新厂家列表失败:', error);
    }
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

// ==================== 预设选择弹窗功能 ====================

// 打开预设选择弹窗
async function openPresetSelector() {
    document.getElementById('presetSelectorModal').style.display = 'flex';
    await loadModalPresetManufacturers();
}

// 关闭预设选择弹窗
function closePresetSelector() {
    document.getElementById('presetSelectorModal').style.display = 'none';
}

// 加载弹窗中的预设厂家列表
async function loadModalPresetManufacturers() {
    try {
        const response = await fetch('/api/config/manufacturers');
        const data = await response.json();
        
        const select = document.getElementById('modalPresetManufacturer');
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

// 弹窗中厂家选择变化
async function onModalPresetManufacturerChange() {
    const manufacturer = document.getElementById('modalPresetManufacturer').value;
    const typeSelect = document.getElementById('modalPresetBoardType');
    const modelSelect = document.getElementById('modalPresetBoardModel');
    
    typeSelect.innerHTML = '<option value="">-- 选择类型 --</option>';
    typeSelect.disabled = true;
    modelSelect.innerHTML = '<option value="">-- 先选择类型 --</option>';
    modelSelect.disabled = true;
    
    if (!manufacturer) return;
    
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

// 弹窗中类型选择变化
async function onModalPresetBoardTypeChange() {
    const manufacturer = document.getElementById('modalPresetManufacturer').value;
    const type = document.getElementById('modalPresetBoardType').value;
    const modelSelect = document.getElementById('modalPresetBoardModel');
    
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

// 从弹窗加载预设到表单
async function loadPresetToForm() {
    const manufacturer = document.getElementById('modalPresetManufacturer').value;
    const configId = document.getElementById('modalPresetBoardModel').value;
    
    if (!manufacturer || !configId) {
        showError('请选择厂家和型号');
        return;
    }
    
    try {
        const response = await fetch(`/api/config/get/${manufacturer}/${configId}`);
        const config = await response.json();
        
        if (config && !config.error) {
            loadConfigToForm(config);
            closePresetSelector();
            showSuccess('预设配置已加载到表单，您可以修改后保存');
        } else {
            showError('加载配置失败');
        }
    } catch (error) {
        console.error('加载配置失败:', error);
        showError('加载配置失败: ' + error.message);
    }
}

// 加载预设厂家列表（保留用于兼容性）
async function loadPresetManufacturers() {
    try {
        const response = await fetch('/api/config/manufacturers');
        const data = await response.json();
        
        const select = document.getElementById('presetManufacturer');
        if (!select) return;
        
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

// 加载 MCU 平台列表
function loadMcuPlatforms() {
    const select = document.getElementById('mcuPlatform');
    if (!select) return;
    
    select.innerHTML = '<option value="">-- 选择平台 --</option>';
    
    for (const platform in klipperMcuDatabase) {
        select.innerHTML += `<option value="${platform}">${platform}</option>`;
    }
}

// MCU 平台选择变化
async function onMcuPlatformChange() {
    const platformEl = document.getElementById('mcuPlatform');
    const modelSelect = document.getElementById('mcuModelSelect');
    const mcuDetailEl = document.getElementById('mcuDetailSection');
    
    if (!platformEl || !modelSelect) return;
    
    const platform = platformEl.value;
    
    // 重置
    modelSelect.innerHTML = '<option value="">-- 选择型号 --</option>';
    modelSelect.disabled = true;
    if (mcuDetailEl) mcuDetailEl.style.display = 'none';
    configManagerMcuInfo = null;
    
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
    const platformEl = document.getElementById('mcuPlatform');
    const mcuModelEl = document.getElementById('mcuModelSelect');
    const mcuDetailEl = document.getElementById('mcuDetailSection');
    
    if (!mcuModelEl) return;
    
    const mcuId = mcuModelEl.value;
    
    if (!mcuId) {
        if (mcuDetailEl) mcuDetailEl.style.display = 'none';
        return;
    }
    
    // 获取 MCU 详细信息
    const response = await fetch(`/api/klipper/mcu-info/${mcuId}`);
    const data = await response.json();
    
    if (data.success) {
        configManagerMcuInfo = data;
        displayMcuDetails(data);
    }
}

// 显示 MCU 详细信息
function displayMcuDetails(data) {
    const mcu = data.mcu;
    
    // 获取元素
    const mcuKconfigEl = document.getElementById('mcuKconfigName');
    const crystalSelect = document.getElementById('crystalFreqSelect');
    const blSelect = document.getElementById('blOffsetSelect');
    const connContainer = document.getElementById('connectionCheckboxes');
    const flashContainer = document.getElementById('flashModeCheckboxes');
    const defaultFlashSelect = document.getElementById('defaultFlashMode');
    const mcuDetailEl = document.getElementById('mcuDetailSection');
    
    // 显示处理器型号
    if (mcuKconfigEl) mcuKconfigEl.value = mcu.id;
    
    // 填充晶振选项
    if (crystalSelect) {
        crystalSelect.innerHTML = '';
        mcu.crystals.forEach(freq => {
            const label = formatFrequency(freq);
            crystalSelect.innerHTML += `<option value="${freq}">${label}</option>`;
        });
    }
    
    // 填充 BL 偏移选项
    if (blSelect) {
        blSelect.innerHTML = '';
        mcu.bl_offsets.forEach(offset => {
            const label = formatBlOffset(offset);
            blSelect.innerHTML += `<option value="${offset}">${label}</option>`;
        });
    }
    
    // 填充连接方式（默认不选中）
    if (connContainer) {
        connContainer.innerHTML = '';
        data.connections.forEach(conn => {
            connContainer.innerHTML += `
                <label class="checkbox-item">
                    <input type="checkbox" name="connection" value="${conn.type}">
                    <span>${conn.name}</span>
                </label>
            `;
        });
    }
    
    // 填充烧录方式（默认不选中）
    if (flashContainer && defaultFlashSelect) {
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
                    <input type="checkbox" name="flashMode" value="${mode}">
                    <span>${label}</span>
                </label>
            `;
            defaultFlashSelect.innerHTML += `<option value="${mode}">${label}</option>`;
        });
    }
    
    // 显示详情区域
    if (mcuDetailEl) mcuDetailEl.style.display = 'block';
}

// 加载配置到表单
function loadConfigToForm(config) {
    // 基本信息
    const boardNameEl = document.getElementById('configBoardName');
    const productTypeEl = document.getElementById('configProductType');
    const manufacturerEl = document.getElementById('configManufacturerInput');
    const bootPinsEl = document.getElementById('bootPins');
    
    if (boardNameEl) boardNameEl.value = config.name || '';
    if (productTypeEl) productTypeEl.value = config.type || 'mainboard';
    if (manufacturerEl) manufacturerEl.value = config.manufacturer || '';
    if (bootPinsEl) bootPinsEl.value = config.boot_pins || '';
    
    // 如果有 MCU 信息，加载详情
    if (config.mcu && config.platform) {
        const mcuPlatformEl = document.getElementById('mcuPlatform');
        if (mcuPlatformEl) {
            mcuPlatformEl.value = config.platform;
            onMcuPlatformChange().then(() => {
                const mcuModelEl = document.getElementById('mcuModelSelect');
                if (mcuModelEl) {
                    mcuModelEl.value = config.mcu;
                    onMcuModelChange().then(() => {
                        // 设置保存的值
                        const crystalEl = document.getElementById('crystalFreqSelect');
                        const blOffsetEl = document.getElementById('blOffsetSelect');
                        const defaultFlashEl = document.getElementById('defaultFlashMode');
                        
                        if (crystalEl && config.crystal) {
                            crystalEl.value = config.crystal;
                        }
                        if (blOffsetEl && config.bl_offset) {
                            blOffsetEl.value = config.bl_offset;
                        }
                        if (defaultFlashEl && config.default_flash) {
                            defaultFlashEl.value = config.default_flash;
                        }
                    });
                }
            });
        }
    }
    
    // 加载固件更新预设（如果存在这些元素）
    const fwUpdateEnabledEl = document.getElementById('firmwareUpdateEnabled');
    if (fwUpdateEnabledEl && config.firmware_update && config.firmware_update.enabled) {
        fwUpdateEnabledEl.value = 'true';
        onFirmwareUpdateEnabledChange();
        
        const katapultModeEl = document.getElementById('katapultMode');
        const deviceIdEl = document.getElementById('deviceId');
        const updateFlashModeEl = document.getElementById('updateFlashMode');
        const customParamsEl = document.getElementById('customCompileParams');
        
        if (katapultModeEl) katapultModeEl.value = config.firmware_update.katapult_mode || 'USB';
        if (deviceIdEl) deviceIdEl.value = config.firmware_update.device_id || '';
        if (updateFlashModeEl) updateFlashModeEl.value = config.firmware_update.flash_mode || 'KAT';
        if (customParamsEl) customParamsEl.value = config.firmware_update.custom_config || '';
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
        
        // 判断是否是修改预设配置
        // 如果是预设配置，创建新的用户配置（不修改预设）
        // 如果是用户配置，更新现有配置
        const isPreset = currentConfig && currentConfig.is_preset === true;
        const isUserConfig = currentConfig && !currentConfig.is_preset;
        
        let url, method, successMsg;
        
        if (isUserConfig) {
            // 更新现有用户配置
            url = `/api/config/update/${manufacturer}/${currentConfig.id}`;
            method = 'PUT';
            successMsg = '配置更新成功！';
        } else {
            // 创建新配置（新配置或基于预设创建）
            url = `/api/config/create/${manufacturer}`;
            method = 'POST';
            successMsg = isPreset ? '基于预设创建新配置成功！' : '配置创建成功！';
        }
        
        const response = await fetch(url, {
            method: method,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(configData)
        });
        
        const result = await response.json();
        
        if (result.success) {
            showSuccess(successMsg);
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
    
    // 安全获取元素值
    const getValue = (id) => {
        const el = document.getElementById(id);
        return el ? el.value : '';
    };
    
    const getTrimmedValue = (id) => {
        const el = document.getElementById(id);
        return el ? el.value.trim() : '';
    };
    
    return {
        name: getTrimmedValue('configBoardName'),
        type: getValue('configProductType') || 'mainboard',
        manufacturer: getTrimmedValue('configManufacturerInput'),
        mcu: configManagerMcuInfo ? configManagerMcuInfo.mcu.id : '',
        platform: configManagerMcuInfo ? configManagerMcuInfo.platform : '',
        crystal: getValue('crystalFreqSelect'),
        bl_offset: getValue('blOffsetSelect'),
        boot_pins: getTrimmedValue('bootPins'),
        connections: connections,
        flash_modes: flashModes,
        default_flash: getValue('defaultFlashMode'),
        firmware_update: {
            enabled: getValue('firmwareUpdateEnabled') === 'true',
            katapult_mode: getValue('katapultMode') || 'USB',
            device_id: getTrimmedValue('deviceId'),
            flash_mode: getValue('updateFlashMode') || 'KAT',
            custom_config: getTrimmedValue('customCompileParams')
        }
    };
}

// 预览 JSON（表格形式）
function previewConfigJson() {
    const data = collectFormData();
    
    // 创建表格HTML
    let tableHtml = `
        <table class="config-preview-table" style="width:100%;border-collapse:collapse;margin-bottom:15px;">
            <thead>
                <tr style="background:#f8f9fa;">
                    <th style="padding:10px;border:1px solid #dee2e6;text-align:left;width:30%;">字段</th>
                    <th style="padding:10px;border:1px solid #dee2e6;text-align:left;width:70%;">值</th>
                </tr>
            </thead>
            <tbody>
    `;
    
    // 字段中文映射
    const fieldLabels = {
        'id': '配置ID',
        'name': '产品名称',
        'type': '产品类型',
        'manufacturer': '厂家',
        'platform': 'MCU平台',
        'mcu': 'MCU型号',
        'crystal': '晶振频率',
        'bl_offset': 'BL偏移',
        'boot_pins': '启动引脚',
        'communication': '连接方式',
        'flash_modes': '支持的烧录方式',
        'default_flash': '默认烧录方式'
    };
    
    // 类型映射
    const typeLabels = {
        'mainboard': '主板',
        'toolboard': '工具板',
        'expansion': '扩展板'
    };
    
    // 添加基本字段
    for (const [key, label] of Object.entries(fieldLabels)) {
        if (data[key] !== undefined) {
            let value = data[key];
            
            // 特殊处理
            if (key === 'type' && typeLabels[value]) {
                value = typeLabels[value];
            } else if (Array.isArray(value)) {
                value = value.join(', ');
            }
            
            tableHtml += `
                <tr>
                    <td style="padding:10px;border:1px solid #dee2e6;font-weight:500;">${label}</td>
                    <td style="padding:10px;border:1px solid #dee2e6;">${value || '-'}</td>
                </tr>
            `;
        }
    }
    
    tableHtml += '</tbody></table>';
    
    // 创建弹窗显示 - 更大尺寸
    const modal = document.createElement('div');
    modal.className = 'json-preview-modal';
    modal.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;z-index:1000;';
    modal.innerHTML = `
        <div class="json-preview-content" style="background:white;padding:30px;border-radius:12px;width:90%;max-width:900px;max-height:85vh;overflow:auto;box-shadow:0 8px 32px rgba(0,0,0,0.2);">
            <h3 style="margin-top:0;margin-bottom:20px;font-size:1.5rem;">📋 配置预览</h3>
            <div style="font-size:1.1rem;">${tableHtml}</div>
            <details style="margin:20px 0;">
                <summary style="cursor:pointer;color:#6c757d;font-size:1rem;padding:10px 0;">查看原始 JSON</summary>
                <pre style="background:#f8f9fa;padding:15px;border-radius:8px;margin-top:10px;font-size:14px;overflow-x:auto;max-height:300px;">${JSON.stringify(data, null, 2)}</pre>
            </details>
            <div style="text-align:center;margin-top:20px;">
                <button class="btn btn-primary" style="padding:10px 30px;font-size:1.1rem;" onclick="this.closest('.json-preview-modal').remove()">关闭</button>
            </div>
        </div>
    `;
    
    // 点击背景关闭
    modal.addEventListener('click', (e) => {
        if (e.target === modal) modal.remove();
    });
    
    document.body.appendChild(modal);
}

// 重置表单
function resetConfigForm() {
    // 重置基本信息
    const boardNameEl = document.getElementById('configBoardName');
    const productTypeEl = document.getElementById('configProductType');
    const manufacturerEl = document.getElementById('configManufacturerInput');
    const bootPinsEl = document.getElementById('bootPins');
    
    if (boardNameEl) boardNameEl.value = '';
    if (productTypeEl) productTypeEl.value = 'mainboard';
    if (manufacturerEl) manufacturerEl.value = '';
    if (bootPinsEl) bootPinsEl.value = '';
    
    // 重置 MCU 选择
    const mcuPlatformEl = document.getElementById('mcuPlatform');
    const mcuModelEl = document.getElementById('mcuModelSelect');
    const mcuDetailEl = document.getElementById('mcuDetailSection');
    
    if (mcuPlatformEl) mcuPlatformEl.value = '';
    if (mcuModelEl) {
        mcuModelEl.innerHTML = '<option value="">-- 先选择平台 --</option>';
        mcuModelEl.disabled = true;
    }
    if (mcuDetailEl) mcuDetailEl.style.display = 'none';
    
    // 重置固件更新（如果元素存在）
    const fwUpdateEnabledEl = document.getElementById('firmwareUpdateEnabled');
    const deviceIdEl = document.getElementById('deviceId');
    const customParamsEl = document.getElementById('customCompileParams');
    
    if (fwUpdateEnabledEl) {
        fwUpdateEnabledEl.value = 'false';
        onFirmwareUpdateEnabledChange();
    }
    if (deviceIdEl) deviceIdEl.value = '';
    if (customParamsEl) customParamsEl.value = '';
    
    currentConfig = null;
    configManagerMcuInfo = null;
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
        
        if (data && !data.error) {
            // API直接返回config对象
            loadConfigToForm(data);
            // 切换到配置管理页面的编辑表单区域
            const editCard = document.querySelector('#page-config .card:nth-child(3)');
            if (editCard) {
                editCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }
            showSuccess('配置已加载到表单，请修改后保存');
        } else {
            showError('加载配置失败: ' + (data.error || '未知错误'));
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

