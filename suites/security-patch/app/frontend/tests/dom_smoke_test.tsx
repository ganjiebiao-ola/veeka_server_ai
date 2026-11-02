import { afterAll, afterEach, test } from "bun:test"
import assert from "node:assert/strict"
import { useState, type ReactNode } from "react"
import { GlobalRegistrator } from "@happy-dom/global-registrator"

// Radix and Testing Library read the DOM globals when they load, so register them before importing.
// `bun test --isolate` keeps these globals out of the other test files.
GlobalRegistrator.register()
const { act, cleanup, fireEvent, render } = await import("@testing-library/react")
const { I18nProvider } = await import("../src/i18n")
const { ConfirmDialog } = await import("../src/components/ConfirmDialog")
const { ReaderModal } = await import("../src/components/ReaderModal")
const { Progress } = await import("../src/components/ui/progress")
const { ClosePRDialog } = await import("../src/pages/OverviewPage")

afterEach(cleanup)
afterAll(() => GlobalRegistrator.unregister())

function Opener({ dialog }: { dialog: (close: () => void) => ReactNode }) {
  const [open, setOpen] = useState(false)
  return <I18nProvider>
    <button type="button" onClick={() => setOpen(true)}>Open</button>
    {open && dialog(() => setOpen(false))}
  </I18nProvider>
}

async function openFrom(ui: ReturnType<typeof render>) {
  const opener = ui.getByRole("button", { name: "Open" })
  opener.focus()
  fireEvent.click(opener)
  return opener
}

async function escape() {
  fireEvent.keyDown(document.activeElement!, { key: "Escape" })
  // Radix returns focus on unmount in a timeout.
  await act(() => new Promise(resolve => setTimeout(resolve, 0)))
}

test("ConfirmDialog closes on Escape and returns focus to its opener", async () => {
  const ui = render(<Opener dialog={close => <ConfirmDialog message="Remove it?" confirmLabel="Remove" onConfirm={close} onCancel={close} />} />)
  const opener = await openFrom(ui)
  assert.equal(ui.getByRole("alertdialog").textContent?.includes("Remove it?"), true)
  await escape()
  assert.equal(ui.queryByRole("alertdialog"), null)
  assert.equal(document.activeElement, opener)
})

test("a busy AlertDialog ignores Escape", async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (() => new Promise(() => {})) as unknown as typeof fetch
  let done = 0
  try {
    const pr = { number: 7, title: "Fix", draft: false, url: "https://github.com/owner/repo/pull/7" }
    const ui = render(<Opener dialog={() => <ClosePRDialog repo="owner/repo" pr={pr} onDone={() => { done++ }} />} />)
    await openFrom(ui)
    fireEvent.click(ui.getByRole("button", { name: "Close PR" }))
    assert.equal((ui.getByRole("button", { name: "Working…" }) as HTMLButtonElement).disabled, true)
    await escape()
    assert.equal(done, 0)
    assert.notEqual(ui.queryByRole("alertdialog"), null)
  } finally { globalThis.fetch = originalFetch }
})

test("ReaderModal closes on Escape and returns focus to its opener", async () => {
  const ui = render(<Opener dialog={close => <ReaderModal title="Report" source="report.md" onClose={close}>Body</ReaderModal>} />)
  const opener = await openFrom(ui)
  assert.equal(ui.getByRole("dialog").textContent?.includes("Body"), true)
  await escape()
  assert.equal(ui.queryByRole("dialog"), null)
  assert.equal(document.activeElement, opener)
})

test("Progress exposes its value", () => {
  const ui = render(<Progress value={40} />)
  assert.equal(ui.getByRole("progressbar").getAttribute("aria-valuenow"), "40")
})
