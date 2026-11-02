"""Redaction rules — the shapes that actually leaked, and the shapes that must never be touched.

Two jobs. First, every case here is a real form seen in archived SRE output, so a rule cannot be
dropped without a red test. Second, `test_rule_names_match_the_engine` pins the rule set against the
Go engine (ola-sre-agent orchestrator/internal/egress/egress.go): this file is a hand-maintained port
and it has already drifted once — argv-secret and keyed-secret were added upstream after a real AK
leak and never reached this copy. Update both sides in the same change.
"""
import unittest

from lib import scrub as S


# Random-looking values below are fabricated for the tests; none is a real credential.
FAKE = "Xj3kQp9wRt2mLn7vBc4dEf8hYz1a"


class SecretTest(unittest.TestCase):
    def names(self, text):
        _, findings = S.scrub(text)
        return sorted({f["name"] for f in findings})

    def test_bare_secret_shapes_are_caught(self):
        """The 2026-08-27 regression: a toolset put the key in argv and the agent echoed it back."""
        self.assertIn("argv-secret", self.names("aliyun dts --access-key-secret " + FAKE + " --region x"))
        self.assertIn("keyed-secret", self.names('{"client_secret":"' + FAKE + '"}'))
        self.assertIn("keyed-secret", self.names("access_key_secret = " + FAKE))

    def test_third_party_signin_credentials(self):
        jwt = "eyJraWQiOiJNRjkyOEE." + "eyJpc3MiOiJodHRwczovL2FwcGxlIn0" + "." + FAKE
        _, findings = S.scrub("id_token " + jwt)
        self.assertTrue(findings, "a sign-in token must be caught")
        self.assertTrue(all(f["blocked"] for f in findings), "a credential blocks, never merely redacts")

    def test_bare_jwt_without_a_key_name(self):
        jwt = "eyJhbGciOiJSUzI1NiJ9." + "eyJzdWIiOiIxMjM0NTY3ODkwIn0" + "." + FAKE
        self.assertIn("jwt", self.names("Authorization payload was " + jwt))

    def test_cookie_header(self):
        self.assertIn("cookie-header", self.names("Cookie: sessionid=" + FAKE + "; path=/"))

    def test_secrets_block_and_pii_does_not(self):
        _, findings = S.scrub("uid 824862702")
        self.assertTrue(findings)
        self.assertFalse(any(f["blocked"] for f in findings), "a user id is redacted, not blocking")

    def test_cjk_prose_is_never_mistaken_for_a_key(self):
        """A false positive here blocks a whole report, so the value charset stays ASCII-random."""
        for text in ("这次故障的根因是数据库连接超时，需要检查保活名单配置是否缺失",
                     "处置口径：命中已知模式判 PASS，不深挖、不开 PR",
                     "token 的取值需要人工确认"):
            self.assertEqual(self.names(text), [], text)


class UserIdTest(unittest.TestCase):
    def names(self, text):
        _, findings = S.scrub(text)
        return sorted({f["name"] for f in findings})

    def test_every_shape_seen_in_real_reports(self):
        for text in ('{"userId": "824841487"}',      # JSON, quote before the colon
                     "uid=810254164",                 # the shape the original pattern covered
                     "同一用户 uid 824862702",         # no separator at all
                     "blid 819330023",                # this platform's own id
                     '"memberId": 824213437'):
            self.assertIn("uid", self.names(text), text)

    def test_identifiers_and_short_numbers_are_left_alone(self):
        for text in ("uid12345abc 是变量名",   # \b keeps an identifier out
                     "uid 42",                 # too short to be a user id
                     "窗内共 424 条，421 条 200",
                     "epoch 1788898003 落在带内"):
            self.assertEqual(self.names(text), [], text)


class ClientIPTest(unittest.TestCase):
    def names(self, text):
        _, findings = S.scrub(text)
        return sorted({f["name"] for f in findings})

    def test_end_user_address_is_redacted(self):
        self.assertIn("client-ip", self.names("client_ip=203.204.40.24"))
        self.assertIn("client-ip", self.names('x_forwarded_for="223.137.11.9, 172.68.87.27"'))

    def test_internal_topology_is_kept(self):
        """Stripping these would cost the reader the host they need, and they are not personal data."""
        for text in ("upstream 10.32.14.7:8080 connect failed",
                     "192.168.1.10", "172.16.0.5", "127.0.0.1"):
            self.assertEqual(self.names(text), [], text)

    def test_version_strings_are_not_addresses(self):
        """Measured on real reports: 1 of 19 dotted-quad candidates was a version, not an address."""
        for text in ("platform=ios、version=9.31.0.0", "ver 1.2.3.4", "版本 10.2.0.1"):
            self.assertEqual(self.names(text), [], text)

    def test_out_of_range_quads_are_not_addresses(self):
        self.assertEqual(self.names("build 2026.09.09.400"), [])


class JSONShapeTest(unittest.TestCase):
    """report.json is scrubbed as one blob and parsed back (sre-inspect run finish), so a rule that
    swallows the key name leaves half a string literal and the report fails to generate."""

    def test_scrubbed_json_still_parses(self):
        import json
        for raw in ('{"userId": "824841487", "n": 1}',
                    '{"cookie":"' + FAKE + '"}',
                    '{"password":"' + FAKE + '"}',
                    '{"client_ip":"203.204.40.24"}',
                    # the common shape: prose inside a JSON string, not a field of its own
                    '{"analysis":"\u540c\u4e00\u7528\u6237 uid 824862702, client_ip=203.204.40.24"}'):
            out, _ = S.scrub(raw)
            try:
                json.loads(out)
            except ValueError as e:
                self.fail("scrubbed JSON no longer parses\n  in : %s\n  out: %s\n  err: %s" % (raw, out, e))

    def test_key_name_survives_and_value_does_not(self):
        out, _ = S.scrub('{"userId": "824841487"}')
        self.assertIn('"userId"', out)
        self.assertNotIn("824841487", out)


class ParityTest(unittest.TestCase):
    def test_rule_names_match_the_engine(self):
        """Pinned against ola-sre-agent internal/egress/egress.go. Changing either side alone is the
        drift this test exists to catch — update both, then update this list."""
        self.assertEqual([n for n, _, _ in S.SECRET_PATTERNS], [
            "aliyun-ak-id", "aws-ak-id", "openai-style-key", "github-token",
            "github-fine-grained-pat", "git-url-credentials", "slack-app-token", "slack-bot-token",
            "bearer", "basic-auth", "authorization-header", "private-key",
            "argv-secret", "keyed-secret", "jwt", "cookie-header",
        ])
        self.assertEqual([n for n, _, _, _ in S.PII_PATTERNS], ["uid", "email", "phone", "client-ip"])

    def test_scan_secrets_reports_one_entry_per_rule(self):
        hits = S.scan_secrets("--api-key " + FAKE + " and --password " + FAKE)
        self.assertEqual(len(hits), 1, "scan_secrets de-duplicates by rule name")


if __name__ == "__main__":
    unittest.main()
