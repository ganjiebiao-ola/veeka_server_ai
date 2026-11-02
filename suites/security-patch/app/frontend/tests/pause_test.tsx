import { test } from "bun:test"
import assert from "node:assert/strict"
import { RunPage } from "../src/pages/RunPage"
import { TopBar } from "../src/components/TopBar"
import { RunOutcome } from "../src/components/RunOutcome"
import { RunStatusLabel } from "../src/components/RunStatusLabel"
import { ResumeBar } from "../src/components/ResumeBar"
import { browser, harness, nodes, text, is } from "./render"

for (const mode of ["scan", "fix"] as const) {
  for (const status of ["queued", "cloning", "scanning", "stopped", "aborted", "completed", "failed"] as const) {
    test(`${mode} ${status} shows Pause only for running scans and retains Stop and Resume`, async () => {
      const b = browser("/runs/fixture")
      const h = harness()
      const originalFetch = globalThis.fetch
      let posts = 0
      let finish: (response: Response) => void = () => {}
      globalThis.fetch = ((input: any, init?: RequestInit) => {
        if (init?.method === "POST") {
          assert.equal(String(input), "/api/runs/fixture/pause")
          posts++
          return new Promise<Response>(resolve => { finish = resolve })
        }
        return Promise.resolve(Response.json({ runId: "fixture", mode, status, repoUrl: "https://github.com/owner/repo" }))
      }) as typeof fetch
      const props = { runId: "fixture", mode, onResumed() {} }
      const render = () => {
        const view = h.render(RunPage, props)
        const bar = nodes(view, node => node.type === TopBar)[0]
        return { view, bar: h.render(TopBar, bar.props) }
      }
      try {
        render()
        await h.flush()
        const { view, bar } = render()
        const running = ["queued", "cloning", "scanning"].includes(status)
        const pause = nodes(bar, node => is(node, "button") && text(node) === "Pause")[0]
        assert.equal(Boolean(pause), mode === "scan" && running)
        assert.equal(nodes(bar, node => is(node, "button") && text(node) === "Cancel run").length, running ? 1 : 0)
        if (status === "stopped") {
          const statusLabel = nodes(bar, node => node.type === RunStatusLabel)[0]
          assert.match(text(h.render(RunStatusLabel, statusLabel.props)), /Paused \(resumable\)/)
          const outcome = nodes(view, node => node.type === RunOutcome)[0]
          assert.equal(nodes(h.render(RunOutcome, outcome.props), node => node.type === ResumeBar).length, 1)
        }
        if (pause) {
          const request = pause.props.onClick()
          pause.props.onClick()
          assert.equal(posts, 1)
          assert.equal(nodes(render().bar, node => is(node, "button") && text(node) === "Pausing…")[0].props.disabled, true)
          finish(Response.json({ ok: true }))
          await request
          assert.equal(nodes(render().bar, node => is(node, "button") && text(node) === "Pausing…")[0].props.disabled, true)
          assert.equal(nodes(render().bar, node => is(node, "button") && text(node) === "Cancel run")[0].props.disabled, false)
          props.runId = "resumed"
          render()
          await h.flush()
          assert.equal(nodes(render().bar, node => is(node, "button") && text(node) === "Pause")[0].props.disabled, false)
        }
      } finally {
        finish(Response.json({ ok: true }))
        await h.flush()
        h.cleanup()
        globalThis.fetch = originalFetch
        b.cleanup()
      }
    })
  }
}
