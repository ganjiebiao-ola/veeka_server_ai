import fs from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path"
import { agentEnv, agentSpawnSync } from "./agent-user.mjs"

const MAX_BYTES = 64 * 1024 * 1024

// Import only trusted scanner modules. All path traversal happens after setpriv.
export function runAsAgent(modulePath, exportName, args, spawn = agentSpawnSync) {
  const result = spawn(process.execPath, ["--input-type=module", "-e", `
    import fs from "node:fs"
    const [modulePath, exportName, args] = JSON.parse(fs.readFileSync(0, "utf8"))
    try {
      const module = await import(modulePath)
      process.stdout.write(JSON.stringify(await module[exportName](...args)))
    } catch (error) {
      process.stderr.write(JSON.stringify({ message: error.message, code: error.code }))
      process.exit(1)
    }
  `], {
    input: JSON.stringify([String(modulePath), exportName, args]),
    env: agentEnv({ PATH: process.env.PATH }), maxBuffer: MAX_BYTES, timeout: 600000, killSignal: "SIGKILL",
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    let error
    try { error = JSON.parse(result.stderr.toString()) } catch { error = { message: "Agent analysis failed" } }
    throw Object.assign(new Error(error.message), { code: error.code })
  }
  return JSON.parse(result.stdout.toString())
}

export function checkedPath(path, roots, write = false) {
  if (typeof path !== "string" || !isAbsolute(path)) throw new Error("ACP file paths must be absolute")
  if (process.getuid?.() === 0) return runAsAgent(import.meta.url, "checkedPath", [path, roots, write])
  const target = resolve(path)
  const actual = write && !fs.lstatSync(target, { throwIfNoEntry: false })
    ? resolve(fs.realpathSync(dirname(target)), basename(target)) : fs.realpathSync(target)
  if (!roots.some(root => {
    try {
      const rel = relative(fs.realpathSync(root), actual)
      return rel !== ".." && !rel.startsWith("../") && !rel.startsWith("/")
    } catch { return false }
  })) throw new Error("ACP file access outside the workspace is denied")
  return actual
}

// Only direct children of the fixed, root-owned artifacts directory use this API.
export function openArtifact(path, append = false) {
  const { O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW, O_NONBLOCK, O_APPEND } = fs.constants
  const flags = O_WRONLY | O_NOFOLLOW | O_NONBLOCK | (append ? O_APPEND : 0)
  let fd
  try { fd = fs.openSync(path, flags | O_CREAT | O_EXCL, 0o644) }
  catch (error) {
    if (error.code !== "EEXIST") throw error
    fd = fs.openSync(path, flags)
  }
  try {
    const stat = fs.fstatSync(fd)
    // Root requires uid 0. Dev hosts use their own uid.
    if (!stat.isFile() || stat.uid !== process.getuid() || stat.nlink !== 1) throw new Error("Unsafe artifact file")
    if (!append) fs.ftruncateSync(fd, 0)
    return fd
  } catch (error) { fs.closeSync(fd); throw error }
}

export function writeArtifact(path, data, append = false) {
  const fd = openArtifact(path, append)
  try { fs.writeFileSync(fd, data) }
  finally { fs.closeSync(fd) }
}
// Only the agent opens untrusted paths. A component swap cannot grant root's access.
function fileOperation(fs, method, args, maxBytes, input) {
  const { O_RDONLY, O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW, O_NONBLOCK } = fs.constants
  if (!["readFileSync", "writeFileSync"].includes(method)) return fs[method](...args)
  const read = method === "readFileSync"
  if (!read) {
    if (input.length > maxBytes) throw new Error("file too large")
    let mode = 0o644
    try {
      const old = fs.openSync(args[0], O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
      try {
        const stat = fs.fstatSync(old)
        if (!stat.isFile()) throw new Error("not a regular file")
        mode = stat.mode & 0o777
      } finally { fs.closeSync(old) }
    } catch (error) { if (error.code !== "ENOENT") throw error }
    // An interrupted write must leave the old file or the new one, never a partial file.
    const temp = `${args[0]}.${process.pid}.${Date.now()}.tmp`
    const fd = fs.openSync(temp, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, mode)
    try {
      let written = 0
      while (written < input.length) written += fs.writeSync(fd, input, written, input.length - written, written)
      fs.closeSync(fd)
      fs.renameSync(temp, args[0])
    } catch (error) {
      try { fs.closeSync(fd) } catch {}
      fs.rmSync(temp, { force: true })
      throw error
    }
    return
  }
  const fd = fs.openSync(args[0], O_RDONLY | O_NOFOLLOW | O_NONBLOCK, 0o644)
  try {
    const stat = fs.fstatSync(fd)
    if (!stat.isFile()) throw new Error("not a regular file")
    if (stat.size > maxBytes) throw new Error("file too large")
    const chunks = []
    let length = 0
    while (length <= maxBytes) {
      const bytes = Buffer.alloc(Math.min(65536, maxBytes + 1 - length))
      const count = fs.readSync(fd, bytes, 0, bytes.length, null)
      if (!count) return Buffer.concat(chunks, length)
      length += count
      chunks.push(bytes.subarray(0, count))
    }
    throw new Error("file too large")
  } finally { fs.closeSync(fd) }
}

function call(method, args, input, maxBytes = MAX_BYTES) {
  let value
  if (process.getuid?.() !== 0) value = fileOperation(fs, method, args, maxBytes, input)
  else {
    const result = agentSpawnSync(process.execPath, ["-e", `
      const fs = require("node:fs")
      const [method, args, maxBytes] = JSON.parse(process.argv[1])
      try {
        const value = (${fileOperation.toString()})(fs, method, args, maxBytes,
          method === "writeFileSync" ? fs.readFileSync(0) : undefined)
        process.stdout.write(method === "readFileSync" ? value : JSON.stringify(value ?? null))
      } catch (error) { process.stderr.write(JSON.stringify({ message: error.message, code: error.code })); process.exit(1) }
    `, JSON.stringify([method, args, maxBytes])], {
      env: agentEnv({ PATH: process.env.PATH }), input, maxBuffer: maxBytes + 4096, timeout: 30000, killSignal: "SIGKILL",
    })
    if (result.error) throw result.error
    if (result.status !== 0) {
      let error
      try { error = JSON.parse(result.stderr.toString()) } catch { error = { message: "Agent file operation failed" } }
      throw Object.assign(new Error(error.message), { code: error.code })
    }
    value = method === "readFileSync" ? result.stdout : JSON.parse(result.stdout.toString())
  }
  return method === "readFileSync" && args[1] ? value.toString(args[1]) : value
}

export const agentFs = Object.fromEntries([
  "existsSync", "rmSync", "unlinkSync", "mkdtempSync", "mkdirSync", "readdirSync",
].map(method => [method, (...args) => call(method, args)]))
agentFs.readFileSync = (path, encoding, maxBytes = MAX_BYTES) => call("readFileSync", [path, encoding], undefined, maxBytes)
agentFs.writeFileSync = (path, data, maxBytes = MAX_BYTES) => {
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data)
  if (bytes.length > maxBytes) throw new Error("file too large")
  return call("writeFileSync", [path], bytes, maxBytes)
}

// Copies the non-empty regular files whose names match, as the agent. Symlinks, unreadable and unchanged files are skipped.
export function copyFiles(from, to, match) {
  let names
  try { names = agentFs.readdirSync(from).filter(name => match.test(name)) } catch { return }
  for (const name of names) {
    try {
      const bytes = agentFs.readFileSync(join(from, name))
      if (!bytes.length) continue
      try { if (bytes.equals(agentFs.readFileSync(join(to, name)))) continue } catch { /* new file */ }
      agentFs.mkdirSync(to, { recursive: true, mode: 0o700 })
      agentFs.writeFileSync(join(to, name), bytes)
    } catch { /* not a regular file */ }
  }
}

// Read-only runs (scan, review) get a fresh agent-owned home holding copies of the login files only, so settings,
// hooks or MCP servers that a fixer wrote into the agent's home earlier in the container never load.
// A resumed session keeps the home that holds it. Only scans resume read-only sessions.
const sessionHomes = new Map()
export function readOnlyHome(home, resume, logins) {
  // Dev hosts running the bridge outside the image have no /home/agent.
  const dir = sessionHomes.get(resume) ?? agentFs.mkdtempSync(join(agentFs.existsSync(home) ? home : tmpdir(), ".readonly-"))
  for (const [path, match] of logins) copyFiles(join(home, path), join(dir, path), match)
  return dir
}
export const keepReadOnlyHome = (session, dir) => { if (typeof session === "string") sessionHomes.set(session, dir) }
// A home no session can resume holds only login copies. rmSync unlinks symlinks without following them.
export function dropReadOnlyHome(dir) {
  if (![...sessionHomes.values()].includes(dir)) agentFs.rmSync(dir, { recursive: true, force: true })
}
