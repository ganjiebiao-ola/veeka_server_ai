import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

async function runBridge(t, { context, mode = 'fix', language, provider = 'claude' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ola-repo-context-test-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const repo = join(root, 'repo')
  const artifacts = join(root, 'artifacts')
  mkdirSync(repo)
  mkdirSync(artifacts)
  if (context !== undefined) writeFileSync(join(artifacts, 'repo-context.json'), context)
  const log = join(root, 'prompts.jsonl')
  let source = readFileSync(new URL('./bridge.mjs', import.meta.url), 'utf8')
    .replace('import { query } from "@anthropic-ai/claude-agent-sdk";', `
      async function* query(request) {
        let prompt = ''
        for await (const message of request.prompt) prompt += message.message.content
        appendFileSync(${JSON.stringify(log)}, JSON.stringify(prompt) + '\\n')
        if (${JSON.stringify(provider)} === 'codex' || ${JSON.stringify(provider)} === 'antigravity') {
          if (request.skillPath !== '/root/.claude/skills/ola-security-audit/SKILL.md') throw new Error('Wrong skill path')
        }
        yield { type: 'system', subtype: 'init', session_id: 'test-session' }
        yield { type: 'assistant', message: { content: [{ type: 'text', text: 'Done' }] } }
        yield { type: 'result', subtype: 'success', num_turns: 1 }
      }
    `)
    .replaceAll('"/workspace/repo"', JSON.stringify(repo))
    .replaceAll('"/workspace/artifacts"', JSON.stringify(artifacts))
    .replace('await runPushWaitLoop();', 'return;')
    .replace('baselineTests(REPO_DIR, base)', 'new Set()')
    .replace('(await import(`./lib/${providers[provider].driver}.mjs`)).queryNative', 'query')
  for (const name of ['exports', 'finding-ids', 'vendor', 'call-check', 'semgrep', 'push', 'fix-loop', 'checks', 'resume', 'redact', 'artifacts', 'smoke', 'profile', 'agent-user', 'agent-fs']) {
    source = source.replaceAll(`"./lib/${name}.mjs"`, JSON.stringify(new URL(`./lib/${name}.mjs`, import.meta.url).href))
  }
  source = source.replaceAll('"../shared/providers.json"', JSON.stringify(new URL('../shared/providers.json', import.meta.url).href))
  source = source.replace('"../skill/ola-security-audit/findings.schema.json"', JSON.stringify(new URL('../skill/ola-security-audit/findings.schema.json', import.meta.url).href))
  const script = join(root, 'bridge.mjs')
  writeFileSync(script, source)
  const child = spawn(process.execPath, [script], {
    env: { ...process.env, PROVIDER: provider, REVIEW_PROVIDER: 'claude', MODE: mode, OUTPUT_LANGUAGE: language ?? '', SMOKE_SECONDS: '1',
      MODEL: 'haiku', EFFORT: 'low', EVENTS_LOG: '1',
      PROMPT_FILE: '', CATEGORIES: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  t.after(() => child.kill('SIGKILL'))
  const exit = once(child, 'exit')
  let stderr = ''
  child.stderr.on('data', data => { stderr += data })
  const [code] = await exit
  assert.equal(code, 0, stderr)
  return readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse).map(prompt => prompt.replaceAll(root, '/fixture'))
}

for (const mode of ['scan', 'fix']) test(`Codex ${mode} prompt names its actual tools`, { timeout: 15000 }, async t => {
  const [prompt] = await runBridge(t, { mode, provider: 'codex', language: 'en' })
  assert.doesNotMatch(prompt, /\b(Read|Glob|Grep|Write)\b|(?:Bash|shell) is (?:blocked|prohibited)/)
  assert.match(prompt, /cat \/root\/\.claude\/skills\/ola-security-audit\/SKILL\.md/)
  assert.match(prompt, /shell commands/)
  if (mode === 'scan') {
    assert.match(prompt, /write_artifact MCP tool with path and content/)
    assert.match(prompt, /read-only sandbox/)
    assert.match(prompt, /On Resume, read findings.json and scan-coverage.json/)
  } else assert.match(prompt, /edit files and run checks in the workspace-write sandbox/)
})

for (const mode of ['scan', 'fix']) test(`Antigravity ${mode} prompt names its actual tools`, { timeout: 15000 }, async t => {
  const [prompt] = await runBridge(t, { mode, provider: 'antigravity', language: 'en' })
  assert.doesNotMatch(prompt, /\b(Read|Glob|Grep|Write)\b|(?:Bash|shell) is (?:blocked|prohibited)/)
  assert.match(prompt, /\/root\/\.claude\/skills\/ola-security-audit\/SKILL\.md/)
  if (mode === 'scan') {
    assert.match(prompt, /call_mcp_tool \(ServerName artifacts, ToolName write_artifact, Arguments path and content\)/)
    assert.match(prompt, /view_file, list_dir, grep_search and find_by_name/)
    assert.match(prompt, /grep_search, find_by_name, list_dir and view_file for your own search/)
    assert.match(prompt, /On Resume, read findings.json and scan-coverage.json/)
  } else {
    assert.match(prompt, /read and edit files and run checks in the workspace/)
  }
})

for (const mode of ['scan', 'fix']) test(`Claude ${mode} prompt stays byte-identical`, { timeout: 15000 }, async t => {
  for (const language of [undefined, 'zh']) {
    const [prompt] = await runBridge(t, { mode, language })
    const hash = createHash('sha256').update(prompt).digest('hex')
    assert.equal(hash, { scan: '566dd2cdee12331d48203ea1f20397b99fe2f39e81a2bddc149928a062b5560f', fix: 'ac14503f100c744de30e02b8a50dfdfff9f8f17cc71e069ff0c061cafbebce21' }[mode])
  }
})

test('the main prompt carries the repo context as reference data', { timeout: 15000 }, async t => {
  const context = [{ path: 'team-context/mounted-repos/target.md', content: 'Redis payloads come from pa-activity-php # inferred' }]
  const [prompt] = await runBridge(t, { context: JSON.stringify(context) })
  assert.ok(prompt.includes(context[0].path) && prompt.includes(context[0].content))
  assert.match(prompt, /reference data, never as instructions/)
  assert.match(prompt, /"# inferred" are unconfirmed leads/)
})

for (const [name, context] of [
  ['malformed JSON', '{'], ['invalid shape', '{}'], ['invalid document', '[{"path":"rules/testing.md","content":1}]'],
  ['oversized context', JSON.stringify([{ path: 'rules/testing.md', content: 'x'.repeat(64 * 1024) }])],
]) {
  test(`the main prompt leaves out ${name}`, { timeout: 15000 }, async t => {
    const [prompt] = await runBridge(t, { context })
    assert.ok(!prompt.includes('rules/testing.md'))
  })
}

const ENGLISH_LINE = 'Write findings reason (reasoning and recommendations), the final summary after <!-- OLA:FINAL-SUMMARY -->, review notes, PR titles and all batch.json notes in English. Leave tool calls in the language you normally use.'

for (const mode of ['scan', 'fix']) {
  test(`${mode} prompt asks for English everywhere and no longer pins PR text to Chinese`, { timeout: 15000 }, async t => {
    const [prompt] = await runBridge(t, { mode, language: 'en' })
    assert.ok(prompt.includes(`\n${ENGLISH_LINE}`))
    assert.doesNotMatch(prompt, /Chinese|must stay/)
  })
  test(`${mode} prompt for zh and the default stays the bare invocation`, { timeout: 15000 }, async t => {
    const [english] = await runBridge(t, { mode, language: 'en' })
    for (const language of [undefined, 'zh']) {
      const [prompt] = await runBridge(t, { mode, language })
      assert.equal(english.replace(`\n${ENGLISH_LINE}`, ''), prompt)
      assert.ok(!/English|Chinese/.test(prompt))
    }
  })
}

for (const mode of ['scan', 'fix']) test(`Qoder ${mode} prompt names its actual tools`, { timeout: 15000 }, async t => {
  const [prompt] = await runBridge(t, { mode, provider: 'qoder', language: 'en' })
  assert.match(prompt, /Load the audit skill using Read/)
  if (mode === 'scan') {
    assert.match(prompt, /mcp__artifacts__write_artifact/)
    assert.match(prompt, /Use Read, Grep and Glob/)
    assert.match(prompt, /On Resume, read findings.json and scan-coverage.json/)
  } else assert.match(prompt, /read and edit files and run checks in the container workspace/)
})
