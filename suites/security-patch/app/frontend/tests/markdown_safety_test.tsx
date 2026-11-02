import { test } from "bun:test"
import assert from "node:assert/strict"
import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { I18nProvider } from "../src/i18n"
import { ReportView, githubUrl } from "../src/components/ReportView"
import { CompletionCard } from "../src/components/CompletionCard"

const hostile = "![track](/api/overview)\n\n[plain](http://evil.test/a) [js](javascript:alert(1)) [ok](https://example.com/x) [top](#top)"

test("hostile report markdown loads no image and links only https", () => {
  const html = renderToStaticMarkup(<I18nProvider><ReportView runId="a/b" text={hostile} /></I18nProvider>)
  assert.doesNotMatch(html, /<img/i)
  assert.doesNotMatch(html, /href="(http:|javascript:)/i)
  assert.match(html, /track/)
  assert.match(html, /<a href="https:\/\/example.com\/x" target="_blank" rel="noopener noreferrer">ok<\/a>/)
  assert.match(html, /<a href="#top">top<\/a>/)
  assert.match(html, /\/api\/runs\/a%2Fb\/artifacts\/report/)
})

test("only github https PR URLs become links", () => {
  assert.equal(githubUrl("https://github.com/a/b/pull/1"), "https://github.com/a/b/pull/1")
  for (const bad of ["http://github.com/a", "https://evil.test/", "https://github.com.evil.test/", "javascript:alert(1)", null, undefined]) assert.equal(githubUrl(bad), undefined)
  const card = (prUrl: string) => renderToStaticMarkup(<I18nProvider><CompletionCard runId="r" mode="fix" status="completed" prUrl={prUrl} /></I18nProvider>)
  assert.match(card("https://github.com/a/b/pull/1"), /href="https:\/\/github.com\/a\/b\/pull\/1"/)
  assert.doesNotMatch(card("https://evil.test/x"), /evil\.test/)
})
