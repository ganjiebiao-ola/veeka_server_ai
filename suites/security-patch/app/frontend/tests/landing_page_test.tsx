import { test } from "bun:test"
import assert from "node:assert/strict"
import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { I18nProvider } from "../src/i18n"
import { LandingPage } from "../src/pages/LandingPage"

test("The Scan page starts scans only and directs fixes to Pick", () => {
  const html = renderToStaticMarkup(<I18nProvider><LandingPage
    sessionId="fixture" activeRuns={[]} onStarted={() => {}}
    startRun={async () => ({ runId: "fixture", status: "queued" })}
  /></I18nProvider>)
  assert.match(html, /Only single repos are supported. Multi-repo projects are not supported yet/ )
  assert.match(html, /Report P0 and P1 by default/ )
  assert.doesNotMatch(html, /role="radio"|Audit|security-review/)
  assert.match(html, /select findings in Pick to start fixes/)
  assert.match(html, /<button(?=[^>]*data-testid="start-scan")[^>]*disabled=""/)
  assert.doesNotMatch(html, /Uses Sonnet 5\.5|Reviewer|Keep container for/)
})
