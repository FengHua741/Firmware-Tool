// ==================== 配置管理 - Fluidd 风格文件浏览器 + 编辑器 ====================

let configTreeData = [];       // 文件树数据
let configTreeExpanded = new Set(['root']); // 展开状态的节点
let currentConfigFile = null;  // 当前选中的配置文件 {manufacturer, type, id, data}
let currentTreeContext = { manufacturer: null, boardType: null }; // 当前树上下文（用于新建配置）
let currentEditorMode = 'form'; // 'form' | 'json'
let klipperMcuDatabase = {};   // MCU 数据库
let configManagerMcuInfo = null; // 当前MCU信息
let treeSearchQuery = '';      // 文件树搜索关键词

// 类型标签映射
const TYPE_LABELS = {
    mainboard: '主板',
    toolboard: '工具板',
    expansion: '扩展板'
};

const FLASH_MODE_LABELS = {
    DFU: 'USB/DFU',
    KAT: 'USB/KAT (Katapult)',
    CAN: 'CAN Bus',
    CAN_BRIDGE_DFU: 'CAN Bridge/DFU',
    CAN_BRIDGE_KAT: 'CAN Bridge/KAT',
    UF2: 'UF2 (USB Mass Storage)',
    TF: 'TF卡烧录',
    HOST: 'HOST (上位机烧录)'
};

// ==================== 初始化 ====================

function initConfigManager() {
    console.log('[ConfigManager] 初始化...');
    loadKlipperMcuDatabase().then(() => {
        refreshConfigTree();
    });
    setupConfigManagerListeners();
}

async function loadKlipperMcuDatabase() {
    try {
        const res = await fetch('/api/klipper/platforms');
        const data = await res.json();
        if (data.success) {
            const dbRes = await fetch('/api/klipper/mcu-database');
            const dbData = await dbRes.json();
            if (dbData.success) klipperMcuDatabase = dbData.database;
        }
    } catch (e) {
        console.error('加载 MCU 数据库失败:', e);
    }
}

function setupConfigManagerListeners() {
    // JSON 编辑器实时同步到表单（延迟500ms避免频繁刷新）
    const jsonEditor = document.getElementById('cmJsonEditor');
    if (jsonEditor) {
        let timeout;
        jsonEditor.addEventListener('input', () => {
            clearTimeout(timeout);
            timeout = setTimeout(() => {
                syncJsonToForm();
            }, 500);
        });
    }
}

// ==================== 文件树 ====================

async function refreshConfigTree() {
    const treeEl = document.getElementById('configFileTree');
    if (!treeEl) return;
    treeEl.innerHTML = '<div class="cm-tree-loading">加载中...</div>';

    try {
        const manufacturersRes = await fetch('/api/config/manufacturers');
        const manufacturersData = await manufacturersRes.json();
        const manufacturers = manufacturersData.manufacturers || [];

        configTreeData = [];

        for (const mfr of manufacturers) {
            const listRes = await fetch(`/api/config/list/${mfr}`);
            const listData = await listRes.json();
            const configs = listData.configs || [];
            const boardTypes = listData.board_types || [];

            // 按类型分组
            const types = {};
            configs.forEach(cfg => {
                const t = cfg.type || 'mainboard';
                if (!types[t]) types[t] = [];
                types[t].push(cfg);
            });

            // 确保所有存在的board_type目录都显示（包括空的）
            boardTypes.forEach(type => {
                if (!types[type]) types[type] = [];
            });

            const typeNodes = Object.keys(types).map(type => ({
                id: `${mfr}/${type}`,
                name: TYPE_LABELS[type] || type,
                type: 'folder',
                children: types[type].map(cfg => ({
                    id: `${mfr}/${type}/${cfg.id}`,
                    name: cfg.name || cfg.id,
                    type: 'file',
                    manufacturer: mfr,
                    boardType: type,
                    configId: cfg.id,
                    data: cfg
                }))
            }));

            configTreeData.push({
                id: mfr,
                name: mfr,
                type: 'folder',
                children: typeNodes
            });
        }

        renderConfigTree();
    } catch (e) {
        console.error('加载配置树失败:', e);
        treeEl.innerHTML = '<div class="cm-tree-empty">加载失败</div>';
    }
}

function renderConfigTree() {
    const treeEl = document.getElementById('configFileTree');
    if (!treeEl) return;

    // 如果有搜索词，计算可见节点并强制展开包含匹配项的父级
    let visibleIds = null;
    let forceExpanded = null;
    if (treeSearchQuery.trim()) {
        const result = computeTreeVisibility(configTreeData, treeSearchQuery.trim().toLowerCase());
        visibleIds = result.visibleIds;
        forceExpanded = result.forceExpanded;
    }

    let html = '<div class="cm-tree">';

    // 根节点
    html += renderTreeNode({
        id: 'root',
        name: '配置库',
        type: 'root',
        children: configTreeData
    }, 0, visibleIds, forceExpanded);

    html += '</div>';
    treeEl.innerHTML = html;
}

function computeTreeVisibility(nodes, query) {
    const visibleIds = new Set();
    const forceExpanded = new Set();

    function checkNode(node) {
        let hasVisibleChild = false;
        if (node.children) {
            for (const child of node.children) {
                if (checkNode(child)) {
                    hasVisibleChild = true;
                }
            }
        }

        if (node.type === 'file') {
            const name = (node.name || '').toLowerCase();
            if (name.includes(query)) {
                visibleIds.add(node.id);
                return true;
            }
            return false;
        } else {
            // folder: visible if any child is visible
            if (hasVisibleChild) {
                visibleIds.add(node.id);
                forceExpanded.add(node.id);
                return true;
            }
            // Also visible if folder name matches
            const name = (node.name || '').toLowerCase();
            if (name.includes(query)) {
                visibleIds.add(node.id);
                return true;
            }
            return false;
        }
    }

    for (const node of nodes) {
        checkNode(node);
    }

    return { visibleIds, forceExpanded };
}

function renderTreeNode(node, depth, visibleIds, forceExpanded) {
    const isExpanded = forceExpanded && forceExpanded.has(node.id) ? true : configTreeExpanded.has(node.id);
    const isSelected = currentConfigFile && currentConfigFile.nodeId === node.id;
    const indent = depth * 16;

    // 搜索过滤：文件节点和文件夹节点都检查是否在可见集合中（根节点除外）
    if (visibleIds && node.id !== 'root' && !visibleIds.has(node.id)) {
        return '';
    }

    let html = '';

    if (node.type === 'file') {
        // 文件节点
        html += `
            <div class="cm-tree-item ${isSelected ? 'selected' : ''}"
                 style="padding-left:${indent + 12}px"
                 onclick="selectConfigFile('${node.manufacturer}', '${node.boardType}', '${node.configId}', '${node.id}')"
                 title="${escapeHtml(node.name)}">
                <span class="cm-tree-icon">📄</span>
                <span class="cm-tree-label">${escapeHtml(node.name)}</span>
            </div>
        `;
    } else {
        // 文件夹/根节点
        const icon = isExpanded ? '📂' : '📁';
        const toggleIcon = isExpanded ? '▼' : '▶';

        html += `
            <div class="cm-tree-item ${isSelected ? 'selected' : ''} ${node.type === 'root' ? 'root' : ''}"
                 style="padding-left:${indent + 12}px"
                 onclick="toggleTreeNode('${node.id}', event)">
                <span class="cm-tree-toggle">${node.children && node.children.length ? toggleIcon : ''}</span>
                <span class="cm-tree-icon">${icon}</span>
                <span class="cm-tree-label">${escapeHtml(node.name)}</span>
                ${node.type === 'folder' && node.id !== 'root' ? `<span class="cm-tree-count">${node.children ? node.children.length : 0}</span>` : ''}
            </div>
        `;

        if (isExpanded && node.children) {
            node.children.forEach(child => {
                html += renderTreeNode(child, depth + 1, visibleIds, forceExpanded);
            });
        }
    }

    return html;
}

function toggleTreeNode(nodeId, event) {
    if (event) event.stopPropagation();
    if (configTreeExpanded.has(nodeId)) {
        configTreeExpanded.delete(nodeId);
    } else {
        configTreeExpanded.add(nodeId);
    }
    // 更新树上下文：从nodeId解析厂家和类型
    const parts = nodeId.split('/');
    if (parts.length === 1) {
        // 厂家节点
        currentTreeContext = { manufacturer: parts[0], boardType: 'mainboard' };
    } else if (parts.length === 2) {
        // 类型节点
        currentTreeContext = { manufacturer: parts[0], boardType: parts[1] };
    }
    renderConfigTree();
}

function onTreeSearch(value) {
    treeSearchQuery = value;
    renderConfigTree();
}

async function selectConfigFile(manufacturer, boardType, configId, nodeId) {
    currentConfigFile = { manufacturer, boardType, configId, nodeId, data: null };
    currentTreeContext = { manufacturer, boardType };
    renderConfigTree(); // 刷新选中状态

    // 显示加载状态
    document.getElementById('cmEditorPath').textContent = `${manufacturer} / ${TYPE_LABELS[boardType] || boardType} / ${configId}`;
    document.getElementById('cmEditorContent').innerHTML = '<div class="cm-loading">加载配置...</div>';

    try {
        const res = await fetch(`/api/config/get/${manufacturer}/${configId}`);
        const data = await res.json();

        if (data.error) {
            showError('加载配置失败: ' + data.error);
            return;
        }

        currentConfigFile.data = data;
        renderEditor();
    } catch (e) {
        showError('加载配置失败: ' + e.message);
    }
}

// ==================== 编辑器 ====================

function switchEditorTab(mode) {
    currentEditorMode = mode;
    document.querySelectorAll('.cm-tab').forEach(el => el.classList.remove('active'));
    document.querySelector(`.cm-tab[data-mode="${mode}"]`).classList.add('active');

    if (mode === 'form') {
        document.getElementById('cmFormPanel').style.display = 'block';
        document.getElementById('cmJsonPanel').style.display = 'none';
    } else {
        document.getElementById('cmFormPanel').style.display = 'none';
        document.getElementById('cmJsonPanel').style.display = 'block';
    }
}

function renderEditor() {
    if (!currentConfigFile || !currentConfigFile.data) {
        document.getElementById('cmEditorContent').innerHTML = `
            <div class="cm-empty-state">
                <div style="font-size:48px;margin-bottom:16px;">📁</div>
                <p>请从左侧选择配置文件</p>
            </div>
        `;
        return;
    }

    const data = currentConfigFile.data;
    const isPreset = data.is_preset === true;

    document.getElementById('cmEditorContent').innerHTML = `
        <div class="cm-editor-inner">
            <!-- 元信息栏 -->
            <div class="cm-meta-bar">
                <span class="cm-meta-item">类型: ${TYPE_LABELS[data.type] || data.type || '-'}</span>
                <span class="cm-meta-item">MCU: ${data.mcu || '-'}</span>
                <span class="cm-meta-item">平台: ${data.platform || '-'}</span>
                ${isPreset ? '<span class="cm-meta-badge preset">系统预设</span>' : '<span class="cm-meta-badge user">用户配置</span>'}
            </div>

            <!-- 标签页 -->
            <div class="cm-tabs">
                <div class="cm-tab active" data-mode="form" onclick="switchEditorTab('form')">表单编辑</div>
                <div class="cm-tab" data-mode="json" onclick="switchEditorTab('json')">JSON 编辑</div>
            </div>

            <!-- 表单面板 -->
            <div id="cmFormPanel" class="cm-panel">
                ${renderFormPanel(data)}
            </div>

            <!-- JSON 面板 -->
            <div id="cmJsonPanel" class="cm-panel" style="display:none;">
                <textarea id="cmJsonEditor" class="cm-json-editor" spellcheck="false">${escapeHtml(JSON.stringify(data, null, 2))}</textarea>
            </div>
        </div>
    `;

    // 绑定表单事件
    bindFormEvents();

    // 初始化MCU下拉框（如果已有平台值）
    const platformEl = document.getElementById('cmPlatform');
    if (platformEl && platformEl.value) {
        onCmMcuPlatformChange();
    }

    // 恢复当前标签页
    switchEditorTab(currentEditorMode);
}

function renderFormPanel(data) {
    const flashModes = data.flash_modes || [];
    const connections = data.connections || [];

    // 烧录方式 checkbox HTML
    const allFlashModes = ['DFU', 'KAT', 'CAN', 'CAN_BRIDGE_DFU', 'CAN_BRIDGE_KAT', 'UF2', 'TF', 'HOST'];
    const flashModeCheckboxes = allFlashModes.map(mode => {
        const checked = flashModes.includes(mode) ? 'checked' : '';
        const label = FLASH_MODE_LABELS[mode] || mode;
        return `
            <label class="cm-checkbox-item">
                <input type="checkbox" name="cmFlashMode" value="${mode}" ${checked}>
                <span>${label}</span>
            </label>
        `;
    }).join('');

    // 默认烧录方式 options
    const defaultFlashOptions = allFlashModes.map(mode => {
        const selected = data.default_flash === mode ? 'selected' : '';
        const label = FLASH_MODE_LABELS[mode] || mode;
        return `<option value="${mode}" ${selected}>${label}</option>`;
    }).join('');

    // 连接方式（简化显示）
    const connHtml = (data.connections || []).map(c => `<span class="cm-tag">${c}</span>`).join(' ') || '-';

    return `
        <div class="cm-form-grid">
            <!-- 基本信息 -->
            <div class="cm-form-section">
                <h4>基本信息</h4>
                <div class="cm-form-row">
                    <div class="cm-form-field" style="flex: 2;">
                        <label>产品名称</label>
                        <input type="text" id="cmName" value="${escapeHtml(data.name || '')}" class="cm-input" oninput="syncNameToIdDisplay()">
                        <div id="cmIdDisplay" style="font-size:12px;color:#888;margin-top:4px;"></div>
                    </div>
                    <div class="cm-form-field">
                        <label>产品类型</label>
                        <select id="cmType" class="cm-input">
                            <option value="mainboard" ${data.type === 'mainboard' ? 'selected' : ''}>主板</option>
                            <option value="toolboard" ${data.type === 'toolboard' ? 'selected' : ''}>工具板</option>
                            <option value="expansion" ${data.type === 'expansion' ? 'selected' : ''}>扩展板</option>
                        </select>
                    </div>
                </div>
                <div class="cm-form-row">
                    <div class="cm-form-field">
                        <label>厂家</label>
                        <input type="text" id="cmManufacturer" value="${escapeHtml(data.manufacturer || '')}" class="cm-input">
                    </div>
                </div>
                <!-- 隐藏的配置ID字段，用于保存时传递现有ID -->
                <input type="hidden" id="cmId" value="${escapeHtml(data.id || '')}">
            </div>

            <!-- MCU 配置 -->
            <div class="cm-form-section">
                <h4>MCU 配置</h4>
                <div class="cm-form-row">
                    <div class="cm-form-field">
                        <label>MCU 平台</label>
                        <select id="cmPlatform" class="cm-input" onchange="onCmMcuPlatformChange()">
                            <option value="">-- 选择平台 --</option>
                            ${renderMcuPlatformOptions(data.platform)}
                        </select>
                    </div>
                    <div class="cm-form-field">
                        <label>MCU 型号</label>
                        <select id="cmMcu" class="cm-input" onchange="onCmMcuModelChange()">
                            <option value="">-- 先选择平台 --</option>
                        </select>
                    </div>
                </div>
                <div class="cm-form-row">
                    <div class="cm-form-field">
                        <label>晶振频率</label>
                        <select id="cmCrystal" class="cm-input">
                            <!-- 动态填充 -->
                        </select>
                    </div>
                    <div class="cm-form-field">
                        <label>Bootloader 偏移</label>
                        <select id="cmBlOffset" class="cm-input">
                            <!-- 动态填充 -->
                        </select>
                    </div>
                </div>
                <div class="cm-form-row">
                    <div class="cm-form-field">
                        <label>启动引脚 <small style="color:#999;font-weight:normal;">（手动配置）</small></label>
                        <input type="text" id="cmBootPins" value="${escapeHtml(data.boot_pins || '')}" class="cm-input" placeholder="例如: gpio8">
                    </div>
                    <div class="cm-form-field">
                        <label>通信接口</label>
                        <div class="cm-tags" id="cmConnTags">${connHtml}</div>
                    </div>
                </div>
            </div>

            <!-- 烧录配置 -->
            <div class="cm-form-section">
                <h4>烧录配置</h4>
                <div class="cm-form-field" style="margin-bottom:12px;">
                    <label>支持的烧录方式</label>
                    <div class="cm-checkbox-group">
                        ${flashModeCheckboxes}
                    </div>
                </div>
                <div class="cm-form-row">
                    <div class="cm-form-field">
                        <label>默认烧录方式</label>
                        <select id="cmDefaultFlash" class="cm-input">
                            <option value="">-- 选择默认 --</option>
                            ${defaultFlashOptions}
                        </select>
                    </div>
                </div>
            </div>

            <!-- 高级：固件更新 -->
            <div class="cm-form-section">
                <h4 style="cursor:pointer;" onclick="toggleCmSection('cmFwUpdateSection')">
                    <span id="cmFwUpdateToggle">▼</span> 固件更新预设（可选）
                </h4>
                <div id="cmFwUpdateSection">
                    <div class="cm-form-row">
                        <div class="cm-form-field">
                            <label>启用自动更新</label>
                            <select id="cmFwUpdateEnabled" class="cm-input" onchange="toggleCmFwUpdateOptions()">
                                <option value="false" ${!(data.firmware_update && data.firmware_update.enabled) ? 'selected' : ''}>否</option>
                                <option value="true" ${data.firmware_update && data.firmware_update.enabled ? 'selected' : ''}>是</option>
                            </select>
                        </div>
                    </div>
                    <div id="cmFwUpdateOptions" style="${data.firmware_update && data.firmware_update.enabled ? '' : 'display:none;'}">
                        <div class="cm-form-row">
                            <div class="cm-form-field">
                                <label>Katapult 模式</label>
                                <select id="cmKatapultMode" class="cm-input">
                                    <option value="USB" ${(data.firmware_update && data.firmware_update.katapult_mode === 'USB') ? 'selected' : ''}>USB</option>
                                    <option value="CAN" ${(data.firmware_update && data.firmware_update.katapult_mode === 'CAN') ? 'selected' : ''}>CAN</option>
                                </select>
                            </div>
                            <div class="cm-form-field">
                                <label>设备 ID</label>
                                <input type="text" id="cmDeviceId" value="${escapeHtml((data.firmware_update && data.firmware_update.device_id) || '')}" class="cm-input">
                            </div>
                        </div>
                        <div class="cm-form-row">
                            <div class="cm-form-field">
                                <label>更新烧录模式</label>
                                <select id="cmUpdateFlashMode" class="cm-input">
                                    <option value="KAT" ${(data.firmware_update && data.firmware_update.flash_mode === 'KAT') ? 'selected' : ''}>KAT</option>
                                    <option value="DFU" ${(data.firmware_update && data.firmware_update.flash_mode === 'DFU') ? 'selected' : ''}>DFU</option>
                                    <option value="CAN" ${(data.firmware_update && data.firmware_update.flash_mode === 'CAN') ? 'selected' : ''}>CAN</option>
                                    <option value="UF2" ${(data.firmware_update && data.firmware_update.flash_mode === 'UF2') ? 'selected' : ''}>UF2</option>
                                    <option value="HOST" ${(data.firmware_update && data.firmware_update.flash_mode === 'HOST') ? 'selected' : ''}>HOST</option>
                                </select>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    `;
}

function renderMcuPlatformOptions(selectedPlatform) {
    let html = '';
    for (const platform in klipperMcuDatabase) {
        const selected = platform === selectedPlatform ? 'selected' : '';
        html += `<option value="${escapeHtml(platform)}" ${selected}>${escapeHtml(platform)}</option>`;
    }
    return html;
}

async function onCmMcuPlatformChange() {
    const platformEl = document.getElementById('cmPlatform');
    const mcuEl = document.getElementById('cmMcu');
    if (!platformEl || !mcuEl) return;

    const platform = platformEl.value;
    mcuEl.innerHTML = '<option value="">-- 选择型号 --</option>';
    mcuEl.disabled = !platform;

    if (!platform) return;

    try {
        const res = await fetch(`/api/klipper/mcus/${platform}`);
        const data = await res.json();
        if (data.success && data.mcus) {
            data.mcus.forEach(mcu => {
                mcuEl.innerHTML += `<option value="${escapeHtml(mcu.id)}">${escapeHtml(mcu.name)}</option>`;
            });
        }
    } catch (e) {
        console.error('加载MCU型号失败:', e);
    }

    // 如果当前配置已有型号且匹配该平台，自动选中
    if (currentConfigFile && currentConfigFile.data && currentConfigFile.data.mcu) {
        const existingMcu = currentConfigFile.data.mcu;
        // 稍微延迟确保选项已渲染
        setTimeout(() => {
            if (mcuEl.querySelector(`option[value="${existingMcu}"]`)) {
                mcuEl.value = existingMcu;
                onCmMcuModelChange();
            }
        }, 50);
    }
}

async function onCmMcuModelChange() {
    const platformEl = document.getElementById('cmPlatform');
    const mcuEl = document.getElementById('cmMcu');
    const crystalEl = document.getElementById('cmCrystal');
    const blOffsetEl = document.getElementById('cmBlOffset');
    const connTagsEl = document.getElementById('cmConnTags');
    if (!platformEl || !mcuEl || !mcuEl.value) return;

    const platform = platformEl.value;
    const mcuId = mcuEl.value;

    try {
        const res = await fetch(`/api/klipper/mcu-info/${mcuId}`);
        const data = await res.json();
        if (!data.success || !data.mcu) return;

        configManagerMcuInfo = data;

        // 填充晶振选项
        if (crystalEl && data.mcu.crystals) {
            crystalEl.innerHTML = '';
            data.mcu.crystals.forEach(freq => {
                const label = formatFrequency(freq);
                const selected = (currentConfigFile && currentConfigFile.data && currentConfigFile.data.crystal === String(freq)) ? 'selected' : '';
                crystalEl.innerHTML += `<option value="${freq}" ${selected}>${label}</option>`;
            });
        }

        // 填充BL偏移选项
        if (blOffsetEl && data.mcu.bl_offsets) {
            blOffsetEl.innerHTML = '';
            data.mcu.bl_offsets.forEach(offset => {
                const label = formatBlOffset(offset, mcuId);
                const selected = (currentConfigFile && currentConfigFile.data && currentConfigFile.data.bl_offset === String(offset)) ? 'selected' : '';
                blOffsetEl.innerHTML += `<option value="${offset}" ${selected}>${label}</option>`;
            });
        }

        // 更新通信接口标签（只显示，不修改配置值）
        if (connTagsEl && data.connections) {
            const tags = data.connections.map(c => `<span class="cm-tag">${escapeHtml(c.name || c.type)}</span>`).join(' ');
            connTagsEl.innerHTML = tags || '-';
        }
    } catch (e) {
        console.error('加载MCU信息失败:', e);
    }

    syncFormToJson();
}

function formatFrequency(freq) {
    const freqNum = parseInt(freq);
    if (freqNum >= 1000000) {
        return (freqNum / 1000000) + ' MHz';
    } else if (freqNum >= 1000) {
        return (freqNum / 1000) + ' KHz';
    }
    return freq + ' Hz';
}

function formatBlOffset(offset, mcuId) {
    const offsetNum = parseInt(offset);
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

function bindFormEvents() {
    // 表单字段变化时，同步更新 JSON 编辑器
    const formIds = ['cmName', 'cmManufacturer', 'cmType', 'cmPlatform', 'cmMcu', 'cmCrystal', 'cmBlOffset', 'cmBootPins', 'cmDefaultFlash', 'cmFwUpdateEnabled', 'cmKatapultMode', 'cmDeviceId', 'cmUpdateFlashMode'];
    formIds.forEach(id => {
        const el = document.getElementById(id);
        if (el) {
            el.addEventListener('change', syncFormToJson);
            el.addEventListener('input', debounce(syncFormToJson, 300));
        }
    });

    // 烧录方式 checkbox 变化
    document.querySelectorAll('input[name="cmFlashMode"]').forEach(cb => {
        cb.addEventListener('change', syncFormToJson);
    });

    // 初始化名称到ID的显示
    syncNameToIdDisplay();
}

function syncNameToIdDisplay() {
    const nameEl = document.getElementById('cmName');
    const idDisplayEl = document.getElementById('cmIdDisplay');
    if (!nameEl || !idDisplayEl) return;

    const generatedId = generateConfigId(nameEl.value);
    const hiddenIdEl = document.getElementById('cmId');
    const existingId = hiddenIdEl ? hiddenIdEl.value : '';

    if (existingId && existingId !== 'new-config') {
        // 已有配置，显示现有ID
        idDisplayEl.textContent = `配置 ID: ${existingId}`;
    } else {
        // 新配置，显示将要生成的ID
        idDisplayEl.textContent = generatedId ? `将生成 ID: ${generatedId}` : '输入产品名称后将自动生成配置 ID';
    }
}

function generateConfigId(name) {
    return name.toLowerCase()
        .replace(/[^a-z0-9]/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');
}

function toggleCmSection(id) {
    const el = document.getElementById(id);
    if (!el) return;
    const toggle = document.getElementById(id.replace('Section', 'Toggle'));
    if (el.style.display === 'none') {
        el.style.display = 'block';
        if (toggle) toggle.textContent = '▼';
    } else {
        el.style.display = 'none';
        if (toggle) toggle.textContent = '▶';
    }
}

function toggleCmFwUpdateOptions() {
    const enabled = document.getElementById('cmFwUpdateEnabled').value === 'true';
    document.getElementById('cmFwUpdateOptions').style.display = enabled ? 'block' : 'none';
}

// ==================== 同步 ====================

function collectFormData() {
    const data = currentConfigFile ? { ...currentConfigFile.data } : {};

    const getVal = (id) => {
        const el = document.getElementById(id);
        return el ? el.value.trim() : '';
    };

    const isNewConfig = !currentConfigFile || !currentConfigFile.data || !currentConfigFile.data.id || currentConfigFile.configId === 'new-config';

    data.name = getVal('cmName');
    data.manufacturer = getVal('cmManufacturer');
    data.type = getVal('cmType');
    data.platform = getVal('cmPlatform');
    data.mcu = getVal('cmMcu');
    data.crystal = getVal('cmCrystal');
    data.bl_offset = getVal('cmBlOffset');
    data.boot_pins = getVal('cmBootPins');
    data.default_flash = getVal('cmDefaultFlash');

    // 配置ID：新配置不传ID让后端自动生成；现有配置保留原ID
    const existingId = getVal('cmId');
    if (!isNewConfig && existingId && existingId !== 'new-config') {
        data.id = existingId;
    } else if (!isNewConfig) {
        data.id = currentConfigFile.configId;
    }
    // 新配置不设置 id 字段，让后端根据名称自动生成

    // 烧录方式
    data.flash_modes = Array.from(document.querySelectorAll('input[name="cmFlashMode"]:checked')).map(cb => cb.value);

    // 固件更新
    const fwEnabled = getVal('cmFwUpdateEnabled') === 'true';
    if (fwEnabled) {
        data.firmware_update = {
            enabled: true,
            katapult_mode: getVal('cmKatapultMode') || 'USB',
            device_id: getVal('cmDeviceId'),
            flash_mode: getVal('cmUpdateFlashMode') || 'KAT'
        };
    } else {
        if (data.firmware_update) data.firmware_update.enabled = false;
    }

    return data;
}

function syncFormToJson() {
    const data = collectFormData();
    const jsonEditor = document.getElementById('cmJsonEditor');
    if (jsonEditor) {
        jsonEditor.value = JSON.stringify(data, null, 2);
    }
}

function syncJsonToForm() {
    const jsonEditor = document.getElementById('cmJsonEditor');
    if (!jsonEditor || currentEditorMode !== 'json') return;

    try {
        const data = JSON.parse(jsonEditor.value);
        currentConfigFile.data = data;
        // 如果当前在 JSON 模式，不强制刷新表单，避免打断编辑；切换回表单时会重新渲染
    } catch (e) {
        // JSON 格式错误，忽略
    }
}

// ==================== 保存 / 删除 / 新建 ====================

async function saveCurrentConfig() {
    if (!currentConfigFile) {
        showError('请先选择一个配置文件');
        return;
    }

    let data;
    if (currentEditorMode === 'json') {
        const jsonEditor = document.getElementById('cmJsonEditor');
        try {
            data = JSON.parse(jsonEditor.value);
        } catch (e) {
            showError('JSON 格式错误，请检查: ' + e.message);
            return;
        }
    } else {
        data = collectFormData();
    }

    if (!data.name) {
        showError('产品名称不能为空');
        return;
    }

    const manufacturer = data.manufacturer || currentConfigFile.manufacturer || 'Custom';
    const isPreset = currentConfigFile.data && currentConfigFile.data.is_preset === true;
    const isNewConfig = !currentConfigFile.data || !currentConfigFile.data.id || currentConfigFile.configId === 'new-config';

    try {
        let url, method, body;

        if (isNewConfig) {
            // 新建配置：使用 create API，后端自动根据名称生成ID
            url = `/api/config/create/${manufacturer}`;
            method = 'POST';
            body = JSON.stringify(data);
        } else {
            // 更新现有配置：使用 save API，必须包含现有ID
            url = '/api/config/save';
            method = 'POST';
            body = JSON.stringify(data);
        }

        const response = await fetch(url, {
            method,
            headers: { 'Content-Type': 'application/json' },
            body
        });

        const result = await response.json();

        if (result.success) {
            showSuccess(isPreset ? '基于预设创建新配置成功！' : isNewConfig ? '配置创建成功！' : '配置保存成功！');
            // 更新当前配置对象
            if (result.id) {
                data.id = result.id;
                currentConfigFile.configId = result.id;
            }
            currentConfigFile.data = data;
            refreshConfigTree();
        } else {
            showError(result.error || '保存失败');
        }
    } catch (e) {
        showError('保存失败: ' + e.message);
    }
}

async function deleteCurrentConfig() {
    if (!currentConfigFile) {
        showError('请先选择一个配置文件');
        return;
    }

    const { manufacturer, configId } = currentConfigFile;
    const cfg = currentConfigFile.data || {};

    if (cfg.is_preset) {
        showError('系统预设配置不能删除');
        return;
    }

    if (!confirm(`确定要删除 "${cfg.name || configId}" 吗？此操作不可恢复。`)) {
        return;
    }

    try {
        const res = await fetch(`/api/config/delete/${manufacturer}/${configId}`, { method: 'DELETE' });
        const result = await res.json();

        if (result.success) {
            showSuccess('配置已删除');
            currentConfigFile = null;
            renderEditor();
            refreshConfigTree();
        } else {
            showError(result.error || '删除失败');
        }
    } catch (e) {
        showError('删除失败: ' + e.message);
    }
}

function showNewConfigDialog() {
    // 新建配置：优先使用当前树上下文，其次使用当前选中的配置文件，最后默认 FLY
    let mfr = 'FLY';
    let type = 'mainboard';
    if (currentTreeContext && currentTreeContext.manufacturer) {
        mfr = currentTreeContext.manufacturer;
        type = currentTreeContext.boardType || 'mainboard';
    } else if (currentConfigFile && currentConfigFile.manufacturer && currentConfigFile.configId !== 'new-config') {
        mfr = currentConfigFile.manufacturer;
        type = currentConfigFile.boardType || 'mainboard';
    }
    currentConfigFile = {
        manufacturer: mfr,
        boardType: type,
        configId: 'new-config',
        nodeId: 'new',
        data: {
            name: '新配置',
            manufacturer: mfr,
            type: type,
            platform: '',
            mcu: '',
            crystal: '',
            bl_offset: '',
            boot_pins: '',
            connections: [],
            flash_modes: [],
            default_flash: ''
        }
    };
    document.getElementById('cmEditorPath').textContent = '新建配置';
    renderEditor();
    showSuccess('已加载空白模板，编辑后保存即可创建新配置');
}

// ==================== 新建厂家 ====================

function showCreateManufacturerDialog() {
    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.id = 'cmCreateMfrModal';
    modal.style.display = 'flex';
    modal.innerHTML = `
        <div class="modal-content" style="max-width:400px;">
            <div class="modal-header">
                <h3>🏭 新建厂家</h3>
                <button class="btn btn-sm btn-secondary" onclick="closeCreateManufacturerDialog()">✕</button>
            </div>
            <div class="modal-body">
                <div class="cm-form-field" style="margin-bottom:16px;">
                    <label>厂家名称 <span style="color:red">*</span></label>
                    <input type="text" id="cmNewMfrName" class="cm-input" placeholder="例如: FLY">
                    <p style="font-size:12px;color:#888;margin-top:4px;">只能包含字母、数字、连字符和下划线</p>
                </div>
                <div style="display:flex;gap:10px;justify-content:flex-end;">
                    <button class="btn btn-secondary" onclick="closeCreateManufacturerDialog()">取消</button>
                    <button class="btn btn-primary" onclick="createManufacturer()">创建</button>
                </div>
            </div>
        </div>
    `;
    modal.addEventListener('click', (e) => {
        if (e.target === modal) closeCreateManufacturerDialog();
    });
    document.body.appendChild(modal);
    setTimeout(() => document.getElementById('cmNewMfrName').focus(), 100);
}

function closeCreateManufacturerDialog() {
    const modal = document.getElementById('cmCreateMfrModal');
    if (modal) modal.remove();
}

async function createManufacturer() {
    const nameEl = document.getElementById('cmNewMfrName');
    const name = nameEl.value.trim();

    if (!name) {
        showError('请输入厂家名称');
        return;
    }
    if (!name.replace(/[-_]/g, '').match(/^[a-zA-Z0-9]+$/)) {
        showError('厂家名称只能包含字母、数字、连字符和下划线');
        return;
    }

    try {
        const response = await fetch('/api/config/create-manufacturer', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name })
        });

        const result = await response.json();

        if (result.success) {
            showSuccess(result.message);
            closeCreateManufacturerDialog();
            // 刷新树并自动展开新厂家
            configTreeExpanded.add(name);
            configTreeExpanded.add(`${name}/mainboard`);
            configTreeExpanded.add(`${name}/toolboard`);
            refreshConfigTree();
        } else {
            showError(result.error || '创建失败');
        }
    } catch (e) {
        showError('创建失败: ' + e.message);
    }
}

// ==================== 工具函数 ====================

function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function debounce(fn, ms) {
    let timer;
    return function(...args) {
        clearTimeout(timer);
        timer = setTimeout(() => fn.apply(this, args), ms);
    };
}

// ==================== 页面初始化 ====================

document.addEventListener('DOMContentLoaded', () => {
    if (document.getElementById('page-config')) {
        initConfigManager();
    }
});
