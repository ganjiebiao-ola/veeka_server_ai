import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { I18nProvider, useI18n } from "../src/i18n"
import { Button } from "../src/components/ui/button"
import { Input } from "../src/components/ui/input"
import { Label } from "../src/components/ui/label"
import { NativeSelect } from "../src/components/ui/native-select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../src/components/ui/table"
import { Textarea } from "../src/components/ui/textarea"

// Run component handlers and effects using the same hook dispatcher pattern as the run-route tests.
export function harness() {
  let i18n: ReturnType<typeof useI18n>
  function Capture() { i18n = useI18n(); return null }
  renderToStaticMarkup(<I18nProvider><Capture /></I18nProvider>)
  const dispatcher = (React as any).__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentDispatcher
  const components = new Map<Function, any[]>()
  const cleanups = new Map<any[], Map<number, () => void>>()
  const effects = new Map<any[], Map<number, () => void>>()
  let slots: any[] = []
  let index = 0
  const pending: (() => void)[] = []
  const same = (a: any[], b: any[]) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]))
  function effect(run: () => void | (() => void), deps: any[]) {
    const current = slots
    const i = index++
    if (!same(current[i], deps)) {
      const setup = () => {
        cleanups.get(current)?.get(i)?.()
        const cleanup = run()
        if (!cleanups.has(current)) cleanups.set(current, new Map())
        if (cleanup) cleanups.get(current)!.set(i, cleanup)
      }
      if (!effects.has(current)) effects.set(current, new Map())
      effects.get(current)!.set(i, setup)
      pending.push(setup)
    }
    current[i] = deps
  }
  return {
    render<P, R>(component: (props: P) => R, props: P): R {
      if (!components.has(component)) components.set(component, [])
      slots = components.get(component)!
      index = 0
      const previous = dispatcher.current
      dispatcher.current = {
        useContext: () => i18n!,
        useState(initial: any) {
          const current = slots
          const i = index++
          if (!(i in current)) current[i] = typeof initial === "function" ? initial() : initial
          return [current[i], (value: any) => { current[i] = typeof value === "function" ? value(current[i]) : value }]
        },
        useRef(initial: any) {
          const i = index++
          return slots[i] ??= { current: initial }
        },
        useEffect: effect,
        useLayoutEffect: effect,
        useCallback(callback: Function, deps: any[]) {
          const i = index++
          if (!slots[i] || !same(slots[i].deps, deps)) slots[i] = { callback, deps }
          return slots[i].callback
        },
        useId: () => `fixture-${index++}`,
      }
      try { return component(props) }
      finally { dispatcher.current = previous }
    },
    async flush() {
      for (const run of pending.splice(0)) run()
      await new Promise(resolve => setTimeout(resolve, 0))
    },
    replayEffects() { for (const map of effects.values()) for (const setup of map.values()) setup() },
    cleanup() { for (const map of cleanups.values()) for (const cleanup of map.values()) cleanup() },
  }
}

// The harness renders one component deep, so a ui component shows up as itself, not as its DOM tag.
// is(node, "button") matches both, so tests keep asserting on what the user gets.
const UI_TAGS = new Map<unknown, string>([
  [Button, "button"], [Input, "input"], [Textarea, "textarea"], [NativeSelect, "select"], [Label, "label"],
  [Table, "table"], [TableHeader, "thead"], [TableBody, "tbody"], [TableRow, "tr"], [TableHead, "th"], [TableCell, "td"],
])
export function is(node: React.ReactElement<any>, tag: string): boolean {
  return node.type === tag || UI_TAGS.get(node.type) === tag && !node.props.asChild
}

export function nodes(view: React.ReactNode, match: (node: React.ReactElement<any>) => boolean): React.ReactElement<any>[] {
  return React.Children.toArray(view).flatMap(child => React.isValidElement<{ children?: React.ReactNode }>(child)
    ? [...(match(child) ? [child] : []), ...nodes(child.props.children, match)] : [])
}

export function text(view: React.ReactNode): string {
  return React.Children.toArray(view).map(child => React.isValidElement<{ children?: React.ReactNode }>(child) ? text(child.props.children) : String(child)).join("")
}

export function markup(view: React.ReactNode): string {
  return renderToStaticMarkup(<I18nProvider>{view}</I18nProvider>)
}

export function browser(path = "/pick?repo=owner/repo", saved: Record<string, string> = {}) {
  const storage = new Map(Object.entries(saved))
  const url = new URL(path, "http://fixture")
  const location = { pathname: url.pathname, search: url.search }
  const values = {
    location,
    localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) },
    sessionStorage: { getItem: () => null, setItem: () => {} },
    history: { replaceState: (_data: unknown, _unused: string, path: string) => {
      const next = new URL(path, "http://fixture")
      location.pathname = next.pathname
      location.search = next.search
    } },
    addEventListener: () => {},
    removeEventListener: () => {},
    confirm: () => true,
  }
  const previous = new Map(Object.keys(values).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  return {
    storage,
    cleanup() {
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor)
        else Reflect.deleteProperty(globalThis, key)
      }
    },
  }
}
