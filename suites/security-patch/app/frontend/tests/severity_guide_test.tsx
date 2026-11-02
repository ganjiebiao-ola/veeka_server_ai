import { readFile } from "node:fs/promises"
import { test } from "bun:test"
import { deepStrictEqual as assertEquals } from "node:assert/strict"
import { CODE_DEPENDENT, FIXED_LEVELS } from "../src/components/SeverityGuide.tsx"

test("the priority guide matches the levels in the audit skill's headings", async () => {
  const skill = await readFile(new URL("../../skill/ola-security-audit/SKILL.md", import.meta.url), "utf8")
  const dict = await readFile(new URL("../src/i18n.tsx", import.meta.url), "utf8")
  const levels = (id: string) => {
    const section = dict.match(new RegExp(`"category\\.${id}": "[^"]*\\(§(1\\.\\d+)\\)"`))?.[1]
    const heading = skill.match(new RegExp(`^### ${section?.replace(".", "\\.")} .*（([^）]*)）`, "m"))?.[1] ?? ""
    return heading.match(/P[012]/g) ?? []
  }
  for (const [level, ids] of Object.entries(FIXED_LEVELS)) for (const id of ids) assertEquals([id, levels(id)], [id, [level]])
  for (const [id, expected] of Object.entries(CODE_DEPENDENT)) assertEquals([id, levels(id)], [id, [...expected]])
})
