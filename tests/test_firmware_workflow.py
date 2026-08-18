import hashlib
import io
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


class FirmwareValidationTests(unittest.TestCase):
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

    def test_dead_preset_advanced_form_is_removed(self):
        self.assertNotIn('compilePresetAdvanced', self.html)
        self.assertNotIn('compilePresetConnection', self.javascript)

    def test_upload_and_request_guards_are_wired(self):
        self.assertIn('/api/firmware/bl/upload', self.javascript)
        self.assertIn('id="compileFirmwareBtn"', self.html)
        self.assertIn('id="flashBootloaderBtn"', self.html)
        self.assertIn('_deviceScanRequestId', self.javascript)
        self.assertIn('_firmwarePageInitPromise', self.javascript)

    def test_manual_reconnect_escapes_server_error(self):
        self.assertIn("escapeHtml(data.error || '未知错误')", self.app_javascript)
        self.assertIn('clearHostKeys(true)', self.app_javascript)


if __name__ == '__main__':
    unittest.main()
