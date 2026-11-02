import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'suite start '))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  for (const dir of ['scripts', 'backend', 'frontend', '.runtime', 'bin']) mkdirSync(join(root, dir))
  writeFileSync(join(root, '.runtime/frontend.pid'), 'fixture\n')
  writeFileSync(join(root, 'frontend/package.json'), '{}\n')
  writeFileSync(join(root, 'frontend/bun.lock'), '{}\n')
  writeFileSync(join(root, '.runtime/frontend.deps'), createHash('sha256').update('{}\n{}\n').digest('hex') + '\n')
  copyFileSync(new URL('./dev.sh', import.meta.url), join(root, 'scripts/dev.sh'))
  const bin = (name, body) => {
    const path = join(root, 'bin', name)
    writeFileSync(path, `#!/bin/sh\n${body}\n`)
    chmodSync(path, 0o755)
  }
  bin('bun', `case "$1" in
    install) exit 0 ;;
    run) printf "%s\\n" "\${OLA_DEV-unset}" > "$TEST_ROOT/$2-dev"
         printf "%s\\n" "\${OLA_AGENT_RELAY_MODEL-unset}" > "$TEST_ROOT/$2-env.tmp"
         echo started
         mv "$TEST_ROOT/$2-env.tmp" "$TEST_ROOT/$2-env" ;;
    *) exec "${process.execPath}" "$@" ;;
  esac`)
  bin('curl', 'if [ -f "$TEST_ROOT/active.json" ]; then cat "$TEST_ROOT/active.json"; else printf "%s" "$TEST_ACTIVE"; fi\nexit "${TEST_CURL_EXIT:-0}"')
  const start = (options = {}) => {
    const script = `
      . "$TEST_ROOT/scripts/dev.sh" help >/dev/null
      cmd_check() { echo check >> "$TEST_ROOT/actions"; }
      cmd_build_scanner() {
        echo build >> "$TEST_ROOT/actions"
        if [ -n "$TEST_AFTER_BUILD" ]; then printf '%s' "$TEST_AFTER_BUILD" > "$TEST_ROOT/active.json"; fi
      }
      cmd_compose_export_creds() { echo credentials >> "$TEST_ROOT/actions"; }
      cmd_export_settings_env() { export ANTHROPIC_MODEL="$TEST_MODEL"; }
      port_alive() { [ "$TEST_OCCUPIED" = "$1" ]; }
      kill() { [ "$TEST_PID_ALIVE" = 1 ]; }
      is_running() {
        if [ "$1" = frontend ]; then [ "$TEST_FRONTEND_RUNNING" = 1 ]; else [ -f "$TEST_ROOT/backend.running" ]; fi
      }
      stop_server() {
        echo stop >> "$TEST_ROOT/actions"
        rm -f "$TEST_ROOT/backend.running" "$TEST_ROOT/start-env"
      }
      wait_for() {
        local attempts=0
        local marker="$TEST_ROOT/start-env"
        [[ "$1" != *32088* ]] || marker="$TEST_ROOT/dev-env"
        while [ ! -f "$marker" ] && [ "$attempts" -lt 1000 ]; do
          sleep 0.01
          attempts=$((attempts + 1))
        done
        [ -f "$marker" ] || return 1
        touch "$TEST_ROOT/backend.running"
      }
      cmd_start
    `
    return execFileSync('bash', ['-c', script], {
      env: { ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH}`, TEST_ROOT: root,
        OLA_AGENT_AUTH_MODE: options.mode ?? 'oauth', DEV_MODE: options.dev ?? '0', TEST_MODEL: options.model ?? 'first',
        TEST_ACTIVE: options.active ?? '{"runs":[]}', TEST_CURL_EXIT: options.curlExit ?? '0',
        TEST_AFTER_BUILD: options.afterBuild ?? '', TEST_OCCUPIED: options.occupied ?? '',
        TEST_PID_ALIVE: options.pidAlive ?? '1', TEST_FRONTEND_RUNNING: options.frontendRunning ?? '1' },
      encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'],
    })
  }
  const actions = () => existsSync(join(root, 'actions')) ? readFileSync(join(root, 'actions'), 'utf8').trim().split('\n') : []
  const env = (value) => writeFileSync(join(root, '.env'), value)
  return { root, start, actions, env }
}

test('settings auth logs omit credentials in the relay URL', t => {
  const f = fixture(t)
  const output = execFileSync('bash', ['-c', `
    . "$TEST_ROOT/scripts/dev.sh" help >/dev/null
    SETTINGS_JSON="$TEST_ROOT/settings.json"
    touch "$SETTINGS_JSON"
    jq() { printf '%s\\n' 'ANTHROPIC_AUTH_TOKEN=fixture-token' 'ANTHROPIC_BASE_URL=https://user:fixture-password@relay.example/v1/fixture-path?key=fixture-key'; }
    cmd_export_settings_env
    [ "$ANTHROPIC_AUTH_TOKEN" = fixture-token ]
    [ "$OLA_AGENT_AUTH_MODE" = settings ]
  `], { env: { ...process.env, TEST_ROOT: f.root }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  assert.match(output, /exported 2 ANTHROPIC_\* var\(s\)/)
  assert.doesNotMatch(output, /fixture-token|fixture-password|fixture-path|fixture-key|relay\.example/)
})

test('unchanged start keeps both servers and skips builds and credential export', { timeout: 30000 }, (t) => {
  const f = fixture(t)
  f.env('OLA_AGENT_RELAY_MODEL=owner/first\n')
  f.start()
  const before = f.actions()
  const config = readFileSync(join(f.root, '.runtime/backend.config'), 'utf8')
  assert.match(config, /^[a-f0-9]{64}\n$/)
  assert.match(f.start(), /already running with current settings/)
  f.env('# comment changed\nOLA_AGENT_RELAY_MODEL=owner/first\n')
  f.start()
  assert.deepEqual(f.actions(), before)
  assert.equal(readFileSync(join(f.root, 'start-env'), 'utf8').trim(), 'owner/first')
})

test('changed and removed dotenv settings reload only the backend', { timeout: 30000 }, (t) => {
  const f = fixture(t)
  f.env('OLA_AGENT_RELAY_MODEL=owner/first\n')
  f.start()
  f.env('OLA_AGENT_RELAY_MODEL=owner/second\n')
  assert.match(f.start(), /settings changed; restarting backend/)
  assert.equal(readFileSync(join(f.root, 'start-env'), 'utf8').trim(), 'owner/second')
  rmSync(join(f.root, '.env'))
  f.start()
  assert.equal(readFileSync(join(f.root, 'start-env'), 'utf8').trim(), 'unset')
  assert.equal(f.actions().filter(action => action === 'stop').length, 2)
})

test('provider settings and auth mode changes reload the backend', { timeout: 30000 }, (t) => {
  const f = fixture(t)
  f.start({ mode: 'settings', model: 'first' })
  f.start({ mode: 'settings', model: 'second' })
  f.start({ mode: 'oauth' })
  assert.equal(f.actions().filter(action => action === 'stop').length, 2)
  assert.equal(f.actions().filter(action => action === 'credentials').length, 1)
})

test('scanner source changes rebuild the scanner while repeated starts keep it', { timeout: 30000 }, (t) => {
  const f = fixture(t)
  mkdirSync(join(f.root, 'scanner'))
  writeFileSync(join(f.root, 'scanner/bridge.mjs'), '// first\n')
  f.start()
  writeFileSync(join(f.root, 'scanner/bridge.mjs'), '// second\n')
  f.start()
  f.start()
  assert.equal(f.actions().filter(action => action === 'build').length, 2)
  assert.equal(f.actions().filter(action => action === 'stop').length, 1)
})

test('backend lockfile and schema changes reload the backend once each', { timeout: 30000 }, t => {
  const f = fixture(t)
  mkdirSync(join(f.root, 'backend/store'))
  const paths = ['backend/bun.lock', 'backend/store/schema.sql']
  for (const path of paths) writeFileSync(join(f.root, path), 'first\n')
  f.start()
  for (const [index, path] of paths.entries()) {
    writeFileSync(join(f.root, path), 'second\n')
    assert.match(f.start(), /settings changed; restarting backend/)
    assert.match(f.start(), /already running with current settings/)
    assert.equal(f.actions().filter(action => action === 'stop').length, index + 1)
  }
})

test('changed settings do not interrupt active scans or restart when status is unknown', { timeout: 30000 }, (t) => {
  const f = fixture(t)
  f.env('OLA_AGENT_RELAY_MODEL=owner/first\n')
  f.start()
  const before = f.actions()
  const config = readFileSync(join(f.root, '.runtime/backend.config'), 'utf8')
  f.env('OLA_AGENT_RELAY_MODEL=owner/second\n')
  for (const options of [{ active: '{"runs":[{}]}' }, { active: '{}' }, { active: 'bad json' }, { curlExit: '1' }]) {
    assert.throws(() => f.start(options), /runs are active or their status is unavailable/)
    assert.deepEqual(f.actions(), before)
    assert.equal(readFileSync(join(f.root, '.runtime/backend.config'), 'utf8'), config)
  }
})

test('a backend without a settings record reloads once', { timeout: 30000 }, (t) => {
  const f = fixture(t)
  writeFileSync(join(f.root, 'backend.running'), '')
  f.start()
  f.start()
  assert.equal(f.actions().filter(action => action === 'stop').length, 1)
})

test('a scan started during the build blocks the backend restart', { timeout: 30000 }, (t) => {
  const f = fixture(t)
  f.env('OLA_AGENT_RELAY_MODEL=owner/first\n')
  f.start()
  const config = readFileSync(join(f.root, '.runtime/backend.config'), 'utf8')
  f.env('OLA_AGENT_RELAY_MODEL=owner/second\n')
  assert.throws(() => f.start({ afterBuild: '{"runs":[{}]}' }), /runs are active/)
  assert.equal(f.actions().filter(action => action === 'stop').length, 0)
  assert.equal(readFileSync(join(f.root, '.runtime/backend.config'), 'utf8'), config)
})

test('stop checks a backend port without a pid file and force bypasses the guard', { timeout: 30000 }, (t) => {
  const f = fixture(t)
  const stop = (active, port, force = '') => execFileSync('bash', ['-c', `
    . "$TEST_ROOT/scripts/dev.sh" help >/dev/null
    port_alive() { [ "$TEST_PORT" = up ]; }
    stop_server() { echo stop >> "$TEST_ROOT/actions"; }
    cmd_clean() { echo clean >> "$TEST_ROOT/actions"; }
    remove_creds() { :; }
    cmd_stop $TEST_FORCE
  `], {
    env: { ...process.env, PATH: `${join(f.root, 'bin')}:${process.env.PATH}`, TEST_ROOT: f.root,
      TEST_ACTIVE: active, TEST_PORT: port, TEST_FORCE: force },
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  })
  for (const active of ['{"runs":[{}]}', '{}', 'bad json']) {
    assert.throws(() => stop(active, 'up'), /runs are active or their status is unavailable/)
    assert.deepEqual(f.actions(), [])
  }
  stop('{"runs":[]}', 'up')
  stop('{"runs":[{}]}', 'up', '--force')
  stop('bad json', 'down')
  assert.equal(f.actions().filter(action => action === 'clean').length, 3)
})


test('start refuses occupied ports before builds and names the port', { timeout: 30000 }, t => {
  for (const port of ['37018', '32088']) {
    const f = fixture(t)
    assert.throws(() => f.start({ occupied: port, frontendRunning: '0' }), new RegExp(`port ${port} is in use`))
    assert.deepEqual(f.actions(), [])
  }
})

test('start requires its backend and frontend pid to survive readiness', { timeout: 30000 }, t => {
  const backend = fixture(t)
  assert.throws(() => backend.start({ pidAlive: '0' }), /backend failed to start/)
  assert.ok(!existsSync(join(backend.root, '.runtime/backend.config')))
  const frontend = fixture(t)
  frontend.start()
  assert.throws(() => frontend.start({ frontendRunning: '0', pidAlive: '0' }), /frontend failed to start/)
})

test('start appends logs and prints suite commands', { timeout: 30000 }, t => {
  const f = fixture(t)
  writeFileSync(join(f.root, '.runtime/backend.log'), 'previous backend log\n')
  writeFileSync(join(f.root, '.runtime/frontend.log'), 'previous frontend log\n')
  const output = f.start({ frontendRunning: '0' })
  for (const label of ['backend', 'frontend']) {
    const log = readFileSync(join(f.root, `.runtime/${label}.log`), 'utf8')
    assert.match(log, new RegExp(`^previous ${label} log\\nstarted`))
  }
  assert.match(output, /suites\/security-patch\/run logs/)
  assert.match(output, /suites\/security-patch\/run stop/)
})

test('logs exits after 200 lines by default and follows only with --follow', { timeout: 30000 }, t => {
  const f = fixture(t)
  const log = join(f.root, '.runtime/backend.log')
  writeFileSync(log, Array.from({ length: 220 }, (_, i) => `line ${i + 1}\n`).join(''))
  const run = (...args) => execFileSync('bash', [join(f.root, 'scripts/dev.sh'), 'logs', ...args], {
    env: { ...process.env, PATH: `${join(f.root, 'bin')}:${process.env.PATH}` },
    encoding: 'utf8', timeout: 15000,
  })
  assert.equal(run(), Array.from({ length: 200 }, (_, i) => `line ${i + 21}\n`).join(''))
  writeFileSync(join(f.root, 'bin/tail'), '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o755 })
  assert.equal(run('--follow'), `-n\n200\n-f\n${log}\n`)
})

test('frontend dependency changes restart the UI once', { timeout: 30000 }, (t) => {
  const f = fixture(t)
  assert.match(f.start(), /frontend already running with current dependencies/)
  writeFileSync(join(f.root, 'frontend/bun.lock'), 'second\n')
  assert.match(f.start(), /frontend dependencies changed; restarting frontend/)
  assert.equal(readFileSync(join(f.root, '.runtime/frontend.deps'), 'utf8').trim(), createHash('sha256').update('{}\nsecond\n').digest('hex'))
  assert.match(f.start(), /frontend already running with current dependencies/)
})

test('developer mode reaches the backend and switching to normal start reloads its settings', { timeout: 30000 }, t => {
  const f = fixture(t)
  f.start({ dev: '1' })
  assert.equal(readFileSync(join(f.root, 'start-dev'), 'utf8').trim(), '1')
  const devConfig = readFileSync(join(f.root, '.runtime/backend.config'), 'utf8')
  f.start()
  assert.equal(readFileSync(join(f.root, 'start-dev'), 'utf8').trim(), '0')
  assert.notEqual(readFileSync(join(f.root, '.runtime/backend.config'), 'utf8'), devConfig)
})
