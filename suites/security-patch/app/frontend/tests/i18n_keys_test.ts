import { ZH_CATEGORY_LABELS } from "../../shared/category_labels"
import { readFile, readdir } from "node:fs/promises"
import { test } from "bun:test"
import { deepStrictEqual as assertEquals } from "node:assert/strict"

// Reads the sources as text, so the test does not need React.
const src = new URL("../src/", import.meta.url)
const dictText = await readFile(new URL("i18n.tsx", src), "utf8")

function keysOf(lang: "en" | "zh"): Set<string> {
  const start = dictText.indexOf(`  ${lang}: {`)
  const end = dictText.indexOf("\n  },", start)
  return new Set([...dictText.slice(start, end).matchAll(/^\s+"([^"]+)":/gm)].map(m => m[1])
    .concat(lang === "zh" ? Object.keys(ZH_CATEGORY_LABELS).map(id => `category.${id}`) : []))
}

async function sources(dir: URL): Promise<string[]> {
  const out: string[] = []
  for await (const entry of await readdir(dir, { withFileTypes: true })) {
    const url = new URL(entry.name + (entry.isDirectory() ? "/" : ""), dir)
    if (entry.isDirectory()) out.push(...await sources(url))
    else if (/\.tsx?$/.test(entry.name)) out.push(await readFile(url, "utf8"))
  }
  return out
}

test("English and Chinese have the same keys", () => {
  const en = keysOf("en"), zh = keysOf("zh")
  assertEquals([...en].filter(k => !zh.has(k)), [], "missing in zh")
  assertEquals([...zh].filter(k => !en.has(k)), [], "missing in en")
})

test("every literal t() key exists", async () => {
  const en = keysOf("en")
  const used = new Set<string>()
  for (const text of await sources(src)) {
    for (const m of text.matchAll(/\bt\(\s*"([^"]+)"/g)) used.add(m[1])
    // t(cond ? "a" : "b")
    for (const m of text.matchAll(/\bt\([^()"]*\?\s*"([^"]+)"\s*:\s*"([^"]+)"/g)) { used.add(m[1]); used.add(m[2]) }
  }
  assertEquals([...used].filter(k => !en.has(k)).sort(), [])
})

test("the UI source has no Chinese outside the dictionary", async () => {
  const offenders: string[] = []
  for (const name of await readdir(new URL("components/", src), { recursive: true })) if (name.endsWith(".tsx")) offenders.push(...await chinese(new URL(`components/${name}`, src)))
  for await (const entry of await readdir(new URL("pages/", src), { withFileTypes: true })) offenders.push(...await chinese(new URL(`pages/${entry.name}`, src)))
  assertEquals(offenders, [])
})

async function chinese(url: URL): Promise<string[]> {
  const lines = (await readFile(url, "utf8")).split("\n")
  // Comments may be in any language. Language names in the switcher are fine.
  return lines
    .map((line, i) => ({ line: line.replace(/\/\/.*$|\{\/\*.*\*\/\}/g, ""), i }))
    .filter(({ line }) => /[一-鿿]/.test(line) && !/切换为中文|^\s*中文\s*$/.test(line))
    .map(({ i }) => `${url.pathname.split("/").pop()}:${i + 1}`)
}
