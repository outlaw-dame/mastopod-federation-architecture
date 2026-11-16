import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("prepare", HERE / "prepare.py")
prepare = importlib.util.module_from_spec(spec)
spec.loader.exec_module(prepare)


class PreparationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory(prefix="paper staging tests ")
        cls.output = Path(cls.temporary.name) / "review"
        prepare.prepare(cls.output)

    @classmethod
    def tearDownClass(cls):
        cls.temporary.cleanup()

    def test_second_preparation_cannot_rotate_existing_credentials(self):
        before = (self.output / "secrets/runtime").read_bytes()
        with self.assertRaises(FileExistsError):
            prepare.prepare(self.output)
        self.assertEqual(before, (self.output / "secrets/runtime").read_bytes())

    def test_credentials_are_private_and_not_in_manifest(self):
        manifest = (self.output / "compose.json").read_text()
        for name in ("admin", "runtime"):
            path = self.output / "secrets" / name
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertNotIn(path.read_text().strip(), manifest)
        self.assertNotEqual((self.output / "secrets/admin").read_bytes(),
                            (self.output / "secrets/runtime").read_bytes())

    def test_certificate_rejects_wrong_hostname(self):
        result = subprocess.run(["openssl", "verify", "-CAfile", str(self.output / "certificates/ca.crt"),
                                 "-verify_hostname", "attacker.test", str(self.output / "certificates/server.crt")],
                                capture_output=True, timeout=10)
        self.assertNotEqual(result.returncode, 0)

    def test_sources_are_exact_pinned_schema_and_no_public_ports(self):
        lock = json.loads((self.output / "lock.json").read_text())
        expected = subprocess.check_output(["git", "-C", str(prepare.REPO), "show",
            lock["federation"] + ":fedify-sidecar/sql/entryway-control-plane-v1.sql"], timeout=10)
        self.assertEqual(expected, (self.output / "build/fedify-sidecar/sql/entryway-control-plane-v1.sql").read_bytes())
        compose = json.loads((self.output / "compose.json").read_text())
        for service in compose["services"].values():
            self.assertNotIn("ports", service)
            self.assertNotIn("privileged", service)
            self.assertNotIn("container_name", service)
        self.assertTrue(compose["networks"]["authority"]["internal"])


if __name__ == "__main__":
    unittest.main()
