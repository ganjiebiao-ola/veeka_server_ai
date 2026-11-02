import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assignFindingIds } from './lib/finding-ids.mjs'

const ID = 'a'.repeat(64)

// Runs the real bridge in batch fix mode with a fake model. Returns the prompts the model got, in order.
// checkpoint: what the stopped run saved (progress, done). reviews: notes the fake reviewer writes per round.
async function runBridge(t, { pause = false, nativeStop = false, stopDuringExport = false, checkpoint, carried = {}, reviews = [], reviewRaw, done = [], env = {}, errorResult, reviewFailure = false, afterResultMessages = [], semgrepReport, scanWrites = {}, thrownError, quotaWorker, numberedUsage, rework = false }) {
  const root = mkdtempSync(join(tmpdir(), 'ola-resume-progress-'))
  t.after(() => {
    if (quotaWorker) {
      try {
        for (const pid of JSON.parse(readFileSync(join(root, 'worker-pids.json'), 'utf8'))) {
          try { process.kill(pid, 'SIGKILL') } catch { /* already exited */ }
        }
      } catch { /* worker not started */ }
    }
    rmSync(root, { recursive: true, force: true })
  })
  const repo = join(root, 'repo')
  const artifacts = join(root, 'artifacts')
  mkdirSync(repo)
  mkdirSync(artifacts)
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' }).toString().trim()
  git('init', '-q')
  git('config', 'user.name', 'Test')
  git('config', 'user.email', 'test@example.invalid')
  git('config', 'commit.gpgsign', 'false')
  const file = semgrepReport ? 'fix.php' : 'fix.txt'
  writeFileSync(join(repo, file), 'before\n')
  git('add', '.')
  git('commit', '-qm', 'base')
  writeFileSync(join(artifacts, 'base.json'), JSON.stringify({ sha: git('rev-parse', 'HEAD') }))
  writeFileSync(join(repo, file), 'after\n')
  git('commit', '-qam', 'fix')
  writeFileSync(join(artifacts, 'picked.json'), JSON.stringify([{ id: ID, category: 'sqli' }]))
  if (checkpoint) writeFileSync(join(artifacts, 'resume-checkpoint.json'), JSON.stringify(checkpoint))
  for (const [name, text] of Object.entries(carried)) writeFileSync(join(artifacts, name), text)

  const log = join(root, 'requests.jsonl')
  const native = env.PROVIDER === 'codex'
  const peer = join(root, 'codex.mjs')
  if (native) writeFileSync(peer, `
    import assert from 'node:assert/strict'
    import { appendFileSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
    import { spawnSync } from 'node:child_process'
    const prompt = readFileSync(0, 'utf8')
    assert.deepEqual(process.argv.slice(2, 4), ['exec', '--json'])
    appendFileSync(${JSON.stringify(log)}, JSON.stringify({ prompt, args: process.argv.slice(2) }) + '\\n')
    const emit = event => console.log(JSON.stringify(event))
    const args = process.argv.find(arg => arg.startsWith('mcp_servers.artifacts.args='))
    const serverArgs = JSON.parse(args.slice(args.indexOf('=') + 1))
    const context = JSON.parse(readFileSync(serverArgs[1], 'utf8'))
    const coverageFile = context.artifactsDir + '/scan-coverage.json'
    const coverage = existsSync(coverageFile) ? JSON.parse(readFileSync(coverageFile, 'utf8')) : []
    const covered = Array.isArray(coverage) ? coverage : coverage.coveredFiles
    const scanned = ['fix.php'].filter(file => !covered.includes(file))
    writeFileSync(${JSON.stringify(join(root, 'scanned-files.json'))}, JSON.stringify(scanned))
    const writeArtifacts = () => {
      if (!${Object.keys(scanWrites).length}) return
      const input = Object.entries(${JSON.stringify(scanWrites)}).map(([name, content], id) => JSON.stringify({
        jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'write_artifact',
          arguments: { path: context.artifactsDir + '/' + name, content } },
      })).join('\\n') + '\\n'
      const result = spawnSync(process.execPath, serverArgs, { input, encoding: 'utf8' })
      assert.equal(result.status, 0, result.stderr)
      for (const line of result.stdout.trim().split('\\n').filter(Boolean)) assert.ok(!JSON.parse(line).result.isError, line)
    }
    emit({ type: 'thread.started', thread_id: 'native-scan-thread' })
    if (${pause || nativeStop}) {
      process.on('SIGINT', () => {
        assert.ok(existsSync(${JSON.stringify(join(root, 'tools-finished'))}), 'interrupted before parallel items completed')
        writeFileSync(${JSON.stringify(join(root, 'codex-int'))}, 'yes')
        emit({ type: 'turn.failed', error: { message: 'Interrupted' } })
      })
      process.on('SIGTERM', () => {
        writeFileSync(${JSON.stringify(join(root, 'codex-term'))}, 'yes')
        process.exit(0)
      })
      emit({ type: 'item.started', item: { id: 'one', type: 'command_execution', command: 'pause-ready' } })
      emit({ type: 'item.started', item: { id: 'two', type: 'mcp_tool_call', server: 'artifacts', tool: 'write_artifact' } })
      setTimeout(() => {
        emit({ type: 'item.completed', item: { id: 'one', type: 'command_execution', exit_code: 0 } })
        setTimeout(() => {
          writeArtifacts()
          writeFileSync(${JSON.stringify(join(root, 'tools-finished'))}, 'yes')
          emit({ type: 'item.completed', item: { id: 'two', type: 'mcp_tool_call' } })
        }, 250)
      }, 250)
      setInterval(() => {}, 1000)
    } else {
      assert.match(prompt, /skip covered files/)
      writeArtifacts()
      emit({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } })
    }
  `)
  const writer = `
    const { writeFileSync, renameSync } = require('node:fs')
    writeFileSync(${JSON.stringify(join(root, 'worker-pids.json'))}, JSON.stringify([process.ppid, process.pid]))
    let tick = 0
    const atomicWrite = (path, data) => { writeFileSync(path + '.tmp', data); renameSync(path + '.tmp', path) }
    const write = () => {
      atomicWrite(${JSON.stringify(join(artifacts, 'findings.json'))}, JSON.stringify([{ ...${JSON.stringify(scanRow)}, reason: 'worker tick ' + ++tick }]))
      atomicWrite(${JSON.stringify(join(artifacts, 'scan-coverage.json'))}, '["fix.php"]')
      atomicWrite(${JSON.stringify(join(root, 'worker-ticks'))}, String(tick))
    }
    process.on('SIGTERM', () => {
      write()
      writeFileSync(${JSON.stringify(join(root, 'worker-term'))}, 'ignored')
      process.stdout.write('term ignored')
    })
    write()
    setInterval(${quotaWorker === 'pipe-holder' ? '() => {}' : 'write'}, 20)
    process.stdout.write('ready')
  `
  const sdkWorker = `
    const { spawn } = require('node:child_process')
    const writer = spawn(process.execPath, ['-e', ${JSON.stringify(writer)}], {
      detached: ${quotaWorker === 'pipe-holder'}, stdio: ['ignore', 'inherit', 'ignore'],
    })
    process.on('SIGTERM', () => writer.kill('SIGTERM'))
  `
  let source = readFileSync(new URL('./bridge.mjs', import.meta.url), 'utf8')
    .replace('import { query } from "@anthropic-ai/claude-agent-sdk";', `
      import { once } from 'node:events'
      function query(request) {
        const iter = messages(request)
        iter.close = () => writeFileSync(${JSON.stringify(join(root, 'sdk-aborted'))}, String(request.options.abortController.signal.aborted))
        return iter
      }
      async function* messages(request) {
        let prompt = ''
        for await (const message of request.prompt) prompt += message.message.content
        appendFileSync(${JSON.stringify(log)}, JSON.stringify({ prompt, options: {
          model: request.options.model, effort: request.options.effort, thinking: request.options.thinking,
        } }) + '\\n')
        for (const [name, content] of Object.entries(${JSON.stringify(scanWrites)})) {
          agentFs.writeFileSync(${JSON.stringify(artifacts)} + '/' + name, content)
        }
        if (${JSON.stringify(thrownError ?? '')}) throw new Error(${JSON.stringify(thrownError ?? '')})
        if (/^(Review notes|Check step failed)/.test(prompt)) {
          const permission = await request.options.canUseTool('Bash', { command: 'git commit -m fix' })
          if (permission.behavior !== 'allow') throw new Error('Fix commands kept the review guard')
          if (${rework} && prompt.startsWith('Review notes')) {
            writeFileSync(${JSON.stringify(join(repo, file))}, 'reworked\\n')
            const result = agentSpawnSync('git', ['-C', ${JSON.stringify(repo)}, 'commit', '-qam', 'rework'], { env: agentEnv })
            if (result.status !== 0) throw new Error('Test rework commit failed')
          }
        }
        const review = prompt.match(/^Review pass (\\d)/)
        if (review && !${reviewFailure} && ${JSON.stringify(reviews)}[review[1] - 1] !== null) writeFileSync(${JSON.stringify(join(artifacts, 'review-'))} + review[1] + '.json', JSON.stringify(${JSON.stringify(reviews)}[review[1] - 1] ?? []))
        if (review && ${JSON.stringify(reviewRaw ?? null)} !== null) writeFileSync(${JSON.stringify(join(artifacts, 'review-'))} + review[1] + '.json', ${JSON.stringify(reviewRaw ?? null)})
        yield { type: 'system', subtype: 'init', session_id: 'fix-session' }
        yield { type: 'assistant', message: { content: [{ type: 'text', text: 'Report' }] } }
        if (${pause}) {
          yield { type: 'assistant', message: { content: [
            { type: 'tool_use', id: 'one', name: 'Read', input: {} },
            { type: 'tool_use', id: 'two', name: 'Read', input: {} },
          ] } }
          emit({ kind: 'test_pause_ready' })
          while (!pauseRequested) await new Promise(resolve => setTimeout(resolve, 5))
          yield { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'one' }] } }
          writeFileSync(${JSON.stringify(join(root, 'tools-finished'))}, 'yes')
          yield { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'two' }] } }
          throw new Error('Provider continued after the pause boundary')
        }
        let worker
        if (${Boolean(quotaWorker)}) {
          worker = request.options.spawnClaudeCodeProcess({ command: process.execPath,
            args: ['-e', ${JSON.stringify(sdkWorker)}], cwd: request.options.cwd, env: process.env })
          worker.once('close', () => writeFileSync(${JSON.stringify(join(root, 'sdk-closed'))}, 'closed'))
          await once(worker.stdout, 'data')
        }
        try {
          const callNumber = readFileSync(${JSON.stringify(log)}, 'utf8').trim().split('\\n').length
          if (callNumber === Number(process.env.TEST_QUOTA_AFTER) + 1) throw new Error('quota exceeded')
          yield { ...(review && ${reviewFailure} ? { type: 'result', subtype: 'error_during_execution', is_error: true } : ${JSON.stringify(errorResult ?? { type: 'result', subtype: 'success', num_turns: 1 })}),
            ...(${Boolean(numberedUsage)} ? { usage: { input_tokens: 1, output_tokens: callNumber } } : {}) }
          for (const message of ${JSON.stringify(afterResultMessages)}) yield message
        } finally {
          if (worker) {
            const ignored = once(worker.stdout, 'data')
            worker.kill('SIGTERM')
            await ignored
          }
        }
      }
    `)
    .replace('agentSpawn, agentSpawnSync } from "./lib/agent-user.mjs"', 'agentSpawn, agentSpawnSync as realAgentSpawnSync } from "./lib/agent-user.mjs"')
    .concat(`
      function agentSpawnSync(command, args, options) {
        if (command !== 'kill') return realAgentSpawnSync(command, args, options)
        if (JSON.stringify(args) !== '["-9","--","-1"]') throw new Error('Unexpected kill command')
        if (readFileSync(${JSON.stringify(join(root, 'sdk-aborted'))}, 'utf8') !== 'true') throw new Error('SDK not aborted and closed before kill')
        writeFileSync(${JSON.stringify(join(root, 'agent-kill'))}, JSON.stringify(args))
        if (${Boolean(quotaWorker)}) {
          const [sdk, writer] = JSON.parse(readFileSync(${JSON.stringify(join(root, 'worker-pids.json'))}, 'utf8'))
          // Model an inherited pipe owned by a different uid, outside the agent kill's reach.
          if (${quotaWorker !== 'pipe-holder'}) process.kill(writer, 'SIGKILL')
          process.kill(sdk, 'SIGKILL')
        }
        return { status: 0 }
      }
    `)
    .replaceAll('"/workspace/repo"', JSON.stringify(repo))
    .replaceAll('"/workspace/artifacts"', JSON.stringify(artifacts))
    .replace('await runPushWaitLoop();', 'return;')
    // The base tests run PHPUnit in /tmp. Skip them, the new-test check still fails for this PHP-free repo.
    .replace('baselineTests(REPO_DIR, base)', 'new Set()')
  if (semgrepReport) source = source.replace('import { runSemgrep, runVendorSemgrep } from "./lib/semgrep.mjs";',
    `const runSemgrep = () => (${JSON.stringify(semgrepReport)});`)
  for (const name of ['exports', 'finding-ids', 'vendor', 'call-check', 'semgrep', 'push', 'fix-loop', 'checks', 'resume', 'redact', 'artifacts', 'smoke', 'profile', 'agent-user', 'agent-fs']) {
    source = source.replaceAll(`"./lib/${name}.mjs"`, JSON.stringify(new URL(`./lib/${name}.mjs`, import.meta.url).href))
  }
  source = source.replaceAll('"../shared/providers.json"', JSON.stringify(new URL('../shared/providers.json', import.meta.url).href))
  source = source.replace('"../skill/ola-security-audit/findings.schema.json"', JSON.stringify(new URL('../skill/ola-security-audit/findings.schema.json', import.meta.url).href))
  source = source.replace('import(`./lib/', 'import(`' + new URL('./lib/', import.meta.url).href)
  if (stopDuringExport) source = source.replace('const child = agentSpawn(cmd, args, {', `
    emit({ kind: 'test_export_started' })
    const child = agentSpawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {`)
  const script = join(root, 'bridge.mjs')
  writeFileSync(script, source)
  const child = spawn(process.execPath, [script], { env: { ...process.env,
    PROVIDER: 'claude', REVIEW_PROVIDER: 'claude', MODE: 'fix', MODEL: 'haiku', EFFORT: 'low', EVENTS_LOG: '1',
    PICKED_FILE: join(artifacts, 'picked.json'), PROMPT_FILE: '', CATEGORIES: '', RESUME_DONE: done.join(','),
    MAX_TURNS: '', MAX_BUDGET_USD: '', ...env,
    ...(native ? { PROVIDER_COMMAND: JSON.stringify([process.execPath, peer]) } : {}),
  }, stdio: [pause || nativeStop ? 'pipe' : 'ignore', 'pipe', 'pipe'] })
  t.after(() => child.kill('SIGKILL'))
  const exit = once(child, 'exit')
  let stderr = ''
  const started = Date.now()
  if (pause || nativeStop) child.stdout.on('data', data => {
    if (nativeStop && data.toString().includes('pause-ready')) child.kill('SIGTERM')
    if (pause && (data.toString().includes('test_pause_ready') || native && data.toString().includes('pause-ready'))) child.stdin.write('{"type":"pause"}\n')
    if (stopDuringExport && data.toString().includes('test_export_started')) child.kill('SIGTERM')
  })
  else child.stdout.resume()
  child.stderr.on('data', data => { stderr += data })
  const [code] = await exit
  let requests = []
  try { requests = readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) } catch { /* no model call */ }
  return { prompts: requests.map(r => r.prompt), requests, code, stderr, artifacts, repo, root, elapsed: Date.now() - started }
}

const starts = (prompts) => prompts.map(p => p.match(/^(Review pass \d|Review notes|Check step failed|\/ola-security-audit)/)?.[1] ?? p.slice(0, 30))
const progress = (phase, extra = {}) => ({ done: [ID], progress: { phase, review: [], checkFixRounds: 0, checksPassed: false, ...extra } })

test('resume with every picked row done skips the fix prompt and starts the review', { timeout: 15000 }, async t => {
  const r = await runBridge(t, { checkpoint: progress('fix'), done: [ID], reviews: [[]] })
  assert.equal(r.code, 0, r.stderr)
  // Review 1 is clean, then the check step (the PHP-free repo has no new test) sends its 2 fix rounds.
  assert.deepEqual(starts(r.prompts), ['Review pass 1', 'Check step failed', 'Check step failed'])
  assert.ok(r.prompts.every(p => !p.includes('Batch fix mode')))
})

for (const language of ['en', 'zh']) test(`the fresh review prompt ${language === 'en' ? 'asks for' : 'leaves out'} English notes`, { timeout: 15000 }, async t => {
  const r = await runBridge(t, { checkpoint: progress('fix'), done: [ID], reviews: [[]], env: { OUTPUT_LANGUAGE: language } })
  assert.equal(r.code, 0, r.stderr)
  const review = r.prompts.find(prompt => prompt.startsWith('Review pass 1'))
  assert.ok(review.includes(`Express all note text in ${language === 'en' ? 'English' : 'Chinese'}.`))
})

test('each round usage is tagged with its batch phase exactly once', { timeout: 15000 }, async t => {
  const r = await runBridge(t, { reviews: [['n1'], []], numberedUsage: true })
  assert.equal(r.code, 0, r.stderr)
  assert.deepEqual(starts(r.prompts), ['/ola-security-audit', 'Review pass 1', 'Review notes', 'Review pass 2', 'Check step failed', 'Check step failed'])
  const tagged = readFileSync(join(r.artifacts, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
    .filter(e => e.kind === 'sdk_message' && e.message.type === 'result')
    .map(e => [e.message.usage.output_tokens, e.phase])
  assert.deepEqual(tagged, [[1, 'fix'], [2, 'review'], [3, 'review'], [4, 'review'], [5, 'checks'], [6, 'checks']])
})

test('without a checkpoint the fix prompt still runs first', { timeout: 15000 }, async t => {
  const r = await runBridge(t, { reviews: [[]] })
  assert.equal(r.code, 0, r.stderr)
  assert.equal(starts(r.prompts)[0], '/ola-security-audit')
  assert.match(r.prompts[0], /Batch fix mode/)
})

test('resume keeps the stopped run report and reports each batch phase', { timeout: 15000 }, async t => {
  const r = await runBridge(t, { checkpoint: progress('fix'), carried: { 'resume-report.md': 'Fixed the row.\n<!-- OLA:FINAL-SUMMARY -->\nOld summary.\n' }, done: [ID], reviews: [[]] })
  assert.equal(r.code, 0, r.stderr)
  const report = readFileSync(join(r.artifacts, 'report.md'), 'utf8')
  assert.match(report, /^Fixed the row\.\n\nOld summary\.\n\n---\n\n## Resumed\n\nReport/)
  const phases = readFileSync(join(r.artifacts, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
    .filter(e => e.kind === 'phase').map(e => e.phase)
  assert.deepEqual(phases, ['review', 'checks'])
})

test('resume continues the review from the next round', { timeout: 15000 }, async t => {
  const stopped = progress('review', { review: [{ round: 1, notes: 1, fixed: true }] })
  const r = await runBridge(t, { checkpoint: stopped, carried: { 'review-1.json': '["old note"]' }, done: [ID], reviews: [['x'], ['new note']] })
  assert.equal(r.code, 0, r.stderr)
  // Round 1 is not reviewed or fixed again. Round 2 is the last review round.
  assert.deepEqual(starts(r.prompts).slice(0, 2), ['Review pass 2', 'Review notes'])
  assert.match(r.prompts[1], /new note/)
  assert.ok(r.prompts.every(p => !/Review pass 1/.test(p)))
  assert.match(r.prompts[0], /old note/)
})

test('resume fixes the carried notes of a review round that was inspected but not fixed', { timeout: 15000 }, async t => {
  const stopped = progress('review', { review: [{ round: 1, notes: 1, fixed: false }] })
  const r = await runBridge(t, { checkpoint: stopped, carried: { 'review-1.json': '["old note"]' }, done: [ID], reviews: [[], []] })
  assert.equal(r.code, 0, r.stderr)
  assert.deepEqual(starts(r.prompts).slice(0, 2), ['Review notes', 'Review pass 2'])
  assert.match(r.prompts[0], /old note/)
})

test('resume clears the review guard before check fixes after a carried clean review', { timeout: 15000 }, async t => {
  const stopped = progress('review', { review: [{ round: 1, notes: 0, fixed: false }] })
  const r = await runBridge(t, { checkpoint: stopped, carried: { 'review-1.json': '[]' }, done: [ID], env: { OUTPUT_LANGUAGE: 'en' } })
  assert.equal(r.code, 0, r.stderr)
  assert.deepEqual(starts(r.prompts), ['Check step failed', 'Check step failed'])
  assert.ok(r.prompts.every(prompt => prompt.includes('review notes, PR titles and all batch.json notes in English.') && !prompt.includes('Chinese')))
})

test('failed review survives a stop in checks and resume', { timeout: 15000 }, async t => {
  const failed = await runBridge(t, { checkpoint: progress('review'), done: [ID], reviewFailure: true, env: { TEST_QUOTA_AFTER: '1' }, carried: { 'batch.json': '{"fix_pattern":"kept"}' } })
  assert.deepEqual(JSON.parse(readFileSync(join(failed.artifacts, 'batch.json'), 'utf8')), { fix_pattern: 'kept', review_did_not_run: [1], review_rounds: 0 })
  const checkpoint = JSON.parse(readFileSync(join(failed.artifacts, 'checkpoint.json'), 'utf8'))
  assert.deepEqual(checkpoint.review_did_not_run, [1])
  const resumed = await runBridge(t, { checkpoint, done: [ID] })
  assert.equal(resumed.code, 0, resumed.stderr)
  assert.deepEqual(JSON.parse(readFileSync(join(resumed.artifacts, 'batch.json'), 'utf8')).review_did_not_run, [1])
})

test('a reviewer that writes no notes is recorded as not run', { timeout: 15000 }, async t => {
  const r = await runBridge(t, { checkpoint: progress('review'), done: [ID], reviews: [null] })
  assert.equal(r.code, 0, r.stderr)
  assert.deepEqual(JSON.parse(readFileSync(join(r.artifacts, 'batch.json'), 'utf8')).review_did_not_run, [1])
})

test('a successful retried review clears its carried marker', { timeout: 15000 }, async t => {
  const checkpoint = { ...progress('review'), review_did_not_run: [1] }
  const r = await runBridge(t, { checkpoint, done: [ID], reviews: [[]], carried: { 'batch.json': '{"review_did_not_run":[1]}' } })
  assert.equal(r.code, 0, r.stderr)
  assert.deepEqual(JSON.parse(readFileSync(join(r.artifacts, 'batch.json'), 'utf8')), { review_rounds: 1 })
})

for (const message of ['Semgrep pre-pass failed. Continue with your own source search.', 'File timed out']) {
  test(`check rescan fails when Semgrep reports: ${message}`, { timeout: 15000 }, async t => {
    const r = await runBridge(t, { checkpoint: progress('checks'), done: [ID],
      semgrepReport: { results: [], errors: [{ path: 'fix.php', message }] } })
    assert.equal(r.code, 0, r.stderr)
    const checks = JSON.parse(readFileSync(join(r.artifacts, 'checks.json'), 'utf8'))
    const rescan = checks.find(check => check.name === 'rescan')
    assert.equal(rescan.ok, false)
    assert.ok(rescan.output.includes(message), rescan.output)
    assert.equal(r.prompts.length, 2)
    assert.ok(r.prompts.every(prompt => prompt.includes('rescan failed') && prompt.includes(message)))
  })
}

for (const notes of ['{}', '[oops', '["valid note", 3]']) {
  test(`invalid review notes are recorded: ${notes}`, { timeout: 15000 }, async t => {
    const r = await runBridge(t, { reviewRaw: notes })
    assert.equal(r.code, 0, r.stderr)
    assert.deepEqual(JSON.parse(readFileSync(join(r.artifacts, 'batch.json'), 'utf8')).review_did_not_run, [1])
  })
}

for (const batch of ['{oops', '[]', 'null']) {
  test(`malformed batch notes do not stop a successful review: ${batch}`, { timeout: 15000 }, async t => {
    const r = await runBridge(t, { checkpoint: progress('review'), done: [ID], reviews: [[]], carried: { 'batch.json': batch } })
    assert.equal(r.code, 0, r.stderr)
    assert.deepEqual(JSON.parse(readFileSync(join(r.artifacts, 'batch.json'), 'utf8')), { review_rounds: 1 })
  })
}

test('resume goes straight to the checks when the review finished, and keeps the check round limit', { timeout: 15000 }, async t => {
  const finished = await runBridge(t, { checkpoint: progress('checks'), carried: { 'review-1.json': '[]' }, done: [ID] })
  assert.equal(finished.code, 0, finished.stderr)
  assert.deepEqual(starts(finished.prompts), ['Check step failed', 'Check step failed'])
  // One check fix round already ran before the stop, so only one is left.
  const oneLeft = await runBridge(t, { checkpoint: progress('checks', { checkFixRounds: 1 }), done: [ID] })
  assert.deepEqual(starts(oneLeft.prompts), ['Check step failed'])
  const none = await runBridge(t, { checkpoint: progress('checks', { checkFixRounds: 2 }), done: [ID] })
  assert.deepEqual(none.prompts, [])
  // Checks that already passed are not run again.
  const passed = await runBridge(t, { checkpoint: progress('checks', { checksPassed: true }), done: [ID] })
  assert.deepEqual(passed.prompts, [])
})

test('a stop in the review saves the phase and the review rounds', { timeout: 15000 }, async t => {
  // A quota error before fixing review notes preserves the review progress.
  const r = await runBridge(t, { reviews: [['n1']], env: { TEST_QUOTA_AFTER: '2' } })
  assert.equal(r.code, 1, r.stderr)
  const checkpoint = JSON.parse(readFileSync(join(r.artifacts, 'checkpoint.json'), 'utf8'))
  assert.deepEqual(checkpoint.progress, { phase: 'review', review: [{ round: 1, notesFile: 'review-1.json', notes: 1, fixed: false, reworkBase: execFileSync('git', ['-C', r.repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() }], checkFixRounds: 0, checksPassed: false })
  assert.equal(readFileSync(join(r.artifacts, 'review-1.json'), 'utf8'), '["n1"]')
})


for (const field of ['result', 'errors']) test(`provider quota in ${field} saves a Resume checkpoint and redacts diagnostics`, { timeout: 15000 }, async t => {
  const secret = 'fixture.provider.secret'
  const text = `Usage limit reached. ${secret} ` + 'x'.repeat(900)
  const r = await runBridge(t, {
    errorResult: { type: 'result', subtype: 'error_during_execution', is_error: true, [field]: field === 'errors' ? [text] : text },
    env: { ANTHROPIC_API_KEY: secret },
  })
  assert.equal(r.code, 1)
  const checkpoint = JSON.parse(readFileSync(join(r.artifacts, 'checkpoint.json'), 'utf8'))
  assert.equal(checkpoint.reason, 'quota')
  assert.match(r.stderr, /checkpoint saved, 0 findings done/)
  assert.match(r.stderr, /Provider request failed: Usage limit reached/)
  assert.ok(!r.stderr.includes(secret))
  assert.ok(r.stderr.length < 1000)
})

test('provider failures retain the operator detail', { timeout: 15000 }, async t => {
  const r = await runBridge(t, { errorResult: { type: 'result', is_error: true, result: 'Provider rejected the model' } })
  assert.match(r.stderr, /Provider request failed: Provider rejected the model/)
  assert.match(readFileSync(join(r.artifacts, 'events.jsonl'), 'utf8'), /scanner_failed/)
})

test('quota after a long provider diagnostic still saves a Resume checkpoint', { timeout: 15000 }, async t => {
  const r = await runBridge(t, {
    errorResult: { type: 'result', subtype: 'error_during_execution', is_error: true,
      errors: ['x'.repeat(600), 'rate_limit_error: Usage limit reached'] },
  })
  assert.equal(r.code, 1)
  assert.equal(JSON.parse(readFileSync(join(r.artifacts, 'checkpoint.json'), 'utf8')).reason, 'quota')
  assert.ok(r.stderr.length < 1000)
})

const scanRow = { category: 'sqli', severity: 'P1', file: 'fix.php', line: 1, snippet: 'query(input)',
  fix_summary: '', status: 'candidate', reason: 'unbound input', function: 'queryUser', sink: 'query(input)' }
const scanOptions = { env: { MODE: 'scan' }, semgrepReport: { results: [], errors: [] } }

test('scan checkpoints carry findings and coverage near their separate byte limits across resume', { timeout: 20000 }, async t => {
  const row = { ...scanRow, snippet: 'x'.repeat(5 * 1024 * 1024 - 1024) }
  const coveredFiles = Array.from({ length: 5900 }, (_, i) => `src/${i}/${'x'.repeat(850)}.php`)
  const coverage = JSON.stringify(coveredFiles).padEnd(5 * 1024 * 1024)
  const stopped = await runBridge(t, { ...scanOptions, scanWrites: {
    'findings.json': JSON.stringify([row]), 'scan-coverage.json': coverage,
  }, thrownError: 'usage limit reached' })
  assert.equal(stopped.code, 1, stopped.stderr)
  const bytes = readFileSync(join(stopped.artifacts, 'checkpoint.json'))
  assert.ok(bytes.length > 5 * 1024 * 1024)
  assert.ok(bytes.length <= 16 * 1024 * 1024)
  const checkpoint = JSON.parse(bytes)
  assert.deepEqual(checkpoint.scan, { findings: [row], coveredFiles })
  const resumed = await runBridge(t, { ...scanOptions, checkpoint, thrownError: 'usage limit reached' })
  assert.equal(resumed.code, 1, resumed.stderr)
  assert.deepEqual(JSON.parse(readFileSync(join(resumed.artifacts, 'checkpoint.json'), 'utf8')).scan, checkpoint.scan)
})

test('scan coverage one byte over its artifact limit is discarded', { timeout: 15000 }, async t => {
  const r = await runBridge(t, { ...scanOptions, scanWrites: {
    'findings.json': JSON.stringify([scanRow]),
    'scan-coverage.json': '["fix.php"]'.padEnd(16 * 1024 * 1024 + 1),
  }, thrownError: 'usage limit reached' })
  assert.equal(r.code, 1, r.stderr)
  const checkpoint = JSON.parse(readFileSync(join(r.artifacts, 'checkpoint.json'), 'utf8'))
  assert.deepEqual(checkpoint.scan, { findings: [scanRow], coveredFiles: [] })
})

for (const failure of [
  { errorResult: { type: 'result', subtype: 'error_during_execution', is_error: true, result: "You've hit your session limit · resets 10am (UTC)" }, reason: 'quota' },
  { thrownError: "You've hit your session limit · resets 10am (UTC)", reason: 'quota' },
]) test(`scan ${failure.reason} stops with partial findings and file coverage`, { timeout: 15000 }, async t => {
  const r = await runBridge(t, { ...scanOptions, ...failure, scanWrites: {
    'findings.json': JSON.stringify([scanRow]), 'scan-coverage.json': '["fix.php"]',
  } })
  assert.equal(r.code, 1, r.stderr)
  const checkpoint = JSON.parse(readFileSync(join(r.artifacts, 'checkpoint.json'), 'utf8'))
  assert.equal(checkpoint.reason, failure.reason)
  assert.deepEqual(checkpoint.scan, { findings: [scanRow], coveredFiles: ['fix.php'] })
  assert.match(r.stderr, /checkpoint saved, 1 findings, 1 covered files/)
  assert.ok(!r.stderr.includes('findings done'))
  assert.equal(checkpoint.bundled, false)
  const findings = JSON.parse(readFileSync(join(r.artifacts, 'findings.json'), 'utf8'))
  assert.match(findings[0].id, /^[a-f0-9]{64}$/)
  const events = readFileSync(join(r.artifacts, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
  assert.ok(events.some(e => e.kind === 'run_stopped' && e.reason === failure.reason))
  assert.ok(!events.some(e => e.kind === 'scanner_failed'))
})

test('resumed scans preserve seed findings, dedupe new rows, and retain identity across stops', { timeout: 15000 }, async t => {
  const second = { ...scanRow, file: 'other.php' }
  const checkpoint = { scan: { findings: [scanRow], coveredFiles: ['fix.php'] } }
  const first = await runBridge(t, { ...scanOptions, checkpoint, scanWrites: {
    'findings.json': JSON.stringify([second, second]), 'scan-coverage.json': '["other.php"]',
  }, errorResult: { type: 'result', subtype: 'error_during_execution', is_error: true, result: 'quota exceeded' } })
  const saved = JSON.parse(readFileSync(join(first.artifacts, 'checkpoint.json'), 'utf8'))
  assert.deepEqual(saved.scan, { findings: [scanRow, second], coveredFiles: ['fix.php', 'other.php'] })
  assert.match(first.stderr, /checkpoint saved, 2 findings, 2 covered files/)
  assert.match(first.prompts[0], /skip covered files/)
  const firstRows = JSON.parse(readFileSync(join(first.artifacts, 'findings.json'), 'utf8'))
  const next = await runBridge(t, { ...scanOptions, checkpoint: saved, scanWrites: {
    'findings.json': JSON.stringify([{ ...scanRow, id: 'forged' }]),
  } })
  assert.equal(next.code, 0, next.stderr)
  assert.deepEqual(JSON.parse(readFileSync(join(next.artifacts, 'findings.json'), 'utf8')), firstRows)
  assert.deepEqual(JSON.parse(readFileSync(join(next.artifacts, 'scan-coverage.json'), 'utf8')).coveredFiles, ['fix.php', 'other.php'])
})

test('scan quota with malformed partial findings keeps seed data and discards new coverage', { timeout: 15000 }, async t => {
  const r = await runBridge(t, { ...scanOptions,
    checkpoint: { scan: { findings: [scanRow], coveredFiles: ['fix.php'] } },
    scanWrites: { 'findings.json': '{', 'scan-coverage.json': '["other.php"]' },
    thrownError: 'usage limit reached',
  })
  const saved = JSON.parse(readFileSync(join(r.artifacts, 'checkpoint.json'), 'utf8'))
  assert.deepEqual(saved.scan, { findings: [scanRow], coveredFiles: ['fix.php'] })
})

test('scan session limit before the first write saves an empty resumable checkpoint', { timeout: 15000 }, async t => {
  const r = await runBridge(t, { ...scanOptions, errorResult: { type: 'result', is_error: true,
    errors: ["You've hit your session limit · resets 10am (UTC)"] } })
  const saved = JSON.parse(readFileSync(join(r.artifacts, 'checkpoint.json'), 'utf8'))
  assert.equal(saved.reason, 'quota')
  assert.match(r.stderr, /checkpoint saved, 0 findings, 0 covered files/)
  assert.deepEqual(saved.scan, { findings: [], coveredFiles: [] })
  assert.deepEqual(JSON.parse(readFileSync(join(r.artifacts, 'findings.json'), 'utf8')), [])
})

for (const subtype of ['error_during_execution']) test(`scan ${subtype} stops before background follow-ups restart the SDK loop`, { timeout: 15000 }, async t => {
  const r = await runBridge(t, { ...scanOptions,
    env: { MODE: 'scan', MAX_TURNS: '40', MAX_BUDGET_USD: '5', MAX_SUBAGENTS: '3' },
    checkpoint: { scan: { findings: [scanRow], coveredFiles: ['fix.php'] } },
    scanWrites: { 'findings.json': JSON.stringify([{ ...scanRow, file: 'other.php' }]), 'scan-coverage.json': '["other.php"]' },
    errorResult: { type: 'result', subtype, is_error: true, result: 'quota exceeded', num_turns: 41 },
    afterResultMessages: [
      { type: 'system', subtype: 'task_notification', status: 'completed' },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'After quota' }] } },
      { type: 'result', subtype: 'error_during_execution', is_error: true, result: 'quota exceeded', num_turns: 41,
        origin: { kind: 'task-notification', producer: 'session-task' } },
      { type: 'result', subtype: 'success', is_error: true, num_turns: 1,
        result: "You've hit your session limit" },
    ],
  })
  assert.equal(r.code, 1, r.stderr)
  assert.equal(r.requests.length, 1)
  assert.equal(r.requests[0].options.maxTurns, undefined)
  assert.equal(r.requests[0].options.maxBudgetUsd, undefined)
  const checkpoint = JSON.parse(readFileSync(join(r.artifacts, 'checkpoint.json'), 'utf8'))
  assert.equal(checkpoint.reason, 'quota')
  assert.deepEqual(checkpoint.scan, {
    findings: [scanRow, { ...scanRow, file: 'other.php' }], coveredFiles: ['fix.php', 'other.php'],
  })
  const events = readFileSync(join(r.artifacts, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
  assert.deepEqual(events.filter(e => e.kind === 'sdk_message' && e.message.type === 'result').map(e => e.message.subtype), [subtype])
  assert.equal(events.at(-1).kind, 'run_stopped')
  assert.equal(events.at(-1).reason, 'quota')
  assert.ok(!readFileSync(join(r.artifacts, 'report.md'), 'utf8').includes('After quota'))
})

test('scan quota kills SDK writers that ignore SIGTERM before saving its checkpoint', { timeout: 15000 }, async t => {
  const r = await runBridge(t, { ...scanOptions, quotaWorker: 'resistant',
    errorResult: { type: 'result', subtype: 'error_during_execution', is_error: true, result: 'quota exceeded' },
  })
  assert.equal(r.code, 1, r.stderr)
  assert.doesNotMatch(r.stderr, /main loop crashed/)
  const saved = JSON.parse(readFileSync(join(r.artifacts, 'checkpoint.json'), 'utf8'))
  const findings = readFileSync(join(r.artifacts, 'findings.json'), 'utf8')
  assert.equal(readFileSync(join(r.root, 'worker-term'), 'utf8'), 'ignored')
  assert.ok(Number(readFileSync(join(r.root, 'worker-ticks'), 'utf8')) >= 2, 'writer did not keep writing after SIGTERM')
  assert.equal(readFileSync(join(r.root, 'sdk-closed'), 'utf8'), 'closed')
  assert.deepEqual(JSON.parse(readFileSync(join(r.root, 'agent-kill'), 'utf8')), ['-9', '--', '-1'])
  assert.equal(saved.reason, 'quota')
  assert.deepEqual(JSON.parse(findings), assignFindingIds(saved.scan.findings, 'scan'))
  assert.deepEqual(JSON.parse(readFileSync(join(r.artifacts, 'scan-coverage.json'), 'utf8')).coveredFiles, saved.scan.coveredFiles)
})

test('scan quota checkpoints while a detached descendant keeps the SDK pipe open', { timeout: 15000 }, async t => {
  const r = await runBridge(t, { ...scanOptions, quotaWorker: 'pipe-holder',
    errorResult: { type: 'result', subtype: 'error_during_execution', is_error: true, result: 'quota exceeded' },
  })
  assert.equal(r.code, 1, r.stderr)
  assert.doesNotMatch(r.stderr, /main loop crashed/)
  assert.equal(existsSync(join(r.root, 'sdk-closed')), false, 'SDK pipe closed before the timeout')
  const [, holder] = JSON.parse(readFileSync(join(r.root, 'worker-pids.json'), 'utf8'))
  process.kill(holder, 0)
  const saved = JSON.parse(readFileSync(join(r.artifacts, 'checkpoint.json'), 'utf8'))
  assert.equal(saved.reason, 'quota')
  assert.deepEqual(JSON.parse(readFileSync(join(r.artifacts, 'findings.json'), 'utf8')), assignFindingIds(saved.scan.findings, 'scan'))
  assert.deepEqual(JSON.parse(readFileSync(join(r.artifacts, 'scan-coverage.json'), 'utf8')).coveredFiles, saved.scan.coveredFiles)
  assert.match(r.stderr, /checkpoint saved, 1 findings, 1 covered files/)
})

test('scan resume discards malformed seed findings and their claimed coverage', { timeout: 15000 }, async t => {
  const r = await runBridge(t, { ...scanOptions,
    checkpoint: { scan: { findings: [{ ...scanRow, file: '../outside.php' }], coveredFiles: ['other.php'] } },
    scanWrites: { 'findings.json': JSON.stringify([scanRow]) },
  })
  assert.equal(r.code, 0, r.stderr)
  assert.deepEqual(JSON.parse(readFileSync(join(r.artifacts, 'scan-coverage.json'), 'utf8')).coveredFiles, [])
  assert.equal(JSON.parse(readFileSync(join(r.artifacts, 'findings.json'), 'utf8')).length, 1)
})

for (const provider of ['claude', 'codex']) test(`scan pause waits for parallel tools and checkpoints with ${provider}`, { timeout: 15000 }, async t => {
  const r = await runBridge(t, { ...scanOptions, pause: true, env: { MODE: 'scan', PROVIDER: provider }, scanWrites: {
    'findings.json': JSON.stringify([scanRow]), 'scan-coverage.json': '["fix.php"]',
  } })
  assert.equal(r.code, 1, r.stderr)
  assert.ok(existsSync(join(r.root, 'tools-finished')), r.stderr)
  assert.equal(readFileSync(join(r.root, 'tools-finished'), 'utf8'), 'yes')
  const checkpoint = JSON.parse(readFileSync(join(r.artifacts, 'checkpoint.json'), 'utf8'))
  assert.equal(checkpoint.reason, 'pause')
  assert.deepEqual(checkpoint.scan, { findings: [scanRow], coveredFiles: ['fix.php'] })
  const events = readFileSync(join(r.artifacts, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
  assert.equal(events.at(-1).kind, 'run_stopped')
  assert.equal(events.at(-1).reason, 'pause')
  assert.ok(!events.some(e => e.kind === 'scanner_failed'))
  if (provider === 'codex') {
    assert.ok(r.elapsed < 5000, `pause took ${r.elapsed} ms`)
    assert.ok(existsSync(join(r.root, 'codex-int')))
    assert.ok(existsSync(join(r.root, 'codex-term')))
  }
  const resumed = await runBridge(t, { ...scanOptions, env: { MODE: 'scan', PROVIDER: provider }, checkpoint })
  assert.equal(resumed.code, 0, resumed.stderr)
  assert.deepEqual(JSON.parse(readFileSync(join(resumed.artifacts, 'scan-coverage.json'), 'utf8')).coveredFiles, ['fix.php'])
  assert.equal(JSON.parse(readFileSync(join(resumed.artifacts, 'findings.json'), 'utf8')).length, 1)
  if (provider === 'codex') assert.deepEqual(JSON.parse(readFileSync(join(resumed.root, 'scanned-files.json'), 'utf8')), [])
})

test('Stop during a native Codex scan leaves no checkpoint', { timeout: 15000 }, async t => {
  const r = await runBridge(t, { ...scanOptions, nativeStop: true, env: { MODE: 'scan', PROVIDER: 'codex' } })
  assert.equal(r.code, 143, r.stderr)
  assert.ok(r.elapsed < 5000, `stop took ${r.elapsed} ms`)
  assert.ok(!existsSync(join(r.artifacts, 'checkpoint.json')))
  const events = readFileSync(join(r.artifacts, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
  assert.ok(!events.some(event => event.kind === 'run_stopped'))
})

test('Stop during paused export aborts without a checkpoint', { timeout: 15000 }, async t => {
  const r = await runBridge(t, { ...scanOptions, pause: true, stopDuringExport: true, env: { MODE: 'scan' } })
  assert.equal(r.code, 143, r.stderr)
  const events = readFileSync(join(r.artifacts, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
  assert.ok(events.some(e => e.kind === 'test_export_started'))
  assert.ok(!events.some(e => e.kind === 'run_stopped'))
  assert.ok(!existsSync(join(r.artifacts, 'checkpoint.json')), 'aborted run must not be resumable')
})

for (const reviews of [[[]], [[{ blocking: false, text: 'Suggestion' }, { blocking: false, text: ' Suggestion ' }]]]) {
  test('no blocking notes skip rework and round 2', { timeout: 15000 }, async t => {
    const r = await runBridge(t, { checkpoint: progress('review'), reviews })
    assert.equal(r.code, 0, r.stderr)
    assert.deepEqual(starts(r.prompts).filter(s => s.startsWith('Review')), ['Review pass 1'])
    const batch = JSON.parse(readFileSync(join(r.artifacts, 'batch.json'), 'utf8'))
    assert.equal(batch.review_rounds, 1)
    assert.deepEqual(batch.review_non_blocking ?? [], reviews[0].length ? ['Suggestion'] : [])
  })
}

test('only blocking notes trigger rework and the second review uses the rework revision', { timeout: 15000 }, async t => {
  const r = await runBridge(t, { checkpoint: progress('review'), rework: true, reviews: [
    [{ blocking: true, text: 'Bypassable fix' }, { blocking: false, text: 'Suggestion' }],
    [{ blocking: false, text: 'Suggestion' }, { blocking: false, text: 'Other suggestion' }],
  ] })
  assert.equal(r.code, 0, r.stderr)
  assert.deepEqual(starts(r.prompts).filter(s => s.startsWith('Review')), ['Review pass 1', 'Review notes', 'Review pass 2'])
  const fix = r.prompts.find(p => p.startsWith('Review notes'))
  assert.match(fix, /Bypassable fix/)
  assert.ok(!fix.includes('Suggestion'))
  const second = r.prompts.find(p => p.startsWith('Review pass 2'))
  assert.match(second, /only the rework diff/)
  assert.match(second, /Bypassable fix/)
  const base = /git diff ([a-f0-9]{40})/.exec(second)[1]
  const diff = execFileSync('git', ['-C', r.repo, 'diff', base], { encoding: 'utf8' })
  assert.match(diff, /-after\n\+reworked/)
  assert.ok(!diff.includes('before'))
  assert.deepEqual(JSON.parse(readFileSync(join(r.artifacts, 'batch.json'), 'utf8')).review_non_blocking, ['Suggestion', 'Other suggestion'])
})

test('resume retains the pre-rework revision after rework finishes', { timeout: 15000 }, async t => {
  const first = await runBridge(t, { checkpoint: progress('review'), reviews: [['Fix bypass']], rework: true, env: { TEST_QUOTA_AFTER: '2' } })
  const checkpoint = JSON.parse(readFileSync(join(first.artifacts, 'checkpoint.json'), 'utf8'))
  assert.equal(checkpoint.progress.review[0].fixed, true)
  assert.match(checkpoint.progress.review[0].reworkBase, /^[a-f0-9]{40}$/)
  const resumed = await runBridge(t, { checkpoint, carried: { 'review-1.json': '["Fix bypass"]' }, reviews: [[], []] })
  assert.equal(resumed.code, 0, resumed.stderr)
  const second = resumed.prompts.find(p => p.startsWith('Review pass 2'))
  assert.ok(second.includes(`git diff ${checkpoint.progress.review[0].reworkBase}`))
  assert.ok(!resumed.prompts.some(p => p.startsWith('Review notes')))
})

test('failed blocking rework does not start round 2', { timeout: 15000 }, async t => {
  const r = await runBridge(t, { checkpoint: progress('review'), reviews: [['Bug']], env: { TEST_QUOTA_AFTER: '1' } })
  assert.equal(r.code, 1, r.stderr)
  assert.deepEqual(starts(r.prompts), ['Review pass 1', 'Review notes'])
  const saved = JSON.parse(readFileSync(join(r.artifacts, 'checkpoint.json'), 'utf8'))
  assert.equal(saved.progress.review[0].fixed, false)
})

for (const explicit of [false, true]) test(`Claude review uses ${explicit ? 'independent' : 'legacy'} model and effort`, { timeout: 15000 }, async t => {
  const r = await runBridge(t, { checkpoint: progress('fix'), done: [ID], reviews: [[]],
    env: explicit ? { REVIEW_MODEL: 'sonnet', REVIEW_EFFORT: 'xhigh' } : {} })
  assert.equal(r.code, 0, r.stderr)
  const review = r.requests.find(request => request.prompt.startsWith('Review pass'))
  assert.equal(review.options.model, explicit ? 'sonnet' : 'claude-haiku-5-5')
  assert.equal(review.options.effort, explicit ? 'xhigh' : 'low')
  assert.equal(review.options.thinking?.type, explicit ? 'adaptive' : undefined)
})

test('Claude Haiku review does not inherit adaptive thinking from the fixer', { timeout: 15000 }, async t => {
  const r = await runBridge(t, { checkpoint: progress('fix'), done: [ID], reviews: [[]],
    env: { MODEL: 'opus', REVIEW_MODEL: 'haiku', REVIEW_EFFORT: 'medium' } })
  assert.equal(r.code, 0, r.stderr)
  const review = r.requests.find(request => request.prompt.startsWith('Review pass'))
  assert.equal(review.options.model, 'claude-haiku-5-5')
  assert.equal(review.options.effort, 'medium')
  assert.equal(review.options.thinking, undefined)
})
