import { test } from "bun:test"
import assert from "node:assert/strict"
import { TrackerModal, type TrackerRow } from "../src/components/TrackerModal"
import { harness, markup } from "./render"

const url = "https://github.com/olaola-chat/security-patch-tracker/blob/main/misc.json"
const row: TrackerRow = { id: "a", category: "misc", kind: "unsafe-query", file: "app/query.php", lines: [12, 14], severity: "P2", status: "in progress", reason: "First line\nSecond line with <unsafe>", date: "14-10-2026", pr: "[PR #7](https://github.com/a/b/pull/7)" }
// The reader opens in a portal, which static markup leaves out. So render the header link and the body it gets.
function render(rows: TrackerRow[], trackerUrl: string | null = url) {
  const h = harness()
  try {
    const reader = h.render(TrackerModal, { repo: "a/b", tracker: { category: "misc", url: trackerUrl, rows }, onClose() {} })
    return markup(<>{reader.props.href && <a href={reader.props.href}>{reader.props.title}</a>}{reader.props.children}</>)
  } finally { h.cleanup() }
}
test("tracker table displays JSON fields, safe text and links", () => {
  const html = render([row])
  assert.match(html, /<table/)
  assert.match(html, /href="https:\/\/github.com\/olaola-chat\/security-patch-tracker\/blob\/main\/misc.json"/)
  assert.match(html, /app\/query.php:12,14/)
  assert.match(html, /unsafe-query/)
  assert.match(html, /In progress/)
  assert.match(html, /P2/)
  assert.match(html, /14-10-2026/)
  assert.match(html, /First line\nSecond line with &lt;unsafe&gt;/)
  assert.match(html, /href="https:\/\/github.com\/a\/b\/pull\/7"[^>]*>PR #7/)
  assert.doesNotMatch(render([{ ...row, pr: "[PR #7](javascript:alert)" }]), /href="javascript:/)
})
test("tracker modal distinguishes missing and empty files", () => {
  assert.match(render([], null), /No tracker file yet/)
  assert.match(render([]), /This tracker file has no findings yet/)
})
