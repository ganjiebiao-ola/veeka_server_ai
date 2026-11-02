import pathlib
import shutil
import subprocess
import sys
import tempfile
import unittest


class SecretScanTest(unittest.TestCase):
    def scan(self, name, content):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            (root / "scripts").mkdir()
            source = pathlib.Path(__file__).resolve().parents[2] / "scripts/check-secret-scan"
            shutil.copyfile(source, root / "scripts/check-secret-scan")
            subprocess.run(["git", "init", "-q", tmp], check=True, capture_output=True)
            (root / name).write_text(content)
            subprocess.run(["git", "-C", tmp, "add", "--", name], check=True, capture_output=True)
            return subprocess.run([sys.executable, str(root / "scripts/check-secret-scan")], capture_output=True, text=True)

    def test_example_is_allowed_but_its_content_is_checked(self):
        self.assertEqual(self.scan(".env.example", "API_KEY=<your-key>\n").returncode, 0)
        self.assertEqual(self.scan(".env.example", "API_KEY=" + "a" * 24 + "\n").returncode, 1)

    def test_local_credential_filenames_still_fail(self):
        for name in (".env", ".env.local", ".env.example.local", "private.pem", "id_ed25519"):
            with self.subTest(name=name):
                self.assertEqual(self.scan(name, "placeholder\n").returncode, 1)

    def test_source_expressions_are_allowed(self):
        content = 'const password = getPassword()\nconst token = Deno.env.get("TOKEN")\n'
        content += 'const request = { authToken: undefined, apiKey: ANTHROPIC_API_KEY }\n'
        content += 'const labels = { "category.hardcoded-secret": "Hardcoded secret" }\n'
        content += 'const names = { apiKey: "ANTHROPIC_API_KEY", relayAuthToken: "OLA_AGENT_RELAY_AUTH_TOKEN" }\n'
        self.assertEqual(self.scan("source.ts", content).returncode, 0)

    def test_credential_literals_and_bare_config_values_fail(self):
        for content in ('const token = "' + "a" * 24 + '"\n',
                        'config.token = "' + "a" * 24 + '"\n',
                        '{"apiKey":"' + "a" * 24 + '"}\n',
                        'const apiKey = "' + "A" * 24 + '"\n',
                        "export API_KEY=" + "a" * 24 + "\n",
                        "password: " + "a" * 24 + "\n"):
            with self.subTest(content_type=content.split()[0]):
                self.assertEqual(self.scan("source.txt", content).returncode, 1)

    def test_high_signal_credentials_still_fail(self):
        samples = ("ghp_" + "a" * 30, "AKIA" + "A" * 16,
                   "-----BEGIN " + "RSA PRIVATE KEY-----\n")
        for index, sample in enumerate(samples):
            with self.subTest(index=index):
                self.assertEqual(self.scan("source.txt", sample).returncode, 1)


if __name__ == "__main__":
    unittest.main()
