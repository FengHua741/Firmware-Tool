// MCU 预设型号配置 - 英文格式

const MCU_PRESETS = {
    'STM32': [
        // STM32F1 系列
        { id: 'stm32f103', name: 'STM32F103 (Cortex-M3 @ 72MHz)', mcu: 'stm32f103xe', crystal: '8000000', bl_offset: '8192', flash_modes: ['DFU'], default_flash: 'DFU' },
        
        // STM32F4 系列
        { id: 'stm32f401', name: 'STM32F401 (Cortex-M4 @ 84MHz)', mcu: 'stm32f401xc', crystal: '8000000', bl_offset: '16384', flash_modes: ['DFU', 'KAT'], default_flash: 'DFU' },
        { id: 'stm32f405', name: 'STM32F405 (Cortex-M4 @ 168MHz)', mcu: 'stm32f405xx', crystal: '8000000', bl_offset: '16384', flash_modes: ['DFU', 'KAT'], default_flash: 'DFU' },
        { id: 'stm32f407', name: 'STM32F407 (Cortex-M4 @ 168MHz)', mcu: 'stm32f407xx', crystal: '8000000', bl_offset: '16384', flash_modes: ['DFU', 'KAT', 'CAN'], default_flash: 'DFU' },
        { id: 'stm32f411', name: 'STM32F411 (Cortex-M4 @ 100MHz)', mcu: 'stm32f411xe', crystal: '8000000', bl_offset: '16384', flash_modes: ['DFU', 'KAT'], default_flash: 'DFU' },
        { id: 'stm32f429', name: 'STM32F429 (Cortex-M4 @ 180MHz)', mcu: 'stm32f429xx', crystal: '8000000', bl_offset: '16384', flash_modes: ['DFU', 'KAT'], default_flash: 'DFU' },
        { id: 'stm32f446', name: 'STM32F446 (Cortex-M4 @ 180MHz)', mcu: 'stm32f446xx', crystal: '8000000', bl_offset: '16384', flash_modes: ['DFU', 'KAT'], default_flash: 'DFU' },
        
        // STM32H7 系列
        { id: 'stm32h723', name: 'STM32H723 (Cortex-M7 @ 550MHz)', mcu: 'stm32h723xx', crystal: '25000000', bl_offset: '32768', flash_modes: ['DFU', 'KAT'], default_flash: 'DFU' },
        { id: 'stm32h743', name: 'STM32H743 (Cortex-M7 @ 480MHz)', mcu: 'stm32h743xx', crystal: '25000000', bl_offset: '32768', flash_modes: ['DFU', 'KAT'], default_flash: 'DFU' },
        { id: 'stm32h750', name: 'STM32H750 (Cortex-M7 @ 480MHz)', mcu: 'stm32h750xx', crystal: '25000000', bl_offset: '32768', flash_modes: ['DFU', 'KAT'], default_flash: 'DFU' },
        
        // STM32G0 系列
        { id: 'stm32g0b1', name: 'STM32G0B1 (Cortex-M0+ @ 64MHz)', mcu: 'stm32g0b1xx', crystal: '8000000', bl_offset: '8192', flash_modes: ['DFU', 'KAT'], default_flash: 'DFU' },
        
        // STM32L4 系列
        { id: 'stm32l432', name: 'STM32L432 (Cortex-M4 @ 80MHz)', mcu: 'stm32l432xx', crystal: '8000000', bl_offset: '16384', flash_modes: ['DFU'], default_flash: 'DFU' },
        { id: 'stm32l433', name: 'STM32L433 (Cortex-M4 @ 80MHz)', mcu: 'stm32l433xx', crystal: '8000000', bl_offset: '16384', flash_modes: ['DFU'], default_flash: 'DFU' }
    ],
    
    'RP2040': [
        { id: 'rp2040', name: 'Raspberry Pi RP2040 (Dual Cortex-M0+ @ 125MHz)', mcu: 'rp2040', crystal: '12000000', bl_offset: '256', flash_modes: ['UF2', 'KAT'], default_flash: 'UF2' }
    ]
};

// 获取主控类型列表
function getMCUTypes() {
    return Object.keys(MCU_PRESETS);
}

// 根据主控类型获取型号列表
function getMCUModels(mcuType) {
    return MCU_PRESETS[mcuType] || [];
}

// 根据型号 ID 获取详细配置
function getMCUPreset(mcuType, modelId) {
    const models = MCU_PRESETS[mcuType] || [];
    return models.find(m => m.id === modelId);
}
