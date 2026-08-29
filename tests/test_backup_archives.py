import json
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest import mock

from flask import Flask


ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / 'src'
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

import routes_backup as backup


class ConfigFolderArchiveTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.base = Path(self.tempdir.name)
        self.config_dir = self.base / 'printer_data' / 'config'
        self.backup_dir = self.base / 'backups'
        self.config_dir.mkdir(parents=True)
        self.backup_dir.mkdir()

        (self.config_dir / 'printer.cfg').write_text(
            '[include macros/*.cfg]\n[mcu]\nserial: test\n',
            encoding='utf-8',
        )
        (self.config_dir / 'moonraker.conf').write_text(
            '[server]\nport: 7125\n', encoding='utf-8'
        )
        (self.config_dir / '.hidden').write_bytes(b'\x00hidden\xff')
        (self.config_dir / 'macros').mkdir()
        (self.config_dir / 'macros' / 'pause.cfg').write_text(
            '[gcode_macro PAUSE]\ngcode:\n', encoding='utf-8'
        )
        (self.config_dir / 'assets').mkdir()
        (self.config_dir / 'assets' / 'binary.dat').write_bytes(
            bytes(range(256))
        )
        (self.config_dir / 'empty').mkdir()

    def tearDown(self):
        self.tempdir.cleanup()

    def _create_archive(self):
        archive_path = self.backup_dir / 'snapshot_config.zip'
        with mock.patch.object(
            backup, '_find_local_config_root', return_value=str(self.config_dir)
        ):
            source, stats = backup._write_local_archive(str(archive_path))
        return archive_path, source, stats

    def test_entire_config_folder_is_archived_with_binary_and_empty_dirs(self):
        archive_path, source, stats = self._create_archive()
        self.assertEqual(source, 'local')
        self.assertEqual(stats['file_count'], 5)

        with zipfile.ZipFile(archive_path, 'r') as archive:
            names = set(archive.namelist())
            self.assertIn('config/printer.cfg', names)
            self.assertIn('config/moonraker.conf', names)
            self.assertIn('config/.hidden', names)
            self.assertIn('config/macros/pause.cfg', names)
            self.assertIn('config/assets/binary.dat', names)
            self.assertIn('config/empty/', names)
            self.assertEqual(
                archive.read('config/assets/binary.dat'), bytes(range(256))
            )

    def test_restore_overwrites_archive_files_without_deleting_extra_files(self):
        archive_path, _, stats = self._create_archive()
        (self.config_dir / 'printer.cfg').write_text('changed\n', encoding='utf-8')
        (self.config_dir / 'macros' / 'pause.cfg').unlink()
        (self.config_dir / 'extra.cfg').write_text('keep me\n', encoding='utf-8')

        with (
            mock.patch.object(backup, '_try_restore_via_moonraker', return_value=None),
            mock.patch.object(backup, 'is_ssh_mode', return_value=False),
            mock.patch.object(
                backup, '_find_local_config_root', return_value=str(self.config_dir)
            ),
        ):
            ok, source, restored = backup._restore_config_archive(
                str(archive_path)
            )

        self.assertTrue(ok)
        self.assertEqual(source, 'local')
        self.assertEqual(restored, stats['file_count'])
        self.assertIn(
            '[include macros/*.cfg]',
            (self.config_dir / 'printer.cfg').read_text(encoding='utf-8'),
        )
        self.assertTrue((self.config_dir / 'macros' / 'pause.cfg').is_file())
        self.assertEqual(
            (self.config_dir / 'assets' / 'binary.dat').read_bytes(),
            bytes(range(256)),
        )
        self.assertEqual(
            (self.config_dir / 'extra.cfg').read_text(encoding='utf-8'),
            'keep me\n',
        )

    def test_archive_rejects_path_traversal(self):
        archive_path = self.backup_dir / 'malicious.zip'
        with zipfile.ZipFile(archive_path, 'w') as archive:
            archive.writestr('config/printer.cfg', '[mcu]\n')
            archive.writestr('../outside.cfg', 'unsafe\n')
        with self.assertRaisesRegex(ValueError, '目录穿越'):
            backup._inspect_config_archive(str(archive_path))

    def test_restore_rejects_existing_symlink_that_escapes_config(self):
        archive_path = self.backup_dir / 'symlink-target.zip'
        outside_dir = self.base / 'outside'
        outside_dir.mkdir()
        (self.config_dir / 'linked').symlink_to(outside_dir, target_is_directory=True)
        with zipfile.ZipFile(archive_path, 'w') as archive:
            archive.writestr('config/printer.cfg', '[mcu]\n')
            archive.writestr('config/linked/escaped.cfg', 'unsafe\n')

        with mock.patch.object(
            backup, '_find_local_config_root', return_value=str(self.config_dir)
        ):
            with self.assertRaisesRegex(ValueError, '越界路径'):
                backup._restore_locally(str(archive_path))
        self.assertFalse((outside_dir / 'escaped.cfg').exists())

    def test_legacy_printer_cfg_backup_remains_readable(self):
        legacy_id = '20260101_010101_abcdef_printer.cfg'
        (self.backup_dir / legacy_id).write_text(
            '[printer]\nkinematics: none\n', encoding='utf-8'
        )
        with mock.patch.object(backup, 'BACKUP_DIR', str(self.backup_dir)):
            content = backup._read_backup_printer_cfg(legacy_id)
        self.assertIn('kinematics: none', content)

    def test_moonraker_file_list_supports_new_and_old_response_shapes(self):
        new_shape = {
            'result': [
                {'path': 'printer.cfg', 'size': 10, 'modified': 1},
                {'path': 'sub/a.cfg', 'size': 5, 'modified': 2},
            ]
        }
        old_shape = {
            'result': {
                'files': [
                    {'filename': 'printer.cfg', 'size': 10},
                    {'filename': 'sub/a.cfg', 'size': 5},
                ]
            }
        }
        expected = ['printer.cfg', 'sub/a.cfg']
        self.assertEqual(
            [item['path'] for item in backup._moonraker_file_entries(new_shape)],
            expected,
        )
        self.assertEqual(
            [item['path'] for item in backup._moonraker_file_entries(old_shape)],
            expected,
        )


class BackupApiCompatibilityTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.backup_dir = Path(self.tempdir.name)
        self.app = Flask(__name__)
        self.app.register_blueprint(backup.backup_bp)
        self.client = self.app.test_client()

    def tearDown(self):
        self.tempdir.cleanup()

    def test_create_list_download_and_restore_zip(self):
        backup_id = '20260101_010101_abcdef_config.zip'
        archive_path = self.backup_dir / backup_id
        with zipfile.ZipFile(archive_path, 'w') as archive:
            archive.writestr('config/printer.cfg', '[mcu]\nserial: test\n')
            archive.writestr('config/macros.cfg', '[gcode_macro TEST]\n')
        meta = {
            'filename': 'config.zip',
            'timestamp': '2026-01-01T01:01:01+0800',
            'source': 'moonraker',
            'format': backup.BACKUP_FORMAT,
            'sha256': backup._sha256_file(str(archive_path)),
            'size': archive_path.stat().st_size,
            'uncompressed_size': 48,
            'file_count': 2,
        }
        (self.backup_dir / f'{backup_id}.meta').write_text(
            json.dumps(meta), encoding='utf-8'
        )

        with mock.patch.object(backup, 'BACKUP_DIR', str(self.backup_dir)):
            listed = self.client.get('/api/backup/list').get_json()
            self.assertEqual(listed['backups'][0]['file_count'], 2)

            download = self.client.get(f'/api/backup/{backup_id}/download')
            self.assertEqual(download.status_code, 200)
            self.assertTrue(download.data.startswith(b'PK'))
            download.close()

            with mock.patch.object(
                backup,
                '_restore_config_archive',
                return_value=(True, 'moonraker', 2),
            ) as restore:
                response = self.client.post(
                    '/api/backup/rollback', json={'backup_id': backup_id}
                )
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.get_json()['file_count'], 2)
            restore.assert_called_once_with(str(archive_path))

            deleted = self.client.delete(f'/api/backup/{backup_id}')
            self.assertEqual(deleted.status_code, 200)
            self.assertFalse(archive_path.exists())
            self.assertFalse((self.backup_dir / f'{backup_id}.meta').exists())


if __name__ == '__main__':
    unittest.main()
