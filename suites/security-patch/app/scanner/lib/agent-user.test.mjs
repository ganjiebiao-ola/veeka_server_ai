import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { agentEnv, killAgentProcesses } from "./agent-user.mjs"

test("agent environment omits GitHub, SSH and OpenAI credentials but keeps the Anthropic key", () => {
  const env = { GH_TOKEN: "t", GITHUB_TOKEN: "t", SECPATCH_GIT_TOKEN: "t", GIT_SSH_COMMAND: "ssh -i /root/.ssh/id_ed25519",
    ANTHROPIC_AUTH_TOKEN: "k", OPENAI_API_KEY: "o", CODEX_API_KEY: "o", PATH: "/bin", HOME: "/root" }
  const out = agentEnv(env)
  for (const name of ["GH_TOKEN", "GITHUB_TOKEN", "SECPATCH_GIT_TOKEN", "GIT_SSH_COMMAND", "OPENAI_API_KEY", "CODEX_API_KEY"]) assert.equal(out[name], undefined)
  assert.equal(out.ANTHROPIC_AUTH_TOKEN, "k")
  assert.equal(out.HOME, "/home/agent")
  assert.equal(env.GH_TOKEN, "t")
})

test("killAgentProcesses repeats kill -9 -- -1 until pgrep finds no agent process, then gives up", async () => {
  const calls = []
  let alive = 2
  const spawn = (cmd, args) => {
    calls.push([cmd, ...args].join(" "))
    if (cmd === "kill") alive--
    return { status: cmd === "pgrep" ? (alive > 0 ? 0 : 1) : 0 }
  }
  await killAgentProcesses(spawn)
  assert.deepEqual(calls, ["kill -9 -- -1", "pgrep -u agent", "kill -9 -- -1", "pgrep -u agent"])
  await assert.rejects(killAgentProcesses(() => ({ status: 0 }), 3), /survived/)
})

test("killAgentProcesses stops an agent process that left the session with setsid and nohup", {
  skip: process.env.CODEX_SANDBOX_TEST !== "1", timeout: 30000,
}, () => {
  const result = spawnSync("docker", ["run", "--rm", "--entrypoint", "bash", process.env.CODEX_SANDBOX_IMAGE ?? "ola-agent-scanner:test", "-c", `
    set -eu
    setpriv --reuid=agent --regid=agent --clear-groups --no-new-privs setsid nohup sh -c 'while :; do sleep 0.1; done' >/dev/null 2>&1 &
    sleep 0.5
    pgrep -u agent >/dev/null
    bun -e 'import { killAgentProcesses } from "/opt/lib/agent-user.mjs"; await killAgentProcesses()'
    ! pgrep -u agent
  `], { encoding: "utf8", timeout: 25000 })
  assert.equal(result.status, 0, result.stderr + result.stdout)
})
