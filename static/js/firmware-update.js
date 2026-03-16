// ==================== 固件批量更新页面 - 重构版 ====================

let updateableConfigs = [];  // 可更新的配置列表
let selectedUpdateConfigs = new Set(); // 选中的配置 ID

// 初始化固件更新页面
async function initFirmwareUpdatePage() {
    console.log('初始化固件更新页面...');
    await loadUpdateableConfigs();
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
        listDiv.innerHTML = '<p class="empty">暂无配置</p>';
        return;
    }
    
    let html = '';
    updateableConfigs.forEach(config => {
        const isSelected = selectedUpdateConfigs.has(config.id);
        const updateEnabled = config.firmware_update?.enabled || false;
        const deviceId = config.firmware_update?.device_id || '';
        
        html += `
            <div class="config-card ${isSelected ? 'selected' : ''}" data-id="${config.id}">
                <input type="checkbox" ${isSelected ? 'checked' : ''} 
                       onchange="toggleUpdateSelection('${config.id}')">
                <div class="info">
                    <div class="name">${config.name}</div>
                    <div class="details">
                        ${config.platform} ${config.mcu} | 
                        ${config.type === 'mainboard' ? '主板' : 
                          config.type === 'toolboard' ? '工具板' : '扩展板'}
                        ${deviceId ? '| ID: ' + deviceId : ''}
                    </div>
                </div>
                <div class="status">
                    <span class="status-badge ${updateEnabled ? 'enabled' : 'disabled'}">
                        ${updateEnabled ? '已启用' : '未启用'}
                    </span>
                    <button class="btn btn-sm btn-secondary" onclick="openUpdateSettings('${config.id}')">
                        ⚙️ 设置
                    </button>
                </div>
            </div>
        `;
    });
    
    listDiv.innerHTML = html;
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

// 打开更新设置弹窗
function openUpdateSettings(configId) {
    const config = updateableConfigs.find(c => c.id === configId);
    if (!config) return;
    
    const updateSettings = config.firmware_update || {
        enabled: false,
        katapult_mode: 'USB',
        device_id: '',
        flash_mode: config.default_flash || 'KAT',
        custom_config: ''
    };
    
    document.getElementById('updateSettingConfigId').value = configId;
    document.getElementById('updateSettingEnabled').value = updateSettings.enabled.toString();
    document.getElementById('updateSettingKatMode').value = updateSettings.katapult_mode;
    document.getElementById('updateSettingDeviceId').value = updateSettings.device_id;
    document.getElementById('updateSettingFlashMode').value = updateSettings.flash_mode;
    document.getElementById('updateSettingCustomConfig').value = updateSettings.custom_config || '';
    
    // 根据启用状态显示/隐藏选项
    toggleUpdateSettingOptions();
    
    document.getElementById('updateSettingsModal').style.display = 'flex';
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
    const config = updateableConfigs.find(c => c.id === configId);
    if (!config) return;
    
    const updateSettings = {
        enabled: document.getElementById('updateSettingEnabled').value === 'true',
        katapult_mode: document.getElementById('updateSettingKatMode').value,
        device_id: document.getElementById('updateSettingDeviceId').value,
        flash_mode: document.getElementById('updateSettingFlashMode').value,
        custom_config: document.getElementById('updateSettingCustomConfig').value
    };
    
    // 更新配置对象
    config.firmware_update = updateSettings;
    
    try {
        const response = await fetch('/api/config/save', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(config)
        });
        
        const result = await response.json();
        
        if (result.success) {
            showSuccess('设置已保存');
            closeUpdateSettingsModal();
            renderUpdateableConfigs(); // 刷新列表
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
        
        updateBatchStatus(`正在更新: ${config.name}...`);
        addBatchResult(config.name, 'running', '更新中...');
        
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
            
            // 2. 再烧录
            const flashResponse = await fetch('/api/firmware/flash', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    device_id: updateSettings.device_id,
                    flash_mode: updateSettings.flash_mode,
                    firmware_path: compileResult.firmware_path
                })
            });
            
            const flashResult = await flashResponse.json();
            
            if (flashResult.success) {
                addBatchResult(config.name, 'success', '更新成功');
            } else {
                addBatchResult(config.name, 'error', '烧录失败: ' + (flashResult.error || '未知错误'));
            }
            
        } catch (error) {
            addBatchResult(config.name, 'error', error.message);
        }
        
        completed++;
        updateBatchProgress(completed, total);
    }
    
    updateBatchStatus('更新完成');
    setTimeout(hideBatchProgress, 3000);
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
