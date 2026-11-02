import { test } from "bun:test"
import assert from "node:assert/strict"
import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import type { PRDetail } from "../../shared/pr"
import { I18nProvider } from "../src/i18n"
import { PRContent, PRReader, DiffView, diffLines } from "../src/components/PRReader"
import { harness, text } from "./render"

const data: PRDetail = {
  number: 7, title: "Hardening queries", body: "## Fix pattern\n\nUse **bindings**. [File](app/query.php)\n\n<script>alert(1)</script>\n\n[Bad link](javascript:alert)",
  state: "open", draft: false, merged: false, html_url: "https://github.com/a/b/pull/7", user: { login: "fixture" }, updated_at: "2026-10-14T00:00:00Z",
  head: { ref: "security/sqli-app-1234abcd", sha: "a".repeat(40) }, base: { ref: "main", sha: "b".repeat(40) },
  additions: 2, deletions: 1, changed_files: 2,
  files: [
    { filename: "app/new.php", previous_filename: "app/old.php", status: "renamed", additions: 1, deletions: 1, patch: "@@ -12,2 +12,2 @@\n-old();\n+new();\n context", blob_url: "https://github.com/a/b/blob/main/app/new.php" },
    { filename: "image.png", status: "added", additions: 0, deletions: 0, blob_url: "javascript:alert(1)" },
  ],
  checks: [{ id: 1, name: "Lint", status: "completed", conclusion: "failure", html_url: "https://github.com/a/b/runs/1", output: { title: "Failed check", summary: "Use the existing helper." } }],
  statuses: [], comments: [{ id: 2, body: "Please add a test.", user: { login: "reader" }, html_url: "https://github.com/a/b/pull/7#comment-2", created_at: "2026-10-14T00:01:00Z" }],
  reviews: [{ id: 3, body: "", state: "APPROVED", user: { login: "reviewer" }, html_url: "https://github.com/a/b/pull/7#review-3", submitted_at: "2026-10-14T00:03:00Z" }],
  reviewComments: [{ id: 4, body: "Change this line.", user: { login: "reader" }, html_url: "https://github.com/a/b/pull/7#comment-4", created_at: "2026-10-14T00:02:00Z", path: "app/query.php", line: 12, diff_hunk: "@@ -12 +12 @@\n-old();\n+new();" }],
  unavailable: {},
}

test("PR reader reports HTTP status when a gateway returns HTML", async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => new Response("<html>Bad gateway</html>", { status: 502 })) as unknown as typeof fetch
  const h = harness()
  const props = { repo: "owner/repo", pr: { number: 123, title: "Fixture", url: "https://github.com/owner/repo/pull/123" }, onClose() {} }
  try {
    h.render(PRReader, props)
    await h.flush()
    const view = h.render(PRReader, props)
    assert.match(text(view), /HTTP 502/)
    assert.doesNotMatch(text(view), /JSON Parse/)
  } finally { h.cleanup(); globalThis.fetch = originalFetch }
})

function sectionMarkup(section: string, detail = data) {
  const dispatcher = (React as any).__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentDispatcher
  const original = dispatcher.current
  let view
  dispatcher.current = {
    useContext: (context: any) => ({ ...context._currentValue,
      t: (key: string, params?: Record<string, unknown>) => [key, ...Object.values(params ?? {})].join(" "),
    }),
    useState: () => [section, () => {}],
    useRef: () => ({ current: null }),
    useId: () => "fixture",
  }
  try { view = PRContent({ data: detail, repo: "a/b" }) }
  finally { dispatcher.current = original }
  return renderToStaticMarkup(<I18nProvider>{view}</I18nProvider>)
}

test("diff lines keep both line numbers across additions, removals, and multiple hunks", () => {
  const lines = diffLines("@@ -12,2 +20,2 @@\n-old();\n+new();\n context\n\\ No newline at end of file\n@@ -0,0 +1,1 @@\n+<script>unsafe()</script>")
  assert.deepEqual(lines.map(line => [line.oldLine, line.newLine]), [[null, null], [12, null], [null, 20], [13, 21], [null, null], [null, null], [null, 1]])
  const html = renderToStaticMarkup(<I18nProvider><DiffView patch="@@ -0,0 +1 @@\n+<script>unsafe()</script>" /></I18nProvider>)
  assert.match(html, /&lt;script&gt;unsafe\(\)&lt;\/script&gt;/)
  assert.doesNotMatch(html, /<script>/)
})

test("PR description renders safe Markdown and resolves file links against the commit", () => {
  const html = renderToStaticMarkup(<I18nProvider><PRContent data={data} repo="a/b" /></I18nProvider>)
  assert.match(html, /<strong>bindings<\/strong>/)
  assert.match(html, /href="https:\/\/github.com\/a\/b\/blob\/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\/app\/query.php"/)
  assert.match(html, /role="tab"[^>]*aria-selected="true"/)
  assert.doesNotMatch(html, /<script|javascript:|data-kind=/)
})

test("PR code blocks preserve HTML examples as code", () => {
  const detail = { ...data, body: "```html\n<br><sub>Example</sub>\n<details><summary>Literal code</summary></details>\n```" }
  const html = renderToStaticMarkup(<I18nProvider><PRContent data={detail} repo="a/b" /></I18nProvider>)
  assert.match(html, /&lt;br&gt;&lt;sub&gt;Example&lt;\/sub&gt;/)
  assert.match(html, /&lt;details&gt;&lt;summary&gt;Literal code&lt;\/summary&gt;&lt;\/details&gt;/)
  assert.doesNotMatch(html, /<sub>|<details>/)
})

test("PR files start collapsed, preserve renames, and disclose missing patches", () => {
  const html = sectionMarkup("files")
  const files = html.match(/<div [^>]*data-testid="pr-file"[^>]*>/g) ?? []
  assert.equal(files.length, 2)
  for (const file of files) assert.match(file, /data-state="closed"/)
  assert.doesNotMatch(html, /href="javascript:/)
  assert.match(html, /app\/old.php/)
  assert.match(html, /pr.no_patch/)
  assert.match(html, /data-kind="removed"/)
  assert.match(html, /data-kind="added"/)
})

test("PR activity keeps check failures, reviews without text, and chronological code comments", () => {
  const html = sectionMarkup("activity")
  assert.match(html, /data-variant="failed"[^>]*data-result="failure"/)
  assert.match(html, /Use the existing helper/)
  assert(html.indexOf("Please add a test") < html.indexOf("Change this line"))
  assert(html.indexOf("Change this line") < html.indexOf("APPROVED"))
  assert.match(html, /app\/query.php:12/)
  assert.match(html, /data-testid="pr-comment-context"/)
})

test("unavailable files and checks show errors instead of empty or passed results", () => {
  const detail = { ...data, files: [], checks: [], unavailable: { files: "HTTP 502", checks: "HTTP 403" } }
  const files = sectionMarkup("files", detail)
  assert.match(files, /role="alert"/)
  assert.match(files, /HTTP 502/)
  assert.doesNotMatch(files, /pr.no_files/)
  const activity = sectionMarkup("activity", detail)
  assert.match(activity, /role="alert"/)
  assert.match(activity, /HTTP 403/)
  assert.doesNotMatch(activity, /pr.no_checks|data-result="success"/)
})

test("PR links require https, GitHub only except CI target_url", () => {
  const hostile: PRDetail = { ...data,
    files: [{ ...data.files[0], blob_url: "https://evil.test/f" }],
    checks: [{ ...data.checks[0], html_url: "http://github.com/a/b/runs/1" }],
    statuses: [{ id: 9, context: "ci", state: "success", target_url: "https://ci.example.com/1" } as any, { id: 10, context: "x", state: "success", target_url: "http://ci.example.com/2" } as any],
    comments: [{ ...data.comments[0], html_url: "https://github.com.evil.test/c" }], reviews: [], reviewComments: [] }
  const html = ["files", "activity"].map(s => sectionMarkup(s, hostile)).join("")
  assert.doesNotMatch(html, /evil\.test|href="http:\/\//)
  assert.match(html, /href="https:\/\/ci\.example\.com\/1"/)
})
