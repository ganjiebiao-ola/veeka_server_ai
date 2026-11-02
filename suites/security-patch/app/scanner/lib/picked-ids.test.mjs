import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

const source = readFileSync(new URL('../bridge.mjs', import.meta.url), 'utf8')
const start = source.indexOf('  let round1Prompt =')
const end = source.indexOf('  if (MODE === "scan")', start)
function invocation(mode, ids, categories = '', file = '', maxSubagents = 0, outputLanguagePrompt = '') {
  return runInNewContext(source.slice(start, end) + '\nround1Prompt', {
    SKILL: 'ola-security-audit', MODE: mode, CATEGORIES: categories, initialPrompt: undefined, MAX_SUBAGENTS: maxSubagents, outputLanguagePrompt,
    process: { env: { PICKED_IDS: ids, PICKED_FILE: file } },
  })
}
test('fix passes picked ids and old skill invocations stay unchanged', () => {
  const ids = 'a'.repeat(64) + ',pr12:app/api.php'
  assert.equal(invocation('fix', ids), `/ola-security-audit fix ids=${ids}`)
  assert.equal(invocation('fix', undefined), '/ola-security-audit fix')
  assert.equal(invocation('fix', ''), '/ola-security-audit fix')
  assert.equal(invocation('scan', ids), '/ola-security-audit scan')
  assert.equal(invocation('scan', ids, 'sqli'), '/ola-security-audit scan categories=sqli')
  assert.equal(invocation('scan', '', 'sqli', '', 2), '/ola-security-audit scan categories=sqli max-subagents=2')
  assert.equal(invocation('scan', '', 'sqli', '', 0, 'Write in English.'), '/ola-security-audit scan categories=sqli\nWrite in English.')
})

test('fix passes the picked rows file and keeps ids as a marker', () => {
  const file = '/workspace/artifacts/picked.json'
  assert.equal(invocation('fix', 'pr12:app/api.php', '', file),
    `/ola-security-audit fix ids=pr12:app/api.php picked-file=${file}`)
  assert.equal(invocation('scan', '', '', file), '/ola-security-audit scan')
  const skill = readFileSync(new URL('../../skill/ola-security-audit/SKILL.md', import.meta.url), 'utf8')
  assert.ok(skill.includes('picked-file=<路径>'))
  assert.ok(skill.includes('Not fixed (outside pick)'))
})

test('the audit skill leaves remote branch changes to the tool', () => {
  const skill = readFileSync(new URL('../../skill/ola-security-audit/SKILL.md', import.meta.url), 'utf8')
  const section = skill.split('### Step C.1：')[1].split('### Step D：')[0]
  assert.doesNotMatch(section, /git (?:fetch|push)|--force-with-lease/)
  assert.ok(section.includes('不扩大 picked 范围'))
  assert.ok(section.includes('不执行任何 push'))
})
