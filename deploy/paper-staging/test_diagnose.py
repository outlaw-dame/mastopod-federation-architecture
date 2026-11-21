"""No diagnostics may disclose ordinary or protected staging passwords."""
import importlib.util
from pathlib import Path
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("diagnose", HERE / "diagnose.py")
diagnose = importlib.util.module_from_spec(spec)
spec.loader.exec_module(diagnose)


class SecretRedactionTests(unittest.TestCase):
    def test_nested_protected_and_shiro_secrets_are_redacted(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "provider.json").write_text(
                '{"SEMAPPS_JENA_PASSWORD":"ordinary-deadbeef12345678"}')
            (root / "protected-access.json").write_text(
                '{"provisioner":{"username":"paper-protected-provisioner",'
                '"password":"private-admin-1234567890"},'
                '"projector":{"password":"private-projection-1234567890"},'
                '"attestor":{"password":"private-attestor-1234567890"}}')
            (root / "protected-shiro.ini").write_text(
                "[users]\npaper-protected-provisioner = "
                "private-admin-1234567890, admins\n"
                "paper-protected-projector = private-projection-1234567890, projectors\n")
            values = diagnose.private_values(root)
            for secret in ["ordinary-deadbeef12345678", "private-admin-1234567890",
                           "private-projection-1234567890", "private-attestor-1234567890"]:
                self.assertIn(secret, values)
                self.assertNotIn(secret, diagnose.redact("before " + secret + " after", values))
            self.assertEqual(diagnose.redact("safe", values), "safe")

    def test_unreadable_secret_inventory_cannot_trigger_log_dump(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "PREPARED").write_text("prepared")
            (root / "secrets").mkdir()
            (root / "secrets" / "broken.json").write_text('{"password":')
            from unittest.mock import patch
            with patch.object(diagnose.subprocess, "run") as runner:
                diagnose.diagnose(root)
                runner.assert_not_called()


if __name__ == "__main__":
    unittest.main()
