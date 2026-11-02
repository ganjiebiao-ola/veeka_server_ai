import { test } from "bun:test"
import assert from "node:assert/strict"
import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { I18nProvider } from "../src/i18n"
import { PickPage } from "../src/pages/PickPage"

test("Pick has one optional batch guidance field with a character limit and counter", () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "location")
  Object.defineProperty(globalThis, "location", { configurable: true, value: { search: "" } })
  try {
    const html = renderToStaticMarkup(<I18nProvider><PickPage
      sessionId="fixture" activeRuns={[]} onStarted={() => {}}
    /></I18nProvider>)
    assert.match(html, /Fix guidance for this batch \(optional\)/)
    assert.equal(html.match(/<textarea/g)?.length, 1)
    assert.match(html, /<textarea[^>]*maxLength="1000"[^>]*aria-describedby="pick-note-count"/)
    assert.match(html, /id="pick-note-count"[^>]*>0\/1,000/)
    assert.doesNotMatch(html, /type="number"/)
    assert.match(html, /<button[^>]*disabled=""[^>]*>Fix selected \(0\)<\/button>/)
  } finally {
    if (previous) Object.defineProperty(globalThis, "location", previous)
    else Reflect.deleteProperty(globalThis, "location")
  }
})
