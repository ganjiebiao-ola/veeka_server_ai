"""Suggest `config.yaml repos[].checks` from what the repo itself says — so the operator never has to
know in advance which compiler / analyser applies. Read-only, deterministic, advisory: the gate still
enforces nothing but "the configured commands exit 0" (lib/repocheck.py). Two sources, strongest first:

1. the repo's own CI: `run:` steps of `.github/workflows/*.yml` that trigger on pull_request —
   whatever CI runs on the PR is what the gate should run first, in any language;
2. a toolchain marker (go.mod, pom.xml, composer.json, tsconfig.json, …) → the canonical compile /
   static-check command, plus whether it catches "wrong signature" class errors (a compiler does;
   `php -l` / `compileall` do not — the 2026-08-26 drill bug is exactly that class).

Extending to a new language = one TABLE row. Nothing here is consulted by the gate.
"""
import os
import re

# (marker file, language, commands, catches signature/type errors, note). A repo may carry several
# markers (a PHP monolith with a stray go.mod for a tool): the one whose language matches the runtime
# probe (CI php-version / go.mod / node-version …) wins, the others are listed as "also found".
TABLE = [
    ("go.mod", "Go", ["go build ./...", "go vet ./..."], True, "Go 编译器在编译期抓签名/类型错"),
    ("Cargo.toml", "Rust", ["cargo check"], True, "rustc 在编译期抓签名/类型错"),
    ("pom.xml", "Java", ["mvn -q -DskipTests compile"], True, "javac 在编译期抓签名/类型错"),
    ("build.gradle", "Java", ["./gradlew -q compileJava"], True, "javac 在编译期抓签名/类型错"),
    ("build.gradle.kts", "Kotlin", ["./gradlew -q compileKotlin compileJava"], True, "kotlinc/javac 在编译期抓签名/类型错"),
    ("tsconfig.json", "Node", ["npx tsc --noEmit"], True, "tsc 类型检查抓签名/类型错"),
    ("Gemfile", "Ruby", ["ruby -c {files}"], False, "只查语法；签名/类型错抓不到——Sorbet/RBS 才能"),
]
WEAK_PHP_NOTE = ("`php -l` 只查语法：签名、按引用传参、类型约束这类错抓不到（演练 #1926 就是这类）。"
                 "有 composer 就装 phpstan/phpstan 并配 `vendor/bin/phpstan analyse --level 5 {files}`；"
                 "老仓没 autoload 用 `sh {root}/suites/sre-autofix/docs/examples/phpstan-new-errors.sh {worktree} {files}`")
WEAK_PY_NOTE = "`compileall` 只查语法；类型/签名错要 mypy 或 pyright（`mypy {files}` / `pyright {files}`）"

_RUN_LINE = re.compile(r"^(\s*)(?:-\s*)?run:\s*(.*)$")
_PR_TRIGGER = re.compile(r"pull_request")
_WORKFLOW_DIR = ".github/workflows/"


def fs_readers(repo_path):
    """(read_at_base, list_files) over a checked-out repo directory — for doctor, which has no
    worktree; plan/gate use the git-baseline readers from lib/workspace.py."""
    def read(rel):
        p = os.path.join(repo_path, rel)
        try:
            with open(p, encoding="utf-8", errors="replace") as f:
                return f.read()
        except OSError:
            return ""

    def list_files():
        out = []
        try:
            for name in sorted(os.listdir(repo_path)):
                if os.path.isfile(os.path.join(repo_path, name)):
                    out.append(name)
        except OSError:
            return out
        wf = os.path.join(repo_path, ".github", "workflows")
        if os.path.isdir(wf):
            out += [_WORKFLOW_DIR + n for n in sorted(os.listdir(wf))]
        return out
    return read, list_files


def ci_run_steps(read_at_base, list_files, limit=6):
    """(workflow file, [first line of each `run:` step]) of the first pull_request workflow that has
    run steps; ("", []) when none. See ci_run_steps_all for every workflow."""
    for f, steps in ci_run_steps_all(read_at_base, list_files, limit):
        return f, steps
    return "", []


def ci_run_steps_all(read_at_base, list_files, limit=6):
    """[(workflow file, [first line of each `run:` step])] for every pull_request workflow that has
    run steps. Naive line scan on purpose — no YAML parser in the stdlib."""
    found = []
    for f in list_files() or []:
        if not (f.startswith(_WORKFLOW_DIR) and (f.endswith(".yml") or f.endswith(".yaml"))):
            continue
        c = read_at_base(f) or ""
        if not _PR_TRIGGER.search(c):
            continue
        lines = c.split("\n")
        steps = []
        i = 0
        while i < len(lines):
            m = _RUN_LINE.match(lines[i])
            if not m:
                i += 1
                continue
            key_indent = len(m.group(1)) + (2 if lines[i].lstrip().startswith("-") else 0)
            val = m.group(2).strip()
            if val in ("|", ">", "|-", ">-", "|+", ">+", ""):
                body = []
                j = i + 1
                while j < len(lines) and (not lines[j].strip() or len(lines[j]) - len(lines[j].lstrip()) > key_indent):
                    if lines[j].strip():
                        body.append(lines[j].strip())
                    j += 1
                if body:
                    steps.append(body[0] + ("  …(+%d 行)" % (len(body) - 1) if len(body) > 1 else ""))
                i = j
            else:
                steps.append(val.strip("'\""))
                i += 1
        if steps:
            found.append((f, steps[:limit]))
    return found


def _candidates(names, read_at_base, runtime_note):
    """Every toolchain the repo shows evidence of: [(lang, basis, commands, strong, note)]."""
    out = []
    for marker, lang, cmds, strong, note in TABLE:
        if marker in names:
            out.append((lang, marker, list(cmds), strong, note))
    if any(n.endswith(".csproj") or n.endswith(".sln") for n in names):
        out.append(("C#", "*.csproj", ["dotnet build --nologo -v q"], True, "C# 编译器在编译期抓签名/类型错"))

    composer = read_at_base("composer.json") if "composer.json" in names else ""
    if composer or (runtime_note or "").startswith("PHP"):
        cmds, strong, note = ["php -l {files}"], False, WEAK_PHP_NOTE
        if "phpstan/phpstan" in composer:
            cmds, strong, note = ["php -l {files}", "vendor/bin/phpstan analyse --level 5 {files}"], True, "composer 里已有 phpstan"
        elif "vimeo/psalm" in composer:
            cmds, strong, note = ["php -l {files}", "vendor/bin/psalm {files}"], True, "composer 里已有 psalm"
        out.append(("PHP", "composer.json" if composer else "CI 探测到 PHP", cmds, strong, note))

    py_marker = next((m for m in ("pyproject.toml", "setup.py", "requirements.txt") if m in names), "")
    if py_marker or (runtime_note or "").startswith("Python"):
        pyproject = read_at_base("pyproject.toml") if "pyproject.toml" in names else ""
        cmds, strong, note = ["python -m compileall -q {files}"], False, WEAK_PY_NOTE
        if "mypy" in pyproject:
            cmds, strong, note = ["mypy {files}"], True, "pyproject 里已有 mypy"
        elif "pyright" in pyproject:
            cmds, strong, note = ["pyright {files}"], True, "pyproject 里已有 pyright"
        out.append(("Python", py_marker or "CI 探测到 Python", cmds, strong, note))

    if "package.json" in names and not any(c[0] == "Node" for c in out):
        pkg = read_at_base("package.json")
        if re.search(r'"lint"\s*:', pkg or ""):
            out.append(("Node", "package.json", ["npm run -s lint"], False,
                        "lint 脚本通常不做类型检查；有 TypeScript 就加 `npx tsc --noEmit`"))
    return out


def suggest(read_at_base, list_files, runtime_note=""):
    """→ {commands, catches_signature_errors, basis, lang, note, also, ci}. `commands` empty when no
    marker is recognised (CI steps may still be present). `also` = other toolchains found in the same
    repo (each a dict like the primary); `ci` = [(workflow, steps)] for every pull_request workflow."""
    files = list_files() or []
    names = set(os.path.basename(f) for f in files) | set(files)
    out = {"commands": [], "catches_signature_errors": False, "basis": "", "lang": "", "note": "", "also": [],
           "ci": ci_run_steps_all(read_at_base, list_files)}
    out["ci_file"], out["ci_steps"] = (out["ci"][0] if out["ci"] else ("", []))
    cands = _candidates(names, read_at_base, runtime_note)
    if not cands:
        return out
    probe_lang = (runtime_note or "").split(" ", 1)[0]     # "PHP 7.2（…）" → "PHP"
    primary = next((c for c in cands if c[0] == probe_lang), cands[0])
    lang, basis, cmds, strong, note = primary
    out.update(commands=cmds, catches_signature_errors=strong, basis=basis, lang=lang, note=note)
    out["also"] = [{"lang": c[0], "basis": c[1], "commands": c[2], "catches_signature_errors": c[3]}
                   for c in cands if c is not primary]
    return out


def render_lines(s, repo_id):
    """Doctor's advisory lines (already indented by the caller)."""
    L = []
    for f, steps in (s.get("ci") or [])[:3]:
        L.append("CI on pull_request runs (%s) — reuse these first: %s" % (f, " ; ".join(steps)))
    if s.get("commands"):
        L.append("suggested (%s, from %s): checks: [%s]   ← %s"
                 % (s.get("lang") or "?", s.get("basis") or "?", ", ".join('"%s"' % c for c in s["commands"]),
                    "compiler/analyser catches signature errors" if s.get("catches_signature_errors")
                    else "SYNTAX ONLY — a wrong signature still passes"))
        if not s.get("catches_signature_errors") and s.get("note"):
            L.append("⚠ " + s["note"])
        for a in s.get("also") or []:
            L.append("also found %s (%s): %s — add it if that code is in scope"
                     % (a["lang"], a["basis"], ", ".join('"%s"' % c for c in a["commands"])))
    if not L:
        L.append("no toolchain marker recognised (go.mod / pom.xml / composer.json / tsconfig.json …) and no CI run "
                 "steps found — put whatever this repo's CI runs on a PR into repos[%s].checks" % repo_id)
    return L
