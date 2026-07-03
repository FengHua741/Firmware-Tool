/**
 * Klipper配置生成器 v3 - 基于板卡引脚映射自动生成完整 printer.cfg
 */
// 机型预设 - 从 JSON 文件动态加载
let _machinePresets = {};
let _currentPreset = null;
let _machineList = [];
const EXT_PRESETS = {
    'bondtech_5mm':{name:'Bondtech 5mm Gear',rotation_distance:22.6789522,microsteps:16,sensor_type:'NTC 100K beta 3950',max_temp:285,desc:'Stealthburner 标配'},
    'sherpa_mini':{name:'Sherpa Mini',rotation_distance:22.85,microsteps:16,sensor_type:'NTC 100K beta 3950',max_temp:285,desc:'SB2040 工具板'},
    'galileo':{name:'Galileo',rotation_distance:47.088,microsteps:16,sensor_type:'NTC 100K beta 3950',max_temp:285,desc:'Voron 2.4 标准挤出机'},
    'creality':{name:'Creality Standard',rotation_distance:33.500,microsteps:16,sensor_type:'EPCOS 100K B57560G104F',max_temp:250,desc:'Ender-3'},
    'bmg_dual':{name:'BMG Dual Gear',rotation_distance:7.84,microsteps:16,sensor_type:'NTC 100K beta 3950',max_temp:285,desc:'标准 BMG 挤出机'},
    'hemera':{name:'Hemera',rotation_distance:7.82,microsteps:16,sensor_type:'ATC Semitec 104GT-2',max_temp:285,desc:'E3D Hemera'},
    'custom':{name:'Custom（自定义）',rotation_distance:null,microsteps:null,sensor_type:null,max_temp:null,desc:'手动输入参数'},
};
const PROBE_PRESETS = {
    'bltouch':{name:'BL-Touch',z_offset:2.0,needs_servo:true,section:'bltouch',desc:'需要 sensor_pin + control_pin(servo)'},
    'klicky':{name:'Klicky Probe',z_offset:2.0,needs_servo:false,section:'probe',desc:'机械式探针，需要 klicky 宏'},
    'euclid':{name:'Euclid Probe',z_offset:2.0,needs_servo:false,section:'probe',desc:'类似 Klicky，需要 euclid 宏'},
    'voron_tap':{name:'Voron Tap',z_offset:0,needs_servo:false,section:'probe',desc:'使用喷嘴作为探针，需要 tap 宏'},
    'inductive':{name:'Inductive Probe',z_offset:2.0,needs_servo:false,section:'probe',desc:'电感探针（标准）'},
    'none':{name:'不使用探针',z_offset:null,needs_servo:false,section:null,desc:''},
};
const ALL_AXES = ['X','X1','Y','Y1','Z','Z1','Z2','Z3','E','E1'];
// 常用热敏传感器型号（Klipper 官方支持列表）
const SENSOR_TYPES = [
    'NTC 100K beta 3950',
    'Generic 3950',
    'EPCOS 100K B57560G104F',
    'ATC Semitec 104GT-2',
    'ATC Semitec 104NT-4-R025H42G',
    'Honeywell 100K 135-104LAG-J01',
    'NTC 100K MGB18-104F39050L32',
    'PT1000',
    'PT100',
    'Slice Engineering 450',
];

// ========== 术语中文化字典 ==========
const TERM_I18N = {
  'rotation_distance':{label:'旋转距离',hint:'步进电机主动轮转一圈皮带/耗材移动的距离(mm)。\n常见值：GT2 20齿=40mm，BMG挤出机=22.68mm',def:'40 (CoreXY)'},
  'microsteps':{label:'微步细分',hint:'步进电机驱动器的微步细分值。推荐16。\nTMC2209支持16/32，TMC5160支持16/32/64。',def:'16'},
  'homing_speed':{label:'归位速度 (mm/s)',hint:'轴归位时向限位开关移动的速度。\n建议 XY: 50-100, Z: 10-20',def:'50'},
  'position_min':{label:'最小行程 (mm)',hint:'轴可移动的最小坐标值（软限位）。\n通常 X/Y=0, Z=-2~0',def:'0'},
  'position_max':{label:'最大行程 (mm)',hint:'轴可移动的最大坐标值。\n等于你的打印机该轴的实际行程长度',def:'由机型决定'},
  'position_endstop':{label:'限位位置 (mm)',hint:'触发限位开关时轴所处的坐标值。\n负方向归位=0，正方向归位=position_max',def:'由归位方向决定'},
  'homing_retract_dist':{label:'归位后退 (mm)',hint:'归位触发后轴退回的距离，防止再次撞击限位',def:'5'},
  'second_homing_speed':{label:'二次归位速度',hint:'第二次归位时的较慢速度，提高精度',def:'自动'},
  'homing_positive_dir':{label:'归位方向',hint:'正方向(true)=向max端归位，负方向(false)=向min端归位',def:'XY正Z负'},
  'full_steps_per_rotation':{label:'电机步数/转',hint:'步进电机每转的步数。1.8度=200，0.9度=400',def:'200 (1.8°)'},
  'pressure_advance':{label:'压力提前',hint:'补偿挤出机压力延迟的参数。\n建议从0.05开始调试，PLA通常0.04-0.08',def:'0.05'},
  'gear_ratio':{label:'减速比',hint:'挤出机齿轮减速比。\nBMG=50:17，Galileo=留空/不使用',def:'BMG: 50:17'},
  'sensor_type':{label:'热敏电阻型号',hint:'温度传感器的型号。\nNTC 100K beta 3950 是最常见的',def:'NTC 100K beta 3950'},
  'max_temp':{label:'最高温度 (℃)',hint:'加热器允许达到的最高温度，安全保护用',def:'挤出机285/热床120'},
  'min_temp':{label:'最低温度 (℃)',hint:'低于此温度时Klipper会报错停止。\n-235 表示禁用最低温度检测（FLY推荐）',def:'-235'},
  'max_power':{label:'最大功率',hint:'加热器的最大输出功率比例 0.0~1.0',def:'1.0'},
  'control':{label:'温控模式',hint:'watermark=开关控制(简单稳定)\npid= PID 精确控制(需自动调谐)',def:'watermark'},
  'filament_diameter':{label:'耗材直径 (mm)',hint:'使用的耗材直径。标准值为1.75mm',def:'1.75'},
  'nozzle_diameter':{label:'喷嘴直径 (mm)',hint:'打印喷嘴的孔径',def:'0.4'},
};

let _boardsIndex = null, _currentMapping = null, _currentBoardInfo = null;
let _toolboardData = [], _cgCurrentConfig = '', _cgHomingDirs = {};
let _extraHeaterCount = 0; // 额外加热器计数

function cgShowToast(msg, type='success') {
    let t = document.getElementById('toastGen');
    if (!t) { t = document.createElement('div'); t.id = 'toastGen'; t.className = 'toast-gen'; document.body.appendChild(t); }
    t.innerHTML = `<i class="fas ${type==='success'?'fa-check-circle':type==='error'?'fa-exclamation-circle':'fa-exclamation-triangle'}"></i> ${msg}`;
    t.className = `toast-gen ${type}`; t.classList.add('show');
    setTimeout(() => t.classList.remove('show'), 3000);
}

// ========== 初始化 ==========
function initConfigGenerator() {
    if (window._configGeneratorInited) return;
    window._configGeneratorInited = true;
    loadMachinePresets();
    loadBoardIndex();
}

// ========== 选项卡切换 ==========
function switchCgTab(n) {
    document.querySelectorAll('.cg-tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab == n));
    document.querySelectorAll('.cg-tab-panel').forEach(p => p.classList.toggle('active', p.dataset.tab == n));
}

// ========== 连接方式切换修复 ==========
function onConnectionTypeChange() {
    const v = document.getElementById('cgConnection').value;
    const h = document.getElementById('cgSerialHint');
    const baud = document.getElementById('cgBaud');
    const baudLabel = document.getElementById('cgBaudLabel');
    const serial = document.getElementById('cgSerial');
    if (v === 'can') {
        if (h) h.textContent = 'CAN连接: canbus_uuid=xxx（16进制字符串）';
        if (baud) { baud.style.display = 'none'; }
        if (baudLabel) { baudLabel.style.display = 'none'; }
        if (serial) serial.placeholder = 'canbus_uuid，例如 3a8e2d4c1f05';
    } else if (v === 'usb') {
        if (h) h.textContent = 'USB: /dev/serial/by-id/usb-...';
        if (baud) { baud.style.display = ''; }
        if (baudLabel) { baudLabel.style.display = ''; }
        if (serial) serial.placeholder = '/dev/serial/by-id/usb-xxx';
    } else {
        if (h) h.textContent = '串口: /dev/serial/by-id/...';
        if (baud) { baud.style.display = ''; }
        if (baudLabel) { baudLabel.style.display = ''; }
        if (serial) serial.placeholder = '/dev/serial/by-id/...';
    }
}


async function loadBoardIndex() {
    try {
        const r = await fetch('/api/tools/boards');
        const d = await r.json();
        if (!d.success) { cgShowToast('加载板卡数据失败','error'); return; }
        _boardsIndex = d.brands; populateBrands();
    } catch (e) { cgShowToast('无法连接服务器','error'); }
}
async function loadMachinePresets() {
    try {
        const r = await fetch('/api/tools/machines');
        const d = await r.json();
        if (!d.success) return;
        _machineList = d.machines;
        d.machines.forEach(m => { _machinePresets[m.id] = m; });
        populatePrinterModels();
    } catch (e) { console.error('加载机型预设失败', e); }
}
function populatePrinterModels() {
    const sel = document.getElementById('cgPrinterModel');
    if (!sel || !_machineList.length) return;
    sel.innerHTML = '';
    _machineList.forEach(m => {
        sel.innerHTML += `<option value="${m.id}">${m.name} (${m.drive_count}驱动, ${m.geometry?.type||'?'})</option>`;
    });
    sel.innerHTML += `<option value="custom">✏️ 自定义打印机</option>`;
    if (_machineList.length > 0) { _loadFullPreset(_machineList[0].id); }
}
async function _loadFullPreset(machineId) {
    try {
        const r = await fetch(`/api/tools/machines/${machineId}`);
        const d = await r.json();
        if (d.success) { _currentPreset = d.preset; }
    } catch (e) { console.error('加载预设详情失败', e); }
}
function populateBrands() {
    const sel = document.getElementById('cgBrand'); sel.innerHTML = '';
    for (const b of Object.keys(_boardsIndex)) sel.innerHTML += `<option value="${b}"${b==='FLY'?' selected':''}>${b}</option>`;
    populateBoards();
}
function onBrandChange() { populateBoards(); }
function populateBoards() {
    const brand = document.getElementById('cgBrand').value || 'FLY';
    const bd = _boardsIndex[brand]; if (!bd) return;
    const bs = document.getElementById('cgBoard');
    bs.innerHTML = '<option value="">-- 选择型号 --</option>';
    for (const [bid,info] of Object.entries(bd.mainboards)) bs.innerHTML += `<option value="${bid}">${info.name} (${info.drive_count}驱动, ${info.platform})</option>`;
    const tbs = Object.keys(bd.toolboards);
    if (tbs.length > 0) {
        bs.innerHTML += `<optgroup label="工具板">`;
        for (const [bid,info] of Object.entries(bd.toolboards)) bs.innerHTML += `<option value="${bid}">${info.name} (${info.drive_count}驱动, ${info.platform})</option>`;
        bs.innerHTML += `</optgroup>`;
    }
}
async function onBoardChange() {
    const boardId = document.getElementById('cgBoard').value;
    if (!boardId) { _currentMapping=null; _currentBoardInfo=null; resetConfigPanels(); return; }
    try {
        const r = await fetch(`/api/tools/boards/${boardId}/mapping`);
        const d = await r.json();
        if (!d.success) { cgShowToast(d.error,'error'); return; }
        _currentMapping = d.mapping; _currentBoardInfo = d.board_info;
        const info = _currentBoardInfo;
        document.getElementById('cgBoardInfo').innerHTML = `<span>MCU: ${info.mcu}</span> | <span>${info.drive_count}驱动</span> | <span>${info.heat_count}加热</span> | <span>${info.fan_count}风扇</span>`;
        // 加载板卡图片
        const imgContainer = document.getElementById('cgBoardImageContainer');
        const imgEl = document.getElementById('cgBoardImage');
        if (info.image && imgContainer && imgEl) {
            imgEl.src = `/api/tools/boards/${boardId}/image`;
            imgContainer.style.display = 'block';
        } else if (imgContainer) {
            imgContainer.style.display = 'none';
        }
        populateConnections(info.connections);
        renderDriverAssignment(); renderMotionParams();
        renderHeaterConfig(); renderFanConfig(); renderExtruderParams(); renderBedParams();
        renderEndstopConfig(); renderProbeConfig();
        renderHomingParams(); renderLevelingParams();
        smartAutoAssign();
    } catch (e) { cgShowToast('加载板卡数据失败: '+e.message,'error'); }
}
function populateConnections(connections) {
    const sel = document.getElementById('cgConnection'); sel.innerHTML = '';
    for (const c of connections) { const v=c.includes('CAN')?'can':c.includes('USB')?'usb':'serial'; sel.innerHTML += `<option value="${v}">${c}</option>`; }
    onConnectionTypeChange();
}

// ========== MCU 自动检测 ==========
async function detectMcuDevices() {
    const btn = document.getElementById('cgDetectBtn');
    if (!btn) return;
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 扫描中...';
    try {
        // 本地扫描串口设备
        let devices = [];
        try {
            const r = await fetch('/api/tools/detect-mcus');
            const d = await r.json();
            if (d.success && d.devices) devices = d.devices;
        } catch(e) {}
        if (!devices.length) {
            cgShowToast('未检测到设备，请在MCU serial框手动输入', 'warning');
            return;
        }
        const serialInput = document.getElementById('cgSerial');
        const hint = document.getElementById('cgSerialHint');
        // 如果只有一个设备，直接自动填入
        if (devices.length === 1 && serialInput) {
            const dev = devices[0];
            serialInput.value = dev.path;
            const connEl = document.getElementById('cgConnection');
            if (connEl && dev.type) connEl.value = dev.type;
            if (hint) hint.textContent = '✅ 已自动检测: ' + dev.description;
            cgShowToast('已自动填入检测到的设备: '+dev.description, 'success');
            return;
        }
        // 多个设备：弹出选择下拉
        const container = serialInput.parentNode;
        const sel = document.createElement('select');
        sel.id = 'cgSerialSelect';
        sel.style.cssText = 'flex:1;min-width:200px;padding:8px 10px;border:1px solid var(--border-color);border-radius:6px;font-size:14px;';
        sel.innerHTML = '<option value="">-- 选择检测到的设备 --</option>';
        devices.forEach(dev => {
            const icons = {can:'🔗 CAN', usb:'🔌 USB', serial:'📡 串口'};
            sel.innerHTML += `<option value="${dev.path}" data-type="${dev.type||'serial'}">${icons[dev.type]||'🔌'}: ${dev.description||dev.path}</option>`;
        });
        serialInput.style.display = 'none';
        container.insertBefore(sel, serialInput.nextSibling);
        sel.onchange = function() {
            serialInput.value = this.value;
            const connType = this.selectedOptions[0]?.dataset?.type || 'serial';
            const connEl = document.getElementById('cgConnection');
            if (connEl) connEl.value = connType;
            if (hint) hint.textContent = '已选择: '+ (this.selectedOptions[0]?.text||this.value);
            serialInput.style.display = '';
            sel.remove();
        };
        cgShowToast('检测到 '+devices.length+' 个设备，请选择', 'info');
    } finally {
        btn.disabled = false;
        btn.innerHTML = '<i class="fas fa-search"></i> 自动检测';
    }
}

function resetConfigPanels() {
    const p='<p style="color:var(--text-secondary);text-align:center;">请先选择主板</p>';
    const p2='<p style="color:var(--text-secondary);text-align:center;">请先选择主板和打印机型号</p>';
    const ids=['cgDriverContainer','cgMotionContainer','cgHeaterContainer','cgFanContainer','cgExtruderParamContainer','cgBedParamContainer','cgEndstopContainer','cgProbeContainer','cgHomingContainer','cgLevelingContainer'];
    ids.forEach(id=>{const el=document.getElementById(id);if(el)el.innerHTML=p;});
    const motion=document.getElementById('cgMotionContainer');if(motion)motion.innerHTML=p2;
    const homing=document.getElementById('cgHomingContainer');if(homing)homing.innerHTML=p2;
    document.getElementById('cgToolboardSection').innerHTML='';
}

// ========== 帮助系统 ==========
function showFieldHelp(el) {
    const existing = document.querySelector('.cg-help-popover');
    if (existing) existing.remove();
    const popover = document.createElement('div');
    popover.className = 'cg-help-popover';
    popover.innerHTML = el.dataset.help.replace(/\n/g, '<br>');
    const rect = el.getBoundingClientRect();
    popover.style.left = Math.min(rect.left, window.innerWidth - 360) + 'px';
    popover.style.top = (rect.bottom + 8) + 'px';
    document.body.appendChild(popover);
    setTimeout(() => {
        const handler = function(e) {
            if (!popover.contains(e.target) && e.target !== el) {
                popover.remove(); document.removeEventListener('click', handler);
            }
        };
        document.addEventListener('click', handler);
    }, 0);
}
function toggleParamSection(header) {
    const body = header.nextElementSibling;
    if (body) {
        body.classList.toggle('collapsed');
        header.classList.toggle('collapsed');
    }
}
// 将参数容器的各 h4+内容自动包装为可折叠面板
function _wrapCollapsibleSections(container) {
    if (!container) return;
    const titles = container.querySelectorAll('h4.cg-section-title');
    titles.forEach(title => {
        // 收集该标题后的所有兄弟元素直到下一个 h4
        const section = document.createElement('div');
        section.className = 'cg-param-section';
        const header = document.createElement('div');
        header.className = 'cg-param-section-header';
        header.innerHTML = '<span>' + title.innerHTML + '</span><i class="fas fa-chevron-down"></i>';
        header.onclick = function() { toggleParamSection(this); };
        const body = document.createElement('div');
        body.className = 'cg-param-section-body';
        title.parentNode.insertBefore(section, title);
        section.appendChild(header);
        section.appendChild(body);
        let next = title.nextSibling;
        title.remove();
        // 收集直到下一个 h4 的所有节点
        while (next) {
            const nxt = next.nextSibling;
            if (next.nodeType === 1 && next.tagName === 'H4' && next.classList.contains('cg-section-title')) break;
            // 跳过已经是 cg-param-section 的包装元素
            if (next.nodeType === 1 && next.classList.contains('cg-param-section')) { nxt = next.nextSibling; continue; }
            body.appendChild(next);
            next = nxt;
        }
        // 高级部分默认折叠
        const advancedTitles = ['可选配置段', '加速度计', '热床网格校准', '温度监控', '打印宏'];
        const titleText = title.textContent;
        const isAdvanced = advancedTitles.some(at => titleText.includes(at));
        if (isAdvanced) {
            header.classList.add('collapsed');
            body.classList.add('collapsed');
        }
    });
}
function renderI18nField(id, termKey, value, extra) {
    const term = TERM_I18N[termKey];
    if (!term) return `<input type="text" id="${id}" value="${value}"${extra||''}>`;
    return `<label><span class="cg-field-label">${term.label}</span> <code class="cg-field-param">${termKey}</code><span class="cg-help-icon" data-help="${term.hint.replace(/"/g,'&quot;')}" onclick="showFieldHelp(this)">?</span></label><input type="text" id="${id}" value="${value}" placeholder="${term.def}"${extra||''}>`;
}
// 错误定位与友好提示
function cgHighlightError(fieldId, message) {
    const el = document.getElementById(fieldId);
    if (!el) return;
    el.classList.add('required');
    el.scrollIntoView({behavior:'smooth',block:'center'});
    el.focus();
    // 展开所在的可折叠面板
    let parent = el.closest('.cg-param-section-body.collapsed');
    if (parent) {
        parent.classList.remove('collapsed');
        const hdr = parent.previousElementSibling;
        if (hdr && hdr.classList.contains('cg-param-section-header')) hdr.classList.remove('collapsed');
    }
    setTimeout(() => el.classList.remove('required'), 5000);
    const errEl = document.getElementById('errorMessage');
    if (errEl) {
        errEl.innerHTML = '<i class="fas fa-exclamation-triangle"></i> ' + message;
        errEl.style.display = 'block';
    }
}

// ========== 智能填充 ==========
function smartAutoAssign() {
    resetMotionOverrides();  // 智能分配时重置手动覆盖
    const preset = _currentPreset;
    if (!preset || !preset.drives) { cgShowToast('请先选择打印机型号','error'); return; }
    const drives = []; for (let i=0;;i++){if(_currentMapping[`Drives${i}`])drives.push({key:`Drives${i}`,idx:i});else break;}
    preset.drives.forEach((drive, idx) => {
        const sel = document.getElementById(`cgAxis_${idx}`);
        if (sel && drive.axis) { sel.value = drive.axis; }
    });
    validateAxisAssignment();
    const m = _currentMapping;
    if (!m) return;
    if (m['BED_OUT']) { const el = document.getElementById('cgHeatPin_heater_bed'); if(el&&!el.value) el.value = 'BED_OUT'; }
    else if (m['bed-heat']) { const el = document.getElementById('cgHeatPin_heater_bed'); if(el&&!el.value) el.value = 'bed-heat'; }
    const extHeat=document.getElementById('cgHeatPin_extruder');
    if (extHeat && !extHeat.value) extHeat.value = 'heat0';
    ['stop0','stop1','stop2'].forEach((stop, i) => {
        const el = document.getElementById(`cgFunc_${stop}`);
        if (el && !el.value) el.value = ['x','y','z'][i];
    });
    const fan0El = document.getElementById('cgFanPin_part_fan');
    if (fan0El && !fan0El.value) fan0El.value = 'fan0';
    if (m.probe && preset.probe) {
        const probeEl = document.getElementById('cgProbeType');
        if (probeEl) probeEl.value = preset.probe.type || 'bltouch';
    }
    updateMotionParamsForModel();
    cgShowToast('已完成智能分配！你可以手动微调', 'success');
}

// ========== 打印机型号 ==========
async function onPrinterModelChange() {
    const modelId = document.getElementById('cgPrinterModel').value;
    if (!modelId) return;
    const customSection = document.getElementById('cgCustomPrinterSection');
    if (modelId === 'custom') {
        if (customSection) customSection.style.display = 'block';
        _currentPreset = { geometry:{type:'corexy'}, drives:[], extruder:{}, bed:{} };
        return;
    }
    if (customSection) customSection.style.display = 'none';
    await _loadFullPreset(modelId);
    if (_currentMapping) {
        renderDriverAssignment(); renderMotionParams();
        renderHeaterConfig(); renderFanConfig(); renderExtruderParams(); renderBedParams();
        renderEndstopConfig(); renderProbeConfig();
        renderHomingParams(); renderLevelingParams();
        smartAutoAssign();
    }
}
function updateMotionParamsForModel() {
    if (!_currentPreset) return;
    const p = _currentPreset;
    (p.drives||[]).forEach(drive => {
        if (drive.axis === 'E') return;
        const axis = drive.axis;
        const mapping = {rd:'rotation_distance',ms:'microsteps',hs:'homing_speed',min:'position_min',max:'position_max',es:'position_endstop'};
        Object.entries(mapping).forEach(([s,k]) => {
            const el = document.getElementById(`cgMotion_${axis}_${s}`);
            if (el && drive[k] != null) el.value = drive[k];
        });
    });
    const ext = p.extruder;
    if (ext) {
        [['cgExtRD','rotation_distance'],['cgExtMS','microsteps'],['cgExtFD','filament_diameter'],['cgExtND','nozzle_diameter'],['cgExtMaxT','max_temp'],['cgExtST','sensor_type']].forEach(([id,k]) => {
            const el = document.getElementById(id);
            if (el && ext[k] != null) el.value = ext[k];
        });
        const grEl = document.getElementById('cgExtGearRatio');
        if (grEl && ext.gear_ratio != null) grEl.value = ext.gear_ratio;
        const s = document.getElementById('cgExtModel');
        if (s) {
            let m = false;
            for (const [k,v] of Object.entries(EXT_PRESETS)) {
                if (k !== 'custom' && v.rotation_distance === ext.rotation_distance) { s.value = k; m = true; break; }
            }
            if (!m) s.value = 'custom';
        }
    }
    const bed = p.bed;
    if (bed) {
        const e1 = document.getElementById('cgBedST'); if (e1 && bed.sensor_type) e1.value = bed.sensor_type;
        const e2 = document.getElementById('cgBedMaxT'); if (e2 && bed.max_temp != null) e2.value = bed.max_temp;
    }
    // 更新可选段默认值
    const opt = p.optional_sections;
    if (opt) {
        const checks = {cgOptSafeZHome:'safe_z_home',cgOptForceMove:'force_move',cgOptVerifyHeater:'verify_heater',cgOptIdleTimeout:'idle_timeout',cgOptExcludeObj:'exclude_object',cgOptTempMonitor:'temperature_monitor',cgOptClientVariable:'client_variable',cgOptPrintMacros:'print_macros',cgOptAdxl345:'adxl345'};
        Object.entries(checks).forEach(([elId, key]) => {
            const el = document.getElementById(elId);
            if (el && opt[key] != null) { el.checked = opt[key]; toggleOptPanel(elId.replace('cgOpt','')); }
        });
        if(opt.adxl345) onAdxlTypeChange();
    }
}
function onExtModelChange() {
    const sel=document.getElementById('cgExtModel'); if(!sel) return;
    const p=EXT_PRESETS[sel.value]; if(!p||sel.value==='custom') return;
    // 同步全部挤出机字段
    [['cgExtRD','rotation_distance'],['cgExtMS','microsteps'],['cgExtFD','filament_diameter'],
     ['cgExtND','nozzle_diameter'],['cgExtST','sensor_type'],['cgExtMaxT','max_temp'],
     ['cgExtPA','pressure_advance'],['cgExtPASmooth','pressure_advance_smooth_time'],
     ['cgExtMaxDist','max_extrude_only_distance'],['cgExtMaxCross','max_extrude_cross_section'],
     ['cgExtMaxPower','max_power'],['cgExtGearRatio','gear_ratio']]
    .forEach(([id,k])=>{const el=document.getElementById(id);if(el&&p[k]!=null)el.value=p[k];});
    cgShowToast(`已切换为: ${p.name}`,'success');
}
function onProbeTypeChange() {
    const pt = document.getElementById('cgProbeType')?.value;
    const p = PROBE_PRESETS[pt];
    // 更新 z_offset 默认值
    if (p && p.z_offset != null) { const z = document.getElementById('cgZOffset'); if (z) z.value = p.z_offset; }
    // BL-Touch servo 区域
    const servoRow = document.getElementById('cgProbeServoRow');
    if (servoRow) servoRow.style.display = (pt === 'bltouch') ? '' : 'none';
    // 探针参数区域
    const params = document.getElementById('cgProbeParams');
    if (params) params.style.display = (pt === 'none') ? 'none' : '';
}

// ========== 工具板 ==========
function onToolCountChange() {
    const count = parseInt(document.getElementById('cgToolCount').value);
    const container = document.getElementById('cgToolboardConfig');
    const inner = document.getElementById('cgToolboardContainer');
    container.style.display = count>0?'block':'none'; inner.innerHTML='';
    _toolboardData = _toolboardData.slice(0, count);
    const brand = document.getElementById('cgBrand').value || 'FLY';
    for (let i=0; i<count; i++) {
        if (!_toolboardData[i]) _toolboardData[i] = {boardId:'',name:`TB${i}`,connType:'can',serial:'',mapping:null,boardInfo:null,axes:[],funcAssigns:{}};
        const tb=_toolboardData[i], div=document.createElement('div');
        div.className='cg-tb-block';
        div.innerHTML = `<div class="cg-tb-header" onclick="toggleToolboardPanel(${i})"><span><i class="fas fa-microchip"></i> 工具板 ${i+1}: <strong id="cgTBTitle${i}">${tb.name}</strong></span><span class="cg-tb-toggle"><i class="fas fa-chevron-down"></i></span></div>
        <div id="cgTBPanel${i}" class="cg-tb-panel" style="display:none;">
            <div class="cg-row"><label>名称：</label><input type="text" id="cgTBName${i}" value="${tb.name}" style="width:100px;" oninput="_toolboardData[${i}].name=this.value;document.getElementById('cgTBTitle${i}').textContent=this.value">
            <label>型号：</label><select id="cgTBBoard${i}" onchange="onToolBoardSelect(${i})" style="min-width:200px;"><option value="">选择工具板型号</option></select><span id="cgTBInfo${i}" class="cg-hint"></span></div>
            <div class="cg-row" style="margin-top:8px;"><label>连接：</label><select id="cgTBConn${i}"><option value="can">CAN</option><option value="usb">USB</option><option value="serial">串口</option></select>
            <label>地址：</label><input type="text" id="cgTBSerial${i}" placeholder="canbus_uuid 或 /dev/..." style="flex:1;min-width:200px;" value="${tb.serial}"></div>
            <div id="cgTBDriverContainer${i}" style="margin-top:10px;"></div><div id="cgTBFuncContainer${i}" style="margin-top:10px;"></div></div>`;
        inner.appendChild(div);
        const cs=document.getElementById(`cgTBConn${i}`); if(cs) cs.value=tb.connType;
    }
    // 填充工具板型号
    const bd = _boardsIndex[brand]; if(bd) { for(const[bid,info]of Object.entries(bd.toolboards)) { for(let i=0;i<count;i++){const o=document.getElementById(`cgTBBoard${i}`);if(o)o.innerHTML+=`<option value="${bid}">${info.name} (${info.mcu})</option>`;} } }
    _toolboardData.forEach((tb,i)=>{if(tb.boardId){const s=document.getElementById(`cgTBBoard${i}`);if(s)s.value=tb.boardId;}});
}
function toggleToolboardPanel(i) { const p=document.getElementById(`cgTBPanel${i}`); if(p) p.style.display=p.style.display==='none'?'block':'none'; }
async function onToolBoardSelect(i) {
    const boardId=document.getElementById(`cgTBBoard${i}`).value;
    _toolboardData[i].boardId=boardId;
    const info=document.getElementById(`cgTBInfo${i}`);
    if(!boardId){_toolboardData[i].mapping=null;document.getElementById(`cgTBDriverContainer${i}`).innerHTML='';document.getElementById(`cgTBFuncContainer${i}`).innerHTML='';return;}
    try {
        const r=await fetch(`/api/tools/boards/${boardId}/mapping`), d=await r.json();
        if(!d.success){cgShowToast(d.error,'error');return;}
        _toolboardData[i].mapping=d.mapping; _toolboardData[i].boardInfo=d.board_info;
        const bi=d.board_info; info.textContent=`${bi.drive_count}驱动, ${bi.heat_count}加热, ${bi.fan_count}风扇`;
        const cs=document.getElementById(`cgTBConn${i}`);
        if(cs&&bi.connections){cs.innerHTML='';bi.connections.forEach(c=>{const v=c.includes('CAN')?'can':c.includes('USB')?'usb':'serial';cs.innerHTML+=`<option value="${v}">${c}</option>`;});cs.value=_toolboardData[i].connType;}
        renderToolboardDrivers(i); renderToolboardFunctions(i);
    } catch(e){cgShowToast('加载工具板失败: '+e.message,'error');}
}
function renderToolboardDrivers(i) {
    const c=document.getElementById(`cgTBDriverContainer${i}`), m=_toolboardData[i].mapping; if(!m){c.innerHTML='';return;}
    const drives=[]; for(let j=0;j<10;j++){if(m[`Drives${j}`])drives.push({key:`Drives${j}`,...m[`Drives${j}`]});else break;}
    if(!drives.length){c.innerHTML='';return;}
    let h='<h4 class="cg-section-title"><i class="fas fa-server"></i> 工具板驱动器分配</h4><div class="cg-drive-table"><table><thead><tr><th>驱动器</th><th>STEP</th><th>DIR</th><th>EN</th><th>分配轴</th></tr></thead><tbody>';
    drives.forEach((d,j)=>{const cur=(_toolboardData[i].axes||[])[j]||'';let o='<option value="">不使用</option>';ALL_AXES.forEach(a=>o+=`<option value="${a}"${a===cur?' selected':''}>${a}</option>`);h+=`<tr><td><strong>${d.key}</strong></td><td class="cg-pin">${d.step_pin}</td><td class="cg-pin">${d.dir_pin}</td><td class="cg-pin">${d.enable_pin}</td><td><select id="cgTBAxis_${i}_${j}" class="cg-axis-sel" onchange="onTBAxisChg(${i})">${o}</select></td></tr>`;});
    h+='</tbody></table></div>'; c.innerHTML=h;
}
function onTBAxisChg(i){const m=_toolboardData[i].mapping;if(!m)return;const d=[];for(let j=0;j<10;j++){if(m[`Drives${j}`])d.push(m[`Drives${j}`]);else break;}_toolboardData[i].axes=d.map((_,j)=>document.getElementById(`cgTBAxis_${i}_${j}`)?.value||'');}
function renderToolboardFunctions(i) {
    const c=document.getElementById(`cgTBFuncContainer${i}`), m=_toolboardData[i].mapping; if(!m){c.innerHTML='';return;}
    const heats=[],temps=[],fans=[],stops=[],fa=_toolboardData[i].funcAssigns||{};
    for(let j=0;j<10;j++){const k=`heat${j}`;if(m[k]!=null)heats.push({key:k,pin:m[k]});} if(m['BED_OUT'])heats.push({key:'BED_OUT',pin:m['BED_OUT']}); if(m['bed-heat'])heats.push({key:'bed-heat',pin:m['bed-heat']});
    for(let j=0;j<10;j++){const k=`temp${j}`;if(m[k]!=null)temps.push({key:k,pin:m[k]});} if(m['temp_bed'])temps.push({key:'temp_bed',pin:m['temp_bed']}); if(m['bed-temp'])temps.push({key:'bed-temp',pin:m['bed-temp']});
    for(let j=0;j<20;j++){const k=`fan${j}`;if(m[k]!=null)fans.push({key:k,pin:m[k]});}
    for(let j=0;j<20;j++){const k=`stop${j}`;if(m[k]!=null)stops.push({key:k,pin:m[k]});}
    let h='';
    const mkFuncSel=(id,cur,opts)=>`<select id="${id}" onchange="_toolboardData[${i}].funcAssigns=Object.assign(_toolboardData[${i}].funcAssigns||{},{'${id.split('_').pop()}':this.value})">${opts.map(([v,l])=>`<option value="${v}"${v===cur?' selected':''}>${l}</option>`).join('')}</select>`;
    if(heats.length){h+='<h4 class="cg-section-title"><i class="fas fa-fire"></i> 加热器</h4><div class="cg-func-grid">';heats.forEach(x=>{const cur=fa[x.key]||'';h+=`<div class="cg-func-item"><label>${x.key} (${x.pin})</label>${mkFuncSel(`cgTBFunc_${i}_${x.key}`,cur,[['','不使用'],['extruder','挤出机加热'],['heater_bed','热床加热']])}</div>`;});h+='</div>';}
    if(temps.length){h+='<h4 class="cg-section-title"><i class="fas fa-thermometer-half"></i> 热敏</h4><div class="cg-func-grid">';temps.forEach(x=>{const ps=Array.isArray(x.pin)?x.pin[0]:x.pin,cur=fa[x.key]||'';h+=`<div class="cg-func-item"><label>${x.key} (${ps})</label>${mkFuncSel(`cgTBFunc_${i}_${x.key}`,cur,[['','不使用'],['extruder','挤出机热敏'],['heater_bed','热床热敏']])}</div>`;});h+='</div>';}
    if(fans.length){h+='<h4 class="cg-section-title"><i class="fas fa-fan"></i> 风扇</h4><div class="cg-func-grid">';fans.forEach((x,idx)=>{const cur=fa[x.key]||(idx===0?'part_fan':idx===1?'throat_fan':'');h+=`<div class="cg-func-item"><label>${x.key} (${x.pin})</label>${mkFuncSel(`cgTBFunc_${i}_${x.key}`,cur,[['','不使用'],['part_fan','模型风扇'],['throat_fan','喉管风扇'],['controller_fan','控制器风扇'],['exhaust_fan','排风扇']])}</div>`;});h+='</div>';}
    if(stops.length){h+='<h4 class="cg-section-title"><i class="fas fa-hand-paper"></i> 限位开关</h4><div class="cg-func-grid">';stops.forEach(x=>{const curA=(fa[x.key]&&fa[x.key].axis)||'';h+=`<div class="cg-func-item"><label>${x.key} (${x.pin})</label><div style="display:flex;gap:6px;"><select id="cgTBFuncStop_${i}_${x.key}" style="flex:1;" onchange="_toolboardData[${i}].funcAssigns=Object.assign(_toolboardData[${i}].funcAssigns||{},{'${x.key}':{axis:this.value,ncno:document.getElementById('cgTBNCNO_${i}_${x.key}')?.value||'NC'}})"><option value="">不使用</option><option value="x"${curA==='x'?' selected':''}>X限位</option><option value="y"${curA==='y'?' selected':''}>Y限位</option><option value="z"${curA==='z'?' selected':''}>Z限位</option></select><select id="cgTBNCNO_${i}_${x.key}" style="width:70px;" onchange="if(_toolboardData[${i}].funcAssigns['${x.key}'])_toolboardData[${i}].funcAssigns['${x.key}'].ncno=this.value"><option value="NC">常闭NC</option><option value="NO">常开NO</option></select></div></div>`;});h+='</div>';}
    c.innerHTML=h||'<p style="color:var(--text-secondary);font-size:13px;">此工具板无可用功能引脚</p>';
}

// ========== 主板驱动器轴分配 (Tab 2) ==========
function renderDriverAssignment() {
    const c=document.getElementById('cgDriverContainer');
    if(!_currentMapping){c.innerHTML='<p style="color:var(--text-secondary);text-align:center;">请先选择主板</p>';return;}
    const m=_currentMapping, drives=[]; for(let i=0;;i++){if(m[`Drives${i}`])drives.push({key:`Drives${i}`,idx:i,...m[`Drives${i}`]});else break;}
    if(!drives.length){c.innerHTML='<p style="color:var(--text-secondary);">此板卡无驱动器引脚</p>';return;}
    const presetDrives=(_currentPreset&&_currentPreset.drives)||[];
    let h='<p style="font-size:12px;color:var(--text-secondary);margin:0 0 8px;">⚠️ 每个轴只能分配给一个驱动器，重复分配将阻止生成。</p>';
    h+='<div class="cg-drive-table"><table style="table-layout:fixed;width:100%;"><colgroup><col style="width:13%;"><col style="width:49%;"><col style="width:23%;"><col style="width:15%;"></colgroup><thead><tr><th>分配轴</th><th>驱动器引脚</th><th>驱动类型</th><th>电流(A)</th></tr></thead><tbody>';
    drives.forEach((d,i)=>{
        const presetDrive=presetDrives[i];const def=presetDrive?presetDrive.axis:'';
        let o='<option value="">不使用</option>';ALL_AXES.forEach(a=>o+=`<option value="${a}"${a===def?' selected':''}>${a}</option>`);
        const pins=[`STEP=${d.step_pin||'-'}`,`DIR=${d.dir_pin||'-'}`,`EN=${d.enable_pin||'-'}`];
        if(d.uart_pin)pins.push(`UART=${d.uart_pin}`);
        const tmcDef=presetDrive?.stepper_driver||'tmc2209';
        const curDef=presetDrive?.run_current||0.8;
        const tmcOps=[['tmc2209','TMC2209'],['tmc5160','TMC5160'],['tmc2240','TMC2240'],['tmc2130','TMC2130'],['tmc2208','TMC2208'],['tmc2660','TMC2660'],['a4988','A4988'],['external','外置驱动'],['yanggong','杨工驱动']]
            .map(([v,l])=>`<option value="${v}"${tmcDef===v?' selected':''}>${l}</option>`).join('');
        h+=`<tr><td><select id="cgAxis_${i}" class="cg-axis-sel" onchange="validateAxisAssignment()">${o}</select></td><td><strong>${d.key}</strong><br><span style="font-size:11px;color:var(--text-secondary);">${pins.join(', ')}</span></td><td><select id="cgTmcModel_${i}" onchange="onTmcModelChg(${i})" style="width:100%;font-size:12px;padding:4px;">${tmcOps}</select></td><td><input type="number" step="0.1" id="cgTmcCurrent_${i}" value="${curDef}" style="width:100%;font-size:12px;padding:4px 6px;border:1px solid var(--border-color);border-radius:4px;background:var(--card-bg);"></td></tr>`;
    });
    h+='</tbody></table></div>';
    h+='<div id="cgAxisWarn" class="cg-warn" style="display:none;"></div>';
    c.innerHTML=h;
}
function validateAxisAssignment() {
    const w=document.getElementById('cgAxisWarn'); if(!w) return true;
    const assigned={}; let dup=false;
    document.querySelectorAll('[id^="cgAxis_"]').forEach(s=>{const a=s.value;if(!a)return;if(assigned[a]){dup=true;s.style.borderColor='var(--danger-color,#e53935)';}else{assigned[a]=true;s.style.borderColor='';}});
    if(dup){w.style.display='block';w.innerHTML='<i class="fas fa-exclamation-triangle"></i> 存在重复轴分配，请修正后再生成';w.style.color='var(--danger-color,#e53935)';}else w.style.display='none';
    return !dup;
}

// ========== Tab 3: 运动参数 ==========
let _motionManualOverride = {};  // 手动覆盖标记: {"X:rd":true,"Y:ms":true,...}
function resetMotionOverrides() { _motionManualOverride = {}; }
function renderMotionParams() {
    const c=document.getElementById('cgMotionContainer'); if(!c||!_currentMapping) return;
    const cp=_currentPreset||{}; const cpDrives=cp.drives||[];
    const _defM={rotation_distance:40,microsteps:16,homing_speed:50,position_min:0,position_max:200,position_endstop:0};
    const kinType = cp.geometry?.type === 'corexy' ? 'corexy' : 'cartesian';
    const isCoreXY = kinType === 'corexy';
    // 重渲染时清除手动覆盖标记（新预设生效）
    resetMotionOverrides();
    // 中文化表头
    const th = (key) => (TERM_I18N[key]?.label || key);
    let h = '<p style="font-size:12px;color:var(--text-secondary);margin:0 0 6px;">';
    h += isCoreXY ? '🔗 CoreXY 机型：X/Y 轴参数自动联动' : '🔗 Cartesian 机型：仅多Z轴参数联动';
    h += '</p>';
    h += '<div class="cg-motion-table"><table><thead><tr><th>轴</th>';
    ['rotation_distance','microsteps','full_steps_per_rotation','homing_retract_dist','homing_speed','position_min','position_max','position_endstop'].forEach(k => {
        h += `<th title="${TERM_I18N[k]?.hint||''}">${th(k)}</th>`;
    });
    h += '</tr></thead><tbody>';
    // microsteps: 纯数字输入，去除有兼容性问题的 datalist
    cpDrives.forEach(drive => {
        if (drive.axis === 'E') return;
        const axis = drive.axis;
        const rd = drive.rotation_distance ?? _defM.rotation_distance;
        const ms = drive.microstepping ?? _defM.microsteps;
        const hs = drive.homing_speed ?? _defM.homing_speed;
        const pmin = drive.position_min ?? _defM.position_min;
        const pmax = drive.position_max ?? 200;
        const pes = drive.position_endstop ?? _defM.position_endstop;
        const fspr = drive.full_steps_per_rotation ?? 200;
        const hrd = drive.homing_retract_dist ?? 5;
        const onChange = (param) => `onchange="syncMotionParam('${axis}','${param}',this.value)"`;
        h += `<tr><td><strong>${axis}</strong></td>`;
        h += `<td><input type="number" step="0.01" id="cgMotion_${axis}_rd" value="${rd}" class="cg-xs" ${onChange('rd')}></td>`;
        h += `<td><input type="number" id="cgMotion_${axis}_ms" value="${ms}" class="cg-xs" ${onChange('ms')}></td>`;
        h += `<td><select id="cgMotion_${axis}_fspr" class="cg-xs" ${onChange('fspr')}><option value="200"${fspr==200?' selected':''}>200(1.8°)</option><option value="400"${fspr==400?' selected':''}>400(0.9°)</option></select></td>`;
        h += `<td><input type="number" step="0.1" id="cgMotion_${axis}_hrd" value="${hrd}" class="cg-xs" style="width:50px" ${onChange('hrd')}></td>`;
        h += `<td><input type="number" id="cgMotion_${axis}_hs" value="${hs}" class="cg-xs" ${onChange('hs')}></td>`;
        h += `<td><input type="number" id="cgMotion_${axis}_min" value="${pmin}" class="cg-xs"></td>`;
        h += `<td><input type="number" id="cgMotion_${axis}_max" value="${pmax}" class="cg-xs" ${onChange('max')}></td>`;
        h += `<td><input type="number" step="0.01" id="cgMotion_${axis}_es" value="${pes}" class="cg-xs" ${onChange('es')}></td></tr>`;
    });
    h += '</tbody></table></div>';
    c.innerHTML = h || '<p style="color:var(--text-secondary);text-align:center;">请先选择打印机型号</p>';
}
// 运动参数联动：CoreXY下X↔Y，多Z轴联动（防递归 + 手动覆盖保护）
let _syncGuard = false;
function syncMotionParam(axis, param, value) {
    if (_syncGuard) return;
    // 用户手动修改 → 标记为"已手动覆盖"，后续联动不再同步此参数
    if (!_syncGuard) {
        _motionManualOverride[`${axis}:${param}`] = true;
    }
    const cp = _currentPreset || {};
    const kinType = cp.geometry?.type === 'corexy' ? 'corexy' : 'cartesian';
    const isCoreXY = kinType === 'corexy';
    let targets = [];
    if (isCoreXY && (axis === 'X' || axis === 'Y')) {
        targets = axis === 'X' ? ['Y'] : ['X'];
    } else if (axis.startsWith('Z')) {
        const allZ = ['Z', 'Z1', 'Z2', 'Z3'];
        targets = allZ.filter(z => z !== axis && document.getElementById(`cgMotion_${z}_${param}`));
    }
    if (!targets.length) return;
    _syncGuard = true;
    targets.forEach(t => {
        // 如果目标轴的该参数已被手动覆盖，跳过自动联动
        if (_motionManualOverride[`${t}:${param}`]) return;
        const el = document.getElementById(`cgMotion_${t}_${param}`);
        if (!el) return;
        if (el.tagName === 'SELECT') {
            if (el.querySelector(`option[value="${value}"]`)) el.value = value;
        } else {
            el.value = value;
        }
        el.style.transition = 'none';
        el.style.background = 'rgba(33,150,243,0.2)';
        requestAnimationFrame(() => {
            el.style.transition = 'background 0.8s';
            el.style.background = '';
        });
    });
    _syncGuard = false;
}

// ========== Tab 4: 加热器 ==========
function renderHeaterConfig() {
    const c=document.getElementById('cgHeaterContainer'); if(!c||!_currentMapping) return;
    const m=_currentMapping; const cp=_currentPreset||{};
    // 收集所有可用的加热/热敏引脚
    const heats=[]; for(let i=0;i<10;i++){const k=`heat${i}`;if(m[k]!=null)heats.push({key:k,pin:m[k]});}
    if(m['bed-heat'])heats.push({key:'bed-heat',pin:m['bed-heat']}); if(m['BED_OUT'])heats.push({key:'BED_OUT',pin:m['BED_OUT']});
    const temps=[]; for(let i=0;i<10;i++){const k=`temp${i}`;if(m[k]!=null)temps.push({key:k,pin:m[k]});}
    if(m['temp_bed'])temps.push({key:'temp_bed',pin:m['temp_bed']}); if(m['bed-temp'])temps.push({key:'bed-temp',pin:m['bed-temp']});
    const heatOpts=heats.map(x=>`<option value="${x.key}">${x.key} (${Array.isArray(x.pin)?x.pin[0]:x.pin})</option>`).join('');
    const tempOpts=temps.map(x=>`<option value="${x.key}">${x.key} (${Array.isArray(x.pin)?x.pin[0]:x.pin})</option>`).join('');
    let h='';
    // 挤出机加热
    h+='<div class="cg-heater-card"><h4><i class="fas fa-fire"></i> 挤出机 (extruder)</h4>';
    h+='<div class="cg-func-grid">';
    h+=`<div class="cg-func-item"><label>加热引脚：</label><select id="cgHeatPin_extruder"><option value="">不使用</option>${heatOpts}</select></div>`;
    h+=`<div class="cg-func-item"><label>热敏引脚：</label><select id="cgTempPin_extruder"><option value="">不使用</option>${tempOpts}</select></div>`;
    h+='</div></div>';
    // 热床加热
    h+='<div class="cg-heater-card"><h4><i class="fas fa-bed"></i> 热床 (heater_bed)</h4>';
    h+='<div class="cg-func-grid">';
    h+=`<div class="cg-func-item"><label>加热引脚：</label><select id="cgHeatPin_heater_bed"><option value="">不使用</option>${heatOpts}</select></div>`;
    h+=`<div class="cg-func-item"><label>热敏引脚：</label><select id="cgTempPin_heater_bed"><option value="">不使用</option>${tempOpts}</select></div>`;
    h+='</div></div>';
    // 额外加热器容器
    h+='<div id="cgExtraHeaters"></div>';
    c.innerHTML=h;
    // 默认选中第一个加热/热敏引脚用于挤出机，第二个用于热床（若存在）
    autoSelectHeaterPins();
}
function autoSelectHeaterPins() {
    const m=_currentMapping; if(!m) return;
    const heats=[]; for(let i=0;i<10;i++){const k=`heat${i}`;if(m[k]!=null)heats.push(k);}
    if(m['bed-heat'])heats.push('bed-heat'); if(m['BED_OUT'])heats.push('BED_OUT');
    const temps=[]; for(let i=0;i<10;i++){const k=`temp${i}`;if(m[k]!=null)temps.push(k);}
    if(m['temp_bed'])temps.push('temp_bed'); if(m['bed-temp'])temps.push('bed-temp');
    // 挤出机用第一个 heat/temp 引脚
    const extHeat=document.getElementById('cgHeatPin_extruder');
    const extTemp=document.getElementById('cgTempPin_extruder');
    if(extHeat&&heats.length>0) extHeat.value=heats[0];
    if(extTemp&&temps.length>0) extTemp.value=temps[0];
    // 热床用第二个 heat/temp 引脚（如有独立热床引脚）
    const bedHeat=document.getElementById('cgHeatPin_heater_bed');
    const bedTemp=document.getElementById('cgTempPin_heater_bed');
    const bedHeatKey=heats.find(k=>k.includes('bed')||k.includes('BED'))||heats[1]||'\n';
    const bedTempKey=temps.find(k=>k.includes('bed')||k.includes('BED'))||temps[1]||'\n';
    if(bedHeat&&bedHeatKey) bedHeat.value=bedHeatKey;
    if(bedTemp&&bedTempKey) bedTemp.value=bedTempKey;
}
function addExtraHeater() {
    _extraHeaterCount++;
    const container=document.getElementById('cgExtraHeaters'); if(!container) return;
    const m=_currentMapping; if(!m) return;
    // 收集所有可用引脚
    const heats=[]; for(let i=0;i<10;i++){const k=`heat${i}`;if(m[k]!=null)heats.push({key:k,pin:m[k]});}
    if(m['bed-heat'])heats.push({key:'bed-heat',pin:m['bed-heat']}); if(m['BED_OUT'])heats.push({key:'BED_OUT',pin:m['BED_OUT']});
    const temps=[]; for(let i=0;i<10;i++){const k=`temp${i}`;if(m[k]!=null)temps.push({key:k,pin:m[k]});}
    if(m['temp_bed'])temps.push({key:'temp_bed',pin:m['temp_bed']}); if(m['bed-temp'])temps.push({key:'bed-temp',pin:m['bed-temp']});
    const fans=[]; for(let i=0;i<20;i++){const k=`fan${i}`;if(m[k]!=null)fans.push({key:k,pin:m[k]});}
    const heatOpts=heats.map(x=>`<option value="${x.key}">${x.key} (${Array.isArray(x.pin)?x.pin[0]:x.pin})</option>`).join('');
    const tempOpts=temps.map(x=>`<option value="${x.key}">${x.key} (${Array.isArray(x.pin)?x.pin[0]:x.pin})</option>`).join('');
    const idx=_extraHeaterCount;
    let h=`<div class="cg-heater-card" id="cgExtraHeater_${idx}"><h4><i class="fas fa-plus-circle"></i> 额外加热器 ${idx} <button class="cg-heater-remove" onclick="removeExtraHeater(${idx})">✕ 移除</button></h4>`;
    h+='<div class="cg-func-grid">';
    // 段类型
    h+=`<div class="cg-func-item"><label>段类型：</label><select id="cgExtraSection_${idx}" onchange="onExtraSectionChange(${idx})"><option value="heater_generic" selected>heater_generic（加热）</option><option value="temperature_sensor">temperature_sensor（仅测温）</option></select></div>`;
    h+=`<div class="cg-func-item"><label>名称：</label><input type="text" id="cgExtraName_${idx}" value="extra_heater_${idx}" style="width:100%;"></div>`;
    h+=`<div class="cg-func-item"><label>加热引脚：</label><select id="cgExtraHeatPin_${idx}"><option value="">不使用</option>${heatOpts}</select></div>`;
    h+=`<div class="cg-func-item"><label>热敏引脚：</label><select id="cgExtraTempPin_${idx}"><option value="">不使用</option>${tempOpts}</select></div>`;
    h+=`<div class="cg-func-item"><label>传感器类型：</label><select id="cgExtraST_${idx}">${SENSOR_TYPES.map(s=>`<option>${s}</option>`).join('')}</select><br><small style="color:#e65100;font-size:11px;">⚠️ PT100 需要 MAX31865 放大器，PT1000 建议搭配放大器使用</small></div>`;
    h+=`<div class="cg-func-item"><label>max_temp：</label><input type="number" id="cgExtraMaxT_${idx}" value="120" class="cg-xs"></div>`;
    h+=`<div class="cg-func-item" id="cgExtraMinTempRow_${idx}"><label>min_temp：</label><input type="number" id="cgExtraMinTemp_${idx}" value="-235" class="cg-xs"></div>`;
    h+=`<div class="cg-func-item" id="cgExtraMaxPowerRow_${idx}"><label>max_power：</label><input type="number" step="0.1" id="cgExtraMaxPower_${idx}" value="1.0" class="cg-xs"></div>`;
    h+=`<div class="cg-func-item" id="cgExtraControlRow_${idx}"><label>control：</label><select id="cgExtraCtrl_${idx}"><option value="watermark" selected>watermark</option><option value="pid">pid</option></select></div>`;
    h+=`<div class="cg-func-item" id="cgExtraGcodeIdRow_${idx}"><label>gcode_id：</label><input type="text" id="cgExtraGcodeId_${idx}" value="" style="width:80px;" placeholder="可选"></div>`;
    h+='</div></div>';
    container.insertAdjacentHTML('beforeend',h);
    // 根据默认段类型隐藏/显示加热专属字段
    onExtraSectionChange(idx);
}
function onExtraSectionChange(idx) {
    const sec=document.getElementById(`cgExtraSection_${idx}`)?.value;
    const isHeat=sec==='heater_generic';
    ['cgExtraMinTempRow','cgExtraMaxPowerRow','cgExtraControlRow'].forEach(id=>{
        const el=document.getElementById(`${id}_${idx}`); if(el) el.style.display=isHeat?'':'none';
    });
    // gcode_id 仅在 temperature_sensor 模式显示
    const gcodeEl=document.getElementById(`cgExtraGcodeIdRow_${idx}`);
    if(gcodeEl) gcodeEl.style.display=isHeat?'none':'';
    // 加热引脚在 temperature_sensor 模式下隐藏
    const heatEl=document.getElementById(`cgExtraHeatPin_${idx}`)?.parentElement;
    if(heatEl) heatEl.style.display=isHeat?'':'none';
}
function removeExtraHeater(idx) {
    const el=document.getElementById(`cgExtraHeater_${idx}`); if(el) el.remove();
}

// ========== Tab 4: 风扇 ==========
function renderFanConfig() {
    const c=document.getElementById('cgFanContainer'); if(!c||!_currentMapping) return;
    const m=_currentMapping; const fans=[];
    for(let i=0;i<20;i++){const k=`fan${i}`;if(m[k]!=null)fans.push({key:k,pin:m[k]});}
    if(!fans.length){c.innerHTML='<p style="color:var(--text-secondary);">此板卡无风扇引脚</p>';return;}
    const fanOpts=fans.map(x=>`<option value="${x.key}">${x.key} (${x.pin})</option>`).join('');
    let h='<div class="cg-func-grid">';
    h+=`<div class="cg-func-item"><label>模型冷却风扇：</label><select id="cgFanPin_part_fan"><option value="">不使用</option>${fanOpts}</select></div>`;
    h+=`<div class="cg-func-item"><label>喉管风扇：</label><select id="cgFanPin_throat_fan"><option value="">不使用</option>${fanOpts}</select></div>`;
    h+=`<div class="cg-func-item"><label>控制器/驱动风扇：</label><select id="cgFanPin_driver_fan"><option value="">不使用</option>${fanOpts}</select></div>`;
    h+=`<div class="cg-func-item"><label>电器仓风扇(heater_bed)：</label><select id="cgFanPin_controller_fan"><option value="">不使用</option>${fanOpts}</select></div>`;
    h+=`<div class="cg-func-item"><label>排风扇：</label><select id="cgFanPin_exhaust_fan"><option value="">不使用</option>${fanOpts}</select></div>`;
    h+='</div>'; c.innerHTML=h;
    // 默认: fan0→模型冷却, fan1→喉管, 其余不使用
    if(fans.length>=1){const el=document.getElementById('cgFanPin_part_fan'); if(el) el.value=fans[0].key;}
    if(fans.length>=2){const el=document.getElementById('cgFanPin_throat_fan'); if(el) el.value=fans[1].key;}
}

// ========== Tab 4: 挤出机参数 ==========
function renderExtruderParams() {
    const c=document.getElementById('cgExtruderParamContainer'); if(!c||!_currentMapping) return;
    const cp=_currentPreset||{}; const ep=cp.extruder||{};
    const _defE={rotation_distance:22.67,microsteps:16,filament_diameter:1.75,nozzle_diameter:0.4,max_temp:285,sensor_type:'NTC 100K beta 3950'};
    let h='<div class="cg-param-grid" style="margin-bottom:8px;"><div class="cg-param-item"><label>挤出机型号：</label><select id="cgExtModel" onchange="onExtModelChange()">';for(const[k,v]of Object.entries(EXT_PRESETS))h+=`<option value="${k}">${v.name} (rd=${v.rotation_distance??'?'}) - ${v.desc}</option>`;h+='</select></div></div><div class="cg-param-grid">';
    h+=`<div class="cg-param-item"><label>rotation_distance：</label><input type="number" step="0.01" id="cgExtRD" value="${ep.rotation_distance??_defE.rotation_distance}"></div>`;
    h+=`<div class="cg-param-item"><label>microsteps：</label><input type="number" id="cgExtMS" value="${ep.microsteps??_defE.microsteps}"></div>`;
    h+=`<div class="cg-param-item"><label>filament_diameter：</label><input type="number" step="0.01" id="cgExtFD" value="${ep.filament_diameter??_defE.filament_diameter}"></div>`;
    h+=`<div class="cg-param-item"><label>nozzle_diameter：</label><input type="number" step="0.1" id="cgExtND" value="${ep.nozzle_diameter??_defE.nozzle_diameter}"></div>`;
    h+=`<div class="cg-param-item"><label>max_temp：</label><input type="number" id="cgExtMaxT" value="${ep.max_temp??_defE.max_temp}"></div>`;
    h+=`<div class="cg-param-item"><label>min_extrude_temp：</label><input type="number" id="cgExtMinT" value="${ep.min_extrude_temp??170}"></div>`;
    const st=ep.sensor_type??_defE.sensor_type;
    h+=`<div class="cg-param-item"><label>sensor_type：</label><select id="cgExtST">${SENSOR_TYPES.map(s=>`<option${s===st?' selected':''}>${s}</option>`).join('')}</select><br><small style="color:#e65100;font-size:11px;">⚠️ PT100 需要 MAX31865 放大器，PT1000 建议搭配放大器使用</small></div>`;
    h+=`<div class="cg-param-item"><label>gear_ratio：</label><input type="text" id="cgExtGearRatio" value="${ep.gear_ratio||''}" style="width:100px;"><br><small style="color:var(--text-secondary);">减速比，BMG=50:17，Galileo留空</small></div>`;
    h+=`<div class="cg-param-item"><label>pressure_advance：</label><input type="number" step="0.001" id="cgExtPA" value="${ep.pressure_advance??0.05}" class="cg-xs"></div>`;
    h+=`<div class="cg-param-item"><label>pressure_advance_smooth_time：</label><input type="number" step="0.001" id="cgExtPASmooth" value="${ep.pressure_advance_smooth_time??0.040}" class="cg-xs"></div>`;
    h+=`<div class="cg-param-item"><label>max_extrude_only_distance：</label><input type="number" id="cgExtMaxDist" value="${ep.max_extrude_only_distance??100}" class="cg-xs"></div>`;
    h+=`<div class="cg-param-item"><label>max_extrude_cross_section：</label><input type="number" id="cgExtMaxCross" value="${ep.max_extrude_cross_section??50}" class="cg-xs"></div>`;
    h+=`<div class="cg-param-item"><label>max_power：</label><input type="number" step="0.1" id="cgExtMaxPower" value="${ep.max_power??1.0}" class="cg-xs"></div>`;
    h+=`<div class="cg-param-item"><label>control：</label><select id="cgExtControl"><option value="watermark"${(ep.control||'watermark')==='watermark'?' selected':''}>watermark</option><option value="pid"${ep.control==='pid'?' selected':''}>pid</option></select></div>`;
    h+=`<div class="cg-param-item"><label>min_temp：</label><input type="number" id="cgExtMinTemp" value="${ep.min_temp??-235}" class="cg-xs"><br><small style="color:var(--text-secondary);">FLY参考配置特殊值</small></div></div>`;
    c.innerHTML=h;
}

// ========== Tab 4: 热床参数 ==========
function renderBedParams() {
    const c=document.getElementById('cgBedParamContainer'); if(!c||!_currentMapping) return;
    const cp=_currentPreset||{}; const _bed=cp.bed||{};
    const _defB={sensor_type:'NTC 100K beta 3950',max_temp:120};
    const bst=_bed.sensor_type||_defB.sensor_type, bmt=_bed.max_temp??_defB.max_temp;
    let h=`<div class="cg-param-grid"><div class="cg-param-item"><label>sensor_type：</label><select id="cgBedST">${SENSOR_TYPES.map(s=>`<option${s===bst?' selected':''}>${s}</option>`).join('')}</select><br><small style="color:#e65100;font-size:11px;">⚠️ PT100 需要 MAX31865 放大器，PT1000 建议搭配放大器使用</small></div><div class="cg-param-item"><label>max_temp：</label><input type="number" id="cgBedMaxT" value="${bmt}"></div><div class="cg-param-item"><label>max_power：</label><input type="number" step="0.1" id="cgBedMaxPower" value="1.0" class="cg-xs"></div><div class="cg-param-item"><label>control：</label><select id="cgBedControl"><option value="watermark" selected>watermark</option><option value="pid">pid</option></select></div><div class="cg-param-item"><label>min_temp：</label><input type="number" id="cgBedMinTemp" value="-235" class="cg-xs"><br><small style="color:var(--text-secondary);">FLY参考配置特殊值</small></div></div>`;
    c.innerHTML=h;
}

// ========== 获取轴→驱动器DIAG映射（含不支持标记）==========
function getAxisDiagMap() {
    const map = {};
    if (!_currentMapping) return map;
    const DIAG_TMC = { 'tmc2209': '^', 'tmc5160': '^!', 'tmc2240': '^!', 'tmc2130': '^!' };
    document.querySelectorAll('[id^="cgAxis_"]').forEach(sel => {
        const axis = sel.value;
        if (!axis || axis === 'E' || axis === 'E1') return;
        const idx = parseInt(sel.id.replace('cgAxis_', ''));
        const d = _currentMapping[`Drives${idx}`];
        const tmcModel = document.getElementById(`cgTmcModel_${idx}`)?.value;
        if (!d || !d.diag_pin) return;
        const info = { driver: `Drives${idx}`, diag_pin: d.diag_pin, idx, tmcModel: tmcModel||'unknown' };
        if (DIAG_TMC[tmcModel]) {
            info.diagPrefix = DIAG_TMC[tmcModel];
            info.diagSupported = true;
        } else {
            info.diagSupported = false;
        }
        map[axis] = info;
    });
    return map;
}
// DIAG复选框切换：联动禁用物理限位、Z轴仅警告不禁用
function onEndstopDiagChange(axis) {
    const cb = document.getElementById(`cgEndstopDiag_${axis}`);
    const info = document.getElementById(`cgEndstopDiagInfo_${axis}`);
    const physicalRow = document.getElementById(`cgEndstopPhysical_${axis}`);
    if (cb && info) {
        if (cb.checked) {
            info.style.display = '';
            cb.closest('.cg-diag-row')?.classList.add('active');
            if (physicalRow) { physicalRow.style.opacity = '0.35'; physicalRow.style.pointerEvents = 'none'; }
        } else {
            info.style.display = 'none';
            cb.closest('.cg-diag-row')?.classList.remove('active');
            if (physicalRow) { physicalRow.style.opacity = ''; physicalRow.style.pointerEvents = ''; }
        }
    }
}

// ========== Tab 3: 限位开关 ==========
function renderEndstopConfig() {
    const c = document.getElementById('cgEndstopContainer');
    if (!c || !_currentMapping) return;
    const m = _currentMapping;
    // 收集所有限位引脚
    const stops = [];
    for (let i = 0; i < 20; i++) { const k = `stop${i}`; if (m[k] != null) stops.push({ key: k, pin: m[k] }); }
    // DIAG 映射
    const diagMap = getAxisDiagMap();
    let h = '';
    // ---- DIAG 传感器限位 ----
    const hasAnyDiag = Object.keys(diagMap).length > 0;
    if (hasAnyDiag) {
        h += '<div class="cg-diag-section"><h4 class="cg-section-title"><i class="fas fa-bolt"></i> DIAG 传感器限位</h4>';
        h += '<p style="font-size:12px;color:var(--text-secondary);margin:0 0 10px;">启用后使用驱动器DIAG引脚作为虚拟限位，无需连接物理限位开关。</p>';
        ['X','Y','Z'].forEach(ax => {
            const dd = diagMap[ax];
            if (dd && dd.diagSupported) {
                // 驱动支持DIAG → 显示复选框
                h += `<div class="cg-diag-row"><label class="cg-diag-check"><input type="checkbox" id="cgEndstopDiag_${ax}" onchange="onEndstopDiagChange('${ax}')"> ${ax}轴使用 DIAG 限位</label><span class="cg-diag-pin-info" id="cgEndstopDiagInfo_${ax}" style="display:none;">(${dd.diagPrefix}${dd.diag_pin} on ${dd.driver}/${dd.tmcModel})</span></div>`;
            } else if (dd && !dd.diagSupported) {
                // 驱动不支持DIAG → 显示禁用的提示
                h += `<div class="cg-diag-row" style="opacity:0.5;"><span style="color:#e53935;font-size:12px;">⛔ ${ax}轴：${dd.tmcModel} 不支持DIAG限位</span></div>`;
            } else if (ax === 'Z') {
                // Z轴无驱动或有驱动但不支持 → 警告
                h += `<div class="cg-diag-row" style="opacity:0.6;"><label class="cg-diag-check"><input type="checkbox" id="cgEndstopDiag_${ax}" onchange="onEndstopDiagChange('${ax}')"> ${ax}轴使用 DIAG 限位</label><span style="color:#e6a817;font-size:11px;"> ⚠️ Z轴不建议使用DIAG，可能影响归位精度</span></div>`;
            }
        });
        h += '</div>';
    }
    // ---- 物理限位引脚分配 (每个轴独立) ----
    if (!stops.length) { c.innerHTML = h || '<p style="color:var(--text-secondary);">此板卡无限位引脚</p>'; return; }
    const diagPins = {}; for (let i = 0; ; i++) { const d = m[`Drives${i}`]; if (!d) break; if (d.diag_pin) diagPins[d.diag_pin] = d.key; }
    h += '<h4 class="cg-section-title" style="margin-top:16px;"><i class="fas fa-hand-paper"></i> 物理限位引脚分配</h4>';
    h += '<p style="font-size:12px;color:var(--text-secondary);margin:0 0 8px;">为每个轴选择限位引脚。NC不需要 <code>!</code> 前缀，NO需要 <code>!</code> 前缀。</p>';
    h += '<div class="cg-endstop-per-axis">';
    ['X','Y','Z'].forEach((ax, ai) => {
        // 为每个轴构建引脚下拉选项
        let stopOpts = '<option value="">不使用</option>';
        stops.forEach(s => {
            const cf = diagPins[typeof s.pin === 'string' ? s.pin : (Array.isArray(s.pin) ? s.pin[0] : '')];
            const cw = cf ? ` ⚠️${cf}` : '';
            stopOpts += `<option value="${s.key}">${s.key} (${typeof s.pin === 'string' ? s.pin : (Array.isArray(s.pin) ? s.pin[0] : s.pin)})${cw}</option>`;
        });
        h += `<div class="cg-endstop-axis-row" id="cgEndstopPhysical_${ax}">
            <label style="font-weight:600;min-width:20px;">${ax}</label>
            <select id="cgEndstopPin_${ax}" style="flex:1;">${stopOpts}</select>
            <select id="cgEndstopNCNO_${ax}" style="width:80px;"><option value="NC" selected>常闭NC</option><option value="NO">常开NO</option></select>
        </div>`;
        // 自动分配：按 stop0→X, stop1→Y, stop2→Z
        if (ai < stops.length) {
            setTimeout(() => { const sel = document.getElementById(`cgEndstopPin_${ax}`); if (sel && !sel.dataset.assigned) { sel.value = stops[ai].key; sel.dataset.assigned = '1'; } }, 10);
        }
    });
    h += '</div>';
    c.innerHTML = h;
}

// ========== Tab 3: 调平传感器 ==========
function renderProbeConfig() {
    const c=document.getElementById('cgProbeContainer'); if(!c||!_currentMapping) return;
    const m=_currentMapping;
    if(!m.probe&&!m.servo){c.innerHTML='<p style="color:var(--text-secondary);">此板卡无调平传感器引脚</p>';return;}
    const pp=PROBE_PRESETS[document.getElementById('cgProbeType')?.value]||PROBE_PRESETS['bltouch'];
    const isBL = (pp.section === 'bltouch');
    const isNone = (pp.section === null);
    let h = '';
    // ---- 探针类型 + 引脚信息 ----
    h += '<div class="cg-probe-section"><h4 class="cg-section-title"><i class="fas fa-ruler-combined"></i> 探针类型</h4>';
    h += '<div class="cg-probe-pin-row">';
    if(m.probe) {
        h += `<select id="cgProbeType" onchange="onProbeTypeChange()" style="flex:1;">`;
        for(const[k,v]of Object.entries(PROBE_PRESETS)) h += `<option value="${k}">${v.name} - ${v.desc}</option>`;
        h += `</select>`;
        h += `<span class="cg-hint" style="margin-left:10px;">sensor_pin: ${m.probe}</span>`;
    }
    if(m.servo) h += `<span class="cg-hint" id="cgProbeServoRow" style="margin-left:10px;${isBL?'':'display:none;'}">servo: ${m.servo}</span>`;
    h += '</div></div>';
    // ---- 参数区域（不使用探针时隐藏）----
    h += `<div id="cgProbeParams" style="${isNone?'display:none;':''}">`;
    // 偏移参数
    h += '<div class="cg-probe-section"><h4 class="cg-section-title"><i class="fas fa-arrows-alt"></i> 偏移参数</h4>';
    h += '<div class="cg-probe-compact">';
    h += `<div class="cg-probe-field"><label>z_offset</label><input type="number" step="0.01" id="cgZOffset" value="${pp.z_offset??0.05}"></div>`;
    h += `<div class="cg-probe-field"><label>x_offset</label><input type="number" step="0.1" id="cgProbeXOffset" value="0"></div>`;
    h += `<div class="cg-probe-field"><label>y_offset</label><input type="number" step="0.1" id="cgProbeYOffset" value="0"></div>`;
    h += '</div></div>';
    // 采样参数
    h += '<div class="cg-probe-section"><h4 class="cg-section-title"><i class="fas fa-chart-bar"></i> 采样参数</h4>';
    h += '<div class="cg-probe-compact">';
    h += '<div class="cg-probe-field"><label>采样次数</label><input type="number" id="cgProbeSamples" value="3" min="1" max="10"></div>';
    h += '<div class="cg-probe-field"><label>采样速度</label><input type="number" step="0.1" id="cgProbeSpeed" value="5.0"></div>';
    h += '<div class="cg-probe-field"><label>二次速度</label><input type="number" step="0.1" id="cgProbeSpeed2" value="2.0"></div>';
    h += '<div class="cg-probe-field"><label>回退距离</label><input type="number" step="0.1" id="cgProbeRetract" value="1.0"></div>';
    h += '<div class="cg-probe-field"><label>取值方式</label><select id="cgProbeSamplesResult"><option value="median" selected>median</option><option value="average">average</option></select></div>';
    h += '<div class="cg-probe-field"><label>采样公差</label><input type="number" step="0.001" id="cgProbeTolerance" value="0.006"></div>';
    h += '<div class="cg-probe-field"><label>重试次数</label><input type="number" id="cgProbeRetries" value="3"></div>';
    h += '</div></div>';
    h += '</div>';
    c.innerHTML = h;
    // 初始化默认探针类型
    if (_currentPreset?.probe?.type) {
        const probeEl = document.getElementById('cgProbeType');
        if (probeEl) probeEl.value = _currentPreset.probe.type;
    }
}

// ========== 参数配置 ==========
// ========== Tab 6: 归位参数 ==========
function renderHomingParams() {
    const c=document.getElementById('cgHomingContainer'); if(!c||!_currentMapping) return;
    const cp=_currentPreset||{}; const cpDrives=cp.drives||[];
    let h='';
    // 归位说明（仅支持 cartesian / corexy）
    const kinType = cp.geometry?.type === 'cartesian' ? 'cartesian' : 'corexy';
    if (kinType === 'corexy') {
        h += '<div class="cg-corexy-info"><strong><i class="fas fa-info-circle"></i> CoreXY 归位说明</strong>';
        h += '<ul><li>X/Y 电机联动：归位任意轴时两个电机同时运动</li>';
        h += '<li>推荐顺序：先 XY 后 Z（确保喷嘴在热床范围内）</li>';
        h += '<li>方向建议：XY 向 min（前左），Z 向 min（下）</li>';
        h += '<li>建议启用 <b>safe_z_home</b> 先抬 Z 再归 XY</li></ul></div>';
    } else {
        h += '<div class="cg-corexy-info"><strong><i class="fas fa-info-circle"></i> Cartesian 归位说明</strong>';
        h += '<ul><li>每轴独立运动，归位顺序建议：先 X → 再 Y → 最后 Z</li>';
        h += '<li>方向建议：X/Y 向 min（前左），Z 向 min（下）</li>';
        h += '<li>使用限位开关时：位置靠近 min 端则归位方向选负</li>';
        h += '<li>使用探针时建议启用 <b>safe_z_home</b> 归位XY前先抬Z</li></ul></div>';
    }
    // ---- 原点位置选择 ----
    // 根据当前的 homing_positive_dir 推导默认原点
    const xPos = cpDrives.find(d=>d.axis==='X')?.homing_positive_dir ?? false;
    const yPos = cpDrives.find(d=>d.axis==='Y')?.homing_positive_dir ?? false;
    const originKey = (xPos?'R':'L') + (yPos?'B':'F');
    const ORIGIN_MAP = {
        'LF': {label:'前左 (Min)', xPos:false, yPos:false, zPos:false},
        'RF': {label:'前右',       xPos:true,  yPos:false, zPos:false},
        'LB': {label:'后左',       xPos:false, yPos:true,  zPos:false},
        'RB': {label:'后右 (Max)', xPos:true,  yPos:true,  zPos:false}
    };
    const curOrigin = ORIGIN_MAP[originKey] || ORIGIN_MAP['LF'];
    h += '<div class="cg-probe-section"><h4 class="cg-section-title"><i class="fas fa-crosshairs"></i> 原点位置</h4>';
    h += '<div class="cg-probe-pin-row" style="margin-bottom:12px;">';
    h += '<label style="font-size:13px;font-weight:500;">原点在热床的角落：</label>';
    h += '<select id="cgOriginPos" onchange="onOriginChange()" style="flex:1;">';
    for (const [k, v] of Object.entries(ORIGIN_MAP)) {
        h += `<option value="${k}"${originKey===k?' selected':''}>${v.label}</option>`;
    }
    h += '</select></div></div>';
    // 归位方向表格
    h+='<div class="cg-motion-table"><table><thead><tr><th>轴</th><th>归位方向</th><th>限位位置</th><th>二次归位速度</th><th>位置</th></tr></thead><tbody>';
    _cgHomingDirs={};
    cpDrives.forEach(drive=>{if(drive.axis==='E')return;const axis=drive.axis;const dp=drive.homing_positive_dir??false;
    _cgHomingDirs[axis]=dp;
    const es = drive.position_endstop ?? (dp ? 200 : 0);
    const isEsMax = es > 0;  // 限位在 max 端
    const spd2=drive.second_homing_speed??Math.max(5,Math.round((drive.homing_speed??50)/2));
    h+=`<tr><td><strong>${axis}</strong></td><td><label class="cg-homing-dir"><input type="checkbox" id="cgHome_${axis}_posd" ${dp?'checked':''} onchange="updateHomePosHint('${axis}')"> 正方向(max)</label></td><td><select id="cgHome_${axis}_estop" onchange="onEndstopPosChange('${axis}')" style="width:100px;"><option value="min"${!isEsMax?' selected':''}>min 端 (0)</option><option value="max"${isEsMax?' selected':''}>max 端 (max)</option></select></td><td><input type="number" step="0.1" id="cgHome_${axis}_spd2" value="${spd2}" class="cg-xs"></td><td><span id="cgHome_${axis}_hint" class="cg-hint">${dp?'正→max':'负→min'}</span></td></tr>`;});
    h+='</tbody></table></div><div id="cgHomingVizContainer" style="display:flex;gap:20px;margin:16px 0;flex-wrap:wrap;align-items:flex-start;"></div>';
    // safe_z_home
    h+='<h4 class="cg-section-title"><i class="fas fa-shield-alt"></i> safe_z_home 归位XY前先抬Z</h4>';
    h+='<div class="cg-param-item" style="margin-bottom:8px;"><label><input type="checkbox" id="cgOptSafeZHome" onchange="document.getElementById(\'cgSafeZParams\').style.display=this.checked?\'block\':\'none\'"> 启用 [safe_z_home]</label></div>';
    h+='<div id="cgSafeZParams" style="display:none;"><div class="cg-param-grid">';
    h+='<div class="cg-param-item"><label>Z抬起高度：</label><input type="number" step="0.1" id="cgSafeZHeight" value="10" class="cg-xs"></div>';
    h+='<div class="cg-param-item"><label>Home X：</label><input type="number" step="0.1" id="cgHomePosX" value="100" class="cg-xs"></div>';
    h+='<div class="cg-param-item"><label>Home Y：</label><input type="number" step="0.1" id="cgHomePosY" value="100" class="cg-xs"></div>';
    h+='<div class="cg-param-item"><label>Z hop：</label><input type="number" step="0.1" id="cgZHop" value="5" class="cg-xs"></div>';
    h+='<div class="cg-param-item"><label>Z hop速度：</label><input type="number" id="cgZHopSpeed" value="15" class="cg-xs"></div></div></div>';
    c.innerHTML=h;
    renderHomingVisualization();
}
// 原点位置变更 → 自动设置各轴归位方向（限位位置由用户手动选择）
function onOriginChange() {
    const sel = document.getElementById('cgOriginPos')?.value;
    const ORIGIN_MAP = {
        'LF': {xPos:false, yPos:false, zPos:false},
        'RF': {xPos:true,  yPos:false, zPos:false},
        'LB': {xPos:false, yPos:true,  zPos:false},
        'RB': {xPos:true,  yPos:true,  zPos:false}
    };
    const o = ORIGIN_MAP[sel] || ORIGIN_MAP['LF'];
    ['X','Y','Z'].forEach(axis => {
        const chk = document.getElementById(`cgHome_${axis}_posd`);
        const hint = document.getElementById(`cgHome_${axis}_hint`);
        const estop = document.getElementById(`cgHome_${axis}_estop`);
        const val = axis === 'X' ? o.xPos : axis === 'Y' ? o.yPos : o.zPos;
        if (chk) chk.checked = val;
        if (hint) hint.textContent = val ? '正→max' : '负→min';
        if (chk) _cgHomingDirs[axis] = val;
        // 同步限位位置下拉框（正方向→max端，负方向→min端）
        if (estop) estop.value = val ? 'max' : 'min';
    });
    renderHomingVisualization();
}
// 限位位置变更 → 联动归位方向 + 同步 position_endstop
function onEndstopPosChange(axis) {
    const sel = document.getElementById(`cgHome_${axis}_estop`)?.value;
    const esEl = document.getElementById(`cgMotion_${axis}_es`);
    const maxEl = document.getElementById(`cgMotion_${axis}_max`);
    if (esEl) {
        esEl.value = (sel === 'max' && maxEl) ? (parseFloat(maxEl.value) || 200) : 0;
    }
    // 限位位置决定归位方向：限位在max端 → 正方向归位；限位在min端 → 负方向归位
    const chk = document.getElementById(`cgHome_${axis}_posd`);
    const hint = document.getElementById(`cgHome_${axis}_hint`);
    const newDir = sel === 'max';
    if (chk) { chk.checked = newDir; _cgHomingDirs[axis] = newDir; }
    if (hint) hint.textContent = newDir ? '正→max' : '负→min';
    // 不再反推原点下拉框——原点位置和限位安装位置是独立概念
    renderHomingVisualization();
}
// ========== Tab 6: 调平与可选配置 ==========
function renderLevelingParams() {
    const c=document.getElementById('cgLevelingContainer'); if(!c||!_currentMapping) return;
    let h='';
    // bed_mesh
    h+='<h4 class="cg-section-title"><i class="fas fa-th"></i> 热床网格校准</h4>';
    h+='<div class="cg-param-item" style="margin-bottom:8px;"><label><input type="checkbox" id="cgOptBedMesh" checked onchange="toggleOptPanel(\'BedMesh\')"> 启用 [bed_mesh]</label></div>';
    h+='<div id="cgBedMeshParams"><div class="cg-param-grid">';
    h+='<div class="cg-param-item"><label>speed：</label><input type="number" id="cgBMSpeed" value="50" class="cg-xs"></div>';
    h+='<div class="cg-param-item"><label>horizontal_move_z：</label><input type="number" id="cgBMHMZ" value="5" class="cg-xs"></div>';
    h+='<div class="cg-param-item"><label>mesh_min(x,y)：</label><input type="text" id="cgBMMeshMin" value="30,30" style="width:100px;"></div>';
    h+='<div class="cg-param-item"><label>mesh_max(x,y)：</label><input type="text" id="cgBMMeshMax" value="270,270" style="width:100px;"></div>';
    h+='<div class="cg-param-item"><label>probe_count：</label><input type="text" id="cgBMProbeCount" value="4,4" style="width:100px;"></div>';
    h+='<div class="cg-param-item"><label>algorithm：</label><select id="cgBMAlgo"><option value="bicubic" selected>bicubic</option><option value="lagrange">lagrange</option></select></div></div></div>';
    // screws_tilt_adjust
    h+='<h4 class="cg-section-title" style="margin-top:16px;"><i class="fas fa-screwdriver"></i> 手工调平辅助</h4>';
    h+='<div class="cg-param-grid">';
    h+='<div class="cg-param-item"><label><input type="checkbox" id="cgOptScrewsTilt" onchange="toggleOptPanel(\'ScrewsTilt\')"> [screws_tilt_adjust] 螺丝调平</label></div>';
    h+='<div class="cg-param-item"><label><input type="checkbox" id="cgOptZTilt" onchange="toggleOptPanel(\'ZTilt\')"> [z_tilt] 多Z轴自动调平</label></div>';
    h+='</div>';
    // screws_tilt params
    h+='<div id="cgScrewsTiltParams" style="display:none;margin-top:10px;"><div class="cg-param-grid">';
    h+='<div class="cg-param-item" style="grid-column:1/-1;"><label>螺丝坐标（x,y）：</label><input type="text" id="cgSTScrew1" value="30,30" style="width:80px;"> <input type="text" id="cgSTScrew2" value="200,30" style="width:80px;"> <input type="text" id="cgSTScrew3" value="200,200" style="width:80px;"> <input type="text" id="cgSTScrew4" value="30,200" style="width:80px;"></div>';
    h+='<div class="cg-param-item"><label>screw_thread：</label><input type="text" id="cgSTThread" value="CW-M3" style="width:80px;"></div>';
    h+='<div class="cg-param-item"><label>speed：</label><input type="number" id="cgSTSpeed" value="50" class="cg-xs"></div></div></div>';
    // z_tilt params
    h+='<div id="cgZTiltParams" style="display:none;margin-top:10px;"><div class="cg-param-grid">';
    h+='<div class="cg-param-item"><label>Z 电机列表：</label><input type="text" id="cgZTZMotors" value="z,z1" style="width:80px;"></div>';
    h+='<div class="cg-param-item"><label>Z 位置（x,y）：</label><input type="text" id="cgZTZPos" value="30,100" style="width:80px;"> <input type="text" id="cgZTZPos2" value="200,100" style="width:80px;"></div>';
    h+='<div class="cg-param-item"><label>retries：</label><input type="number" id="cgZTRetries" value="5" class="cg-xs"></div>';
    h+='<div class="cg-param-item"><label>retry_tolerance：</label><input type="number" step="0.001" id="cgZTZTolerance" value="0.0075" class="cg-xs"></div></div></div>';
    // 可选段开关
    h+='<h4 class="cg-section-title"><i class="fas fa-toggle-on"></i> 可选配置段</h4><div class="cg-param-grid">';
    h+='<div class="cg-param-item"><label><input type="checkbox" id="cgOptForceMove"> [force_move] 手动步进电机</label></div>';
    h+='<div class="cg-param-item"><label><input type="checkbox" id="cgOptVerifyHeater" checked onchange="toggleOptPanel(\'VerifyHeater\')"> [verify_heater] 加热校验</label></div>';
    h+='<div class="cg-param-item"><label><input type="checkbox" id="cgOptGcodeArcs" onchange="toggleOptPanel(\'GcodeArcs\')"> [gcode_arcs] 圆弧支持</label></div>';
    h+='<div class="cg-param-item"><label><input type="checkbox" id="cgOptIdleTimeout" checked onchange="toggleOptPanel(\'IdleTimeout\')"> [idle_timeout] 空闲超时</label></div>';
    h+='<div class="cg-param-item"><label><input type="checkbox" id="cgOptExcludeObj"> [exclude_object] 排除对象</label></div>';
    h+='<div class="cg-param-item"><label><input type="checkbox" id="cgOptClientVariable" onchange="toggleOptPanel(\'ClientVariable\')"> [_CLIENT_VARIABLE] 暂停/取消自定义</label></div></div>';
    // safe_z params (already in homing tab, but keep ID)
    // verify_heater params
    h+='<div id="cgVerifyHeaterParams" style="display:none;margin-top:10px;"><div class="cg-param-grid">';
    h+='<div class="cg-param-item"><label>max_error(秒)：</label><input type="number" id="cgVHMaxError" value="120" class="cg-xs"></div>';
    h+='<div class="cg-param-item"><label>check_gain_time(秒)：</label><input type="number" id="cgVHCheckGain" value="20" class="cg-xs"></div>';
    h+='<div class="cg-param-item"><label>hysteresis(℃)：</label><input type="number" step="0.1" id="cgVHHysteresis" value="5" class="cg-xs"></div>';
    h+='<div class="cg-param-item"><label>heating_gain(℃)：</label><input type="number" step="0.1" id="cgVHHeatingGain" value="2.0" class="cg-xs"></div></div></div>';
    // gcode_arcs
    h+='<div id="cgGcodeArcsParams" style="display:none;margin-top:10px;"><div class="cg-warn" style="display:block;margin-bottom:10px;"><i class="fas fa-exclamation-triangle"></i> 一般建议不要开启此项。</div><div class="cg-param-grid"><div class="cg-param-item"><label>resolution(mm)：</label><input type="number" step="0.1" id="cgGAResolution" value="1.0" class="cg-xs"></div></div></div>';
    // idle_timeout
    h+='<div id="cgIdleTimeoutParams" style="display:none;margin-top:10px;"><div class="cg-param-grid">';
    h+='<div class="cg-param-item"><label>timeout(秒)：</label><input type="number" id="cgITTimeout" value="600" class="cg-xs"></div>';
    h+='<div class="cg-param-item"><label>gcode(只读)：</label><textarea id="cgITGcode" rows="2" readonly style="font-family:monospace;font-size:12px;padding:6px;border:1px solid var(--border-color);border-radius:4px;background:var(--bg-color);width:100%;resize:none;">TURN_OFF_HEATERS\nM84</textarea></div></div></div>';
    // _CLIENT_VARIABLE params
    h+='<div id="cgClientVariableParams" style="display:none;margin-top:10px;border:1px solid var(--border-color);border-radius:8px;padding:14px;background:rgba(33,150,243,.03);">';
    h+='<p style="font-size:12px;color:var(--text-secondary);margin:0 0 10px;">需配合 <code>[include mainsail.cfg]</code> 或 <code>[include fluidd.cfg]</code> 使用。</p>';
    h+='<div class="cg-param-grid">';
    h+='<div class="cg-param-item"><label>use_custom_pos：</label><select id="cgCVUseCustomPos"><option value="False" selected>False</option><option value="True">True</option></select></div>';
    h+='<div class="cg-param-item"><label>custom_park_x：</label><input type="number" step="0.1" id="cgCVParkX" value="0.0" class="cg-xs"></div>';
    h+='<div class="cg-param-item"><label>custom_park_y：</label><input type="number" step="0.1" id="cgCVParkY" value="0.0" class="cg-xs"></div>';
    h+='<div class="cg-param-item"><label>custom_park_dz：</label><input type="number" step="0.1" id="cgCVParkDZ" value="2.0" class="cg-xs"></div>';
    h+='<div class="cg-param-item"><label>park_at_cancel：</label><select id="cgCVParkAtCancel"><option value="False" selected>False</option><option value="True">True</option></select></div>';
    h+='<div class="cg-param-item"><label>park_at_cancel_x：</label><input type="text" id="cgCVCancelX" value="None" style="width:100px;"></div>';
    h+='<div class="cg-param-item"><label>park_at_cancel_y：</label><input type="text" id="cgCVCancelY" value="None" style="width:100px;"></div>';
    h+='<div class="cg-param-item"><label>retract(mm)：</label><input type="number" step="0.1" id="cgCVRetract" value="1.0" class="cg-xs"></div>';
    h+='<div class="cg-param-item"><label>cancel_retract(mm)：</label><input type="number" step="0.1" id="cgCVCancelRetract" value="5.0" class="cg-xs"></div>';
    h+='<div class="cg-param-item"><label>speed_retract(mm/s)：</label><input type="number" step="0.1" id="cgCVSpeedRetract" value="35.0" class="cg-xs"></div>';
    h+='<div class="cg-param-item"><label>unretract(mm)：</label><input type="number" step="0.1" id="cgCVUnretract" value="1.0" class="cg-xs"></div>';
    h+='<div class="cg-param-item"><label>speed_unretract(mm/s)：</label><input type="number" step="0.1" id="cgCVSpeedUnretract" value="35.0" class="cg-xs"></div>';
    h+='<div class="cg-param-item"><label>speed_hop(mm/s)：</label><input type="number" step="0.1" id="cgCVSpeedHop" value="15.0" class="cg-xs"></div>';
    h+='<div class="cg-param-item"><label>speed_move(mm/s)：</label><input type="number" step="0.1" id="cgCVSpeedMove" value="100.0" class="cg-xs"></div>';
    h+='<div class="cg-param-item"><label>idle_timeout(秒)：</label><input type="number" id="cgCVIdleTimeout" value="86400" class="cg-xs"></div>';
    h+='<div class="cg-param-item"><label>use_fw_retract：</label><select id="cgCVUseFwRetract"><option value="False" selected>False</option><option value="True">True</option></select></div>';
    h+='<div class="cg-param-item"><label>runout_sensor：</label><input type="text" id="cgCVRunoutSensor" value="" placeholder="传感器名"></div>';
    h+='<div class="cg-param-item"><label>user_pause_macro：</label><input type="text" id="cgCVUserPause" value="" placeholder="单行命令"></div>';
    h+='<div class="cg-param-item"><label>user_resume_macro：</label><input type="text" id="cgCVUserResume" value="" placeholder="单行命令"></div>';
    h+='<div class="cg-param-item"><label>user_cancel_macro：</label><input type="text" id="cgCVUserCancel" value="" placeholder="单行命令"></div>';
    h+='</div></div>';
    // ADXL345
    h+='<h4 class="cg-section-title"><i class="fas fa-wave-square"></i> 加速度计（共振补偿）</h4>';
    h+='<div class="cg-param-item" style="margin-bottom:8px;"><label><input type="checkbox" id="cgOptAdxl345" onchange="toggleOptPanel(\'Adxl345\');onAdxlTypeChange()"> 启用 [adxl345]</label></div>';
    h+='<div id="cgAdxl345Params" style="display:none;">';
    h+='<div class="cg-param-grid"><div class="cg-param-item"><label>连接方式：</label><select id="cgAdxlConnType" onchange="onAdxlTypeChange()"><option value="spi_bus">SPI总线</option><option value="spi_pins">SPI引脚</option><option value="usb">USB模块</option></select></div></div>';
    h+='<div id="cgAdxlSpiBusPanel"><div class="cg-param-grid"><div class="cg-param-item"><label>spi_bus：</label><select id="cgAdxlSpiBus"><option value="spi1">SPI1</option><option value="spi2" selected>SPI2</option><option value="spi3">SPI3</option></select></div><div class="cg-param-item"><label>cs_pin：</label><input type="text" id="cgAdxlCsPin" value="PA4" style="width:100px;"></div></div></div>';
    h+='<div id="cgAdxlSpiPinsPanel" style="display:none;"><div class="cg-param-grid"><div class="cg-param-item"><label>cs_pin：</label><input type="text" id="cgAdxlCsPin2" value="PA4" style="width:100px;"></div><div class="cg-param-item"><label>sclk_pin：</label><input type="text" id="cgAdxlSclkPin" value="PA5" style="width:100px;"></div><div class="cg-param-item"><label>mosi_pin：</label><input type="text" id="cgAdxlMosiPin" value="PA7" style="width:100px;"></div><div class="cg-param-item"><label>miso_pin：</label><input type="text" id="cgAdxlMisoPin" value="PA6" style="width:100px;"></div></div></div>';
    h+='<div id="cgAdxlUsbPanel" style="display:none;"><div class="cg-param-grid"><div class="cg-param-item"><label>serial：</label><input type="text" id="cgAdxlSerial" value="/dev/serial/by-id/usb-Adxl345" style="width:100%;"></div></div></div>';
    h+='<div class="cg-param-grid" style="margin-top:8px;">';
    h+='<div class="cg-param-item"><label>axes_map：</label><select id="cgAdxlAxesMap"><option value="x,y,z" selected>x,y,z</option><option value="x,z,y">x,z,y</option><option value="z,y,x">z,y,x</option></select></div>';
    h+='<div class="cg-param-item"><label>rate：</label><input type="number" id="cgAdxlRate" value="3200" class="cg-xs"></div>';
    h+='<div class="cg-param-item"><label>offset_x：</label><input type="number" step="0.001" id="cgAdxlOffX" value="0.0" class="cg-xs"></div>';
    h+='<div class="cg-param-item"><label>offset_y：</label><input type="number" step="0.001" id="cgAdxlOffY" value="0.0" class="cg-xs"></div>';
    h+='<div class="cg-param-item"><label>offset_z：</label><input type="number" step="0.001" id="cgAdxlOffZ" value="0.0" class="cg-xs"></div></div>';
    h+='<h4 class="cg-section-title" style="font-size:13px;"><i class="fas fa-vibrate"></i> [resonance_tester]</h4><div class="cg-param-grid">';
    h+='<div class="cg-param-item"><label>accel_chip：</label><input type="text" id="cgResTestChip" value="adxl345" style="width:120px;" readonly></div>';
    h+='<div class="cg-param-item"><label>probe_points：</label><input type="text" id="cgResTestPoints" value="125,125,20" style="width:120px;"></div>';
    h+='<div class="cg-param-item"><label>auto_calibrate：</label><select id="cgResTestAutoCal"><option value="True" selected>True</option><option value="False">False</option></select></div>';
    h+='</div></div>';
    // 温度监控
    h+='<h4 class="cg-section-title"><i class="fas fa-thermometer-half"></i> 温度监控</h4>';
    h+='<div class="cg-param-item" style="margin-bottom:8px;"><label><input type="checkbox" id="cgOptTempMonitor" checked onchange="toggleOptPanel(\'TempMonitor\')"> 启用温度传感器</label></div>';
    h+='<div id="cgTempMonitorParams"><div class="cg-param-grid">';
    h+='<div class="cg-param-item"><label>MCU传感器名称：</label><input type="text" id="cgTempMCUName" value="MCU温度" style="width:120px;"></div>';
    h+='<div class="cg-param-item"><label>上位机传感器名称：</label><input type="text" id="cgTempHostName" value="上位机温度" style="width:120px;"></div></div></div>';
    // 打印宏
    h+='<h4 class="cg-section-title"><i class="fas fa-code"></i> 打印宏</h4>';
    h+='<div class="cg-param-item" style="margin-bottom:8px;"><label><input type="checkbox" id="cgOptPrintMacros" onchange="toggleOptPanel(\'PrintMacros\')"> 生成 PRINT_START / PRINT_END 宏</label></div>';
    h+='<div id="cgPrintMacrosParams" style="display:none;"><p style="font-size:12px;color:var(--text-secondary);margin:0 0 8px;">生成标准打印开始/结束宏</p>';
    h+='<div class="cg-param-item"><label>PRINT_START 预览：</label><textarea rows="5" readonly style="font-family:monospace;font-size:11px;padding:6px;border:1px solid var(--border-color);border-radius:4px;background:var(--bg-color);width:100%;resize:vertical;">G92 E0\nBED_MESH_CLEAR\nG28\nG1 Z20 F3000\nBED_MESH_PROFILE LOAD=default</textarea></div>';
    h+='<div class="cg-param-item" style="margin-top:8px;"><label>PRINT_END 预览：</label><textarea rows="8" readonly style="font-family:monospace;font-size:11px;padding:6px;border:1px solid var(--border-color);border-radius:4px;background:var(--bg-color);width:100%;resize:vertical;">M400\nG92 E0\nG1 E-10.0 F3600\nG91\nG0 Z2 F3600\nM104 S0\nM140 S0\nM106 S0\nG90\nBED_MESH_CLEAR</textarea></div></div>';
    // 运动学
    h+='<h4 class="cg-section-title"><i class="fas fa-tachometer-alt"></i> 运动学参数</h4><div class="cg-param-grid">';
    h+='<div class="cg-param-item"><label>max_velocity(mm/s)：</label><input type="number" id="cgMaxVel" value="300" class="cg-xs"></div>';
    h+='<div class="cg-param-item"><label>max_accel(mm/s²)：</label><input type="number" id="cgMaxAccel" value="3000" class="cg-xs"></div>';
    h+='<div class="cg-param-item"><label>max_z_velocity(mm/s)：</label><input type="number" id="cgMaxZVel" value="15" class="cg-xs"></div>';
    h+='<div class="cg-param-item"><label>max_z_accel(mm/s²)：</label><input type="number" id="cgMaxZAccel" value="100" class="cg-xs"></div>';
    h+='<div class="cg-param-item"><label>square_corner_vel(mm/s)：</label><input type="number" step="0.1" id="cgCornerVel" value="5.0" class="cg-xs"></div></div>';
    c.innerHTML=h;
    // init panels
    if(document.getElementById('cgOptVerifyHeater')?.checked) document.getElementById('cgVerifyHeaterParams').style.display='block';
    if(document.getElementById('cgOptIdleTimeout')?.checked) document.getElementById('cgIdleTimeoutParams').style.display='block';
    if(document.getElementById('cgOptAdxl345')?.checked) { document.getElementById('cgAdxl345Params').style.display='block'; onAdxlTypeChange(); }
}
// 保留旧函数以防其他地方调用
function renderParameterInputs() { renderHomingParams(); renderLevelingParams(); }

function onAdxlTypeChange() {
    const t=document.getElementById('cgAdxlConnType')?.value||'spi_bus';
    const sp=document.getElementById('cgAdxlSpiBusPanel'),spp=document.getElementById('cgAdxlSpiPinsPanel'),up=document.getElementById('cgAdxlUsbPanel');
    if(sp) sp.style.display=t==='spi_bus'?'block':'none';
    if(spp) spp.style.display=t==='spi_pins'?'block':'none';
    if(up) up.style.display=t==='usb'?'block':'none';
}
function toggleOptPanel(name) {
    const panel=document.getElementById(`cg${name}Params`);
    const chk=document.getElementById(`cgOpt${name}`);
    if(panel&&chk) panel.style.display=chk.checked?'block':'none';
}
function onTmcModelChg(i) {
    const model=document.getElementById(`cgTmcModel_${i}`)?.value;
    const curEl=document.getElementById(`cgTmcCurrent_${i}`);
    if(model==='tmc5160'&&curEl) curEl.value='1.0';
    else if(model==='tmc2209'&&curEl) curEl.value='0.8';
    else if(model==='tmc2240'&&curEl) curEl.value='1.0';
    else if(model==='tmc2130'&&curEl) curEl.value='1.0';
    else if(model==='tmc2208'&&curEl) curEl.value='0.8';
    else if(model==='tmc2660'&&curEl) curEl.value='1.2';
    else if(model==='a4988'&&curEl) curEl.value='1.0';
    // TMC型号变更后刷新DIAG限位区域
    renderEndstopConfig();
}
function updateHomePosHint(axis) {
    const chk=document.getElementById(`cgHome_${axis}_posd`), hint=document.getElementById(`cgHome_${axis}_hint`);
    if(chk&&hint) hint.textContent=chk.checked?'正→max':'负→min';
    if(chk) _cgHomingDirs[axis]=chk.checked;
    // 不再反推原点下拉框——原点位置和归位方向是独立概念
    renderHomingVisualization();
}
function renderHomingVisualization() {
    const c=document.getElementById('cgHomingVizContainer'); if(!c) return;
    if(!Object.keys(_cgHomingDirs).length){c.innerHTML='';return;}
    const xD=_cgHomingDirs['X'],yD=_cgHomingDirs['Y'],zD=_cgHomingDirs['Z'];
    const ox=xD?248:32,oy=yD?32:248,oL=(xD?'右':'左')+(yD?'后':'前');
    const xT=xD?248:32,xTl=xD?60:220,xL=xD?'X+→max':'X-→min';
    const yT=yD?32:248,yTl=yD?220:60,yL=yD?'Y+→max':'Y-→min';
    const zT=zD?32:248,zTl=zD?220:60,zL=zD?'Z+↑max':'Z-↓min';
    // 读取限位位置（min端/max端）
    const xES = document.getElementById('cgHome_X_estop')?.value || 'min';
    const yES = document.getElementById('cgHome_Y_estop')?.value || 'min';
    const zES = document.getElementById('cgHome_Z_estop')?.value || 'min';
    // X轴限位标记
    const xEsX = xES==='max' ? 248 : 32;
    const xEsLabel = xES==='max' ? '限位▶' : '◀限位';
    // Y轴限位标记
    const yEsY = yES==='max' ? 32 : 248;
    const yEsLabel = yES==='max' ? '限位▲' : '▼限位';
    // Z轴限位标记
    const zEsY = zES==='max' ? 32 : 248;
    const zEsLabel = zES==='max' ? '限位▲' : '▼限位';
    // 描述文字
    const xDe = xD ? '正方向（向右归位）' : '负方向（向左归位）';
    const yDe = yD ? '正方向（向后归位）' : '负方向（向前归位）';
    const zDe = zD ? '正方向（向上归位）' : '负方向（向下归位）';

    c.innerHTML=`<svg viewBox="0 0 350 290" style="width:550px;height:456px;flex-shrink:0;"><defs><marker id="ahX" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto"><path d="M0,0 L8,3 L0,6Z" fill="#2196f3"/></marker><marker id="ahY" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto"><path d="M0,0 L8,3 L0,6Z" fill="#4caf50"/></marker><marker id="ahZ" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto"><path d="M0,0 L8,3 L0,6Z" fill="#ff9800"/></marker></defs><!-- 热床 --><rect x="30" y="30" width="220" height="220" rx="6" fill="#f5f5f5" stroke="#ddd" stroke-width="2"/><!-- 网格 --><line x1="85" y1="30" x2="85" y2="250" stroke="#eee" stroke-width=".5"/><line x1="140" y1="30" x2="140" y2="250" stroke="#eee" stroke-width=".5"/><line x1="195" y1="30" x2="195" y2="250" stroke="#eee" stroke-width=".5"/><line x1="30" y1="85" x2="250" y2="85" stroke="#eee" stroke-width=".5"/><line x1="30" y1="140" x2="250" y2="140" stroke="#eee" stroke-width=".5"/><line x1="30" y1="195" x2="250" y2="195" stroke="#eee" stroke-width=".5"/><!-- 原点 --><circle cx="${ox}" cy="${oy}" r="7" fill="#e53935"/><text x="${ox}" y="${oy+20}" text-anchor="middle" font-size="10" font-weight="bold" fill="#e53935" font-family="sans-serif">原点(${oL})</text><!-- X 归位箭头 --><line x1="${xTl}" y1="140" x2="${xT}" y2="140" stroke="#2196f3" stroke-width="2.5" marker-end="url(#ahX)"/><text x="${(xTl+xT)/2}" y="133" text-anchor="middle" fill="#2196f3" font-size="10" font-weight="700" font-family="sans-serif">${xL}</text><!-- X 限位标记 --><rect x="${xEsX-4}" y="132" width="8" height="16" rx="2" fill="#ff5722" stroke="#e64a19" stroke-width="1"/><text x="${xEsX}" y="${xES==='max'?126:156}" text-anchor="middle" fill="#e64a19" font-size="8" font-weight="700" font-family="sans-serif">${xEsLabel}</text><!-- Y 归位箭头 --><line x1="140" y1="${yTl}" x2="140" y2="${yT}" stroke="#4caf50" stroke-width="2.5" marker-end="url(#ahY)"/><text x="155" y="${(yTl+yT)/2+4}" fill="#4caf50" font-size="10" font-weight="700" font-family="sans-serif">${yL}</text><!-- Y 限位标记 --><rect x="132" y="${yEsY-4}" width="16" height="8" rx="2" fill="#ff5722" stroke="#e64a19" stroke-width="1"/><text x="${yES==='max'?128:152}" y="${yEsY+3}" text-anchor="middle" fill="#e64a19" font-size="8" font-weight="700" font-family="sans-serif">${yEsLabel}</text><!-- Z 归位箭头 --><rect x="270" y="30" width="20" height="220" rx="4" fill="#f5f5f5" stroke="#ddd" stroke-width="1"/><line x1="280" y1="${zTl}" x2="280" y2="${zT}" stroke="#ff9800" stroke-width="2.5" stroke-dasharray="6,3" marker-end="url(#ahZ)"/><text x="280" y="22" text-anchor="middle" fill="#ff9800" font-size="10" font-weight="700" font-family="sans-serif">Z</text><text x="300" y="${(zTl+zT)/2+4}" fill="#ff9800" font-size="9" font-weight="700" font-family="sans-serif">${zL}</text><!-- Z 限位标记 --><rect x="274" y="${zEsY-4}" width="12" height="8" rx="2" fill="#ff5722" stroke="#e64a19" stroke-width="1"/><text x="298" y="${zEsY+3}" fill="#e64a19" font-size="8" font-weight="700" font-family="sans-serif">${zEsLabel}</text><!-- 方位 --><text x="140" y="22" text-anchor="middle" fill="#999" font-size="9" font-family="sans-serif">后</text><text x="140" y="268" text-anchor="middle" fill="#999" font-size="9" font-family="sans-serif">前</text><text x="16" y="144" text-anchor="middle" fill="#999" font-size="9" font-family="sans-serif" transform="rotate(-90,16,144)">左</text><text x="264" y="144" text-anchor="middle" fill="#999" font-size="9" font-family="sans-serif" transform="rotate(90,264,144)">右</text></svg><div style="flex:1;min-width:160px;font-size:13px;"><div style="margin-bottom:8px;padding:8px 12px;background:rgba(33,150,243,.06);border-radius:6px;border-left:3px solid #2196f3;"><strong style="color:#2196f3;">X轴：</strong>${xDe}</div><div style="margin-bottom:8px;padding:8px 12px;background:rgba(76,175,80,.06);border-radius:6px;border-left:3px solid #4caf50;"><strong style="color:#4caf50;">Y轴：</strong>${yDe}</div><div style="padding:8px 12px;background:rgba(255,152,0,.06);border-radius:6px;border-left:3px solid #ff9800;"><strong style="color:#ff9800;">Z轴：</strong>${zDe}</div></div>`;
}
// ========== 配置生成 ==========
function generateConfig() {
    if (!_currentMapping || !_currentBoardInfo) { cgShowToast('请先选择主板','error'); switchCgTab(1); return; }
    if (!validateAxisAssignment()) { cgHighlightError(null,'存在重复轴分配，请检查步骤3的驱动器分配后再生成'); return; }
    const errEl = document.getElementById('errorMessage'); errEl.style.display = 'none';
    const m = _currentMapping;
    const _DM={rotation_distance:40,microsteps:16,homing_speed:50,position_min:0,position_max:200,position_endstop:0};
    const _DE={rotation_distance:22.67,microsteps:16,filament_diameter:1.75,nozzle_diameter:0.4,max_temp:285,sensor_type:'NTC 100K beta 3950'};
    const _DB={sensor_type:'NTC 100K beta 3950',max_temp:120};
    const B=(t)=>'#####################################################################\n# '+t.padEnd(66)+'#\n#####################################################################\n';
    let config = B('3D MELLOW / FLY 配置 - Firmware-Tool 配置生成器自动生成');
    config += '## 如需售后，请联系淘宝客服\n## FLY 售后技术支持群:621032883\n\n';
    // ---- [mcu] ----
    const connType = document.getElementById('cgConnection').value;
    const serial = document.getElementById('cgSerial').value.trim();
    const baud = document.getElementById('cgBaud').value;
    if (serial) {
        if (connType==='can') { if (!/^[0-9a-fA-F:]{6,}$/.test(serial)) { cgHighlightError('cgSerial','CAN UUID 格式错误，应为 16 进制字符串如 3a8e2d4c1f05'); return; } }
        else { if (!serial.startsWith('/dev/') && !serial.startsWith('/tmp/')) { cgHighlightError('cgSerial','MCU serial 应以 /dev/ 开头，例如 /dev/serial/by-id/usb-xxx'); return; } }
    }
    config += B('主板配置');
    config += '[mcu]                           # FLY主板\n';
    if (serial) { if (connType==='can') config+=`canbus_uuid: ${serial}     # CAN总线UUID\n`; else { config+=`serial: ${serial}\n`; if(connType==='usb') config+=`baud: ${baud}\n`; } }
    else config += '# TODO: 请填写 MCU 连接信息\n';
    config += '\n';
    // ---- [printer] ----
    const maxVel=document.getElementById('cgMaxVel')?.value||300;
    const maxAccel=document.getElementById('cgMaxAccel')?.value||3000;
    const maxZVel=document.getElementById('cgMaxZVel')?.value||15;
    const maxZAccel=document.getElementById('cgMaxZAccel')?.value||100;
    const cornerVel=document.getElementById('cgCornerVel')?.value||5.0;
    config += B('机型和加速度');
    config += '[printer]                       # 打印机设置\n';
    config += `kinematics: ${(_currentPreset?.geometry?.type==='cartesian'?'cartesian':'corexy')}              # 运动学结构\n`;
    config += `max_velocity: ${maxVel}               # 最大速度\n`;
    config += `max_accel: ${maxAccel}                 # 最大加速度\n`;
    config += `max_z_velocity: ${maxZVel}                # Z轴最大速度\n`;
    config += `max_z_accel: ${maxZAccel}                # Z轴最大加速度\n`;
    config += `square_corner_velocity: ${cornerVel}     # 拐角速度\n\n`;
    // ---- 温度监控 ----
    if(document.getElementById('cgOptTempMonitor')?.checked) {
        const mcuN=document.getElementById('cgTempMCUName')?.value||'MCU温度';
        const hostN=document.getElementById('cgTempHostName')?.value||'上位机温度';
        config += B('温度监控');
        config += `[temperature_sensor ${mcuN}]     # 主板温度\n`;
        config += 'sensor_type: temperature_mcu     # 关联mcu\n';
        config += '#--------------------------------------------------------------------\n';
        config += `[temperature_sensor ${hostN}]     # 上位机温度\n`;
        config += 'sensor_type: temperature_host     # 关联上位机\n\n';
    }
    // ---- bed_mesh ----
    if(document.getElementById('cgOptBedMesh')?.checked) {
        config += B('热床网格校准');
        config += '[bed_mesh]\n';
        config += `speed: ${document.getElementById('cgBMSpeed')?.value||50}                    # 校准速度\n`;
        config += `horizontal_move_z: ${document.getElementById('cgBMHMZ')?.value||5}         # 探针前Z抬升高度\n`;
        config += `mesh_min: ${document.getElementById('cgBMMeshMin')?.value||'30,30'}              # 最小校准点坐标\n`;
        config += `mesh_max: ${document.getElementById('cgBMMeshMax')?.value||'270,270'}           # 最大校准点坐标\n`;
        config += `probe_count: ${document.getElementById('cgBMProbeCount')?.value||'4,4'}             # 采样点数\n`;
        config += 'mesh_pps: 2,2                # 补充采样点数\n';
        config += `algorithm: ${document.getElementById('cgBMAlgo')?.value||'bicubic'}           # 算法模型\n`;
        config += 'bicubic_tension: 0.2         # 算法插值\n\n';
    }
    // ---- screws_tilt_adjust ----
    if(document.getElementById('cgOptScrewsTilt')?.checked) {
        const s1=document.getElementById('cgSTScrew1')?.value||'30,30';
        const s2=document.getElementById('cgSTScrew2')?.value||'200,30';
        const s3=document.getElementById('cgSTScrew3')?.value||'200,200';
        const s4=document.getElementById('cgSTScrew4')?.value||'30,200';
        const thread=document.getElementById('cgSTThread')?.value||'CW-M3';
        const stSpeed=document.getElementById('cgSTSpeed')?.value||50;
        config += B('螺丝调平辅助');
        config += '[screws_tilt_adjust]\n';
        config += `screw1: ${s1}\n`; config += `screw1_name: front left screw\n`;
        config += `screw2: ${s2}\n`; config += `screw2_name: front right screw\n`;
        config += `screw3: ${s3}\n`; config += `screw3_name: rear right screw\n`;
        config += `screw4: ${s4}\n`; config += `screw4_name: rear left screw\n`;
        config += `horizontal_move_z: 10.\n`;
        config += `speed: ${stSpeed}\n`;
        config += `screw_thread: ${thread}\n\n`;
    }
    // ---- z_tilt ----
    if(document.getElementById('cgOptZTilt')?.checked) {
        const zMotors=document.getElementById('cgZTZMotors')?.value||'z,z1';
        const zPos1=document.getElementById('cgZTZPos')?.value||'30,100';
        const zPos2=document.getElementById('cgZTZPos2')?.value||'200,100';
        const ztRetries=document.getElementById('cgZTRetries')?.value||5;
        const ztTol=document.getElementById('cgZTZTolerance')?.value||0.0075;
        config += B('多Z轴自动调平');
        config += '[z_tilt]\n';
        config += `z_positions: ${zPos1}\n              ${zPos2}\n`;
        config += `points: ${zMotors.split(',').map((z,i)=>i===0?zPos1:zPos2).join('\n       ')}  # 对应各Z轴\n`;
        config += `speed: 100\n`;
        config += `horizontal_move_z: 5\n`;
        config += `retries: ${ztRetries}\n`;
        config += `retry_tolerance: ${ztTol}\n\n`;
    }
    // ---- 收集轴分配和功能引脚 ----
    const drives = []; for (let i=0;;i++) { if(m[`Drives${i}`]) drives.push({key:`Drives${i}`,idx:i,...m[`Drives${i}`]}); else break; }
    const axisAssign = [];
    drives.forEach((d,i) => { const sel=document.getElementById(`cgAxis_${i}`); axisAssign.push({drive:d.key, axis:sel?sel.value:'', info:d}); });
    const funcPins = {};
    document.querySelectorAll('[id^="cgFunc_"]').forEach(sel => {
        const key = sel.id.replace('cgFunc_',''); const val = sel.value;
        if (val && m[key]!==undefined) { const pin=Array.isArray(m[key])?m[key][0]:m[key]; funcPins[key]={pin,func:val}; }
    });
    // ---- [stepper_*] + TMC ----
    const axisLabels={X:'X轴',Y:'Y轴',Z:'Z轴',X1:'X1轴',Y1:'Y1轴',Z1:'Z1轴',Z2:'Z2轴',Z3:'Z3轴'};
    axisAssign.forEach((a,ai) => {
        if (!a.axis || a.axis==='E') return;
        const d = a.info, di=a.info.idx||ai;
        const al=axisLabels[a.axis]||a.axis+'轴';
        config += B(`${al}步进电机 on ${a.drive}`);
        config += `[stepper_${a.axis.toLowerCase()}]\n`;
        config += `step_pin: ${d.step_pin}                       # ${al}电机脉冲引脚设置\n`;
        config += `dir_pin: ${d.dir_pin}                        # ${al}电机方向引脚设置\n`;
        const tmcM=document.getElementById(`cgTmcModel_${di}`)?.value||'tmc2209';
        const invPin=['tmc2208','tmc2209','tmc5160','tmc2240','tmc2130','tmc2660','a4988','yanggong'].includes(tmcM)?'!':'';
        config += `enable_pin: ${invPin}${d.enable_pin}                   # ${al}电机使能引脚设置\n`;
        const rd=document.getElementById(`cgMotion_${a.axis}_rd`)?.value||_DM.rotation_distance;
        const ms=parseInt(document.getElementById(`cgMotion_${a.axis}_ms`)?.value||_DM.microsteps);
        const fspr=document.getElementById(`cgMotion_${a.axis}_fspr`)?.value||'200';
        const hrd=document.getElementById(`cgMotion_${a.axis}_hrd`)?.value||'5';
        const spd=document.getElementById(`cgMotion_${a.axis}_spd`)?.value||'0.000004';
        const hs=document.getElementById(`cgMotion_${a.axis}_hs`)?.value||_DM.homing_speed;
        const pmin=document.getElementById(`cgMotion_${a.axis}_min`)?.value||_DM.position_min;
        const pmax=document.getElementById(`cgMotion_${a.axis}_max`)?.value||200;
        const pes=document.getElementById(`cgMotion_${a.axis}_es`)?.value||_DM.position_endstop;
        const posDir=document.getElementById(`cgHome_${a.axis}_posd`)?.checked??false;
        const spd2=document.getElementById(`cgHome_${a.axis}_spd2`)?.value||Math.max(5,Math.round(parseFloat(hs)/2));
        config += `rotation_distance: ${rd}               # 主动带轮周长mm\n`;
        config += `microsteps: ${ms}                      # 电机细分\n`;
        config += `full_steps_per_rotation: ${fspr}        # 电机单圈脉冲数(1.8度:200,0.9度:400)\n`;
        // 限位引脚
        const isSecondary = /^[XYZ]1$/i.test(a.axis) || /^[XYZ][2-9]$/i.test(a.axis);
        if (!isSecondary) {
            const baseAxis = a.axis.toLowerCase().replace(/\d+/,'');
            // 检查是否使用 DIAG 引脚
            const diagChecked = document.getElementById(`cgEndstopDiag_${baseAxis.toUpperCase()}`)?.checked ?? false;
            const tmcM=document.getElementById(`cgTmcModel_${di}`)?.value||'tmc2209';
            if (diagChecked && d.diag_pin) {
                config += `endstop_pin: ${tmcM}_stepper_${baseAxis.toLowerCase()}:virtual_endstop                 # DIAG虚拟限位\n`;
            } else {
                const endstopKey = document.getElementById(`cgEndstopPin_${baseAxis.toUpperCase()}`)?.value;
                if (endstopKey && m[endstopKey] !== undefined) {
                    const isNO = document.getElementById(`cgEndstopNCNO_${baseAxis.toUpperCase()}`)?.value === 'NO';
                    const pin = Array.isArray(m[endstopKey]) ? m[endstopKey][0] : m[endstopKey];
                    config += `endstop_pin: ^${isNO?'!':''}${pin}                   # 限位开关PIN脚${isNO?' (NO常开)':' (NC常闭)'}\n`;
                }
            }
        }
        config += `position_min: ${pmin}                     # 软限位最小行程\n`;
        config += `position_endstop: ${pes}               # 限位位置\n`;
        config += `position_max: ${pmax}                   # 机械限位最大行程\n`;
        config += `homing_speed: ${hs}                    # 复位速度\n`;
        config += `homing_retract_dist: ${hrd}              # 归位后退距离\n`;
        config += `homing_positive_dir: ${posDir?'True':'False'}              # 归位方向\n`;
        config += `second_homing_speed: ${spd2}              # 二次归位速度\n`;
        config += `step_pulse_duration: ${spd}\n`;
        config += '#--------------------------------------------------------------------\n';
        // TMC驱动段
        const tmcModel=document.getElementById(`cgTmcModel_${di}`)?.value||'tmc2209';
        const tmcCur=document.getElementById(`cgTmcCurrent_${di}`)?.value||'0.8';
        if(tmcModel!=='none'&&d.uart_pin) {
            const diagEnabled = document.getElementById(`cgEndstopDiag_${a.axis.toUpperCase().replace(/\d+/,'')}`)?.checked ?? false;
            config += `[${tmcModel} stepper_${a.axis.toLowerCase()}]                 # ${al}驱动配置\n`;
            const diagPrefixMap={'tmc2209':'^','tmc5160':'^!','tmc2240':'^!','tmc2130':'^!'};
            if(tmcModel==='tmc5160'||tmcModel==='tmc2130') {
                config += `cs_pin: ${d.uart_pin}                      # SPI片选Pin脚\n`;
                if(d.spi_bus) config += `# spi_bus: ${d.spi_bus}                     # SPI总线\n`;
                if(diagEnabled && d.diag_pin) {
                    const dp=diagPrefixMap[tmcModel]||'';
                    config += `diag1_pin: ${dp}${d.diag_pin}                  # DIAG引脚(需^!前缀)\n`;
                    config += 'driver_SGT: 1                     # 灵敏度(-64最敏感 ~ 63最不敏感)\n';
                }
                config += `run_current: ${tmcCur}                    # 运行电流\n`;
                config += `stealthchop_threshold: 0            # 静音阈值(0=禁用静音, 999999=全静音)\n`;
                config += `#sense_resistor: 0.075               # 驱动采样电阻(默认自动检测)\n`;
            } else if(tmcModel==='tmc2240') {
                if(d.uart_pin) config += `uart_pin: ${d.uart_pin}                      # 通讯端口Pin脚定义\n`;
                if(diagEnabled && d.diag_pin) {
                    const dp=diagPrefixMap[tmcModel]||'';
                    config += `diag1_pin: ${dp}${d.diag_pin}                  # DIAG引脚(需^!前缀)\n`;
                    config += 'driver_SGT: 1                     # 灵敏度(-64最敏感 ~ 63最不敏感)\n';
                }
                config += `run_current: ${tmcCur}                    # 运行电流\n`;
                config += `stealthchop_threshold: 999999        # 静音阈值(全静音)\n`;
                config += `#sense_resistor: 0.110               # 驱动采样电阻(默认自动检测)\n`;
            } else {
                config += `uart_pin: ${d.uart_pin}                      # 通讯端口Pin脚定义\n`;
                if(diagEnabled && d.diag_pin) {
                    const dp=diagPrefixMap[tmcModel]||'^';
                    config += `diag_pin: ${dp}${d.diag_pin}                  # DIAG引脚(需前缀)\n`;
                    config += 'driver_SGTHRS: 100                # 灵敏度(0最不敏感 ~ 255最敏感)\n';
                }
                config += `run_current: ${tmcCur}                    # 运行电流\n`;
                config += `stealthchop_threshold: 999999        # 静音阈值(全静音)\n`;
                config += `#sense_resistor: 0.110               # 驱动采样电阻(默认自动检测)\n`;
            }
        }
        config += '#--------------------------------------------------------------------\n\n';
    });
    // ---- [extruder] + TMC ----
    const extDrive = axisAssign.find(a => a.axis==='E');
    if (extDrive) {
        const d=extDrive.info, edi=extDrive.info.idx||0;
        config += B('挤出机设置 (E0 Settings)');
        config += '[extruder]                          # 挤出机\n';
        config += `step_pin: ${d.step_pin}                       # 挤出电机脉冲引脚\n`;
        config += `dir_pin: ${d.dir_pin}                        # 挤出电机方向引脚\n`;
        const extTmc=document.getElementById(`cgTmcModel_${edi}`)?.value||'tmc2209';
        const extInv=['tmc2208','tmc2209','tmc5160','tmc2240','tmc2130','tmc2660','a4988','yanggong'].includes(extTmc)?'!':'';
        config += `enable_pin: ${extInv}${d.enable_pin}                   # 挤出电机使能引脚\n`;
        const rd=document.getElementById('cgExtRD')?.value||_DE.rotation_distance;
        const ms=document.getElementById('cgExtMS')?.value||_DE.microsteps;
        const fd=document.getElementById('cgExtFD')?.value||_DE.filament_diameter;
        const nd=document.getElementById('cgExtND')?.value||_DE.nozzle_diameter;
        const maxT=document.getElementById('cgExtMaxT')?.value||_DE.max_temp;
        const minT=document.getElementById('cgExtMinT')?.value||170;
        const st=document.getElementById('cgExtST')?.value||_DE.sensor_type;
        const gr=document.getElementById('cgExtGearRatio')?.value||'';
        const pa=document.getElementById('cgExtPA')?.value||'0.05';
        const pas=document.getElementById('cgExtPASmooth')?.value||'0.040';
        const med=document.getElementById('cgExtMaxDist')?.value||'100';
        const mec=document.getElementById('cgExtMaxCross')?.value||'50';
        const mep=document.getElementById('cgExtMaxPower')?.value||'1.0';
        const ec=document.getElementById('cgExtControl')?.value||'watermark';
        const emt=document.getElementById('cgExtMinTemp')?.value||'-235';
        config += `rotation_distance: ${rd}            # 步进值\n`;
        if(gr) config += `gear_ratio: ${gr}                   # 减速比\n`;
        config += `microsteps: ${ms}                      # 电机细分\n`;
        config += `full_steps_per_rotation: 200        # 单圈脉冲数\n`;
        config += `nozzle_diameter: ${nd}               # 喷嘴直径\n`;
        config += `filament_diameter: ${fd}              # 耗材直径\n`;
        const hk=document.getElementById('cgHeatPin_extruder')?.value;
        if(hk&&m[hk]!==undefined) { const pin=Array.isArray(m[hk])?m[hk][0]:m[hk]; config += `heater_pin: ${pin}                     # 加热棒引脚\n`; }
        config += `sensor_type: ${st}    # 传感器型号\n`;
        if(st==='PT100') config += '# ⚠️ PT100 需要 MAX31865 放大器模块，不可直连 MCU ADC 引脚\n';
        else if(st==='PT1000') config += '# ⚠️ PT1000 建议搭配放大器使用以确保精度\n';
        const tk=document.getElementById('cgTempPin_extruder')?.value;
        if(tk&&m[tk]!==undefined) { const pin=Array.isArray(m[tk])?m[tk][0]:m[tk]; config += `sensor_pin: ${pin}                     # 传感器引脚\n`; }
        config += `min_temp: ${emt}                        # 最小温度\n`;
        config += `max_temp: ${maxT}                       # 最大温度\n`;
        config += `max_power: ${mep}                      # 最大功率\n`;
        config += `min_extrude_temp: ${minT}               # 最小挤出温度\n`;
        config += `pressure_advance: ${pa}              # 推进压力\n`;
        config += `pressure_advance_smooth_time: ${pas} # 平稳推进时间\n`;
        config += `max_extrude_only_distance: ${med}\n`;
        config += `max_extrude_cross_section:${mec}\n`;
        config += `control:${ec}\n`;
        config += 'step_pulse_duration: 0.000004\n';
        config += '#--------------------------------------------------------------------\n';
        // TMC驱动段
        const tmcModel=document.getElementById(`cgTmcModel_${edi}`)?.value||'tmc2209';
        const tmcCur=document.getElementById(`cgTmcCurrent_${edi}`)?.value||'0.5';
        if(tmcModel!=='none'&&d.uart_pin) {
            config += `[${tmcModel} extruder]                  # 挤出机驱动配置\n`;
            if(tmcModel==='tmc5160') {
                config += `cs_pin: ${d.uart_pin}                      # SPI片选Pin脚\n`;
                if(d.spi_bus) config += `# spi_bus: ${d.spi_bus}                     # SPI总线\n`;
            } else {
                config += `uart_pin: ${d.uart_pin}                      # 通讯端口Pin脚定义\n`;
            }
            config += `run_current: ${tmcCur}                    # 运行电流\n`;
            if(extTmc==='tmc2209'||extTmc==='tmc2208') config += 'stealthchop_threshold: 999999        # 静音阈值(全静音)\n';
            config += `#sense_resistor: ${extTmc==='tmc5160'?'0.075':'0.110'}               # 驱动采样电阻\n`;
        }
        config += '#--------------------------------------------------------------------\n\n';
    }
    // ---- [heater_bed] ----
    const bedHK=document.getElementById('cgHeatPin_heater_bed')?.value;
    const bedTK=document.getElementById('cgTempPin_heater_bed')?.value;
    if(bedHK||bedTK) {
        config += B('热床配置');
        config += '[heater_bed]\n';
        if(bedHK&&m[bedHK]!==undefined) { const pin=Array.isArray(m[bedHK])?m[bedHK][0]:m[bedHK]; config+=`heater_pin: ${pin}              # 热床接口\n`; }
        const bst=document.getElementById('cgBedST')?.value||_DB.sensor_type;
        if(bedTK&&m[bedTK]!==undefined) { const pin=Array.isArray(m[bedTK])?m[bedTK][0]:m[bedTK]; config+=`sensor_type: ${bst}    # 热床传感器类型\nsensor_pin: ${pin}              # 热床传感器接口\n`; }
        if(bst==='PT100') config += '# ⚠️ PT100 需要 MAX31865 放大器模块，不可直连 MCU ADC 引脚\n';
        else if(bst==='PT1000') config += '# ⚠️ PT1000 建议搭配放大器使用以确保精度\n';
        config += `max_power: ${document.getElementById('cgBedMaxPower')?.value||'1.0'}               # 热床功率\n`;
        config += `min_temp: ${document.getElementById('cgBedMinTemp')?.value||'-235'}                  # 最小温度\n`;
        config += `max_temp: ${document.getElementById('cgBedMaxT')?.value||_DB.max_temp}                # 最大温度\n`;
        config += `control:${document.getElementById('cgBedControl')?.value||'watermark'}\n\n`;
    }
    // ---- 额外加热器 / temperature_sensor ----
    for(let i=1;i<=_extraHeaterCount;i++) {
        const sec=document.getElementById(`cgExtraSection_${i}`)?.value||'heater_generic';
        const name=document.getElementById(`cgExtraName_${i}`)?.value||`extra_heater_${i}`;
        const st=document.getElementById(`cgExtraST_${i}`)?.value||'NTC 100K beta 3950';
        const maxT=document.getElementById(`cgExtraMaxT_${i}`)?.value||'120';
        if(sec==='heater_generic') {
            const heatKey=document.getElementById(`cgExtraHeatPin_${i}`)?.value;
            const tempKey=document.getElementById(`cgExtraTempPin_${i}`)?.value;
            if(!heatKey&&!tempKey) continue;
            config += B(`额外加热器: ${name}`);
            config += `[heater_generic ${name}]\n`;
            if(heatKey&&m[heatKey]!==undefined) { const pin=Array.isArray(m[heatKey])?m[heatKey][0]:m[heatKey]; config+=`heater_pin: ${pin}\n`; }
            if(tempKey&&m[tempKey]!==undefined) { const pin=Array.isArray(m[tempKey])?m[tempKey][0]:m[tempKey]; config+=`sensor_type: ${st}\nsensor_pin: ${pin}\n`; }
            if(st==='PT100') config += '# ⚠️ PT100 需要 MAX31865 放大器\n';
            else if(st==='PT1000') config += '# ⚠️ PT1000 建议搭配放大器\n';
            config += `max_temp: ${maxT}\n`;
            config += `min_temp: ${document.getElementById(`cgExtraMinTemp_${i}`)?.value||'-235'}\n`;
            config += `max_power: ${document.getElementById(`cgExtraMaxPower_${i}`)?.value||'1.0'}\n`;
            config += `control:${document.getElementById(`cgExtraCtrl_${i}`)?.value||'watermark'}\n\n`;
        } else {
            const tempKey=document.getElementById(`cgExtraTempPin_${i}`)?.value;
            if(!tempKey) continue;
            config += B(`温度传感器: ${name}`);
            config += `[temperature_sensor ${name}]\n`;
            if(tempKey&&m[tempKey]!==undefined) { const pin=Array.isArray(m[tempKey])?m[tempKey][0]:m[tempKey]; config+=`sensor_type: ${st}\nsensor_pin: ${pin}\n`; }
            if(st==='PT100') config += '# ⚠️ PT100 需要 MAX31865 放大器\n';
            else if(st==='PT1000') config += '# ⚠️ PT1000 建议搭配放大器\n';
            config += `max_temp: ${maxT}\n`;
            const gcodeId=document.getElementById(`cgExtraGcodeId_${i}`)?.value;
            if(gcodeId) config += `gcode_id: ${gcodeId}\n`;
            config += '\n';
        }
    }
    // ---- [fan] [heater_fan] [controller_fan] ----
    const partFanKey=document.getElementById('cgFanPin_part_fan')?.value;
    const throatFanKey=document.getElementById('cgFanPin_throat_fan')?.value;
    const driverFanKey=document.getElementById('cgFanPin_driver_fan')?.value;
    const ctrlFanKey=document.getElementById('cgFanPin_controller_fan')?.value;
    const exhFanKey=document.getElementById('cgFanPin_exhaust_fan')?.value;
    if(partFanKey||throatFanKey||driverFanKey||ctrlFanKey||exhFanKey) {
        config += B('风扇配置');
        if(partFanKey&&m[partFanKey]!==undefined) { const pin=Array.isArray(m[partFanKey])?m[partFanKey][0]:m[partFanKey]; config+='[fan]                        # 模型冷却风扇\n'; config+=`pin: ${pin}                     # 信号接口\n`; config+='max_power: 1.0               # 最大转速\nshutdown_speed: 0.0          # 关机转速\nkick_start_time: 0.5         # 启动时间\noff_below: 0.10              # 最低启动\n'; config+='#--------------------------------------------------------------------\n'; }
        if(throatFanKey&&m[throatFanKey]!==undefined) { const pin=Array.isArray(m[throatFanKey])?m[throatFanKey][0]:m[throatFanKey]; config+='[heater_fan hotend_fan]      # 喉管冷却风扇\n'; config+=`pin: ${pin}                     # 信号接口\n`; config+='max_power: 1.0               # 最大转速\nkick_start_time: 0.5         # 启动时间\nheater: extruder             # 关联设备\nheater_temp: 50              # 启动温度\nfan_speed: 1.0               # 风扇转速\n'; config+='#--------------------------------------------------------------------\n'; }
        if(driverFanKey&&m[driverFanKey]!==undefined) { const pin=Array.isArray(m[driverFanKey])?m[driverFanKey][0]:m[driverFanKey]; config+='[controller_fan driver_fan]  # 驱动/主控散热风扇\n'; config+=`pin: ${pin}                     # 信号接口\n`; config+='max_power: 1.0               # 最大转速\nkick_start_time: 0.5         # 启动时间\nshutdown_speed: 0.5          # 关机转速\nheater: heater_bed           # 关联加热器\nfan_speed: 0.8               # 风扇转速\n'; config+='#--------------------------------------------------------------------\n'; }
        if(ctrlFanKey&&m[ctrlFanKey]!==undefined) { const pin=Array.isArray(m[ctrlFanKey])?m[ctrlFanKey][0]:m[ctrlFanKey]; config+='[heater_fan controller_fan]  # 电器仓风扇\n'; config+=`pin: ${pin}                     # 信号接口\n`; config+='max_power: 1.0\nkick_start_time: 0.5\nheater: heater_bed\nheater_temp: 50\nfan_speed: 1.0\n'; config+='#--------------------------------------------------------------------\n'; }
        if(exhFanKey&&m[exhFanKey]!==undefined) { const pin=Array.isArray(m[exhFanKey])?m[exhFanKey][0]:m[exhFanKey]; config+='[heater_fan exhaust_fan]    # 排风扇\n'; config+=`pin: ${pin}                     # 信号接口\n`; config+='max_power: 1.0\nkick_start_time: 0.5\nheater: heater_bed\nheater_temp: 70\nfan_speed: 1.0\n'; }
        config+='\n';
    }
    // ---- [adxl345] + [resonance_tester] ----
    if(document.getElementById('cgOptAdxl345')?.checked) {
        const connType=document.getElementById('cgAdxlConnType')?.value||'spi_bus';
        const axesMap=document.getElementById('cgAdxlAxesMap')?.value||'x,y,z';
        const rate=document.getElementById('cgAdxlRate')?.value||'3200';
        const offX=document.getElementById('cgAdxlOffX')?.value||'0.0';
        const offY=document.getElementById('cgAdxlOffY')?.value||'0.0';
        const offZ=document.getElementById('cgAdxlOffZ')?.value||'0.0';
        config += B('加速度计 ADXL345');
        if(connType==='usb') {
            // USB 独立模块 - 需要单独的 [mcu] 段
            const adxlSerial=document.getElementById('cgAdxlSerial')?.value||'/dev/serial/by-id/usb-Adxl345';
            config += '[mcu adxl]                  # USB加速度计独立MCU\n';
            config += `serial: ${adxlSerial}\n\n`;
            config += '[adxl345]\n';
            config += 'mcu: adxl\n';
        } else {
            config += '[adxl345]\n';
            if(connType==='spi_bus') {
                const spiBus=document.getElementById('cgAdxlSpiBus')?.value||'spi2';
                const csPin=document.getElementById('cgAdxlCsPin')?.value||'PA4';
                config += `spi_bus: ${spiBus}                  # SPI总线\n`;
                config += `cs_pin: ${csPin}                  # 片选引脚\n`;
            } else {
                const csPin2=document.getElementById('cgAdxlCsPin2')?.value||'PA4';
                const sclk=document.getElementById('cgAdxlSclkPin')?.value||'PA5';
                const mosi=document.getElementById('cgAdxlMosiPin')?.value||'PA7';
                const miso=document.getElementById('cgAdxlMisoPin')?.value||'PA6';
                config += `cs_pin: ${csPin2}\n`;
                config += `sclk_pin: ${sclk}\n`;
                config += `mosi_pin: ${mosi}\n`;
                config += `miso_pin: ${miso}\n`;
            }
        }
        config += `axes_map: ${axesMap}              # 轴向映射\n`;
        config += `rate: ${rate}                   # 采样率\n`;
        if(parseFloat(offX)!==0||parseFloat(offY)!==0||parseFloat(offZ)!==0) {
            config += `offset_x: ${offX}\n`;
            config += `offset_y: ${offY}\n`;
            config += `offset_z: ${offZ}\n`;
        }
        config += '#--------------------------------------------------------------------\n\n';
        // [resonance_tester]
        const chipName=document.getElementById('cgResTestChip')?.value||'adxl345';
        const probePoints=document.getElementById('cgResTestPoints')?.value||'125,125,20';
        const autoCal=document.getElementById('cgResTestAutoCal')?.value||'True';
        config += B('共振测试器');
        config += '[resonance_tester]\n';
        config += `accel_chip: ${chipName}              # 加速度计芯片\n`;
        config += `probe_points: ${probePoints}       # 探测点(热床中心)\n`;
        if(autoCal==='True') config += 'auto_calibrate: True           # 自动共振校准\n';
        config += '\n';
    }
    // ---- [probe] / [bltouch] ----
    const probeType=document.getElementById('cgProbeType')?.value||'bltouch';
    const probePreset=PROBE_PRESETS[probeType];
    const zOffset=document.getElementById('cgZOffset')?.value??(probePreset?.z_offset??0.05);
    const samples=document.getElementById('cgProbeSamples')?.value||3;
    const retractDist=document.getElementById('cgProbeRetract')?.value||1.0;
    const probeSpeed=document.getElementById('cgProbeSpeed')?.value||5.0;
    const probeSpeed2=document.getElementById('cgProbeSpeed2')?.value||2.0;
    const pxOff=document.getElementById('cgProbeXOffset')?.value||0;
    const pyOff=document.getElementById('cgProbeYOffset')?.value||0;
    const pSR=document.getElementById('cgProbeSamplesResult')?.value||'median';
    const pTol=document.getElementById('cgProbeTolerance')?.value||0.006;
    const pRet=document.getElementById('cgProbeRetries')?.value||3;
    if(probeType!=='none'&&probePreset&&m.probe) {
        config += B('调平传感器');
        if(probePreset.section==='bltouch') {
            config+='[bltouch]\n';
            config+=`sensor_pin: ${m.probe}                   # 限位开关PIN脚\n`;
            if(m.servo) config+=`control_pin: ${m.servo}                   # 舵机控制引脚\n`;
        } else {
            config+=`[probe]\npin: ${m.probe}                   # 限位开关PIN脚\n`;
        }
        config+=`x_offset: ${pxOff}                  # X轴偏移量\n`;
        config+=`y_offset: ${pyOff}                  # Y轴偏移量\n`;
        config+=`z_offset: ${zOffset}                  # Z轴偏移量\n`;
        config+=`speed: ${probeSpeed}                   # 调平速度\n`;
        config+=`samples: ${samples}                   # 采样次数\n`;
        config+=`samples_result: ${pSR}       # 取值方式\n`;
        config+=`sample_retract_dist: ${retractDist}     # 调平回缩距离\n`;
        config+=`samples_tolerance: ${pTol}     # 采样公差\n`;
        config+=`samples_tolerance_retries: ${pRet} # 超公差重试次数\n`;
        if(probeType==='voron_tap') config+='# Voron Tap: z_offset 应为 0\n';
        else if(probeType==='klicky') config+='# Klicky Probe: 请确保已加载 klicky 宏\n';
        else if(probeType==='euclid') config+='# Euclid Probe: 请确保已加载 euclid 宏\n';
        config+='\n';
    }
    // ---- 归位 ----
    if(document.getElementById('cgOptSafeZHome')?.checked) {
        const hX=document.getElementById('cgHomePosX')?.value||100;
        const hY=document.getElementById('cgHomePosY')?.value||100;
        const zHop=document.getElementById('cgZHop')?.value||5;
        const zHopSpd=document.getElementById('cgZHopSpeed')?.value||15;
        config+=B('归位');
        config+=`[safe_z_home]                # Z轴限位坐标\n`;
        config+=`home_xy_position:${hX},${hY}     # Z轴限位位置\n`;
        config+=`speed: 100                    # 归位速度\n`;
        config+=`z_hop:${zHop}                     # 归位之前抬升高度\n`;
        config+=`z_hop_speed: ${zHopSpd}               # 抬升速度\n\n`;
    }
    // ---- 可选段 ----
    if(document.getElementById('cgOptForceMove')?.checked) { config+=B('手动步进电机')+'[force_move]\nenable_force_move: True\n\n'; }
    if(document.getElementById('cgOptVerifyHeater')?.checked) {
        const vMe=document.getElementById('cgVHMaxError')?.value||120;
        const vCg=document.getElementById('cgVHCheckGain')?.value||20;
        const vHy=document.getElementById('cgVHHysteresis')?.value||5;
        const vHg=document.getElementById('cgVHHeatingGain')?.value||2.0;
        config+=B('加热校验')+'[verify_heater]\n';
        config+=`max_error: ${vMe}\ncheck_gain_time: ${vCg}\nhysteresis: ${vHy}\nheating_gain: ${vHg}\n\n`;
    }
    if(document.getElementById('cgOptGcodeArcs')?.checked) {
        config+=B('圆弧支持')+'[gcode_arcs]\n';
        config+=`resolution: ${document.getElementById('cgGAResolution')?.value||1.0}\n\n`;
    }
    if(document.getElementById('cgOptIdleTimeout')?.checked) {
        const itTimeout=document.getElementById('cgITTimeout')?.value||600;
        const itGcode=document.getElementById('cgITGcode')?.value||'TURN_OFF_HEATERS\nM84';
        config+=B('闲置关闭')+'[idle_timeout]\n';
        config+=`timeout: ${itTimeout}                # 空闲超时\n\n`;
    }
    if(document.getElementById('cgOptExcludeObj')?.checked) config+=B('排除对象')+'[exclude_object]\n\n';
    // ---- [gcode_macro _CLIENT_VARIABLE] ----
    if(document.getElementById('cgOptClientVariable')?.checked) {
        const gv=(id,d)=>{const el=document.getElementById(id);return el?el.value:d;};
        const gs=(id,d)=>{const el=document.getElementById(id);return el?el.value.trim():d;};
        config+=B('Mainsail/Fluidd 客户端变量');
        config+='[gcode_macro _CLIENT_VARIABLE]\n';
        config+=`variable_use_custom_pos   : ${gv('cgCVUseCustomPos','False')}\n`;
        config+=`variable_custom_park_x    : ${gv('cgCVParkX','0.0')}\n`;
        config+=`variable_custom_park_y    : ${gv('cgCVParkY','0.0')}\n`;
        config+=`variable_custom_park_dz   : ${gv('cgCVParkDZ','2.0')}\n`;
        config+=`variable_park_at_cancel   : ${gv('cgCVParkAtCancel','False')}\n`;
        config+=`variable_park_at_cancel_x : ${gv('cgCVCancelX','None')}\n`;
        config+=`variable_park_at_cancel_y : ${gv('cgCVCancelY','None')}\n`;
        config+=`variable_retract          : ${gv('cgCVRetract','1.0')}\n`;
        config+=`variable_cancel_retract   : ${gv('cgCVCancelRetract','5.0')}\n`;
        config+=`variable_speed_retract    : ${gv('cgCVSpeedRetract','35.0')}\n`;
        config+=`variable_unretract        : ${gv('cgCVUnretract','1.0')}\n`;
        config+=`variable_speed_unretract  : ${gv('cgCVSpeedUnretract','35.0')}\n`;
        config+=`variable_speed_hop        : ${gv('cgCVSpeedHop','15.0')}\n`;
        config+=`variable_speed_move       : ${gv('cgCVSpeedMove','100.0')}\n`;
        config+=`variable_idle_timeout     : ${gv('cgCVIdleTimeout','86400')}\n`;
        config+=`variable_use_fw_retract   : ${gv('cgCVUseFwRetract','False')}\n`;
        config+=`variable_runout_sensor    : "${gs('cgCVRunoutSensor','')}"\n`;
        config+=`variable_user_pause_macro : "${gs('cgCVUserPause','')}"\n`;
        config+=`variable_user_resume_macro: "${gs('cgCVUserResume','')}"\n`;
        config+=`variable_user_cancel_macro: "${gs('cgCVUserCancel','')}"\n`;
        config+='gcode:\n\n';
    }
    // ---- 打印宏 ----
    if(document.getElementById('cgOptPrintMacros')?.checked) {
        config+=B('自定义gcode宏');
        config+='[gcode_macro PRINT_START]          # 打印开始宏\n';
        config+='gcode:\n';
        config+='    G92 E0                         # 重置挤出\n';
        config+='    BED_MESH_CLEAR                 # 卸载网床\n';
        config+='    G28                            # 归位所有轴\n';
        config+='    G1 Z20 F3000                   # 将喷嘴移离热床\n';
        config+='    BED_MESH_PROFILE LOAD=default  # 加载网床\n';
        config+='#--------------------------------------------------------------------\n';
        config+='[gcode_macro PRINT_END]            # 打印结束宏\n';
        config+='gcode:\n';
        config+='    {% set max_x = printer.configfile.config["stepper_x"]["position_max"]|float %}\n';
        config+='    {% set max_y = printer.configfile.config["stepper_y"]["position_max"]|float %}\n';
        config+='    {% set max_z = printer.configfile.config["stepper_z"]["position_max"]|float %}\n';
        config+='    {% if printer.toolhead.position.x < (max_x - 20) %}{% set x_safe = 20.0 %}{% else %}{% set x_safe = -20.0 %}{% endif %}\n';
        config+='    {% if printer.toolhead.position.y < (max_y - 20) %}{% set y_safe = 20.0 %}{% else %}{% set y_safe = -20.0 %}{% endif %}\n';
        config+='    {% if printer.toolhead.position.z < (max_z - 2) %}{% set z_safe = 2.0 %}{% else %}{% set z_safe = max_z - printer.toolhead.position.z %}{% endif %}\n';
        config+='    M400\n';
        config+='    G92 E0\n';
        config+='    G1 E-10.0 F3600\n';
        config+='    G91\n';
        config+='    G0 Z{z_safe} F3600\n';
        config+='    G0 X{x_safe} Y{y_safe} F20000\n';
        config+='    M104 S0\n';
        config+='    M140 S0\n';
        config+='    M106 S0\n';
        config+='    G90\n';
        config+='    G0 X{max_x / 2} Y{max_y} F3600\n';
        config+='    BED_MESH_CLEAR\n\n';
    }
    // ---- 工具板配置 ----
    _toolboardData.forEach((tb,i) => {
        if(!tb.mapping||!tb.boardInfo) return;
        const tm=tb.mapping, tbi=tb.boardInfo;
        const tbName=tb.name||`TB${i}`;
        const tbSerial=document.getElementById(`cgTBSerial${i}`)?.value?.trim()||'';
        const tbConn=document.getElementById(`cgTBConn${i}`)?.value||'can';
        // [mcu TBName]
        config+=`[mcu ${tbName}]\n`;
        if(tbSerial) { if(tbConn==='can') config+=`canbus_uuid: ${tbSerial}\n`; else config+=`serial: ${tbSerial}\n`; }
        else config+='# TODO: 请填写工具板连接信息\n';
        config+='\n';
        // 工具板驱动器
        const tbDrives=[]; for(let j=0;j<10;j++){if(tm[`Drives${j}`])tbDrives.push({key:`Drives${j}`,...tm[`Drives${j}`]});else break;}
        const tbAxes=tb.axes||[];
        tbDrives.forEach((d,j)=>{
            const axis=tbAxes[j]; if(!axis||axis==='E') return;
            const rd=document.getElementById(`cgMotion_${axis}_rd`)?.value||_DM.rotation_distance;
            const ms=parseInt(document.getElementById(`cgMotion_${axis}_ms`)?.value||_DM.microsteps);
            const hs=document.getElementById(`cgMotion_${axis}_hs`)?.value||_DM.homing_speed;
            const pmin=document.getElementById(`cgMotion_${axis}_min`)?.value||_DM.position_min;
            const pmax=document.getElementById(`cgMotion_${axis}_max`)?.value||200;
            const pes=document.getElementById(`cgMotion_${axis}_es`)?.value||_DM.position_endstop;
            const posDir=document.getElementById(`cgHome_${axis}_posd`)?.checked??false;
            const spd2=document.getElementById(`cgHome_${axis}_spd2`)?.value||Math.max(5,Math.round(parseFloat(hs)/2));
            config+=`[stepper_${axis.toLowerCase()}]\n`;
            config+=`mcu: ${tbName}\n`;
            config+=`step_pin: ${d.step_pin}\ndir_pin: ${d.dir_pin}\nenable_pin: ${d.enable_pin}\n`;
            config+=`microsteps: ${ms}\nrotation_distance: ${rd}\nhoming_speed: ${hs}\n`;
            config+=`position_min: ${pmin}\nposition_max: ${pmax}\nposition_endstop: ${pes}\n`;
            config+=`homing_positive_dir: ${posDir?'true':'false'}\nsecond_homing_speed: ${spd2}\n\n`;
        });
        // 工具板挤出机
        const tbExtAxis=tbAxes.indexOf('E');
        if(tbExtAxis>=0) {
            const d=tbDrives[tbExtAxis]; if(d) {
                const rd=document.getElementById('cgExtRD')?.value||_DE.rotation_distance;
                const ms=document.getElementById('cgExtMS')?.value||_DE.microsteps;
                const fd=document.getElementById('cgExtFD')?.value||_DE.filament_diameter;
                const nd=document.getElementById('cgExtND')?.value||_DE.nozzle_diameter;
                const maxT=document.getElementById('cgExtMaxT')?.value||_DE.max_temp;
                const minT=document.getElementById('cgExtMinT')?.value||170;
                const st=document.getElementById('cgExtST')?.value||_DE.sensor_type;
                config+='[extruder]\n';
                config+=`mcu: ${tbName}\n`;
                config+=`step_pin: ${d.step_pin}\ndir_pin: ${d.dir_pin}\nenable_pin: ${d.enable_pin}\n`;
                config+=`microsteps: ${ms}\nrotation_distance: ${rd}\nfilament_diameter: ${fd}\nnozzle_diameter: ${nd}\n`;
                config+=`max_temp: ${maxT}\nmin_extrude_temp: ${minT}\n`;
                const fa=tb.funcAssigns||{};
                const thk=Object.keys(fa).find(k=>fa[k]==='extruder'&&k.startsWith('heat'));
                if(thk&&tm[thk]!=null) { const pin=Array.isArray(tm[thk])?tm[thk][0]:tm[thk]; config+=`heater_pin: ${pin}\n`; }
                const ttk=Object.keys(fa).find(k=>fa[k]==='extruder'&&k.startsWith('temp'));
                if(ttk&&tm[ttk]!=null) { const pin=Array.isArray(tm[ttk])?tm[ttk][0]:tm[ttk]; config+=`sensor_type: ${st}\nsensor_pin: ${pin}\n`; }
                config+='\n';
            }
        }
        // 工具板风扇
        const fa=tb.funcAssigns||{};
        const tfk=Object.keys(fa).find(k=>fa[k]==='part_fan');
        if(tfk&&tm[tfk]!=null) { const pin=Array.isArray(tm[tfk])?tm[tfk][0]:tm[tfk]; config+=`[fan]\nmcu: ${tbName}\npin: ${pin}\n\n`; }
        const ttfk=Object.keys(fa).find(k=>fa[k]==='throat_fan');
        if(ttfk&&tm[ttfk]!=null) { const pin=Array.isArray(tm[ttfk])?tm[ttfk][0]:tm[ttfk]; config+=`[heater_fan throat_fan]\nmcu: ${tbName}\npin: ${pin}\nheater: extruder\n\n`; }
    });
    // ---- 输出 ----
    document.getElementById('output').textContent = config;
    document.getElementById('downloadBtn').disabled = false;
    document.getElementById('copyBtn').disabled = false;
    document.getElementById('configStatus').innerHTML = '<span class="dot"></span><span>已生成</span>';
    document.getElementById('configStatus').classList.add('active');
    _cgCurrentConfig = config;
    cgShowToast('配置生成成功！');
    // 滚动到预览区域
    const previewCard = document.querySelector('.cg-tab-panel[data-tab="5"]');
    if (previewCard) {
        setTimeout(() => previewCard.scrollIntoView({behavior:'smooth',block:'start'}), 100);
    }
}
function downloadConfig() { const b=new Blob([_cgCurrentConfig],{type:'text/plain'}),u=URL.createObjectURL(b),a=document.createElement('a');a.href=u;a.download='printer.cfg';a.click();URL.revokeObjectURL(u);cgShowToast('配置已下载！'); }
function copyConfig() { navigator.clipboard.writeText(_cgCurrentConfig).then(()=>cgShowToast('已复制到剪贴板！')).catch(()=>cgShowToast('复制失败','error')); }
function resetForm() {
    switchCgTab(1);
    document.getElementById('cgBrand').innerHTML='<option value="">加载中...</option>';
    document.getElementById('cgBoard').innerHTML='<option value="">-- 选择型号 --</option>';
    document.getElementById('cgBoardInfo').textContent='';
    document.getElementById('cgConnection').innerHTML='<option value="">选择板卡后显示</option>';
    document.getElementById('cgToolCount').value='0';
    document.getElementById('cgToolboardConfig').style.display='none';
    document.getElementById('cgToolboardContainer').innerHTML='';
    document.getElementById('cgToolboardSection').innerHTML='';
    document.getElementById('cgPrinterModel').value='';
    const customSec=document.getElementById('cgCustomPrinterSection'); if(customSec) customSec.style.display='none';
    _currentMapping=null;_currentBoardInfo=null;_toolboardData=[];_cgCurrentConfig='';_currentPreset=null;_extraHeaterCount=0;
    resetConfigPanels(); populateBrands(); loadMachinePresets();
    document.getElementById('output').textContent='请完成配置后点击“生成配置”...';
    document.getElementById('downloadBtn').disabled=true;
    document.getElementById('copyBtn').disabled=true;
    document.getElementById('configStatus').innerHTML='<span class="dot"></span><span>未生成</span>';
    document.getElementById('configStatus').classList.remove('active');
    document.getElementById('errorMessage').style.display='none';
    // 重置板卡图片
    const imgC=document.getElementById('cgBoardImageContainer'); if(imgC) imgC.style.display='none';
    const serialSelect=document.getElementById('cgSerialSelect'); if(serialSelect) serialSelect.remove();
    const serialInput=document.getElementById('cgSerial'); if(serialInput){serialInput.style.display='';serialInput.value='';}
    cgShowToast('表单已重置！');
}
