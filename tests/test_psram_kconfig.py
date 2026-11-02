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
