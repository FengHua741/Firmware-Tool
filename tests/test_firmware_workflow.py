import hashlib
import io
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from flask import Flask


ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / 'src'
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

import routes_firmware as firmware
import routes_system as system
import kconfig_can_parser as can_parser
import ssh_manager


class Sb2040V3PresetTests(unittest.TestCase):
    BOARD_IDS = ('sb2040-v3', 'sb2040-pro-v3')

    def _load_board(self, board_id):
        path = ROOT / 'board_configs' / 'FLY' / 'toolboard' / f'{board_id}.json'
        return json.loads(path.read_text(encoding='utf-8'))

    def test_v3_connection_profiles_match_fly_documentation(self):
        for board_id in self.BOARD_IDS:
            with self.subTest(board_id=board_id):
                board = self._load_board(board_id)
                self.assertEqual(board['connections'], ['CANBUS', 'RS232'])
                self.assertEqual(board['default_connection'], 'CAN bus')
                self.assertEqual(board['default_flash'], 'CAN')
                self.assertEqual(board['flash_modes'], ['CAN', 'UF2'])
                self.assertEqual(board['boot_pins'], '!gpio5,!gpio19,!gpio24')

                can = board['connection_profiles']['can']
                self.assertEqual(can['bl_offset'], '16384')
                self.assertEqual(can['config_symbol'], 'RPXXXX_CANBUS')
                self.assertEqual(can['can_gpio'], {'rx': 1, 'tx': 0})
                self.assertEqual(can['canbus_frequency'], '1000000')
                self.assertEqual(can['flash_mode'], 'CAN')

                serial = board['connection_profiles']['serial']
                self.assertEqual(serial['bl_offset'], '256')
                self.assertEqual(
                    serial['config_symbol'],
                    'RPXXXX_SERIAL_UART0_PINS_0_1',
                )
                self.assertEqual(serial['flash_mode'], 'UF2')


class FlyPresetDocumentationTests(unittest.TestCase):
    MAINBOARD_IDS = {
        'fly-c5', 'fly-c8', 'fly-c8p', 'fly-cdy-v3', 'fly-d5', 'fly-d7',
        'fly-d8-f407', 'fly-d8-h723', 'fly-dp5', 'fly-e3-ultra',
        'fly-e3-v2', 'fly-f407zg', 'fly-gemini-v3', 'fly-micro4',
        'fly-pro-x10', 'fly-rpfmex', 'fly-super5', 'fly-super8-pro',
        'fly-super8',
    }
    TOOLBOARD_EXPECTED = {
        'ercf': ('rp2040', '16384', ['CANBUS', 'USB'], 'gpio17', ['CAN', 'KAT'], 'CAN'),
        'ercfv2': ('rp2040', '16384', ['CANBUS', 'USB', 'RS232'], 'gpio17', ['CAN', 'KAT', 'UF2'], 'CAN'),
        'fly-sht36-v2-072': ('stm32f072', '8192', ['CANBUS'], '!PC13', ['CAN'], 'CAN'),
        'fly-usb-adxl': ('rp2040', '256', ['USB'], None, ['UF2'], 'UF2'),
        'fly-usb-lis2dw': ('rp2040', '256', ['USB'], 'gpio8', ['UF2'], 'UF2'),
        'mmu': ('stm32h723', '131072', ['CANBUS', 'USB', 'RS232'], '!PA15', ['CAN', 'KAT', 'DFU'], 'CAN'),
        'sb2040-pro-v3': ('rp2040', '16384', ['CANBUS', 'RS232'], '!gpio5,!gpio19,!gpio24', ['CAN', 'UF2'], 'CAN'),
        'sb2040-pro': ('rp2040', '16384', ['CANBUS'], 'gpio24', ['CAN'], 'CAN'),
        'sb2040-v3': ('rp2040', '16384', ['CANBUS', 'RS232'], '!gpio5,!gpio19,!gpio24', ['CAN', 'UF2'], 'CAN'),
        'sb2040': ('rp2040', '16384', ['CANBUS'], 'gpio24', ['CAN'], 'CAN'),
        'sht36': ('stm32f072', '8192', ['CANBUS'], None, ['CAN'], 'CAN'),
        'sht36_lis3dh': ('rp2040', '16384', ['CANBUS'], '!gpio20', ['CAN'], 'CAN'),
        'sht36_pro': ('rp2040', '16384', ['CANBUS'], '!gpio13', ['CAN'], 'CAN'),
        'sht36_v2': ('stm32f103', '8192', ['CANBUS'], '!PC13', ['CAN'], 'CAN'),
        'sht36_v3': ('rp2040', '16384', ['CANBUS', 'RS232'], '!gpio5', ['CAN', 'UF2'], 'CAN'),
        'tool-lite-232': ('rp2040', '256', ['RS232'], '!gpio18', ['UF2'], 'UF2'),
        'tool-lite': ('rp2040', '16384', ['CANBUS'], '!gpio18', ['CAN'], 'CAN'),
    }
    RP2040_CAN_GPIO = {
        'ercf': {'rx': 4, 'tx': 5},
        'ercfv2': {'rx': 1, 'tx': 0},
        'sb2040-pro-v3': {'rx': 1, 'tx': 0},
        'sb2040-pro': {'rx': 4, 'tx': 5},
        'sb2040-v3': {'rx': 1, 'tx': 0},
        'sb2040': {'rx': 4, 'tx': 5},
        'sht36_lis3dh': {'rx': 4, 'tx': 5},
        'sht36_pro': {'rx': 4, 'tx': 5},
        'sht36_v3': {'rx': 1, 'tx': 0},
        'tool-lite': {'rx': 1, 'tx': 0},
    }

    def _load_group(self, group):
        result = {}
        for path in sorted((ROOT / 'board_configs' / 'FLY' / group).glob('*.json')):
            board = json.loads(path.read_text(encoding='utf-8'))
            result[board['id']] = board
        return result

    def test_all_documented_fly_products_have_one_unambiguous_preset(self):
        mainboards = self._load_group('mainboard')
        toolboards = self._load_group('toolboard')
        self.assertEqual(set(mainboards), self.MAINBOARD_IDS)
        self.assertEqual(set(toolboards), set(self.TOOLBOARD_EXPECTED))
        self.assertEqual(toolboards['tool-lite']['name'], 'FLY-TOOL-LITE-CAN')
        self.assertEqual(toolboards['tool-lite-232']['name'], 'FLY-TOOL-LITE-232')
        self.assertEqual(toolboards['fly-usb-adxl']['name'], 'FLY-USB-ADXL')
        self.assertEqual(toolboards['fly-usb-lis2dw']['name'], 'FLY-USB-LIS2DW')

    def test_mainboards_match_fly_firmware_pages(self):
        boards = self._load_group('mainboard')
        mcu_groups = {
            ('stm32h723', '25000000', '131072'): {
                'fly-c5', 'fly-c8p', 'fly-d8-h723', 'fly-e3-ultra',
                'fly-pro-x10', 'fly-super5', 'fly-super8-pro',
            },
            ('stm32f407', '8000000', '32768'): {
                'fly-c8', 'fly-cdy-v3', 'fly-d8-f407', 'fly-e3-v2',
                'fly-f407zg', 'fly-super8',
            },
            ('stm32f405', '8000000', '32768'): {'fly-gemini-v3'},
            ('stm32f072', '8000000', '8192'): {'fly-d5', 'fly-d7', 'fly-dp5'},
            ('rp2040', '12000000', '16384'): {'fly-micro4', 'fly-rpfmex'},
        }
        for expected, board_ids in mcu_groups.items():
            for board_id in board_ids:
                with self.subTest(board_id=board_id, field='mcu-profile'):
                    board = boards[board_id]
                    self.assertEqual(
                        (board['mcu'], board['crystal'], board['bl_offset']),
                        expected,
                    )

        usb_only = {'fly-cdy-v3', 'fly-f407zg', 'fly-rpfmex'}
        host_flash = {'fly-c5', 'fly-c8', 'fly-c8p', 'fly-gemini-v3'}
        tf_flash = {
            'fly-cdy-v3', 'fly-e3-ultra', 'fly-e3-v2', 'fly-f407zg',
            'fly-super5', 'fly-super8-pro', 'fly-super8',
        }
        katapult_flash = {
            'fly-d5', 'fly-d7', 'fly-d8-f407', 'fly-d8-h723', 'fly-dp5',
            'fly-micro4', 'fly-pro-x10',
        }
        for board_id, board in boards.items():
            with self.subTest(board_id=board_id, field='declared-connections'):
                expected_connections = ['USB'] if board_id in usb_only else ['USB', 'USB转CAN']
                self.assertEqual(board['connections'], expected_connections)
                self.assertFalse(board.get('boot_pins'))
            if board_id in host_flash:
                expected_modes, expected_default = ['HOST'], 'HOST'
            elif board_id in tf_flash:
                expected_modes, expected_default = ['TF'], 'TF'
            elif board_id in katapult_flash:
                expected_modes, expected_default = ['KAT', 'CAN_BRIDGE_KAT'], 'KAT'
            else:
                expected_modes, expected_default = ['KAT'], 'KAT'
            with self.subTest(board_id=board_id, field='flash-modes'):
                self.assertEqual(board['flash_modes'], expected_modes)
                self.assertEqual(board['default_flash'], expected_default)

    def test_toolboards_match_fly_firmware_pages(self):
        boards = self._load_group('toolboard')
        for board_id, expected in self.TOOLBOARD_EXPECTED.items():
            with self.subTest(board_id=board_id):
                board = boards[board_id]
                actual = (
                    board['mcu'], board['bl_offset'], board['connections'],
                    board.get('boot_pins'), board['flash_modes'], board['default_flash'],
                )
                self.assertEqual(actual, expected)

    def test_declared_toolboard_connections_have_exact_profiles(self):
        connection_keys = {
            'CANBUS': 'can',
            'USB': 'usb',
            'RS232': 'serial',
            'USB转CAN': 'usbcanbridge',
        }
        boards = self._load_group('toolboard')
        for board_id, board in boards.items():
            profiles = board.get('connection_profiles') or {}
            expected_keys = {connection_keys[value] for value in board['connections']}
            with self.subTest(board_id=board_id, field='profile-keys'):
                self.assertEqual(set(profiles), expected_keys)
            for connection_type, profile in profiles.items():
                with self.subTest(board_id=board_id, connection=connection_type):
                    self.assertIn(profile['flash_mode'], board['flash_modes'])
                    self.assertTrue(profile.get('config_symbol'))
                    if connection_type == 'can':
                        self.assertEqual(profile['canbus_frequency'], '1000000')

        for board_id, expected_gpio in self.RP2040_CAN_GPIO.items():
            with self.subTest(board_id=board_id, field='can-gpio'):
                board = boards[board_id]
                self.assertEqual(board['can_gpio'], expected_gpio)
                self.assertEqual(board['connection_profiles']['can']['can_gpio'], expected_gpio)

    def test_rs232_profiles_use_documented_uart_and_no_bootloader(self):
        boards = self._load_group('toolboard')
        rp2040_serial = {
            'ercfv2', 'sb2040-pro-v3', 'sb2040-v3', 'sht36_v3',
            'tool-lite-232',
        }
        for board_id in rp2040_serial:
            with self.subTest(board_id=board_id):
                serial = boards[board_id]['connection_profiles']['serial']
                self.assertEqual(serial['bl_offset'], '256')
                self.assertEqual(serial['config_symbol'], 'RPXXXX_SERIAL_UART0_PINS_0_1')
                self.assertEqual(serial['flash_mode'], 'UF2')

        mmu_serial = boards['mmu']['connection_profiles']['serial']
        self.assertEqual(mmu_serial['bl_offset'], '0')
        self.assertEqual(mmu_serial['config_symbol'], 'STM32_SERIAL_USART1')
        self.assertEqual(mmu_serial['flash_mode'], 'DFU')


class SshRemoteSystemDetectionTests(unittest.TestCase):
    def _client_with_marker(self, marker):
        stdout = mock.Mock()
        stdout.read.return_value = marker.encode('utf-8')
        client = mock.Mock()
        client.exec_command.return_value = (None, stdout, None)
        return client

    def test_flyos_fast_is_detected_after_ssh_authentication(self):
        client = self._client_with_marker('flyos-fast')

        detected = ssh_manager.SSHManager._detect_remote_system(client)

        self.assertEqual(detected, 'flyos-fast')
        command = client.exec_command.call_args.args[0]
        self.assertIn('/etc/issue', command)
        self.assertIn('flyos-fast-ota', command)

    def test_other_ssh_targets_remain_generic_linux(self):
        client = self._client_with_marker('linux')

        detected = ssh_manager.SSHManager._detect_remote_system(client)

        self.assertEqual(detected, 'linux')


class FirmwareValidationTests(unittest.TestCase):
    def test_katapult_flashtool_falls_back_to_klipper_embedded_copy(self):
        embedded = '/data/klipper/lib/katapult/flashtool.py'
        with mock.patch.dict(firmware.config, {
            'katapult_path': '~/katapult',
            'klipper_path': '~/klipper',
        }), mock.patch.object(
            firmware, 'path_exists', side_effect=lambda path: path == embedded
        ):
            selected, checked = firmware._find_katapult_flashtool(
                '/data', '/data/klipper'
            )

        self.assertEqual(selected, embedded)
        self.assertIn('/data/katapult/scripts/flashtool.py', checked)
        self.assertIn(embedded, checked)

    def test_can_frequency_boundaries_and_suffixes(self):
        self.assertEqual(firmware._normalize_canbus_frequency('1m'), '1000000')
        self.assertEqual(firmware._normalize_canbus_frequency('500k'), '500000')
        self.assertEqual(firmware._normalize_canbus_frequency('10000'), '10000')
        self.assertEqual(firmware._normalize_canbus_frequency('5000000'), '5000000')
        for value in ('0', '9999', '5000001', 'fast'):
            with self.subTest(value=value), self.assertRaises(ValueError):
                firmware._normalize_canbus_frequency(value)

    def test_rp2040_gpio_validation(self):
        self.assertEqual(firmware._normalize_rp2040_gpio('0', 'RX'), '0')
        self.assertEqual(firmware._normalize_rp2040_gpio('29', 'TX'), '29')
        for value in ('-1', '30', '1.5', 'gpio4', ''):
            with self.subTest(value=value), self.assertRaises(ValueError):
                firmware._normalize_rp2040_gpio(value, 'GPIO')

    def test_dfu_identity_and_filter_preserve_unique_device(self):
        device_id = firmware._dfu_device_id('0483:df11', 'ABC 123', '1-2.3')
        self.assertEqual(device_id, 'dfu:0483:df11;serial=ABC%20123;path=1-2.3')
        command_filter = firmware._dfu_device_filter(device_id)
        self.assertIn('-d 0483:df11', command_filter)
        self.assertIn("-S 'ABC 123'", command_filter)
        self.assertIn('-p 1-2.3', command_filter)
        with self.assertRaises(ValueError):
            firmware._dfu_device_filter('dfu:not-a-device')

    def test_openocd_target_is_mcu_specific(self):
        self.assertEqual(firmware._openocd_target_for_mcu('STM32H723XX'), 'stm32h7x')
        self.assertEqual(firmware._openocd_target_for_mcu('stm32f072'), 'stm32f0x')
        self.assertEqual(firmware._openocd_target_for_mcu('rp2040'), '')

    def test_unknown_download_type_is_not_renamed_to_bin(self):
        self.assertEqual(firmware._firmware_download_name('/tmp/klipper.elf'), 'klipper.elf')

    def test_rp2040_can_defaults_to_16k_without_overwriting_real_value(self):
        detected = system._apply_can_mcu_defaults({
            'mcu_model': 'rp2040',
            'inferred_connection': 'CANBUS',
        })
        self.assertEqual(detected['bl_offset'], '16384')
        self.assertEqual(detected['bl_offset_hex'], '0x4000')
        self.assertEqual(detected['bl_offset_label'], '16 KB')
        self.assertEqual(detected['field_sources']['bl_offset'], 'mcu_can_default')

        real = system._apply_can_mcu_defaults({
            'mcu_model': 'rp2040',
            'inferred_connection': 'CANBUS',
            'bl_offset': '32768',
        })
        self.assertEqual(real['bl_offset'], '32768')


class DynamicCommunicationCapabilityTests(unittest.TestCase):
    KCONFIG = '''
if MACH_STM32
choice
    prompt "Processor model"
    config MACH_STM32X999
        bool "STM32X999"
        select MACH_STM32H5
endchoice
config MACH_STM32H5
    bool
config HAVE_STM32_USBFS
    bool
    default y if MACH_STM32H5
config HAVE_STM32_FDCANBUS
    bool
    default y if MACH_STM32H5
config HAVE_STM32_USBCANBUS
    bool
    depends on HAVE_STM32_USBFS && HAVE_STM32_FDCANBUS
    default y
choice
    prompt "Communication interface"
    config STM32_USB_FLEX
        bool "USB"
        depends on HAVE_STM32_USBFS
        select USBSERIAL
    config STM32_SERIAL_FLEX
        bool "Flexible UART"
        select SERIAL
    config STM32_CANBUS_FLEX
        bool "Flexible CAN"
        depends on HAVE_STM32_FDCANBUS
        select CANSERIAL
    config STM32_USBCANBUS_FLEX
        bool "USB to CAN bridge"
        depends on HAVE_STM32_USBCANBUS
        select USBCANBUS
endchoice
if STM32_SERIAL_FLEX
choice
    prompt "UART peripheral"
    config STM32_FLEX_USART1
        bool "USART1"
endchoice
endif
if STM32_FLEX_USART1
choice
    prompt "UART RX pin"
    config STM32_FLEX_RX_PA10
        bool "PA10"
endchoice
choice
    prompt "UART TX pin"
    config STM32_FLEX_TX_PA9
        bool "PA9"
endchoice
endif
endif
'''

    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        stm32_dir = Path(self.tempdir.name) / 'src' / 'stm32'
        stm32_dir.mkdir(parents=True)
        (stm32_dir / 'Kconfig').write_text(self.KCONFIG, encoding='utf-8')

    def tearDown(self):
        self.tempdir.cleanup()

    def test_new_mcu_uses_kconfig_capabilities_without_static_registration(self):
        parsed = can_parser.parse_can_options(self.tempdir.name)['stm32']
        self.assertFalse(hasattr(can_parser, 'PROCESSOR_CAPABILITIES'))
        self.assertEqual(
            {'usb', 'serial', 'can', 'usbcanbridge'},
            {
                option['comm_type']
                for option in parsed['communication_options']
                if 'STM32X999' in option['compatible_processors']
            },
        )
        self.assertTrue(all(
            option['compatibility_resolved']
            for option in parsed['communication_options']
        ))
        self.assertIn('HAVE_STM32_USBCANBUS', parsed['processor_capabilities']['STM32X999'])

    def test_generic_nested_communication_choices_are_parsed_and_validated(self):
        parsed = can_parser.parse_can_options(self.tempdir.name)['stm32']
        self.assertEqual(
            ['UART peripheral', 'UART RX pin', 'UART TX pin'],
            [choice['prompt'] for choice in parsed['communication_subchoices']],
        )
        condition_parser = can_parser.KlipperKconfigParser(self.tempdir.name)
        symbols, _ = firmware._resolve_communication_extra_symbols(
            parsed,
            'STM32X999',
            'STM32_SERIAL_FLEX',
            '',
            ['STM32_FLEX_USART1', 'STM32_FLEX_RX_PA10', 'STM32_FLEX_TX_PA9'],
            condition_parser,
        )
        self.assertEqual(symbols, [
            'STM32_FLEX_USART1',
            'STM32_FLEX_RX_PA10',
            'STM32_FLEX_TX_PA9',
        ])

        with self.assertRaisesRegex(ValueError, '必须且只能选择一项'):
            firmware._resolve_communication_extra_symbols(
                parsed,
                'STM32X999',
                'STM32_SERIAL_FLEX',
                '',
                ['STM32_FLEX_USART1', 'STM32_FLEX_RX_PA10'],
                condition_parser,
            )


class KlipperVersionTests(unittest.TestCase):
    def test_version_placeholder_is_rejected(self):
        for value in ('', '?', 'unknown', None):
            with self.subTest(value=value):
                self.assertEqual(system._normalize_klipper_version(value), '')
        self.assertEqual(
            system._normalize_klipper_version('v1.4.0-g7a684b0850\n'),
            'v1.4.0-g7a684b0850'
        )

    def test_packaged_klipper_uses_embedded_source_version(self):
        def fake_exists(path):
            return path in ('/data/klipper', '/data/klipper/klippy/util.py')

        completed = type('Completed', (), {
            'returncode': 0,
            'stdout': 'v1.4.0-g7a684b0850\n',
            'stderr': '',
        })()
        with mock.patch.object(system, 'path_exists', side_effect=fake_exists), \
                mock.patch.object(system, 'run_cmd', return_value=completed) as run:
            version, source = system._detect_klipper_version('/data/klipper')

        self.assertEqual(version, 'v1.4.0-g7a684b0850')
        self.assertEqual(source, 'packaged_source')
        self.assertEqual(run.call_args.args[0][0], 'python3')

    def test_missing_klipper_is_distinct_from_unknown_version(self):
        with mock.patch.object(system, 'path_exists', return_value=False):
            self.assertEqual(system._detect_klipper_version('/missing'), ('', 'missing'))


class ManifestAndPlanTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.firmware_path = os.path.join(self.tempdir.name, 'klipper.bin')
        with open(self.firmware_path, 'wb') as output:
            output.write(b'valid firmware image')
        payload = Path(self.firmware_path).read_bytes()
        self.manifest = {
            'firmware': {
                'path': self.firmware_path,
                'size': len(payload),
                'sha256': hashlib.sha256(payload).hexdigest(),
                'ext': '.bin',
            },
            'build': {
                'bl_offset': '0',
                'flash_application_address': '0x08000000',
                'comm_type': 'usb',
            },
            'board': {},
        }
        self.patches = (
            mock.patch.object(firmware, 'is_ssh_mode', return_value=False),
            mock.patch.object(firmware, 'path_exists', side_effect=os.path.exists),
            mock.patch.object(firmware, 'get_file_size', side_effect=os.path.getsize),
            mock.patch.object(firmware, 'expand_klipper_path', side_effect=lambda value, **_: value),
        )
        for patcher in self.patches:
            patcher.start()

    def tearDown(self):
        for patcher in reversed(self.patches):
            patcher.stop()
        self.tempdir.cleanup()

    def test_valid_manifest_allows_selected_dfu_device(self):
        plan = firmware._flash_plan(
            self.manifest, self.firmware_path, 'DFU', 'dfu:0483:df11;serial=ABC'
        )
        self.assertTrue(plan['manifest_valid'])
        self.assertTrue(plan['ok'])
        self.assertEqual(plan['dfu_address'], '0x08000000')

    def test_stale_manifest_cannot_supply_flash_address(self):
        stale = dict(self.manifest)
        stale['firmware'] = dict(self.manifest['firmware'], sha256='0' * 64)
        plan = firmware._flash_plan(stale, self.firmware_path, 'DFU', 'dfu:0483:df11')
        self.assertFalse(plan['manifest_valid'])
        self.assertFalse(plan['ok'])
        self.assertEqual(plan['dfu_address'], '')
        self.assertTrue(any('重新编译' in error for error in plan['errors']))

    def test_device_type_is_required_for_dfu_and_uf2(self):
        missing_dfu = firmware._flash_plan(self.manifest, self.firmware_path, 'DFU', '')
        self.assertFalse(missing_dfu['ok'])
        self.assertTrue(any('DFU 设备' in error for error in missing_dfu['errors']))

        uf2_path = os.path.join(self.tempdir.name, 'klipper.uf2')
        Path(uf2_path).write_bytes(b'uf2')
        wrong_uf2_device = firmware._flash_plan(None, uf2_path, 'UF2', 'dfu:0483:df11')
        self.assertFalse(wrong_uf2_device['ok'])
        self.assertTrue(any('BOOT' in error for error in wrong_uf2_device['errors']))

        wrong_kat_device = firmware._flash_plan(
            self.manifest, self.firmware_path, 'KAT', 'dfu:0483:df11'
        )
        self.assertFalse(wrong_kat_device['ok'])
        self.assertTrue(any('Katapult' in error for error in wrong_kat_device['errors']))

    def test_tf_mode_rejects_non_bin_file(self):
        uf2_path = os.path.join(self.tempdir.name, 'klipper.uf2')
        Path(uf2_path).write_bytes(b'uf2')
        plan = firmware._flash_plan(None, uf2_path, 'TF', '')
        self.assertFalse(plan['ok'])
        self.assertTrue(any('.bin' in error for error in plan['errors']))

    def test_connection_profile_flash_mode_survives_compile_recommendation(self):
        manifest = dict(self.manifest)
        manifest['build'] = {
            'bl_offset': '16384',
            'comm_type': 'usb',
            'selected_flash_mode': 'KAT',
        }
        manifest['board'] = {
            'default_flash': 'CAN',
            'flash_modes': ['CAN', 'KAT'],
        }
        self.assertEqual(firmware._recommended_flash_mode(manifest), 'KAT')

        manifest['build']['selected_flash_mode'] = 'UF2'
        self.assertEqual(firmware._recommended_flash_mode(manifest), 'CAN')


class BootloaderUploadTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.upload_patch = mock.patch.object(firmware, 'BL_UPLOAD_DIR', self.tempdir.name)
        self.ssh_patch = mock.patch.object(firmware, 'is_ssh_mode', return_value=False)
        self.upload_patch.start()
        self.ssh_patch.start()
        app = Flask(__name__)
        app.register_blueprint(firmware.firmware_bp)
        app.config['TESTING'] = True
        self.client = app.test_client()

    def tearDown(self):
        self.ssh_patch.stop()
        self.upload_patch.stop()
        self.tempdir.cleanup()

    def test_upload_accepts_bin_and_uses_content_hash_name(self):
        response = self.client.post(
            '/api/firmware/bl/upload',
            data={'file': (io.BytesIO(b'bootloader'), 'katapult.bin')},
            content_type='multipart/form-data',
        )
        self.assertEqual(response.status_code, 200)
        data = response.get_json()
        self.assertTrue(data['success'])
        self.assertTrue(os.path.isfile(data['file']['path']))
        self.assertRegex(data['file']['stored_name'], r'^katapult-[0-9a-f]{12}\.bin$')

    def test_upload_rejects_unsupported_extension(self):
        response = self.client.post(
            '/api/firmware/bl/upload',
            data={'file': (io.BytesIO(b'bad'), 'bootloader.txt')},
            content_type='multipart/form-data',
        )
        self.assertEqual(response.status_code, 400)

    def test_uf2_flash_precheck_rejects_wrong_device(self):
        path = os.path.join(self.tempdir.name, 'katapult.uf2')
        Path(path).write_bytes(b'uf2')
        response = self.client.post('/api/firmware/bl/flash', json={
            'bl_firmware_path': path,
            'flash_mode': 'UF2',
            'platform_key': 'rp2040',
            'device_id': 'dfu:0483:df11',
        })
        self.assertEqual(response.status_code, 400)
        self.assertIn('BOOTSEL', response.get_json()['error'])

    def test_bl_detect_returns_tools_and_stlink_programmers(self):
        detected = {
            'tools': {'dfu-util': {'available': True, 'path': '/usr/bin/dfu-util'}},
            'programmers': [{
                'id': 'stlink:serial=ABC123',
                'name': 'ST-Link (SN: ABC123)',
                'type': 'stlink',
                'serial': 'ABC123',
                'supported_tools': ['st-flash'],
            }],
            'warnings': [],
        }
        with mock.patch.object(firmware, '_detect_bl_programmers', return_value=detected):
            response = self.client.get('/api/firmware/bl/detect')
        self.assertEqual(response.status_code, 200)
        data = response.get_json()
        self.assertTrue(data['success'])
        self.assertEqual(data['programmers'][0]['id'], 'stlink:serial=ABC123')

    def test_stlink_parser_disables_untargetable_probe_when_multiple(self):
        sysfs = (
            '0483:374b\t\tST-LINK/V2\t1-1\n'
            '0483:374b\tABC123\tST-LINK/V2\t1-2\n'
        )
        devices = firmware._parse_stlink_programmers(sysfs, '', ['st-flash', 'openocd'])
        self.assertEqual(len(devices), 2)
        no_serial = next(device for device in devices if not device['serial'])
        with_serial = next(device for device in devices if device['serial'])
        self.assertFalse(no_serial['targetable'])
        self.assertEqual(no_serial['supported_tools'], [])
        self.assertTrue(with_serial['targetable'])

    def test_stlink_flash_precheck_requires_detected_device(self):
        path = os.path.join(self.tempdir.name, 'katapult.bin')
        Path(path).write_bytes(b'bootloader')
        response = self.client.post('/api/firmware/bl/flash', json={
            'bl_firmware_path': path,
            'flash_mode': 'st-flash',
            'platform_key': 'stm32',
            'device_id': '',
        })
        self.assertEqual(response.status_code, 400)
        self.assertIn('ST-Link', response.get_json()['error'])

    def test_stflash_uses_selected_stlink_serial(self):
        path = os.path.join(self.tempdir.name, 'katapult.bin')
        Path(path).write_bytes(b'bootloader')
        command_result = mock.Mock(returncode=0, stdout='ok', stderr='')
        with mock.patch.object(firmware, 'run_cmd', return_value=command_result) as run_cmd:
            response = self.client.post('/api/firmware/bl/flash', json={
                'bl_firmware_path': path,
                'flash_mode': 'st-flash',
                'platform_key': 'stm32',
                'device_id': 'stlink:serial=ABC123',
                'dfu_address': '0x08000000',
                'erase_flash': False,
            })
        self.assertEqual(response.status_code, 200)
        self.assertIn('--serial ABC123', run_cmd.call_args.args[0])

    def test_bl_flash_lock_rejects_duplicate_request(self):
        firmware._bl_flash_lock.acquire()
        try:
            response = self.client.post('/api/firmware/bl/flash', json={})
        finally:
            firmware._bl_flash_lock.release()
        self.assertEqual(response.status_code, 409)


class FrontendContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.html = (ROOT / 'static' / 'index.html').read_text(encoding='utf-8')
        cls.javascript = (ROOT / 'static' / 'js' / 'firmware-compile.js').read_text(encoding='utf-8')
        cls.app_javascript = (ROOT / 'static' / 'js' / 'app.js').read_text(encoding='utf-8')

    def test_all_backend_flash_modes_are_selectable(self):
        for mode in ('DFU', 'KAT', 'CAN', 'UF2', 'TF', 'CAN_BRIDGE_DFU', 'CAN_BRIDGE_KAT'):
            with self.subTest(mode=mode):
                self.assertIn(f'value="{mode}"', self.html)

    def test_preset_advanced_and_connection_filter_are_wired(self):
        self.assertIn('id="compilePresetAdvancedBtn"', self.html)
        self.assertIn('id="compilePresetConnectionWarning"', self.html)
        self.assertIn('toggleCompilePresetAdvanced', self.javascript)
        self.assertIn('_filterPresetCommunicationOptions', self.javascript)
        self.assertIn('_applyCompilePresetConnectionProfile', self.javascript)
        self.assertIn('declaredOrder', self.javascript)
        self.assertIn("normalized.includes('RS232')", self.javascript)
        self.assertIn("compileParams.flash_mode", self.javascript)

    def test_upload_and_request_guards_are_wired(self):
        self.assertIn('/api/firmware/bl/upload', self.javascript)
        self.assertIn('id="compileFirmwareBtn"', self.html)
        self.assertIn('id="flashBootloaderBtn"', self.html)
        self.assertIn('_deviceScanRequestId', self.javascript)
        self.assertIn('_firmwarePageInitPromise', self.javascript)

    def test_bl_device_detection_and_compatibility_are_wired(self):
        self.assertIn('id="blDeviceSelect"', self.html)
        self.assertIn('id="detectBlDevicesBtn"', self.html)
        self.assertIn('id="blDeviceDetectHint"', self.html)
        self.assertIn('/api/firmware/bl/detect', self.javascript)
        self.assertIn('detectBlFlashDevices', self.javascript)
        self.assertIn('_buildBlCompatibility', self.javascript)
        self.assertIn("document.getElementById('blDeviceSelect')", self.javascript)
        self.assertNotIn('<option value="st-flash">', self.html)
        self.assertNotIn('<option value="openocd">', self.html)

    def test_manual_reconnect_escapes_server_error(self):
        self.assertIn("escapeHtml(data.error || '未知错误')", self.app_javascript)
        self.assertIn('clearHostKeys(true)', self.app_javascript)

    def test_project_update_feature_is_removed(self):
        self.assertNotIn('项目更新', self.html)
        self.assertNotIn('checkForUpdates', self.app_javascript)
        self.assertNotIn('/api/system/update', self.app_javascript)


if __name__ == '__main__':
    unittest.main()
