"""Resolve the real application Kconfig with an unpatched HAL symbol definition."""
import os
import pathlib
import tempfile
import unittest
from unittest.mock import patch
try:
    import kconfiglib
except ImportError:
    kconfiglib = None
ROOT = pathlib.Path(__file__).resolve().parents[1]

@unittest.skipUnless(kconfiglib, 'kconfiglib is required (installed in host CI)')
class PsramKconfigTests(unittest.TestCase):
    def test_unpatched_hal_and_repeated_archive_configuration(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            # A custom module path without .git. No patching should be needed.
            hal = root / 'custom-hal'
            hal.mkdir()
            original = '''config SPIRAM_ALLOW_BSS_SEG_EXTERNAL_MEMORY
    bool
    default y if SOC_SERIES_ESP32
    default y if SOC_SERIES_ESP32S2
    default y if SOC_SERIES_ESP32S3
'''
            (hal / 'Kconfig').write_text(original)
            (root / 'Kconfig.zephyr').write_text(''.join(
                f'config {name}\n    bool "{name}"\n' for name in
                ['SOC_SERIES_ESP32', 'SOC_SERIES_ESP32S2', 'SOC_SERIES_ESP32S3',
                 'SOC_SERIES_ESP32C3', 'SOC_SERIES_ESP32C5', 'ESP_SPIRAM']) +
                f'source "{hal}/Kconfig"\n')
            with patch.dict(os.environ, {'srctree': tmp}):
                for _ in range(2):
                    for soc, psram, expected in [('ESP32C5', True, 'y'),
                            ('ESP32C5', False, 'n'), ('ESP32C3', False, 'n'),
                            ('ESP32', False, 'y')]:
                        with self.subTest(soc=soc, psram=psram):
                            conf = kconfiglib.Kconfig(str(ROOT / 'Kconfig'), warn=False)
                            conf.syms['SOC_SERIES_' + soc].set_value('y')
                            conf.syms['ESP_SPIRAM'].set_value('y' if psram else 'n')
                            self.assertEqual(conf.syms['SPIRAM_ALLOW_BSS_SEG_EXTERNAL_MEMORY'].str_value, expected)
            self.assertEqual((hal / 'Kconfig').read_text(), original)

    def test_rf_heap_defaults_fall_back_for_larger_custom_pools(self):
        pools = {
            'ESP32_WIFI_DYNAMIC_RX_BUFFER_NUM': 6,
            'ESP32_WIFI_DYNAMIC_TX_BUFFER_NUM': 6,
            'ESP32_WIFI_STATIC_RX_BUFFER_NUM': 6,
            'ESP32_WIFI_MGMT_SBUF_NUM': 6,
            'ESP32_BT_LE_MAX_CONNECTIONS': 2,
            'ESP32_BT_LE_MSYS_1_BLOCK_COUNT': 12,
            'ESP32_BT_LE_MSYS_1_BLOCK_SIZE': 256,
            'ESP32_BT_LE_MSYS_2_BLOCK_COUNT': 12,
            'ESP32_BT_LE_MSYS_2_BLOCK_SIZE': 320,
            'ESP32_BT_LE_ACL_BUF_COUNT': 8,
            'ESP32_BT_LE_ACL_BUF_SIZE': 255,
        }
        with tempfile.TemporaryDirectory() as tmp:
            definitions = ''.join(
                f'config {name}\n    bool "{name}"\n' for name in
                ['SOC_SERIES_ESP32C3', 'SOC_SERIES_ESP32C5', 'ESP_WIFI_HEAP_SYSTEM',
                 'ESP32_WIFI_DYNAMIC_TX_BUFFER', 'BT_ESP32'])
            definitions += ''.join(
                f'config {name}\n    int "{name}"\n    default {value}\n'
                for name, value in pools.items())
            definitions += ('config HEAP_MEM_POOL_ADD_SIZE_ESP_WIFI\n'
                            '    int\n    default 51200\n'
                            'config HEAP_MEM_POOL_ADD_SIZE_ESP_BT\n'
                            '    int\n    default 50000\n')
            (pathlib.Path(tmp) / 'Kconfig.zephyr').write_text(definitions)
            with patch.dict(os.environ, {'srctree': tmp}):
                cases = [
                    ('ESP32C3', {}, '40960', '50000'),
                    ('ESP32C3', {'ESP32_WIFI_DYNAMIC_RX_BUFFER_NUM': 9}, '51200', '50000'),
                    ('ESP32C3', {'ESP32_WIFI_DYNAMIC_TX_BUFFER': 'n'}, '51200', '50000'),
                    ('ESP32C3', {'ESP32_WIFI_STATIC_RX_BUFFER_NUM': 7}, '51200', '50000'),
                    ('ESP32C5', {}, '36864', '44000'),
                    ('ESP32C5', {'ESP32_WIFI_DYNAMIC_TX_BUFFER_NUM': 7}, '51200', '44000'),
                    ('ESP32C5', {'ESP32_BT_LE_ACL_BUF_SIZE': 517}, '36864', '50000'),
                    ('ESP32C5', {'ESP32_BT_LE_MSYS_2_BLOCK_COUNT': 24}, '36864', '50000'),
                    ('ESP32C5', {'ESP32_BT_LE_MAX_CONNECTIONS': 3}, '36864', '50000'),
                ]
                for soc, overrides, wifi_heap, bt_heap in cases:
                    with self.subTest(soc=soc, overrides=overrides):
                        conf = kconfiglib.Kconfig(str(ROOT / 'Kconfig'), warn=False)
                        conf.syms['SOC_SERIES_' + soc].set_value('y')
                        conf.syms['ESP_WIFI_HEAP_SYSTEM'].set_value('y')
                        conf.syms['ESP32_WIFI_DYNAMIC_TX_BUFFER'].set_value('y')
                        conf.syms['BT_ESP32'].set_value('y')
                        for name, value in overrides.items():
                            self.assertTrue(conf.syms[name].set_value(str(value)))
                        self.assertEqual(conf.syms['HEAP_MEM_POOL_ADD_SIZE_ESP_WIFI'].str_value, wifi_heap)
                        self.assertEqual(conf.syms['HEAP_MEM_POOL_ADD_SIZE_ESP_BT'].str_value, bt_heap)
