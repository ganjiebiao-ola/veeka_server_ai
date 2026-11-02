import { join } from "node:path"
import { tmpdir } from "node:os"
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { spyOn, test } from "bun:test"
import { strict as assert } from "node:assert"
import { batchBranch, batchNotes, openBatchPR, patchFiles, prBody, prTitle } from "./batch_pr.ts"
import { GitHubClient } from "../tracker/client.ts"
import { today } from "../tracker/rows.ts"
import { TrackerConflict, type TrackerFile, type TrackerStore } from "../tracker/store.ts"
import type { Row } from "../tracker/rows.ts"
import { Store } from "../store/repo.ts"
import { candidates, refreshRows } from "../tracker/pick.ts"
import { ScannerRun } from "./scanner.ts"
import type { RunEvent } from "../../shared/types.ts"
import { recordBatchError } from "../handlers/pick.ts"

class MemoryStore implements TrackerStore {
  files: TrackerFile[]
  constructor(rows: Row[]) {
    this.files = [{ category: "sqli", rows: structuredClone(rows), log: [], url: "https://example.test/sqli.json" }]
  }
  async read() { return structuredClone(this.files) }
  async write(file: TrackerFile, rows: Row[], message: string) {
    const next = { ...file, rows: structuredClone(rows), log: [...file.log, ...(message ? [{ at: "now", message }] : [])], sha: "sha" }
    this.files = [...this.files.filter(current => current.category !== file.category), next]
    return next
  }
}

const row = (n: number, extra: Partial<Row> = {}): Row => ({
  id: n.toString(16).padStart(64, "0"), category: "sqli", file: `app/api/${n}.php`, lines: [3],
  severity: "P1", status: "in progress", reason: "", date: today(), pr: "", ...extra,
})

test("PR title uses the highest fixed-row priority and shared Chinese category label", () => {
  const rows = [row(1, { severity: "P2" }), row(2, { severity: "P1" }), row(3, { severity: "P0" })]
  assert.ok(prTitle("sqli", rows, {}).startsWith("【P0·SQL 注入】"))
  assert.ok(prTitle("sqli", rows.slice(0, 2), {}).startsWith("【P1·SQL 注入】"))
  assert.ok(prTitle("sqli", rows.slice(0, 1), {}).startsWith("【P2·SQL 注入】"))
  assert.ok(prTitle("deserialization", rows, {}).startsWith("【P0·反序列化/POP】"))
  assert.ok(prTitle("signature-compare", rows, {}).startsWith("【P0·签名】"))
})

test("PR title uses the optional parsed model description for regular and draft PRs", async () => {
  const notes = batchNotes({ pr_title: "SdkFacebook 写入参数化" })
  assert.equal(prTitle("sqli", [row(1)], notes), "【P1·SQL 注入】SdkFacebook 写入参数化")
  for (const ok of [true, false]) {
    const r = await setup([{ name: "lint", command: "php -l", ok }], { 1: "fixed" }, undefined, undefined, notes)
    assert.equal(r.prs[0].title, "【P1·SQL 注入】SdkFacebook 写入参数化")
    assert.equal(r.prs[0].draft, !ok)
  }
})

test("PR title cleans model markdown, controls, mentions, refs and long text", () => {
  const notes = batchNotes({ pr_title: "**接口**\n\t@team #123 [绑定](https://example.com) <b>参数</b>\u0000\u202e " + "修".repeat(80) })
  const title = prTitle("sqli", [row(1)], notes)
  const description = title.split("】")[1]
  assert.ok(description.startsWith("接口 ＠team ＃123 绑定 参数 "))
  assert.equal(Array.from(description).length, 40)
  assert.ok(!/[\n\t\p{Cc}\p{Cf}@*<>]/u.test(title))
  assert.ok(Array.from(title).length < 100)
})

test("PR title cleaning stays fast on huge model text", () => {
  const start = performance.now()
  const title = prTitle("sqli", [row(1)], batchNotes({ pr_title: "[".repeat(200000) + "x" }))
  assert.ok(performance.now() - start < 1000)
  assert.ok(Array.from(title).length < 100)
})

test("PR title falls back to distinct basenames when model text is missing or invalid", () => {
  const rows = [row(1, { file: "a/Handler.php" }), row(2, { file: "b/Handler.php" }), row(3, { file: "b/Db.php" }), row(4)]
  for (const pr_title of [undefined, "", " \n", "**【】**\u0000", 12, []]) {
    assert.equal(prTitle("sqli", rows, batchNotes({ pr_title })), "【P1·SQL 注入】Handler.php、Db.php等 加固")
  }
  assert.equal(prTitle("sqli", [row(1)], {}), "【P1·SQL 注入】1.php 加固")
  assert.equal(prTitle("sqli", rows.slice(0, 2), {}), "【P1·SQL 注入】Handler.php 加固")
  const long = prTitle("sqli", [row(1, { file: "x".repeat(200) + ".php" })], {})
  assert.ok(long.length < 100)
  assert.ok(long.endsWith(" 加固"))
})

test("patchFiles lists files, new tests and changed lines", () => {
  const patch = [
    "diff --git a/app/x.php b/app/x.php", "--- a/app/x.php", "+++ b/app/x.php", "-old", "+new",
    "diff --git a/tests/XTest.php b/tests/XTest.php", "new file mode 100644", "+++ b/tests/XTest.php", "+test",
  ].join("\n")
  assert.deepEqual(patchFiles(patch), { files: ["app/x.php", "tests/XTest.php"], newTests: ["tests/XTest.php"], lines: 3 })
})

test("a batch across subsystems gets a mixed branch that still reads as a suite branch", () => {
  const runId = "0123abcd-4567-89ef-0123-456789abcdef"
  assert.equal(batchBranch("sqli", ["app/api"], runId), "security/sqli-app-api-0123abcd")
  assert.equal(batchBranch("sqli", ["app/api", "app/web"], runId), "security/sqli-mixed-0123abcd")
  assert.match(batchBranch("sqli", ["app/api", "app/web"], runId), GitHubClient.SUITE_BRANCH)
  const body = prBody({ category: "sqli", subsystem: "app/api, app/web", files: ["app/api/1.php"], newTests: [], lines: 4,
    fixed: [], notes: {}, checks: [{ name: "lint", command: "php -l", ok: true }], failing: false })
  assert.ok(body.includes("✅ 检查 1/1 · 🧪 新增测试 0"))
})

test("PR body leads with callouts and status, then decisions and folded detail", () => {
  const body = prBody({ category: "sqli", subsystem: "app/api", files: ["app/api/1.php"], newTests: [], lines: 4,
    fixed: [row(1)], notes: { fix_pattern: "Bind parameters", shared_helpers: [{ name: "Db::q", callers: 4 }], decisions: ["Kept the old signature"],
      later: ["app/api/9.php:3"], review_notes: ["Old note"] }, checks: undefined, failing: true })
  assert.ok(body.startsWith("> [!WARNING]\n> **草稿：两轮后检查仍失败。**"))
  assert.ok(body.includes("检查步骤没有运行 · 🧪 新增测试 0"))
  for (const title of ["合并前请确认 (1)", "改动"]) assert.ok(body.includes(`## ${title}\n`), title)
  assert.ok(body.indexOf("## 合并前请确认") < body.indexOf("## 改动"))
  assert.ok(body.includes("<details open><summary>检查步骤没有运行 · 🧪 新增测试 0</summary>\n\n**验证**\n\n- 检查步骤没有运行。"))
  assert.ok(body.indexOf("## 合并前请确认") < body.indexOf("**Review 记录**"))
  assert.ok(body.includes("<details><summary>留待以后 (1)</summary>"))
  assert.ok(body.includes("- Old note"))
  assert.ok(body.includes("`Db::q` (4 处调用)"))
  assert.ok(!body.includes("## 文件") && !body.includes("<b>文件 (") && !body.includes("Files ("))
  assert.ok(!body.includes("changed lines") && !body.includes("**sqli**"))
})

test("PR body shows each decision as a checkbox with folded detail", () => {
  const body = prBody({ category: "sqli", subsystem: "app/api", files: ["app/api/1.php"], newTests: ["tests/XTest.php"], lines: 1,
    fixed: [row(1)], notes: { decisions: [{ ask: "Drop frames with objects?", detail: "Only start_http.php sends.", behavior: true }, { ask: "Patch vendor in place?" }] },
    checks: [{ name: "lint", command: "php -l", ok: true }], failing: false })
  assert.ok(body.startsWith("> [!WARNING]\n> **草稿：这个 PR 改变了运行行为。**"))
  assert.ok(body.includes("- [ ] **Drop frames with objects?** *行为变化*\n  <details><summary>细节</summary>\n\n  Only start_http.php sends.\n\n  </details>"))
  assert.ok(body.includes("- [ ] **Patch vendor in place?**\n"))
  assert.ok(!/[📍🚀↩️]/u.test(body))
  assert.ok(body.includes("新增测试：\n- `tests/XTest.php`"))
})

test("a behavior change opens a draft and says why on the row", async () => {
  const r = await setup([{ name: "lint", command: "php -l", ok: true }], { 1: "fixed" }, undefined, undefined, { decisions: [{ ask: "Drop frames?", behavior: true }] })
  assert.deepEqual(r.prs.map(p => p.draft), [true])
  assert.equal(r.push.draft, true)
  assert.equal(statusOf(r.rows, 1).reason, "Behavior change needs a human decision")
})

test("PR body hides empty sections", () => {
  const body = prBody({ category: "sqli", subsystem: "app/api", files: ["app/api/1.php"], newTests: [], lines: 1,
    fixed: [row(1)], notes: {}, checks: [{ name: "lint", command: "php -l", ok: true }], failing: false })
  assert.ok(body.startsWith("## 改动"))
  assert.ok(body.includes("<details><summary>✅ 检查 1/1 · 🧪 新增测试 0</summary>\n\n**验证**\n\n- ✅ lint：`php -l`"))
  for (const title of ["## 合并前请确认", "改动的共享 helper", "升级的 vendor 包", "留待以后", "Review 记录", "[!WARNING]", "🔍 Review", "## 部署", "回滚步骤"]) assert.ok(!body.includes(title), title)
})

test("PR body lists callers in related repos as checkboxes", () => {
  const base = { category: "api-no-auth", subsystem: "app/api", files: ["app/api/1.php"], newTests: [], lines: 1,
    fixed: [row(1)], checks: [{ name: "lint", command: "php -l", ok: true }], failing: false }
  const body = prBody({ ...base, notes: { caller_repos: ["client-app"], callers: [
    { route: "/user/info", repo: "client-app", file: "src/api.ts", line: 12 },
    { route: "/x`y", repo: "client-app", file: "src/b.ts", line: 3 },
    { route: "/bad", repo: "client-app", file: "src/c.ts", line: "3" as never },
  ] } })
  assert.ok(body.includes("## 相关仓库中的调用方 (2)\n\n已搜索: `client-app`"))
  assert.ok(body.includes("- [ ] `client-app:src/api.ts:12` 调用 `/user/info`"))
  assert.ok(body.includes("- [ ] `client-app:src/b.ts:3` 调用 `/xy`"))
  assert.ok(!body.includes("src/c.ts"))
  assert.ok(prBody({ ...base, notes: { caller_repos: ["client-app"], callers: [] } }).includes("没有找到调用方。"))
  assert.ok(prBody({ ...base, notes: { caller_repos: [] } }).includes("notes 文件没有列出相关仓库。"))
  assert.ok(!prBody({ ...base, notes: {} }).includes("相关仓库中的调用方"))
})

test("PR body uses Chinese headers for Chinese notes", () => {
  const body = prBody({ category: "sqli", subsystem: "app/api", files: ["app/api/1.php"], newTests: [], lines: 1,
    fixed: [row(1)], notes: { fix_pattern: "改用参数绑定", decisions: ["保留旧签名"] }, checks: [{ name: "lint", command: "php -l", ok: false }], failing: true })
  assert.ok(body.startsWith("> [!WARNING]\n> **草稿"))
  assert.ok(body.includes("❌ 检查 1/1 失败"))
  for (const title of ["合并前请确认 (1)", "改动"]) assert.ok(body.includes(`## ${title}\n`), title)
  assert.ok(!body.includes("## Fix pattern"))
})

const layoutInput = (language?: "en" | "zh") => ({
  category: "sqli", subsystem: "app/api", files: ["app/api/1.php", "app/api/2.php"], newTests: ["tests/XTest.php"], lines: 12,
  fixed: [{ ...row(1), fixSummary: "Handler::fix1() binds input" }, { ...row(2, { file: "app/api/1.php", lines: [9, 4] }), fixSummary: "Handler::fix2() binds id" }, row(3)],
  checks: [{ name: "lint", command: "php -l", ok: true }, { name: "phpunit", command: "phpunit", ok: false }], failing: true,
  trackerUrl: "https://example.test/tracker", ...(language ? { language } : {}),
  notes: batchNotes({
    fix_pattern: "Bind parameters", vulnerability: ["HTTP input reaches the SQL sink."], impact: ["Api::run() <- HTTP controller, login needed, live code."],
    shared_helpers: [{ name: "Db::q", callers: 4 }], vendor_upgrades: [{ tree: "vendor", package: "a/b", from: null, to: "2.0" }],
    decisions: [{ ask: "Drop frames?", detail: "Only start_http.php sends.", behavior: true }, "Keep the old signature?"],
    caller_repos: ["client-app"], callers: [{ route: "/user/info", repo: "client-app", file: "src/api.ts", line: 12 }],
    restart: ["supervisorctl restart a", "supervisorctl restart b"], rollback: "1. Revert\n2. Clear cache", later: ["app/api/9.php:3 sibling sink"],
    review_notes: [{ note: "Bind the id", action: "fixed" }, { note: "Not needed", action: "rejected" }], review_rounds: 2, review_did_not_run: [2],
    test_note: "Cannot unit test the controller.",
  }),
})

const ZH_LAYOUT = `> [!WARNING]
> **草稿：两轮后检查仍失败。** 这个 PR 处理完之前，这些行保持 \`in progress\`。

> [!WARNING]
> **草稿：这个 PR 改变了运行行为。** 合并前请先确认标了 *行为变化* 的决定。

> [!WARNING]
> 第 2 轮 Review 没有运行。

## 合并前请确认 (2)

- [ ] **Drop frames?** *行为变化*
  <details><summary>细节</summary>

  Only start_http.php sends.

  </details>
- [ ] Keep the old signature?

## 相关仓库中的调用方 (1)

已搜索: \`client-app\`

- [ ] \`client-app:src/api.ts:12\` 调用 \`/user/info\`

## 改动

Bind parameters

**\`app/api/1.php\`**

- \`:3\` Handler::fix1&#40;&#41; binds input
- \`:4,9\` Handler::fix2&#40;&#41; binds id

**\`app/api/3.php\`**

- \`:3\`

改动的共享 helper:
- \`Db::q\` (4 处调用)

升级的 vendor 包:
- \`vendor\`: \`a/b\` 未安装 → 2.0

## 漏洞说明

- HTTP input reaches the SQL sink.

## 影响范围

- Api::run&#40;&#41; &lt;- HTTP controller, login needed, live code.

## 需要重启的服务

\`\`\`sh
supervisorctl restart a b
\`\`\`

## 关联

- [Tracker](https://example.test/tracker)

<details><summary>留待以后 (1)</summary>

- app/api/9.php:3 sibling sink

</details>

<details><summary>回滚步骤</summary>

1. Revert<br>2. Clear cache

</details>

<details open><summary>❌ 检查 1/2 失败 · 🧪 新增测试 1 · 🔍 Review 2 轮（1 改 · 1 拒）</summary>

**验证**

- ✅ lint：\`php -l\`
- ❌ phpunit：\`phpunit\`

新增测试：
- \`tests/XTest.php\`

Cannot unit test the controller.

**Review 记录**

- 改：Bind the id
- 拒：Not needed

</details>`

const EN_LAYOUT = `> [!WARNING]
> **Draft: checks still fail after 2 rounds.** The rows remain \`in progress\` until this PR is resolved.

> [!WARNING]
> **Draft: this PR changes runtime behavior.** Answer the decisions marked *behavior change* before merge.

> [!WARNING]
> Review round 2 did not run.

## Description

### Confirm before merging (2)

- [ ] **Drop frames?** *behavior change*
  <details><summary>Detail</summary>

  Only start_http.php sends.

  </details>
- [ ] Keep the old signature?

### Callers in related repos (1)

Searched: \`client-app\`

- [ ] \`client-app:src/api.ts:12\` calls \`/user/info\`

### Changes

Bind parameters

**\`app/api/1.php\`**

- \`:3\` Handler::fix1&#40;&#41; binds input
- \`:4,9\` Handler::fix2&#40;&#41; binds id

**\`app/api/3.php\`**

- \`:3\`

Shared helpers changed:
- \`Db::q\` (4 callers)

Vendor packages moved:
- \`vendor\`: \`a/b\` not installed → 2.0

### Vulnerability

- HTTP input reaches the SQL sink.

### Impact

- Api::run&#40;&#41; &lt;- HTTP controller, login needed, live code.

### Services to restart

\`\`\`sh
supervisorctl restart a b
\`\`\`

<details><summary>Rollback</summary>

1. Revert<br>2. Clear cache

</details>

## Related Issue

- [Tracker](https://example.test/tracker)

<details><summary>Left for later (1)</summary>

- app/api/9.php:3 sibling sink

</details>

## Type of Change

- [x] Bug fix (security)

## How Has This Been Tested

<details open><summary>❌ Checks 1/2 failed · 🧪 New tests 1 · 🔍 Review 2 rounds (1 fixed · 1 rejected)</summary>

**Verification**

- ✅ lint: \`php -l\`
- ❌ phpunit: \`phpunit\`

New tests:
- \`tests/XTest.php\`

Cannot unit test the controller.

**Review notes**

- Fixed: Bind the id
- Rejected: Not needed

</details>`

test("the Chinese PR body layout is unchanged, with or without an explicit language", () => {
  assert.equal(prBody(layoutInput()), ZH_LAYOUT)
  assert.equal(prBody(layoutInput("zh")), ZH_LAYOUT)
})

test("the English PR body follows the Description, Related Issue, Type of Change, How Has This Been Tested template", () => {
  const body = prBody(layoutInput("en"))
  assert.equal(body, EN_LAYOUT)
  assert.ok(!/[\u4e00-\u9fff]/.test(body))
  const titles = ["> [!WARNING]", "## Description", "### Confirm before merging (2)", "### Callers in related repos (1)", "### Changes", "### Vulnerability",
    "### Impact", "### Services to restart", "<summary>Rollback</summary>", "## Related Issue", "<summary>Left for later (1)</summary>", "## Type of Change",
    "- [x] Bug fix (security)", "## How Has This Been Tested", "<details open><summary>❌ Checks 1/2 failed"]
  for (let i = 1; i < titles.length; i++) assert.ok(body.indexOf(titles[i - 1]) < body.indexOf(titles[i]), titles[i])
})

test("the English PR body keeps the status fold closed when checks pass and drops empty sections", () => {
  const body = prBody({ category: "sqli", subsystem: "app/api", files: ["app/api/1.php"], newTests: [], lines: 1,
    fixed: [row(1)], notes: {}, checks: [{ name: "lint", command: "php -l", ok: true }], failing: false, language: "en" })
  assert.ok(body.startsWith("## Description\n\n### Changes\n"))
  assert.ok(body.includes("## How Has This Been Tested\n\n<details><summary>✅ Checks 1/1 · 🧪 New tests 0</summary>\n\n**Verification**\n\n- ✅ lint: `php -l`"))
  assert.ok(body.includes("### Services to restart\n\nNot specified; confirm before merge."))
  assert.ok(body.includes("## Related Issue\n\nNone\n"))
  for (const title of ["Confirm before merging", "Vulnerability", "Rollback", "Left for later", "[!WARNING]"]) assert.ok(!body.includes(title), title)
})

test("the English PR title mirrors the Chinese format with an English category name", () => {
  const rows = [row(1, { severity: "P2" }), row(2, { severity: "P1" }), row(3, { severity: "P0" })]
  assert.ok(prTitle("sqli", rows, {}, "en").startsWith("[P0·SQL injection] "))
  assert.ok(prTitle("sqli", rows.slice(0, 2), {}, "en").startsWith("[P1·SQL injection] "))
  assert.ok(prTitle("deserialization", rows, {}, "en").startsWith("[P0·Deserialization] "))
  assert.ok(prTitle("unknown", rows, {}, "en").startsWith("[P0·Other] "))
  assert.equal(prTitle("sqli", [row(1)], batchNotes({ pr_title: "Bind SdkFacebook writes" }), "en"), "[P1·SQL injection] Bind SdkFacebook writes")
  assert.equal(prTitle("sqli", [row(1)], {}, "en"), "[P1·SQL injection] 1.php hardening")
  const names = [row(1, { file: "a/Handler.php" }), row(2, { file: "b/Db.php" }), row(3)]
  assert.equal(prTitle("sqli", names, {}, "en"), "[P1·SQL injection] Handler.php, Db.php and more hardening")
  const forged = prTitle("sqli", [row(1)], batchNotes({ pr_title: "[P0·Fake] " + "x".repeat(200) }), "en")
  assert.ok(forged.startsWith("[P1·SQL injection] P0·Fake x"))
  assert.ok(Array.from(forged).length < 100)
  assert.equal(prTitle("sqli", rows, {}), prTitle("sqli", rows, {}, "zh"))
})

for (const language of ["en", "zh"] as const) test(`${language} PR body truncation closes details and keeps the notice last`, () => {
  const base = { category: "sqli", subsystem: "app", files: [], newTests: [], lines: 0, fixed: [], checks: [], failing: false, language }
  const item = "`" + "@".repeat(498) + "`"
  for (const notes of [
    { later: Array(30).fill(item) },
    { review_notes: Array(30).fill(item) },
    { decisions: Array.from({ length: 30 }, () => ({ ask: item, detail: item })) },
  ]) {
    const body = prBody({ ...base, notes })
    assert.ok(body.length < 65_536, String(body.length))
    assert.ok(body.endsWith(language === "en" ? "The full notes are in the run's batch.json." : "完整内容见该次运行的 batch.json。"))
    for (const source of [body, Bun.markdown.html(body, { autolinks: true })]) {
      assert.equal((source.match(/<code>/g) ?? []).length, (source.match(/<\/code>/g) ?? []).length)
      assert.equal((source.match(/<details\b/g) ?? []).length, (source.match(/<\/details>/g) ?? []).length)
    }
    assert.ok(body.lastIndexOf("</details>") < body.lastIndexOf(language === "en" ? "> The PR body" : "> PR 描述"))
  }
})

test("PR body identifies review rounds that did not run", () => {
  const base = { category: "sqli", subsystem: "app/api", files: [], newTests: [], lines: 1,
    fixed: [row(1)], checks: [{ name: "lint", command: "php -l", ok: true }], failing: false }
  const body = prBody({ ...base, notes: batchNotes({ fix_pattern: "改用参数绑定", review_did_not_run: [2, "bad"] }) })
  assert.ok(body.includes("第 2 轮 Review 没有运行。"))
  assert.ok(!body.includes("第 1 轮 Review 没有运行。"))
  assert.ok(!prBody({ ...base, notes: batchNotes({ fix_pattern: "改用参数绑定" }) }).includes("轮 Review 没有运行"))
  assert.ok(body.startsWith("> [!WARNING]\n> 第 2 轮 Review 没有运行。"))
})

async function setup(checks: unknown, statuses: Record<number, string>, patch = "diff --git a/app/api/1.php b/app/api/1.php\n+x\n", pushError?: string, notes?: unknown, failAt?: "push" | "createPR" | "save" | "tracking" | "record", prepare?: (art: string) => Promise<void>, language?: "en" | "zh") {
  const dir = await mkdtemp(join(tmpdir(), "ola-agent-"))
  const store = await Store.open(`${dir}/test.sqlite`)
  const runId = "run-1"
  store.ensureSession("s1")
  store.createRun({ runId, sessionId: "s1", repoUrl: "https://github.com/a/b", branch: "main", skill: "ola-security-audit", model: "opus", effort: "high", mode: "fix", categories: "", language })
  const art = `${dir}/${runId}/artifacts`
  await mkdir(art, { recursive: true })
  const rows = [row(1), row(2), row(3), row(4)]
  await writeFile(`${art}/picked.json`, JSON.stringify(rows.map(({ id, category }) => ({ id, category }))))
  await writeFile(`${art}/working.patch`, patch)
  if (checks) await writeFile(`${art}/checks.json`, JSON.stringify(checks))
  if (notes) await writeFile(`${art}/batch.json`, JSON.stringify(notes))
  await prepare?.(art)
  for (const [n, status] of Object.entries(statuses)) store.insertFinding(runId, { id: row(Number(n)).id, category: "sqli", severity: "P2", status: status as never, fixSummary: `Handler::fix${n}() binds input`, reason: `r${n}` })
  const trackerStore = new MemoryStore(rows)
  const prs: { draft: boolean, title: string, body: string }[] = []
  const client = {
    async openPRFiles() { return [] }, async prState(): Promise<"open" | "merged" | "closed"> { return "open" },
    async createPR(pr: { draft: boolean, title: string, body: string }) {
      if (failAt === "createPR") throw new Error("fixture createPR failure")
      prs.push(pr)
      return 9
    },
  }
  const read = trackerStore.read.bind(trackerStore)
  trackerStore.read = async () => {
    if (failAt === "tracking") throw new Error("fixture tracking failure")
    return read()
  }
  const write = trackerStore.write.bind(trackerStore)
  trackerStore.write = async (file, rows, message) => {
    if (failAt === "save" && prs.length) throw new Error("fixture save failure")
    if (failAt === "record" && message.includes(" pushed: ")) throw new Error("fixture record failure")
    return write(file, rows, message)
  }
  const pushes: string[] = []
  const events: RunEvent[] = []
  const deps = { store, runsRootDir: dir, bus: { publish(_id: string, event: RunEvent) { events.push(event) } }, controller: { async stopAndRemove() {} },
    activeRuns: new Map([[runId, { pushToBranch: async (b: string) => {
      if (failAt === "push") throw new Error("fixture push failure")
      pushes.push(b)
      return { ok: !pushError, sha: "a".repeat(40), error: pushError }
    } }]]) }
  let pr: number | undefined
  if (failAt && failAt !== "record") {
    await assert.rejects(openBatchPR(deps as never, runId, client, trackerStore, "a/b"), new RegExp(`fixture ${failAt} failure`))
    failAt = undefined
    await refreshRows(client, trackerStore, "a/b", new Set())
  } else pr = await openBatchPR(deps as never, runId, client, trackerStore, "a/b")
  const push = await readFile(`${art}/push.json`, "utf8").then(JSON.parse).catch(() => undefined)
  const result = { pr, prs, pushes, events, client, trackerStore, push, released: !deps.activeRuns.has(runId), rows: trackerStore.files[0].rows }
  store.close()
  await rm(dir, { recursive: true })
  return result
}
const statusOf = (rows: Row[], n: number) => rows.find(r => r.id === row(n).id)!

for (const cleanup of ["stalled", "throws", "rejects"] as const) test(`run_finished follows PR creation when container cleanup ${cleanup}`, async () => {
  const dir = await mkdtemp(join(tmpdir(), "ola-cleanup-"))
  const store = await Store.open(`${dir}/test.sqlite`)
  const runId = "cleanup-run"
  const events: RunEvent[] = []
  const finished = Promise.withResolvers<void>()
  const trackerStore = new MemoryStore([row(1)])
  let created = false
  const client = {
    async createPR() { created = true; return 9 },
  }
  const deps = {
    store, runsRootDir: dir, activeRuns: new Map<string, ScannerRun>(),
    bus: { publish(_id: string, event: RunEvent) {
      events.push(event)
      if (event.type === "run_finished") finished.resolve()
    } },
    controller: { stopAndRemove(id: string): Promise<void> {
      assert.equal(id, "fixture-container")
      assert.equal(created, true)
      if (cleanup === "throws") throw new Error("fixture cleanup failure")
      if (cleanup === "rejects") return Promise.reject(new Error("fixture cleanup failure"))
      return new Promise(() => {})
    } },
  }
  const realTimeout = globalThis.setTimeout
  const timer = spyOn(globalThis, "setTimeout").mockImplementation(((...args: Parameters<typeof setTimeout>) => {
    if (args[1] === 30_000) args[1] = 1
    return realTimeout(...args)
  }) as typeof setTimeout)
  const warn = spyOn(console, "warn").mockImplementation(() => {})
  try {
    store.ensureSession("s1")
    store.createRun({ runId, sessionId: "s1", repoUrl: "https://github.com/a/b", branch: "main",
      skill: "ola-security-audit", model: "sonnet", effort: "low", mode: "fix" })
    store.updateRunStatus(runId, "scanning", { containerId: "fixture-container" })
    store.insertFinding(runId, { id: row(1).id, category: "sqli", severity: "P1", status: "fixed" })
    const art = `${dir}/${runId}/artifacts`
    await mkdir(art, { recursive: true })
    await writeFile(`${art}/picked.json`, JSON.stringify([row(1)]))
    await writeFile(`${art}/working.patch`, "diff --git a/app/api/1.php b/app/api/1.php\n+safe\n")
    const scanner = new ScannerRun(runId, { ...deps,
      onFixComplete: async () => { await openBatchPR(deps as never, runId, client as never, trackerStore, "a/b") },
    } as never)
    spyOn(scanner, "pushToBranch").mockResolvedValue({ ok: true })
    deps.activeRuns.set(runId, scanner)
    const inner = scanner as unknown as { handleBridgeEvent(event: unknown): void }
    inner.handleBridgeEvent({ kind: "run_finished" })
    await finished.promise
    assert.equal(deps.activeRuns.has(runId), false)
    assert.equal(events.filter(event => event.type === "run_finished").length, 1)
    assert.deepEqual(events.at(-1), { type: "run_finished", status: "completed" })
    assert.ok(events.some(event => event.type === "push_result" && event.ok && event.prUrl === "https://github.com/a/b/pull/9"))
    assert.equal(warn.mock.calls.length, 1)
    assert.match(String(warn.mock.calls[0][0]), cleanup === "stalled" ? /cleanup.*30s/ : /cleanup.*fixture cleanup failure/)
    if (cleanup === "stalled") assert.ok(timer.mock.calls.some(call => call[1] === 30_000))
  } finally {
    timer.mockRestore()
    warn.mockRestore()
    store.close()
    await rm(dir, { recursive: true })
  }
})

test("passing batch opens a PR and maps every finding status to its row", async () => {
  const r = await setup([{ name: "lint", command: "php -l", ok: true }], { 1: "fixed", 2: "false positive", 3: "needs human" })
  assert.equal(r.pr, 9)
  assert.deepEqual(r.prs.map(p => p.draft), [false])
  assert.equal(r.prs[0].title, "【P1·SQL 注入】1.php 加固")
  assert.match(r.pushes[0], /^security\/sqli-app-api-run1$/)
  assert.deepEqual([1, 2, 3, 4].map(n => statusOf(r.rows, n).status), ["in progress", "ignored", "needs human", "open"])
  assert.equal(statusOf(r.rows, 1).pr, "[PR #9](https://github.com/a/b/pull/9)")
  assert.equal(statusOf(r.rows, 2).pr, "")
  assert.equal(statusOf(r.rows, 2).reason, "r2")
  assert.equal(statusOf(r.rows, 3).reason, "r3")
  assert.equal(statusOf(r.rows, 3).severity, "P2")
  assert.equal(r.push.prUrl, "https://github.com/a/b/pull/9")
  assert.equal(r.released, true)
})

test("failing or missing checks keep draft fixes in progress until their PR resolves", async () => {
  for (const checks of [[{ name: "lint", command: "php -l", ok: false }], undefined]) {
    const r = await setup(checks, { 1: "fixed" })
    assert.deepEqual(r.prs.map(p => p.draft), [true])
    assert.equal(statusOf(r.rows, 1).status, "in progress")
    assert.equal(statusOf(r.rows, 1).reason, "Checks fail in the draft PR")
    assert.equal(statusOf(r.rows, 1).pr, "[PR #9](https://github.com/a/b/pull/9)")
    assert.equal(candidates(r.rows, []).some(row => row.id === statusOf(r.rows, 1).id), false)
    r.client.prState = async () => checks ? "merged" : "closed"
    assert.equal(await refreshRows(r.client, r.trackerStore, "a/b"), 1)
    const rows = r.trackerStore.files[0].rows
    assert.equal(statusOf(rows, 1).status, checks ? "fixed" : "open")
    assert.equal(statusOf(rows, 1).pr, checks ? "[PR #9](https://github.com/a/b/pull/9)" : "")
  }
})

test("a failed push returns findings to Pick with the failure reason", async () => {
  const r = await setup([{ name: "lint", command: "php -l", ok: true }], { 1: "fixed", 2: "false positive", 3: "needs human" }, undefined, "fixture push failure")
  assert.equal(r.pr, undefined)
  assert.equal(r.prs.length, 0)
  assert.equal(r.released, true)
  assert.equal(statusOf(r.rows, 1).status, "open")
  assert.equal(statusOf(r.rows, 1).reason, "Push failed: fixture push failure")
  assert.equal(statusOf(r.rows, 1).pr, "")
  assert.equal(statusOf(r.rows, 2).status, "ignored")
  assert.equal(statusOf(r.rows, 3).status, "needs human")
  assert.equal(statusOf(r.rows, 3).reason, "r3")
  assert.equal(statusOf(r.rows, 3).severity, "P2")
  assert.equal(candidates(r.rows, []).length, 2)
})

test("a batch with no fix opens no PR and returns rows to Pick", async () => {
  const r = await setup([{ name: "lint", command: "php -l", ok: true }], { 1: "false positive" }, "")
  assert.equal(r.pr, undefined)
  assert.equal(r.prs.length, 0)
  assert.equal(r.pushes.length, 0)
  assert.deepEqual([1, 2].map(n => statusOf(r.rows, n).status), ["ignored", "open"])
  assert.equal(r.released, true)
})

test("a batch preserves ignored decisions and keeps unfixed findings open", async () => {
  const r = await setup([{ name: "lint", command: "php -l", ok: true }], { 1: "fixed", 2: "ignored", 3: "open", 4: "won't fix" })
  assert.deepEqual([1, 2, 3, 4].map(n => statusOf(r.rows, n).status), ["in progress", "ignored", "open", "ignored"])
  assert.equal(statusOf(r.rows, 2).reason, "r2")
  assert.equal(statusOf(r.rows, 4).pr, "")
})

test("PR body lists vendor moves", () => {
  const options = { category: "misc", subsystem: "example/client", files: [], newTests: [], lines: 0,
    fixed: [], checks: [], failing: false }
  assert.ok(!prBody({ ...options, notes: {} }).includes("Vendor packages moved"))
  const body = prBody({ ...options, notes: { vendor_upgrades: [
    { tree: "sdk/vendor", package: "example/client", from: "1.0", to: "1.1" },
  ] } })
  assert.ok(body.includes("`sdk/vendor`: `example/client` 1.0 → 1.1"))
})

test("a thrown PR step records the error and publishes a failed push result", async () => {
  const { recordBatchError } = await import("../handlers/pick.ts")
  const dir = await mkdtemp(join(tmpdir(), "ola-agent-"))
  const store = await Store.open(`${dir}/test.sqlite`)
  const events: unknown[] = []
  try {
    store.ensureSession("s1")
    store.createRun({ runId: "run", sessionId: "s1", repoUrl: "https://github.com/a/b", branch: "main", skill: "ola-security-audit", model: "opus", effort: "high", mode: "fix" })
    store.updateRunStatus("run", "completed")
    const deps = { store, bus: { publish(_id: string, event: unknown) { events.push(event) } } }
    recordBatchError(deps as never, "run", new Error("PR creation failed"))
    assert.equal(store.getRun("run")?.error, "PR creation failed")
    assert.equal(store.getRun("run")?.status, "completed")
    assert.deepEqual(events, [{ type: "push_result", ok: false, error: "PR creation failed" }])
  } finally { store.close(); await rm(dir, { recursive: true }) }
})

test("OLA_AGENT_DRAFT_PRS opens a passing batch as a draft", async () => {
  const previous = process.env["OLA_AGENT_DRAFT_PRS"]
  process.env["OLA_AGENT_DRAFT_PRS"] = "1"
  try {
    const r = await setup([{ name: "lint", command: "php -l", ok: true }], { 1: "fixed", 3: "needs human" })
    assert.deepEqual(r.prs.map(pr => pr.draft), [true])
    assert.equal(r.push.draft, true)
    assert.equal(statusOf(r.rows, 3).status, "needs human")
  } finally {
    if (previous === undefined) delete process.env["OLA_AGENT_DRAFT_PRS"]
    else process.env["OLA_AGENT_DRAFT_PRS"] = previous
  }
})

test("a needs-human verdict survives a batch without a PR", async () => {
  const r = await setup(undefined, { 3: "needs human" })
  assert.equal(r.pr, undefined)
  assert.deepEqual([statusOf(r.rows, 3).status, statusOf(r.rows, 3).severity, statusOf(r.rows, 3).reason], ["needs human", "P2", "r3"])
  assert.ok(!candidates(r.rows, []).some(row => row.id === statusOf(r.rows, 3).id))
})

for (const failAt of ["push", "createPR", "save"] as const) {
  test(`needs-human verdicts survive refresh after a thrown ${failAt} step`, async () => {
    const r = await setup([{ name: "lint", command: "php -l", ok: true }], { 1: "fixed", 3: "needs human" }, undefined, undefined, undefined, failAt)
    const human = statusOf(r.rows, 3)
    assert.deepEqual([human.status, human.severity, human.reason, human.pr], ["needs human", "P2", "r3", ""])
    assert.ok(!candidates(r.rows, []).some(row => row.id === human.id))
  })
}

test("a failed PR create reopens the rows and records the pushed branch", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ola-pr-fail-"))
  const store = await Store.open(`${dir}/test.sqlite`)
  const trackerStore = new MemoryStore([row(1)])
  const client = {
    async openPRFiles() { return [] }, async prState() { return "open" as const },
    async createPR(): Promise<number> { throw new Error("GitHub rejected the PR") },
  }
  const activeRuns = new Map()
  const events: { runId: string, event: RunEvent }[] = []
  const deps = { store, runsRootDir: dir, activeRuns,
    bus: { publish(runId: string, event: RunEvent) { events.push({ runId, event }) } },
    controller: { async stopAndRemove() {} } }
  try {
    store.ensureSession("s1")
    const runId = "run-1"
    store.createRun({ runId, sessionId: "s1", repoUrl: "https://github.com/fail/repo", branch: "main",
      skill: "ola-security-audit", model: "opus", effort: "high", mode: "fix" })
    store.insertFinding(runId, { id: row(1).id, category: "sqli", severity: "P1", status: "fixed" })
    const art = `${dir}/${runId}/artifacts`
    await mkdir(art, { recursive: true })
    await writeFile(`${art}/picked.json`, JSON.stringify([row(1)]))
    await writeFile(`${art}/working.patch`, "diff --git a/app/api/1.php b/app/api/1.php\n+safe\n")
    activeRuns.set(runId, { async pushToBranch() { return { ok: true } } })
    const error = await openBatchPR(deps as never, runId, client, trackerStore, "fail/repo").then(() => undefined, (error: Error) => {
      recordBatchError(deps as never, runId, error)
      return error
    })
    assert.match(error!.message, /GitHub rejected the PR/)
    assert.match(store.getRun(runId)!.error!, /Branch security\/.* pushed without a PR: GitHub rejected the PR/)
    const reopened = statusOf(trackerStore.files[0].rows, 1)
    assert.equal(reopened.status, "open")
    assert.equal(reopened.pr, "")
    assert.equal(reopened.reason, store.getRun(runId)!.error)
    assert.equal(activeRuns.size, 0)
    assert.ok(events.some(({ runId: id, event }) => id === runId && event.type === "push_result" && !event.ok))
  } finally { store.close(); await rm(dir, { recursive: true }) }
})

test("PR body neutralizes agent-written mentions, links, HTML, </details> and backticks", () => {
  const evil = "@alice [x](https://evil.example) ![i](https://evil.example/i.png) <img src=x> </details> `code`"
  const body = prBody({ category: "sqli", subsystem: "app/api", files: ["app/`x`.php"], newTests: [], lines: 1, fixed: [{ ...row(1), file: "app/`x`.php" }],
    notes: { fix_pattern: evil, rollback: evil, later: [evil], review_notes: [evil], decisions: [evil, { ask: evil, detail: `line\n${evil}` }],
      shared_helpers: [{ name: evil, callers: 1 }], caller_repos: ["r"], callers: [{ route: evil, repo: "r", file: "f", line: 1 }] },
    checks: [{ name: evil, command: "php -l `x` @bob", ok: true }], failing: false })
  // Text inside a code span is inert on GitHub, so check the prose around the spans.
  const prose = body.replace(/`[^`\n]*`/g, "")
  for (const raw of ["@alice", "[x]", "](https", "<img", "`code`"]) assert.ok(!prose.includes(raw), raw)
  assert.equal(prose.split("</details>").length - 1, prose.split("<details").length - 1)
  // Code spans hold the value with its backticks dropped, so they never close early.
  assert.ok(body.includes("`php -l x @bob`"))
  assert.ok(body.includes("**`app/x.php`**\n\n- `:3`"))
  assert.ok(body.includes("  line\n  &#64;alice"))
  assert.ok(prBody({ category: "sqli", subsystem: "app/api", files: [], newTests: [], lines: 1, fixed: [], failing: false, checks: [],
    notes: { later: Array.from({ length: 40 }, (_, i) => `item ${i}`), rollback: "x".repeat(5000) } }).includes("- … 10 more"))
})

test("PR body keeps bare URLs readable without GFM autolinks in agent prose", () => {
  const prose = "https://evil.example/attack www.example.com HTTP://www.example.com FTP://evil.example/file"
  const base = { category: "sqli", subsystem: "app", files: [], newTests: [], lines: 0, checks: [], failing: false }
  const cases = [
    { fix_pattern: prose }, { vulnerability: [prose] }, { impact: [prose] }, { later: [prose] },
    { review_notes: [prose, { note: prose, action: "fixed" as const }] }, { rollback: prose },
    { decisions: [prose, { ask: prose, detail: prose }] },
    { vendor_upgrades: [{ tree: "vendor", package: "pkg", from: prose, to: prose }] },
  ]
  const bodies = cases.map(notes => prBody({ ...base, fixed: [], notes }))
  bodies.push(prBody({ ...base, fixed: [{ ...row(1), fixSummary: prose, reason: prose }], notes: {} }))
  bodies.push(prBody({ ...base, fixed: [], notes: {}, checks: [{ name: prose, command: "lint", ok: true }] }))
  for (const body of bodies) {
    const html = Bun.markdown.html(body, { autolinks: true })
    assert.doesNotMatch(html, /<a\b|<img\b/)
    assert.ok(html.includes(prose), html)
  }
})

test("PR body truncation preserves complete code tags and closes details before the notice", () => {
  const base = { category: "sqli", subsystem: "app", files: [], newTests: [], lines: 0,
    fixed: [], checks: [], failing: false }
  const item = "`" + "@".repeat(498) + "`"
  for (const notes of [
    { later: Array(30).fill(item) },
    { review_notes: Array(30).fill(item) },
    { decisions: Array.from({ length: 30 }, () => ({ ask: item, detail: item })) },
  ]) {
    const body = prBody({ ...base, notes })
    assert.ok(body.length < 65_536, String(body.length))
    assert.ok(body.endsWith("完整内容见该次运行的 batch.json。"))
    for (const source of [body, Bun.markdown.html(body, { autolinks: true })]) {
      assert.equal((source.match(/<code>/g) ?? []).length, (source.match(/<\/code>/g) ?? []).length)
      assert.equal((source.match(/<details\b/g) ?? []).length, (source.match(/<\/details>/g) ?? []).length)
    }
    assert.ok(body.lastIndexOf("</details>") < body.lastIndexOf("> PR 描述"))
  }
})

test("a malformed batch.json drops bad fields instead of failing the PR step", async () => {
  const r = await setup([{ name: "lint", command: "php -l", ok: true }], { 1: "fixed" }, undefined, undefined,
    { decisions: "not a list", later: { a: 1 }, review_notes: [1, "kept"], callers: "x", fix_pattern: 5 })
  assert.equal(r.pr, 9)
  assert.equal(r.prs.length, 1)
})

test("push.json is not written through a symlink", async () => {
  const outside = await mkdtemp(join(tmpdir(), "ola-outside-"))
  try {
    await writeFile(join(outside, "target"), "original")
    const r = await setup([{ name: "lint", command: "php -l", ok: true }], { 1: "fixed" }, undefined, undefined, undefined, undefined,
      art => symlink(join(outside, "target"), join(art, "push.json")))
    assert.equal(r.pr, 9)
    assert.equal(await readFile(join(outside, "target"), "utf8"), "original")
  } finally { await rm(outside, { recursive: true }) }
})

test("PR body keeps line breaks in multi-line notes and stays under GitHub's size limit", () => {
  const base = { category: "sqli", subsystem: "app/api", files: ["app/api/1.php"], newTests: [], lines: 1,
    fixed: [row(1)], checks: [{ name: "lint", command: "php -l", ok: true }], failing: false }
  const body = prBody({ ...base, notes: { rollback: "1. Revert\r\n2. Clear cache", later: ["a\nb"] } })
  assert.ok(body.includes("1. Revert<br>2. Clear cache"))
  assert.ok(body.includes("- a<br>b"))
  const huge = "(".repeat(2000)
  const big = prBody({ ...base, notes: { decisions: Array.from({ length: 30 }, () => ({ ask: huge, detail: huge })),
    later: Array.from({ length: 30 }, () => huge), review_notes: Array.from({ length: 30 }, () => huge), rollback: huge, fix_pattern: huge } })
  assert.ok(big.length < 65_536, String(big.length))
  assert.ok(big.endsWith("完整内容见该次运行的 batch.json。"))
})

test("an error before the push still releases the container", async () => {
  const { released, pushes } = await setup([{ name: "t", command: "t", ok: true }], { 1: "fixed" }, undefined, undefined, undefined, "tracking")
  assert.equal(released, true)
  assert.deepEqual(pushes, [])
})


for (const status of ["fixed", "needs human", "ignored"] as const) {
  test(`batch ${status} writes keep fresh unrelated owner fields after conflict`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "secpatch-batch-conflict-"))
    try {
      const art = join(dir, "run-1", "artifacts")
      await mkdir(art, { recursive: true })
      await writeFile(join(art, "picked.json"), JSON.stringify([row(1)]))
      await writeFile(join(art, "checks.json"), JSON.stringify([{ name: "lint", command: "fixture lint", ok: true }]))
      await writeFile(join(art, "working.patch"), "diff --git a/app/api/1.php b/app/api/1.php\n+x\n")
      const trackerStore = new MemoryStore([row(1), row(2)])
      const write = trackerStore.write.bind(trackerStore)
      let conflicted = false
      trackerStore.write = async (file, rows, message) => {
        if (!conflicted) {
          conflicted = true
          trackerStore.files[0].rows = [row(1, { severity: "P0", reason: "fresh owner reason", file: "new.php", lines: [9] }), row(2, { status: "ignored", reason: "unselected" })]
          throw new TrackerConflict()
        }
        return write(file, rows, message)
      }
      const deps = { runsRootDir: dir, store: { getRun: () => ({ mode: "fix", branch: "main" }),
        listFindings: () => [{ id: row(1).id, category: "sqli", status, severity: "P2", reason: "" }], getContainerId: () => undefined },
        activeRuns: new Map([["run-1", { pushToBranch: async () => ({ ok: true }) }]]), controller: { stopAndRemove: async () => {} }, bus: { publish() {} } }
      const client = { openPRFiles: async () => [], prState: async () => "open" as const, createPR: async () => 9 }
      await openBatchPR(deps as never, "run-1", client, trackerStore, "owner/repo")
      assert.deepEqual(trackerStore.files[0].rows, [row(1, { severity: status === "needs human" ? "P2" : "P0", reason: "fresh owner reason", file: "new.php", lines: [9], status: status === "fixed" ? "in progress" : status, pr: status === "fixed" ? "[PR #9](https://github.com/owner/repo/pull/9)" : "" }), row(2, { status: "ignored", reason: "unselected" })])
    } finally { await rm(dir, { recursive: true, force: true }) }
  })
}

test("a failed adoption record still links rows, releases and publishes the push result", async () => {
  const warn = spyOn(console, "warn").mockImplementation(() => {})
  try {
    const r = await setup([{ name: "lint", command: "php -l", ok: true }], { 1: "fixed" }, undefined, undefined, undefined, "record")
    assert.equal(r.pr, 9)
    assert.equal(statusOf(r.rows, 1).pr, "[PR #9](https://github.com/a/b/pull/9)")
    assert.equal(r.push.pr, 9)
    assert.equal(r.released, true)
    assert.ok(r.events.some(event => event.type === "push_result" && event.ok && event.prUrl === "https://github.com/a/b/pull/9"))
    assert.match(String(warn.mock.calls[0][0]), /adoption record failed.*fixture record failure/)
  } finally { warn.mockRestore() }
})

test("batch PR records the pushed SHA in shared tracker metadata and local push artifact", async () => {
  const result = await setup([{ name: "lint", command: "php -l", ok: true }], { 1: "fixed" })
  assert.equal(result.trackerStore.files[0].prs?.[result.pr!].pushedSha, "a".repeat(40))
  assert.equal(result.push.pushedSha, "a".repeat(40))
})

test("PR body groups sites by file and sorts each file by line, without severity", () => {
  const fixed = [
    { ...row(1), severity: "P2", file: "app/z.php", lines: [9, 8], fixSummary: "Z::run() binds input" },
    { ...row(2), severity: "P0", file: "app/a.php", lines: [20], fixSummary: "A::run() checks input" },
    { ...row(3), severity: "P1", file: "app/a.php", lines: [1] },
    { ...row(4), severity: "P0", file: "app/a.php", lines: [2] },
  ]
  const body = prBody({ category: "sqli", subsystem: "app", files: [], newTests: ["tests/X.php"], lines: 99,
    fixed, notes: { restart: [], review_rounds: 2 }, checks: [{ name: "lint", command: "lint", ok: true }], failing: false,
    trackerUrl: "https://github.com/example/repo/issues/1" })
  assert.ok(body.endsWith("\n\n<details><summary>✅ 检查 1/1 · 🧪 新增测试 1 · 🔍 Review 2 轮</summary>\n\n**验证**\n\n- ✅ lint：`lint`\n\n新增测试：\n- `tests/X.php`\n\n</details>"))
  assert.ok(body.includes("**`app/a.php`**\n\n- `:1`\n- `:2`\n- `:20` A::run&#40;&#41; checks input\n\n**`app/z.php`**\n\n- `:8,9` Z::run&#40;&#41; binds input"))
  assert.ok(!/`P[0-2]`/.test(body))
  assert.ok(body.includes("## 关联\n\n- [Tracker](https://github.com/example/repo/issues/1)"))
  assert.ok(!body.includes("| 级别 |") && !body.includes("## 修复"))
  for (const item of fixed) assert.ok(!body.includes(item.id))
  assert.equal(fixed[0].file, "app/z.php")
  assert.deepEqual(fixed[0].lines, [9, 8])
})

test("restart is unknown, unnecessary or commands; rollback and failed checks fold correctly", () => {
  const base = { category: "sqli", subsystem: "app", files: [], newTests: [], lines: 0, fixed: [row(1)],
    checks: [{ name: "lint", command: "php -l", ok: false }, { name: "test", command: "phpunit", ok: true }], failing: false }
  const unknown = prBody({ ...base, notes: {} })
  assert.ok(unknown.includes("## 需要重启的服务\n\n未说明，合并前请确认。"))
  assert.ok(unknown.includes("❌ 检查 1/2 失败"))
  assert.ok(unknown.includes("<details open><summary>❌ 检查 1/2 失败"))
  assert.ok(unknown.includes("- ❌ lint：`php -l`\n- ✅ test：`phpunit`"))
  assert.ok(!unknown.includes("[!WARNING]"))
  const empty = prBody({ ...base, notes: batchNotes({ restart: [], rollback: "" }) })
  assert.ok(empty.includes("## 需要重启的服务\n\n无需重启。") && !empty.includes("回滚步骤"))
  const body = prBody({ ...base, notes: batchNotes({ restart: ['supervisorctl restart `worker`\n@ops', 1, '<tag> | [x](url)'], rollback: "Clear cache" }) })
  assert.ok(body.includes("## 需要重启的服务\n\n```sh\nsupervisorctl restart worker@ops\n<tag> | [x](url)\n```"))
  const merged = prBody({ ...base, notes: { restart: ["supervisorctl restart a:*", "systemctl restart php-fpm", "supervisorctl restart b:*", "make reload", "make reload"] } })
  assert.ok(merged.includes("```sh\nsupervisorctl restart a:* b:*\nsystemctl restart php-fpm\nmake reload\n```"))
  assert.ok(!body.includes("🚀 无需重启"))
  assert.ok(!body.includes("↩️"))
  assert.ok(body.includes("<details><summary>回滚步骤</summary>\n\nClear cache"))
  assert.deepEqual(batchNotes({ restart: [1, "ok", false] }).restart, ["ok"])
  assert.equal(batchNotes({ restart: "bad" }).restart, undefined)
  assert.equal(batchNotes({ restart: Array(40).fill("cmd") }).restart?.length, 30)
})

test("review notes accept old strings and valid action objects and count each kind", () => {
  const notes = batchNotes({ review_rounds: 2, review_notes: ["Legacy note", { note: "Bound input", action: "fixed" },
    { note: "Kept signature", action: "rejected" }, { note: "Added test", action: "fixed" },
    null, 1, {}, { note: 1, action: "fixed" }, { note: "bad", action: "other" }] })
  assert.equal(notes.review_notes?.length, 4)
  const base = { category: "sqli", subsystem: "app", files: [], newTests: [], lines: 0, fixed: [], checks: [], failing: false }
  const body = prBody({ ...base, notes })
  assert.ok(body.includes("🔍 Review 2 轮（2 改 · 1 拒）</summary>"))
  assert.ok(body.includes("**Review 记录**"))
  assert.ok(body.includes("- Legacy note\n- 改：Bound input\n- 拒：Kept signature\n- 改：Added test"))
  assert.ok(prBody({ ...base, notes: { review_notes: notes.review_notes?.slice(1) } }).includes("（2 改 · 1 拒）</summary>"))
  assert.equal(batchNotes({ review_rounds: "2" }).review_rounds, undefined)
  assert.equal(batchNotes({ review_rounds: -1 }).review_rounds, undefined)
})

test("site code spans keep hostile file values inert, including pipes and backslashes", () => {
  const files = ["app/[x](https://evil.example)|lost.php", "app/[x](https://evil.example)\\|lost.php",
    "app/\\\\|`x`\r\n<img src=x>@alice.php"]
  for (const file of files) {
    const severity = "P1\\|`x`\r\n[x](https://evil.example)<img>@ops"
    const body = prBody({ category: "sqli", subsystem: "app", files: [], newTests: [], lines: 0,
      fixed: [row(1, { file, severity })], notes: {}, checks: [], failing: false })
    const html = Bun.markdown.html(body)
    const codes = [...html.matchAll(/<code>([\s\S]*?)<\/code>/g)].map(match => match[1])
    assert.ok(codes.includes(file.replace(/[`\r\n]/g, "").replaceAll("<", "&lt;").replaceAll(">", "&gt;")))
    assert.ok(!body.includes("evil.example)<img>@ops"))
    assert.doesNotMatch(html, /<a\b|<img\b|<table\b/)
    assert.ok(html.includes("<strong><code>"))
  }
})

test("applicable alerts lead in draft, behavior and missing-review order; the status fold opens at the bottom", () => {
  const body = prBody({ category: "sqli", subsystem: "app", files: [], newTests: [], lines: 0, fixed: [],
    notes: { decisions: [{ ask: "Change behavior?", behavior: true }], review_did_not_run: [1, 2] },
    checks: [{ name: "lint", command: "lint", ok: false }], failing: true })
  const alerts = body.split("\n\n").slice(0, 4)
  assert.ok(alerts.every(alert => alert.startsWith("> [!WARNING]\n> ")))
  assert.match(alerts[0], /两轮后检查仍失败/)
  assert.match(alerts[1], /改变了运行行为/)
  assert.match(alerts[2], /第 1 轮 Review 没有运行/)
  assert.match(alerts[3], /第 2 轮 Review 没有运行/)
  assert.ok(body.split("\n\n")[4].startsWith("## 合并前请确认"))
  assert.ok(body.includes("\n\n<details open><summary>❌ 检查 1/1 失败 ·"))
})


test("PR body follows the owner's section order, with verification and review folded under the status line at the bottom", () => {
  const body = prBody({ category: "sqli", subsystem: "app", files: [], newTests: [], lines: 0,
    fixed: [row(1)], checks: [{ name: "lint", command: "lint", ok: false }], failing: true,
    trackerUrl: "https://example.test/tracker", notes: {
      decisions: ["确认调用方？"], caller_repos: ["client"], callers: [], fix_pattern: "绑定参数\n保留签名",
      vulnerability: ["HTTP 参数到达 SQL sink，允许注入。", "CLI 参数到达 SQL sink，允许注入。"],
      impact: ["Api::run() ← HTTP controller，需登录，活跃代码。", "Task::run() ← CLI task，无需登录，活跃代码。"],
      restart: [], later: ["app/a.php:1 sibling sink", "app/b.php:2 sibling sink"],
      review_notes: [{ note: "绑定参数", action: "fixed" }], rollback: "Clear cache",
    } })
  const titles = ["> [!WARNING]", "## 合并前请确认 (1)", "## 相关仓库中的调用方 (0)",
    "## 改动", "## 漏洞说明", "## 影响范围", "## 需要重启的服务", "## 关联", "留待以后 (2)", "回滚步骤", "❌ 检查", "**验证**", "**Review 记录**"]
  for (let i = 1; i < titles.length; i++) assert.ok(body.indexOf(titles[i - 1]) < body.indexOf(titles[i]), titles[i])
  assert.ok(body.includes("## 改动\n\n绑定参数 保留签名\n\n**`app/api/1.php`**"))
  assert.ok(body.includes("## 漏洞说明\n\n- HTTP 参数到达 SQL sink，允许注入。\n- CLI 参数到达 SQL sink，允许注入。"))
  assert.ok(body.includes("## 影响范围\n\n- Api::run&#40;&#41; ← HTTP controller，需登录，活跃代码。\n- Task::run&#40;&#41; ← CLI task，无需登录，活跃代码。"))
  assert.ok(body.includes("<details open><summary>❌ 检查 1/1 失败 · 🧪 新增测试 0（1 改）</summary>"))
})

test("vulnerability falls back to finding evidence or a non-verdict line, capped at 120 characters", () => {
  const base = { category: "sqli", subsystem: "app", files: [], newTests: [], lines: 0, checks: [], failing: false }
  const fixed = [
    row(1, { reason: "Verdict: 真阳。\r\nEvidence: HTTP input reaches query()\r\nFix: Bind it" }),
    row(2, { reason: "\nVerdict: 真阳。\n\nLegacy input reaches exec()\nsecond line" }),
    row(3, { reason: "Verdict: 真阳。" }),
    row(4, { reason: "  \nVerdict: 真阳。\nEvidence:  \nVerdict:\n  " }),
    row(5, { reason: `Evidence: ${"证".repeat(130)}\nFix: hidden` }),
  ]
  const body = prBody({ ...base, fixed, notes: {} })
  const vulnerability = body.split("## 漏洞说明\n\n")[1].split("\n\n## 影响范围")[0]
  assert.equal(vulnerability, `- HTTP input reaches query&#40;&#41;\n- Legacy input reaches exec&#40;&#41;\n- ${"证".repeat(119)}…`)
  assert.ok(!body.includes("Verdict:") && !body.includes("second line") && !body.includes("Fix: hidden"))
  assert.ok(body.includes("## 影响范围\n\n见 Tracker 中各行的 reason。"))
  const explicit = prBody({ ...base, fixed, notes: { vulnerability: ["Provided explanation"] } })
  assert.ok(explicit.includes("## 漏洞说明\n\n- Provided explanation"))
  assert.ok(!explicit.includes("HTTP input reaches"))
  for (const notes of [{}, { vulnerability: [] }]) {
    const empty = prBody({ ...base, fixed: fixed.slice(2, 4), notes })
    assert.ok(!empty.includes("## 漏洞说明"))
    assert.ok(!empty.includes("修复 agent 没有给出"))
  }
})

test("related section handles tracker and later independently, and uses none when both are absent", () => {
  const base = { category: "sqli", subsystem: "app", files: [], newTests: [], lines: 0, fixed: [], checks: [], failing: false }
  for (const trackerUrl of [undefined, "https://example.test/tracker"]) {
    for (const later of [undefined, ["one", "two"]]) {
      const body = prBody({ ...base, trackerUrl, notes: { later } })
      const related = body.split("## 关联\n\n")[1].split(/\n\n<details(?: open)?><summary>(?:✅|❌|检查)/)[0]
      assert.equal(related.includes("- [Tracker](https://example.test/tracker)"), !!trackerUrl)
      assert.equal(related.includes("留待以后 (2)"), !!later)
      if (later) assert.ok(related.includes("- one\n- two"))
      if (!trackerUrl && !later) assert.equal(related, "无")
    }
  }
})

test("new batch note lists filter shapes and cap entries; fixed site bullets are capped too", () => {
  for (const field of ["vulnerability", "impact"] as const) {
    assert.deepEqual(batchNotes({ [field]: [null, false, {}, "ok", 1] })[field], ["ok"])
    assert.equal(batchNotes({ [field]: "bad" })[field], undefined)
    assert.equal(batchNotes({ [field]: Array(40).fill("ok") })[field]?.length, 30)
  }
  const body = prBody({ category: "sqli", subsystem: "app", files: [], newTests: [], lines: 0,
    fixed: Array.from({ length: 40 }, (_, i) => row(i, { file: "app/x.php", lines: [i + 1] })),
    notes: { vulnerability: Array(40).fill("vuln"), impact: Array(40).fill("impact") }, checks: [], failing: false })
  assert.equal((body.match(/^- `:\d+`/gm) ?? []).length, 30)
  assert.equal((body.match(/- … 10 more/g) ?? []).length, 3)
})

test("new prose and restart sites escape agent text without opening links, HTML or extra lines", () => {
  const evil = "@ops [x](https://evil.example) ![i](url) <img> </details> `x` \\|\r\nnext"
  const base = { category: "sqli", subsystem: "app", files: [], newTests: [], lines: 0, checks: [], failing: false }
  const escaped = "&#64;ops &#91;x&#93;&#40;https&#58;//evil.example&#41; !&#91;i&#93;&#40;url&#41; &lt;img&gt; &lt;/details&gt; <code>x</code> &#92;&#124; next"
  for (const source of ["fix_pattern", "fixSummary", "vulnerability", "impact", "reason", "restart"] as const) {
    const body = prBody({ ...base,
      fixed: [{ ...row(1), fixSummary: source === "fixSummary" ? evil : undefined, reason: source === "reason" ? `Evidence: ${evil}` : "" }],
      notes: source === "fix_pattern" ? { fix_pattern: evil } : source === "vulnerability" ? { vulnerability: [evil] }
        : source === "impact" ? { impact: [evil] } : source === "restart" ? { restart: [evil] } : {},
    })
    const html = Bun.markdown.html(body)
    assert.doesNotMatch(html, /<a\b|<img\b/)
    assert.equal((html.match(/<details/g) ?? []).length, (html.match(/<\/details>/g) ?? []).length)
    if (source === "restart") assert.ok(body.includes("```sh\n@ops [x](https://evil.example) ![i](url) <img> </details> x \\|next\n```"))
    else if (source === "reason") assert.ok(body.includes(escaped.split(" next")[0]))
    else assert.ok(body.includes(escaped), source)
    const prose = body.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "")
    assert.doesNotMatch(prose, /@ops|<img>|\[x\]\(/)
  }
})

test("agent prose renders paired backticks as escaped inline code and leaves unmatched backticks inert", () => {
  const prose = "Use `$roomUid` and `</code><img src=x> [x](url) @ops &lt; \\|` then `unfinished"
  const rendered = "Use <code>$roomUid</code> and <code>&lt;/code&gt;&lt;img src=x&gt; &#91;x&#93;&#40;url&#41; &#64;ops &amp;lt; &#92;&#124;</code> then &#96;unfinished"
  const body = prBody({ category: "sqli", subsystem: "app", files: [], newTests: [], lines: 0,
    fixed: [{ ...row(1), fixSummary: prose }], checks: [], failing: false,
    notes: { fix_pattern: prose, vulnerability: [prose], impact: [prose], later: [prose],
      review_notes: [prose, { note: prose, action: "fixed" }], decisions: [prose, { ask: prose, detail: prose }], rollback: prose } })
  assert.equal(body.split(rendered).length - 1, 11)
  const html = Bun.markdown.html(body)
  assert.doesNotMatch(html, /<img\b|<a\b/)
  assert.ok(html.includes("<code>&lt;/code&gt;&lt;img src=x&gt;"))
  assert.equal((html.match(/<code>/g) ?? []).length, (html.match(/<\/code>/g) ?? []).length)
  const pattern = body.split("## 改动\n\n")[1].split("\n\n")[0]
  const table = Bun.markdown.html(`| Prose | Other |\n| --- | --- |\n| ${pattern} | safe |`)
  assert.equal((table.match(/<td>/g) ?? []).length, 2)
  assert.ok(table.includes("&#92;|</code>") || table.includes("\\|</code>"))
})

test("openBatchPR writes the PR title and body in the language stored on the run", async () => {
  const checks = [{ name: "lint", command: "lint", ok: true }]
  const en = await setup(checks, { 1: "fixed" }, undefined, undefined, undefined, undefined, undefined, "en")
  assert.ok(en.prs[0].title.startsWith("[P1·SQL injection] "))
  assert.ok(en.prs[0].body.startsWith("## Description\n\n### Changes\n"))
  for (const language of [undefined, "zh" as const]) {
    const zh = await setup(checks, { 1: "fixed" }, undefined, undefined, undefined, undefined, undefined, language)
    assert.ok(zh.prs[0].title.startsWith("【P1·SQL 注入】"))
    assert.ok(zh.prs[0].body.startsWith("## 改动\n"))
  }
})

test("openBatchPR passes each fixed finding's summary and reason to the body", async () => {
  const result = await setup([{ name: "lint", command: "lint", ok: true }], { 1: "fixed", 2: "open" })
  assert.ok(result.prs[0].body.includes("- `:3` Handler::fix1&#40;&#41; binds input"))
  assert.ok(result.prs[0].body.includes("## 漏洞说明\n\n- r1\n\n"))
  assert.ok(!result.prs[0].body.includes("Handler::fix2"))
})

test("test_note shows as one escaped line under the new tests, inside the status fold", () => {
  const base = { category: "sqli", subsystem: "app", files: [], newTests: ["tests/XTest.php"], lines: 0, fixed: [row(1)],
    checks: [{ name: "lint", command: "php -l", ok: true }], failing: false }
  const body = prBody({ ...base, notes: batchNotes({ test_note: "findUid 无法单测 <b>x</b>\n@ops，改用源码守卫" }) })
  assert.ok(body.includes("新增测试：\n- `tests/XTest.php`\n\nfindUid 无法单测 &lt;b&gt;x&lt;/b&gt; &#64;ops，改用源码守卫\n\n</details>"))
  assert.ok(!body.includes("## 合并前请确认"))
  assert.ok(!prBody({ ...base, notes: {} }).includes("源码守卫"))
  assert.equal(batchNotes({ test_note: 1 }).test_note, undefined)
})

for (const language of ["en", "zh"] as const) test(`non-blocking reviewer notes in ${language} PR body are deduplicated and escaped`, () => {
  const notes = batchNotes({ review_non_blocking: [" Suggestion ", "Suggestion", "<script>bad</script>", 1] })
  const body = prBody({ category: "sqli", subsystem: "api", files: [], lines: 0, checks: undefined, fixed: [], newTests: [], failing: false, language, notes })
  assert.ok(body.includes(language === "en" ? "Reviewer notes (non-blocking)" : "审查意见（非阻塞）"))
  assert.equal(body.match(/Suggestion/g)?.length, 1)
  assert.ok(!body.includes("<script>"))
  const empty = prBody({ category: "sqli", subsystem: "api", files: [], lines: 0, checks: undefined, fixed: [], newTests: [], failing: false, language, notes: batchNotes({ review_non_blocking: "bad" }) })
  assert.ok(!empty.includes("Reviewer notes (non-blocking)") && !empty.includes("审查意见（非阻塞）"))
})
