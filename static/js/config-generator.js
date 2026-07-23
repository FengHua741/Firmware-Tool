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
// 调平传感器类型（Klipper 原生段落统一归到 [probe] / [bltouch]）
const PROBE_PRESETS = {
    'bltouch':{name:'BL-Touch',z_offset:2.0,needs_servo:true,section:'bltouch',desc:'需要 sensor_pin (probe引脚) + control_pin (servo引脚)'},
    'voron_tap':{name:'Voron Tap',z_offset:0,needs_servo:false,section:'probe',desc:'仅需 sensor_pin (probe引脚)，喷嘴即探针'},
    'inductive':{name:'电感/接近开关',z_offset:0,needs_servo:false,section:'probe',desc:'NPN/PNP/电感探针，生成 [probe]'},
    'microswitch':{name:'微动/Klicky',z_offset:0,needs_servo:false,section:'probe',desc:'微动或可拆卸探针，宏请单独合并'},
};
// Z限位/调平传感器三种工作模式
const PROBE_MODES = {
    'z_endstop_only':       {label:'仅Z物理限位',        desc:'Z轴用物理限位开关归位，不使用调平传感器', icon:'fa-hand-paper'},
    'z_endstop_plus_probe': {label:'Z物理限位 + 调平传感器', desc:'Z轴物理限位归位，调平传感器仅用于网床校准与调平', icon:'fa-layer-group'},
    'probe_as_z':           {label:'调平传感器替代Z限位',  desc:'使用probe:z_virtual_endstop虚拟限位，传感器同时负责归位+调平', icon:'fa-ruler-combined'},
};
let _currentProbeMode = 'z_endstop_plus_probe'; // 默认模式B
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

const TOOLBOARD_ROLE_PRESETS = {
    custom: {
        label: '自定义',
        desc: '手动分配驱动器、加热、风扇、探针和 ADXL',
        axes: [],
        functions: {}
    },
    extruder_only: {
        label: '仅挤出机',
        desc: '工具板只接管 E 电机',
        axes: ['E'],
        functions: {}
    },
    extruder_hotend: {
        label: '挤出机 + 热端',
        desc: 'E 电机、热端加热和热敏都在工具板',
        axes: ['E'],
        functions: {heat: 'extruder', temp: 'extruder'}
    },
    extruder_hotend_fans: {
        label: '挤出机 + 热端 + 风扇',
        desc: '在热端基础上接管模型风扇和喉管风扇',
        axes: ['E'],
        functions: {heat: 'extruder', temp: 'extruder', fan0: 'part_fan', fan1: 'throat_fan'}
    },
    extruder_hotend_probe: {
        label: '挤出机 + 热端 + 风扇 + 探针',
        desc: '工具头常用完整组合，探针默认使用第一个限位/Probe 口',
        axes: ['E'],
        functions: {heat: 'extruder', temp: 'extruder', fan0: 'part_fan', fan1: 'throat_fan', probe: true}
    },
    adxl: {
        label: 'ADXL 加速度计',
        desc: '工具板只接管工具头加速度计/共振测试',
        axes: [],
        functions: {adxl: true}
    }
};

const TOOLBOARD_FUNCTION_LABELS = {
    extruder_drive: '挤出机电机',
    extruder_heater: '热端加热',
    extruder_sensor: '热端热敏',
    part_fan: '模型风扇',
    throat_fan: '喉管风扇',
    driver_fan: '驱动/控制器风扇',
    controller_fan: '电器仓风扇',
    exhaust_fan: '排风扇',
    filament_sensor: '断料/堵料传感器',
    probe: '探针',
    adxl: 'ADXL/共振测试',
    toolhead_endstop_x: '工具头 X 限位',
    toolhead_endstop_y: '工具头 Y 限位',
    toolhead_endstop_z: '工具头 Z 限位',
};

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
let _currentProbeSource = 'main';
let _cgImportedConfig = '';
let _cgImportedToolboards = [];
let _currentBoardLayout = null;
let _cgSelectedBoardPin = '';
let _cgBoardImageUrl = '';
let _cgBoardLoadSeq = 0;

function cgShowToast(msg, type='success') {
    let t = document.getElementById('toastGen');
    if (!t) { t = document.createElement('div'); t.id = 'toastGen'; t.className = 'toast-gen'; document.body.appendChild(t); }
    t.textContent = '';
    const icon = document.createElement('i');
    icon.className = `fas ${type==='success'?'fa-check-circle':type==='error'?'fa-exclamation-circle':'fa-exclamation-triangle'}`;
    t.appendChild(icon);
    t.appendChild(document.createTextNode(` ${msg}`));
    t.className = `toast-gen ${type}`; t.classList.add('show');
    setTimeout(() => t.classList.remove('show'), 3000);
}

function cgRawPin(pin) {
    if (pin == null) return '';
    return String(Array.isArray(pin) ? pin[0] : pin).trim();
}

function cgDisplayPin(pin) {
    if (pin == null) return '';
    if (Array.isArray(pin)) return String(pin[0] || '').trim();
    if (typeof pin === 'object') return String(pin.cs_pin || pin.pin || pin.gpio || '').trim();
    return String(pin).trim();
}

function cgPrefixPin(pin, mcuName) {
    const raw = cgRawPin(pin);
    if (!raw || !mcuName) return raw;
    const m = raw.match(/^([!^~]+)(.+)$/);
    const mods = m ? Array.from(new Set(m[1].split(''))).join('') : '';
    const body = m ? m[2] : raw;
    if (body.includes(':')) return `${mods}${body}`;
    return `${mods}${mcuName}:${body}`;
}

function cgSafeConfigName(name, fallback='item') {
    const safe = String(name || fallback).trim().replace(/[^\w.-]+/g, '_');
    return safe || fallback;
}

function cgEscapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, ch => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    }[ch]));
}

function cgToolIfaceName(key) {
    const raw = String(key || '');
    let m = raw.match(/^Drives(\d+)$/i);
    if (m) return `MOT${m[1]}`;
    m = raw.match(/^heat(\d+)$/i);
    if (m) return `HE${m[1]}`;
    m = raw.match(/^temp(\d+)$/i);
    if (m) return `TH${m[1]}`;
    m = raw.match(/^fan(\d+)$/i);
    if (m) return `FAN${m[1]}`;
    m = raw.match(/^stop(\d+)$/i);
    if (m) return `STOP${m[1]}`;
    if (/bed/i.test(raw) && /heat|out/i.test(raw)) return 'BED_HE';
    if (/bed/i.test(raw) && /temp/i.test(raw)) return 'BED_TH';
    if (/probe/i.test(raw)) return 'PROBE';
    if (/servo/i.test(raw)) return 'SERVO';
    if (/lis2dw|adxl/i.test(raw)) return 'ADXL_CS';
    if (/31865/i.test(raw)) return 'MAX31865_CS';
    return raw.toUpperCase();
}

function cgToolPinLabel(key, pin) {
    const raw = cgDisplayPin(pin);
    return `${cgToolIfaceName(key)} <small class="cg-pin-sub">${cgEscapeHtml(key)}${raw ? ` / ${cgEscapeHtml(raw)}` : ''}</small>`;
}

function cgToolPinText(key, pin, owner='') {
    const raw = cgDisplayPin(pin);
    const prefix = owner ? `${owner} / ` : '';
    return `${prefix}${cgToolIfaceName(key)}${raw ? ` (${raw})` : ''}`;
}

function cgToolboardRoleOptions(current='custom') {
    return Object.entries(TOOLBOARD_ROLE_PRESETS).map(([value, preset]) =>
        `<option value="${value}"${value === current ? ' selected' : ''}>${preset.label}</option>`
    ).join('');
}

function cgPinRefMain(key) {
    return `main:${key}`;
}

function cgPinRefTool(index, key) {
    return `tb:${index}:${key}`;
}

function cgParsePinRef(value) {
    const raw = String(value || '');
    if (!raw) return null;
    const parts = raw.split(':');
    if (parts[0] === 'tb' && parts.length >= 3) {
        return {source: 'toolboard', index: parseInt(parts[1], 10), key: parts.slice(2).join(':')};
    }
    if (parts[0] === 'main' && parts.length >= 2) {
        return {source: 'main', key: parts.slice(1).join(':')};
    }
    return {source: 'main', key: raw};
}

function cgResolvePinRef(value) {
    const ref = cgParsePinRef(value);
    if (!ref) return null;
    if (ref.source === 'toolboard') {
        const tb = _toolboardData[ref.index];
        if (!tb?.mapping || tb.mapping[ref.key] == null) return null;
        const mcuName = cgSafeConfigName(tb.name || `TB${ref.index}`, `TB${ref.index}`);
        return {
            source: 'toolboard',
            index: ref.index,
            key: ref.key,
            mcuName,
            rawPin: cgRawPin(tb.mapping[ref.key]),
            pin: cgPrefixPin(tb.mapping[ref.key], mcuName),
            label: `工具板 ${ref.index + 1}: ${mcuName}`
        };
    }
    if (!_currentMapping || _currentMapping[ref.key] == null) return null;
    return {
        source: 'main',
        key: ref.key,
        mcuName: '',
        rawPin: cgRawPin(_currentMapping[ref.key]),
        pin: cgRawPin(_currentMapping[ref.key]),
        label: '主板'
    };
}

function cgMappingKeysForType(mapping, type) {
    const keys = [];
    if (!mapping) return keys;
    const pushSeq = (prefix, max=20) => {
        for (let i = 0; i < max; i++) {
            const key = `${prefix}${i}`;
            if (mapping[key] != null) keys.push(key);
        }
    };
    if (type === 'heat') {
        pushSeq('heat', 10);
        ['BED_OUT','bed-heat'].forEach(key => { if (mapping[key] != null) keys.push(key); });
    } else if (type === 'temp') {
        pushSeq('temp', 10);
        ['temp_bed','bed-temp'].forEach(key => { if (mapping[key] != null) keys.push(key); });
    } else if (type === 'fan') {
        pushSeq('fan', 20);
    } else if (type === 'stop') {
        pushSeq('stop', 20);
    } else if (type === 'probe') {
        if (mapping.probe != null) keys.push('probe');
        pushSeq('stop', 20);
    } else if (type === 'servo') {
        if (mapping.servo != null) keys.push('servo');
    } else if (type === 'adxl') {
        ['adxl','adxl345','adxl_cs','lis2dw'].forEach(key => { if (mapping[key] != null) keys.push(key); });
    }
    return [...new Set(keys)];
}

function cgCollectPinOptions(type) {
    const options = [];
    cgMappingKeysForType(_currentMapping, type).forEach(key => {
        options.push({value: cgPinRefMain(key), source: 'main', key, label: cgToolPinText(key, _currentMapping[key], '主板')});
    });
    _toolboardData.forEach((tb, index) => {
        if (!tb?.mapping) return;
        const name = cgSafeConfigName(tb.name || `TB${index}`, `TB${index}`);
        cgMappingKeysForType(tb.mapping, type).forEach(key => {
            options.push({value: cgPinRefTool(index, key), source: 'toolboard', index, key, label: cgToolPinText(key, tb.mapping[key], name)});
        });
    });
    return options;
}

function cgPinOptionsHtml(type, selected='', includeEmpty=true) {
    const opts = [];
    if (includeEmpty) opts.push('<option value="">不使用</option>');
    cgCollectPinOptions(type).forEach(opt => {
        opts.push(`<option value="${cgEscapeHtml(opt.value)}"${opt.value === selected ? ' selected' : ''}>${cgEscapeHtml(opt.label)}</option>`);
    });
    return opts.join('');
}

function cgBoardLayoutType(group, key) {
    const g = String(group || '').toLowerCase();
    const k = String(key || '').toLowerCase();
    if (g === 'drives' || /^drives\d+/.test(k)) return 'drive';
    if (g === 'heat' || /^heat\d+/.test(k) || /bed_out|bed-heat/.test(k)) return 'heat';
    if (g === 'temp' || /^temp/.test(k) || /bed-temp/.test(k)) return 'temp';
    if (g === 'fan' || /^fan\d+/.test(k)) return 'fan';
    if (g === 'endstop' || /^stop\d+/.test(k)) return 'stop';
    if (k.includes('servo')) return 'servo';
    if (g === 'bltouch' || k.includes('probe')) return 'probe';
    if (g === 'rgb') return 'rgb';
    return g || 'other';
}

function cgBoardTypeLabel(type) {
    return {
        drive: '驱动口',
        heat: '加热口',
        temp: '热敏口',
        fan: '风扇口',
        stop: '限位口',
        probe: '探针口',
        servo: '舵机口',
        rgb: 'RGB口',
        other: '接口'
    }[type] || type;
}

function cgBoardLayoutItems() {
    if (!_currentBoardLayout) return [];
    const items = [];
    Object.entries(_currentBoardLayout).forEach(([group, entries]) => {
        if (group === 'img' || !Array.isArray(entries)) return;
        entries.forEach(entry => {
            if (!entry?.name) return;
            const left = Number(entry.left);
            const top = Number(entry.top);
            const width = Number(entry.Width ?? entry.width);
            const height = Number(entry.Height ?? entry.height);
            if (![left, top, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return;
            const key = String(entry.name);
            items.push({
                key,
                group,
                type: cgBoardLayoutType(group, key),
                label: cgToolIfaceName(key),
                left,
                top,
                width,
                height
            });
        });
    });
    return items;
}

function cgBoardLayoutBaseSize(imgEl) {
    const info = _currentBoardLayout?.img || {};
    const zoom = Number(info.Zoom || info.zoom || 1) || 1;
    const rawOffsetX = Number(info.OffsetX ?? info.offsetX ?? 0);
    const rawOffsetY = Number(info.OffsetY ?? info.offsetY ?? 0);
    const offsetX = Number.isFinite(rawOffsetX) ? rawOffsetX : 0;
    const offsetY = Number.isFinite(rawOffsetY) ? rawOffsetY : 0;
    const naturalWidth = Number(info.Width || info.width || imgEl?.naturalWidth || 1) || 1;
    const naturalHeight = Number(info.Height || info.height || imgEl?.naturalHeight || 1) || 1;
    const explicitCoordWidth = Number(info.CoordWidth ?? info.coordWidth ?? info.DisplayWidth ?? info.displayWidth);
    const explicitCoordHeight = Number(info.CoordHeight ?? info.coordHeight ?? info.DisplayHeight ?? info.displayHeight);
    if (explicitCoordWidth > 0 && explicitCoordHeight > 0) {
        return {
            width: explicitCoordWidth * zoom,
            height: explicitCoordHeight * zoom,
            zoom,
            offsetX,
            offsetY
        };
    }
    const items = cgBoardLayoutItems();
    const minX = items.length ? Math.min(...items.map(item => item.left)) : 0;
    const minY = items.length ? Math.min(...items.map(item => item.top)) : 0;
    const maxX = Math.max(...items.map(item => item.left + item.width), 0);
    const maxY = Math.max(...items.map(item => item.top + item.height), 0);
    if (maxX > 0 && maxY > 0) {
        const spanX = Math.max(maxX - minX, 1);
        const spanY = Math.max(maxY - minY, 1);
        const rawPaddingRatio = Number(info.PaddingRatio ?? info.paddingRatio ?? 0.02);
        const paddingRatio = Number.isFinite(rawPaddingRatio) && rawPaddingRatio >= 0 ? rawPaddingRatio : 0.02;
        let width = maxX + Math.max(8, spanX * paddingRatio);
        let height = maxY + Math.max(6, spanY * paddingRatio);
        const aspect = naturalWidth / naturalHeight;
        if (Number.isFinite(aspect) && aspect > 0) {
            if (width / height > aspect) {
                height = width / aspect;
            } else {
                width = height * aspect;
            }
        }
        return {
            width: width * zoom,
            height: height * zoom,
            zoom,
            offsetX,
            offsetY
        };
    }
    return {
        width: naturalWidth * zoom || 1,
        height: naturalHeight * zoom || 1,
        zoom,
        offsetX,
        offsetY
    };
}

function cgMainKeyRawPins(key) {
    const value = _currentMapping?.[key];
    const pins = [];
    if (value == null) return pins;
    if (typeof value === 'object' && !Array.isArray(value)) {
        ['step_pin','dir_pin','enable_pin','uart_pin','diag_pin','cs_pin','pin','gpio'].forEach(field => {
            if (value[field] != null) pins.push(cgRawPin(value[field]));
        });
        if (Array.isArray(value.spi_bus)) value.spi_bus.forEach(pin => pins.push(cgRawPin(pin)));
    } else {
        pins.push(cgRawPin(value));
    }
    return pins.filter(Boolean);
}

function cgMainKeyMatchesRawPin(key, rawPin) {
    const raw = cgRawPin(rawPin);
    return !!raw && cgMainKeyRawPins(key).includes(raw);
}

function cgMainKeyPinSummary(key) {
    const value = _currentMapping?.[key];
    if (value == null) return '<span>mapping 未定义</span>';
    if (typeof value === 'object' && !Array.isArray(value)) {
        const fields = ['step_pin','dir_pin','enable_pin','uart_pin','diag_pin','cs_pin','pin','gpio']
            .filter(field => value[field] != null)
            .map(field => `<code>${cgEscapeHtml(field)}=${cgEscapeHtml(cgRawPin(value[field]))}</code>`);
        if (value.spi_bus) {
            fields.push(`<code>spi_bus=${cgEscapeHtml(Array.isArray(value.spi_bus) ? value.spi_bus.join('/') : value.spi_bus)}</code>`);
        }
        return fields.join(' ') || '<span>无 pin 信息</span>';
    }
    return `<code>${cgEscapeHtml(cgRawPin(value))}</code>`;
}

function cgMainKeyUsages(key) {
    const usages = [];
    const add = label => { if (label && !usages.includes(label)) usages.push(label); };
    const driveMatch = String(key).match(/^Drives(\d+)$/i);
    if (driveMatch) {
        const axis = document.getElementById(`cgAxis_${driveMatch[1]}`)?.value || '';
        if (axis) add(`${axis} 电机`);
    }

    [
        ['cgHeatPin_extruder', '挤出机加热'],
        ['cgTempPin_extruder', '挤出机热敏'],
        ['cgHeatPin_heater_bed', '热床加热'],
        ['cgTempPin_heater_bed', '热床热敏'],
        ['cgFanPin_part_fan', '模型风扇'],
        ['cgFanPin_throat_fan', '喉管风扇'],
        ['cgFanPin_driver_fan', '驱动/控制器风扇'],
        ['cgFanPin_controller_fan', '电器仓风扇'],
        ['cgFanPin_exhaust_fan', '排风扇'],
        ['cgFilamentSensorPin', '断料/堵料检测'],
    ].forEach(([id, label]) => {
        const ref = cgParsePinRef(document.getElementById(id)?.value || '');
        if (ref?.source === 'main' && ref.key === key) add(label);
    });

    for (let i = 1; i <= _extraHeaterCount; i++) {
        const name = document.getElementById(`cgExtraName_${i}`)?.value || `extra_heater_${i}`;
        const heatRef = cgParsePinRef(document.getElementById(`cgExtraHeatPin_${i}`)?.value || '');
        const tempRef = cgParsePinRef(document.getElementById(`cgExtraTempPin_${i}`)?.value || '');
        if (heatRef?.source === 'main' && heatRef.key === key && document.getElementById(`cgExtraSection_${i}`)?.value !== 'temperature_sensor') add(`${name} 加热`);
        if (tempRef?.source === 'main' && tempRef.key === key) add(`${name} 热敏`);
    }

    ['X','Y','Z'].forEach(axis => {
        const ref = cgParsePinRef(document.getElementById(`cgEndstopPin_${axis}`)?.value || '');
        if (ref?.source === 'main' && ref.key === key && !(axis === 'Z' && _currentProbeMode === 'probe_as_z') && !document.getElementById(`cgEndstopDiag_${axis}`)?.checked) {
            add(`${axis} 轴物理限位`);
        }
        if (document.getElementById(`cgEndstopDiag_${axis}`)?.checked) {
            const axisSel = Array.from(document.querySelectorAll('[id^="cgAxis_"]')).find(sel => sel.value === axis);
            const idx = axisSel ? parseInt(axisSel.id.replace('cgAxis_', ''), 10) : -1;
            const diagPin = idx >= 0 ? _currentMapping?.[`Drives${idx}`]?.diag_pin : '';
            if (cgMainKeyMatchesRawPin(key, diagPin)) add(`${axis} 轴 DIAG 限位`);
        }
    });

    const probeState = getProbePinState();
    if (_currentProbeMode !== 'z_endstop_only' && probeState.source?.value === 'main') {
        if (cgMainKeyMatchesRawPin(key, probeState.sensorPin)) add('探针 sensor_pin');
        if (cgMainKeyMatchesRawPin(key, probeState.controlPin)) add('探针 control_pin');
    }

    return usages;
}

function cgBoardActionCall(fn, args) {
    return `${fn}(${args.map(arg => JSON.stringify(arg)).join(',')})`;
}

function cgBoardActionButtons(item) {
    const key = item.key;
    const buttons = [];
    const add = (label, fn, args) => buttons.push(`<button type="button" onclick='${cgBoardActionCall(fn, args)}'>${cgEscapeHtml(label)}</button>`);
    if (item.type === 'drive') {
        ['X','Y','Z','E'].forEach(axis => add(`分配 ${axis}`, 'cgAssignBoardDrive', [key, axis]));
        add('不使用', 'cgAssignBoardDrive', [key, '']);
    } else if (item.type === 'heat') {
        add('挤出机加热', 'cgAssignBoardPinSelect', ['cgHeatPin_extruder', key, 5, '挤出机加热']);
        add('热床加热', 'cgAssignBoardPinSelect', ['cgHeatPin_heater_bed', key, 5, '热床加热']);
    } else if (item.type === 'temp') {
        add('挤出机热敏', 'cgAssignBoardPinSelect', ['cgTempPin_extruder', key, 5, '挤出机热敏']);
        add('热床热敏', 'cgAssignBoardPinSelect', ['cgTempPin_heater_bed', key, 5, '热床热敏']);
    } else if (item.type === 'fan') {
        add('模型风扇', 'cgAssignBoardPinSelect', ['cgFanPin_part_fan', key, 5, '模型风扇']);
        add('喉管风扇', 'cgAssignBoardPinSelect', ['cgFanPin_throat_fan', key, 5, '喉管风扇']);
        add('驱动风扇', 'cgAssignBoardPinSelect', ['cgFanPin_driver_fan', key, 5, '驱动/控制器风扇']);
        add('电器仓风扇', 'cgAssignBoardPinSelect', ['cgFanPin_controller_fan', key, 5, '电器仓风扇']);
    } else if (item.type === 'stop') {
        ['X','Y','Z'].forEach(axis => add(`${axis}限位`, 'cgAssignBoardPinSelect', [`cgEndstopPin_${axis}`, key, 3, `${axis}轴限位`]));
        add('断料/堵料', 'cgAssignBoardPinSelect', ['cgFilamentSensorPin', key, 5, '断料/堵料检测']);
        add('探针信号', 'cgAssignBoardProbePin', [key, 'sensor']);
    } else if (item.type === 'probe') {
        add('断料/堵料', 'cgAssignBoardPinSelect', ['cgFilamentSensorPin', key, 5, '断料/堵料检测']);
        add('探针信号', 'cgAssignBoardProbePin', [key, 'sensor']);
    } else if (item.type === 'servo') {
        add('BLTouch控制', 'cgAssignBoardProbePin', [key, 'control']);
    }
    return buttons.length ? `<div class="cg-board-pin-actions">${buttons.join('')}</div>` : '';
}

function cgBoardPinInfoHtml(item) {
    const usages = cgMainKeyUsages(item.key);
    const usageText = usages.length ? usages.map(cgEscapeHtml).join('、') : '未分配';
    return `<strong>${cgEscapeHtml(item.label)}</strong> <span>${cgEscapeHtml(cgBoardTypeLabel(item.type))}</span>
        <div class="cg-board-pin-meta">
            <span>接口: <code>${cgEscapeHtml(item.key)}</code></span>
            <span>位置: <code>x=${item.left}, y=${item.top}, ${item.width}x${item.height}</code></span>
        </div>
        <div>真实 pin: ${cgMainKeyPinSummary(item.key)}</div>
        <div>当前用途: ${usageText}</div>
        ${cgBoardActionButtons(item)}`;
}

function cgBoardMapRoots() {
    return Array.from(document.querySelectorAll('.cg-board-map'));
}

function cgEnsureBoardMap(root) {
    if (!root) return null;
    if (!root.querySelector('.cg-board-image-stage')) {
        root.innerHTML = `<div class="cg-board-image-stage">
            <img class="cg-board-image" alt="板卡接口位置">
            <div class="cg-board-overlay" aria-label="板卡接口热区"></div>
        </div>
        <div class="cg-board-pin-info"><i class="fas fa-info-circle"></i> 点击图片上的接口查看物理位置、真实 pin 和可用分配。</div>`;
    }
    return {
        img: root.querySelector('.cg-board-image'),
        overlay: root.querySelector('.cg-board-overlay'),
        panel: root.querySelector('.cg-board-pin-info'),
    };
}

function cgBoardMapAllowedTypes(root) {
    const raw = root?.dataset?.mapTypes || 'all';
    const types = raw.split(',').map(s => s.trim()).filter(Boolean);
    if (!types.length || types.includes('all')) return null;
    return new Set(types);
}

function cgBoardMapItems(root) {
    const allowed = cgBoardMapAllowedTypes(root);
    return cgBoardLayoutItems().filter(item => !allowed || allowed.has(item.type));
}

function cgBoardMapDefaultHtml(root, hasItems=true) {
    if (!_currentMapping) return '<i class="fas fa-info-circle"></i> 请先选择主板。';
    if (!_currentBoardLayout) return '<i class="fas fa-info-circle"></i> 当前板卡没有接口坐标数据。';
    if (!hasItems) return `<i class="fas fa-info-circle"></i> ${cgEscapeHtml(root?.dataset?.mapEmpty || '当前选项卡没有匹配的接口坐标数据。')}`;
    return '<i class="fas fa-info-circle"></i> 点击图片上的接口查看物理位置、真实 pin 和可用分配。';
}

function cgBoardImageUrl(boardId) {
    if (!boardId) return '';
    const path = `/api/tools/boards/${encodeURIComponent(boardId)}/image?board=${encodeURIComponent(boardId)}&v=${Date.now()}`;
    return new URL(path, window.location.href).href;
}

function cgClearBoardImages(message='正在加载板卡图片...') {
    _cgBoardImageUrl = '';
    const imgContainer = document.getElementById('cgBoardImageContainer');
    const previewImg = document.getElementById('cgBoardImage');
    if (previewImg) {
        previewImg.onload = null;
        previewImg.onerror = null;
        previewImg.removeAttribute('src');
    }
    if (imgContainer) imgContainer.style.display = 'none';
    document.querySelectorAll('.cg-board-map').forEach(root => {
        root.classList.add('empty');
        const parts = cgEnsureBoardMap(root);
        if (parts?.img) {
            parts.img.onload = null;
            parts.img.onerror = null;
            parts.img.removeAttribute('src');
        }
        if (parts?.overlay) parts.overlay.innerHTML = '';
        if (parts?.panel) parts.panel.innerHTML = `<i class="fas fa-info-circle"></i> ${cgEscapeHtml(message)}`;
    });
}

function cgRefreshBoardHotspotUsage() {
    document.querySelectorAll('.cg-board-hotspot').forEach(btn => {
        const key = btn.dataset.key || '';
        btn.classList.toggle('used', cgMainKeyUsages(key).length > 0);
        btn.classList.toggle('active', key === _cgSelectedBoardPin);
    });
    cgBoardMapRoots().forEach(root => {
        const parts = cgEnsureBoardMap(root);
        if (!parts?.panel) return;
        const items = cgBoardMapItems(root);
        const item = _cgSelectedBoardPin ? items.find(x => x.key === _cgSelectedBoardPin) : null;
        parts.panel.innerHTML = item ? cgBoardPinInfoHtml(item) : cgBoardMapDefaultHtml(root, items.length > 0);
    });
}

function cgRenderBoardMapRoot(root) {
    const parts = cgEnsureBoardMap(root);
    if (!parts?.img || !parts?.overlay || !parts?.panel) return;
    parts.overlay.innerHTML = '';
    const items = cgBoardMapItems(root);
    if (!_currentBoardLayout || !_currentMapping || !items.length) {
        root.classList.add('empty');
        parts.panel.innerHTML = cgBoardMapDefaultHtml(root, items.length > 0);
        return;
    }
    root.classList.remove('empty');
    const imageUrl = _cgBoardImageUrl || document.getElementById('cgBoardImage')?.src || '';
    if (imageUrl && parts.img.src !== imageUrl) parts.img.src = imageUrl;
    if (!parts.img.complete || !parts.img.naturalWidth) {
        parts.img.onload = () => renderBoardLayoutOverlay();
        return;
    }
    const base = cgBoardLayoutBaseSize(parts.img);
    items.forEach(item => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `cg-board-hotspot type-${item.type}`;
        btn.dataset.key = item.key;
        btn.dataset.label = item.label;
        btn.style.left = `${(((item.left + base.offsetX) * base.zoom) / base.width) * 100}%`;
        btn.style.top = `${(((item.top + base.offsetY) * base.zoom) / base.height) * 100}%`;
        btn.style.width = `${((item.width * base.zoom) / base.width) * 100}%`;
        btn.style.height = `${((item.height * base.zoom) / base.height) * 100}%`;
        btn.title = `${item.label} / ${item.key}`;
        btn.setAttribute('aria-label', `${item.label} / ${item.key}`);
        btn.onclick = () => cgSelectBoardHotspot(item.key);
        parts.overlay.appendChild(btn);
    });
}

function renderBoardLayoutOverlay() {
    cgBoardMapRoots().forEach(root => cgRenderBoardMapRoot(root));
    if (_cgSelectedBoardPin && !cgBoardLayoutItems().some(item => item.key === _cgSelectedBoardPin)) {
        _cgSelectedBoardPin = '';
    }
    cgRefreshBoardHotspotUsage();
}

function cgSelectBoardHotspot(key) {
    const item = cgBoardLayoutItems().find(x => x.key === key);
    if (!item) return;
    _cgSelectedBoardPin = key;
    cgRefreshBoardHotspotUsage();
}

function cgFocusConfigElement(id, tab) {
    if (tab) switchCgTab(tab);
    setTimeout(() => {
        const el = document.getElementById(id);
        if (!el) return;
        el.scrollIntoView({block: 'center', behavior: 'smooth'});
        el.focus();
    }, 80);
}

function cgAssignBoardDrive(key, axis) {
    const m = String(key || '').match(/^Drives(\d+)$/i);
    if (!m) return;
    if (axis && cgIsAxisOnToolboard(axis)) {
        cgShowToast(`${axis} 已分配给工具板，不能再分配到主板驱动`, 'error');
        return;
    }
    const el = document.getElementById(`cgAxis_${m[1]}`);
    if (!el) return;
    if (axis) {
        document.querySelectorAll('[id^="cgAxis_"]').forEach(sel => {
            if (sel !== el && sel.value === axis) sel.value = '';
        });
    }
    el.value = axis;
    validateAxisAssignment();
    renderBoardLayoutOverlay();
    cgSelectBoardHotspot(key);
    cgFocusConfigElement(el.id, 2);
    cgShowToast(axis ? `${key} 已分配给 ${axis}` : `${key} 已设置为不使用`);
}

function cgAssignBoardPinSelect(selectId, key, tab, label='接口') {
    const el = document.getElementById(selectId);
    if (!el) {
        cgShowToast('目标配置项不存在，请先选择主板并完成页面渲染', 'error');
        return;
    }
    const value = cgPinRefMain(key);
    if (!Array.from(el.options).some(opt => opt.value === value)) {
        cgShowToast(`${key} 不能用于 ${label}`, 'error');
        return;
    }
    el.value = value;
    renderToolboardConflictPanel();
    renderBoardLayoutOverlay();
    cgSelectBoardHotspot(key);
    cgFocusConfigElement(selectId, tab);
    cgShowToast(`${key} 已分配到 ${label}`);
}

function cgAssignBoardProbePin(key, field) {
    const rawPin = cgRawPin(_currentMapping?.[key]);
    if (!rawPin) {
        cgShowToast(`${key} 没有可用 pin`, 'error');
        return;
    }
    _currentProbeSource = 'main';
    switchCgTab(3);
    renderProbeConfig();
    const id = field === 'control' ? 'cgProbeControlPin' : 'cgProbeSensorPin';
    const el = document.getElementById(id);
    if (!el || !Array.from(el.options).some(opt => opt.value === rawPin)) {
        cgShowToast(`${key} 不能作为${field === 'control' ? '探针控制' : '探针信号'}引脚`, 'error');
        return;
    }
    el.value = rawPin;
    renderProbeCheckPanel();
    renderToolboardConflictPanel();
    renderBoardLayoutOverlay();
    cgSelectBoardHotspot(key);
    cgFocusConfigElement(id, 3);
    cgShowToast(`${key} 已分配到${field === 'control' ? '探针 control_pin' : '探针 sensor_pin'}`);
}

function cgSetSelectIfOption(id, value) {
    const el = document.getElementById(id);
    if (!el || !value) return false;
    if (!Array.from(el.options).some(opt => opt.value === value)) return false;
    el.value = value;
    return true;
}

function cgIsAxisOnToolboard(axis) {
    return _toolboardData.some(tb => (tb?.axes || []).includes(axis));
}

function cgClearMainAxisIfToolboardOwns(axis) {
    if (!axis) return;
    document.querySelectorAll('[id^="cgAxis_"]').forEach(sel => {
        if (sel.value === axis) sel.value = '';
    });
}

function cgApplyToolboardExtruderDefaults(index) {
    const tb = _toolboardData[index];
    if (!tb?.mapping) return false;
    let changed = false;
    const driveKeys = cgToolboardDriveKeys(tb.mapping);
    if (driveKeys.length && !_toolboardData.some((other, otherIndex) => otherIndex !== index && (other?.axes || []).includes('E'))) {
        tb.axes = new Array(driveKeys.length).fill('');
        tb.axes[0] = 'E';
        changed = true;
    }
    return changed;
}

function cgApplyToolboardExtruderPinDefaults(index) {
    const tb = _toolboardData[index];
    if (!tb?.mapping) return;
    const heatKey = cgFirstToolKey(tb.mapping, 'heat');
    const tempKey = cgFirstToolKey(tb.mapping, 'temp');
    if (heatKey) cgSetSelectIfOption('cgHeatPin_extruder', cgPinRefTool(index, heatKey));
    if (tempKey) cgSetSelectIfOption('cgTempPin_extruder', cgPinRefTool(index, tempKey));
    renderToolboardConflictPanel();
}

function cgTmcEnableInvert(model) {
    return ['tmc2208','tmc2209','tmc5160','tmc2240','tmc2130','tmc2660','a4988','yanggong'].includes(model) ? '!' : '';
}

function onTBTmcModelChg(tbIndex, driveIndex) {
    const model = document.getElementById(`cgTBTmcModel_${tbIndex}_${driveIndex}`)?.value;
    const curEl = document.getElementById(`cgTBTmcCurrent_${tbIndex}_${driveIndex}`);
    const srEl = document.getElementById(`cgTBTmcSR_${tbIndex}_${driveIndex}`);
    const srLabel = document.getElementById(`cgTBTmcSRLabel_${tbIndex}_${driveIndex}`);
    if (model === 'tmc5160' && curEl) curEl.value = '1.0';
    else if (model === 'tmc2209' && curEl) curEl.value = '0.8';
    else if (model === 'tmc2240' && curEl) curEl.value = '1.0';
    else if (model === 'tmc2130' && curEl) curEl.value = '1.0';
    else if (model === 'tmc2208' && curEl) curEl.value = '0.8';
    else if (model === 'tmc2660' && curEl) curEl.value = '1.2';
    else if (model === 'a4988' && curEl) curEl.value = '1.0';
    if (srLabel) {
        if (model === 'tmc2240') { srLabel.textContent = 'rref'; if (srEl && !srEl.dataset.userEdited) srEl.value = '12300'; }
        else if (['tmc5160','tmc2209','tmc2130'].includes(model)) { srLabel.textContent = 'sense_resistor'; if (srEl && !srEl.dataset.userEdited) srEl.value = model === 'tmc5160' ? '0.075' : '0.110'; }
        else { srLabel.textContent = '(不使用)'; if (srEl && !srEl.dataset.userEdited) srEl.value = ''; }
    }
    if (srEl) srEl.addEventListener('input', () => srEl.dataset.userEdited = '1', {once:true});
    renderToolboardConflictPanel();
}

function cgFormatGcodeBlock(value) {
    return String(value || '')
        .split(/\s*;\s*|\r?\n/)
        .map(line => line.trim())
        .filter(Boolean)
        .map(line => `    ${line}`)
        .join('\n');
}

function cgNormalizePinClaim(pin, defaultMcu='') {
    let raw = cgRawPin(pin);
    if (!raw) return null;
    raw = raw.replace(/^[!^~]+/, '').trim();
    if (!raw || /virtual_endstop/i.test(raw)) return null;
    let mcuName = defaultMcu || 'mcu';
    let pinName = raw;
    const colon = raw.indexOf(':');
    if (colon > 0) {
        mcuName = raw.slice(0, colon).trim() || mcuName;
        pinName = raw.slice(colon + 1).trim();
    }
    if (!pinName || /virtual_endstop/i.test(pinName)) return null;
    const mcuKey = String(mcuName || 'mcu').toLowerCase();
    const pinKey = String(pinName).toUpperCase();
    return {key: `${mcuKey}:${pinKey}`, label: `${mcuName || 'mcu'}:${pinName}`};
}

function cgAddPinClaim(claims, pin, mcuName, label, meta={}) {
    const norm = cgNormalizePinClaim(pin, mcuName);
    if (!norm) return;
    claims.pinUsages[norm.key] = claims.pinUsages[norm.key] || {pin: norm.label, usages: []};
    const usage = {
        label,
        source: meta.source || '',
        type: meta.type || '',
        index: meta.index,
        key: meta.key || ''
    };
    const usageKey = `${usage.label}|${usage.source}|${usage.type}|${usage.index ?? ''}|${usage.key}`;
    if (claims.pinUsages[norm.key].usages.some(item => item.usageKey === usageKey)) return;
    claims.pinUsages[norm.key].usages.push({...usage, usageKey});
}

function cgAddPinClaimFromRef(claims, value, label, meta={}) {
    const ref = cgResolvePinRef(value);
    if (!ref) return;
    cgAddPinClaim(claims, ref.rawPin, ref.mcuName, label, {...meta, source: ref.source, index: ref.index, key: ref.key});
}

function cgPinConflictMessages(claims) {
    return Object.values(claims.pinUsages)
        .filter(item => item.usages.length > 1)
        .map(item => {
            const names = item.usages.map(usage => usage.label).join('、');
            return `引脚冲突 ${item.pin}: ${names}`;
        });
}

function cgParseNumber(value, fallback=0) {
    const n = parseFloat(value);
    return Number.isFinite(n) ? n : fallback;
}

function cgParsePoint(value) {
    const parts = String(value || '').split(',').map(v => parseFloat(v.trim()));
    if (parts.length < 2 || !Number.isFinite(parts[0]) || !Number.isFinite(parts[1])) return null;
    return {x: parts[0], y: parts[1]};
}

function cgParsePointList(values) {
    return values.map(value => cgParsePoint(value)).filter(Boolean);
}

function cgPinArray(value) {
    if (value == null) return [];
    return Array.isArray(value) ? value.filter(v => v != null) : [value];
}

function cgComposePin(pin, mcuName='', opts={}) {
    const raw = cgRawPin(pin);
    if (!raw) return '';
    const m = raw.match(/^([!^~]+)(.+)$/);
    const body = m ? m[2] : raw;
    const mods = new Set((m ? m[1] : '').split('').filter(Boolean));
    if (opts.pullup) mods.add('^');
    if (opts.invert) mods.add('!');
    const ordered = ['^', '!', '~'].filter(ch => mods.has(ch)).join('');
    return cgPrefixPin(`${ordered}${body}`, mcuName);
}

function cgAxisBounds(axis) {
    const min = cgParseNumber(document.getElementById(`cgMotion_${axis}_min`)?.value, 0);
    const max = cgParseNumber(document.getElementById(`cgMotion_${axis}_max`)?.value, 200);
    return {min, max};
}

function cgInRange(value, bounds) {
    return value >= bounds.min && value <= bounds.max;
}

function getProbeSources() {
    const sources = [];
    const mainProbePins = cgMappingKeysForType(_currentMapping, 'probe').map(key => _currentMapping[key]);
    const mainServoPins = cgMappingKeysForType(_currentMapping, 'servo').map(key => _currentMapping[key]);
    if (_currentMapping && (mainProbePins.length || mainServoPins.length)) {
        sources.push({
            value: 'main',
            label: '主板',
            mcuName: '',
            mapping: _currentMapping,
            sensorPins: mainProbePins,
            controlPins: mainServoPins,
            serial: 'main'
        });
    }
    _toolboardData.forEach((tb, index) => {
        if (!tb || !tb.mapping) return;
        const sensorPins = cgMappingKeysForType(tb.mapping, 'probe').map(key => tb.mapping[key]);
        const controlPins = cgMappingKeysForType(tb.mapping, 'servo').map(key => tb.mapping[key]);
        if (!sensorPins.length && !controlPins.length) return;
        const name = cgSafeConfigName(tb.name || `TB${index}`, `TB${index}`);
        sources.push({
            value: `tb:${index}`,
            label: `工具板 ${index + 1}: ${name}`,
            mcuName: name,
            mapping: tb.mapping,
            sensorPins,
            controlPins,
            serial: document.getElementById(`cgTBSerial${index}`)?.value?.trim() || tb.serial || '',
            toolboardIndex: index
        });
    });
    return sources;
}

function getSelectedProbeSource() {
    const requested = document.getElementById('cgProbeSource')?.value || _currentProbeSource || 'main';
    const sources = getProbeSources();
    return sources.find(s => s.value === requested) || sources[0] || null;
}

function getProbePinState() {
    const source = getSelectedProbeSource();
    return {
        source,
        sensorPin: document.getElementById('cgProbeSensorPin')?.value || source?.sensorPins?.[0] || '',
        controlPin: document.getElementById('cgProbeControlPin')?.value || source?.controlPins?.[0] || '',
        pullup: document.getElementById('cgProbePullup')?.checked ?? true,
        invert: document.getElementById('cgProbeInvert')?.checked ?? false,
    };
}

function cgToolboardDriveKeys(mapping) {
    const keys = [];
    for (let i = 0; i < 10; i++) {
        const key = `Drives${i}`;
        if (mapping?.[key]) keys.push(key);
        else break;
    }
    return keys;
}

function cgFirstToolKey(mapping, prefix) {
    if (!mapping) return '';
    if (prefix === 'probe') {
        if (mapping.probe != null) return 'probe';
        for (let i = 0; i < 20; i++) {
            const key = `stop${i}`;
            if (mapping[key] != null) return key;
        }
        return '';
    }
    for (let i = 0; i < 20; i++) {
        const key = `${prefix}${i}`;
        if (mapping[key] != null) return key;
    }
    return '';
}

function cgApplyToolboardRolePreset(index, options={}) {
    const tb = _toolboardData[index];
    if (!tb) return;
    const preset = TOOLBOARD_ROLE_PRESETS[tb.role || 'custom'] || TOOLBOARD_ROLE_PRESETS.custom;
    if (!tb.mapping) {
        if (options.render !== false) renderToolboardConflictPanel();
        return;
    }

    const driveKeys = cgToolboardDriveKeys(tb.mapping);
    const nextAxes = new Array(driveKeys.length).fill('');
    (preset.axes || []).forEach((axis, axisIndex) => {
        if (axisIndex < nextAxes.length) nextAxes[axisIndex] = axis;
    });
    if (tb.role !== 'custom') tb.axes = nextAxes;

    if (tb.role !== 'custom') {
        const next = {};
        const heatKey = cgFirstToolKey(tb.mapping, 'heat');
        const tempKey = cgFirstToolKey(tb.mapping, 'temp');
        if (preset.functions?.heat && heatKey) next[heatKey] = preset.functions.heat;
        if (preset.functions?.temp && tempKey) next[tempKey] = preset.functions.temp;
        if (preset.functions?.fan0) {
            const key = tb.mapping.fan0 != null ? 'fan0' : cgFirstToolKey(tb.mapping, 'fan');
            if (key) next[key] = preset.functions.fan0;
        }
        if (preset.functions?.fan1) {
            const key = tb.mapping.fan1 != null ? 'fan1' : '';
            if (key) next[key] = preset.functions.fan1;
        }
        if (preset.functions?.probe) {
            const key = cgFirstToolKey(tb.mapping, 'probe');
            if (key) next[key] = {axis: 'probe', ncno: 'NC'};
            _currentProbeSource = `tb:${index}`;
        }
        if (preset.functions?.adxl) next.__adxl = 'adxl';
        tb.funcAssigns = next;
    }

    if (options.render !== false) {
        renderToolboardDrivers(index);
        renderToolboardFunctions(index);
        renderProbeConfig();
        validateAxisAssignment();
        renderToolboardConflictPanel();
    }
}

function onToolboardRoleChange(index) {
    const tb = _toolboardData[index];
    if (!tb) return;
    tb.role = document.getElementById(`cgTBRole${index}`)?.value || 'custom';
    cgApplyToolboardRolePreset(index);
}

function onToolboardFuncChange(index, key, value) {
    const tb = _toolboardData[index];
    if (!tb) return;
    tb.role = 'custom';
    const roleSel = document.getElementById(`cgTBRole${index}`);
    if (roleSel) roleSel.value = 'custom';
    tb.funcAssigns = tb.funcAssigns || {};
    if (value) tb.funcAssigns[key] = value;
    else delete tb.funcAssigns[key];
    renderToolboardConflictPanel();
    renderProbeConfig();
}

function onToolboardStopFuncChange(index, key, value) {
    const tb = _toolboardData[index];
    if (!tb) return;
    tb.role = 'custom';
    const roleSel = document.getElementById(`cgTBRole${index}`);
    if (roleSel) roleSel.value = 'custom';
    tb.funcAssigns = tb.funcAssigns || {};
    if (value) {
        const ncno = document.getElementById(`cgTBNCNO_${index}_${key}`)?.value || 'NC';
        tb.funcAssigns[key] = {axis: value, ncno};
    } else {
        delete tb.funcAssigns[key];
    }
    renderToolboardConflictPanel();
    renderProbeConfig();
}

function onToolboardStopNcnoChange(index, key, value) {
    const cfg = _toolboardData[index]?.funcAssigns?.[key];
    if (cfg && typeof cfg === 'object') cfg.ncno = value;
    renderToolboardConflictPanel();
    renderProbeConfig();
}

function cgToolboardProbePins(tb) {
    const pins = cgPinArray(tb?.mapping?.probe);
    const fa = tb?.funcAssigns || {};
    Object.entries(fa).forEach(([key, value]) => {
        if (value && typeof value === 'object' && value.axis === 'probe' && tb.mapping?.[key] != null) {
            pins.push(tb.mapping[key]);
        }
    });
    return [...new Set(pins.map(p => cgRawPin(p)).filter(Boolean))];
}

function cgCreateClaims() {
    return {toolboards: [], functions: {}, mcuNames: {}, axes: {}, pinUsages: {}, pinConflicts: []};
}

function cgAddClaim(claims, tbClaim, func, key='', pin='') {
    if (!func) return;
    if (!claims.functions[func]) claims.functions[func] = [];
    const item = {index: tbClaim.index, name: tbClaim.name, key, pin};
    claims.functions[func].push(item);
    tbClaim.functions.push({...item, func});
}

function cgCollectConfiguredPinClaims(claims) {
    if (!_currentMapping) return;
    const tmcUsesCommPin = model => !['none','a4988','external','yanggong'].includes(model || '');
    const addDrivePins = (drive, axis, mcuName, labelPrefix, tmcModel, diagEnabled=false) => {
        if (!drive || !axis) return;
        cgAddPinClaim(claims, drive.step_pin, mcuName, `${labelPrefix} STEP`, {type: 'driver'});
        cgAddPinClaim(claims, drive.dir_pin, mcuName, `${labelPrefix} DIR`, {type: 'driver'});
        cgAddPinClaim(claims, drive.enable_pin, mcuName, `${labelPrefix} ENABLE`, {type: 'driver'});
        if (drive.uart_pin && tmcUsesCommPin(tmcModel)) {
            const commLabel = ['tmc5160','tmc2130'].includes(tmcModel) ? 'TMC CS' : 'TMC UART';
            cgAddPinClaim(claims, drive.uart_pin, mcuName, `${labelPrefix} ${commLabel}`, {type: 'driver'});
        }
        if (diagEnabled && drive.diag_pin) {
            cgAddPinClaim(claims, drive.diag_pin, mcuName, `${labelPrefix} DIAG 限位`, {type: 'diag'});
        }
    };

    for (let i = 0; ; i++) {
        const drive = _currentMapping[`Drives${i}`];
        if (!drive) break;
        const axis = document.getElementById(`cgAxis_${i}`)?.value || '';
        if (!axis) continue;
        const baseAxis = axis.toUpperCase().replace(/\d+/, '');
        const diagEnabled = !!document.getElementById(`cgEndstopDiag_${baseAxis}`)?.checked;
        const tmcModel = document.getElementById(`cgTmcModel_${i}`)?.value || 'tmc2209';
        addDrivePins(drive, axis, '', `主板 ${axis} 电机`, tmcModel, diagEnabled);
    }

    _toolboardData.forEach((tb, tbIndex) => {
        if (!tb?.mapping) return;
        const tbName = cgSafeConfigName(tb.name || `TB${tbIndex}`, `TB${tbIndex}`);
        (tb.axes || []).forEach((axis, driveIndex) => {
            if (!axis) return;
            const drive = tb.mapping[`Drives${driveIndex}`];
            const tmcModel = document.getElementById(`cgTBTmcModel_${tbIndex}_${driveIndex}`)?.value || 'tmc2209';
            addDrivePins(drive, axis, tbName, `${tbName} ${axis} 电机`, tmcModel, false);
        });

        const fa = tb.funcAssigns || {};
        Object.entries(fa).forEach(([key, value]) => {
            const pin = tb.mapping[key];
            if (pin == null) return;
            if (typeof value === 'string' && ['part_fan','throat_fan','controller_fan','exhaust_fan'].includes(value)) {
                cgAddPinClaim(claims, pin, tbName, `${tbName} ${TOOLBOARD_FUNCTION_LABELS[value] || value}`, {type: 'toolboard-fan', index: tbIndex, key});
            } else if (value && typeof value === 'object') {
                const axis = String(value.axis || '').toLowerCase();
                if (axis === 'probe') cgAddPinClaim(claims, pin, tbName, `${tbName} 探针`, {type: 'toolboard-probe', index: tbIndex, key});
                else if (['x','y','z'].includes(axis)) cgAddPinClaim(claims, pin, tbName, `${tbName} ${axis.toUpperCase()} 限位`, {type: 'toolboard-endstop', index: tbIndex, key});
            }
        });

        if (fa.__adxl === 'adxl') {
            const adxlKey = ['lis2dw','adxl345','adxl','adxl_cs'].find(key => tb.mapping[key] != null);
            const adxl = adxlKey ? tb.mapping[adxlKey] : null;
            if (adxl && typeof adxl === 'object') {
                cgAddPinClaim(claims, adxl.cs_pin || adxl.pin || adxl.gpio, tbName, `${tbName} ADXL CS`, {type: 'adxl', index: tbIndex, key: adxlKey});
                if (Array.isArray(adxl.spi_bus)) {
                    cgAddPinClaim(claims, adxl.spi_bus[1] || adxl.spi_bus[0], tbName, `${tbName} ADXL SCLK`, {type: 'adxl', index: tbIndex, key: adxlKey});
                    cgAddPinClaim(claims, adxl.spi_bus[0] || adxl.spi_bus[1], tbName, `${tbName} ADXL MOSI`, {type: 'adxl', index: tbIndex, key: adxlKey});
                    cgAddPinClaim(claims, adxl.spi_bus[2] || adxl.spi_bus[0], tbName, `${tbName} ADXL MISO`, {type: 'adxl', index: tbIndex, key: adxlKey});
                }
            } else if (adxl) {
                cgAddPinClaim(claims, adxl, tbName, `${tbName} ADXL CS`, {type: 'adxl', index: tbIndex, key: adxlKey});
            }
        }
    });

    [
        ['cgHeatPin_extruder', '挤出机 heater_pin'],
        ['cgTempPin_extruder', '挤出机 sensor_pin'],
        ['cgHeatPin_heater_bed', '热床 heater_pin'],
        ['cgTempPin_heater_bed', '热床 sensor_pin'],
        ['cgFanPin_part_fan', '模型风扇 pin'],
        ['cgFanPin_throat_fan', '喉管风扇 pin'],
        ['cgFanPin_driver_fan', '驱动/控制器风扇 pin'],
        ['cgFanPin_controller_fan', '电器仓风扇 pin'],
        ['cgFanPin_exhaust_fan', '排风扇 pin'],
        ['cgFilamentSensorPin', '断料/堵料 switch_pin'],
    ].forEach(([id, label]) => cgAddPinClaimFromRef(claims, document.getElementById(id)?.value || '', label));

    for (let i = 1; i <= _extraHeaterCount; i++) {
        const sec = document.getElementById(`cgExtraSection_${i}`)?.value || 'heater_generic';
        const name = document.getElementById(`cgExtraName_${i}`)?.value || `extra_heater_${i}`;
        if (sec === 'heater_generic') cgAddPinClaimFromRef(claims, document.getElementById(`cgExtraHeatPin_${i}`)?.value || '', `${name} heater_pin`);
        cgAddPinClaimFromRef(claims, document.getElementById(`cgExtraTempPin_${i}`)?.value || '', `${name} sensor_pin`);
    }

    ['X','Y','Z'].forEach(axis => {
        if (axis === 'Z' && _currentProbeMode === 'probe_as_z') return;
        if (document.getElementById(`cgEndstopDiag_${axis}`)?.checked) return;
        cgAddPinClaimFromRef(claims, document.getElementById(`cgEndstopPin_${axis}`)?.value || '', `${axis} 轴物理限位`);
    });

    if (_currentProbeMode !== 'z_endstop_only') {
        const probeType = document.getElementById('cgProbeType')?.value || 'bltouch';
        const probePreset = PROBE_PRESETS[probeType];
        const pinState = getProbePinState();
        if (pinState.source) {
            cgAddPinClaim(claims, pinState.sensorPin, pinState.source.mcuName || '', '探针 sensor_pin', {type: 'probe'});
            if (probePreset?.needs_servo) {
                cgAddPinClaim(claims, pinState.controlPin, pinState.source.mcuName || '', '探针 control_pin', {type: 'probe'});
            }
        }
    }

    if (document.getElementById('cgOptAdxl345')?.checked && !(claims.functions.adxl || []).length) {
        const connType = document.getElementById('cgAdxlConnType')?.value || 'spi_bus';
        if (connType === 'usb') {
            cgAddPinClaim(claims, document.getElementById('cgAdxlUsbCsPin')?.value || 'adxl:gpio1', 'adxl', 'ADXL USB cs_pin', {type: 'adxl'});
        } else if (connType === 'spi_bus') {
            cgAddPinClaim(claims, document.getElementById('cgAdxlCsPin')?.value || 'PA4', '', 'ADXL cs_pin', {type: 'adxl'});
        } else {
            cgAddPinClaim(claims, document.getElementById('cgAdxlCsPin2')?.value || 'PA4', '', 'ADXL cs_pin', {type: 'adxl'});
            cgAddPinClaim(claims, document.getElementById('cgAdxlSclkPin')?.value || 'PA5', '', 'ADXL sclk_pin', {type: 'adxl'});
            cgAddPinClaim(claims, document.getElementById('cgAdxlMosiPin')?.value || 'PA7', '', 'ADXL mosi_pin', {type: 'adxl'});
            cgAddPinClaim(claims, document.getElementById('cgAdxlMisoPin')?.value || 'PA6', '', 'ADXL miso_pin', {type: 'adxl'});
        }
    }
}

function collectToolboardClaims() {
    const claims = cgCreateClaims();
    _toolboardData.forEach((tb, index) => {
        if (!tb || !tb.mapping) return;
        const name = cgSafeConfigName(tb.name || `TB${index}`, `TB${index}`);
        const connType = document.getElementById(`cgTBConn${index}`)?.value || tb.connType || 'can';
        const serial = document.getElementById(`cgTBSerial${index}`)?.value?.trim() || tb.serial || '';
        const tbClaim = {index, name, connType, serial, role: tb.role || 'custom', functions: [], axes: []};
        claims.toolboards.push(tbClaim);
        claims.mcuNames[name] = claims.mcuNames[name] || [];
        claims.mcuNames[name].push(index);

        (tb.axes || []).forEach((axis, driveIndex) => {
            if (!axis) return;
            const axisKey = axis.toUpperCase();
            const item = {index, name, driveIndex};
            claims.axes[axisKey] = claims.axes[axisKey] || [];
            claims.axes[axisKey].push(item);
            tbClaim.axes.push({axis: axisKey, driveIndex});
            if (axisKey === 'E') cgAddClaim(claims, tbClaim, 'extruder_drive', `Drives${driveIndex}`, '');
        });

        const fa = tb.funcAssigns || {};
        Object.entries(fa).forEach(([key, value]) => {
            if (key === '__adxl' && value === 'adxl') {
                cgAddClaim(claims, tbClaim, 'adxl', key, '');
                return;
            }
            const pin = tb.mapping[key] != null ? cgRawPin(tb.mapping[key]) : '';
            if (typeof value === 'string') {
                if (value === 'extruder' && /^heat/i.test(key)) cgAddClaim(claims, tbClaim, 'extruder_heater', key, pin);
                else if (value === 'extruder' && /^temp/i.test(key)) cgAddClaim(claims, tbClaim, 'extruder_sensor', key, pin);
                else if (['part_fan','throat_fan','controller_fan','exhaust_fan'].includes(value)) cgAddClaim(claims, tbClaim, value, key, pin);
            } else if (value && typeof value === 'object') {
                if (value.axis === 'probe') cgAddClaim(claims, tbClaim, 'probe', key, pin);
                else if (['x','y','z'].includes(String(value.axis || '').toLowerCase())) {
                    cgAddClaim(claims, tbClaim, `toolhead_endstop_${String(value.axis).toLowerCase()}`, key, pin);
                }
            }
        });
    });
    const addRefClaim = (func, elementId) => {
        const ref = cgParsePinRef(document.getElementById(elementId)?.value || '');
        if (!ref || ref.source !== 'toolboard') return;
        const tb = _toolboardData[ref.index];
        if (!tb?.mapping) return;
        const tbClaim = claims.toolboards.find(item => item.index === ref.index);
        if (!tbClaim) return;
        cgAddClaim(claims, tbClaim, func, ref.key, cgRawPin(tb.mapping[ref.key]));
    };
    addRefClaim('extruder_heater', 'cgHeatPin_extruder');
    addRefClaim('extruder_sensor', 'cgTempPin_extruder');
    addRefClaim('part_fan', 'cgFanPin_part_fan');
    addRefClaim('throat_fan', 'cgFanPin_throat_fan');
    addRefClaim('driver_fan', 'cgFanPin_driver_fan');
    addRefClaim('controller_fan', 'cgFanPin_controller_fan');
    addRefClaim('exhaust_fan', 'cgFanPin_exhaust_fan');
    addRefClaim('filament_sensor', 'cgFilamentSensorPin');
    ['X','Y','Z'].forEach(axis => addRefClaim(`toolhead_endstop_${axis.toLowerCase()}`, `cgEndstopPin_${axis}`));
    const probeSource = getSelectedProbeSource();
    if (probeSource?.toolboardIndex != null) {
        const tbClaim = claims.toolboards.find(item => item.index === probeSource.toolboardIndex);
        if (tbClaim) cgAddClaim(claims, tbClaim, 'probe', 'probe', '');
    }
    cgCollectConfiguredPinClaims(claims);
    claims.pinConflicts = cgPinConflictMessages(claims);
    return claims;
}

function cgMainAxisAssigned(axis) {
    return Array.from(document.querySelectorAll('[id^="cgAxis_"]')).some(sel => sel.value === axis);
}

function validateToolboardSetup() {
    const claims = collectToolboardClaims();
    const errors = [];
    const warnings = [];

    Object.entries(claims.mcuNames).forEach(([name, indexes]) => {
        if (indexes.length > 1) errors.push(`MCU 名称重复: ${name}`);
    });

    claims.toolboards.forEach(tb => {
        if (!tb.name) errors.push(`工具板 ${tb.index + 1} MCU 名称为空`);
        if (tb.connType === 'can' && tb.serial && !/^[0-9a-fA-F:]{6,}$/.test(tb.serial)) {
            errors.push(`工具板 ${tb.name} 的 CAN UUID 格式不正确`);
        }
        if (tb.connType !== 'can' && tb.serial && !tb.serial.startsWith('/dev/') && !tb.serial.startsWith('/tmp/')) {
            warnings.push(`工具板 ${tb.name} 的 serial 通常应以 /dev/ 开头`);
        }
        if (tb.role !== 'custom' && !tb.functions.length && !tb.axes.length) {
            warnings.push(`工具板 ${tb.name} 已选择“${TOOLBOARD_ROLE_PRESETS[tb.role]?.label || tb.role}”，但当前型号没有匹配到可用接口`);
        }
    });

    Object.entries(claims.functions).forEach(([func, owners]) => {
        if (owners.length > 1) {
            const names = owners.map(o => `${o.name}${o.key ? `:${o.key}` : ''}`).join('、');
            errors.push(`${TOOLBOARD_FUNCTION_LABELS[func] || func} 被多个工具板声明: ${names}`);
        }
    });

    Object.entries(claims.axes).forEach(([axis, owners]) => {
        if (owners.length > 1) {
            errors.push(`${axis} 轴被多个工具板重复分配`);
        }
        if (cgMainAxisAssigned(axis)) {
            errors.push(`${axis} 轴被主板和工具板重复分配`);
        }
    });

    claims.pinConflicts.forEach(msg => errors.push(msg));

    const owns = func => (claims.functions[func] || []).length > 0;
    if (owns('extruder_drive') && (!owns('extruder_heater') || !owns('extruder_sensor'))) {
        warnings.push('工具板已接管 E 电机，但热端加热或热敏未完整分配；生成时会优先复用主板侧挤出机 heater/sensor。');
    }
    if (owns('adxl') && document.getElementById('cgOptAdxl345')?.checked) {
        warnings.push('ADXL 已由工具板接管，主板/独立 ADXL 配置将不生成。');
    }

    return {ok: errors.length === 0, errors, warnings, claims};
}

function renderToolboardConflictPanel() {
    const panel = document.getElementById('cgToolboardConflictSummary');
    const result = validateToolboardSetup();
    if (panel) {
        const items = [
            ...result.errors.map(msg => `<li class="error">${cgEscapeHtml(msg)}</li>`),
            ...result.warnings.map(msg => `<li class="warn">${cgEscapeHtml(msg)}</li>`)
        ];
        if (!items.length) {
            panel.className = 'cg-toolboard-check ok';
            panel.innerHTML = '<i class="fas fa-check-circle"></i> 工具板冲突检查通过';
        } else {
            panel.className = result.ok ? 'cg-toolboard-check warn' : 'cg-toolboard-check error';
            panel.innerHTML = `<strong>${result.ok ? '建议确认' : '需要处理'}</strong><ul>${items.join('')}</ul>`;
        }
    }

    result.claims.toolboards.forEach(tb => {
        const box = document.getElementById(`cgTBConflict${tb.index}`);
        if (!box) return;
        const own = tb.functions.map(item => TOOLBOARD_FUNCTION_LABELS[item.func] || item.func);
        const axes = tb.axes.map(item => item.axis);
        const summary = [...new Set([...own, ...axes.map(a => `${a}轴`)])];
        box.className = 'cg-toolboard-mini';
        box.innerHTML = summary.length
            ? `<i class="fas fa-route"></i> 当前使用：${summary.map(cgEscapeHtml).join('、')}`
            : '<i class="fas fa-info-circle"></i> 尚未在其他选项卡中使用';
    });
    cgRefreshBoardHotspotUsage();
}

function cgToolboardOwns(claims, func) {
    return (claims?.functions?.[func] || []).length > 0;
}

function cgGetOutputMode() {
    return document.getElementById('cgOutputMode')?.value || 'full';
}

function cgToolboardMcuNames() {
    return _toolboardData
        .map((tb, index) => tb?.mapping ? cgSafeConfigName(tb.name || `TB${index}`, `TB${index}`) : '')
        .filter(Boolean);
}

function cgSplitConfigSections(text) {
    const blocks = [];
    let current = [];
    String(text || '').split(/\r?\n/).forEach(line => {
        if (/^\s*\[[^\]]+\]/.test(line)) {
            if (current.length) blocks.push(current.join('\n').trimEnd());
            current = [line];
        } else if (current.length) {
            current.push(line);
        }
    });
    if (current.length) blocks.push(current.join('\n').trimEnd());
    return blocks.filter(Boolean);
}

function cgFilterConfigByToolboards(text, includeToolboard=true) {
    const names = cgToolboardMcuNames();
    if (!names.length) return '';
    const isToolBlock = block => names.some(name =>
        new RegExp(`^\\[mcu\\s+${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\]`, 'm').test(block) ||
        block.includes(`${name}:`)
    );
    return cgSplitConfigSections(text).filter(block => includeToolboard ? isToolBlock(block) : !isToolBlock(block)).join('\n\n') + '\n';
}

function cgParseCfgSections(text) {
    const sections = [];
    let current = null;
    String(text || '').split(/\r?\n/).forEach((line, lineIndex) => {
        const header = line.match(/^\s*\[([^\]]+)\]\s*(?:#.*)?$/);
        if (header) {
            current = {name: header[1].trim(), line: lineIndex + 1, raw: [], options: {}};
            sections.push(current);
            return;
        }
        if (!current) return;
        current.raw.push(line);
        const kv = line.match(/^\s*([^:#]+)\s*:\s*(.*?)\s*(?:#.*)?$/);
        if (kv) current.options[kv[1].trim()] = kv[2].trim();
    });
    const map = {};
    sections.forEach(sec => {
        map[sec.name] = sec;
    });
    return {sections, map};
}

function cgExtractMcuPrefixesFromSection(section) {
    const prefixes = new Set();
    Object.values(section.options || {}).forEach(value => {
        String(value).replace(/[!^~]?\b([A-Za-z_][\w.-]*):[A-Za-z0-9_.-]+/g, (_, mcu) => {
            if (mcu !== 'mcu' && mcu !== 'probe') prefixes.add(mcu);
            return _;
        });
    });
    return [...prefixes];
}

function cgInferToolboardFunctions(parsed, mcuName) {
    const funcs = new Set();
    parsed.sections.forEach(sec => {
        const prefixes = cgExtractMcuPrefixesFromSection(sec);
        if (!prefixes.includes(mcuName)) return;
        const name = sec.name.toLowerCase();
        if (name === 'extruder') funcs.add('挤出机/热端');
        else if (name.startsWith('fan') || name.startsWith('heater_fan') || name.startsWith('controller_fan')) funcs.add('风扇');
        else if (name === 'probe' || name === 'bltouch') funcs.add('探针');
        else if (name.startsWith('adxl') || name.startsWith('lis2dw') || name.startsWith('resonance_tester')) funcs.add('ADXL/共振');
        else if (name.startsWith('stepper_')) funcs.add('限位/运动');
    });
    return [...funcs];
}

function cgIdentifyToolboardsFromConfig(text) {
    const parsed = cgParseCfgSections(text);
    const mcuSections = parsed.sections.filter(sec => sec.name.toLowerCase().startsWith('mcu '));
    const byName = {};
    mcuSections.forEach(sec => {
        const name = sec.name.replace(/^mcu\s+/i, '').trim();
        if (!name || name === 'mcu') return;
        byName[name] = {
            name,
            connType: sec.options.canbus_uuid ? 'can' : 'serial',
            serial: sec.options.canbus_uuid || sec.options.serial || '',
            functions: []
        };
    });
    parsed.sections.forEach(sec => {
        cgExtractMcuPrefixesFromSection(sec).forEach(prefix => {
            if (!byName[prefix]) byName[prefix] = {name: prefix, connType: 'can', serial: '', functions: []};
        });
    });
    Object.values(byName).forEach(tb => {
        tb.functions = cgInferToolboardFunctions(parsed, tb.name);
    });
    return Object.values(byName);
}

function cgEnsureToolCountOption(count) {
    const sel = document.getElementById('cgToolCount');
    if (!sel) return;
    if (!Array.from(sel.options).some(opt => opt.value === String(count))) {
        sel.innerHTML += `<option value="${count}">${count}</option>`;
    }
    sel.value = String(count);
}

function cgApplyImportedToolboards(toolboards) {
    if (!toolboards.length) return;
    cgEnsureToolCountOption(toolboards.length);
    _toolboardData = toolboards.map((tb, index) => ({
        boardId: '',
        name: tb.name || `toolhead${index || ''}`,
        role: 'custom',
        connType: tb.connType || 'can',
        serial: tb.serial || '',
        mapping: null,
        boardInfo: null,
        axes: [],
        funcAssigns: {}
    }));
    onToolCountChange();
}

function cgImportedConfigSummaryHtml(sourceLabel='导入配置') {
    const parsed = cgParseCfgSections(_cgImportedConfig);
    const header = `<strong>${cgEscapeHtml(sourceLabel)}</strong><p>已读取 ${parsed.sections.length} 个 section，可用于工具板识别和新旧配置 diff。</p>`;
    if (_cgImportedToolboards.length) {
        return header + '<strong>已识别工具板</strong><ul>' + _cgImportedToolboards.map(tb =>
            `<li><code>[mcu ${cgEscapeHtml(tb.name)}]</code> ${tb.connType === 'can' ? 'CAN' : 'Serial'} ${cgEscapeHtml(tb.serial || '未发现地址')} - ${cgEscapeHtml((tb.functions || []).join('、') || '未识别功能')}</li>`
        ).join('') + '</ul>';
    }
    return header + '<p>未识别到独立工具板 MCU。</p>';
}

function cgApplyImportedConfigText(text, sourceLabel='导入配置', showToast=true) {
    _cgImportedConfig = String(text || '');
    _cgImportedToolboards = cgIdentifyToolboardsFromConfig(_cgImportedConfig);
    cgApplyImportedToolboards(_cgImportedToolboards);
    const panel = document.getElementById('cgImportSummary');
    if (panel) {
        panel.style.display = 'block';
        panel.innerHTML = cgImportedConfigSummaryHtml(sourceLabel);
    }
    if (showToast) cgShowToast('已作为旧配置导入');
}

function importExistingPrinterConfig(event) {
    const file = event?.target?.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
        const text = String(reader.result || '');
        cgApplyImportedConfigText(text, file.name || '旧 printer.cfg');
        const parserInput = document.getElementById('cgParserInput');
        if (parserInput) parserInput.value = text;
        if (document.getElementById('cgParserResult')) cgParserRun(false);
    };
    reader.readAsText(file);
}

function cgParserSetStatus(message='', type='info') {
    const el = document.getElementById('cgParserStatus');
    if (!el) return;
    const colors = {
        success: 'var(--success-color)',
        warning: 'var(--warning-color)',
        error: 'var(--danger-color)',
        info: 'var(--text-secondary)'
    };
    el.style.color = colors[type] || colors.info;
    el.textContent = message;
}

function cgParserSetProgress(visible) {
    const el = document.getElementById('cgParserProgress');
    if (el) el.style.display = visible ? 'block' : 'none';
}

function cgParserGetBaseline() {
    try { return _mainsailBaseline || ''; } catch (e) { return ''; }
}

function cgParserSetBaseline(value) {
    try { _mainsailBaseline = value || ''; } catch (e) { console.warn('设置 Mainsail 基准失败:', e); }
}

function cgParserSetInput(text) {
    const input = document.getElementById('cgParserInput');
    if (input) input.value = String(text || '');
}

function cgParserGetInput() {
    return String(document.getElementById('cgParserInput')?.value || '');
}

function cgParserRun(importAsOld=false) {
    const text = cgParserGetInput();
    const output = document.getElementById('cgParserResult');
    if (!output) return;
    if (!text.trim()) {
        output.innerHTML = '<div class="error-msg"><i class="fas fa-exclamation-circle"></i> 请先加载、上传或粘贴配置内容。</div>';
        cgParserSetStatus('没有可解析的配置', 'warning');
        return;
    }
    if (typeof klipperParserAnalyzeConfig !== 'function') {
        output.innerHTML = '<div class="error-msg"><i class="fas fa-exclamation-circle"></i> 配置解析器脚本未加载。</div>';
        cgParserSetStatus('解析器不可用', 'error');
        return;
    }
    try {
        const analysis = klipperParserAnalyzeConfig(text, cgParserGetBaseline());
        output.innerHTML = analysis.html;
        cgParserSetStatus(`解析完成：${analysis.sections.length} 个 section`, 'success');
        if (importAsOld) cgApplyImportedConfigText(text, '解析器内容', false);
    } catch (error) {
        output.innerHTML = `<div class="error-msg"><i class="fas fa-exclamation-circle"></i> 解析错误: ${cgEscapeHtml(error.message)}</div>`;
        cgParserSetStatus('解析失败', 'error');
    }
}

function cgParserUseAsImported() {
    const text = cgParserGetInput();
    if (!text.trim()) {
        cgParserSetStatus('没有可导入的旧配置', 'warning');
        cgShowToast('请先加载或粘贴旧配置', 'warning');
        return;
    }
    cgApplyImportedConfigText(text, '解析器内容');
    cgParserRun(false);
}

function cgParserClear() {
    cgParserSetInput('');
    const result = document.getElementById('cgParserResult');
    if (result) result.innerHTML = '<p style="text-align:center;color:var(--text-secondary);padding:30px 0;">解析结果将显示在这里...</p>';
    const list = document.getElementById('cgParserRemoteFileList');
    if (list) list.style.display = 'none';
    const listContent = document.getElementById('cgParserRemoteFileListContent');
    if (listContent) listContent.innerHTML = '';
    cgParserSetStatus('');
}

function cgParserHandleFiles(event) {
    const files = Array.from(event?.target?.files || []);
    if (!files.length) return;
    const valid = files.filter(file => /\.(cfg|conf|txt)$/i.test(file.name));
    if (!valid.length) {
        cgShowToast('请选择 .cfg / .conf / .txt 配置文件', 'warning');
        return;
    }
    Promise.all(valid.map(file => new Promise(resolve => {
        const reader = new FileReader();
        reader.onload = e => resolve(`# ===== ${file.name} =====\n${e.target.result || ''}`);
        reader.readAsText(file);
    }))).then(contents => {
        const text = contents.join('\n\n');
        cgParserSetInput(text);
        cgApplyImportedConfigText(text, `上传配置 (${valid.length} 个文件)`, false);
        cgParserRun(false);
        cgParserSetStatus(`已合并 ${valid.length} 个配置文件`, 'success');
    });
    if (event?.target) event.target.value = '';
}

function cgParserLoadGeneratedConfig() {
    if (!_cgCurrentConfig) {
        cgShowToast('请先生成配置', 'warning');
        return;
    }
    cgParserSetInput(_cgCurrentConfig);
    cgParserRun(false);
    cgParserSetStatus('已载入当前生成结果', 'success');
}

async function cgParserLoadRemoteConfigList() {
    const btn = document.getElementById('cgParserRemoteBtn');
    const fileListDiv = document.getElementById('cgParserRemoteFileList');
    const fileListContent = document.getElementById('cgParserRemoteFileListContent');
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 加载中...'; }
    cgParserSetStatus('正在查询被控机器配置文件...', 'info');
    cgParserSetProgress(true);
    if (fileListDiv) fileListDiv.style.display = 'none';
    try {
        const resp = await fetch('/api/tools/config-files');
        const data = await resp.json();
        if (!data.success) throw new Error(data.error || '加载失败');
        const files = data.files || [];
        const sourceLabels = { moonraker: 'Moonraker', ssh: 'SSH', local: '本地' };
        const sourceLabel = sourceLabels[data.source] || data.source || '未知来源';
        const dirs = files.filter(f => f.type === 'dir');
        const cfgFiles = files.filter(f => f.type === 'file');
        let html = '';
        if (dirs.length) {
            html += '<div style="padding:6px 8px;font-size:12px;color:var(--text-secondary);border-bottom:1px solid var(--border-color);">子目录</div>';
            dirs.forEach(d => { html += `<div class="file-item"><div class="file-name"><i class="fas fa-folder"></i> ${cgEscapeHtml(d.name)}</div><div class="file-size">目录</div></div>`; });
        }
        if (cfgFiles.length) {
            html += `<div style="padding:6px 8px;font-size:12px;color:var(--text-secondary);border-bottom:1px solid var(--border-color);">配置文件 (${cfgFiles.length} 个, 来源: ${cgEscapeHtml(sourceLabel)})</div>`;
            cfgFiles.forEach(f => {
                const sizeStr = f.size ? `${(f.size / 1024).toFixed(1)} KB` : '';
                const isPrinterCfg = f.name === 'printer.cfg';
                html += `<div class="file-item" style="cursor:pointer;${isPrinterCfg ? ' background:#e8f4ff;' : ''}" onclick='cgParserLoadRemoteConfig(${JSON.stringify(f.path)})' title="点击加载"><div class="file-name"><i class="fas fa-file-code" style="color:var(--primary-color);margin-right:6px;"></i>${cgEscapeHtml(f.name)}${isPrinterCfg ? ' <span style="color:var(--success-color);font-size:11px;">(主配置)</span>' : ''}</div><div class="file-size">${cgEscapeHtml(sizeStr)} <i class="fas fa-download" style="margin-left:6px;color:var(--primary-color);"></i></div></div>`;
            });
        }
        if (fileListContent) fileListContent.innerHTML = html || '<p class="empty">未找到配置文件</p>';
        if (fileListDiv) fileListDiv.style.display = 'block';
        const printerCfg = cfgFiles.find(f => f.name === 'printer.cfg');
        if (printerCfg) {
            await cgParserLoadPrinterCfgWithIncludes(printerCfg.path, sourceLabel);
        } else {
            cgParserSetStatus(`未找到 printer.cfg，请手动选择配置文件 (${sourceLabel})`, 'warning');
        }
    } catch (err) {
        cgParserSetStatus(`加载失败: ${err.message}`, 'error');
    } finally {
        if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-server"></i> 从被控机器加载'; }
        cgParserSetProgress(false);
    }
}

async function cgParserLoadPrinterCfgWithIncludes(printerCfgPath, sourceLabel='被控机器') {
    cgParserSetStatus('正在读取 printer.cfg...', 'info');
    const mainResp = await fetch('/api/tools/config-content', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: printerCfgPath })
    });
    const mainData = await mainResp.json();
    if (!mainData.success) throw new Error(mainData.error || 'printer.cfg 加载失败');
    let mergedContent = `# ===== printer.cfg (主配置) =====\n${mainData.content}`;
    const includePatterns = typeof parseIncludeFiles === 'function' ? parseIncludeFiles(mainData.content) : [];
    if (includePatterns.length && typeof recursiveLoadIncludes === 'function') {
        const cfgDir = printerCfgPath.substring(0, printerCfgPath.lastIndexOf('/') + 1);
        const loadedFiles = new Set([printerCfgPath]);
        cgParserSetStatus(`发现 ${includePatterns.length} 个 include，正在递归加载...`, 'info');
        mergedContent += await recursiveLoadIncludes(includePatterns, cfgDir, loadedFiles, 0, 5, msg => cgParserSetStatus(msg, 'info'));
    }
    try {
        const msResp = await fetch('/api/tools/mainsail-config');
        const msData = await msResp.json();
        cgParserSetBaseline(msData.success ? msData.content : '');
    } catch (e) {
        cgParserSetBaseline('');
    }
    cgParserSetInput(mergedContent);
    cgApplyImportedConfigText(mergedContent, `被控机器 printer.cfg (${sourceLabel})`, false);
    cgParserRun(false);
    cgParserSetStatus(`已加载 printer.cfg 及 include (${sourceLabel})`, 'success');
}

async function cgParserLoadRemoteConfig(filePath) {
    cgParserSetStatus('正在读取文件...', 'info');
    try {
        const resp = await fetch('/api/tools/config-content', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: filePath })
        });
        const data = await resp.json();
        if (!data.success) throw new Error(data.error || '读取失败');
        cgParserSetInput(data.content);
        cgApplyImportedConfigText(data.content, data.filename || '远程配置', false);
        cgParserRun(false);
        cgParserSetStatus(`已加载: ${data.filename || filePath}`, 'success');
    } catch (err) {
        cgParserSetStatus(`读取失败: ${err.message}`, 'error');
    }
}

async function cgParserUpdateMainsailBaseline() {
    const btn = document.getElementById('cgParserBaselineBtn');
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 更新中...'; }
    cgParserSetStatus('正在更新 mainsail.cfg 宏基准...', 'info');
    try {
        const resp = await fetch('/api/tools/mainsail-config/update', { method: 'POST' });
        const data = await resp.json();
        if (!data.success) throw new Error(data.error || '更新失败');
        const msResp = await fetch('/api/tools/mainsail-config');
        const msData = await msResp.json();
        if (msData.success) cgParserSetBaseline(msData.content);
        cgParserSetStatus(`${data.message}，包含 ${data.macro_count} 个宏`, 'success');
        if (cgParserGetInput().trim()) cgParserRun(false);
    } catch (err) {
        cgParserSetStatus(`宏基准更新失败: ${err.message}`, 'error');
    } finally {
        if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-sync-alt"></i> 更新宏基准'; }
    }
}

function showGeneratedConfigDiff() {
    const panel = document.getElementById('cgDiffSummary');
    if (!panel) return;
    if (!_cgImportedConfig) {
        panel.style.display = 'block';
        panel.innerHTML = '<strong>无法对比</strong><p>请先导入旧 printer.cfg。</p>';
        cgShowToast('请先导入旧配置', 'warning');
        return;
    }
    if (!_cgCurrentConfig) {
        panel.style.display = 'block';
        panel.innerHTML = '<strong>无法对比</strong><p>请先生成新配置。</p>';
        cgShowToast('请先生成配置', 'warning');
        return;
    }
    const oldParsed = cgParseCfgSections(_cgImportedConfig);
    const newParsed = cgParseCfgSections(_cgCurrentConfig);
    const oldNames = new Set(Object.keys(oldParsed.map));
    const newNames = new Set(Object.keys(newParsed.map));
    const added = [...newNames].filter(name => !oldNames.has(name));
    const removed = [...oldNames].filter(name => !newNames.has(name));
    const modified = [...newNames].filter(name => oldNames.has(name) && JSON.stringify(newParsed.map[name].options) !== JSON.stringify(oldParsed.map[name].options));
    const unchanged = [...newNames].filter(name => oldNames.has(name) && !modified.includes(name));
    const list = (title, items, cls) => `<div class="cg-diff-group ${cls}"><strong>${title} (${items.length})</strong>${items.length ? `<ul>${items.map(name => `<li><code>[${cgEscapeHtml(name)}]</code></li>`).join('')}</ul>` : '<p>无</p>'}</div>`;
    panel.style.display = 'block';
    panel.innerHTML = list('新增', added, 'add') + list('修改', modified, 'mod') + list('旧配置存在但新配置未生成，建议手动确认保留', removed, 'del') + list('未变化', unchanged, 'same');
}

function cgStaticValidateConfig(text) {
    const parsed = cgParseCfgSections(text);
    const errors = [];
    const warnings = [];
    const seen = {};
    parsed.sections.forEach(sec => {
        seen[sec.name] = seen[sec.name] || [];
        seen[sec.name].push(sec.line);
        Object.entries(sec.options).forEach(([key, value]) => {
            if (/_pin$|^pin$/.test(key) && /\b[A-Za-z_][\w.-]*:/.test(value)) {
                const mcu = value.replace(/^[!^~]+/, '').split(':')[0];
                if (mcu && mcu !== 'probe' && !parsed.map[`mcu ${mcu}`]) {
                    errors.push(`[${sec.name}] ${key} 使用 ${mcu}: 前缀，但缺少 [mcu ${mcu}]。`);
                }
            }
        });
    });
    Object.entries(seen).forEach(([name, lines]) => {
        if (lines.length > 1) errors.push(`重复 section [${name}]，行号: ${lines.join(', ')}`);
    });
    if (!parsed.map.mcu && !parsed.map['mcu']) warnings.push('未发现 [mcu] 主控 section。');
    return {ok: errors.length === 0, errors, warnings, method: 'static'};
}

async function validateGeneratedConfigLocal() {
    if (!_cgCurrentConfig) {
        cgShowToast('请先生成配置', 'warning');
        return;
    }
    const panel = document.getElementById('cgDiffSummary');
    try {
        const res = await fetch('/api/tools/validate-klipper-config', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({content: _cgCurrentConfig})
        });
        const data = await res.json();
        if (!data.success) throw new Error(data.error || '校验失败');
        const items = [...(data.errors || []).map(msg => `<li class="error">${cgEscapeHtml(msg)}</li>`), ...(data.warnings || []).map(msg => `<li class="warn">${cgEscapeHtml(msg)}</li>`)];
        if (panel) {
            panel.style.display = 'block';
            panel.innerHTML = `<strong>${data.ok ? '校验通过' : '校验发现问题'}</strong><p>方法：${cgEscapeHtml(data.method || 'local')}</p>${items.length ? `<ul>${items.join('')}</ul>` : '<p>未发现明显问题。</p>'}`;
        }
        cgShowToast(data.ok ? '配置校验通过' : '配置校验发现问题', data.ok ? 'success' : 'warning');
    } catch (e) {
        const result = cgStaticValidateConfig(_cgCurrentConfig);
        const items = [...result.errors.map(msg => `<li class="error">${cgEscapeHtml(msg)}</li>`), ...result.warnings.map(msg => `<li class="warn">${cgEscapeHtml(msg)}</li>`)];
        if (panel) {
            panel.style.display = 'block';
            panel.innerHTML = `<strong>${result.ok ? '静态校验通过' : '静态校验发现问题'}</strong><p>后端本地 Klipper 校验不可用，已执行前端结构检查。</p>${items.length ? `<ul>${items.join('')}</ul>` : '<p>未发现明显问题。</p>'}`;
        }
        cgShowToast(result.ok ? '静态校验通过' : '静态校验发现问题', result.ok ? 'success' : 'warning');
    }
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
        sel.innerHTML += `<option value="${cgEscapeHtml(m.id)}">${cgEscapeHtml(m.name)} (${cgEscapeHtml(m.drive_count)}驱动, ${cgEscapeHtml(m.geometry?.type || '?')})</option>`;
    });
    sel.innerHTML += `<option value="custom">✏️ 自定义打印机</option>`;
    if (_machineList.length > 0) { _loadFullPreset(_machineList[0].id); }
}
async function _loadFullPreset(machineId) {
    try {
        const r = await fetch(`/api/tools/machines/${encodeURIComponent(machineId)}`);
        const d = await r.json();
        if (d.success) { _currentPreset = d.preset; }
    } catch (e) { console.error('加载预设详情失败', e); }
}
function populateBrands() {
    const sel = document.getElementById('cgBrand'); sel.innerHTML = '';
    for (const b of Object.keys(_boardsIndex)) sel.innerHTML += `<option value="${cgEscapeHtml(b)}"${b==='FLY'?' selected':''}>${cgEscapeHtml(b)}</option>`;
    populateBoards();
}
function onBrandChange() {
    populateBoards();
    _cgBoardLoadSeq++;
    _currentMapping = null;
    _currentBoardInfo = null;
    _currentBoardLayout = null;
    _cgSelectedBoardPin = '';
    const info = document.getElementById('cgBoardInfo');
    if (info) info.textContent = '';
    cgClearBoardImages('请先选择主板。');
    resetConfigPanels();
}
function populateBoards() {
    const brand = document.getElementById('cgBrand').value || 'FLY';
    const bd = _boardsIndex[brand]; if (!bd) return;
    const bs = document.getElementById('cgBoard');
    bs.innerHTML = '<option value="">-- 选择型号 --</option>';
    for (const [bid,info] of Object.entries(bd.mainboards)) bs.innerHTML += `<option value="${cgEscapeHtml(bid)}">${cgEscapeHtml(info.name)} (${cgEscapeHtml(info.drive_count)}驱动, ${cgEscapeHtml(info.platform)})</option>`;
    const tbs = Object.keys(bd.toolboards);
    if (tbs.length > 0) {
        bs.innerHTML += `<optgroup label="工具板">`;
        for (const [bid,info] of Object.entries(bd.toolboards)) bs.innerHTML += `<option value="${cgEscapeHtml(bid)}">${cgEscapeHtml(info.name)} (${cgEscapeHtml(info.drive_count)}驱动, ${cgEscapeHtml(info.platform)})</option>`;
        bs.innerHTML += `</optgroup>`;
    }
}
async function onBoardChange() {
    const boardId = document.getElementById('cgBoard').value;
    const loadSeq = ++_cgBoardLoadSeq;
    cgClearBoardImages(boardId ? '正在加载板卡图片...' : '请先选择主板。');
    if (!boardId) { _currentMapping=null; _currentBoardInfo=null; _currentBoardLayout=null; _cgSelectedBoardPin=''; resetConfigPanels(); return; }
    _currentMapping = null;
    _currentBoardInfo = null;
    _currentBoardLayout = null;
    _cgSelectedBoardPin = '';
    try {
        const r = await fetch(`/api/tools/boards/${encodeURIComponent(boardId)}/mapping`);
        const d = await r.json();
        if (loadSeq !== _cgBoardLoadSeq) return;
        if (!d.success) { cgShowToast(d.error,'error'); return; }
        _currentMapping = d.mapping; _currentBoardInfo = d.board_info;
        _currentBoardLayout = d.layout || null;
        _cgSelectedBoardPin = '';
        const info = _currentBoardInfo;
        document.getElementById('cgBoardInfo').innerHTML = `<span>MCU: ${cgEscapeHtml(info.mcu)}</span> | <span>${cgEscapeHtml(info.drive_count)}驱动</span> | <span>${cgEscapeHtml(info.heat_count)}加热</span> | <span>${cgEscapeHtml(info.fan_count)}风扇</span>`;
        // 加载板卡图片
        const imgContainer = document.getElementById('cgBoardImageContainer');
        const imgEl = document.getElementById('cgBoardImage');
        if (info.image && imgContainer && imgEl) {
            const imageUrl = cgBoardImageUrl(boardId);
            _cgBoardImageUrl = imageUrl;
            imgEl.onload = () => {
                if (loadSeq !== _cgBoardLoadSeq) return;
                imgContainer.style.display = 'block';
                renderBoardLayoutOverlay();
            };
            imgEl.onerror = () => {
                if (loadSeq !== _cgBoardLoadSeq) return;
                imgContainer.style.display = 'none';
                cgShowToast('板卡图片加载失败', 'warning');
            };
            imgEl.alt = `${info.name || boardId} 板卡图片`;
            imgEl.src = imageUrl;
        } else if (imgContainer) {
            _cgBoardImageUrl = '';
            imgContainer.style.display = 'none';
        }
        populateConnections(info.connections);
        renderDriverAssignment(); renderMotionParams();
        renderHeaterConfig(); renderFanConfig(); renderExtruderParams(); renderBedParams();
        renderEndstopConfig(); renderProbeConfig();
        renderHomingParams(); renderLevelingParams();
        smartAutoAssign();
        renderBoardLayoutOverlay();
    } catch (e) { cgShowToast('加载板卡数据失败: '+e.message,'error'); }
}
function populateConnections(connections) {
    const sel = document.getElementById('cgConnection'); sel.innerHTML = '';
    for (const c of connections) { const v=c.includes('CAN')?'can':c.includes('USB')?'usb':'serial'; sel.innerHTML += `<option value="${cgEscapeHtml(v)}">${cgEscapeHtml(c)}</option>`; }
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
        } catch(e) { console.warn('MCU 设备检测请求失败:', e); }
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
            sel.innerHTML += `<option value="${cgEscapeHtml(dev.path)}" data-type="${cgEscapeHtml(dev.type || 'serial')}">${cgEscapeHtml(icons[dev.type] || '🔌')}: ${cgEscapeHtml(dev.description || dev.path)}</option>`;
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
    const overlay=document.getElementById('cgBoardOverlay'); if(overlay) overlay.innerHTML='';
    const pinInfo=document.getElementById('cgBoardPinInfo'); if(pinInfo) pinInfo.innerHTML='<i class="fas fa-info-circle"></i> 点击图片上的接口查看物理位置、真实 pin 和可用分配。';
    document.querySelectorAll('.cg-board-map').forEach(root => {
        root.classList.add('empty');
        const parts = cgEnsureBoardMap(root);
        if (parts?.overlay) parts.overlay.innerHTML = '';
        if (parts?.panel) parts.panel.innerHTML = '<i class="fas fa-info-circle"></i> 请先选择主板。';
    });
}

// ========== 帮助系统 ==========
function showFieldHelp(el) {
    const existing = document.querySelector('.cg-help-popover');
    if (existing) existing.remove();
    const popover = document.createElement('div');
    popover.className = 'cg-help-popover';
    popover.innerHTML = cgEscapeHtml(el.dataset.help || '').replace(/\n/g, '<br>');
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
    if (!term) return `<input type="text" id="${cgEscapeHtml(id)}" value="${cgEscapeHtml(value)}"${extra||''}>`;
    return `<label><span class="cg-field-label">${cgEscapeHtml(term.label)}</span> <code class="cg-field-param">${cgEscapeHtml(termKey)}</code><span class="cg-help-icon" data-help="${cgEscapeHtml(term.hint)}" onclick="showFieldHelp(this)">?</span></label><input type="text" id="${cgEscapeHtml(id)}" value="${cgEscapeHtml(value)}" placeholder="${cgEscapeHtml(term.def)}"${extra||''}>`;
}
// 错误定位与友好提示
function cgShowFormError(message) {
    const errEl = document.getElementById('errorMessage');
    if (errEl) {
        errEl.innerHTML = '<i class="fas fa-exclamation-triangle"></i> ' + cgEscapeHtml(message);
        errEl.style.display = 'block';
    }
}
function cgHighlightError(fieldId, message) {
    const el = document.getElementById(fieldId);
    if (el) {
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
    }
    cgShowFormError(message);
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
    if (m['BED_OUT']) { const el = document.getElementById('cgHeatPin_heater_bed'); if(el&&!el.value) el.value = cgPinRefMain('BED_OUT'); }
    else if (m['bed-heat']) { const el = document.getElementById('cgHeatPin_heater_bed'); if(el&&!el.value) el.value = cgPinRefMain('bed-heat'); }
    const extHeat=document.getElementById('cgHeatPin_extruder');
    if (extHeat && !extHeat.value && m.heat0 != null) extHeat.value = cgPinRefMain('heat0');
    ['stop0','stop1','stop2'].forEach((stop, i) => {
        const el = document.getElementById(`cgFunc_${stop}`);
        if (el && !el.value) el.value = ['x','y','z'][i];
    });
    const fan0El = document.getElementById('cgFanPin_part_fan');
    if (fan0El && !fan0El.value && m.fan0 != null) fan0El.value = cgPinRefMain('fan0');
    if (m.probe && preset.probe) {
        const probeEl = document.getElementById('cgProbeType');
        if (probeEl) probeEl.value = preset.probe.type || 'bltouch';
    }
    updateMotionParamsForModel();
    renderBoardLayoutOverlay();
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
// ========== Probe 工具函数 ==========
function applyProbePreset() {
    // 从 _currentPreset.probe 注入完整预设参数到 UI
    const pp = _currentPreset?.probe;
    if (!pp) return;
    const setVal = (id, val, def) => { const el = document.getElementById(id); if (el && val != null) el.value = val; else if (el && def != null) el.value = def; };
    setVal('cgZOffset', pp.z_offset, 2.0);
    setVal('cgProbeXOffset', pp.x_offset, 0);
    setVal('cgProbeYOffset', pp.y_offset, 0);
    setVal('cgProbeSamples', pp.samples, 1);
    setVal('cgProbeSpeed', pp.speed, 5.0);
    setVal('cgProbeSpeed2', pp.second_speed ?? pp.lift_speed, pp.speed ?? 5.0);
    setVal('cgProbeRetract', pp.sample_retract_dist, 2.0);
    setVal('cgProbeTolerance', pp.samples_tolerance, 0.100);
    setVal('cgProbeRetries', pp.samples_tolerance_retries, 0);
    if (pp.samples_result) { const el = document.getElementById('cgProbeSamplesResult'); if (el) el.value = pp.samples_result; }
}
function onProbeModeChange() {
    // 从radio button读取当前选中的模式值
    const checkedRadio = document.querySelector('input[name="cgProbeMode"]:checked');
    const mode = checkedRadio?.value || 'z_endstop_plus_probe';
    _currentProbeMode = mode;
    // 更新模式选择器 active 样式
    document.querySelectorAll('.cg-probe-mode-option').forEach(el => el.classList.remove('active'));
    const activeOpt = document.getElementById(`cgProbeModeOpt_${mode}`);
    if (activeOpt) activeOpt.classList.add('active');
    const probeParams = document.getElementById('cgProbeParams');
    const probeTypeRow = document.getElementById('cgProbeTypeRow');
    const modeDesc = document.getElementById('cgProbeModeDesc');
    const modeHint = document.getElementById('cgProbeModeHint');
    if (mode === 'z_endstop_only') {
        if (probeParams) probeParams.style.display = 'none';
        if (probeTypeRow) probeTypeRow.style.display = 'none';
        if (modeDesc) modeDesc.textContent = 'Z轴将使用物理限位开关归位，不生成调平传感器配置。';
        if (modeHint) modeHint.textContent = 'bed_mesh/调平功能将不可用';
    } else if (mode === 'z_endstop_plus_probe') {
        if (probeParams) probeParams.style.display = '';
        if (probeTypeRow) probeTypeRow.style.display = '';
        if (modeDesc) modeDesc.textContent = 'Z轴使用物理限位归位，调平传感器仅用于网床校准(BED_MESH_CALIBRATE)和螺丝调平(SCREWS_TILT_CALCULATE)。';
        if (modeHint) modeHint.textContent = 'Z轴endstop_pin指向物理限位引脚';
    } else if (mode === 'probe_as_z') {
        if (probeParams) probeParams.style.display = '';
        if (probeTypeRow) probeTypeRow.style.display = '';
        if (modeDesc) modeDesc.textContent = 'Z轴使用probe:z_virtual_endstop虚拟限位，调平传感器同时负责Z归位+网床校准+调平。';
        if (modeHint) modeHint.textContent = 'Z轴endstop_pin=probe:z_virtual_endstop，建议启用safe_z_home';
    }
    // 同步Z物理限位可见性
    syncZEndstopVisibility();
    // 同步 bed_mesh 启用状态
    syncBedMeshByMode();
    syncSafeZHomeByProbeMode();
    renderProbeCheckPanel();
    renderToolboardConflictPanel();
}
function onProbeTypeChange() {
    const pt = document.getElementById('cgProbeType')?.value;
    const p = PROBE_PRESETS[pt];
    // 更新 z_offset 默认值
    if (p && p.z_offset != null) { const z = document.getElementById('cgZOffset'); if (z) z.value = p.z_offset; }
    // BL-Touch servo 区域
    const servoRow = document.getElementById('cgProbeServoRow');
    if (servoRow) servoRow.style.display = (pt === 'bltouch') ? '' : 'none';
    renderProbeCheckPanel();
    renderToolboardConflictPanel();
}
function onProbeSourceChange() {
    _currentProbeSource = document.getElementById('cgProbeSource')?.value || 'main';
    renderProbeConfig();
    renderToolboardConflictPanel();
}
function syncZEndstopVisibility() {
    // 模式C(probe_as_z)时隐藏Z轴物理限位引脚行
    const zRow = document.getElementById('cgEndstopPhysical_Z');
    if (zRow) zRow.style.display = (_currentProbeMode === 'probe_as_z') ? 'none' : '';
    if (_currentProbeMode === 'probe_as_z') {
        const zDiag = document.getElementById('cgEndstopDiag_Z');
        if (zDiag) zDiag.checked = false;
    }
    renderToolboardConflictPanel();
}
function syncBedMeshByMode() {
    const cb = document.getElementById('cgOptBedMesh');
    if (!cb) return;
    if (_currentProbeMode === 'z_endstop_only') {
        cb.checked = false;
        cb.disabled = true;
    } else {
        cb.disabled = false;
        cb.checked = true;
    }
    toggleOptPanel('BedMesh');
}
function syncSafeZHomeByProbeMode() {
    const cb = document.getElementById('cgOptSafeZHome');
    const panel = document.getElementById('cgSafeZParams');
    if (!cb) return;
    if (_currentProbeMode === 'probe_as_z') cb.checked = true;
    if (panel) panel.style.display = cb.checked ? 'block' : 'none';
}

function validateProbeSetup() {
    const errors = [];
    const warnings = [];
    const mode = _currentProbeMode;
    const probeType = document.getElementById('cgProbeType')?.value || 'bltouch';
    const probePreset = PROBE_PRESETS[probeType];
    const pinState = getProbePinState();
    const xOff = cgParseNumber(document.getElementById('cgProbeXOffset')?.value, 0);
    const yOff = cgParseNumber(document.getElementById('cgProbeYOffset')?.value, 0);
    const zOffsetRaw = document.getElementById('cgZOffset')?.value;
    const xBounds = cgAxisBounds('X');
    const yBounds = cgAxisBounds('Y');

    if (mode === 'z_endstop_only') {
        if (document.getElementById('cgOptBedMesh')?.checked) {
            errors.push('仅 Z 物理限位模式不能启用 bed_mesh，请切换探针模式或关闭 bed_mesh。');
        }
        if (document.getElementById('cgOptScrewsTilt')?.checked) {
            errors.push('仅 Z 物理限位模式不能启用 screws_tilt_adjust，请切换探针模式或关闭螺丝调平。');
        }
        if (document.getElementById('cgOptZTilt')?.checked) {
            errors.push('仅 Z 物理限位模式不能启用 z_tilt，请切换探针模式或关闭多 Z 自动调平。');
        }
        return {ok: !errors.length, errors, warnings};
    }

    if (!probePreset) errors.push('未选择有效的探针类型。');
    if (!pinState.source) errors.push('未找到可用的探针来源，请检查主板或工具板是否有 probe/servo 引脚。');
    if (!pinState.sensorPin) errors.push('未选择探针 sensor_pin。');
    if (probePreset?.needs_servo && !pinState.controlPin) errors.push('BLTouch 需要 control_pin，请选择带 servo/control 引脚的来源。');
    if (zOffsetRaw === '' || zOffsetRaw == null) warnings.push('z_offset 需要后续通过 PROBE_CALIBRATE 校准。');
    if (mode === 'probe_as_z' && !document.getElementById('cgOptSafeZHome')?.checked) {
        errors.push('探针替代 Z 限位时必须启用 safe_z_home。');
    }
    if (!document.getElementById('cgOptBedMesh')?.checked &&
        !document.getElementById('cgOptScrewsTilt')?.checked &&
        !document.getElementById('cgOptZTilt')?.checked) {
        warnings.push('已启用探针，但未启用 bed_mesh、screws_tilt_adjust 或 z_tilt。');
    }

    const checkNozzlePoint = (point, label) => {
        if (!point) {
            errors.push(`${label} 坐标格式应为 x,y。`);
            return;
        }
        const nozzle = {x: point.x - xOff, y: point.y - yOff};
        if (!cgInRange(nozzle.x, xBounds) || !cgInRange(nozzle.y, yBounds)) {
            errors.push(`${label} 加上探针偏移后需要喷嘴移动到 ${nozzle.x.toFixed(1)},${nozzle.y.toFixed(1)}，超出 X/Y 行程。`);
        }
    };

    if (document.getElementById('cgOptBedMesh')?.checked) {
        const meshMin = cgParsePoint(document.getElementById('cgBMMeshMin')?.value);
        const meshMax = cgParsePoint(document.getElementById('cgBMMeshMax')?.value);
        checkNozzlePoint(meshMin, 'mesh_min');
        checkNozzlePoint(meshMax, 'mesh_max');
        const probeCount = String(document.getElementById('cgBMProbeCount')?.value || '').split(',').map(v => parseInt(v.trim(), 10));
        if (probeCount.length < 2 || probeCount.some(v => !Number.isFinite(v) || v < 2)) {
            warnings.push('probe_count 建议使用 x,y 格式且每个方向至少 2 个点。');
        }
    }

    if (document.getElementById('cgOptScrewsTilt')?.checked) {
        ['cgSTScrew1', 'cgSTScrew2', 'cgSTScrew3', 'cgSTScrew4'].forEach((id, idx) => {
            const raw = document.getElementById(id)?.value || '';
            if (raw.trim()) checkNozzlePoint(cgParsePoint(raw), `screw${idx + 1}`);
        });
    }

    if (document.getElementById('cgOptZTilt')?.checked) {
        const zTiltPoints = cgParsePointList([
            document.getElementById('cgZTZPos')?.value || '',
            document.getElementById('cgZTZPos2')?.value || '',
        ]);
        if (zTiltPoints.length < 2) {
            errors.push('z_tilt 至少需要两个有效 points 坐标。');
        }
        zTiltPoints.forEach((point, idx) => checkNozzlePoint(point, `z_tilt point ${idx + 1}`));
    }

    if (document.getElementById('cgOptSafeZHome')?.checked) {
        const homePoint = cgParsePoint(`${document.getElementById('cgHomePosX')?.value || ''},${document.getElementById('cgHomePosY')?.value || ''}`);
        if (!homePoint) {
            errors.push('safe_z_home 坐标格式无效。');
        } else {
            if (!cgInRange(homePoint.x, xBounds) || !cgInRange(homePoint.y, yBounds)) {
                errors.push('safe_z_home 的喷嘴坐标超出 X/Y 行程。');
            }
            const probeContact = {x: homePoint.x + xOff, y: homePoint.y + yOff};
            if (!cgInRange(probeContact.x, xBounds) || !cgInRange(probeContact.y, yBounds)) {
                errors.push(`safe_z_home 触发时探针位置为 ${probeContact.x.toFixed(1)},${probeContact.y.toFixed(1)}，超出热床/行程范围。`);
            }
        }
    }

    return {ok: !errors.length, errors, warnings};
}

function renderProbeCheckPanel() {
    const panel = document.getElementById('cgProbeCheckPanel');
    if (!panel) return;
    const result = validateProbeSetup();
    const items = [];
    result.errors.forEach(msg => items.push(`<li class="error">${msg}</li>`));
    result.warnings.forEach(msg => items.push(`<li class="warn">${msg}</li>`));
    if (!items.length) {
        panel.className = 'cg-probe-check ok';
        panel.innerHTML = '<i class="fas fa-check-circle"></i> 探针配置检查通过';
        return;
    }
    panel.className = result.errors.length ? 'cg-probe-check error' : 'cg-probe-check warn';
    panel.innerHTML = `<strong>${result.errors.length ? '需要处理' : '建议确认'}</strong><ul>${items.join('')}</ul>`;
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
        if (!_toolboardData[i]) _toolboardData[i] = {boardId:'',name:`toolhead${i||''}`,role:'custom',connType:'can',serial:'',mapping:null,boardInfo:null,axes:[],funcAssigns:{}};
        if (!_toolboardData[i].role) _toolboardData[i].role = 'custom';
        const tb=_toolboardData[i], div=document.createElement('div');
        div.className='cg-tb-block';
        div.innerHTML = `<div class="cg-tb-header" onclick="toggleToolboardPanel(${i})"><span><i class="fas fa-microchip"></i> 工具板 ${i+1}: <strong id="cgTBTitle${i}">${cgEscapeHtml(tb.name)}</strong></span><span class="cg-tb-toggle"><i class="fas fa-chevron-down"></i></span></div>
        <div id="cgTBPanel${i}" class="cg-tb-panel" style="display:none;">
            <div class="cg-row"><label>MCU 名称：</label><input type="text" id="cgTBName${i}" value="${cgEscapeHtml(tb.name)}" style="width:120px;" oninput="_toolboardData[${i}].name=this.value;document.getElementById('cgTBTitle${i}').textContent=this.value;renderToolboardConflictPanel();renderProbeConfig();renderEndstopConfig();renderHeaterConfig();renderFanConfig();">
            <span class="cg-hint">用途在轴分配、限位/探针、温控/风扇等选项卡中选择</span></div>
            <div class="cg-row" style="margin-top:8px;"><label>型号：</label><select id="cgTBBoard${i}" onchange="onToolBoardSelect(${i})" style="min-width:220px;"><option value="">选择工具板型号</option></select><span id="cgTBInfo${i}" class="cg-hint"></span></div>
            <div class="cg-row" style="margin-top:8px;"><label>连接：</label><select id="cgTBConn${i}" onchange="_toolboardData[${i}].connType=this.value;renderToolboardConflictPanel();"><option value="can">CAN</option><option value="usb">USB</option><option value="serial">串口</option></select>
            <label>地址：</label><input type="text" id="cgTBSerial${i}" placeholder="canbus_uuid 或 /dev/serial/by-id/..." style="flex:1;min-width:220px;" value="${cgEscapeHtml(tb.serial)}" oninput="_toolboardData[${i}].serial=this.value;renderToolboardConflictPanel();"></div>
            <div id="cgTBConflict${i}" class="cg-toolboard-mini" style="margin-top:8px;"></div></div>`;
        inner.appendChild(div);
        const cs=document.getElementById(`cgTBConn${i}`); if(cs) cs.value=tb.connType;
    }
    // 填充工具板型号
    const bd = _boardsIndex[brand]; if(bd) { for(const[bid,info]of Object.entries(bd.toolboards)) { for(let i=0;i<count;i++){const o=document.getElementById(`cgTBBoard${i}`);if(o)o.innerHTML+=`<option value="${cgEscapeHtml(bid)}">${cgEscapeHtml(info.name)} (${cgEscapeHtml(info.mcu)})</option>`;} } }
    _toolboardData.forEach((tb,i)=>{if(tb.boardId){const s=document.getElementById(`cgTBBoard${i}`);if(s)s.value=tb.boardId;}});
    renderToolboardConflictPanel();
    if (_currentMapping) { renderDriverAssignment(); renderEndstopConfig(); renderProbeConfig(); renderHeaterConfig(); renderFanConfig(); }
}
function toggleToolboardPanel(i) { const p=document.getElementById(`cgTBPanel${i}`); if(p) p.style.display=p.style.display==='none'?'block':'none'; }
async function onToolBoardSelect(i) {
    const boardId=document.getElementById(`cgTBBoard${i}`).value;
    _toolboardData[i].boardId=boardId;
    const info=document.getElementById(`cgTBInfo${i}`);
    if(!boardId){_toolboardData[i].mapping=null;renderToolboardConflictPanel();if(_currentMapping){renderDriverAssignment();renderEndstopConfig();renderProbeConfig();renderHeaterConfig();renderFanConfig();}return;}
    try {
        const r=await fetch(`/api/tools/boards/${encodeURIComponent(boardId)}/mapping`), d=await r.json();
        if(!d.success){cgShowToast(d.error,'error');return;}
        _toolboardData[i].mapping=d.mapping; _toolboardData[i].boardInfo=d.board_info;
        const bi=d.board_info; info.textContent=`${bi.drive_count}驱动, ${bi.heat_count}加热, ${bi.fan_count}风扇`;
        const cs=document.getElementById(`cgTBConn${i}`);
        if(cs&&bi.connections){cs.innerHTML='';bi.connections.forEach(c=>{const v=c.includes('CAN')?'can':c.includes('USB')?'usb':'serial';cs.innerHTML+=`<option value="${cgEscapeHtml(v)}">${cgEscapeHtml(c)}</option>`;});cs.value=_toolboardData[i].connType;}
        const defaultedExtruder = cgApplyToolboardExtruderDefaults(i);
        renderToolboardConflictPanel();
        if (_currentMapping) {
            renderDriverAssignment(); renderEndstopConfig(); renderProbeConfig(); renderHeaterConfig(); renderFanConfig();
            if (defaultedExtruder) {
                cgClearMainAxisIfToolboardOwns('E');
                cgApplyToolboardExtruderPinDefaults(i);
                validateAxisAssignment();
            }
        }
    } catch(e){cgShowToast('加载工具板失败: '+e.message,'error');}
}
function renderToolboardDrivers(i) {
    const c=document.getElementById(`cgTBDriverContainer${i}`), m=_toolboardData[i].mapping; if(!m){c.innerHTML='';return;}
    const drives=[]; for(let j=0;j<10;j++){if(m[`Drives${j}`])drives.push({key:`Drives${j}`,...m[`Drives${j}`]});else break;}
    if(!drives.length){c.innerHTML='';return;}
    let h='<h4 class="cg-section-title"><i class="fas fa-server"></i> 工具板驱动器分配</h4><div class="cg-drive-table"><table><thead><tr><th>驱动器</th><th>STEP</th><th>DIR</th><th>EN</th><th>分配轴</th></tr></thead><tbody>';
    drives.forEach((d,j)=>{const cur=(_toolboardData[i].axes||[])[j]||'';let o='<option value="">不使用</option>';ALL_AXES.forEach(a=>o+=`<option value="${a}"${a===cur?' selected':''}>${a}</option>`);h+=`<tr><td><strong>${cgToolIfaceName(d.key)}</strong><br><small class="cg-pin-sub">${d.key}</small></td><td class="cg-pin">${d.step_pin}</td><td class="cg-pin">${d.dir_pin}</td><td class="cg-pin">${d.enable_pin}</td><td><select id="cgTBAxis_${i}_${j}" class="cg-axis-sel" onchange="onTBAxisChg(${i})">${o}</select></td></tr>`;});
    h+='</tbody></table></div>'; c.innerHTML=h;
}
function onTBAxisChg(i){const m=_toolboardData[i].mapping;if(!m)return;_toolboardData[i].role='custom';const roleSel=document.getElementById(`cgTBRole${i}`);if(roleSel)roleSel.value='custom';const d=[];for(let j=0;j<10;j++){if(m[`Drives${j}`])d.push(m[`Drives${j}`]);else break;}_toolboardData[i].axes=d.map((_,j)=>document.getElementById(`cgTBAxis_${i}_${j}`)?.value||'');_toolboardData[i].axes.filter(Boolean).forEach(axis=>cgClearMainAxisIfToolboardOwns(axis));validateAxisAssignment();renderToolboardConflictPanel();}
function renderToolboardFunctions(i) {
    const c=document.getElementById(`cgTBFuncContainer${i}`), m=_toolboardData[i].mapping; if(!m){c.innerHTML='';return;}
    const heats=[],temps=[],fans=[],stops=[],accels=[],fa=_toolboardData[i].funcAssigns||{};
    for(let j=0;j<10;j++){const k=`heat${j}`;if(m[k]!=null)heats.push({key:k,pin:m[k]});} if(m['BED_OUT'])heats.push({key:'BED_OUT',pin:m['BED_OUT']}); if(m['bed-heat'])heats.push({key:'bed-heat',pin:m['bed-heat']});
    for(let j=0;j<10;j++){const k=`temp${j}`;if(m[k]!=null)temps.push({key:k,pin:m[k]});} if(m['temp_bed'])temps.push({key:'temp_bed',pin:m['temp_bed']}); if(m['bed-temp'])temps.push({key:'bed-temp',pin:m['bed-temp']});
    for(let j=0;j<20;j++){const k=`fan${j}`;if(m[k]!=null)fans.push({key:k,pin:m[k]});}
    for(let j=0;j<20;j++){const k=`stop${j}`;if(m[k]!=null)stops.push({key:k,pin:m[k]});}
    if(m.probe!=null) stops.unshift({key:'probe',pin:m.probe});
    ['adxl','adxl345','adxl_cs','lis2dw'].forEach(k=>{if(m[k]!=null)accels.push({key:k,pin:m[k]});});
    let h='';
    const mkFuncSel=(key,cur,opts)=>`<select id="cgTBFunc_${i}_${key}" onchange="onToolboardFuncChange(${i},${JSON.stringify(key)},this.value)">${opts.map(([v,l])=>`<option value="${v}"${v===cur?' selected':''}>${l}</option>`).join('')}</select>`;
    if(heats.length){h+='<h4 class="cg-section-title"><i class="fas fa-fire"></i> 加热器</h4><div class="cg-func-grid">';heats.forEach(x=>{const cur=fa[x.key]||'';h+=`<div class="cg-func-item"><label>${cgToolPinLabel(x.key,x.pin)}</label>${mkFuncSel(x.key,cur,[['','不使用'],['extruder','挤出机加热'],['heater_bed','热床加热']])}</div>`;});h+='</div>';}
    if(temps.length){h+='<h4 class="cg-section-title"><i class="fas fa-thermometer-half"></i> 热敏</h4><div class="cg-func-grid">';temps.forEach(x=>{const cur=fa[x.key]||'';h+=`<div class="cg-func-item"><label>${cgToolPinLabel(x.key,x.pin)}</label>${mkFuncSel(x.key,cur,[['','不使用'],['extruder','挤出机热敏'],['heater_bed','热床热敏']])}</div>`;});h+='</div>';}
    if(fans.length){h+='<h4 class="cg-section-title"><i class="fas fa-fan"></i> 风扇</h4><div class="cg-func-grid">';fans.forEach(x=>{const cur=fa[x.key]||'';h+=`<div class="cg-func-item"><label>${cgToolPinLabel(x.key,x.pin)}</label>${mkFuncSel(x.key,cur,[['','不使用'],['part_fan','模型风扇'],['throat_fan','喉管风扇'],['controller_fan','控制器风扇'],['exhaust_fan','排风扇']])}</div>`;});h+='</div>';}
    if(stops.length){h+='<h4 class="cg-section-title"><i class="fas fa-hand-paper"></i> 限位/探针</h4><div class="cg-func-grid">';stops.forEach(x=>{const curObj=(fa[x.key]&&typeof fa[x.key]==='object')?fa[x.key]:{},curA=curObj.axis||'',curNc=curObj.ncno||'NC';h+=`<div class="cg-func-item"><label>${cgToolPinLabel(x.key,x.pin)}</label><div style="display:flex;gap:6px;"><select id="cgTBFuncStop_${i}_${x.key}" style="flex:1;" onchange="onToolboardStopFuncChange(${i},${JSON.stringify(x.key)},this.value)"><option value="">不使用</option><option value="probe"${curA==='probe'?' selected':''}>探针</option><option value="x"${curA==='x'?' selected':''}>X限位</option><option value="y"${curA==='y'?' selected':''}>Y限位</option><option value="z"${curA==='z'?' selected':''}>Z限位</option></select><select id="cgTBNCNO_${i}_${x.key}" style="width:78px;" onchange="onToolboardStopNcnoChange(${i},${JSON.stringify(x.key)},this.value)"><option value="NC"${curNc==='NC'?' selected':''}>常闭NC</option><option value="NO"${curNc==='NO'?' selected':''}>常开NO</option></select></div></div>`;});h+='</div>';}
    if(accels.length){const checked=fa.__adxl==='adxl';h+='<h4 class="cg-section-title"><i class="fas fa-wave-square"></i> 加速度计/扩展</h4><div class="cg-func-grid">';accels.forEach(x=>{h+=`<div class="cg-func-item"><label>${cgToolPinLabel(x.key,x.pin)}</label><label class="cg-inline-check"><input type="checkbox" ${checked?'checked':''} onchange="onToolboardFuncChange(${i},'__adxl',this.checked?'adxl':'')"> 接管 ADXL/共振测试</label></div>`;});h+='</div>';}
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
    h+='<div class="cg-drive-table"><table style="table-layout:fixed;width:100%;"><colgroup><col style="width:11%;"><col style="width:40%;"><col style="width:17%;"><col style="width:12%;"><col style="width:20%;"></colgroup><thead><tr><th>分配轴</th><th>驱动器引脚</th><th>驱动类型</th><th>电流(A)</th><th><span id="cgTmcSRHeader">采样电阻/Rref</span></th></tr></thead><tbody>';
    drives.forEach((d,i)=>{
        const presetDrive=presetDrives[i];const presetAxis=presetDrive?presetDrive.axis:'';const def=cgIsAxisOnToolboard(presetAxis)?'':presetAxis;
        let o='<option value="">不使用</option>';ALL_AXES.forEach(a=>o+=`<option value="${a}"${a===def?' selected':''}>${a}</option>`);
        const pins=[`STEP=${d.step_pin||'-'}`,`DIR=${d.dir_pin||'-'}`,`EN=${d.enable_pin||'-'}`];
        if(d.uart_pin)pins.push(`UART=${d.uart_pin}`);
        const tmcDef=presetDrive?.stepper_driver||'tmc2209';
        const curDef=presetDrive?.run_current||0.8;
        // 采样电阻/Rref 默认值：TMC2240用rref，TMC5160=0.075，TMC2209=0.110，其他留空
        const srDef = presetDrive?.sense_resistor ?? presetDrive?.rref ?? (tmcDef==='tmc2240' ? '12300' : (tmcDef==='tmc5160' ? '0.075' : (tmcDef==='tmc2209' ? '0.110' : '')));
        const tmcOps=[['tmc2209','TMC2209'],['tmc5160','TMC5160'],['tmc2240','TMC2240'],['tmc2130','TMC2130'],['tmc2208','TMC2208'],['tmc2660','TMC2660'],['a4988','A4988'],['external','外置驱动'],['yanggong','杨工驱动']]
            .map(([v,l])=>`<option value="${v}"${tmcDef===v?' selected':''}>${l}</option>`).join('');
        h+=`<tr><td><select id="cgAxis_${i}" class="cg-axis-sel" onchange="validateAxisAssignment()">${o}</select></td><td><strong>${d.key}</strong><br><span style="font-size:11px;color:var(--text-secondary);">${pins.join(', ')}</span></td><td><select id="cgTmcModel_${i}" onchange="onTmcModelChg(${i})" style="width:100%;font-size:12px;padding:4px;">${tmcOps}</select></td><td><input type="number" step="0.1" id="cgTmcCurrent_${i}" value="${curDef}" style="width:100%;font-size:12px;padding:4px 6px;border:1px solid var(--border-color);border-radius:4px;background:var(--card-bg);"></td><td><input type="text" id="cgTmcSR_${i}" value="${srDef}" style="width:100%;font-size:12px;padding:4px 6px;border:1px solid var(--border-color);border-radius:4px;background:var(--card-bg);"><small id="cgTmcSRLabel_${i}" style="font-size:10px;color:var(--text-secondary);display:block;text-align:center;">${tmcDef==='tmc2240'?'rref':'sense_resistor'}</small></td></tr>`;
    });
    h+='</tbody></table></div>';
    _toolboardData.forEach((tb, tbIndex) => {
        if (!tb?.mapping) return;
        const drives = [];
        for (let j=0; j<10; j++) {
            const key = `Drives${j}`;
            if (tb.mapping[key]) drives.push({key, ...tb.mapping[key]});
            else break;
        }
        if (!drives.length) return;
        const tbName = cgSafeConfigName(tb.name || `TB${tbIndex}`, `TB${tbIndex}`);
        h += `<h4 class="cg-section-title"><i class="fas fa-microchip"></i> 工具板 ${tbIndex + 1}: ${cgEscapeHtml(tbName)} 驱动器分配</h4>`;
        h += '<div class="cg-drive-table"><table style="table-layout:fixed;width:100%;"><colgroup><col style="width:13%;"><col style="width:39%;"><col style="width:18%;"><col style="width:12%;"><col style="width:18%;"></colgroup><thead><tr><th>分配轴</th><th>驱动器接口</th><th>驱动类型</th><th>电流(A)</th><th>采样电阻/Rref</th></tr></thead><tbody>';
        drives.forEach((d,j)=>{
            const cur = (tb.axes || [])[j] || '';
            let opts = '<option value="">不使用</option>';
            ALL_AXES.forEach(a => opts += `<option value="${a}"${a===cur?' selected':''}>${a}</option>`);
            const pins = [`STEP=${d.step_pin||'-'}`, `DIR=${d.dir_pin||'-'}`, `EN=${d.enable_pin||'-'}`];
            if (d.uart_pin) pins.push(`UART=${d.uart_pin}`);
            const tmcDef = document.getElementById(`cgTBTmcModel_${tbIndex}_${j}`)?.value || 'tmc2209';
            const curDef = document.getElementById(`cgTBTmcCurrent_${tbIndex}_${j}`)?.value || '0.8';
            const srDef = document.getElementById(`cgTBTmcSR_${tbIndex}_${j}`)?.value || (tmcDef==='tmc2240' ? '12300' : (tmcDef==='tmc5160' ? '0.075' : (tmcDef==='tmc2209' ? '0.110' : '')));
            const tmcOps=[['tmc2209','TMC2209'],['tmc5160','TMC5160'],['tmc2240','TMC2240'],['tmc2130','TMC2130'],['tmc2208','TMC2208'],['tmc2660','TMC2660'],['a4988','A4988'],['external','外置驱动']]
                .map(([v,l])=>`<option value="${v}"${tmcDef===v?' selected':''}>${l}</option>`).join('');
            h += `<tr><td><select id="cgTBAxis_${tbIndex}_${j}" class="cg-axis-sel" onchange="onTBAxisChg(${tbIndex})">${opts}</select></td><td><strong>${cgToolIfaceName(d.key)}</strong><br><span style="font-size:11px;color:var(--text-secondary);">${pins.join(', ')}</span></td><td><select id="cgTBTmcModel_${tbIndex}_${j}" onchange="onTBTmcModelChg(${tbIndex},${j})" style="width:100%;font-size:12px;padding:4px;">${tmcOps}</select></td><td><input type="number" step="0.1" id="cgTBTmcCurrent_${tbIndex}_${j}" value="${curDef}" style="width:100%;font-size:12px;padding:4px 6px;border:1px solid var(--border-color);border-radius:4px;background:var(--card-bg);"></td><td><input type="text" id="cgTBTmcSR_${tbIndex}_${j}" value="${srDef}" style="width:100%;font-size:12px;padding:4px 6px;border:1px solid var(--border-color);border-radius:4px;background:var(--card-bg);"><small id="cgTBTmcSRLabel_${tbIndex}_${j}" style="font-size:10px;color:var(--text-secondary);display:block;text-align:center;">${tmcDef==='tmc2240'?'rref':'sense_resistor'}</small></td></tr>`;
        });
        h += '</tbody></table></div>';
    });
    h+='<div id="cgAxisWarn" class="cg-warn" style="display:none;"></div>';
    c.innerHTML=h;
}
function validateAxisAssignment() {
    const w=document.getElementById('cgAxisWarn'); if(!w) return true;
    const assigned={}; let dup=false;
    document.querySelectorAll('[id^="cgAxis_"],[id^="cgTBAxis_"]').forEach(s=>{const a=s.value;if(!a){s.style.borderColor='';return;}if(assigned[a]){dup=true;s.style.borderColor='var(--danger-color,#e53935)';assigned[a].style.borderColor='var(--danger-color,#e53935)';}else{assigned[a]=s;s.style.borderColor='';}});
    if(dup){w.style.display='block';w.innerHTML='<i class="fas fa-exclamation-triangle"></i> 主板/工具板存在重复轴分配，请修正后再生成';w.style.color='var(--danger-color,#e53935)';}else w.style.display='none';
    renderToolboardConflictPanel();
    return !dup;
}

// ========== Tab 3: 运动参数 ==========
let _motionManualOverride = {};  // 手动覆盖标记: {"X:rd":true,"Y:ms":true,...}
let _homingManualOverride = {};  // 归位方向手动覆盖标记: {"X":true,"Y":true,...}
let _homingOriginLocked = false; // 原点全局锁定标记
function resetMotionOverrides() { _motionManualOverride = {}; _homingManualOverride = {}; _homingOriginLocked = false; }
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
    const prevExtHeat=document.getElementById('cgHeatPin_extruder')?.value||'';
    const prevExtTemp=document.getElementById('cgTempPin_extruder')?.value||'';
    const prevBedHeat=document.getElementById('cgHeatPin_heater_bed')?.value||'';
    const prevBedTemp=document.getElementById('cgTempPin_heater_bed')?.value||'';
    const heatOptsExt=cgPinOptionsHtml('heat', prevExtHeat);
    const tempOptsExt=cgPinOptionsHtml('temp', prevExtTemp);
    const heatOptsBed=cgPinOptionsHtml('heat', prevBedHeat);
    const tempOptsBed=cgPinOptionsHtml('temp', prevBedTemp);
    let h='';
    // 挤出机加热
    h+='<div class="cg-heater-card"><h4><i class="fas fa-fire"></i> 挤出机 (extruder)</h4>';
    h+='<div class="cg-func-grid">';
    h+=`<div class="cg-func-item"><label>加热引脚：</label><select id="cgHeatPin_extruder" onchange="renderToolboardConflictPanel()">${heatOptsExt}</select></div>`;
    h+=`<div class="cg-func-item"><label>热敏引脚：</label><select id="cgTempPin_extruder" onchange="renderToolboardConflictPanel()">${tempOptsExt}</select></div>`;
    h+='</div></div>';
    // 热床加热
    h+='<div class="cg-heater-card"><h4><i class="fas fa-bed"></i> 热床 (heater_bed)</h4>';
    h+='<div class="cg-func-grid">';
    h+=`<div class="cg-func-item"><label>加热引脚：</label><select id="cgHeatPin_heater_bed" onchange="renderToolboardConflictPanel()">${heatOptsBed}</select></div>`;
    h+=`<div class="cg-func-item"><label>热敏引脚：</label><select id="cgTempPin_heater_bed" onchange="renderToolboardConflictPanel()">${tempOptsBed}</select></div>`;
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
    if(extHeat&&heats.length>0&&!extHeat.value) extHeat.value=cgPinRefMain(heats[0]);
    if(extTemp&&temps.length>0&&!extTemp.value) extTemp.value=cgPinRefMain(temps[0]);
    // 热床用第二个 heat/temp 引脚（如有独立热床引脚）
    const bedHeat=document.getElementById('cgHeatPin_heater_bed');
    const bedTemp=document.getElementById('cgTempPin_heater_bed');
    const bedHeatKey=heats.find(k=>k.includes('bed')||k.includes('BED'))||heats[1]||'\n';
    const bedTempKey=temps.find(k=>k.includes('bed')||k.includes('BED'))||temps[1]||'\n';
    if(bedHeat&&bedHeatKey&&!bedHeat.value) bedHeat.value=cgPinRefMain(bedHeatKey);
    if(bedTemp&&bedTempKey&&!bedTemp.value) bedTemp.value=cgPinRefMain(bedTempKey);
}
function addExtraHeater() {
    _extraHeaterCount++;
    const container=document.getElementById('cgExtraHeaters'); if(!container) return;
    if(!_currentMapping) return;
    const heatOpts=cgPinOptionsHtml('heat');
    const tempOpts=cgPinOptionsHtml('temp');
    const idx=_extraHeaterCount;
    let h=`<div class="cg-heater-card" id="cgExtraHeater_${idx}"><h4><i class="fas fa-plus-circle"></i> 额外加热器 ${idx} <button class="cg-heater-remove" onclick="removeExtraHeater(${idx})">✕ 移除</button></h4>`;
    h+='<div class="cg-func-grid">';
    // 段类型
    h+=`<div class="cg-func-item"><label>段类型：</label><select id="cgExtraSection_${idx}" onchange="onExtraSectionChange(${idx})"><option value="heater_generic" selected>heater_generic（加热）</option><option value="temperature_sensor">temperature_sensor（仅测温）</option></select></div>`;
    h+=`<div class="cg-func-item"><label>名称：</label><input type="text" id="cgExtraName_${idx}" value="extra_heater_${idx}" style="width:100%;"></div>`;
    h+=`<div class="cg-func-item"><label>加热引脚：</label><select id="cgExtraHeatPin_${idx}" onchange="renderToolboardConflictPanel()">${heatOpts}</select></div>`;
    h+=`<div class="cg-func-item"><label>热敏引脚：</label><select id="cgExtraTempPin_${idx}" onchange="renderToolboardConflictPanel()">${tempOpts}</select></div>`;
    h+=`<div class="cg-func-item"><label>传感器类型：</label><select id="cgExtraST_${idx}">${SENSOR_TYPES.map(s=>`<option>${cgEscapeHtml(s)}</option>`).join('')}</select><br><small style="color:#e65100;font-size:11px;">⚠️ PT100 需要 MAX31865 放大器，PT1000 建议搭配放大器使用</small></div>`;
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
    renderToolboardConflictPanel();
}
function removeExtraHeater(idx) {
    const el=document.getElementById(`cgExtraHeater_${idx}`); if(el) el.remove();
}

// ========== Tab 4: 风扇 ==========
function renderFanConfig() {
    const c=document.getElementById('cgFanContainer'); if(!c||!_currentMapping) return;
    const fans=cgCollectPinOptions('fan');
    const prevPart=document.getElementById('cgFanPin_part_fan')?.value||'';
    const prevThroat=document.getElementById('cgFanPin_throat_fan')?.value||'';
    const prevDriver=document.getElementById('cgFanPin_driver_fan')?.value||'';
    const prevController=document.getElementById('cgFanPin_controller_fan')?.value||'';
    const prevExhaust=document.getElementById('cgFanPin_exhaust_fan')?.value||'';
    const prevFilament=document.getElementById('cgFilamentSensorPin')?.value||'';
    const prevFilamentName=document.getElementById('cgFilamentSensorName')?.value||'filament_sensor';
    const prevFilamentMode=document.getElementById('cgFilamentSensorMode')?.value||'switch';
    const prevFilamentNCNO=document.getElementById('cgFilamentSensorNCNO')?.value||'NC';
    const prevFilamentLen=document.getElementById('cgFilamentDetectionLength')?.value||'7.0';
    const prevFilamentExtruder=document.getElementById('cgFilamentExtruder')?.value||'extruder';
    const prevFilamentPause=document.getElementById('cgFilamentPauseOnRunout')?.value||'True';
    const prevFilamentPullup=document.getElementById('cgFilamentPullup')?.checked ?? true;
    const prevFilamentEventDelay=document.getElementById('cgFilamentEventDelay')?.value||'3.0';
    const prevFilamentPauseDelay=document.getElementById('cgFilamentPauseDelay')?.value||'0.5';
    const prevFilamentRunoutGcode=document.getElementById('cgFilamentRunoutGcode')?.value||'PAUSE';
    const prevFilamentInsertGcode=document.getElementById('cgFilamentInsertGcode')?.value||'';
    let h='<div class="cg-func-grid">';
    h+=`<div class="cg-func-item"><label>模型冷却风扇：</label><select id="cgFanPin_part_fan" onchange="renderToolboardConflictPanel()">${cgPinOptionsHtml('fan', prevPart)}</select></div>`;
    h+=`<div class="cg-func-item"><label>喉管风扇：</label><select id="cgFanPin_throat_fan" onchange="renderToolboardConflictPanel()">${cgPinOptionsHtml('fan', prevThroat)}</select></div>`;
    h+=`<div class="cg-func-item"><label>控制器/驱动风扇：</label><select id="cgFanPin_driver_fan" onchange="renderToolboardConflictPanel()">${cgPinOptionsHtml('fan', prevDriver)}</select></div>`;
    h+=`<div class="cg-func-item"><label>电器仓风扇(heater_bed)：</label><select id="cgFanPin_controller_fan" onchange="renderToolboardConflictPanel()">${cgPinOptionsHtml('fan', prevController)}</select></div>`;
    h+=`<div class="cg-func-item"><label>排风扇：</label><select id="cgFanPin_exhaust_fan" onchange="renderToolboardConflictPanel()">${cgPinOptionsHtml('fan', prevExhaust)}</select></div>`;
    h+='</div>';
    h+='<h4 class="cg-section-title"><i class="fas fa-exclamation-circle"></i> 断料/堵料检测</h4>';
    h+='<div class="cg-func-grid">';
    h+=`<div class="cg-func-item"><label>传感器类型：</label><select id="cgFilamentSensorMode"><option value="switch"${prevFilamentMode==='switch'?' selected':''}>filament_switch_sensor</option><option value="motion"${prevFilamentMode==='motion'?' selected':''}>filament_motion_sensor</option></select></div>`;
    h+=`<div class="cg-func-item"><label>名称：</label><input type="text" id="cgFilamentSensorName" value="${cgEscapeHtml(prevFilamentName)}"></div>`;
    h+=`<div class="cg-func-item"><label>信号引脚：</label><select id="cgFilamentSensorPin" onchange="renderToolboardConflictPanel()">${cgPinOptionsHtml('probe', prevFilament)}</select></div>`;
    h+=`<div class="cg-func-item"><label>触发方式：</label><select id="cgFilamentSensorNCNO"><option value="NC"${prevFilamentNCNO==='NC'?' selected':''}>常闭NC</option><option value="NO"${prevFilamentNCNO==='NO'?' selected':''}>常开NO</option></select></div>`;
    h+=`<div class="cg-func-item"><label>上拉：</label><label class="cg-inline-check"><input type="checkbox" id="cgFilamentPullup"${prevFilamentPullup?' checked':''}> 使用 ^ 上拉</label></div>`;
    h+=`<div class="cg-func-item"><label>pause_on_runout：</label><select id="cgFilamentPauseOnRunout"><option value="True"${prevFilamentPause==='True'?' selected':''}>True</option><option value="False"${prevFilamentPause==='False'?' selected':''}>False</option></select></div>`;
    h+=`<div class="cg-func-item"><label>event_delay：</label><input type="number" step="0.1" id="cgFilamentEventDelay" value="${cgEscapeHtml(prevFilamentEventDelay)}" class="cg-xs"></div>`;
    h+=`<div class="cg-func-item"><label>pause_delay：</label><input type="number" step="0.1" id="cgFilamentPauseDelay" value="${cgEscapeHtml(prevFilamentPauseDelay)}" class="cg-xs"></div>`;
    h+=`<div class="cg-func-item"><label>堵料检测长度：</label><input type="number" step="0.1" id="cgFilamentDetectionLength" value="${cgEscapeHtml(prevFilamentLen)}" class="cg-xs"><small class="cg-hint">仅 motion 模式使用</small></div>`;
    h+=`<div class="cg-func-item"><label>motion 关联挤出机：</label><input type="text" id="cgFilamentExtruder" value="${cgEscapeHtml(prevFilamentExtruder)}"></div>`;
    h+=`<div class="cg-func-item"><label>runout_gcode：</label><input type="text" id="cgFilamentRunoutGcode" value="${cgEscapeHtml(prevFilamentRunoutGcode)}"><small class="cg-hint">多条命令可用 ; 分隔</small></div>`;
    h+=`<div class="cg-func-item"><label>insert_gcode：</label><input type="text" id="cgFilamentInsertGcode" value="${cgEscapeHtml(prevFilamentInsertGcode)}"><small class="cg-hint">可留空</small></div>`;
    h+='</div>';
    c.innerHTML=h;
    // 默认: fan0→模型冷却, fan1→喉管, 其余不使用
    if(fans.length>=1){const el=document.getElementById('cgFanPin_part_fan'); if(el&&!el.value) el.value=fans[0].value;}
    if(fans.length>=2){const el=document.getElementById('cgFanPin_throat_fan'); if(el&&!el.value) el.value=fans[1].value;}
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
// 主板DIAG物理引脚固定（JSON中diag_pin），DIAG0/DIAG1是TMC驱动芯片的通道选择
function getAxisDiagMap() {
    const map = {};
    if (!_currentMapping) return map;
    const DUAL_DIAG_TMC = { 'tmc5160': true, 'tmc2240': true, 'tmc2130': true };
    const DIAG_TMC = { 'tmc2209': '^', 'tmc5160': '^!', 'tmc2240': '^!', 'tmc2130': '^!' };
    document.querySelectorAll('[id^="cgAxis_"]').forEach(sel => {
        const axis = sel.value;
        if (!axis || axis === 'E' || axis === 'E1') return;
        const idx = parseInt(sel.id.replace('cgAxis_', ''));
        const d = _currentMapping[`Drives${idx}`];
        const tmcModel = document.getElementById(`cgTmcModel_${idx}`)?.value;
        if (!d) return;
        const boardDiagPin = d.diag_pin || null;
        const supportsDualDiag = !!(boardDiagPin && DUAL_DIAG_TMC[tmcModel]);
        const info = {
            driver: `Drives${idx}`,
            diag_pin: boardDiagPin,
            idx,
            tmcModel: tmcModel||'unknown',
            hasDiagPin: !!boardDiagPin,
            diagSupported: false,
            noDiagPin: !boardDiagPin,
            supportsDualDiag,
        };
        if (boardDiagPin) {
            if (DIAG_TMC[tmcModel]) {
                info.diagPrefix = DIAG_TMC[tmcModel];
                info.diagSupported = true;
            }
        }
        map[axis] = info;
    });
    return map;
}
// DIAG复选框切换：联动禁用物理限位、控制DIAG模式选择器显隐
function onEndstopDiagChange(axis) {
    const cb = document.getElementById(`cgEndstopDiag_${axis}`);
    const info = document.getElementById(`cgEndstopDiagInfo_${axis}`);
    const modeSel = document.getElementById(`cgEndstopDiagMode_${axis}`);
    const physicalRow = document.getElementById(`cgEndstopPhysical_${axis}`);
    if (cb) {
        if (cb.checked) {
            if (info) info.style.display = '';
            if (modeSel) modeSel.style.display = '';
            cb.closest('.cg-diag-row')?.classList.add('active');
            if (physicalRow) { physicalRow.style.opacity = '0.35'; physicalRow.style.pointerEvents = 'none'; }
        } else {
            if (info) info.style.display = 'none';
            if (modeSel) modeSel.style.display = 'none';
            cb.closest('.cg-diag-row')?.classList.remove('active');
            if (physicalRow) { physicalRow.style.opacity = ''; physicalRow.style.pointerEvents = ''; }
        }
    }
    renderToolboardConflictPanel();
}

// ========== Tab 3: 限位开关 ==========
function renderEndstopConfig() {
    const c = document.getElementById('cgEndstopContainer');
    if (!c || !_currentMapping) return;
    const m = _currentMapping;
    const prevPins = {};
    const prevNcno = {};
    ['X','Y','Z'].forEach(ax => {
        prevPins[ax] = document.getElementById(`cgEndstopPin_${ax}`)?.value || '';
        prevNcno[ax] = document.getElementById(`cgEndstopNCNO_${ax}`)?.value || 'NC';
    });
    // 收集所有限位引脚
    const stops = cgCollectPinOptions('stop');
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
                h += `<div class="cg-diag-row"><label class="cg-diag-check"><input type="checkbox" id="cgEndstopDiag_${ax}" onchange="onEndstopDiagChange('${ax}')"> ${ax}轴使用 DIAG 限位</label>`;
                // 支持双DIAG的驱动（TMC5160/2240/2130）显示DIAG0/DIAG1选择器
                if (dd.supportsDualDiag) {
                    h += `<select id="cgEndstopDiagMode_${ax}" style="margin-left:8px;font-size:12px;padding:2px 4px;" title="TMC驱动DIAG通道：DIAG0/DIAG1使用同一主板引脚${dd.diag_pin}">`;
                    h += `<option value="diag0_pin">DIAG0 (${dd.diag_pin})</option>`;
                    h += `<option value="diag1_pin" selected>DIAG1 (${dd.diag_pin})</option>`;
                    h += `</select>`;
                } else {
                    h += `<span class="cg-diag-pin-info" id="cgEndstopDiagInfo_${ax}" style="display:none;">(${dd.diagPrefix}${dd.diag_pin} on ${dd.driver}/${dd.tmcModel})</span>`;
                }
                if (ax === 'Z') h += '<span style="color:#e6a817;font-size:11px;margin-left:8px;">⚠️ Z轴不建议使用DIAG</span>';
                h += '</div>';
            } else if (dd && dd.noDiagPin) {
                // 该驱动未引出DIAG引脚
                h += `<div class="cg-diag-row" style="opacity:0.5;"><span style="color:#e53935;font-size:12px;">⛔ ${ax}轴(${dd.driver})：该驱动未引出DIAG引脚，不可用于传感器限位</span></div>`;
            } else if (dd && !dd.diagSupported) {
                // 有DIAG引脚但TMC型号不支持 → 显示禁用的提示
                h += `<div class="cg-diag-row" style="opacity:0.5;"><span style="color:#e53935;font-size:12px;">⛔ ${ax}轴：${dd.tmcModel} 不支持DIAG传感器限位（${dd.diagField}: ${dd.diag_pin}）</span></div>`;
            } else if (ax === 'Z') {
                // Z轴无分配 → 警告
                h += `<div class="cg-diag-row" style="opacity:0.6;"><label class="cg-diag-check"><input type="checkbox" id="cgEndstopDiag_${ax}" onchange="onEndstopDiagChange('${ax}')"> ${ax}轴使用 DIAG 限位</label><span style="color:#e6a817;font-size:11px;"> ⚠️ Z轴不建议使用DIAG，可能影响归位精度</span></div>`;
            }
        });
        h += '</div>';
    }
    // ---- 物理限位引脚分配 (每个轴独立) ----
    if (!stops.length) { c.innerHTML = h || '<p style="color:var(--text-secondary);">当前主板/工具板无限位引脚</p>'; return; }
    const diagPins = {}; for (let i = 0; ; i++) { const d = m[`Drives${i}`]; if (!d) break; if (d.diag_pin) diagPins[d.diag_pin] = d.key; }
    h += '<h4 class="cg-section-title" style="margin-top:16px;"><i class="fas fa-hand-paper"></i> 物理限位引脚分配</h4>';
    h += '<p style="font-size:12px;color:var(--text-secondary);margin:0 0 8px;">为每个轴选择限位引脚。NC不需要 <code>!</code> 前缀，NO需要 <code>!</code> 前缀。</p>';
    h += '<div class="cg-endstop-per-axis">';
    ['X','Y','Z'].forEach((ax, ai) => {
        // 为每个轴构建引脚下拉选项
        let stopOpts = '<option value="">不使用</option>';
        stops.forEach(s => {
            const resolved = cgResolvePinRef(s.value);
            const rawPin = resolved?.rawPin || '';
            const cf = s.source === 'main' ? diagPins[rawPin] : '';
            const cw = cf ? ` ⚠️${cf}` : '';
            const selected = prevPins[ax] ? s.value === prevPins[ax] : (s.source === 'main' && s.key === `stop${ai}`);
            stopOpts += `<option value="${cgEscapeHtml(s.value)}"${selected?' selected':''}>${cgEscapeHtml(s.label + cw)}</option>`;
        });
        h += `<div class="cg-endstop-axis-row" id="cgEndstopPhysical_${ax}">
            <label style="font-weight:600;min-width:20px;">${ax}</label>
            <select id="cgEndstopPin_${ax}" style="flex:1;" onchange="renderToolboardConflictPanel()">${stopOpts}</select>
            <select id="cgEndstopNCNO_${ax}" style="width:80px;"><option value="NC"${prevNcno[ax]==='NC'?' selected':''}>常闭NC</option><option value="NO"${prevNcno[ax]==='NO'?' selected':''}>常开NO</option></select>
        </div>`;
    });
    h += '</div>';
    c.innerHTML = h;
    // 根据当前Probe模式同步Z限位可见性
    syncZEndstopVisibility();
}

// ========== Tab 3: 调平传感器 ==========
function renderProbeConfig() {
    const c=document.getElementById('cgProbeContainer'); if(!c||!_currentMapping) return;
    const sources = getProbeSources();
    const hasProbePin = sources.length > 0;
    if(!hasProbePin) {
        // 无probe/servo引脚：仅允许模式A，强制切换
        _currentProbeMode = 'z_endstop_only';
        c.innerHTML='<div class="cg-probe-section"><h4 class="cg-section-title"><i class="fas fa-cogs"></i> Z限位/调平传感器模式</h4>'+
            '<div style="padding:10px 14px;border-radius:6px;border:1px solid var(--border-color);">'+
            '<span style="color:#e6a817;"><i class="fas fa-info-circle"></i> 此板卡无调平传感器引脚(probe/servo)</span>'+
            '<p style="font-size:12px;color:var(--text-secondary);margin:4px 0 0;">仅支持"仅Z物理限位"模式，Z轴将使用物理限位开关归位。</p></div></div>';
        syncBedMeshByMode();
        return;
    }
    const presetProbe = _currentPreset?.probe;
    const currentType = document.getElementById('cgProbeType')?.value || presetProbe?.type || 'bltouch';
    const pp = PROBE_PRESETS[currentType] || PROBE_PRESETS['bltouch'];
    const isBL = (pp.section === 'bltouch');
    if (!sources.some(src => src.value === _currentProbeSource)) _currentProbeSource = sources[0].value;
    const selectedSource = sources.find(src => src.value === _currentProbeSource) || sources[0];
    let h = '';
    // ---- Z限位/调平传感器工作模式选择 ----
    h += '<div class="cg-probe-section"><h4 class="cg-section-title"><i class="fas fa-cogs"></i> Z限位/调平传感器模式</h4>';
    h += '<div class="cg-probe-mode-selector">';
    for(const[modeKey, modeInfo] of Object.entries(PROBE_MODES)) {
        const checked = (modeKey === _currentProbeMode) ? ' checked' : '';
        h += `<label class="cg-probe-mode-option${checked?' active':''}" id="cgProbeModeOpt_${modeKey}">`;
        h += `<input type="radio" name="cgProbeMode" value="${modeKey}"${checked} onchange="onProbeModeChange()">`;
        h += `<span><i class="fas ${modeInfo.icon}"></i> ${modeInfo.label}</span>`;
        h += `<small>${modeInfo.desc}</small>`;
        h += `</label>`;
    }
    h += '</div>';
    h += '<div style="margin-top:6px;font-size:12px;color:var(--primary-color);"><i class="fas fa-info-circle"></i> <span id="cgProbeModeDesc"></span></div>';
    h += '<div style="font-size:11px;color:var(--text-secondary);"><span id="cgProbeModeHint"></span></div></div>';
    // ---- 探针类型 + 引脚信息（模式A时隐藏）----
    h += `<div id="cgProbeTypeRow" style="${_currentProbeMode==='z_endstop_only'?'display:none;':''}">`;
    h += '<div class="cg-probe-section"><h4 class="cg-section-title"><i class="fas fa-ruler-combined"></i> 探针类型与来源</h4>';
    h += '<div class="cg-probe-pin-row">';
    h += `<select id="cgProbeType" onchange="onProbeTypeChange()" style="flex:1;min-width:220px;">`;
    for(const[k,v]of Object.entries(PROBE_PRESETS)) {
        h += `<option value="${k}"${k===currentType?' selected':''}>${v.name} - ${v.desc}</option>`;
    }
    h += `</select>`;
    h += `<select id="cgProbeSource" onchange="onProbeSourceChange()" style="min-width:170px;">`;
    sources.forEach(src => {
        const selected = src.value === selectedSource.value ? ' selected' : '';
        const pinHint = src.sensorPins.length ? src.sensorPins.map(cgRawPin).join('/') : '无probe';
        h += `<option value="${src.value}"${selected}>${src.label} (${pinHint})</option>`;
    });
    h += `</select>`;
    h += '</div>';
    h += '<div class="cg-probe-pin-row" style="margin-top:8px;">';
    h += `<label>sensor_pin：</label><select id="cgProbeSensorPin" style="min-width:140px;" onchange="renderProbeCheckPanel();renderToolboardConflictPanel()">`;
    selectedSource.sensorPins.forEach(p => h += `<option value="${cgRawPin(p)}">${cgRawPin(p)}</option>`);
    h += `</select>`;
    h += `<span class="cg-probe-mods"><label><input type="checkbox" id="cgProbePullup" checked onchange="renderProbeCheckPanel()"> 上拉(^)</label><label><input type="checkbox" id="cgProbeInvert" onchange="renderProbeCheckPanel()"> 反相(!)</label></span>`;
    h += `<span class="cg-hint">生成：${selectedSource.mcuName ? selectedSource.mcuName + ':pin' : 'pin'}</span>`;
    h += '</div>';
    h += `<div class="cg-probe-pin-row" id="cgProbeServoRow" style="margin-top:8px;${isBL?'':'display:none;'}">`;
    h += '<label>control_pin：</label>';
    if (selectedSource.controlPins.length) {
        h += `<select id="cgProbeControlPin" style="min-width:140px;" onchange="renderProbeCheckPanel();renderToolboardConflictPanel()">`;
        selectedSource.controlPins.forEach(p => h += `<option value="${cgRawPin(p)}">${cgRawPin(p)}</option>`);
        h += '</select>';
    } else {
        h += '<span class="cg-hint" style="color:var(--danger-color);">当前来源没有 servo/control 引脚</span>';
    }
    h += '</div></div></div>';
    // ---- 参数区域（模式A时隐藏）----
    const hideParams = (_currentProbeMode === 'z_endstop_only');
    h += `<div id="cgProbeParams" style="${hideParams?'display:none;':''}">`;
    // 偏移参数（从预设注入）
    h += '<div class="cg-probe-section"><h4 class="cg-section-title"><i class="fas fa-arrows-alt"></i> 偏移参数</h4>';
    h += '<div class="cg-probe-compact">';
    h += `<div class="cg-probe-field"><label>z_offset</label><input type="number" step="0.01" id="cgZOffset" value="${presetProbe?.z_offset ?? pp.z_offset ?? 2.0}" oninput="renderProbeCheckPanel()"></div>`;
    h += `<div class="cg-probe-field"><label>x_offset</label><input type="number" step="0.1" id="cgProbeXOffset" value="${presetProbe?.x_offset ?? 0}" oninput="renderProbeCheckPanel()"></div>`;
    h += `<div class="cg-probe-field"><label>y_offset</label><input type="number" step="0.1" id="cgProbeYOffset" value="${presetProbe?.y_offset ?? 0}" oninput="renderProbeCheckPanel()"></div>`;
    h += '</div></div>';
    // 采样参数（从预设注入）
    const sp = presetProbe || {};
    h += '<div class="cg-probe-section"><h4 class="cg-section-title"><i class="fas fa-chart-bar"></i> 采样参数</h4>';
    h += '<div class="cg-probe-compact">';
    h += `<div class="cg-probe-field"><label>采样次数</label><input type="number" id="cgProbeSamples" value="${sp.samples ?? 1}" min="1" max="10"></div>`;
    h += `<div class="cg-probe-field"><label>采样速度</label><input type="number" step="0.1" id="cgProbeSpeed" value="${sp.speed ?? 5.0}"></div>`;
    h += `<div class="cg-probe-field"><label>抬升速度</label><input type="number" step="0.1" id="cgProbeSpeed2" value="${sp.second_speed ?? sp.lift_speed ?? sp.speed ?? 5.0}"></div>`;
    h += `<div class="cg-probe-field"><label>回退距离</label><input type="number" step="0.1" id="cgProbeRetract" value="${sp.sample_retract_dist ?? 2.0}"></div>`;
    const srSel = sp.samples_result === 'average' ? ['average','median'] : ['median','average'];
    h += `<div class="cg-probe-field"><label>取值方式</label><select id="cgProbeSamplesResult"><option value="${srSel[0]}" selected>${srSel[0]}</option><option value="${srSel[1]}">${srSel[1]}</option></select></div>`;
    h += `<div class="cg-probe-field"><label>采样公差</label><input type="number" step="0.001" id="cgProbeTolerance" value="${sp.samples_tolerance ?? 0.100}"></div>`;
    h += `<div class="cg-probe-field"><label>重试次数</label><input type="number" id="cgProbeRetries" value="${sp.samples_tolerance_retries ?? 0}"></div>`;
    h += '</div></div>';
    h += '<div id="cgProbeCheckPanel" class="cg-probe-check"></div>';
    h += '</div>';
    c.innerHTML = h;
    // 触发模式描述更新
    onProbeModeChange();
    renderProbeCheckPanel();
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
    // 先重填 _cgHomingDirs（原点锁定时保留当前值），再推导 originKey
    const savedDirs = { ..._cgHomingDirs };
    _cgHomingDirs={};
    cpDrives.forEach(drive=>{if(drive.axis==='E')return;const axis=drive.axis;
        let dp;
        if (_homingOriginLocked && savedDirs[axis] !== undefined) {
            // 原点锁定后，所有轴的值从上次UI状态恢复，不重置为预设
            dp = savedDirs[axis];
        } else {
            dp = drive.homing_positive_dir??false;
        }
        _cgHomingDirs[axis]=dp;
    });
    const xPos = _cgHomingDirs['X'] ?? (cpDrives.find(d=>d.axis==='X')?.homing_positive_dir ?? false);
    const yPos = _cgHomingDirs['Y'] ?? (cpDrives.find(d=>d.axis==='Y')?.homing_positive_dir ?? false);
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
    // 限位与速度表格（归位方向由原点统一控制，不单独显示）
    h+='<div class="cg-motion-table"><table><thead><tr><th>轴</th><th>限位位置</th><th>二次归位速度</th><th>归位方向</th></tr></thead><tbody>';
    cpDrives.forEach(drive=>{if(drive.axis==='E')return;const axis=drive.axis;
    const dp=_cgHomingDirs[axis];
    const es = drive.position_endstop ?? (dp ? 200 : 0);
    const isEsMax = es > 0;
    const spd2=drive.second_homing_speed??Math.max(5,Math.round((drive.homing_speed??50)/2));
    h+=`<tr><td><strong>${axis}</strong></td><td><select id="cgHome_${axis}_estop" onchange="onEndstopPosChange('${axis}')" style="width:110px;"><option value="min"${!isEsMax?' selected':''}>min 端 (0)</option><option value="max"${isEsMax?' selected':''}>max 端 (max=${parseFloat(document.getElementById(`cgMotion_${axis}_max`)?.value)||200})</option></select></td><td><input type="number" step="0.1" id="cgHome_${axis}_spd2" value="${spd2}" class="cg-xs"></td><td><span id="cgHome_${axis}_hint" class="cg-hint">${dp?'正→max':'负→min'}</span></td></tr>`;});
    h+='</tbody></table></div><div id="cgHomingVizContainer" style="display:flex;gap:20px;margin:16px 0;flex-wrap:wrap;align-items:flex-start;"></div>';
    // safe_z_home
    h+='<h4 class="cg-section-title"><i class="fas fa-shield-alt"></i> safe_z_home 归位XY前先抬Z</h4>';
    h+='<div class="cg-param-item" style="margin-bottom:8px;"><label><input type="checkbox" id="cgOptSafeZHome" onchange="document.getElementById(\'cgSafeZParams\').style.display=this.checked?\'block\':\'none\';renderProbeCheckPanel()"> 启用 [safe_z_home]</label></div>';
    h+='<div id="cgSafeZParams" style="display:none;"><div class="cg-param-grid">';
    h+='<div class="cg-param-item"><label>Z抬起高度：</label><input type="number" step="0.1" id="cgSafeZHeight" value="10" class="cg-xs" oninput="renderProbeCheckPanel()"></div>';
    h+='<div class="cg-param-item"><label>Home X：</label><input type="number" step="0.1" id="cgHomePosX" value="100" class="cg-xs" oninput="renderProbeCheckPanel()"></div>';
    h+='<div class="cg-param-item"><label>Home Y：</label><input type="number" step="0.1" id="cgHomePosY" value="100" class="cg-xs" oninput="renderProbeCheckPanel()"></div>';
    h+='<div class="cg-param-item"><label>Z hop：</label><input type="number" step="0.1" id="cgZHop" value="5" class="cg-xs" oninput="renderProbeCheckPanel()"></div>';
    h+='<div class="cg-param-item"><label>Z hop速度：</label><input type="number" id="cgZHopSpeed" value="15" class="cg-xs"></div></div></div>';
    c.innerHTML=h;
    syncSafeZHomeByProbeMode();
    renderHomingVisualization();
}
// 原点位置变更 → 主设置：归位方向+限位位置+position_endstop一次性同步
function onOriginChange() {
    const sel = document.getElementById('cgOriginPos')?.value;
    const ORIGIN_MAP = {
        'LF': {xPos:false, yPos:false, zPos:false},
        'RF': {xPos:true,  yPos:false, zPos:false},
        'LB': {xPos:false, yPos:true,  zPos:false},
        'RB': {xPos:true,  yPos:true,  zPos:false}
    };
    const o = ORIGIN_MAP[sel] || ORIGIN_MAP['LF'];
    _homingOriginLocked = true;
    _homingManualOverride = {};  // 原点为主设置，主动选择时清除所有手动覆盖
    ['X','Y','Z'].forEach(axis => {
        const hint = document.getElementById(`cgHome_${axis}_hint`);
        const estop = document.getElementById(`cgHome_${axis}_estop`);
        const esEl = document.getElementById(`cgMotion_${axis}_es`);
        const maxEl = document.getElementById(`cgMotion_${axis}_max`);
        const val = axis === 'X' ? o.xPos : axis === 'Y' ? o.yPos : o.zPos;
        _cgHomingDirs[axis] = val;
        if (hint) hint.textContent = val ? '正→max' : '负→min';
        // 限位位置下拉框
        if (estop) estop.value = val ? 'max' : 'min';
        // position_endstop数值：max端→最大行程, min端→0
        if (esEl) esEl.value = val ? (parseFloat(maxEl?.value) || 200) : 0;
    });
    renderHomingVisualization();
}
// 限位位置变更 → 仅更新 position_endstop，归位方向由原点统一控制
function onEndstopPosChange(axis) {
    const sel = document.getElementById(`cgHome_${axis}_estop`)?.value;
    const esEl = document.getElementById(`cgMotion_${axis}_es`);
    const maxEl = document.getElementById(`cgMotion_${axis}_max`);
    if (esEl) {
        esEl.value = (sel === 'max' && maxEl) ? (parseFloat(maxEl.value) || 200) : 0;
    }
    // 限位位置变更 → 仅更新 position_endstop，归位方向保持原点设置不变
    _homingManualOverride[axis] = true;
    renderHomingVisualization();
}
// ========== Tab 6: 调平与可选配置 ==========
function renderLevelingParams() {
    const c=document.getElementById('cgLevelingContainer'); if(!c||!_currentMapping) return;
    let h='';
    // bed_mesh
    h+='<h4 class="cg-section-title"><i class="fas fa-th"></i> 热床网格校准</h4>';
    h+='<div class="cg-param-item" style="margin-bottom:8px;"><label><input type="checkbox" id="cgOptBedMesh" checked onchange="toggleOptPanel(\'BedMesh\');renderProbeCheckPanel()"> 启用 [bed_mesh]</label></div>';
    h+='<div id="cgBedMeshParams"><div class="cg-param-grid">';
    h+='<div class="cg-param-item"><label>speed：</label><input type="number" id="cgBMSpeed" value="50" class="cg-xs"></div>';
    h+='<div class="cg-param-item"><label>horizontal_move_z：</label><input type="number" id="cgBMHMZ" value="5" class="cg-xs" oninput="renderProbeCheckPanel()"></div>';
    h+='<div class="cg-param-item"><label>mesh_min(x,y)：</label><input type="text" id="cgBMMeshMin" value="30,30" style="width:100px;" oninput="renderProbeCheckPanel()"></div>';
    h+='<div class="cg-param-item"><label>mesh_max(x,y)：</label><input type="text" id="cgBMMeshMax" value="270,270" style="width:100px;" oninput="renderProbeCheckPanel()"></div>';
    h+='<div class="cg-param-item"><label>probe_count：</label><input type="text" id="cgBMProbeCount" value="4,4" style="width:100px;" oninput="renderProbeCheckPanel()"></div>';
    h+='<div class="cg-param-item"><label>algorithm：</label><select id="cgBMAlgo"><option value="bicubic" selected>bicubic</option><option value="lagrange">lagrange</option></select></div></div></div>';
    // screws_tilt_adjust
    h+='<h4 class="cg-section-title" style="margin-top:16px;"><i class="fas fa-screwdriver"></i> 手工调平辅助</h4>';
    h+='<div class="cg-param-grid">';
    h+='<div class="cg-param-item"><label><input type="checkbox" id="cgOptScrewsTilt" onchange="toggleOptPanel(\'ScrewsTilt\');renderProbeCheckPanel()"> [screws_tilt_adjust] 螺丝调平</label></div>';
    h+='<div class="cg-param-item"><label><input type="checkbox" id="cgOptZTilt" onchange="toggleOptPanel(\'ZTilt\');renderProbeCheckPanel()"> [z_tilt] 多Z轴自动调平</label></div>';
    h+='</div>';
    // screws_tilt params
    h+='<div id="cgScrewsTiltParams" style="display:none;margin-top:10px;"><div class="cg-param-grid">';
    h+='<div class="cg-param-item" style="grid-column:1/-1;"><label>螺丝坐标（x,y）：</label><input type="text" id="cgSTScrew1" value="30,30" style="width:80px;" oninput="renderProbeCheckPanel()"> <input type="text" id="cgSTScrew2" value="200,30" style="width:80px;" oninput="renderProbeCheckPanel()"> <input type="text" id="cgSTScrew3" value="200,200" style="width:80px;" oninput="renderProbeCheckPanel()"> <input type="text" id="cgSTScrew4" value="30,200" style="width:80px;" oninput="renderProbeCheckPanel()"></div>';
    h+='<div class="cg-param-item"><label>screw_thread：</label><input type="text" id="cgSTThread" value="CW-M3" style="width:80px;"></div>';
    h+='<div class="cg-param-item"><label>speed：</label><input type="number" id="cgSTSpeed" value="50" class="cg-xs"></div></div></div>';
    // z_tilt params
    h+='<div id="cgZTiltParams" style="display:none;margin-top:10px;"><div class="cg-param-grid">';
    h+='<div class="cg-param-item"><label>Z 电机列表：</label><input type="text" id="cgZTZMotors" value="z,z1" style="width:80px;"></div>';
    h+='<div class="cg-param-item"><label>Z 位置（x,y）：</label><input type="text" id="cgZTZPos" value="30,100" style="width:80px;" oninput="renderProbeCheckPanel()"> <input type="text" id="cgZTZPos2" value="200,100" style="width:80px;" oninput="renderProbeCheckPanel()"></div>';
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
    h+='<div class="cg-param-item" style="margin-bottom:8px;"><label><input type="checkbox" id="cgOptAdxl345" onchange="toggleOptPanel(\'Adxl345\');onAdxlTypeChange();renderToolboardConflictPanel()"> 启用 [adxl345]</label></div>';
    h+='<div id="cgAdxl345Params" style="display:none;">';
    h+='<div class="cg-param-grid"><div class="cg-param-item"><label>连接方式：</label><select id="cgAdxlConnType" onchange="onAdxlTypeChange();renderToolboardConflictPanel()"><option value="spi_bus">SPI总线</option><option value="spi_pins">SPI引脚</option><option value="usb">USB模块</option></select></div></div>';
    h+='<div id="cgAdxlSpiBusPanel"><div class="cg-param-grid"><div class="cg-param-item"><label>spi_bus：</label><select id="cgAdxlSpiBus"><option value="spi1">SPI1</option><option value="spi2" selected>SPI2</option><option value="spi3">SPI3</option></select></div><div class="cg-param-item"><label>cs_pin：</label><input type="text" id="cgAdxlCsPin" value="PA4" style="width:100px;" onchange="renderToolboardConflictPanel()"></div></div></div>';
    h+='<div id="cgAdxlSpiPinsPanel" style="display:none;"><div class="cg-param-grid"><div class="cg-param-item"><label>cs_pin：</label><input type="text" id="cgAdxlCsPin2" value="PA4" style="width:100px;" onchange="renderToolboardConflictPanel()"></div><div class="cg-param-item"><label>sclk_pin：</label><input type="text" id="cgAdxlSclkPin" value="PA5" style="width:100px;" onchange="renderToolboardConflictPanel()"></div><div class="cg-param-item"><label>mosi_pin：</label><input type="text" id="cgAdxlMosiPin" value="PA7" style="width:100px;" onchange="renderToolboardConflictPanel()"></div><div class="cg-param-item"><label>miso_pin：</label><input type="text" id="cgAdxlMisoPin" value="PA6" style="width:100px;" onchange="renderToolboardConflictPanel()"></div></div></div>';
    h+='<div id="cgAdxlUsbPanel" style="display:none;"><div class="cg-param-grid"><div class="cg-param-item"><label>serial：</label><input type="text" id="cgAdxlSerial" value="/dev/serial/by-id/usb-Adxl345" style="width:100%;"></div><div class="cg-param-item"><label>cs_pin：</label><input type="text" id="cgAdxlUsbCsPin" value="adxl:gpio1" style="width:120px;" onchange="renderToolboardConflictPanel()"></div></div></div>';
    h+='<div class="cg-param-grid" style="margin-top:8px;">';
    h+='<div class="cg-param-item"><label>axes_map：</label><select id="cgAdxlAxesMap"><option value="x,y,z" selected>x,y,z</option><option value="x,z,y">x,z,y</option><option value="z,y,x">z,y,x</option></select></div>';
    h+='<div class="cg-param-item"><label>rate：</label><input type="number" id="cgAdxlRate" value="3200" class="cg-xs"></div>';
    h+='<div class="cg-param-item"><label>offset_x：</label><input type="number" step="0.001" id="cgAdxlOffX" value="0.0" class="cg-xs"></div>';
    h+='<div class="cg-param-item"><label>offset_y：</label><input type="number" step="0.001" id="cgAdxlOffY" value="0.0" class="cg-xs"></div>';
    h+='<div class="cg-param-item"><label>offset_z：</label><input type="number" step="0.001" id="cgAdxlOffZ" value="0.0" class="cg-xs"></div></div>';
    h+='<h4 class="cg-section-title" style="font-size:13px;"><i class="fas fa-vibrate"></i> [resonance_tester]</h4><div class="cg-param-grid">';
    h+='<div class="cg-param-item"><label>accel_chip：</label><input type="text" id="cgResTestChip" value="adxl345" style="width:120px;" readonly></div>';
    h+='<div class="cg-param-item"><label>probe_points：</label><input type="text" id="cgResTestPoints" value="125,125,20" style="width:120px;"></div>';
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
    syncBedMeshByMode();
    renderProbeCheckPanel();
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
    // 动态更新采样电阻/Rref标签和默认值
    const srEl=document.getElementById(`cgTmcSR_${i}`);
    const srLabel=document.getElementById(`cgTmcSRLabel_${i}`);
    if(srLabel) {
        if(model==='tmc2240') { srLabel.textContent='rref'; if(srEl&&!srEl.dataset.userEdited) srEl.value='12300'; }
        else if(model==='tmc5160'||model==='tmc2209'||model==='tmc2130') { srLabel.textContent='sense_resistor'; if(srEl&&!srEl.dataset.userEdited) srEl.value=(model==='tmc5160'?'0.075':'0.110'); }
        else { srLabel.textContent='(不使用)'; if(srEl&&!srEl.dataset.userEdited) srEl.value=''; }
    }
    // 标记采样电阻输入被用户手动编辑
    if(srEl) { srEl.addEventListener('input', ()=>srEl.dataset.userEdited='1', {once:true}); }
    // TMC型号变更后刷新DIAG限位区域
    renderEndstopConfig();
    renderToolboardConflictPanel();
}
function updateHomePosHint(axis) {
    // 归位方向复选框已移除，方向由原点统一控制
    _homingManualOverride[axis] = true;
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
    const probeCheck = validateProbeSetup();
    if (!probeCheck.ok) {
        switchCgTab(3);
        renderProbeCheckPanel();
        cgHighlightError(null, '探针配置存在风险：\n' + probeCheck.errors.join('\n'));
        return;
    }
    const tbCheck = validateToolboardSetup();
    renderToolboardConflictPanel();
    if (!tbCheck.ok) {
        switchCgTab(1);
        cgHighlightError(null, '配置存在冲突：\n' + tbCheck.errors.join('\n'));
        return;
    }
    const tbClaims = tbCheck.claims;
    const outputMode = cgGetOutputMode();
    const includeToolboards = outputMode !== 'mainboard';
    const ownsToolboard = func => cgToolboardOwns(tbClaims, func);
    const errEl = document.getElementById('errorMessage'); errEl.style.display = 'none';
    const m = _currentMapping;
    const _DM={rotation_distance:40,microsteps:16,homing_speed:50,position_min:0,position_max:200,position_endstop:0};
    const _DE={rotation_distance:22.67,microsteps:16,filament_diameter:1.75,nozzle_diameter:0.4,max_temp:285,sensor_type:'NTC 100K beta 3950'};
    const _DB={sensor_type:'NTC 100K beta 3950',max_temp:120};
    const B=(t)=>{const vw=s=>[...s].reduce((w,c)=>w+(c.charCodeAt(0)>255?2:1),0);const pad=66-vw(t);return '#####################################################################\n# '+t+' '.repeat(Math.max(0,pad))+'#\n#####################################################################\n';};
    const P=(pre, cmt)=>`${String(pre).padEnd(48)}# ${cmt}\n`;  // 对齐注释到第50列
    const verifyHeaterTargets = new Set();
    let hasPartFanSection = false;
    let config = B('3D MELLOW / FLY 配置 - Firmware-Tool 配置生成器自动生成');
    config += '# 如需售后，请联系淘宝客服\n# FLY 售后技术支持群:621032883\n\n';
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
    config += P(`kinematics: ${(_currentPreset?.geometry?.type==='cartesian'?'cartesian':'corexy')}`,'运动学结构');
    config += P(`max_velocity: ${maxVel}`,'最大速度');
    config += P(`max_accel: ${maxAccel}`,'最大加速度');
    config += P(`max_z_velocity: ${maxZVel}`,'Z轴最大速度');
    config += P(`max_z_accel: ${maxZAccel}`,'Z轴最大加速度');
    config += P(`square_corner_velocity: ${cornerVel}`,'拐角速度');
    config += '\n';
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
        config += P(`step_pin: ${d.step_pin}`,`${al}电机脉冲引脚设置`);
        config += P(`dir_pin: ${d.dir_pin}`,`${al}电机方向引脚设置`);
        const tmcM=document.getElementById(`cgTmcModel_${di}`)?.value||'tmc2209';
        const invPin=['tmc2208','tmc2209','tmc5160','tmc2240','tmc2130','tmc2660','a4988','yanggong'].includes(tmcM)?'!':'';
        config += P(`enable_pin: ${invPin}${d.enable_pin}`,`${al}电机使能引脚设置`);
        const rd=document.getElementById(`cgMotion_${a.axis}_rd`)?.value||_DM.rotation_distance;
        const ms=parseInt(document.getElementById(`cgMotion_${a.axis}_ms`)?.value||_DM.microsteps);
        const fspr=document.getElementById(`cgMotion_${a.axis}_fspr`)?.value||'200';
        const hrd=document.getElementById(`cgMotion_${a.axis}_hrd`)?.value||'5';
        const spd=document.getElementById(`cgMotion_${a.axis}_spd`)?.value||'0.000004';
        const hs=document.getElementById(`cgMotion_${a.axis}_hs`)?.value||_DM.homing_speed;
        const pmin=document.getElementById(`cgMotion_${a.axis}_min`)?.value||_DM.position_min;
        const pmax=document.getElementById(`cgMotion_${a.axis}_max`)?.value||200;
        const pes=document.getElementById(`cgMotion_${a.axis}_es`)?.value||_DM.position_endstop;
        const posDir = _cgHomingDirs[a.axis] ?? false;
        const spd2=document.getElementById(`cgHome_${a.axis}_spd2`)?.value||Math.max(5,Math.round(parseFloat(hs)/2));
        config += P(`rotation_distance: ${rd}`,'主动带轮周长mm');
        config += P(`microsteps: ${ms}`,'电机细分');
        config += P(`full_steps_per_rotation: ${fspr}`,'单圈脉冲数(1.8度=200,0.9度=400)');
        // 限位引脚
        const isSecondary = /^[XYZ]1$/i.test(a.axis) || /^[XYZ][2-9]$/i.test(a.axis);
        if (!isSecondary) {
            const baseAxis = a.axis.toLowerCase().replace(/\d+/,'');
            const diagChecked = document.getElementById(`cgEndstopDiag_${baseAxis.toUpperCase()}`)?.checked ?? false;
            const tmcM=document.getElementById(`cgTmcModel_${di}`)?.value||'tmc2209';
            if (baseAxis === 'z' && _currentProbeMode === 'probe_as_z') {
                config += P('endstop_pin: probe:z_virtual_endstop','使用调平传感器替代Z限位');
            } else if (diagChecked && d.diag_pin) {
                config += P(`endstop_pin: ${tmcM}_stepper_${baseAxis.toLowerCase()}:virtual_endstop`,'DIAG虚拟限位');
            } else {
                const endstopKey = document.getElementById(`cgEndstopPin_${baseAxis.toUpperCase()}`)?.value;
                const endstopRef = cgResolvePinRef(endstopKey);
                if (endstopRef) {
                    const isNO = document.getElementById(`cgEndstopNCNO_${baseAxis.toUpperCase()}`)?.value === 'NO';
                    const pin = cgPrefixPin(`^${isNO?'!':''}${endstopRef.rawPin}`, endstopRef.mcuName);
                    config += P(`endstop_pin: ${pin}`,`限位开关PIN脚${isNO?' (NO常开)':' (NC常闭)'}`);
                }
            }
            config += P(`position_min: ${pmin}`,'软限位最小行程');
            config += P(`position_endstop: ${pes}`,'限位位置');
            config += P(`position_max: ${pmax}`,'机械限位最大行程');
            config += P(`homing_speed: ${hs}`,'复位速度');
            config += P(`homing_retract_dist: ${hrd}`,'归位后退距离');
            config += P(`homing_positive_dir: ${posDir?'true':'false'}`,'归位方向');
            config += P(`second_homing_speed: ${spd2}`,'二次归位速度');
        }
        config += '#--------------------------------------------------------------------\n';
        // TMC驱动段
        const tmcModel=document.getElementById(`cgTmcModel_${di}`)?.value||'tmc2209';
        const tmcCur=document.getElementById(`cgTmcCurrent_${di}`)?.value||'0.8';
        if(tmcModel!=='none'&&d.uart_pin) {
            const diagEnabled = document.getElementById(`cgEndstopDiag_${a.axis.toUpperCase().replace(/\d+/,'')}`)?.checked ?? false;
            config += P(`[${tmcModel} stepper_${a.axis.toLowerCase()}]`,`${al}驱动配置`);
            const diagPrefixMap={'tmc2209':'^','tmc5160':'^!','tmc2240':'^!','tmc2130':'^!'};
            if(tmcModel==='tmc5160'||tmcModel==='tmc2130') {
                config += P(`cs_pin: ${d.uart_pin}`,'SPI片选Pin脚');
                if(d.spi_bus) config += `# spi_bus: ${d.spi_bus}\n`;
                if(diagEnabled && d.diag_pin) {
                    const dp=diagPrefixMap[tmcModel]||'';
                    const diagMode = document.getElementById(`cgEndstopDiagMode_${a.axis.toUpperCase().replace(/\d+/,'')}`)?.value || 'diag1_pin';
                    config += P(`${diagMode}: ${dp}${d.diag_pin}`,`TMC ${tmcModel.toUpperCase()} DIAG引脚`);
                    config += P('driver_SGT: 1','灵敏度(-64最敏感~63最不敏感)');
                }
                config += P(`run_current: ${tmcCur}`,'运行电流');
                const srVal = document.getElementById(`cgTmcSR_${di}`)?.value;
                if(srVal) config += P(`sense_resistor: ${srVal}`,'驱动采样电阻');
            } else if(tmcModel==='tmc2240') {
                if(d.uart_pin) config += P(`uart_pin: ${d.uart_pin}`,'通讯端口Pin脚定义');
                if(diagEnabled && d.diag_pin) {
                    const dp=diagPrefixMap[tmcModel]||'';
                    const diagMode = document.getElementById(`cgEndstopDiagMode_${a.axis.toUpperCase().replace(/\d+/,'')}`)?.value || 'diag1_pin';
                    config += P(`${diagMode}: ${dp}${d.diag_pin}`,`TMC ${tmcModel.toUpperCase()} DIAG引脚`);
                    config += P('driver_SGT: 1','灵敏度(-64最敏感~63最不敏感)');
                }
                config += P(`run_current: ${tmcCur}`,'运行电流');
                const rrefVal = document.getElementById(`cgTmcSR_${di}`)?.value || '12300';
                config += P(`rref: ${rrefVal}`,'外部参考电阻(Ohm)');
            } else {
                config += P(`uart_pin: ${d.uart_pin}`,'通讯端口Pin脚定义');
                if(diagEnabled && d.diag_pin) {
                    const dp=diagPrefixMap[tmcModel]||'^';
                    config += P(`diag_pin: ${dp}${d.diag_pin}`,'DIAG引脚(需前缀)');
                    config += P('driver_SGTHRS: 100','灵敏度(0最不敏感~255最不敏感)');
                }
                config += P(`run_current: ${tmcCur}`,'运行电流');
                const srVal3 = document.getElementById(`cgTmcSR_${di}`)?.value;
                if(srVal3) config += P(`sense_resistor: ${srVal3}`,'驱动采样电阻');
            }
        }
        config += '#--------------------------------------------------------------------\n\n';
    });
    // ---- [extruder] + TMC ----
    const extDrive = axisAssign.find(a => a.axis==='E');
    if (extDrive && !ownsToolboard('extruder_drive')) {
        const d=extDrive.info, edi=extDrive.info.idx||0;
        config += B('挤出机设置 (E0 Settings)');
        config += '[extruder]                          # 挤出机\n';
        verifyHeaterTargets.add('extruder');
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
        config += P(`rotation_distance: ${rd}`,'步进值');
        if(gr) config += P(`gear_ratio: ${gr}`,'减速比');
        config += P(`microsteps: ${ms}`,'电机细分');
        config += P('full_steps_per_rotation: 200','单圈脉冲数');
        config += P(`nozzle_diameter: ${nd}`,'喷嘴直径');
        config += P(`filament_diameter: ${fd}`,'耗材直径');
        const hk=document.getElementById('cgHeatPin_extruder')?.value;
        const hRef=cgResolvePinRef(hk);
        if(hRef) config += P(`heater_pin: ${hRef.pin}`,'加热棒引脚');
        config += P(`sensor_type: ${st}`,'传感器型号');
        if(st==='PT100') config += '# ⚠️ PT100 需要 MAX31865 放大器模块，不可直连 MCU ADC 引脚\n';
        else if(st==='PT1000') config += '# ⚠️ PT1000 建议搭配放大器使用以确保精度\n';
        const tk=document.getElementById('cgTempPin_extruder')?.value;
        const tRef=cgResolvePinRef(tk);
        if(tRef) config += P(`sensor_pin: ${tRef.pin}`,'传感器引脚');
        config += P(`min_temp: ${emt}`,'最小温度');
        config += P(`max_temp: ${maxT}`,'最大温度');
        config += P(`max_power: ${mep}`,'最大功率');
        config += P(`min_extrude_temp: ${minT}`,'最小挤出温度');
        config += P(`pressure_advance: ${pa}`,'推进压力');
        config += P(`pressure_advance_smooth_time: ${pas}`,'平稳推进时间');
        config += `max_extrude_only_distance: ${med}\n`;
        config += `max_extrude_cross_section: ${mec}\n`;
        config += `control: ${ec}\n`;
        config += '#--------------------------------------------------------------------\n';
        // TMC驱动段
        const tmcModel=document.getElementById(`cgTmcModel_${edi}`)?.value||'tmc2209';
        const tmcCur=document.getElementById(`cgTmcCurrent_${edi}`)?.value||'0.5';
        if(tmcModel!=='none'&&d.uart_pin) {
            config += P(`[${tmcModel} extruder]`,'挤出机驱动配置');
            if(tmcModel==='tmc5160') {
                config += P(`cs_pin: ${d.uart_pin}`,'SPI片选Pin脚');
                if(d.spi_bus) config += `# spi_bus: ${d.spi_bus}\n`;
            } else {
                config += P(`uart_pin: ${d.uart_pin}`,'通讯端口Pin脚定义');
            }
            config += P(`run_current: ${tmcCur}`,'运行电流');
            if(tmcModel==='tmc2240') {
                const rrefVal = document.getElementById(`cgTmcSR_${edi}`)?.value || '12300';
                config += P(`rref: ${rrefVal}`,'外部参考电阻(Ohm)');
            } else {
                const extSR = document.getElementById(`cgTmcSR_${edi}`)?.value;
                if(extSR) config += P(`sense_resistor: ${extSR}`,'驱动采样电阻');
            }
        }
        config += '#--------------------------------------------------------------------\n\n';
    }
    // ---- [heater_bed] ----
    const bedHK=document.getElementById('cgHeatPin_heater_bed')?.value;
    const bedTK=document.getElementById('cgTempPin_heater_bed')?.value;
    if(bedHK||bedTK) {
        config += B('热床配置');
        config += '[heater_bed]\n';
        if(bedHK&&bedTK) verifyHeaterTargets.add('heater_bed');
        const bedHRef=cgResolvePinRef(bedHK);
        if(bedHRef) config+=`heater_pin: ${bedHRef.pin}              # 热床接口\n`;
        const bst=document.getElementById('cgBedST')?.value||_DB.sensor_type;
        const bedTRef=cgResolvePinRef(bedTK);
        if(bedTRef) config+=`sensor_type: ${bst}    # 热床传感器类型\nsensor_pin: ${bedTRef.pin}              # 热床传感器接口\n`;
        if(bst==='PT100') config += '# ⚠️ PT100 需要 MAX31865 放大器模块，不可直连 MCU ADC 引脚\n';
        else if(bst==='PT1000') config += '# ⚠️ PT1000 建议搭配放大器使用以确保精度\n';
        config += `max_power: ${document.getElementById('cgBedMaxPower')?.value||'1.0'}               # 热床功率\n`;
        config += `min_temp: ${document.getElementById('cgBedMinTemp')?.value||'-235'}                  # 最小温度\n`;
        config += `max_temp: ${document.getElementById('cgBedMaxT')?.value||_DB.max_temp}                # 最大温度\n`;
        config += `control: ${document.getElementById('cgBedControl')?.value||'watermark'}\n\n`;
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
            const heatRef=cgResolvePinRef(heatKey);
            const tempRef=cgResolvePinRef(tempKey);
            if(heatRef) config+=`heater_pin: ${heatRef.pin}\n`;
            if(tempRef) config+=`sensor_type: ${st}\nsensor_pin: ${tempRef.pin}\n`;
            if(st==='PT100') config += '# ⚠️ PT100 需要 MAX31865 放大器\n';
            else if(st==='PT1000') config += '# ⚠️ PT1000 建议搭配放大器\n';
            config += `max_temp: ${maxT}\n`;
            config += `min_temp: ${document.getElementById(`cgExtraMinTemp_${i}`)?.value||'-235'}\n`;
            config += `max_power: ${document.getElementById(`cgExtraMaxPower_${i}`)?.value||'1.0'}\n`;
            config += `control: ${document.getElementById(`cgExtraCtrl_${i}`)?.value||'watermark'}\n\n`;
            if(heatKey&&tempKey) verifyHeaterTargets.add(name);
        } else {
            const tempKey=document.getElementById(`cgExtraTempPin_${i}`)?.value;
            if(!tempKey) continue;
            config += B(`温度传感器: ${name}`);
            config += `[temperature_sensor ${name}]\n`;
            const tempRef=cgResolvePinRef(tempKey);
            if(tempRef) config+=`sensor_type: ${st}\nsensor_pin: ${tempRef.pin}\n`;
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
    let fanConfig = '';
    const partFanRef=cgResolvePinRef(partFanKey);
    const throatFanRef=cgResolvePinRef(throatFanKey);
    const driverFanRef=cgResolvePinRef(driverFanKey);
    const ctrlFanRef=cgResolvePinRef(ctrlFanKey);
    const exhFanRef=cgResolvePinRef(exhFanKey);
    if(partFanRef) { fanConfig+='[fan]                        # 模型冷却风扇\n'; hasPartFanSection=true; fanConfig+=`pin: ${partFanRef.pin}                     # 信号接口\n`; fanConfig+='max_power: 1.0               # 最大转速\nshutdown_speed: 0.0          # 关机转速\nkick_start_time: 0.5         # 启动时间\noff_below: 0.10              # 最低启动\n'; fanConfig+='#--------------------------------------------------------------------\n'; }
    if(throatFanRef) { fanConfig+='[heater_fan hotend_fan]      # 喉管冷却风扇\n'; fanConfig+=`pin: ${throatFanRef.pin}                     # 信号接口\n`; fanConfig+='max_power: 1.0               # 最大转速\nkick_start_time: 0.5         # 启动时间\nheater: extruder             # 关联设备\nheater_temp: 50              # 启动温度\nfan_speed: 1.0               # 风扇转速\n'; fanConfig+='#--------------------------------------------------------------------\n'; }
    if(driverFanRef) { fanConfig+='[controller_fan driver_fan]  # 驱动/主控散热风扇\n'; fanConfig+=`pin: ${driverFanRef.pin}                     # 信号接口\n`; fanConfig+='max_power: 1.0               # 最大转速\nkick_start_time: 0.5         # 启动时间\nshutdown_speed: 0.5          # 关机转速\nheater: heater_bed           # 关联加热器\nfan_speed: 0.8               # 风扇转速\n'; fanConfig+='#--------------------------------------------------------------------\n'; }
    if(ctrlFanRef) { fanConfig+='[heater_fan controller_fan]  # 电器仓风扇\n'; fanConfig+=`pin: ${ctrlFanRef.pin}                     # 信号接口\n`; fanConfig+='max_power: 1.0\nkick_start_time: 0.5\nheater: heater_bed\nheater_temp: 50\nfan_speed: 1.0\n'; fanConfig+='#--------------------------------------------------------------------\n'; }
    if(exhFanRef) { fanConfig+='[heater_fan exhaust_fan]    # 排风扇\n'; fanConfig+=`pin: ${exhFanRef.pin}                     # 信号接口\n`; fanConfig+='max_power: 1.0\nkick_start_time: 0.5\nheater: heater_bed\nheater_temp: 70\nfan_speed: 1.0\n'; }
    if(fanConfig) config += B('风扇配置') + fanConfig + '\n';
    const filamentPin=document.getElementById('cgFilamentSensorPin')?.value;
    const filamentRef=cgResolvePinRef(filamentPin);
    if(filamentRef) {
        const fsName=cgSafeConfigName(document.getElementById('cgFilamentSensorName')?.value||'filament_sensor','filament_sensor');
        const fsMode=document.getElementById('cgFilamentSensorMode')?.value||'switch';
        const fsNO=document.getElementById('cgFilamentSensorNCNO')?.value==='NO';
        const fsPullup=document.getElementById('cgFilamentPullup')?.checked ?? true;
        const fsPin=cgPrefixPin(`${fsPullup?'^':''}${fsNO?'!':''}${filamentRef.rawPin}`, filamentRef.mcuName);
        const pauseOnRunout=document.getElementById('cgFilamentPauseOnRunout')?.value||'True';
        const eventDelay=document.getElementById('cgFilamentEventDelay')?.value||'3.0';
        const pauseDelay=document.getElementById('cgFilamentPauseDelay')?.value||'0.5';
        const runoutGcode=cgFormatGcodeBlock(document.getElementById('cgFilamentRunoutGcode')?.value||'PAUSE');
        const insertGcode=cgFormatGcodeBlock(document.getElementById('cgFilamentInsertGcode')?.value||'');
        config += B('断料/堵料检测');
        if(fsMode==='motion') {
            config += `[filament_motion_sensor ${fsName}]\n`;
            config += `switch_pin: ${fsPin}\n`;
            config += `detection_length: ${document.getElementById('cgFilamentDetectionLength')?.value||'7.0'}\n`;
            config += `extruder: ${document.getElementById('cgFilamentExtruder')?.value||'extruder'}\n`;
        } else {
            config += `[filament_switch_sensor ${fsName}]\n`;
            config += `switch_pin: ${fsPin}\n`;
        }
        config += `pause_on_runout: ${pauseOnRunout}\n`;
        config += `event_delay: ${eventDelay}\n`;
        config += `pause_delay: ${pauseDelay}\n`;
        if(runoutGcode) config += `runout_gcode:\n${runoutGcode}\n`;
        if(insertGcode) config += `insert_gcode:\n${insertGcode}\n`;
        config += '\n';
    }
    // ---- [adxl345] + [resonance_tester] ----
    if(document.getElementById('cgOptAdxl345')?.checked && !ownsToolboard('adxl')) {
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
            const adxlCsPin=document.getElementById('cgAdxlUsbCsPin')?.value||'adxl:gpio1';
            config += '[mcu adxl]                  # USB加速度计独立MCU\n';
            config += `serial: ${adxlSerial}\n\n`;
            config += '[adxl345]\n';
            config += `cs_pin: ${cgPrefixPin(adxlCsPin, 'adxl')}                  # 片选引脚\n`;
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
        config += B('共振测试器');
        config += '[resonance_tester]\n';
        config += `accel_chip: ${chipName}              # 加速度计芯片\n`;
        config += `probe_points: ${probePoints}       # 探测点(热床中心)\n`;
        config += '\n';
    }
    // ---- [probe] / [bltouch] ---- 根据 _currentProbeMode 决定是否生成
    const probeType=document.getElementById('cgProbeType')?.value||'bltouch';
    const probePreset=PROBE_PRESETS[probeType];
    const zOffset=document.getElementById('cgZOffset')?.value??(probePreset?.z_offset??2.0);
    const samples=document.getElementById('cgProbeSamples')?.value||1;
    const retractDist=document.getElementById('cgProbeRetract')?.value||2.0;
    const probeSpeed=document.getElementById('cgProbeSpeed')?.value||5.0;
    const probeSpeed2=document.getElementById('cgProbeSpeed2')?.value||5.0;
    const pxOff=document.getElementById('cgProbeXOffset')?.value||0;
    const pyOff=document.getElementById('cgProbeYOffset')?.value||0;
    const pSR=document.getElementById('cgProbeSamplesResult')?.value||'average';
    const pTol=document.getElementById('cgProbeTolerance')?.value||0.100;
    const pRet=document.getElementById('cgProbeRetries')?.value||0;
    // 模式B/C需要生成probe配置（模式A不生成）
    const probePins = getProbePinState();
    const sensorPin = probePins.sensorPin ? cgComposePin(probePins.sensorPin, probePins.source?.mcuName || '', {pullup: probePins.pullup, invert: probePins.invert}) : '';
    const controlPin = probePins.controlPin ? cgComposePin(probePins.controlPin, probePins.source?.mcuName || '') : '';
    if(_currentProbeMode!=='z_endstop_only'&&probePreset&&sensorPin) {
        config += B('调平传感器');
        config += `# 探针来源: ${probePins.source?.label || '未知'}\n`;
        if (_currentProbeMode === 'probe_as_z') config += '# Z轴 endstop_pin 已设置为 probe:z_virtual_endstop\n';
        else config += '# Z轴仍使用物理限位，探针仅用于网床/调平\n';
        if(probePreset.section==='bltouch') {
            config+='[bltouch]\n';
            config+=`sensor_pin: ${sensorPin}                  # 传感器信号引脚\n`;
            if(controlPin) config+=`control_pin: ${controlPin}                  # 舵机控制引脚\n`;
        } else {
            config+=`[probe]\npin: ${sensorPin}                  # 传感器信号引脚\n`;
        }
        config+=`x_offset: ${pxOff}                   # X轴偏移量\n`;
        config+=`y_offset: ${pyOff}                   # Y轴偏移量\n`;
        config+=`z_offset: ${zOffset}                  # Z轴偏移量\n`;
        config+=`speed: ${probeSpeed}                   # 探测速度\n`;
        config+=`lift_speed: ${probeSpeed2}               # 抬升速度\n`;
        config+=`samples: ${samples}                    # 采样次数\n`;
        config+=`samples_result: ${pSR}        # 取值方式\n`;
        config+=`sample_retract_dist: ${retractDist}     # 采样回退距离\n`;
        config+=`samples_tolerance: ${pTol}      # 采样公差\n`;
        config+=`samples_tolerance_retries: ${pRet}  # 超公差重试次数\n`;
        if(probeType==='voron_tap') config+='# Voron Tap: z_offset 应为 0，使用喷嘴作为探针\n';
        config+='\n';
        config += B('探针启用后检查清单');
        config += '# 1. 先执行 QUERY_PROBE，确认未触发/触发状态正确\n';
        if(probePreset.section==='bltouch') {
            config += '# 2. BLTouch 请先执行 BLTOUCH_DEBUG COMMAND=pin_down / pin_up 检查伸缩\n';
            config += '# 3. 确认 sensor_pin 与 control_pin 都接在同一探针来源 MCU 上\n';
        } else {
            config += '# 2. 用手触发探针，确认 QUERY_PROBE 状态变化正确\n';
        }
        if(_currentProbeMode==='probe_as_z') {
            config += '# 4. 当前 Z 限位使用 probe:z_virtual_endstop，首次 G28 前请确认 safe_z_home 坐标安全\n';
        } else {
            config += '# 4. 当前 Z 仍使用物理限位，探针只参与调平/网床\n';
        }
        config += '# 5. 首次使用必须执行 PROBE_CALIBRATE 并 SAVE_CONFIG 校准 z_offset\n';
        config += '# 6. 如果启用 bed_mesh / z_tilt / screws_tilt_adjust，请确认所有点位都在热床可达范围内\n\n';
    }
    // ---- 归位 ----
    if(document.getElementById('cgOptSafeZHome')?.checked) {
        const hX=document.getElementById('cgHomePosX')?.value||100;
        const hY=document.getElementById('cgHomePosY')?.value||100;
        const zHop=document.getElementById('cgZHop')?.value||5;
        const zHopSpd=document.getElementById('cgZHopSpeed')?.value||15;
        config+=B('归位');
        config+=`[safe_z_home]                # Z轴限位坐标\n`;
        config+=`home_xy_position: ${hX},${hY}     # Z轴限位位置\n`;
        config+=`speed: 100                    # 归位速度\n`;
        config+=`z_hop: ${zHop}                     # 归位之前抬升高度\n`;
        config+=`z_hop_speed: ${zHopSpd}               # 抬升速度\n\n`;
    }
    // ---- 可选段 ----
    if(document.getElementById('cgOptForceMove')?.checked) { config+=B('手动步进电机')+'[force_move]\nenable_force_move: True\n\n'; }
    if(document.getElementById('cgOptVerifyHeater')?.checked) {
        const vMe=document.getElementById('cgVHMaxError')?.value||120;
        const vCg=document.getElementById('cgVHCheckGain')?.value||20;
        const vHy=document.getElementById('cgVHHysteresis')?.value||5;
        const vHg=document.getElementById('cgVHHeatingGain')?.value||2.0;
        if(ownsToolboard('extruder_drive')) verifyHeaterTargets.add('extruder');
        const targets=Array.from(verifyHeaterTargets);
        if(targets.length) {
            config+=B('加热校验');
            targets.forEach(target=>{
                config+=`[verify_heater ${target}]\n`;
                config+=`max_error: ${vMe}\ncheck_gain_time: ${vCg}\nhysteresis: ${vHy}\nheating_gain: ${vHg}\n`;
                config+='#--------------------------------------------------------------------\n';
            });
            config+='\n';
        }
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
    const mainConfigBeforeToolboards = config;
    if (includeToolboards) _toolboardData.forEach((tb,i) => {
        if(!tb.mapping||!tb.boardInfo) return;
        const tm=tb.mapping;
        const tbName=cgSafeConfigName(tb.name||`TB${i}`, `TB${i}`);
        const tbSectionName=cgSafeConfigName(tbName.toLowerCase(), `tb${i}`);
        const tbPin=(pin)=>cgPrefixPin(pin, tbName);
        const fa=tb.funcAssigns||{};
        const tbSerial=document.getElementById(`cgTBSerial${i}`)?.value?.trim()||'';
        const tbConn=document.getElementById(`cgTBConn${i}`)?.value||'can';
        const appendTBTmc = (target, d, driveIndex) => {
            const model=document.getElementById(`cgTBTmcModel_${i}_${driveIndex}`)?.value||'tmc2209';
            if(!d?.uart_pin || ['none','a4988','external','yanggong'].includes(model)) return '';
            const cur=document.getElementById(`cgTBTmcCurrent_${i}_${driveIndex}`)?.value||'0.8';
            const sr=document.getElementById(`cgTBTmcSR_${i}_${driveIndex}`)?.value||'';
            let out=`[${model} ${target}]\n`;
            if((model==='tmc5160'||model==='tmc2130') && d.spi_bus) {
                out+=`cs_pin: ${tbPin(d.uart_pin)}\n`;
                if(Array.isArray(d.spi_bus)) {
                    out+=`spi_software_sclk_pin: ${tbPin(d.spi_bus[1]||d.spi_bus[0])}\n`;
                    out+=`spi_software_mosi_pin: ${tbPin(d.spi_bus[0]||d.spi_bus[1])}\n`;
                    out+=`spi_software_miso_pin: ${tbPin(d.spi_bus[2]||d.spi_bus[0])}\n`;
                } else {
                    out+=`spi_bus: ${d.spi_bus}\n`;
                }
            } else {
                out+=`uart_pin: ${tbPin(d.uart_pin)}\n`;
            }
            out+=`run_current: ${cur}\n`;
            if(sr) out+=`${model==='tmc2240'?'rref':'sense_resistor'}: ${sr}\n`;
            return out+'\n';
        };
        // [mcu TBName]
        config+=B(`工具板 MCU 配置: ${tbName}`);
        config+=`[mcu ${tbName}]\n`;
        if(tbSerial) { if(tbConn==='can') config+=`canbus_uuid: ${tbSerial}\n`; else config+=`serial: ${tbSerial}\n`; }
        else config+='# TODO: 请填写工具板连接信息\n';
        config+='\n';
        // 工具板驱动器
        const tbDrives=[]; for(let j=0;j<10;j++){if(tm[`Drives${j}`])tbDrives.push({key:`Drives${j}`,...tm[`Drives${j}`]});else break;}
        const tbAxes=tb.axes||[];
        const nonExtruderAxes = tbAxes.filter(axis => axis && axis !== 'E');
        if(nonExtruderAxes.length) config+=B(`工具板运动系统: ${tbName}`);
        tbDrives.forEach((d,j)=>{
            const axis=tbAxes[j]; if(!axis||axis==='E') return;
            const rd=document.getElementById(`cgMotion_${axis}_rd`)?.value||_DM.rotation_distance;
            const ms=parseInt(document.getElementById(`cgMotion_${axis}_ms`)?.value||_DM.microsteps);
            const fspr=document.getElementById(`cgMotion_${axis}_fspr`)?.value||'200';
            const hrd=document.getElementById(`cgMotion_${axis}_hrd`)?.value||'5';
            const hs=document.getElementById(`cgMotion_${axis}_hs`)?.value||_DM.homing_speed;
            const pmin=document.getElementById(`cgMotion_${axis}_min`)?.value||_DM.position_min;
            const pmax=document.getElementById(`cgMotion_${axis}_max`)?.value||200;
            const pes=document.getElementById(`cgMotion_${axis}_es`)?.value||_DM.position_endstop;
            const posDir = _cgHomingDirs[axis] ?? false;
            const spd2=document.getElementById(`cgHome_${axis}_spd2`)?.value||Math.max(5,Math.round(parseFloat(hs)/2));
            const isSecondary = /^[XYZ]1$/i.test(axis) || /^[XYZ][2-9]$/i.test(axis);
            const tbTmcModel=document.getElementById(`cgTBTmcModel_${i}_${j}`)?.value||'tmc2209';
            config+=`[stepper_${axis.toLowerCase()}]\n`;
            config+=`step_pin: ${tbPin(d.step_pin)}\ndir_pin: ${tbPin(d.dir_pin)}\nenable_pin: ${tbPin(`${cgTmcEnableInvert(tbTmcModel)}${d.enable_pin}`)}\n`;
            config+=`microsteps: ${ms}\nrotation_distance: ${rd}\nfull_steps_per_rotation: ${fspr}\n`;
            if(!isSecondary) {
                const baseAxis=axis.toLowerCase().replace(/\d+/,'');
                const stopEntry=Object.entries(fa).find(([_,v])=>v&&typeof v==='object'&&v.axis===baseAxis);
                if(stopEntry) {
                    const [stopKey,stopCfg]=stopEntry;
                    const stopPin=tm[stopKey];
                    if(stopPin!=null) config+=`endstop_pin: ${cgPrefixPin(`^${stopCfg.ncno==='NO'?'!':''}${cgRawPin(stopPin)}`, tbName)}\n`;
                }
                config+=`position_min: ${pmin}\nposition_max: ${pmax}\nposition_endstop: ${pes}\n`;
                config+=`homing_speed: ${hs}\nhoming_retract_dist: ${hrd}\n`;
                config+=`homing_positive_dir: ${posDir?'true':'false'}\nsecond_homing_speed: ${spd2}\n`;
            }
            config+='\n';
            config+=appendTBTmc(`stepper_${axis.toLowerCase()}`, d, j);
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
                const emt=document.getElementById('cgExtMinTemp')?.value||'-235';
                const mep=document.getElementById('cgExtMaxPower')?.value||'1.0';
                config+=B(`工具板挤出/热端: ${tbName}`);
                const tbTmcModel=document.getElementById(`cgTBTmcModel_${i}_${tbExtAxis}`)?.value||'tmc2209';
                config+='[extruder]\n';
                config+=`step_pin: ${tbPin(d.step_pin)}\ndir_pin: ${tbPin(d.dir_pin)}\nenable_pin: ${tbPin(`${cgTmcEnableInvert(tbTmcModel)}${d.enable_pin}`)}\n`;
                config+=`microsteps: ${ms}\nrotation_distance: ${rd}\nfilament_diameter: ${fd}\nnozzle_diameter: ${nd}\n`;
                config+=`min_temp: ${emt}\nmax_temp: ${maxT}\nmax_power: ${mep}\nmin_extrude_temp: ${minT}\n`;
                const heatRef=cgResolvePinRef(document.getElementById('cgHeatPin_extruder')?.value);
                const tempRef=cgResolvePinRef(document.getElementById('cgTempPin_extruder')?.value);
                if(heatRef) config+=`heater_pin: ${heatRef.pin}\n`;
                if(tempRef) config+=`sensor_type: ${st}\nsensor_pin: ${tempRef.pin}\n`;
                if(heatRef&&tempRef) verifyHeaterTargets.add('extruder');
                config+='\n';
                config+=appendTBTmc('extruder', d, tbExtAxis);
            }
        }
        // 工具板风扇
        let tbHasToolheadFanHeader = false;
        const tfk=Object.keys(fa).find(k=>fa[k]==='part_fan');
        if(tfk&&tm[tfk]!=null) {
            if(!tbHasToolheadFanHeader){config+=B(`工具板风扇/附加功能: ${tbName}`);tbHasToolheadFanHeader=true;}
            const section=hasPartFanSection?`[fan_generic ${tbSectionName}_part_fan]`:'[fan]';
            config+=`${section}\npin: ${tbPin(tm[tfk])}\n\n`;
            hasPartFanSection=true;
        }
        const ttfk=Object.keys(fa).find(k=>fa[k]==='throat_fan');
        if(ttfk&&tm[ttfk]!=null) { if(!tbHasToolheadFanHeader){config+=B(`工具板风扇/附加功能: ${tbName}`);tbHasToolheadFanHeader=true;} config+=`[heater_fan ${tbSectionName}_throat_fan]\npin: ${tbPin(tm[ttfk])}\nheater: extruder\nheater_temp: 50\nfan_speed: 1.0\n\n`; }
        const tcfk=Object.keys(fa).find(k=>fa[k]==='controller_fan');
        if(tcfk&&tm[tcfk]!=null) { if(!tbHasToolheadFanHeader){config+=B(`工具板风扇/附加功能: ${tbName}`);tbHasToolheadFanHeader=true;} config+=`[controller_fan ${tbSectionName}_controller_fan]\npin: ${tbPin(tm[tcfk])}\nheater: heater_bed\nfan_speed: 0.8\n\n`; }
        const tefk=Object.keys(fa).find(k=>fa[k]==='exhaust_fan');
        if(tefk&&tm[tefk]!=null) { if(!tbHasToolheadFanHeader){config+=B(`工具板风扇/附加功能: ${tbName}`);tbHasToolheadFanHeader=true;} config+=`[heater_fan ${tbSectionName}_exhaust_fan]\npin: ${tbPin(tm[tefk])}\nheater: heater_bed\nheater_temp: 70\nfan_speed: 1.0\n\n`; }
        if(fa.__adxl==='adxl' && tm.lis2dw) {
            config+=B(`工具板 ADXL/共振测试: ${tbName}`);
            const lis=tm.lis2dw;
            config+='[lis2dw]\n';
            if(lis.spi_bus) config+=Array.isArray(lis.spi_bus) ? `spi_software_sclk_pin: ${tbPin(lis.spi_bus[1]||lis.spi_bus[0])}\nspi_software_mosi_pin: ${tbPin(lis.spi_bus[0]||lis.spi_bus[1])}\nspi_software_miso_pin: ${tbPin(lis.spi_bus[2]||lis.spi_bus[0])}\n` : `spi_bus: ${lis.spi_bus}\n`;
            if(lis.cs_pin) config+=`cs_pin: ${tbPin(lis.cs_pin)}\n`;
            config+='\n[resonance_tester]\n';
            config+=`accel_chip: lis2dw\n`;
            config+=`probe_points: ${document.getElementById('cgResTestPoints')?.value||'125,125,20'}\n\n`;
        } else if(fa.__adxl==='adxl') {
            config+=B(`工具板 ADXL/共振测试: ${tbName}`);
            config+='# TODO: 当前工具板映射未提供 lis2dw/adxl 引脚，请按板卡文档补充 [adxl345] 或 [lis2dw]\n\n';
        }
    });
    const toolboardConfig = cgFilterConfigByToolboards(config, true);
    if(outputMode === 'toolboard') {
        config = B('仅工具板配置片段') + (toolboardConfig || '# 未生成工具板片段：请先添加工具板并在对应功能页选择工具板接口。\n');
    } else if(outputMode === 'mainboard') {
        config = B('仅主板配置片段') + (cgFilterConfigByToolboards(config, false) || mainConfigBeforeToolboards);
    } else if(outputMode === 'merge') {
        config = B('与现有配置合并建议') + '# 请优先保留旧配置中的自定义宏、include、PID、网床和 SAVE_CONFIG 段。\n# 下方为本次生成结果；可点击“对比旧配置”查看 section 级差异。\n\n' + config;
    }
    // ---- 输出 ----
    document.getElementById('output').textContent = config;
    document.getElementById('downloadBtn').disabled = false;
    document.getElementById('copyBtn').disabled = false;
    document.getElementById('configStatus').innerHTML = '<span class="dot"></span><span>已生成</span>';
    document.getElementById('configStatus').classList.add('active');
    _cgCurrentConfig = config;
    cgShowToast('配置生成成功！');
    // 自动跳转到生成配置选项卡
    switchCgTab(6);
}
function downloadConfig() { const b=new Blob([_cgCurrentConfig],{type:'text/plain'}),u=URL.createObjectURL(b),a=document.createElement('a');a.href=u;a.download='printer.cfg';a.click();URL.revokeObjectURL(u);cgShowToast('配置已下载！'); }
function copyConfig() {
    try {
        // 优先使用 Clipboard API
        navigator.clipboard.writeText(_cgCurrentConfig).then(
            ()=>cgShowToast('已复制到剪贴板！'),
            ()=>fallbackCopy()
        );
    } catch(e) { fallbackCopy(); }
    function fallbackCopy() {
        const ta = document.createElement('textarea');
        ta.value = _cgCurrentConfig; ta.style.position='fixed'; ta.style.left='-9999px';
        document.body.appendChild(ta); ta.select();
        try { document.execCommand('copy'); cgShowToast('已复制到剪贴板！'); } catch(e) { cgShowToast('复制失败，请手动复制','error'); }
        document.body.removeChild(ta);
    }
}
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
    _currentMapping=null;_currentBoardInfo=null;_currentBoardLayout=null;_cgSelectedBoardPin='';_toolboardData=[];_cgCurrentConfig='';_cgImportedConfig='';_cgImportedToolboards=[];_currentPreset=null;_extraHeaterCount=0;
    resetConfigPanels(); populateBrands(); loadMachinePresets();
    document.getElementById('output').textContent='请完成配置后点击“生成配置”...';
    document.getElementById('downloadBtn').disabled=true;
    document.getElementById('copyBtn').disabled=true;
    document.getElementById('configStatus').innerHTML='<span class="dot"></span><span>未生成</span>';
    document.getElementById('configStatus').classList.remove('active');
    document.getElementById('errorMessage').style.display='none';
    const importPanel=document.getElementById('cgImportSummary'); if(importPanel){importPanel.style.display='none';importPanel.innerHTML='';}
    const diffPanel=document.getElementById('cgDiffSummary'); if(diffPanel){diffPanel.style.display='none';diffPanel.innerHTML='';}
    // 重置板卡图片
    _cgBoardImageUrl='';
    const imgC=document.getElementById('cgBoardImageContainer'); if(imgC) imgC.style.display='none';
    const img=document.getElementById('cgBoardImage'); if(img){img.onload=null;img.onerror=null;img.removeAttribute('src');}
    const serialSelect=document.getElementById('cgSerialSelect'); if(serialSelect) serialSelect.remove();
    const serialInput=document.getElementById('cgSerial'); if(serialInput){serialInput.style.display='';serialInput.value='';}
    cgShowToast('表单已重置！');
}
