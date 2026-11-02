import { join } from "node:path"
import { tmpdir } from "node:os"
import { access, chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { test, spyOn } from "bun:test"
import { deepStrictEqual as assertEquals, rejects, throws } from "node:assert/strict"
import {
  DEFAULT_CPUS,
  DEFAULT_MEMORY_MB,
  DockerController,
  parseResourceEnv,
} from "./controller.ts";

const MEM = { min: 256, max: 65536, integer: true };
const CPU = { min: 0.01, max: 8, integer: false };

test("parseResourceEnv: unset or blank falls back to the built-in default", () => {
  assertEquals(parseResourceEnv("X", undefined, MEM), undefined);
  assertEquals(parseResourceEnv("X", "", MEM), undefined);
  assertEquals(parseResourceEnv("X", "   ", MEM), undefined);
});

test("parseResourceEnv: plain numbers are accepted", () => {
  assertEquals(parseResourceEnv("X", "1536", MEM), 1536);
  assertEquals(parseResourceEnv("X", " 4096 ", MEM), 4096);
  assertEquals(parseResourceEnv("X", "1", CPU), 1);
  assertEquals(parseResourceEnv("X", "1.5", CPU), 1.5);
});

// The whole point of the validation: a value with a unit suffix used to be
// silently truncated by parseInt ("2g" -> 2), producing `--memory 2m`, which
// docker rejects ("Minimum memory limit allowed is 6MB"). Every scan then
// failed, with the real reason visible only in the backend's stderr drain.
test("parseResourceEnv: suffixed values are rejected, not truncated", () => {
  for (const raw of ["2g", "2G", "1.5g", "1536m", "4gb", "1_000", "1e9"]) {
    assertEquals(parseResourceEnv("X", raw, MEM), undefined, `should reject ${raw}`);
  }
});

// The opposite failure, and the quieter one: docker happily accepts
// `--memory 99999999m` (~95 TB), i.e. no cap at all. A single misplaced digit
// would silently disable the very limit this knob exists to impose.
test("parseResourceEnv: out-of-range values are rejected", () => {
  assertEquals(parseResourceEnv("X", "99999999", MEM), undefined);
  assertEquals(parseResourceEnv("X", "0", MEM), undefined);
  assertEquals(parseResourceEnv("X", "255", MEM), undefined);
  assertEquals(parseResourceEnv("X", "16", CPU), undefined);
  assertEquals(parseResourceEnv("X", "256", MEM), 256, "boundary is inclusive");
});

test("parseResourceEnv: non-integer rejected where an integer is required", () => {
  assertEquals(parseResourceEnv("X", "1536.5", MEM), undefined);
  assertEquals(parseResourceEnv("X", "-512", MEM), undefined);
});

test("DockerController: no options reproduces the historical hard-coded caps", () => {
  const c = new DockerController();
  assertEquals(c.defaultCpus, DEFAULT_CPUS);
  assertEquals(c.defaultMemoryMb, DEFAULT_MEMORY_MB);
  assertEquals(c.defaultMemorySwapMb, undefined, "must not emit --memory-swap by default");
});

test("DockerController: undefined options fall through to the defaults", () => {
  const c = new DockerController({ defaultCpus: undefined, defaultMemoryMb: undefined });
  assertEquals(c.defaultCpus, DEFAULT_CPUS);
  assertEquals(c.defaultMemoryMb, DEFAULT_MEMORY_MB);
});

test("DockerController: explicit options win", () => {
  const c = new DockerController({ defaultCpus: 1, defaultMemoryMb: 1536, defaultMemorySwapMb: 1536 });
  assertEquals(c.defaultCpus, 1);
  assertEquals(c.defaultMemoryMb, 1536);
  assertEquals(c.defaultMemorySwapMb, 1536);
});

test("DockerController applies the scoped sandbox policy only when Codex runs", async () => {
  const root = await mkdtemp(join(tmpdir(), "ola-agent-"));
  const path = process.env["PATH"];
  await writeFile(`${root}/docker`, '#!/bin/sh\n[ "$GH_TOKEN" = "fixture.gh.secret" ] && [ "$ANTHROPIC_API_KEY" = "fixture.api.secret" ] && [ "$ANTHROPIC_AUTH_TOKEN" = "fixture.relay.secret" ] && [ "$REVIEW_MODEL" = "review-test-model" ] && [ "$REVIEW_EFFORT" = "xhigh" ] || exit 1\nprintf "%s\\n" "$@"\n');
  await chmod(`${root}/docker`, 0o755);
  process.env["PATH"] = `${root}:${path ?? ""}`;
  try {
    for (const [provider, mode, reviewer, scoped] of [
      ["codex", "scan", "claude", true],
      ["claude", "fix", "codex", true],
      ["claude", "scan", "codex", false],
    ] as const) {
      const handle = new DockerController().runScanner({
        runId: "sandbox-test", image: "scanner-test", artifactsHostDir: root,
        env: { GH_TOKEN: "fixture.gh.secret", ANTHROPIC_API_KEY: "fixture.api.secret", ANTHROPIC_AUTH_TOKEN: "fixture.relay.secret", RUN_ID: "sandbox-test", MODEL: "", EFFORT: "", PROVIDER: provider, MODE: mode, REVIEW_PROVIDER: reviewer, REVIEW_MODEL: "review-test-model", REVIEW_EFFORT: "xhigh" },
      });
      await handle.stdin.close();
      const [output, , status] = await Promise.all([
        new Response(handle.stdout).text(), new Response(handle.stderr).text(), handle.process.exited,
      ]);
      assertEquals(status === 0, true);
      const args = output.trim().split("\n");
      assertEquals(args.includes("REVIEW_MODEL"), true);
      assertEquals(args.includes("REVIEW_EFFORT"), true);
      for (const key of ["GH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]) assertEquals(args.includes(key), true)
      assertEquals(output.includes("fixture.gh.secret") || output.includes("fixture.api.secret") || output.includes("fixture.relay.secret"), false)
      assertEquals(args.includes("--security-opt"), scoped);
      assertEquals(args.some(arg => ["--privileged", "--cap-add", "seccomp=unconfined"].includes(arg)), false);
      if (scoped) {
        const policy = JSON.parse(await readFile(args[args.indexOf("--security-opt") + 1].slice("seccomp=".length), "utf8"));
        assertEquals(policy.defaultAction, "SCMP_ACT_ERRNO");
        assertEquals(policy.syscalls.slice(-3).map((rule: { names: string[] }) => rule.names), [
          ["clone"], ["unshare"], ["mount", "umount2", "pivot_root"],
        ]);
      }
    }
  } finally {
    if (path === undefined) delete process.env["PATH"];
    else process.env["PATH"] = path;
    await rm(root, { recursive: true });
  }
});

test("DockerController mounts related repos read-only", async () => {
  const root = await mkdtemp(join(tmpdir(), "ola-agent-"));
  const path = process.env["PATH"];
  await writeFile(`${root}/docker`, '#!/bin/sh\nprintf "%s\\n" "$@"\n');
  await chmod(`${root}/docker`, 0o755);
  process.env["PATH"] = `${root}:${path ?? ""}`;
  try {
    const handle = new DockerController().runScanner({
      runId: "related-test", image: "scanner-test", artifactsHostDir: root, relatedHostDirs: [{ id: "client-app", dir: "/host/repos/client-app" }],
      env: { RUN_ID: "related-test", MODEL: "", EFFORT: "", PROVIDER: "claude", MODE: "fix", REVIEW_PROVIDER: "claude" },
    });
    await handle.stdin.close();
    const [output] = await Promise.all([new Response(handle.stdout).text(), new Response(handle.stderr).text(), handle.process.exited]);
    assertEquals(output.trim().split("\n").includes("/host/repos/client-app:/workspace/related/client-app:ro"), true);
  } finally {
    if (path === undefined) delete process.env["PATH"];
    else process.env["PATH"] = path;
    await rm(root, { recursive: true });
  }
});

test("DockerController forwards scanner input before closing it and waits for exit", async () => {
  const root = await mkdtemp(join(tmpdir(), "ola-agent-"))
  const path = process.env.PATH
  await writeFile(`${root}/docker`, '#!/bin/sh\nwhile IFS= read -r line; do printf "%s\\n" "$line"; done\n')
  await chmod(`${root}/docker`, 0o755)
  process.env.PATH = `${root}:${path ?? ""}`
  try {
    const handle = new DockerController().runScanner({
      runId: "stdin-test", image: "scanner-test", artifactsHostDir: root,
      env: { RUN_ID: "stdin-test", MODEL: "", EFFORT: "", MODE: "scan" },
    })
    const reader = handle.stdout.getReader()
    const line = '{"type":"push","branch":"security/test"}\n'
    await handle.stdin.write(new TextEncoder().encode(line))
    assertEquals(new TextDecoder().decode((await reader.read()).value), line)
    await handle.stdin.close()
    assertEquals((await reader.read()).done, true)
    assertEquals(await handle.process.exited, 0)
  } finally {
    if (path === undefined) delete process.env.PATH
    else process.env.PATH = path
    await rm(root, { recursive: true })
  }
})

test("DockerController keeps GH_TOKEN out of docker argv and mounts no SSH key", async () => {
  const root = await mkdtemp(join(tmpdir(), "ola-agent-"))
  const path = process.env.PATH
  await writeFile(`${root}/docker`, '#!/bin/sh\nprintf "%s\\n" "$@"\n')
  await chmod(`${root}/docker`, 0o755)
  process.env.PATH = `${root}:${path ?? ""}`
  try {
    const handle = new DockerController().runScanner({
      runId: "auth-test", image: "scanner-test", artifactsHostDir: root,
      env: { RUN_ID: "auth-test", MODEL: "", EFFORT: "", MODE: "scan", GH_TOKEN: "fixture.token" },
    })
    await handle.stdin.close()
    const [output] = await Promise.all([new Response(handle.stdout).text(), new Response(handle.stderr).text(), handle.process.exited])
    assertEquals(output.includes(".ssh"), false)
    assertEquals(output.includes("fixture.token"), false)
  } finally {
    if (path === undefined) delete process.env.PATH; else process.env.PATH = path
    await rm(root, { recursive: true })
  }
})

test("DockerController mounts the Antigravity login only when a host path is given", async () => {
  const root = await mkdtemp(join(tmpdir(), "ola-agent-"))
  const path = process.env.PATH
  await writeFile(`${root}/docker`, '#!/bin/sh\nprintf "%s\\n" "$@"\n')
  await chmod(`${root}/docker`, 0o755)
  process.env.PATH = `${root}:${path ?? ""}`
  try {
    for (const antigravityAuthHostPath of ["/host/agy/antigravity-oauth-token", undefined]) {
      const handle = new DockerController().runScanner({
        runId: "agy-test", image: "scanner-test", artifactsHostDir: root, antigravityAuthHostPath,
        env: { RUN_ID: "agy-test", MODEL: "", EFFORT: "", MODE: "scan" },
      })
      await handle.stdin.close()
      const [output] = await Promise.all([new Response(handle.stdout).text(), new Response(handle.stderr).text(), handle.process.exited])
      const mount = "/host/agy/antigravity-oauth-token:/root/.gemini/antigravity-cli/antigravity-oauth-token"
      assertEquals(output.trim().split("\n").includes(mount), antigravityAuthHostPath !== undefined)
      assertEquals(output.includes("antigravity-cli"), antigravityAuthHostPath !== undefined)
    }
  } finally {
    if (path === undefined) delete process.env.PATH; else process.env.PATH = path
    await rm(root, { recursive: true })
  }
})

test("run-info.json records the run setup and drops secret values", async () => {
  const root = await mkdtemp(join(tmpdir(), "ola-agent-"))
  const path = process.env.PATH
  await writeFile(`${root}/docker`, "#!/bin/sh\nexit 0\n")
  await chmod(`${root}/docker`, 0o755)
  process.env.PATH = `${root}:${path ?? ""}`
  // Built at runtime so the repo secret scan never sees a token-shaped literal.
  const secret = ["ab", "cd"].join("").repeat(8)
  try {
    const handle = new DockerController({ defaultCpus: 3 }).runScanner({
      runId: "info-test", image: "scanner-test", artifactsHostDir: root,
      env: { RUN_ID: "info-test", MODEL: "opus", EFFORT: "high", MODE: "scan", GH_TOKEN: secret, OPENAI_API_KEY: secret.toUpperCase(), MAX_SUBAGENTS: "3" },
    })
    await handle.process.exited
    const text = await readFile(`${root}/run-info.json`, "utf8")
    assertEquals(text.includes(secret), false)
    assertEquals(text.includes(secret.toUpperCase()), false)
    const info = JSON.parse(text)
    assertEquals(info.image, "scanner-test")
    assertEquals(info.resources, { cpus: 3, memoryMb: DEFAULT_MEMORY_MB })
    assertEquals(info.env.GH_TOKEN, "<set>")
    assertEquals(info.env.OPENAI_API_KEY, "<set>")
    assertEquals(info.env.MAX_SUBAGENTS, "3")
    assertEquals(info.mounts.credentials, false)
  } finally {
    if (path === undefined) delete process.env.PATH
    else process.env.PATH = path
    await rm(root, { recursive: true })
  }
})

test("orphan sweep reports run labels only for running containers", async () => {
  const root = await mkdtemp(join(tmpdir(), "ola-agent-"))
  const path = process.env.PATH
  await writeFile(`${root}/docker`, `#!/bin/sh
[ "$1" = ps ] || exit 1
printf '%s\\n' 'live running pending' 'old exited completed' 'unlabeled running'
`)
  await chmod(`${root}/docker`, 0o755)
  process.env.PATH = `${root}:${path ?? ""}`
  try {
    const controller = new DockerController()
    const removed: string[] = []
    controller.stopAndRemove = async id => { removed.push(id) }
    assertEquals(await controller.sweepOrphans(), [
      { id: "live", runId: "pending" }, { id: "old", runId: "" }, { id: "unlabeled", runId: "" },
    ])
    assertEquals(removed, ["live", "old", "unlabeled"])
  } finally {
    if (path === undefined) delete process.env.PATH
    else process.env.PATH = path
    await rm(root, { recursive: true })
  }
})

test("DockerController rejects mount traversal and ambiguous host paths before launching", async () => {
  const root = await mkdtemp(join(tmpdir(), "ola-agent-"))
  const path = process.env.PATH
  await writeFile(`${root}/docker`, "#!/bin/sh\nexit 0\n")
  await chmod(`${root}/docker`, 0o755)
  process.env.PATH = `${root}:${path ?? ""}`
  const args = {
    runId: "mount-test", image: "scanner-test", artifactsHostDir: root,
    env: { RUN_ID: "mount-test", MODEL: "", EFFORT: "", MODE: "scan" },
  }
  try {
    const controller = new DockerController()
    for (const id of ["..", ".", "../repo", "../../root/.ssh", "repo:rw", "repo/child", "repo\\child", "bad\0id"]) {
      throws(() => controller.runScanner({ ...args, relatedHostDirs: [{ id, dir: root }] }), /invalid related repo id/)
    }
    for (const dir of ["named-volume", "../outside", "/host/repo:ro", "/host/repo\0"]) {
      for (const field of ["artifactsHostDir", "workspaceHostDir", "credentialsHostPath", "codexAuthHostPath", "antigravityAuthHostPath", "qoderAuthHostPath"]) {
        throws(() => controller.runScanner({ ...args, [field]: dir }), /invalid bind mount path/)
      }
      throws(() => controller.runScanner({ ...args, relatedHostDirs: [{ id: "repo", dir }] }), /invalid bind mount path/)
    }
  } finally {
    if (path === undefined) delete process.env.PATH
    else process.env.PATH = path
    await rm(root, { recursive: true })
  }
})

test("DockerController cleans up only the container created by a failed Docker client", async () => {
  const root = await mkdtemp(join(tmpdir(), "ola-agent-"))
  const path = process.env.PATH
  const id = "a".repeat(64)
  await writeFile(`${root}/docker`, `#!/bin/sh
[ "$1" = run ] || exit 0
while [ "$#" -gt 0 ]; do
  if [ "$1" = --cidfile ]; then
    shift
    if [ "$RUN_ID" = created ]; then printf '%s' '${id}' > "$1"; fi
    printf '%s' "$1"
  fi
  shift
done
exit 125
`)
  await chmod(`${root}/docker`, 0o755)
  process.env.PATH = `${root}:${path ?? ""}`
  try {
    const controller = new DockerController()
    const removed: string[] = []
    controller.stopAndRemove = async container => { removed.push(container) }
    for (const runId of ["created", "name-conflict"]) {
      const handle = controller.runScanner({
        runId, image: "scanner-test", artifactsHostDir: root,
        env: { RUN_ID: runId, MODEL: "", EFFORT: "", MODE: "scan" },
      })
      const [cidPath, , code] = await Promise.all([
        new Response(handle.stdout).text(), new Response(handle.stderr).text(), handle.process.exited,
      ])
      assertEquals(code, 125)
      assertEquals(removed, [id])
      assertEquals(await Bun.file(cidPath).exists(), false)
      await handle.stdin.close()
    }
  } finally {
    if (path === undefined) delete process.env.PATH
    else process.env.PATH = path
    await rm(root, { recursive: true })
  }
})

test("DockerController removes its CID directory when spawning Docker throws", async () => {
  const root = await mkdtemp(join(tmpdir(), "ola-agent-"))
  const spawn = spyOn(Bun, "spawn")
  let cidPath = ""
  spawn.mockImplementation((cmd: string[] | { cmd: string[] }) => {
    const argv = Array.isArray(cmd) ? cmd : cmd.cmd
    cidPath = argv[argv.indexOf("--cidfile") + 1]
    throw new Error("fixture spawn failure")
  })
  try {
    throws(() => new DockerController().runScanner({
      runId: "spawn-test", image: "scanner-test", artifactsHostDir: root,
      env: { RUN_ID: "spawn-test", MODEL: "", EFFORT: "", MODE: "scan" },
    }), /fixture spawn failure/)
    assertEquals(Boolean(cidPath), true)
    await rejects(access(join(cidPath, "..")), { code: "ENOENT" })
  } finally {
    spawn.mockRestore()
    await rm(root, { recursive: true })
  }
})

test("DockerController mounts the Qoder login only when a host path is given", async () => {
  const root = await mkdtemp(join(tmpdir(), "ola-agent-"))
  const path = process.env.PATH
  await writeFile(`${root}/docker`, '#!/bin/sh\nprintf "%s\\n" "$@"\n')
  await chmod(`${root}/docker`, 0o755)
  process.env.PATH = `${root}:${path ?? ""}`
  try {
    for (const qoderAuthHostPath of ["/host/qoder/.auth", undefined]) {
      const handle = new DockerController().runScanner({
        runId: "qoder-test", image: "scanner-test", artifactsHostDir: root, qoderAuthHostPath,
        env: { RUN_ID: "qoder-test", MODEL: "", EFFORT: "", MODE: "scan" },
      })
      await handle.stdin.close()
      const [output] = await Promise.all([new Response(handle.stdout).text(), new Response(handle.stderr).text(), handle.process.exited])
      const mount = "/host/qoder/.auth:/root/.qoder/.auth"
      assertEquals(output.trim().split("\n").includes(mount), qoderAuthHostPath !== undefined)
      assertEquals(output.includes("/root/.qoder/.auth"), qoderAuthHostPath !== undefined)
    }
  } finally {
    if (path === undefined) delete process.env.PATH; else process.env.PATH = path
    await rm(root, { recursive: true })
  }
})
