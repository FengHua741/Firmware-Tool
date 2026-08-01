/**
 * Klipper配置解析器 - 页面逻辑
 */

function klipperParserProcessPinValue(value) {
    let cleanValue = String(value || '').split('#')[0].trim();
    if (cleanValue.toLowerCase() === 'host:none') return { value: 'host:None', cleanedValue: 'host:None', type: 'host' };
    if (cleanValue.toLowerCase().includes('virtual_endstop')) return { value: '虚拟引脚', type: 'virtual' };
    if (cleanValue.includes(':')) {
        const parts = cleanValue.split(':');
        const cleanedPin = (parts[1] || '').replace(/^[!^]/, '');
        return { value: cleanValue, cleanedValue: `${parts[0]}:${cleanedPin}`, type: 'toolboard', board: parts[0], pin: cleanedPin };
    }
    const cleanedValue = cleanValue.replace(/^[!^]/, '');
    return { value: cleanValue, cleanedValue: cleanedValue, type: 'standard' };
}

function kpEscapeHtml(value) {
    const div = document.createElement('div');
    div.textContent = value == null ? '' : String(value);
    return div.innerHTML;
}

function kpEscapeJsString(value) {
    return String(value == null ? '' : value)
        .replace(/\\/g, '\\\\')
        .replace(/'/g, "\\'")
        .replace(/"/g, '\\"')
        .replace(/\n/g, '\\n')
        .replace(/\r/g, '\\r');
}

function klipperParserParseConfig(config) {
    const lines = String(config || '').split('\n');
    let currentSection = '';
    const results = {
        axes: [], extruders: [], heaterBed: null, probe: null, fans: [],
        toolboards: [], drivers: {},
        pinAliases: { steppers: {}, heaters: {}, sensors: {}, fans: [], endstops: {}, bltouch: {}, drivers: {} }
    };

    for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
            currentSection = trimmed.slice(1, -1);
            if (currentSection.toLowerCase().startsWith('mcu') && !currentSection.toLowerCase().endsWith('mcu') && !results.toolboards.includes(currentSection)) {
                results.toolboards.push(currentSection);
            }
            continue;
        }
        if (trimmed.startsWith('#') || trimmed === '') continue;
        const lineWithoutComment = trimmed.split('#')[0].trim();
        const parts = lineWithoutComment.split(':');
        if (parts.length < 2) continue;
        const key = parts[0].trim();
        const value = parts.slice(1).join(':').trim();
        const pinData = klipperParserProcessPinValue(value);

        if (currentSection.match(/stepper_([xyz]\d*)/i)) {
            const match = currentSection.match(/stepper_([xyz]\d*)/i);
            const axisType = match[1].toLowerCase();
            let axis = results.axes.find(a => a.name === axisType);
            if (!axis) { axis = { name: axisType, section: currentSection }; results.axes.push(axis); }
            if (key === 'step_pin') { axis.step_pin = pinData; results.pinAliases.steppers[`${axisType.toUpperCase()}_STEP`] = pinData.cleanedValue; }
            if (key === 'dir_pin') { axis.dir_pin = pinData; results.pinAliases.steppers[`${axisType.toUpperCase()}_DIR`] = pinData.cleanedValue; }
            if (key === 'enable_pin') { axis.enable_pin = pinData; results.pinAliases.steppers[`${axisType.toUpperCase()}_EN`] = pinData.cleanedValue; }
            if (key === 'endstop_pin') { axis.endstop_pin = pinData; results.pinAliases.endstops[`${axisType.toUpperCase()}_STOP`] = pinData.cleanedValue; }
        }
        if (currentSection.match(/extruder(\d*)/i)) {
            const match = currentSection.match(/extruder(\d*)/i);
            const extruderNum = match[1] || '';
            const extruderName = extruderNum ? `挤出机${extruderNum}` : '挤出机';
            let extruder = results.extruders.find(e => e.name === extruderName);
            if (!extruder) { extruder = { name: extruderName, section: currentSection }; results.extruders.push(extruder); }
            if (key === 'step_pin') { extruder.step_pin = pinData; results.pinAliases.steppers['E_STEP'] = pinData.cleanedValue; }
            if (key === 'dir_pin') { extruder.dir_pin = pinData; results.pinAliases.steppers['E_DIR'] = pinData.cleanedValue; }
            if (key === 'enable_pin') { extruder.enable_pin = pinData; results.pinAliases.steppers['E_EN'] = pinData.cleanedValue; }
            if (key === 'heater_pin') { extruder.heater_pin = pinData; results.pinAliases.heaters['HEAT'] = pinData.cleanedValue; }
            if (key === 'sensor_pin') { extruder.sensor_pin = pinData; results.pinAliases.sensors['HEAT_TEMP'] = pinData.cleanedValue; }
        }
        if (currentSection === 'heater_bed') {
            if (!results.heaterBed) results.heaterBed = { section: currentSection };
            if (key === 'heater_pin') { results.heaterBed.heater_pin = pinData; results.pinAliases.heaters['BED_OUT'] = pinData.cleanedValue; }
            if (key === 'sensor_pin') { results.heaterBed.sensor_pin = pinData; results.pinAliases.sensors['BED_TEMP'] = pinData.cleanedValue; }
        }
        if (currentSection === 'probe' || currentSection === 'bltouch') {
            if (!results.probe) results.probe = { type: currentSection, section: currentSection };
            if (key === 'pin' || key === 'sensor_pin') { results.probe.sensor_pin = pinData; results.pinAliases.bltouch['PROBE'] = pinData.cleanedValue; }
            if (key === 'control_pin') { results.probe.control_pin = pinData; results.pinAliases.bltouch['SERVO'] = pinData.cleanedValue; }
        }
        if (currentSection === 'fan' || currentSection.startsWith('heater_fan')) {
            let fan = results.fans.find(f => f.section === currentSection);
            if (!fan) {
                fan = { name: currentSection === 'fan' ? '主风扇' : currentSection, section: currentSection, type: currentSection.startsWith('heater_fan') ? '加热器风扇' : '冷却风扇' };
                results.fans.push(fan);
            }
            if (key === 'pin') { const pd = klipperParserProcessPinValue(value); fan.pin = pd; results.pinAliases.fans.push(pd.cleanedValue); }
        }
        if (currentSection.startsWith('tmc')) {
            const parts2 = currentSection.split(' ');
            if (parts2.length > 1) {
                const driverType = parts2[0]; const targetAxis = parts2[1];
                if (!results.drivers[targetAxis]) results.drivers[targetAxis] = { type: driverType };
                if (key === 'cs_pin') { results.drivers[targetAxis].cs_pin = pinData; const at = targetAxis.split('_')[1] || 'E'; results.pinAliases.drivers[`${at.toUpperCase()}_CS`] = pinData.cleanedValue; }
                if (key === 'uart_pin') { results.drivers[targetAxis].uart_pin = pinData; const at = targetAxis.split('_')[1] || 'E'; results.pinAliases.drivers[`${at.toUpperCase()}_UART`] = pinData.cleanedValue; }
            }
        }
    }
    for (const [axisSection, driverData] of Object.entries(results.drivers)) {
        let targetAxis = results.axes.find(a => a.section === axisSection);
        if (!targetAxis) targetAxis = results.extruders.find(e => e.section === axisSection);
        if (targetAxis) {
            targetAxis.driver_cs_pin = driverData.cs_pin;
            targetAxis.driver_uart_pin = driverData.uart_pin;
            targetAxis.driver_type = driverData.type;
        }
    }
    return results;
}

function klipperParserFormatPinValue(pinData) {
    if (!pinData || !pinData.value) return '<span class="pin-value">未配置</span>';
    const value = kpEscapeHtml(pinData.value);
    if (pinData.type === 'virtual') return `<span class="virtual-pin">${value}</span>`;
    if (pinData.type === 'host') return `<span class="host-pin">${value}</span>`;
    if (pinData.type === 'toolboard') return `<span class="toolboard-name">${kpEscapeHtml(pinData.board)}</span>:<span class="pin-number">${kpEscapeHtml(pinData.pin)}</span> <span class="toolboard-hint">工具板</span>`;
    if (pinData.value.includes('cs_pin') || pinData.value.includes('uart_pin')) return `<span class="driver-pin">${value}</span>`;
    return `<span class="pin-value">${value}</span>`;
}

function klipperParserBuildResultHTML(result, checkReport) {
    let html = '';
    if (checkReport) {
        html += buildCheckReportHTML(checkReport.duplicates, checkReport.conflicts, checkReport.macroCheck);
        html += '<hr style="margin:20px 0;">';
    }
    if (result.toolboards && result.toolboards.length > 0) {
        html += '<div style="margin-bottom:20px; padding-bottom:15px; border-bottom:1px solid var(--border-color);"><h3 style="display:flex; align-items:center; color:var(--primary-color); margin-bottom:15px; font-size:1.2rem;"><i class="fas fa-toolbox" style="margin-right:10px;"></i> 工具板配置</h3><div class="toolboard-section">';
        result.toolboards.forEach(tb => { html += `<div class="toolboard-card"><i class="fas fa-microchip"></i><div><strong>${kpEscapeHtml(tb)}</strong><div class="toolboard-pin">已配置工具板引脚</div></div></div>`; });
        html += '</div></div><hr>';
    }
    if (result.axes.length > 0) {
        html += '<div style="margin-bottom:20px; padding-bottom:15px; border-bottom:1px solid var(--border-color);"><h3 style="display:flex; align-items:center; color:var(--primary-color); margin-bottom:15px; font-size:1.2rem;"><i class="fas fa-arrows-alt" style="margin-right:10px;"></i> 步进电机轴配置</h3>';
        result.axes.forEach(axis => {
            html += `<div class="axis-config"><h4><i class="fas fa-arrows-alt-h"></i> ${kpEscapeHtml(axis.name.toUpperCase())}轴</h4><ul>`;
            if (axis.step_pin) html += `<li><strong>STEP引脚</strong>: ${klipperParserFormatPinValue(axis.step_pin)}</li>`;
            if (axis.dir_pin) html += `<li><strong>DIR引脚</strong>: ${klipperParserFormatPinValue(axis.dir_pin)}</li>`;
            if (axis.enable_pin) html += `<li><strong>EN引脚</strong>: ${klipperParserFormatPinValue(axis.enable_pin)}</li>`;
            if (axis.endstop_pin) html += `<li><strong>限位开关引脚</strong>: ${klipperParserFormatPinValue(axis.endstop_pin)}</li>`;
            if (axis.driver_cs_pin) html += `<li><strong>CS引脚</strong>: ${klipperParserFormatPinValue(axis.driver_cs_pin)}</li>`;
            if (axis.driver_uart_pin) html += `<li><strong>UART引脚</strong>: ${klipperParserFormatPinValue(axis.driver_uart_pin)}</li>`;
            if (axis.driver_type) html += `<li><strong>驱动类型</strong>: ${kpEscapeHtml(axis.driver_type)}</li>`;
            html += `</ul></div>`;
        });
        html += '</div><hr>';
    }
    if (result.extruders.length > 0) {
        html += '<div style="margin-bottom:20px; padding-bottom:15px; border-bottom:1px solid var(--border-color);"><h3 style="display:flex; align-items:center; color:var(--primary-color); margin-bottom:15px; font-size:1.2rem;"><i class="fas fa-fire" style="margin-right:10px;"></i> 挤出机配置</h3>';
        result.extruders.forEach(extruder => {
            html += `<div class="extruder-config"><h4><i class="fas fa-temperature-high"></i> ${kpEscapeHtml(extruder.name)}</h4><ul>`;
            if (extruder.step_pin) html += `<li><strong>STEP引脚</strong>: ${klipperParserFormatPinValue(extruder.step_pin)}</li>`;
            if (extruder.dir_pin) html += `<li><strong>DIR引脚</strong>: ${klipperParserFormatPinValue(extruder.dir_pin)}</li>`;
            if (extruder.enable_pin) html += `<li><strong>EN引脚</strong>: ${klipperParserFormatPinValue(extruder.enable_pin)}</li>`;
            if (extruder.heater_pin) html += `<li><strong>加热引脚</strong>: ${klipperParserFormatPinValue(extruder.heater_pin)}</li>`;
            if (extruder.sensor_pin) html += `<li><strong>热敏引脚</strong>: ${klipperParserFormatPinValue(extruder.sensor_pin)}</li>`;
            if (extruder.driver_cs_pin) html += `<li><strong>CS引脚</strong>: ${klipperParserFormatPinValue(extruder.driver_cs_pin)}</li>`;
            if (extruder.driver_uart_pin) html += `<li><strong>UART引脚</strong>: ${klipperParserFormatPinValue(extruder.driver_uart_pin)}</li>`;
            if (extruder.driver_type) html += `<li><strong>驱动类型</strong>: ${kpEscapeHtml(extruder.driver_type)}</li>`;
            html += `</ul></div>`;
        });
        html += '</div><hr>';
    }
    if (result.heaterBed) {
        html += '<div style="margin-bottom:20px; padding-bottom:15px; border-bottom:1px solid var(--border-color);"><h3 style="display:flex; align-items:center; color:var(--primary-color); margin-bottom:15px; font-size:1.2rem;"><i class="fas fa-bed" style="margin-right:10px;"></i> 热床配置</h3><div class="heater-config-result"><h4><i class="fas fa-temperature-high"></i> 热床加热器</h4><ul>';
        if (result.heaterBed.heater_pin) html += `<li><strong>加热引脚</strong>: ${klipperParserFormatPinValue(result.heaterBed.heater_pin)}</li>`;
        if (result.heaterBed.sensor_pin) html += `<li><strong>热敏引脚</strong>: ${klipperParserFormatPinValue(result.heaterBed.sensor_pin)}</li>`;
        html += `</ul></div></div><hr>`;
    }
    return html || '<p style="text-align:center; color:var(--text-secondary); padding:30px 0;">未找到可解析的配置信息</p>';
}

function klipperParserAnalyzeConfig(config, mainsailBaseline='') {
    const result = klipperParserParseConfig(config);
    const sections = parseMergedSections(config);
    const duplicates = checkDuplicateSections(sections);
    const conflicts = checkPinConflicts(config);
    const macroCheck = checkMacroModifications(config, mainsailBaseline);
    const html = klipperParserBuildResultHTML(result, { duplicates, conflicts, macroCheck });
    return { result, sections, duplicates, conflicts, macroCheck, html };
}

function initKlipperParser() {
    // 防止重复初始化
    if (window._klipperParserInited) return;
    window._klipperParserInited = true;

    const configInput = document.getElementById('configInput');
    const parseBtn = document.getElementById('parseBtn');
    const resetBtn = document.getElementById('resetBtn');
    const uploadBtn = document.getElementById('uploadBtn');
    const fileInput = document.getElementById('fileInput');
    const dropArea = document.getElementById('dropArea');
    const fileList = document.getElementById('fileList');
    const fileCount = document.getElementById('fileCount');
    const totalSize = document.getElementById('totalSize');
    const resultOutput = document.getElementById('resultOutput');
    let files = [];

    dropArea.addEventListener('click', () => { fileInput.click(); });
    uploadBtn.addEventListener('click', () => { fileInput.click(); });

    dropArea.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropArea.style.borderColor = 'var(--primary-color)';
        dropArea.style.backgroundColor = '#e3f2fd';
    });
    dropArea.addEventListener('dragleave', () => {
        dropArea.style.borderColor = '';
        dropArea.style.backgroundColor = '#fafafa';
    });
    dropArea.addEventListener('drop', (e) => {
        e.preventDefault();
        dropArea.style.borderColor = '';
        dropArea.style.backgroundColor = '#fafafa';
        if (e.dataTransfer.files.length) handleFiles(e.dataTransfer.files);
    });
    fileInput.addEventListener('change', (e) => {
        if (e.target.files.length) handleFiles(e.target.files);
    });

    function handleFiles(selectedFiles) {
        for (let i = 0; i < selectedFiles.length; i++) {
            const file = selectedFiles[i];
            if (!file.name.match(/\.(cfg|txt)$/i)) {
                alert(`文件 ${file.name} 不是有效的配置文件 (.cfg 或 .txt)`);
                continue;
            }
            if (files.find(f => f.name === file.name && f.size === file.size)) continue;
            files.push(file);
        }
        updateFileList();
        readAndMergeFiles();
    }

    function updateFileList() {
        if (files.length === 0) {
            fileList.innerHTML = '<p style="text-align:center; color:var(--text-secondary); padding:15px;">未选择文件</p>';
            fileCount.textContent = '0 个文件已选择';
            totalSize.textContent = '0 KB';
            return;
        }
        let totalSizeBytes = 0;
        let fileListHTML = '';
        files.forEach((file, index) => {
            totalSizeBytes += file.size;
            const sizeKB = (file.size / 1024).toFixed(1);
            fileListHTML += `<div class="file-item"><div class="file-name">${kpEscapeHtml(file.name)}</div><div class="file-size">${kpEscapeHtml(sizeKB)} KB</div><div class="remove-file" data-index="${index}"><i class="fas fa-times"></i></div></div>`;
        });
        fileList.innerHTML = fileListHTML;
        fileCount.textContent = `${files.length} 个文件已选择`;
        totalSize.textContent = `${(totalSizeBytes / 1024).toFixed(1)} KB`;
        document.querySelectorAll('.remove-file').forEach(el => {
            el.addEventListener('click', (e) => {
                const index = parseInt(e.currentTarget.getAttribute('data-index'));
                files.splice(index, 1);
                updateFileList();
                readAndMergeFiles();
            });
        });
    }

    function readAndMergeFiles() {
        if (files.length === 0) { configInput.value = ''; return; }
        const readers = [];
        files.forEach(file => {
            const reader = new FileReader();
            readers.push(new Promise((resolve) => {
                reader.onload = (e) => { resolve(e.target.result); };
                reader.readAsText(file);
            }));
        });
        Promise.all(readers).then(contents => { configInput.value = contents.join('\n\n'); });
    }

    parseBtn.addEventListener('click', function() {
        const config = configInput.value;
        if (!config.trim()) {
            resultOutput.innerHTML = '<div class="error-msg"><i class="fas fa-exclamation-circle"></i> 错误：请输入有效的 Klipper 配置文件内容</div>';
            return;
        }
        try {
            const result = klipperParserParseConfig(config);

            // 运行三项配置检查
            const sections = parseMergedSections(config);
            const duplicates = checkDuplicateSections(sections);
            const conflicts = checkPinConflicts(config);
            const macroCheck = checkMacroModifications(config, _mainsailBaseline);

            resultOutput.innerHTML = klipperParserBuildResultHTML(result, { duplicates, conflicts, macroCheck });
        } catch (error) {
            resultOutput.innerHTML = `<div class="error-msg"><i class="fas fa-exclamation-circle"></i> 解析错误: ${kpEscapeHtml(error.message)}</div>`;
        }
    });

    resetBtn.addEventListener('click', function() {
        files = [];
        configInput.value = '';
        _mainsailBaseline = '';
        updateFileList();
        resultOutput.innerHTML = '<p style="text-align:center; color:var(--text-secondary); padding:30px 0;">解析结果将显示在这里...</p>';
    });
}

// ==================== 远程加载配置 ====================

/** 从被控机器加载配置文件列表，自动加载 printer.cfg 及其 include 文件 */
async function loadRemoteConfigList() {
    const btn = document.getElementById('remoteLoadBtn');
    const status = document.getElementById('remoteLoadStatus');
    const fileListDiv = document.getElementById('remoteFileList');
    const fileListContent = document.getElementById('remoteFileListContent');

    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 加载中...';
    status.innerHTML = '<span style="color:var(--primary-color)"><i class="fas fa-spinner fa-spin"></i> 正在查询被控机器配置文件...</span>';
    fileListDiv.style.display = 'none';
    const progressBar = document.getElementById('remoteProgress');
    if (progressBar) progressBar.style.display = 'block';

    try {
        const resp = await fetch('/api/tools/config-files');
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.json();

        if (!data.success) {
            status.innerHTML = `<span style="color:var(--danger-color)"><i class="fas fa-exclamation-circle"></i> ${kpEscapeHtml(data.error)}</span>`;
            return;
        }

        const files = data.files || [];
        const sourceLabels = { moonraker: 'Moonraker', ssh: 'SSH', local: '本地' };
        const sourceLabel = sourceLabels[data.source] || data.source || '未知';
        const safeSourceLabel = kpEscapeHtml(sourceLabel);

        if (files.length === 0) {
            status.innerHTML = `<span style="color:var(--warning-color)"><i class="fas fa-exclamation-triangle"></i> 未找到配置文件 (来源: ${safeSourceLabel})</span>`;
            return;
        }

        // 分离目录和文件
        const dirs = files.filter(f => f.type === 'dir');
        const cfgFiles = files.filter(f => f.type === 'file');

        // 构建文件列表 UI
        let html = '';
        if (dirs.length > 0) {
            html += '<div style="padding:6px 8px; font-size:12px; color:var(--text-secondary); border-bottom:1px solid var(--border-color);">📁 子目录</div>';
            dirs.forEach(d => {
                html += `<div class="file-item"><div class="file-name">📁 ${kpEscapeHtml(d.name)}</div><div class="file-size">目录</div></div>`;
            });
        }
        if (cfgFiles.length > 0) {
            html += `<div style="padding:6px 8px; font-size:12px; color:var(--text-secondary); border-bottom:1px solid var(--border-color);">📄 配置文件 (${cfgFiles.length} 个, 来源: ${safeSourceLabel})</div>`;
            cfgFiles.forEach(f => {
                const sizeStr = f.size ? `${(f.size / 1024).toFixed(1)} KB` : '';
                const isPrinterCfg = f.name === 'printer.cfg';
                html += `<div class="file-item" style="cursor:pointer;${isPrinterCfg ? ' background:#e8f4ff;' : ''}" onclick="loadRemoteConfig('${kpEscapeJsString(f.path)}')" title="点击加载"><div class="file-name"><i class="fas fa-file-code" style="color:var(--primary-color); margin-right:6px;"></i>${kpEscapeHtml(f.name)}${isPrinterCfg ? ' <span style="color:var(--success-color);font-size:11px;">(主配置)</span>' : ''}</div><div class="file-size">${kpEscapeHtml(sizeStr)} <i class="fas fa-download" style="margin-left:6px; color:var(--primary-color);"></i></div></div>`;
            });
        }

        fileListContent.innerHTML = html;
        fileListDiv.style.display = 'block';

        // 自动查找并加载 printer.cfg
        const printerCfg = cfgFiles.find(f => f.name === 'printer.cfg');
        if (printerCfg) {
            status.innerHTML = '<span style="color:var(--primary-color)"><i class="fas fa-spinner fa-spin"></i> 找到 printer.cfg，正在加载主配置及 include 文件...</span>';
            await loadPrinterCfgWithIncludes(printerCfg.path, sourceLabel);
        } else {
            status.innerHTML = `<span style="color:var(--warning-color)"><i class="fas fa-exclamation-triangle"></i> 未找到 printer.cfg，请手动选择配置文件 (来源: ${safeSourceLabel})</span>`;
        }
    } catch (err) {
        status.innerHTML = `<span style="color:var(--danger-color)"><i class="fas fa-exclamation-circle"></i> 请求失败: ${kpEscapeHtml(err.message)}</span>`;
    } finally {
        btn.disabled = false;
        btn.innerHTML = '<i class="fas fa-server"></i> 从被控机器加载';
        if (progressBar) progressBar.style.display = 'none';
    }
}

/** 解析配置内容中的 [include XXX] 指令，返回需要加载的文件模式列表（忽略 # 注释行） */
function parseIncludeFiles(content) {
    const includes = [];
    const lines = content.split('\n');
    for (const line of lines) {
        const trimmed = line.trim();
        // 跳过注释行
        if (trimmed.startsWith('#')) continue;
        // 匹配 [include XXX.cfg] 或 [include XXX/*.cfg]
        const match = trimmed.match(/^\[include\s+(.+?)\]$/i);
        if (match) {
            includes.push(match[1].trim());
        }
    }
    return includes;
}

/** 展开单个 include 模式，返回实际文件路径数组（处理通配符） */
async function expandIncludePattern(includePath, cfgDir) {
    // 通配符包含 * 或 ?
    if (includePath.includes('*') || includePath.includes('?')) {
        const fullPattern = cfgDir + includePath;
        try {
            const resp = await fetch('/api/tools/config-wildcard', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ pattern: fullPattern })
            });
            if (!resp.ok) return [];
            const data = await resp.json();
            if (data.success && data.files && data.files.length > 0) {
                return data.files.map(f => f.path);
            }
        } catch (e) {
            console.warn(`通配符展开失败: ${fullPattern}`, e);
        }
        return [];
    }
    // 普通文件路径
    return [cfgDir + includePath];
}

/** 递归加载 include 文件（支持嵌套 include、通配符、循环引用检测）
 * @param {string[]} includePatterns - include 模式列表
 * @param {string} cfgDir - 配置目录前缀
 * @param {Set} loadedFiles - 已加载文件集合（防循环）
 * @param {number} depth - 当前递归深度
 * @param {number} maxDepth - 最大递归深度
 * @param {Function} onProgress - 进度回调 (msg)
 * @returns {string} 合并后的内容
 */
async function recursiveLoadIncludes(includePatterns, cfgDir, loadedFiles, depth, maxDepth, onProgress) {
    let result = '';

    for (const pattern of includePatterns) {
        const filePaths = await expandIncludePattern(pattern, cfgDir);

        if (filePaths.length === 0) {
            result += `\n\n# ===== [include ${pattern}] - 未找到匹配文件 =====`;
            continue;
        }

        for (const filePath of filePaths) {
            const fileName = filePath.split('/').pop();

            // 循环引用检测
            if (loadedFiles.has(filePath)) {
                result += `\n\n# ===== [include ${fileName}] - 循环引用，已跳过 =====`;
                continue;
            }
            loadedFiles.add(filePath);

            // 深度限制
            if (depth >= maxDepth) {
                result += `\n\n# ===== [include ${fileName}] - 超过最大嵌套深度 (${maxDepth}) =====`;
                continue;
            }

            onProgress(`正在加载 ${fileName}...`);

            try {
                const resp = await fetch('/api/tools/config-content', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ path: filePath })
                });
                if (!resp.ok) {
                    result += `\n\n# ===== [include ${fileName}] - 请求失败: HTTP ${resp.status} =====`;
                    continue;
                }
                const data = await resp.json();

                if (data.success) {
                    result += `\n\n# ===== [include ${fileName}] =====\n${data.content}`;

                    // 递归解析嵌套的 include
                    const nestedIncludes = parseIncludeFiles(data.content);
                    if (nestedIncludes.length > 0) {
                        const nestedContent = await recursiveLoadIncludes(
                            nestedIncludes, cfgDir, loadedFiles, depth + 1, maxDepth, onProgress
                        );
                        result += nestedContent;
                    }
                } else {
                    result += `\n\n# ===== [include ${fileName}] - 加载失败: ${data.error} =====`;
                }
            } catch (err) {
                result += `\n\n# ===== [include ${fileName}] - 请求失败: ${err.message} =====`;
            }
        }
    }

    return result;
}

/** 加载 printer.cfg 及其所有 include 文件（递归、通配符、循环检测），合并后填入解析器 */
async function loadPrinterCfgWithIncludes(printerCfgPath, sourceLabel) {
    const status = document.getElementById('remoteLoadStatus');
    const configInput = document.getElementById('configInput');

    try {
        // 1. 加载 printer.cfg
        status.innerHTML = '<span style="color:var(--primary-color)"><i class="fas fa-spinner fa-spin"></i> 正在读取 printer.cfg...</span>';
        const mainResp = await fetch('/api/tools/config-content', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: printerCfgPath })
        });
        if (!mainResp.ok) {
            const errData = await mainResp.json().catch(() => ({}));
            status.innerHTML = `<span style="color:var(--danger-color)"><i class="fas fa-exclamation-circle"></i> 请求失败: ${kpEscapeHtml(errData.error || 'HTTP ' + mainResp.status)}</span>`;
            return;
        }
        const mainData = await mainResp.json();

        if (!mainData.success) {
            status.innerHTML = `<span style="color:var(--danger-color)"><i class="fas fa-exclamation-circle"></i> 加载 printer.cfg 失败: ${kpEscapeHtml(mainData.error)}</span>`;
            return;
        }

        let mergedContent = `# ===== printer.cfg (主配置) =====\n${mainData.content}`;

        // 2. 解析 include 指令
        const includePatterns = parseIncludeFiles(mainData.content);

        if (includePatterns.length > 0) {
            // 计算配置目录前缀
            const cfgDir = printerCfgPath.substring(0, printerCfgPath.lastIndexOf('/') + 1);
            // 已加载文件集合（防循环引用）
            const loadedFiles = new Set([printerCfgPath]);

            status.innerHTML = `<span style="color:var(--primary-color)"><i class="fas fa-spinner fa-spin"></i> 发现 ${includePatterns.length} 个 include 指令，正在递归加载...</span>`;

            // 3. 递归加载所有 include 文件（最大深度 5）
            const includeContent = await recursiveLoadIncludes(
                includePatterns, cfgDir, loadedFiles, 0, 5,
                (msg) => {
                    status.innerHTML = `<span style="color:var(--primary-color)"><i class="fas fa-spinner fa-spin"></i> ${kpEscapeHtml(msg)}</span>`;
                }
            );
            mergedContent += includeContent;
        }

        // 4. 填入文本框
        configInput.value = mergedContent;

        // 5. 尝试加载 mainsail.cfg 作为宏基准
        try {
            const msResp = await fetch('/api/tools/mainsail-config');
            if (!msResp.ok) throw new Error(`HTTP ${msResp.status}`);
            const msData = await msResp.json();
            if (msData.success) {
                _mainsailBaseline = msData.content;
            } else {
                _mainsailBaseline = '';
            }
        } catch (e) {
            _mainsailBaseline = '';
        }

        // 6. 触发解析
        const parseBtn = document.getElementById('parseBtn');
        if (parseBtn) parseBtn.click();

        status.innerHTML = `<span style="color:var(--success-color)"><i class="fas fa-check-circle"></i> 已加载 printer.cfg 及所有 include 文件 (来源: ${kpEscapeHtml(sourceLabel)})</span>`;
    } catch (err) {
        status.innerHTML = `<span style="color:var(--danger-color)"><i class="fas fa-exclamation-circle"></i> 加载失败: ${kpEscapeHtml(err.message)}</span>`;
    }
}

/** 手动加载指定远程配置文件内容到解析器（不包含 include 解析） */
async function loadRemoteConfig(filePath) {
    const status = document.getElementById('remoteLoadStatus');
    const configInput = document.getElementById('configInput');

    status.innerHTML = '<span style="color:var(--primary-color)"><i class="fas fa-spinner fa-spin"></i> 正在读取文件...</span>';

    try {
        const resp = await fetch('/api/tools/config-content', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: filePath })
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.json();

        if (!data.success) {
            status.innerHTML = `<span style="color:var(--danger-color)"><i class="fas fa-exclamation-circle"></i> ${kpEscapeHtml(data.error)}</span>`;
            return;
        }

        configInput.value = data.content;

        const parseBtn = document.getElementById('parseBtn');
        if (parseBtn) parseBtn.click();

        status.innerHTML = `<span style="color:var(--success-color)"><i class="fas fa-check-circle"></i> 已加载: ${kpEscapeHtml(data.filename)} (来源: ${kpEscapeHtml(data.source)})</span>`;
    } catch (err) {
        status.innerHTML = `<span style="color:var(--danger-color)"><i class="fas fa-exclamation-circle"></i> 读取失败: ${kpEscapeHtml(err.message)}</span>`;
    }
}

/** 从被控机器更新 mainsail.cfg 基准文件 */
async function updateMainsailBaseline() {
    const btn = document.getElementById('updateBaselineBtn');
    const status = document.getElementById('baselineStatus');

    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 更新中...';
    status.innerHTML = '<span style="color:var(--primary-color)"><i class="fas fa-spinner fa-spin"></i> 正在从被控机器获取 mainsail.cfg...</span>';

    try {
        const resp = await fetch('/api/tools/mainsail-config/update', { method: 'POST' });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.json();

        if (data.success) {
            status.innerHTML = `<span style="color:var(--success-color)"><i class="fas fa-check-circle"></i> ${kpEscapeHtml(data.message)}，包含 ${kpEscapeHtml(data.macro_count)} 个宏</span>`;
            // 重新加载基准到内存
            const msResp = await fetch('/api/tools/mainsail-config');
            if (msResp.ok) {
                const msData = await msResp.json();
                if (msData.success) {
                    _mainsailBaseline = msData.content;
                }
            }
        } else {
            status.innerHTML = `<span style="color:var(--danger-color)"><i class="fas fa-exclamation-circle"></i> ${kpEscapeHtml(data.error)}</span>`;
        }
    } catch (err) {
        status.innerHTML = `<span style="color:var(--danger-color)"><i class="fas fa-exclamation-circle"></i> 请求失败: ${kpEscapeHtml(err.message)}</span>`;
    } finally {
        btn.disabled = false;
        btn.innerHTML = '<i class="fas fa-sync-alt"></i> 更新宏基准';
    }
}

// ==================== 配置检查功能 ====================

/** 全局变量：存储 mainsail.cfg 基准内容 */
let _mainsailBaseline = '';

/** 解析合并后的配置内容，提取所有 section 及其来源文件和行号 */
function parseMergedSections(config) {
    const lines = config.split('\n');
    const sections = [];
    let currentFile = 'printer.cfg';
    let currentSection = null;
    let currentContent = [];
    let sectionStartLine = 0;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();

        // 检测来源文件标记
        const fileMatch = trimmed.match(/^#\s*=+\s*\[include\s+(.+?)\]\s*=+$/);
        if (fileMatch) {
            if (currentSection) {
                sections.push({ name: currentSection, file: currentFile, content: currentContent.join('\n'), line: sectionStartLine });
            }
            currentFile = fileMatch[1];
            currentSection = null;
            currentContent = [];
            continue;
        }
        // 主配置标记
        if (trimmed.match(/^#\s*=+\s*printer\.cfg.*=+$/)) {
            if (currentSection) {
                sections.push({ name: currentSection, file: currentFile, content: currentContent.join('\n'), line: sectionStartLine });
            }
            currentFile = 'printer.cfg';
            currentSection = null;
            currentContent = [];
            continue;
        }

        if (trimmed.startsWith('[') && trimmed.endsWith(']') && !trimmed.startsWith('[#')) {
            if (currentSection) {
                sections.push({ name: currentSection, file: currentFile, content: currentContent.join('\n'), line: sectionStartLine });
            }
            currentSection = trimmed.slice(1, -1).trim();
            currentContent = [];
            sectionStartLine = i + 1;
        } else if (currentSection && !trimmed.startsWith('#') && trimmed !== '') {
            currentContent.push(trimmed);
        }
    }
    if (currentSection) {
        sections.push({ name: currentSection, file: currentFile, content: currentContent.join('\n'), line: sectionStartLine });
    }
    return sections;
}

/** 检查1：检测重复配置段 */
function checkDuplicateSections(sections) {
    const sectionMap = {};
    sections.forEach(s => {
        if (!sectionMap[s.name]) sectionMap[s.name] = [];
        sectionMap[s.name].push(s);
    });

    const duplicates = [];
    for (const [name, instances] of Object.entries(sectionMap)) {
        if (instances.length > 1) {
            const allSame = instances.every(inst => inst.content.trim() === instances[0].content.trim());
            duplicates.push({
                name, count: instances.length,
                files: instances.map(i => i.file),
                lines: instances.map(i => i.line),
                sameContent: allSame
            });
        }
    }
    return duplicates;
}

/** 检查2：检测引脚和资源冲突 */
function checkPinConflicts(config) {
    const lines = config.split('\n');
    const pinAssignments = [];
    const uartAssignments = [];
    let currentSection = '';
    let currentFile = 'printer.cfg';

    const pinKeys = ['step_pin', 'dir_pin', 'enable_pin', 'endstop_pin', 'sensor_pin', 'heater_pin', 'cs_pin', 'uart_pin', 'pin', 'control_pin'];

    for (const line of lines) {
        const trimmed = line.trim();
        const fileMatch = trimmed.match(/^#\s*=+\s*\[include\s+(.+?)\]\s*=+$/);
        if (fileMatch) { currentFile = fileMatch[1]; continue; }
        if (trimmed.match(/^#\s*=+\s*printer\.cfg.*=+$/)) { currentFile = 'printer.cfg'; continue; }

        if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
            currentSection = trimmed.slice(1, -1).trim();
            continue;
        }
        if (trimmed.startsWith('#') || trimmed === '') continue;
        const cleanLine = trimmed.split('#')[0].trim();
        const colonIdx = cleanLine.indexOf(':');
        if (colonIdx < 0) continue;
        const key = cleanLine.substring(0, colonIdx).trim().toLowerCase();
        const value = cleanLine.substring(colonIdx + 1).trim();

        if (pinKeys.includes(key)) {
            const cleanVal = value.split('#')[0].trim();
            if (cleanVal.toLowerCase() === 'host:none' || cleanVal.toLowerCase().includes('virtual_endstop')) continue;
            pinAssignments.push({ pin: cleanVal, section: currentSection, key, file: currentFile });
        }
        if (key === 'uart_pin') {
            uartAssignments.push({ pin: value.split('#')[0].trim(), section: currentSection, file: currentFile });
        }
    }

    const warnings = [];
    // 检查引脚重复分配
    const pinMap = {};
    pinAssignments.forEach(pa => {
        const key = pa.pin.toLowerCase();
        if (!pinMap[key]) pinMap[key] = [];
        pinMap[key].push(pa);
    });
    for (const [pin, assignments] of Object.entries(pinMap)) {
        if (assignments.length > 1) {
            const uniqueSections = [...new Set(assignments.map(a => a.section))];
            if (uniqueSections.length > 1) {
                warnings.push({
                    type: 'pin', pin,
                    sections: assignments.map(a => `${a.section} (${a.key})`),
                    files: [...new Set(assignments.map(a => a.file))]
                });
            }
        }
    }
    // 检查 UART 冲突
    const uartMap = {};
    uartAssignments.forEach(ua => {
        const key = ua.pin.toLowerCase();
        if (!uartMap[key]) uartMap[key] = [];
        uartMap[key].push(ua);
    });
    for (const [pin, assignments] of Object.entries(uartMap)) {
        if (assignments.length > 1) {
            const uniqueSections = [...new Set(assignments.map(a => a.section))];
            if (uniqueSections.length > 1) {
                warnings.push({
                    type: 'uart', pin,
                    sections: assignments.map(a => a.section),
                    files: [...new Set(assignments.map(a => a.file))]
                });
            }
        }
    }
    return warnings;
}

/** 从配置内容中提取所有 gcode_macro 定义 */
function extractMacros(content) {
    const macros = {};
    const lines = content.split('\n');
    let currentMacro = null;
    let currentLines = [];

    for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.match(/^\[gcode_macro\s+/i)) {
            if (currentMacro) macros[currentMacro] = currentLines.join('\n');
            const match = trimmed.match(/^\[gcode_macro\s+(.+?)\]$/i);
            currentMacro = match ? match[1].trim() : null;
            currentLines = [trimmed];
        } else if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
            if (currentMacro) macros[currentMacro] = currentLines.join('\n');
            currentMacro = null;
            currentLines = [];
        } else if (currentMacro) {
            currentLines.push(line);
        }
    }
    if (currentMacro) macros[currentMacro] = currentLines.join('\n');
    return macros;
}

/** 比较两个宏内容的差异，返回差异摘要 */
function diffMacroContent(baseline, current) {
    const bLines = baseline.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
    const cLines = current.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
    const bSet = new Set(bLines);
    const cSet = new Set(cLines);
    const added = cLines.filter(l => !bSet.has(l));
    const removed = bLines.filter(l => !cSet.has(l));
    return { added: added.slice(0, 5), removed: removed.slice(0, 5), totalAdded: added.length, totalRemoved: removed.length };
}

/** 检查3：以 mainsail.cfg 为基准检查被修改的宏 */
function checkMacroModifications(mergedContent, mainsailContent) {
    if (!mainsailContent) return { skipped: true, reason: '未找到 mainsail.cfg 基准文件' };

    const baselineMacros = extractMacros(mainsailContent);
    const currentMacros = extractMacros(mergedContent);
    const macroNames = Object.keys(baselineMacros);

    if (macroNames.length === 0) return { skipped: true, reason: 'mainsail.cfg 中未找到 gcode_macro 定义' };

    const results = [];
    for (const name of macroNames) {
        if (currentMacros[name]) {
            const bContent = baselineMacros[name].trim();
            const cContent = currentMacros[name].trim();
            if (bContent === cContent) {
                results.push({ name, status: 'unchanged' });
            } else {
                const diff = diffMacroContent(baselineMacros[name], currentMacros[name]);
                results.push({ name, status: 'modified', diff });
            }
        } else {
            results.push({ name, status: 'missing' });
        }
    }
    // 检查用户自定义的额外宏（不在 mainsail.cfg 中的）
    const extraMacros = Object.keys(currentMacros).filter(n => !baselineMacros[n]);
    return { results, extraCount: extraMacros.length, extraNames: extraMacros.slice(0, 10) };
}

/** 生成配置检查报告 HTML */
function buildCheckReportHTML(duplicates, conflicts, macroCheck) {
    let html = '<div class="config-check-report">';
    html += '<h3 style="display:flex;align-items:center;margin-bottom:15px;"><i class="fas fa-clipboard-check" style="margin-right:10px;color:var(--primary-color)"></i> 配置检查报告</h3>';

    // === 重复配置检查 ===
    html += '<div class="check-item">';
    if (duplicates.length === 0) {
        html += '<div class="check-header check-pass"><i class="fas fa-check-circle"></i> 重复配置检查：通过 <span class="check-desc">未发现重复的配置段</span></div>';
    } else {
        html += `<div class="check-header check-error"><i class="fas fa-times-circle"></i> 重复配置检查：发现 ${duplicates.length} 个重复段 <button class="check-toggle" onclick="this.parentElement.parentElement.querySelector('.check-detail').classList.toggle('open')">查看详情</button></div>`;
        html += '<div class="check-detail"><ul class="check-list">';
        duplicates.forEach(d => {
            const statusCls = d.sameContent ? 'check-warn' : 'check-err';
            const statusText = d.sameContent ? '内容相同' : '内容不一致';
            const files = (d.files || []).map(kpEscapeHtml).join(', ');
            html += `<li class="${statusCls}"><strong>[${kpEscapeHtml(d.name)}]</strong> 出现 ${kpEscapeHtml(d.count)} 次 (${statusText})<br><span class="check-files">来源: ${files}</span></li>`;
        });
        html += '</ul></div>';
    }
    html += '</div>';

    // === 冲突检查 ===
    html += '<div class="check-item">';
    if (conflicts.length === 0) {
        html += '<div class="check-header check-pass"><i class="fas fa-check-circle"></i> 引脚/资源冲突检查：通过 <span class="check-desc">未发现引脚或资源冲突</span></div>';
    } else {
        html += `<div class="check-header check-error"><i class="fas fa-times-circle"></i> 引脚/资源冲突检查：发现 ${conflicts.length} 个冲突 <button class="check-toggle" onclick="this.parentElement.parentElement.querySelector('.check-detail').classList.toggle('open')">查看详情</button></div>`;
        html += '<div class="check-detail"><ul class="check-list">';
        conflicts.forEach(c => {
            const icon = c.type === 'pin' ? '引脚' : 'UART';
            const typeLabel = c.type === 'pin' ? '引脚' : 'UART';
            const sections = (c.sections || []).map(kpEscapeHtml).join(' | ');
            const files = (c.files || []).map(kpEscapeHtml).join(', ');
            html += `<li class="check-err">${icon} <strong>${kpEscapeHtml(c.pin)}</strong> (${typeLabel}) 被多个 section 占用: ${sections}<br><span class="check-files">来源: ${files}</span></li>`;
        });
        html += '</ul></div>';
    }
    html += '</div>';

    // === 宏修改检查 ===
    html += '<div class="check-item">';
    if (macroCheck.skipped) {
        html += `<div class="check-header check-warn"><i class="fas fa-exclamation-triangle"></i> 宏修改检查：跳过 <span class="check-desc">${kpEscapeHtml(macroCheck.reason)}</span></div>`;
    } else {
        const modified = macroCheck.results.filter(r => r.status === 'modified');
        const missing = macroCheck.results.filter(r => r.status === 'missing');
        const unchanged = macroCheck.results.filter(r => r.status === 'unchanged');

        if (modified.length === 0 && missing.length === 0) {
            html += `<div class="check-header check-pass"><i class="fas fa-check-circle"></i> 宏修改检查：通过 <span class="check-desc">所有 ${unchanged.length} 个 mainsail 宏均未被修改</span></div>`;
        } else {
            const totalIssues = modified.length + missing.length;
            html += `<div class="check-header check-error"><i class="fas fa-times-circle"></i> 宏修改检查：发现 ${totalIssues} 个问题 <button class="check-toggle" onclick="this.parentElement.parentElement.querySelector('.check-detail').classList.toggle('open')">查看详情</button></div>`;
            html += '<div class="check-detail"><ul class="check-list">';
            modified.forEach(m => {
                let diffHtml = '';
                if (m.diff.totalAdded > 0) diffHtml += `<span style="color:var(--success-color)">+${m.diff.totalAdded}行</span> `;
                if (m.diff.totalRemoved > 0) diffHtml += `<span style="color:var(--danger-color)">-${m.diff.totalRemoved}行</span>`;
                html += `<li class="check-warn">宏 <strong>[${kpEscapeHtml(m.name)}]</strong> 已被修改 (${diffHtml})`;
                if (m.diff.added.length > 0) html += `<br><span class="check-diff">新增: ${m.diff.added.map(l => `<code>${kpEscapeHtml(l.substring(0, 60))}</code>`).join(', ')}</span>`;
                if (m.diff.removed.length > 0) html += `<br><span class="check-diff">移除: ${m.diff.removed.map(l => `<code>${kpEscapeHtml(l.substring(0, 60))}</code>`).join(', ')}</span>`;
                html += '</li>';
            });
            missing.forEach(m => {
                html += `<li class="check-err">缺失 <strong>[${kpEscapeHtml(m.name)}]</strong> 在用户配置中缺失</li>`;
            });
            html += '</ul>';
            if (macroCheck.extraCount > 0) {
                const extraNames = (macroCheck.extraNames || []).map(kpEscapeHtml).join(', ');
                html += `<div class="check-extra-info"><i class="fas fa-plus-circle"></i> 用户额外定义了 ${kpEscapeHtml(macroCheck.extraCount)} 个自定义宏: ${extraNames}${macroCheck.extraCount > 10 ? '...' : ''}</div>`;
            }
            html += '</div>';
        }
    }
    html += '</div>';

    html += '</div>';
    return html;
}
