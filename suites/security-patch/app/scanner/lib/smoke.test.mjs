import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { relaySettings, smokeQuery } from './smoke.mjs'
import { redact } from './redact.mjs'

const TOKEN = 'fixture' + '-relay-token-348'
const env = { ANTHROPIC_BASE_URL: 'https://litellm.example', ANTHROPIC_AUTH_TOKEN: TOKEN,
  ANTHROPIC_MODEL: 'gateway-fixture', EFFORT: 'high' }
const message = text => ({ type: 'assistant', message: { content: [{ type: 'text', text }] } })

test('relay settings keep the configured model and effort, require a token, and protect remote credentials', () => {
  assert.deepEqual(relaySettings(env), { model: 'gateway-fixture', effort: 'high' })
  assert.throws(() => relaySettings({ ...env, ANTHROPIC_AUTH_TOKEN: '' }), /AUTH_TOKEN/)
  assert.throws(() => relaySettings({ ...env, ANTHROPIC_BASE_URL: 'http://remote.example' }), /HTTPS/)
  assert.throws(() => relaySettings({ ...env, ANTHROPIC_BASE_URL: 'https://user:fixture@remote.example' }), /URL credentials/)
  assert.deepEqual(relaySettings({ ...env, ANTHROPIC_BASE_URL: 'http://127.0.0.1:4000' }), { model: 'gateway-fixture', effort: 'high' })
  assert.equal(redact(`Authentication failed: ${TOKEN}`, env), 'Authentication failed: [REDACTED]')
})

for (const scenario of ['response', 'tool-first', 'timeout', 'empty', 'authentication', 'effort', 'effort-assistant', 'thrown-authentication', 'thrown-effort']) {
  test(`relay smoke ${scenario}: saves its outcome without exposing the fake credential`, { timeout: 2000 }, async t => {
    const artifactsDir = mkdtempSync(join(tmpdir(), 'ola-relay-'))
    t.after(() => rmSync(artifactsDir, { recursive: true, force: true }))
    const controller = new AbortController()
    let closed = false
    const iter = (async function* () {
      if (scenario === 'thrown-authentication') throw new Error(`authentication_failed: invalid key ${TOKEN}`)
      else if (scenario === 'thrown-effort') throw new Error(`unsupported output_config.effort: high ${TOKEN}`)
      else if (scenario === 'timeout') await new Promise((_, reject) => controller.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }))
      else if (scenario === 'authentication') yield { ...message(`Bad key ${TOKEN}`), error: 'authentication_failed' }
      else if (scenario === 'effort') yield { type: 'result', is_error: true, errors: [`unsupported output_config.effort: high ${TOKEN}`] }
      else if (scenario === 'effort-assistant') yield { ...message(`unsupported output_config.effort: high ${TOKEN}`), error: 'invalid_request' }
      else if (scenario === 'response') yield message(`READY ${TOKEN}`)
      else if (scenario === 'tool-first') yield { type: 'assistant', message: { content: [{ type: 'thinking', thinking: '' }, { type: 'tool_use', name: 'Grep', input: { pattern: TOKEN } }] } }
    })()
    iter.close = () => { closed = true }
    const output = []
    const run = async () => { for await (const item of smokeQuery(iter, { seconds: 0.02, controller, artifactsDir, env })) output.push(item) }
    const responded = ['response', 'tool-first'].includes(scenario)
    if (responded) await run()
    else await assert.rejects(run, scenario.includes('authentication') ? /authentication_failed/ : scenario.includes('effort') ? /effort/ : /inconclusive/)
    const metadata = JSON.parse(readFileSync(join(artifactsDir, 'smoke.json')))
    assert.equal(metadata.status, responded ? 'responded' : scenario.includes('authentication') || scenario.includes('effort') ? 'failed' : 'inconclusive')
    assert.equal(metadata.effort, 'high')
    assert.equal(metadata.settingStatus, scenario.includes('effort') ? 'rejected' : responded ? 'request_succeeded' : 'unverified')
    assert.equal(metadata.model, 'gateway-fixture')
    assert.equal(controller.signal.aborted, true)
    assert.equal(closed, true)
    assert.ok(!JSON.stringify(output).includes(TOKEN))
    assert.ok(!JSON.stringify(metadata).includes(TOKEN))
  })
}

for (const scenario of ['response', 'scan-smoke', 'authentication', 'non-smoke']) test(`bridge relay ${scenario}: forwards the gateway settings once and saves safe artifacts`, { timeout: 15000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'ola-relay-bridge-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const repo = join(root, 'repo')
  const artifacts = join(root, 'artifacts')
  mkdirSync(repo)
  mkdirSync(artifacts)
  writeFileSync(join(repo, 'fixture.php'), '<?php return "SELECT * FROM users WHERE id = ". $id;')
  let source = readFileSync(new URL('../bridge.mjs', import.meta.url), 'utf8')
  source = source.replace('import { query } from "@anthropic-ai/claude-agent-sdk";', `
    function query({ options }) {
      options.stderr?.('Gateway diagnostic ' + ${JSON.stringify(TOKEN)});
      const selectedEnv = options.env || process.env;
      writeFileSync(${JSON.stringify(join(root, 'request.json'))}, JSON.stringify({
        model: options.model, effort: options.effort,
        gatewayModel: selectedEnv.ANTHROPIC_MODEL, gatewayUrl: selectedEnv.ANTHROPIC_BASE_URL,
        keyMatches: selectedEnv.ANTHROPIC_AUTH_TOKEN === ${JSON.stringify(TOKEN)},
        retries: selectedEnv.CLAUDE_CODE_MAX_RETRIES,
        githubKeyAbsent: selectedEnv.GH_TOKEN === undefined,
      }));
      const iter = (async function* () {
        ${scenario !== 'authentication' ? `yield { type: 'assistant', message: { content: [{ type: 'text', text: ${JSON.stringify(scenario === 'non-smoke' ? 'READY ' + TOKEN : 'READY')} }] } };` : `yield { type: 'assistant', error: 'authentication_failed', message: { content: [{ type: 'text', text: 'invalid key ' + ${JSON.stringify(TOKEN)} }] } };`}
      })();
      iter.close = () => {};
      return iter;
    }
  `).replaceAll('"/workspace/repo"', JSON.stringify(repo))
    .replaceAll('"/workspace/artifacts"', JSON.stringify(artifacts))
    .replace('await runPushWaitLoop();', 'return;')
  for (const name of ['exports','push','vendor','call-check','semgrep','fix-loop','checks','resume','finding-ids','redact', 'artifacts','smoke', 'profile', 'agent-user', 'agent-fs']) {
    source = source.replaceAll(`"./lib/${name}.mjs"`, JSON.stringify(new URL(`./${name}.mjs`, import.meta.url).href))
  }
  source = source.replaceAll('"../shared/providers.json"', JSON.stringify(new URL('../../shared/providers.json', import.meta.url).href))
  source = source.replace('"../skill/ola-security-audit/findings.schema.json"', JSON.stringify(new URL('../../skill/ola-security-audit/findings.schema.json', import.meta.url).href))
  const script = join(root, 'bridge.mjs')
  writeFileSync(script, source)
  const child = spawn(process.execPath, [script], { env: { ...process.env, ...env,
    GH_TOKEN: 'dummy' + '-gh', PROVIDER: 'claude', MODE: scenario === 'scan-smoke' ? 'scan' : 'fix', MODEL: '', SMOKE_SECONDS: scenario === 'non-smoke' ? '0' : '0.1',
    EVENTS_LOG: '1', PROMPT_FILE: '', CATEGORIES: '' }, stdio: ['pipe','pipe','pipe'] })
  t.after(() => child.kill('SIGKILL'))
  let output = ''
  child.stdout.on('data', data => { output += data })
  child.stderr.on('data', data => { output += data })
  const [code] = await once(child, 'exit')
  assert.equal(code, scenario === 'authentication' ? 1 : 0, output)
  assert.ok(!output.includes(TOKEN))
  const request = JSON.parse(readFileSync(join(root, 'request.json')))
  // No MODEL: the relay's ANTHROPIC_MODEL picks the model, in scan and fix mode.
  assert.equal(request.model, undefined)
  assert.equal(request.gatewayModel, 'gateway-fixture')
  assert.equal(request.effort, 'high')
  assert.equal(request.keyMatches, true)
  assert.equal(request.retries, scenario === 'non-smoke' ? undefined : '0')
  if (scenario !== 'non-smoke') assert.equal(request.githubKeyAbsent, true)
  for (const file of ['report.md','response.md','events.jsonl', ...(scenario === 'non-smoke' ? [] : ['smoke.json'])]) {
    assert.ok(!readFileSync(join(artifacts, file), 'utf8').includes(TOKEN), file)
  }
  if (scenario === 'scan-smoke') assert.equal(JSON.parse(readFileSync(join(artifacts, 'semgrep.json'), 'utf8')).skipped, 'smoke check')
  assert.equal(readFileSync(join(artifacts, 'response.md'), 'utf8').trim(), ['response', 'scan-smoke'].includes(scenario) ? 'READY' : scenario === 'non-smoke' ? 'READY [REDACTED]' : '')
})

test('a Claude run with no MODEL and no ANTHROPIC_MODEL fails before any model call', { timeout: 15000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'ola-no-model-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'artifacts'))
  let source = readFileSync(new URL('../bridge.mjs', import.meta.url), 'utf8')
    .replace('import { query } from "@anthropic-ai/claude-agent-sdk";', 'function query() { throw new Error("query must not run") }')
    .replaceAll('"/workspace/artifacts"', JSON.stringify(join(root, 'artifacts')))
  for (const name of ['exports','push','vendor','call-check','semgrep','fix-loop','checks','resume','finding-ids','redact', 'artifacts','smoke', 'profile', 'agent-user', 'agent-fs']) {
    source = source.replaceAll(`"./lib/${name}.mjs"`, JSON.stringify(new URL(`./${name}.mjs`, import.meta.url).href))
  }
  source = source.replaceAll('"../shared/providers.json"', JSON.stringify(new URL('../../shared/providers.json', import.meta.url).href))
  source = source.replace('"../skill/ola-security-audit/findings.schema.json"', JSON.stringify(new URL('../../skill/ola-security-audit/findings.schema.json', import.meta.url).href))
  writeFileSync(join(root, 'bridge.mjs'), source)
  const { ANTHROPIC_MODEL: _, ...base } = process.env
  const child = spawn(process.execPath, [join(root, 'bridge.mjs')], { env: { ...base, PROVIDER: 'claude', MODE: 'scan', MODEL: '' }, stdio: ['pipe','pipe','pipe'] })
  t.after(() => child.kill('SIGKILL'))
  let output = ''
  child.stdout.on('data', data => { output += data })
  const [code] = await once(child, 'exit')
  assert.equal(code, 1)
  assert.match(output, /"kind":"scanner_failed","error":"No model: set MODEL, or ANTHROPIC_MODEL for a relay\."/)
})
