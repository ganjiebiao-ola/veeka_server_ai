import { expect, test } from "bun:test"
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

for (const settings of [
  { dotenv: 'OLA_AGENT_TRACKER_REPO="fixture/custom-tracker"\nOLA_AGENT_GH_TOKEN="fixture.env-alias"\n', gh: "", alias: "", repo: "fixture/custom-tracker", token: "fixture.env-alias" },
  { dotenv: "", gh: "fixture.shell-token", alias: "fixture.shell-alias", repo: "fixture/shell-tracker", token: "fixture.shell-token" },
  { dotenv: "", gh: "", alias: "fixture.shell-alias", repo: "fixture/shell-tracker", token: "fixture.shell-alias" },
  { dotenv: "", gh: "  ", alias: " fixture.shell-alias ", repo: "fixture/shell-tracker", token: "fixture.shell-alias" },
  { dotenv: "", gh: "", alias: "", repo: "olaola-chat/security-patch-tracker", token: "" },
]) {
  test(`run doctor uses backend tracker settings: ${settings.token || "gh login"}`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "secpatch-doctor-"))
    try {
      await mkdir(join(dir, "app"))
      await mkdir(join(dir, "lib"))
      await copyFile(new URL("../../../run", import.meta.url), join(dir, "run"))
      await writeFile(join(dir, "app/.env"), settings.dotenv)
      await writeFile(join(dir, "lib/secpatch.py"), "def main(args): return 0\n")
      await writeFile(join(dir, "gh"), '#!/bin/sh\nprintf "%s\\n" "$GH_TOKEN" "$*" > "$CAPTURE"\nprintf true\n')
      await chmod(join(dir, "gh"), 0o755)
      const result = Bun.spawnSync(["sh", join(dir, "run"), "doctor"], {
        cwd: dir, env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, GH_TOKEN: settings.gh,
          OLA_AGENT_GH_TOKEN: settings.alias, OLA_AGENT_TRACKER_REPO: settings.dotenv ? "fixture/ignored" : settings.repo,
          CAPTURE: join(dir, "capture"), PYTHONDONTWRITEBYTECODE: "1" },
      })
      expect(result.exitCode).toBe(0)
      const [token, args] = (await readFile(join(dir, "capture"), "utf8")).split("\n")
      expect(token).toBe(settings.token)
      expect(args).toBe(`api repos/${settings.repo} --jq .permissions.push`)
      expect(result.stdout.toString()).toBe("[OK] tracker repository push access\n")
      expect(result.stderr.toString()).toBe("")
    } finally { await rm(dir, { recursive: true, force: true }) }
  })
}
