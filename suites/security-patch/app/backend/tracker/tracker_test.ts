import { test } from "bun:test"
import { strict as assert } from "node:assert"
import { GitHubTrackerStore, TrackerConflict, serializeTracker, type TrackerFile, type TrackerStore } from "./store.ts"
import { CATEGORIES, END, isDuplicate, parseRows, renderRows, replaceRows, START, STATUSES, today, upsert, validateRow } from "./rows.ts"
import type { Row } from "./rows.ts"
import { scrub, SECRET_PATTERNS } from "./scrub.ts"
import { branchCategory, Tracker, validateSeed } from "./tracker.ts"
import type { SeedPR } from "./tracker.ts"
import { run } from "../cli/seed_tracker.ts"

const row: Row = { id: "a".repeat(64), category: "sqli", file: "app/x.php", lines: [12, 40], severity: "P1", status: "open", reason: "normal code | <script>\n& text", date: "05-10-2026", pr: "" }
const body = (rows: Row[] = []) => `Human intro\r\n${START}${renderRows(rows)}${END}\r\nHuman footer\n`

test("all legacy statuses normalize in every issue table format and preserve row data", () => {
  assert.deepEqual(STATUSES, ["open", "in progress", "fixed", "ignored", "needs human"])
  const statuses = [
    ["candidate", "open"], ["deferred", "open"], ["picked", "in progress"], ["in PR", "in progress"],
    ["false positive", "ignored"], ["won't fix", "ignored"], ["needs human", "needs human"], ["fixed", "fixed"],
  ] as const
  const pr = "[PR #7](https://github.com/owner/repo/pull/7)"
  const original = { ...row, reason: "Review this site", pr }
  const site = renderRows([original]).split("\n").find(line => line.includes("<!-- id:"))!.split("|")[1].trim()
  for (const [legacy, status] of statuses) {
    assert.doesNotThrow(() => validateRow({ ...original, status: legacy }))
    for (const [cells, date] of [
      [`${site} | ${legacy} | P1 | ${row.date} | ${original.reason} | ${pr}`, row.date],
      [`${site} | ${legacy} | P1 | app | ${original.reason} | batch | ${pr}`, today()],
      [`${row.id} | ${row.file}:12 <!-- lines:12,40 --> | app | P1 | ${legacy} | ${original.reason} | batch | ${pr}`, today()],
    ]) {
      const legacyBody = `Human intro\n${START}\n| ${cells} |\n${END}\nHuman footer`
      const parsed = parseRows(legacyBody, "sqli")
      assert.deepEqual(parsed, [{ ...original, status, date }])
      const migrated = replaceRows(legacyBody, parsed)
      assert.deepEqual(parseRows(migrated, "sqli"), parsed)
      assert.equal(replaceRows(migrated, parsed), migrated)
      assert.ok(migrated.startsWith(`Human intro\n${START}`))
      assert.ok(migrated.endsWith(`${END}\nHuman footer`))
    }
  }
  for (const status of ["done", "__proto__", "toString"]) {
    assert.throws(() => validateRow({ ...row, status: status as never }), /invalid tracker row/)
  }
})

class Fake implements TrackerStore {
  files = new Map<string, TrackerFile>()
  writes = 0
  rows(category: string) { return this.files.get(category)!.rows }
  log(category: string) { return this.files.get(category)!.log.map(entry => entry.message) }
  async read() { return structuredClone([...this.files.values()]) }
  async write(file: TrackerFile, rows: Row[], message: string) {
    if (this.files.get(file.category)?.sha !== file.sha) throw new TrackerConflict()
    const next = { ...file, rows: structuredClone(rows),
      log: [...file.log, ...(message ? [{ at: "now", message }] : [])],
      sha: String(++this.writes), url: `https://example.test/${file.category}.json` }
    this.files.set(file.category, next)
    return structuredClone(next)
  }
}

async function withGitHubStore(fake: Fake, check: (store: GitHubTrackerStore) => Promise<void>) {
  const original = globalThis.fetch
  globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === "https://api.github.com/graphql") {
      assert.equal(init?.method, "POST")
      return Response.json({ data: { repository: { object: { entries: [...fake.files.values()].map(file => ({
        name: `${file.category}.json`, object: { text: serializeTracker("owner/repo", file), oid: file.sha ?? "initial" },
      })) } } } })
    }
    assert.equal(init?.method, "PUT")
    assert.ok(String(input).startsWith("https://api.github.com/repos/olaola-chat/security-patch-tracker/contents/trackers/repo/"))
    const data = JSON.parse(String(init?.body))
    const file = JSON.parse(Buffer.from(data.content, "base64").toString())
    assert.equal(data.sha, fake.files.get(file.category)?.sha ?? (fake.files.has(file.category) ? "initial" : undefined))
    const sha = String(++fake.writes)
    fake.files.set(file.category, { category: file.category, rows: file.rows, log: file.log, sha, url: "" })
    return Response.json({ content: { sha } })
  }, { preconnect: original.preconnect })
  try { await check(new GitHubTrackerStore("owner/repo", "fake-token")) }
  finally { globalThis.fetch = original }
}

test("marker round trip, all lines, escaped cells, and outside bytes", () => {
  assert.deepEqual(parseRows(body([row]), "sqli"), [row])
  assert.equal(replaceRows(body([row]), [row]), body([row]))
  const next = replaceRows(body(), [row])
  assert.ok(next.startsWith(`Human intro\r\n${START}`))
  assert.ok(next.endsWith(`${END}\r\nHuman footer\n`))
  assert.ok(next.includes("[x.php:12](https://github.com/owner/repo/blob/main/app/x.php#L12)"))
  assert.ok(next.includes("open: 1"))
  assert.deepEqual(upsert([row], { ...row, status: "fixed" }), [{ ...row, status: "fixed" }])
  assert.equal(upsert([], row).length, 1)
  for (const id of ["not-an-id", "pr0:app/x.php", "pr1:../x.php", "pr1:", "pr9007199254740992:x.php"]) {
    assert.throws(() => renderRows([{ ...row, id }]), /row id|relative path/)
  }
  for (const invalid of ["", `${END}${START}`, `${START}${START}${END}`, `${START}${END}${END}`]) {
    assert.throws(() => parseRows(invalid, "sqli"), /marker/)
  }
  assert.throws(() => parseRows(body().replace("| --- |", "| bad |",), "sqli"), /table|site/)
})

test("dedupe covers id, normalized file, every stored line, category, and both edges", () => {
  assert.ok(isDuplicate([row], { id: row.id, category: "cors", file: "other.php", line: 500 }))
  for (const offset of [-11, -10, 0, 10, 11]) {
    assert.equal(isDuplicate([row], { id: "different", category: "sqli", file: "/workspace/repo/app\\x.php", line: 40 + offset }), Math.abs(offset) <= 10)
  }
  assert.equal(isDuplicate([row], { id: "other", category: "cors", file: row.file, line: 40 }), false)
  assert.equal(isDuplicate([row], { id: "other", category: "sqli", file: "App/x.php", line: 40 }), false)
})

test("tracker fetches fresh rows, upserts, dedupes scans, and scrubs log entries and rows", async () => {
  const fake = new Fake()
  fake.files.set("sqli", { category: "sqli", rows: [row], log: [], url: "" })
  await withGitHubStore(fake, async store => {
    const tracker = new Tracker(store)
    fake.files.get("sqli")!.log.push({ at: "now", message: "New human note" })
    const secret = "AKIA" + "Q".repeat(16)
    await tracker.update("sqli", () => [{ ...row, status: "in progress", reason: secret }], `Pick ${secret}`)
    assert.equal(fake.log("sqli")[0], "New human note")
    assert.ok(!fake.rows("sqli")[0].reason.includes(secret))
    assert.ok(!fake.log("sqli")[1].includes(secret))
    assert.equal(fake.rows("sqli")[0].status, "in progress")
    const finding = { id: row.id, category: "sqli", file: row.file, line: 200, severity: "P1", status: "open" as const, reason: "" }
    await tracker.scan("sqli", [finding, { ...finding, id: "b".repeat(64), line: 50 }], "Scan complete")
    assert.equal(fake.rows("sqli").length, 1)
    await tracker.scan("sqli", [{ ...finding, id: "c".repeat(64), line: 51 }], "Next scan")
    assert.equal(fake.rows("sqli").length, 2)
    await assert.rejects(() => tracker.update("cors", () => [row], ""), /category/)
  })
})

const prs: SeedPR[] = ["merged", "open", "closed"].map((state, index) => ({ number: index + 1, headRefName: `sqli-${index}`, state: state as SeedPR["state"], sites: [{ file: `app/${index}.php`, lines: [12, 40] }] }))
test("seed states, one type first, all categories, unmapped reporting, and idempotence", async () => {
  const fake = new Fake()
  const tracker = new Tracker(fake)
  const input = [...prs, { ...prs[0], number: 99, headRefName: "unmapped" }]
  assert.deepEqual(await tracker.seed(input, "sqli"), { unmapped: [99], changed: ["sqli"] })
  assert.equal(fake.files.size, 1)
  const rows = fake.rows("sqli")
  assert.deepEqual(rows.map(row => row.status), ["fixed", "in progress", "open"])
  assert.equal(rows[0].id, "pr1:app/0.php")
  assert.deepEqual(rows[0].lines, [12, 40])
  assert.equal(rows[0].pr, "[PR #1](https://github.com/owner/repo/pull/1)")
  const snapshot = JSON.stringify([...fake.files])
  const writes = fake.writes
  const log = fake.log("sqli").length
  await tracker.seed(input, "sqli")
  assert.equal(JSON.stringify([...fake.files]), snapshot)
  assert.equal(fake.writes, writes)
  assert.equal(fake.log("sqli").length, log)
  await tracker.update("sqli", () => [{ ...rows[2], status: "ignored" }], "Decision")
  await tracker.seed(input, "sqli")
  assert.equal(fake.rows("sqli").find(item => item.id === rows[2].id)!.status, "ignored")
  await tracker.seed([...input, ...CATEGORIES.filter(category => category !== "sqli").map((category, i) => ({
    ...prs[0], number: 100 + i, category,
  }))])
  assert.deepEqual([...fake.files.keys()], CATEGORIES)
})

test("seed saves moved rows before removing their source and preserves edits on retry", async () => {
  const fake = new Fake()
  const source = { ...row, id: "pr1:app/x.php", status: "ignored" as const, reason: "Owner accepted this risk" }
  fake.files.set("sqli", { category: "sqli", rows: [source], log: [], url: "" })
  fake.files.set("cors", { category: "cors", rows: [], log: [], url: "" })
  const original = structuredClone(fake.files.get("sqli"))
  const write = fake.write.bind(fake)
  let fail = true
  fake.write = async (file, rows, message) => {
    if (file.category === "cors" && fail) throw new Error("destination failed")
    if (file.category === "cors") {
      assert.deepEqual(fake.rows("sqli"), [source])
      const unrelated = { ...row, id: "beef", file: "app/other.php", reason: "New human edit" }
      const sourceFile = fake.files.get("sqli")!
      await write(sourceFile, [source, unrelated], "New human note")
    }
    return write(file, rows, message)
  }
  const tracker = new Tracker(fake)
  const input = [{ ...prs[0], category: "cors", sites: [{ file: source.file, lines: source.lines }] }]
  await assert.rejects(tracker.seed(input), /destination failed/)
  assert.deepEqual(fake.files.get("sqli"), original)
  fail = false
  await tracker.seed(input)
  assert.deepEqual(fake.rows("cors"), [{ ...source, category: "cors" }])
  const remaining = fake.rows("sqli")
  assert.equal(remaining.length, 1)
  assert.equal(remaining[0].reason, "New human edit")
  assert.deepEqual(fake.log("sqli"), ["New human note"])
})

test("store rejects seeded ids with scrub-matching paths on repeated runs", async () => {
  const fake = new Fake()
  await withGitHubStore(fake, async store => {
    const tracker = new Tracker(store)
    for (const file of ["app/fake@example.test.php", "app/AKIA" + "Q".repeat(16) + ".php", 'app/password="fake!zzzzzzzzzzzzzzzzzzzz".php']) {
      const input = [{ ...prs[0], sites: [{ file, lines: [12] }] }]
      for (let attempt = 0; attempt < 2; attempt++) {
        await assert.rejects(() => tracker.seed(input, "sqli"), error => error instanceof Error && error.message === "unsafe tracker row id in sqli at line 12")
        assert.equal(fake.files.size, 0)
        assert.equal(fake.writes, 0)
      }
    }
  })
})

test("branch mappings and seed validation reject guessed or malformed input", async () => {
  const branches: [string, string][] = [
    ["sqli-x", "sqli"], ["cmd-injection-x", "cmd-injection"], ["deserialize-x", "deserialization"],
    ["unserialize-x", "deserialization"], ["fix-hash-equals-x", "signature-compare"], ["fix-token-compare", "signature-compare"],
    ["creds-x", "hardcoded-secret"], ["ssrf-x", "path-ssrf"], ["verifyimagesrv-x", "path-ssrf"],
    ["xscrypt-x", "weak-hash"], ["crypto-migration", "weak-hash"], ["loginexempt-whitelist", "api-no-auth"],
    ["secure-random-x", "weak-random"], ["log-redact-x", "log-leak"], ["deadcode-x", "dead-code"], ["cors-x", "cors"],
  ]
  for (const [branch, category] of branches) assert.equal(branchCategory(branch), category)
  assert.equal(branchCategory("other"), undefined)
  for (const [branch, category] of [["security/sqli-like-query-hardening", "sqli"], ["security/iap-notify-auth-and-sqli", "sqli"],
    ["security/auth-loginexempt-explicit-whitelist", "api-no-auth"], ["security/secure-random-xscrypt-key", "weak-random"],
    ["security/creds-payment", "hardcoded-secret"],
    ["security/command-injection-defense-in-depth", "cmd-injection"], ["security/clihelper-exec-escaping", "cmd-injection"],
    ["security/loose-token-comparison", "signature-compare"], ["security/loose-signature-comparison", "signature-compare"],
    ["security/hardcoded-signature-backdoor", "hardcoded-secret"], ["security/prod-credentials-external-config", "hardcoded-secret"],
    ["security/auth-gate-explicit-whitelist", "api-no-auth"]]) assert.equal(branchCategory(branch), category)
  assert.equal(branchCategory("security/idor-roomctrl-isadmin-source"), "misc")
  for (const bad of [null, {}, [{}], [{ ...prs[0], state: "unknown" }], [{ ...prs[0], sites: [{ file: "../x", lines: [1] }] }], [{ ...prs[0], sites: [{ file: "x", lines: [0] }] }]]) assert.throws(() => validateSeed(bad))
  for (const args of [[], ["--unknown"], ["--input"], ["--input", "x", "--only-type", "unknown"]]) await assert.rejects(() => run(args))
  await assert.rejects(() => run(["--input", "x"]), /required: --repo owner\/repo/)
})

test("scrub ports secret patterns, protects quotes, catches credential shapes, leaves normal code", () => {
  assert.equal(SECRET_PATTERNS.length, 18)
  const credentials = [
    "AKIA" + "A".repeat(16),
    "-----BEGIN " + "RSA PRIVATE KEY-----\n" + "M".repeat(30) + "\n-----END RSA PRIVATE KEY-----",
    'password="' + "p".repeat(20) + '"',
    "Bearer " + "t".repeat(30),
    "postgres://user:fake-short-password@db.local/app",
  ]
  for (const text of credentials) {
    const [redacted, findings] = scrub(text)
    assert.notEqual(redacted, text)
    assert.ok(findings.some(finding => finding.blocked))
    assert.ok(!redacted.includes("M".repeat(30)))
    assert.ok(!redacted.includes("fake-short-password"))
    assert.equal(redacted.split('"').length, text.split('"').length)
  }
  const password = "fake!zzzzzzzzzzzzzzzzzzzz"
  for (const separator of [":", "="]) {
    for (const quote of ['"', "'", ""]) {
      for (const suffix of ["", " next", ",next", '"next', "'next"]) {
        const prefix = `password${separator}${quote}`
        assert.equal(scrub(prefix + password + quote + suffix)[0], prefix + "«已脱敏:keyed-secret»" + quote + suffix)
      }
    }
  }
  const normal = 'const password = getPassword()\nversion=1.2.3.4\nconnect("10.0.0.1")'
  assert.equal(scrub(normal)[0], normal)
  assert.equal(scrub('"token":"' + "z".repeat(20) + '"')[0], '"token":"«已脱敏:keyed-secret»"')
  assert.ok(scrub("extra " + "q".repeat(20), ["q".repeat(20)])[0].includes("配置值"))
  assert.ok(scrub("userId: 123456 email fake@example.test ip 8.8.8.8")[1].every(hit => !hit.blocked))
})

test("GitHub tracker store uses fake transport for reads, writes, logs, and safe errors", async () => {
  const original = globalThis.fetch
  const token = "fake" + "-operator-" + "z".repeat(20)
  const requests: { url: string, method: string, data: Record<string, unknown> | undefined }[] = []
  const file: TrackerFile = { category: "sqli", rows: [row], log: [], url: "" }
  const replies: { status?: number, data: unknown }[] = [
    { data: { data: { repository: { object: { entries: [{ name: "sqli.json", object: { text: serializeTracker("owner/repo", file), oid: "initial" } }] } } } } },
    { data: { content: { sha: "next" } } },
    { status: 403, data: { message: token } },
  ]
  globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    assert.equal(new Headers(init?.headers).get("Authorization"), `Bearer ${token}`)
    requests.push({ url: String(input), method: init?.method ?? "GET", data: init?.body ? JSON.parse(String(init.body)) : undefined })
    assert.ok(replies.length > 0, "unexpected request")
    const reply = replies.shift()!
    return new Response(JSON.stringify(reply.data), { status: reply.status ?? 200 })
  }, { preconnect: original.preconnect })
  try {
    const store = new GitHubTrackerStore("owner/repo", token)
    const [current] = await store.read()
    assert.deepEqual(current.rows, [row])
    assert.equal(current.sha, "initial")
    await assert.rejects(() => store.write(current, [{ ...row, id: "pr1:app/fake@example.test.php" }], ""), /unsafe tracker row id/)
    const next = await store.write(current, [{ ...row, id: "pr1:app/test.php", file: "app/fake@example.test.php", reason: token }], `Batch ${token}`)
    const posted = JSON.parse(Buffer.from(requests[1].data!.content as string, "base64").toString())
    assert.equal(posted.rows[0].id, "pr1:app/test.php")
    assert.ok(!posted.rows[0].file.includes("fake@example.test"))
    assert.ok(!posted.rows[0].reason.includes(token))
    assert.ok(!posted.log[0].message.includes(token))
    assert.ok(!(requests[1].data!.message as string).includes(token))
    assert.deepEqual(posted.rows, next.rows)
    assert.deepEqual(posted.log, next.log)
    assert.equal(next.sha, "next")
    assert.equal(requests[1].data!.sha, "initial")
    assert.ok(requests[1].url.endsWith("/trackers/repo/sqli.json"))
    assert.deepEqual(requests.map(request => request.method), ["POST", "PUT"])
    await assert.rejects(() => store.read(), error => error instanceof Error && error.message === "tracker GitHub request failed (403)")
    assert.equal(replies.length, 0)
  } finally { globalThis.fetch = original }
})

test("scan retries skip log entries for known rows and existing run prefixes", async () => {
  const fake = new Fake()
  const tracker = new Tracker(fake)
  const finding = { ...row, line: 12 }
  await tracker.scan("sqli", [finding], "Scan run-1: added 1")
  await tracker.scan("sqli", [finding], "Scan run-1: added 0")
  await tracker.scan("sqli", [{ ...finding, id: "e".repeat(64), file: "other.php" }], "Scan run-1: added 1, retry")
  assert.deepEqual(fake.log("sqli"), ["Scan run-1: added 1"])
  assert.equal(fake.rows("sqli").length, 2)
})

test("GitHub client lists comments across pages", async () => {
  const { GitHubClient } = await import("./client.ts")
  const original = globalThis.fetch
  const urls: string[] = []
  globalThis.fetch = Object.assign(async (input: RequestInfo | URL) => {
    urls.push(String(input))
    return new Response(JSON.stringify(urls.length === 1
      ? Array.from({ length: 100 }, () => ({ body: "Older comment" }))
      : [{ body: "Scan run-1: added 1" }]))
  }, { preconnect: original.preconnect })
  try {
    const comments = await new GitHubClient("owner/repo", "fake-token").listComments(1)
    assert.equal(comments.length, 101)
    assert.equal(comments.at(-1), "Scan run-1: added 1")
    assert.ok(urls[1].endsWith("comments?per_page=100&page=2"))
  } finally { globalThis.fetch = original }
})

const oldBody = `Human intro\r\n${START}
candidate: 0, in PR: 1, fixed: 1

| id | file:line | subsystem | severity | status | reason | batch | PR |
| --- | --- | --- | --- | --- | --- | --- | --- |
| pr1:app/0.php | app/0.php:12 <!-- lines:12,40 --> | api | P1 | fixed | Keep &#124; reason&#10;next | batch1 | [PR #1](https://github.com/owner/repo/pull/1) |
| abc | app/other.php:9 <!-- lines:9,20 --> | | | in PR | Review | | PR #9 |
${END}\r\nHuman footer\n`

test("new rows order statuses, files and lines, hide zeros, and escape visible and machine data", () => {
  const statuses: Row["status"][] = ["open", "in progress", "ignored", "fixed"]
  const ordered = statuses.map((status, i) => ({ ...row, id: String(i + 1), status }))
  const candidates = [
    { ...row, id: "ab", file: "app/a.php", lines: [2, 80] },
    { ...row, id: "ac", file: "app/a.php", lines: [9] },
  ]
  const input = [...ordered, ...candidates].reverse()
  const rendered = renderRows(input, "owner/repo")
  assert.deepEqual(parseRows(`${START}${rendered}${END}`, "sqli").map(item => item.id), ["ab", "ac", "1", "2", "3", "4"])
  assert.deepEqual(input.map(item => item.id), [...ordered, ...candidates].reverse().map(item => item.id))
  assert.ok(rendered.includes("**6 findings** · open: 3 · in progress: 1 · ignored: 1 · fixed: 1"))
  assert.ok(renderRows([]).includes("**0 findings**\n"))
  assert.ok(!renderRows([row]).includes(": 0"))
  const file = "app/odd | dir/na[me](x)#?-->.php"
  const odd = { ...row, id: `pr2:${file}`, file, reason: "a|b\r\nc", pr: "[PR](x)|\n" }
  const escaped = renderRows([odd], "owner/repo")
  assert.deepEqual(parseRows(`${START}${escaped}${END}`, "sqli"), [odd])
  assert.ok(escaped.includes("na&#91;me&#93;(x)#?--&gt;.php:12"))
  assert.ok(escaped.includes("<sub>app/odd &#124; dir</sub>"))
  assert.ok(escaped.includes("odd%20%7C%20dir/na%5Bme%5D%28x%29%23%3F--%3E.php#L12"))
  assert.ok(escaped.includes("%2D%2D%3E.php lines:12,40 -->"))
  assert.equal(escaped.split("\n").filter(line => line.startsWith("| ")).length, 3)
  assert.equal(replaceRows(`${START}${escaped}${END}`, [odd], "owner/repo"), `${START}${escaped}${END}`)
  const legacySingle = oldBody.replace(" <!-- lines:9,20 -->", "")
  assert.deepEqual(parseRows(legacySingle, "sqli")[1].lines, [9])
})

test("false positive rows render a blank PR cell", () => {
  const pr = "[PR #7](https://github.com/a/b/pull/7)"
  const [fp, fixed] = renderRows([{ ...row, status: "false positive", pr }, { ...row, id: "b".repeat(64), status: "fixed", pr }])
    .split("\n").filter(line => line.includes("<!-- id:"))
  assert.ok(fixed.includes("PR #7"))
  assert.ok(!fp.includes("PR #7"))
  assert.ok(fp.trimEnd().endsWith("|  |"))
})

test("rows sort by status, then severity, then oldest date, and reject unknown values", () => {
  const rows: Row[] = [
    { ...row, id: "1", status: "in progress", severity: "P0" },
    { ...row, id: "2", severity: "", date: "01-01-2026" },
    { ...row, id: "3", severity: "P2", date: "01-01-2026" },
    { ...row, id: "4", severity: "P0", date: "02-01-2026" },
    { ...row, id: "5", severity: "P0", date: "31-12-2025" },
  ]
  assert.deepEqual(parseRows(`${START}${renderRows(rows)}${END}`, "sqli").map(item => item.id), ["5", "4", "3", "2", "1"])
  assert.ok(renderRows([row]).includes("| File | Status | Severity | Date | Reason | PR |"))
  assert.throws(() => renderRows([{ ...row, severity: "P3" }]), /invalid tracker row/)
  assert.throws(() => renderRows([{ ...row, date: "2026-10-05" }]), /invalid tracker row/)
  assert.throws(() => renderRows([{ ...row, status: "done" as never }]), /invalid tracker row/)
  assert.equal(today(new Date("2026-10-06T23:00:00Z")), "06-10-2026")
})

test("fixed rows fold into one collapsed block per PR and round trip", () => {
  const pr = (n: number) => `[PR #${n}](https://github.com/a/b/pull/${n})`
  const rows: Row[] = [
    { ...row, id: "1", status: "fixed", pr: pr(20) },
    { ...row, id: "2", status: "fixed", pr: pr(3), file: "app/b.php" },
    { ...row, id: "3", status: "fixed", pr: pr(3), file: "app/a.php" },
    { ...row, id: "4", status: "in progress", pr: pr(9) },
  ]
  const rendered = renderRows(rows)
  const summaries = rendered.split("\n").filter(line => line.startsWith("<details>"))
  assert.deepEqual(summaries, [
    "<details><summary>Fixed · PR #3 · 2 findings</summary>",
    "<details><summary>Fixed · PR #20 · 1 finding</summary>",
  ])
  assert.ok(rendered.indexOf("<!-- id:4 ") < rendered.indexOf("<details>"))
  assert.deepEqual(parseRows(`${START}${rendered}${END}`, "sqli").map(item => item.id), ["4", "3", "2", "1"])
  assert.equal(replaceRows(`${START}${rendered}${END}`, rows), `${START}${rendered}${END}`)
  const onlyFixed = renderRows([rows[0]])
  assert.ok(onlyFixed.trimStart().startsWith("**1 findings** · fixed: 1\n\n\n<details>"))
})

test("misc issue shows a Type column and type counts, round trips, and seed moves and labels rows", async () => {
  const misc: Row[] = [
    { ...row, id: "1", category: "misc", kind: "idor" },
    { ...row, id: "2", category: "misc", kind: "idor", file: "app/b.php" },
    { ...row, id: "3", category: "misc", kind: "tls-verify-off", status: "fixed", pr: "[PR #4](x)" },
  ]
  const rendered = renderRows(misc)
  assert.ok(rendered.includes("Types: `idor` 2 · `tls-verify-off` 1"))
  assert.equal(rendered.split("\n").filter(line => line.startsWith("| File | Type |")).length, 2)
  assert.deepEqual(parseRows(`${START}${rendered}${END}`, "misc").map(item => item.kind), ["idor", "idor", "tls-verify-off"])
  assert.equal(replaceRows(`${START}${rendered}${END}`, misc), `${START}${rendered}${END}`)
  assert.throws(() => renderRows([{ ...row, kind: "idor" }]), /invalid tracker row/)
  assert.throws(() => renderRows([{ ...misc[0], kind: "Bad Type" }]), /invalid tracker row/)

  const fake = new Fake()
  const tracker = new Tracker(fake, "owner/repo")
  const base = { state: "open" as const, sites: [{ file: "app/x.php", lines: [3] }] }
  await tracker.seed([{ ...base, number: 1, headRefName: "security/idor-x" }, { ...base, number: 2, headRefName: "security/greedy-x" }])
  assert.deepEqual(fake.rows("misc").map(item => [item.id, item.kind]), [["pr1:app/x.php", ""], ["pr2:app/x.php", ""]])
  await tracker.seed([{ ...base, number: 1, headRefName: "security/idor-x", kind: "idor" }, { ...base, number: 2, headRefName: "security/greedy-x", category: "weak-random" }])
  assert.deepEqual(fake.rows("misc").map(item => [item.id, item.kind]), [["pr1:app/x.php", "idor"]])
  assert.deepEqual(fake.rows("weak-random").map(item => item.id), ["pr2:app/x.php"])
  for (const bad of [{ category: "unknown" }, { kind: "idor" }, { category: "misc", kind: "Bad" }]) {
    assert.throws(() => validateSeed([{ ...base, number: 3, headRefName: "sqli-x", ...bad }]))
  }
})

test("seed dates rows by PR open day, fixes old dates on re-seed, and rejects bad dates", async () => {
  const fake = new Fake()
  const tracker = new Tracker(fake, "owner/repo")
  const pr = { number: 1, headRefName: "security/sqli-x", state: "open" as const, sites: [{ file: "app/x.php", lines: [3] }] }
  await tracker.seed([pr], "sqli")
  assert.equal(fake.rows("sqli")[0].date, today())
  await tracker.seed([{ ...pr, createdAt: "2026-07-31T02:37:42Z" }], "sqli")
  assert.equal(fake.rows("sqli")[0].date, "31-07-2026")
  for (const createdAt of ["31-07-2026", "2026-13-99T00:00:00Z", 5]) assert.throws(() => validateSeed([{ ...pr, createdAt }]))
})

test("reason line breaks render as <br> with bold labels and parse back unchanged", () => {
  const reason = "Ignored: test only\nEarlier reason: Verdict: 真阳。\nEvidence: a <b>Ignored:</b> fake & <br> text"
  const rendered = renderRows([{ ...row, status: "ignored", reason }])
  assert.ok(rendered.includes("<b>Ignored:</b> test only<br><b>Earlier reason:</b> Verdict: 真阳。<br><b>Evidence:</b> a &lt;b&gt;Ignored:&lt;/b&gt; fake &amp; &lt;br&gt; text"))
  assert.equal(parseRows(`${START}${rendered}${END}`, "sqli")[0].reason, reason)
})

test("seed keeps promoted kinds in misc for refresh, including branch-inferred kinds", async () => {
  for (const kind of ["tls-verify-off", "vendor-cve"]) {
    const fake = new Fake()
    const pr = { ...prs[0], headRefName: `security/${kind}-x`, kind }
    assert.equal(branchCategory(pr.headRefName), "misc")
    await new Tracker(fake).seed([pr], "misc")
    const rows = fake.rows("misc")
    assert.equal(rows[0].category, "misc")
    assert.equal(rows[0].kind, kind)
    assert.equal(fake.files.has(kind), false)
  }
})
