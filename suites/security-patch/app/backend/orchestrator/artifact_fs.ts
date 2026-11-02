// Reads and writes of files in a run's artifacts/ directory. The scanner container mounts that
// directory read-write and a scanned repo can steer its agent, so every entry is hostile.
// Only regular files directly inside the directory are opened, and a symlink is never followed.
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, rmSync, writeSync } from "node:fs"
import { isAbsolute, join, relative } from "node:path"

export const MAX_ARTIFACT_BYTES = 5 * 1024 * 1024

// Returns an open fd, or throws (ENOENT when a file to read is missing). The caller closes the fd.
export function openArtifact(artifactsDir: string, filename: string, flags = constants.O_RDONLY): number {
  if (!filename || /[/\\]/.test(filename)) throw new Error("invalid artifact name")
  const dir = realpathSync(artifactsDir)
  const path = join(dir, filename)
  try {
    if (!lstatSync(path).isFile()) throw new Error("invalid artifact file")
  } catch (error) {
    if (!(flags & constants.O_CREAT) || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
  // O_NOFOLLOW refuses a symlink swapped in after lstat. O_NONBLOCK keeps a swapped-in FIFO from blocking.
  const fd = openSync(path, flags | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600)
  try {
    if (!fstatSync(fd).isFile()) throw new Error("invalid artifact file")
    const inside = relative(dir, realpathSync(path))
    if (!inside || isAbsolute(inside) || inside === ".." || inside.startsWith("../") || inside.startsWith("..\\")) {
      throw new Error("artifact file outside artifacts directory")
    }
  } catch (error) {
    closeSync(fd)
    throw error
  }
  return fd
}

function readBytes(artifactsDir: string, filename: string, maxBytes: number): Uint8Array {
  const fd = openArtifact(artifactsDir, filename)
  try {
    if (fstatSync(fd).size > maxBytes) throw new Error("artifact file too large")
    // Bound the read even if the file grows after stat.
    const bytes = new Uint8Array(maxBytes + 1)
    let length = 0
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null)
      if (count === 0) break
      length += count
    }
    if (length > maxBytes) throw new Error("artifact file too large")
    return bytes.subarray(0, length)
  } finally {
    closeSync(fd)
  }
}

export function readArtifact(artifactsDir: string, filename: string, maxBytes = MAX_ARTIFACT_BYTES): string {
  return new TextDecoder().decode(readBytes(artifactsDir, filename, maxBytes))
}

export function readArtifactJson(artifactsDir: string, filename: string): unknown {
  return JSON.parse(readArtifact(artifactsDir, filename)) as unknown
}

function writeBytes(artifactsDir: string, filename: string, data: string | Uint8Array, flags: number): void {
  const fd = openArtifact(artifactsDir, filename, constants.O_WRONLY | constants.O_CREAT | flags)
  try {
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data
    let written = 0
    while (written < bytes.length) written += writeSync(fd, bytes, written)
  } finally {
    closeSync(fd)
  }
}

export function writeArtifact(artifactsDir: string, filename: string, data: string | Uint8Array): void {
  writeBytes(artifactsDir, filename, data, constants.O_TRUNC)
}

export function appendArtifact(artifactsDir: string, filename: string, data: string): void {
  writeBytes(artifactsDir, filename, data, constants.O_APPEND)
}

export function removeArtifact(artifactsDir: string, filename: string): void {
  if (!filename || /[/\\]/.test(filename)) throw new Error("invalid artifact name")
  rmSync(join(realpathSync(artifactsDir), filename), { force: true })
}

// Copies a file from one run's artifacts into another's, for example on resume.
export function copyArtifact(fromDir: string, filename: string, toDir: string, as: string, maxBytes = MAX_ARTIFACT_BYTES): void {
  writeArtifact(toDir, as, readBytes(fromDir, filename, maxBytes))
}
