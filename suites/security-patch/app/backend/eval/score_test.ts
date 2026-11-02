import { join } from "node:path"
import { tmpdir } from "node:os"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { test } from "bun:test"
import { strict as assert } from "node:assert"
import { formatScore, LINE_WINDOW, readInput, run, score } from "./score.ts"

const finding = { category: "sqli", file: "app/x.php", line: 100, status: "candidate" }
const example = { pr: 1, category: "sqli", sites: [{ file: "app/x.php", lines: [100] }] }

test("recall includes both window edges and excludes lines beyond them", () => {
  assert.equal(LINE_WINDOW, 10)
  for (const offset of [-11, -10, 0, 10, 11]) {
    const result = score([example], [{ ...finding, line: 100 + offset }])
    const found = Number(Math.abs(offset) <= LINE_WINDOW)
    assert.equal(result.cases[0].sitesFound, found)
    assert.equal(result.total.casesFound, found)
  }
  assert.equal(score([example], [{ ...finding, category: "cors" }]).total.sitesFound, 0)
  assert.equal(score([example], [{ ...finding, file: "app/y.php" }]).total.sitesFound, 0)
  assert.equal(score([example], []).total.sitesFound, 0)
})

test("path normalization preserves case and directories", () => {
  for (const file of [
    "./app/x.php", "app//x.php", "app/temp/../x.php", "app\\x.php",
    "/app/x.php", "/workspace/repo/app/x.php", "/workspace/repo/./app/x.php", "/./app/x.php",
  ]) {
    assert.equal(score([example], [{ ...finding, file }]).total.sitesFound, 1)
    assert.equal(score([{ ...example, sites: [{ file, lines: [100] }] }], [finding]).total.sitesFound, 1)
  }
  for (const file of ["App/x.php", "other/x.php"]) {
    assert.equal(score([example], [{ ...finding, file }]).total.sitesFound, 0)
  }
})

test("multi-site recall counts sites once and aggregates partial cases", () => {
  const cases = [
    { ...example, sites: [
      { file: "app/x.php", lines: [30, 100, 150] },
      { file: "app/y.php", lines: [200] },
    ] },
    { ...example, pr: 2 },
    { pr: 3, category: "cors", sites: [{ file: "app/z.php", lines: [50] }] },
  ]
  const result = score(cases, [finding, finding, {
    category: "cors", file: "app/z.php", line: 50, status: "fixed",
  }])
  assert.deepEqual(result.cases, [
    { pr: 1, category: "sqli", sitesFound: 1, sitesTotal: 2, fullyFound: false },
    { pr: 2, category: "sqli", sitesFound: 1, sitesTotal: 1, fullyFound: true },
    { pr: 3, category: "cors", sitesFound: 1, sitesTotal: 1, fullyFound: true },
  ])
  assert.deepEqual(result.categories, {
    sqli: { sitesFound: 2, sitesTotal: 3, casesFound: 1, casesTotal: 2 },
    cors: { sitesFound: 1, sitesTotal: 1, casesFound: 1, casesTotal: 1 },
  })
  assert.deepEqual(result.total, { sitesFound: 3, sitesTotal: 4, casesFound: 2, casesTotal: 3 })
  assert.deepEqual(score([], []).total, { sitesFound: 0, sitesTotal: 0, casesFound: 0, casesTotal: 0 })
})

test("false positive status is ignored and ruled-out sites count once", () => {
  const ignored = { ...finding, status: "false positive" }
  const ruledOut = { category: "sqli", file: "./app/x.php", line: 100, note: "fake ruled-out site" }
  assert.equal(score([example], [ignored], [ruledOut]).total.sitesFound, 0)
  const findings = [
    { ...finding, line: 90 }, { ...finding, line: 110, status: "fixed" },
    { ...finding, line: 89 }, { ...finding, line: 111 },
    { ...finding, category: "cors" }, { ...finding, file: "app/y.php" }, ignored,
  ]
  const result = score([], findings, [ruledOut, ruledOut])
  assert.deepEqual(result.falsePositives, { count: 1, findings: findings.slice(0, 1) })
  assert.deepEqual(score([], findings).falsePositives, { count: 0, findings: [] })
  const text = formatScore(result)
  assert.ok(text.includes("False positives: 1"))
  assert.ok(text.includes("sqli\tapp/x.php:90\tcandidate"))
  assert.ok(!text.includes("sqli\tapp/x.php:110\tfixed"))
})

test("identical findings report each ruled-out site once", () => {
  const ruledOut = { category: "sqli", file: "app/x.php", line: 100, note: "fake" }
  const result = score([], [finding, { ...finding }], [ruledOut, {
    ...ruledOut, file: "/workspace/repo/app/x.php",
  }])
  assert.deepEqual(result.falsePositives, { count: 1, findings: [finding] })
  assert.equal(formatScore(result).split("sqli\tapp/x.php:100\tcandidate").length - 1, 1)
  assert.equal(score([], [finding, finding], [ruledOut, {
    ...ruledOut, line: 105,
  }]).falsePositives.count, 2)
})

test("CLI reads fake inputs and prints matching JSON and text scores", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ola-agent-"))
  try {
    const cases = `${dir}/cases.json`
    const findings = `${dir}/findings.json`
    const fp = `${dir}/fp.json`
    await writeFile(cases, JSON.stringify([example]))
    await writeFile(findings, JSON.stringify([finding]))
    const ruledOut = [{ category: "sqli", file: "app/x.php", line: 100, note: "fake" }]
    await writeFile(fp, JSON.stringify(ruledOut))
    const args = ["--cases", cases, "--findings", findings, "--false-positives", fp]
    const expected = score([example], [finding], ruledOut)
    assert.deepEqual(JSON.parse(await run([...args, "--json"])), expected)
    assert.equal(await run(args), formatScore(expected))
    assert.ok((await run(args)).includes("1\tsqli\tfound 1 of 1"))
    assert.ok((await run(args)).includes("TOTAL\t1/1\t1/1"))
    assert.equal(JSON.parse(await run(args.slice(0, 4).concat("--json"))).falsePositives.count, 0)
    const result = Bun.spawnSync([process.execPath, "run", new URL("./score.ts", import.meta.url).pathname, ...args, "--json"], { stdout: "pipe", stderr: "pipe" })
    assert.equal(result.exitCode, 0, new TextDecoder().decode(result.stderr))
    assert.deepEqual(JSON.parse(new TextDecoder().decode(result.stdout)), expected)
  } finally {
    await rm(dir, { recursive: true })
  }
})

test("bad files and CLI arguments give clear errors", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ola-agent-"))
  const path = `${dir}/input.json`
  try {
    await assert.rejects(() => readInput(path, "cases"), /cases file .*input.json/)
    for (const content of ["{", "{}", "null"]) {
      await writeFile(path, content)
      await assert.rejects(() => readInput(path, "findings"), /findings file .*input.json/)
    }
    const badCases = [
      {}, { ...example, pr: 0 }, { ...example, category: "unknown" },
      { ...example, sites: [] }, { ...example, sites: [{ file: "app/x.php", lines: [] }] },
      { ...example, sites: [{ file: "app/x.php", lines: [0] }] },
      { ...example, sites: [{ file: "app/x.php", lines: [1.5] }] },
    ]
    for (const row of badCases) {
      await writeFile(path, JSON.stringify([row]))
      await assert.rejects(() => readInput(path, "cases"), /cases file .*row 1: invalid cases row/)
    }
    for (const row of [{ ...finding, status: null }, { ...finding, line: "100" }, { ...finding, category: "unknown" }]) {
      await writeFile(path, JSON.stringify([row]))
      await assert.rejects(() => readInput(path, "findings"), /row 1: invalid findings row/)
    }
    for (const file of ["", "../x.php", "app/../../x.php", "/../x.php",
      "/workspace/repo/../x.php", "/workspace/repo/app/../../x.php", "C:\\app\\x.php", "."]) {
      await writeFile(path, JSON.stringify([{ ...finding, file }]))
      await assert.rejects(() => readInput(path, "findings"), /findings file .*row 1:/)
    }
    for (const file of ["/app/x.php", "/workspace/repo/app/x.php"]) {
      await writeFile(path, JSON.stringify([{ ...finding, file }]))
      assert.equal((await readInput(path, "findings")).length, 1)
    }
    await writeFile(path, JSON.stringify([{ category: "sqli", file: "app/x.php", line: 1 }]))
    await assert.rejects(() => readInput(path, "false-positives"), /false-positives file .*row 1:/)
    for (const args of [[], ["--cases"], ["--wat"], ["--cases", "a", "--cases", "b"]]) {
      await assert.rejects(() => run(args), /required options|requires a path|unknown option|duplicate option/)
    }
    const result = Bun.spawnSync([process.execPath, "run", new URL("./score.ts", import.meta.url).pathname, "--cases", path, "--findings", path], { stdout: "pipe", stderr: "pipe" })
    assert.equal(result.exitCode, 1)
    assert.equal(new TextDecoder().decode(result.stdout), "")
    assert.match(new TextDecoder().decode(result.stderr), /score: cases file .*row 1:/)
  } finally {
    await rm(dir, { recursive: true })
  }
})
