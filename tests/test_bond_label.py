"""Host tests of the real bond label storage and its `bonds label` commands."""
import pathlib
import re
import subprocess
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]


class BondLabelTests(unittest.TestCase):
    def test_storage_and_commands(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = pathlib.Path(tmp)
            for name, source in (
                ('bond_label_production.inc', 'src/bond_label.c'),
                ('bond_production.inc', 'src/bond_manager.c'),
            ):
                text = (ROOT / source).read_text()
                (path / name).write_text(
                    re.sub(r'^#include[^\n]*\n', '', text, flags=re.M)
                )
            binary = path / 'test'
            subprocess.run(
                ['cc', '-std=c11', '-Wall', '-Wextra', '-Werror', '-I', tmp,
                 str(ROOT / 'tests/bond_label_harness.c'), '-o', str(binary)],
                check=True,
            )
            subprocess.run([str(binary)], check=True)
