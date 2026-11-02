# `.sre-evidence/verification.json` — schema and how the gate reads it

The suite's gate (`suites/sre-autofix/lib/gate.py`, port of `fixgate.go:176-220`) parses this file
**tolerantly**: only `all_passed` and `checks[].{name,passed}` are mandatory. Everything else is
optional and free-form — two real upstream samples used different extra keys (`runner` vs `command`,
`not_verified[]` vs `php_binary`) and both had to pass.

| Field | Required | Meaning |
|---|---|---|
| `incident` | no (write it) | The id from `# INCIDENT <id>` |
| `checks[]` | **yes, non-empty** | Only checks you actually ran |
| `checks[].name` | yes | What the check was; blank names are numbered `#n` in the verdict |
| `checks[].passed` | yes, boolean | Any `false` fails the whole patch |
| `checks[].output` / `command` / `runner` / `note` | no | Raw output excerpt, how it was run |
| `all_passed` | **yes, boolean** | Your overall conclusion; `false` fails even if every item is `true` |
| `not_verified[]` | no (strongly recommended) | Things you could not do and why; copied verbatim into the PR body, never penalised |
| `notes` | no | Interpretation notes |

Rejections (verbatim from the gate): file missing · not JSON · missing `all_passed` · empty `checks` ·
`验证项未通过：<names>` · `逐项均通过但 all_passed=false`.

## Example A — runtime present, three real checks

```json
{
  "incident": "INC-20260101-000000-deadbeef",
  "checks": [
    {"name": "php -l app/service/ExampleSrv.php", "passed": true,
     "command": "php7.2 -l app/service/ExampleSrv.php",
     "output": "No syntax errors detected in app/service/ExampleSrv.php"},
    {"name": "call-site audit: isFeatureEnabled", "passed": true,
     "command": "grep -rn \"isFeatureEnabled\" --include=*.php .",
     "output": "1 call site app/controllers/ExampleController.php:120; unchanged"},
    {"name": "brace balance of the touched file", "passed": true,
     "output": "awk open=22 close=22"}
  ],
  "all_passed": true,
  "not_verified": ["No PHPUnit suite exists for this service; unit tests not run"],
  "notes": "Syntax checked with the project's PHP major.minor, not whatever is on PATH."
}
```

## Example B — no runtime on this machine, one honest check

```json
{
  "incident": "INC-20260101-000000-deadbeef",
  "checks": [
    {"name": "人工核对了全部调用点与降级路径", "passed": true,
     "output": "2 call sites, both guard empty results before use"}
  ],
  "all_passed": true,
  "not_verified": [
    "未执行 php -l：本机没有 PHP 7.2 运行时（按环境约束不安装、不找解释器）；语法由目标仓库 CI 判定",
    "未运行单元测试：同上"
  ],
  "notes": "not_verified 项均为环境约束所致，非检查失败。"
}
```

Anti-pattern: `{"name": "php -l", "passed": false, "output": "php: command not found"}` — that is
"按约定没做", it belongs in `not_verified[]`, not as a failed check.
