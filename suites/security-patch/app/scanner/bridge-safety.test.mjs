import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { artifactPermission } from './lib/artifacts.mjs'
import { redact } from './lib/redact.mjs'
import { checkedPath } from './lib/agent-fs.mjs'
import { coverageOutput, parseScanCoverage } from './lib/resume.mjs'

const source = readFileSync(new URL('./bridge.mjs', import.meta.url), 'utf8')
const guard = source.slice(source.indexOf('const SHELL_WORD'), source.indexOf('// Restore summarized thinking'))
const options = source.slice(source.indexOf('const baseSdkOptions'), source.indexOf('function makePromptStream'))

function scanGate(t) {
  const root = mkdtempSync(join(tmpdir(), 'scan-gate-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  for (const path of ['repo', 'related', 'artifacts', 'skill']) {
    mkdirSync(join(root, path))
    writeFileSync(join(root, path, 'file'), 'fixture')
  }
  writeFileSync(join(root, 'credentials.json'), 'outside scan roots')
  symlinkSync(join(root, 'credentials.json'), join(root, 'repo', 'escape'))
  const mapped = path => path
    .replace('/workspace/related', join(root, 'related'))
    .replace('/root/.claude/skills/ola-security-audit', join(root, 'skill'))
  const check = (path, roots) => checkedPath(mapped(path), roots.map(mapped))
  const gate = new Function('reviewNotesFile', 'MODE', 'REPO_DIR', 'ARTIFACTS_DIR', 'SKILL', 'checkedPath', 'resolve', 'sep', 'redact', 'parseScanCoverage', 'coverageOutput', 'scanInventory', 'artifactPermission',
    `${guard}\nreturn canUseTool`)(null, 'scan', join(root, 'repo'), join(root, 'artifacts'), 'ola-security-audit', check, resolve, sep, redact, parseScanCoverage, coverageOutput, { files: ["src/a.php", "src/b.php"], categories: ["sqli"] }, artifactPermission)
  return { gate, root }
}

test('scan Read reaches the gate and only permits canonical paths inside scan roots', async t => {
  const { gate, root } = scanGate(t)
  const scanOptions = new Function('MODEL', 'EFFORT', 'thinkingOption', 'REPO_DIR', 'agentEnv', 'MODE', 'MAX_SUBAGENTS', 'canUseTool',
    `${options}\nreturn baseSdkOptions`)('', 'high', {}, join(root, 'repo'), {}, 'scan', 0, gate)
  assert.ok(!scanOptions.allowedTools.includes('Read'))
  for (const path of [join(root, 'repo/file'), join(root, 'artifacts/file'), '/workspace/related/file', '/root/.claude/skills/ola-security-audit/file', 'file']) {
    assert.equal((await gate('Read', { file_path: path })).behavior, 'allow', path)
  }
  for (const path of ['/root/.claude/.credentials.json', join(root, 'credentials.json'), '../credentials.json', join(root, 'repo/escape'), join(root, 'repo-extra/file'), '/missing']) {
    assert.equal((await gate('Read', { file_path: path })).behavior, 'deny', path)
  }
})

test('scan coverage writes allow only completed repository-relative file paths', async t => {
  const { gate, root } = scanGate(t)
  for (const [coverage, behavior] of [[["src/a.php"], 'allow'], [[], 'allow'], [["../key"], 'deny'], [{}, 'deny']]) {
    assert.equal((await gate('Write', { file_path: join(root, 'artifacts/scan-coverage.json'), content: JSON.stringify(coverage) })).behavior, behavior)
  }
})

test('scan denials name the available tools and the invalid finding', async t => {
  const { gate, root } = scanGate(t)
  const denied = await gate('Bash', { command: 'cat anything' })
  assert.match(denied.message, /Read, Glob, Grep, Skill, Write/)
  const result = await gate('Write', { file_path: join(root, 'artifacts/findings.json'), content: JSON.stringify([
    { id: 'valid', status: 'candidate' }, { id: 'bad-row', status: 'fixed' },
  ]) })
  assert.equal(result.behavior, 'deny')
  assert.match(result.message, /finding 2 \(bad-row\) requires candidate status/)
  assert.match(result.message, /Read, Glob, Grep, Skill, Write/)
  assert.equal((await gate('Write', { file_path: join(root, 'artifacts/findings.json'), content: '[]' })).behavior, 'allow')
  assert.equal((await gate('Write', { file_path: join(root, 'artifacts/findings.json'), content: '{' })).behavior, 'deny')
})
