import { test } from "bun:test"
import assert from "node:assert/strict"
import { ActivityTimeline } from "../src/components/ActivityArea"
import { browser, harness, nodes, text, is } from "./render"

const timeline = (count: number) => Array.from({ length: count }, (_, i) => ({ thinking: `Entry ${i + 1}` }))

test("pager follows the newest page and keeps an older page still with a new-entry notice", () => {
  const b = browser()
  const h = harness()
  let count = 125
  const render = () => h.render(ActivityTimeline, { timeline: timeline(count), toolLog: [], ended: false })!
  let view = render()
  const click = (label: string) => nodes(view, node => is(node, "button") && text(node) === label)[0].props.onClick()
  const entries = () => nodes(view, node => node.type === "li").map(node => text(node))
  try {
    assert.match(text(view), /Page 3 of 3/)
    assert.equal(entries().length, 25)
    assert.equal(entries()[0], "Entry 101")
    count = 151
    view = render()
    assert.match(text(view), /Page 4 of 4/)
    assert.deepEqual(entries(), ["Entry 151"])
    click("Previous")
    view = render()
    const older = entries()
    assert.equal(older.length, 50)
    count = 160
    view = render()
    assert.deepEqual(entries(), older)
    assert.match(text(view), /Page 3 of 4.*9 new entries/)
    click("Next")
    view = render()
    assert.match(text(view), /Page 4 of 4/)
    assert.doesNotMatch(text(view), /new entries/)
    count = 201
    view = render()
    assert.match(text(view), /Page 5 of 5/)
    assert.deepEqual(entries(), ["Entry 201"])
    click("Previous")
    view = render()
    click("Previous")
    view = render()
    click("Previous")
    view = render()
    click("Previous")
    view = render()
    assert.equal(nodes(view, node => is(node, "button") && text(node) === "Previous")[0].props.disabled, true)
  } finally { h.cleanup(); b.cleanup() }
})

for (const size of [10, 50, 100]) test(`pager remembers ${size} entries per page`, () => {
  const b = browser()
  const h = harness()
  const props = { timeline: timeline(200), toolLog: [], ended: true }
  try {
    let view = h.render(ActivityTimeline, props)!
    const select = nodes(view, node => is(node, "select"))[0]
    assert.deepEqual(nodes(select, node => node.type === "option").map(node => node.props.value), [10, 50, 100])
    select.props.onChange({ currentTarget: { value: String(size) } })
    view = h.render(ActivityTimeline, props)!
    assert.equal(nodes(view, node => node.type === "li").length, size)
    assert.equal(b.storage.get("run.activity.pageSize"), String(size))
    const reload = harness()
    try {
      const restored = reload.render(ActivityTimeline, props)!
      assert.equal(nodes(restored, node => is(node, "select"))[0].props.value, size)
      assert.equal(nodes(restored, node => node.type === "li").length, size)
      assert.equal(nodes(restored, node => is(node, "button") && text(node) === "Next")[0].props.disabled, true)
    } finally { reload.cleanup() }
  } finally { h.cleanup(); b.cleanup() }
})

for (const saved of ["junk", "20", "0"]) test(`pager ignores invalid saved size ${saved}`, () => {
  const b = browser("/", { "run.activity.pageSize": saved })
  const h = harness()
  try {
    const view = h.render(ActivityTimeline, { timeline: timeline(100), toolLog: [], ended: false })
    assert.equal(nodes(view, node => is(node, "select"))[0].props.value, 50)
  } finally { h.cleanup(); b.cleanup() }
})

test("pager works when storage reads and writes throw", () => {
  const b = browser()
  const h = harness()
  Object.defineProperty(globalThis, "localStorage", { configurable: true, get() { throw new Error("storage denied") } })
  try {
    const props = { timeline: timeline(100), toolLog: [], ended: false }
    let view = h.render(ActivityTimeline, props)
    const select = nodes(view, node => is(node, "select"))[0]
    assert.equal(select.props.value, 50)
    select.props.onChange({ currentTarget: { value: "10" } })
    view = h.render(ActivityTimeline, props)
    assert.equal(nodes(view, node => node.type === "li").length, 10)
  } finally { h.cleanup(); b.cleanup() }
})
