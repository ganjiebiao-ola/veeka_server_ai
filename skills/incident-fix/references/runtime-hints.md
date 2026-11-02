# Runtime detection and verification hints

`suites/sre-autofix/run plan` probes the repo baseline deterministically (port of `fixbrief.go
detectRuntime`, trust order below) and writes the result into `INCIDENT.md ## 环境事实`. When it
says "未探测到", determine the version yourself from the same sources and state it in `FIXNOTES.md`.
Never guess; never install anything (环境约束 2).

| Runtime | Detection sources (trust order) | Read-only checks to put in `checks[]` when the runtime is on PATH |
|---|---|---|
| PHP | `.github/workflows/*.yml` `php-version:` → `composer.json` `require.php` | `php -l <file>` — must be the project's major.minor; if only a newer PHP is on PATH, run it but record the version gap in `not_verified[]` |
| Go | `go.mod` `go X.Y` | `gofmt -l <pkg>`, `go vet ./<pkg>`, `go build ./...`, `go test ./<pkg>` |
| Node / TypeScript | CI `node-version:` → `.nvmrc` → `package.json` `engines.node` | `node --check <file>`, `npx tsc --noEmit`, the project's lint script |
| Python | CI `python-version:` → `.python-version` → `pyproject.toml` `requires-python` | `python3 -m py_compile <file>`, `ruff` / `flake8`, `pytest -k <name>` |
| Java / Kotlin | `pom.xml` `maven.compiler.*` → `build.gradle` `sourceCompatibility` → CI `java-version:` | `mvn -q compile` / `gradle compileJava` |
| other | declare what you read and where | — |

Upstream status: PHP and Go are first-class (real merged PRs went through this contract); the other
rows are "进得了门、未实战" — the gate accepts them, but expect to lean more on `not_verified[]`.

Style: the probe also reports the touched files' indent character/width and trailing-newline state
(`styleOf`: ≥3 evidence lines, docblock ` *` lines excluded). Follow it — a tab/space mix or a
missing final newline makes the target repo's style check flag the whole file.
