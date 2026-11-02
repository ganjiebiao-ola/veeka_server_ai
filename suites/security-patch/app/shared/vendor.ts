export type VendorTree = {
  path: string
  mode: "committed" | "reinstalled" | "unknown"
  evidence: string[]
  lock: "present" | "missing" | "invalid"
  metadataSource: "installed.json" | "composer.lock" | "none"
  packages: { name: string, version: string }[]
  mismatches: { package: string, installed: string, locked: string | null }[]
  audit: "not run" | "completed" | "failed" | "skipped"
}
export type Advisory = {
  package: string, version: string, trees: string[], advisoryId: string,
  cve: string | null, title: string, severity: string | null, link: string | null,
}
export type VendorData = { trees: VendorTree[], advisories: Advisory[], errors: string[] }
