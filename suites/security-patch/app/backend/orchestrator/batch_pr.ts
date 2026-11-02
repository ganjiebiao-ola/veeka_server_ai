import { recordPR, type TrackerStore } from "../tracker/store.ts"
import { basename, join, resolve } from "node:path"
import { EN_CATEGORY_TITLES, ZH_CATEGORY_LABELS } from "../../shared/category_labels.ts"
import type { Finding } from "../../shared/types.ts"
import type { Store } from "../store/repo.ts"
import type { DockerController } from "../docker/controller.ts"
import type { RunEventBus } from "../events/bus.ts"
import type { ScannerRun } from "./scanner.ts"
import { readBaseBranch } from "./push_url.ts"
import { encode, inert } from "../tracker/rows.ts"
import { readArtifact, readArtifactJson, writeArtifact } from "./artifact_fs.ts"
import type { Row } from "../tracker/rows.ts"
import { subsystem } from "../tracker/pick.ts"
import type { PickClient } from "../tracker/pick.ts"
import { Tracker } from "../tracker/tracker.ts"

// Written by the check step: one entry per check that ran.
export type Check = { name: string, command: string, ok: boolean, output?: string }
// One question the reviewer answers. behavior marks a change to runtime behavior beyond the fix recipe.
export type Decision = { ask: string, detail?: string, behavior?: boolean }
// Written by the fix agent next to findings.json.
export type BatchNotes = {
  pr_title?: string, fix_pattern?: string, vulnerability?: string[], impact?: string[], shared_helpers?: { name: string, callers: number }[],
  decisions?: (string | Decision)[], review_notes?: (string | { note: string, action: "fixed" | "rejected" })[],
  review_non_blocking?: string[], review_rounds?: number, review_did_not_run?: number[], restart?: string[], rollback?: string, later?: string[], test_note?: string,
  vendor_upgrades?: { tree: string, package: string, from: string | null, to: string }[],
  // Caller search (SKILL §0.6): the related repos searched, and each call site found for a changed route.
  caller_repos?: string[], callers?: { route: string, repo: string, file: string, line: number }[],
}
type OutputLanguage = "en" | "zh"
export interface BatchPRClient extends PickClient {
  createPR(pr: { head: string, base: string, title: string, body: string, draft: boolean }): Promise<number>
}
export type BatchPRDeps = {
  store: Store, activeRuns: Map<string, ScannerRun>, bus: RunEventBus,
  controller: DockerController, runsRootDir: string,
}

// Files the batch changed, and the ones it added under a tests directory.
export function patchFiles(patch: string): { files: string[], newTests: string[], lines: number } {
  const files: string[] = []
  const newTests: string[] = []
  let current = ""
  let lines = 0
  for (const line of patch.split("\n")) {
    const header = /^diff --git a\/(.+) b\/(.+)$/.exec(line)
    if (header) { current = header[2]; files.push(current); continue }
    if (line.startsWith("new file mode") && /(^|\/)tests?\//i.test(current)) newTests.push(current)
    if (/^[+-](?![+-]{2} )/.test(line)) lines++
  }
  return { files, newTests, lines }
}

// Caps keep a hostile batch.json from pushing the body past GitHub's size limit.
const MAX_ITEMS = 30
const MAX_TEXT = 500
const more = (count: number) => count > MAX_ITEMS ? [`- … ${count - MAX_ITEMS} more`] : []
const list = (items: string[] | undefined, empty: string) => items?.length
  ? [...items.slice(0, MAX_ITEMS).map(item => `- ${item}`), ...more(items.length)].join("\n") : `- ${empty}`

const LABELS = {
  en: {
    draft: "**Draft: checks still fail after 2 rounds.** The rows remain `in progress` until this PR is resolved.",
    checks: (failed: number, total: number) => total ? failed ? `❌ Checks ${failed}/${total} failed` : `✅ Checks ${total}/${total}` : "The check step did not run",
    tests: (n: number) => `🧪 New tests ${n}`, rounds: (n: number) => `🔍 Review ${n} rounds`,
    noRestart: "No restart needed.", unknownRestart: "Not specified; confirm before merge.",
    behavior: "**Draft: this PR changes runtime behavior.** Answer the decisions marked *behavior change* before merge.",
    decisions: "Confirm before merging", behaviorTag: "*behavior change*", detail: "Detail", changes: "Changes", vulnerability: "Vulnerability", impact: "Impact",
    noImpact: "See each row’s reason in the Tracker.", related: "Related Issue",
    helpers: "Shared helpers changed", callers: "callers", vendor: "Vendor packages moved", notInstalled: "not installed",
    restart: "Services to restart", rollback: "Rollback",
    verification: "Verification", noChecks: "The check step did not run.", newTests: "New tests:",
    later: "Left for later", review: "Review notes", reviewNonBlocking: "Reviewer notes (non-blocking)", reviewAction: { fixed: "Fixed: ", rejected: "Rejected: " }, reviewFixed: (n: number) => `${n} fixed`, reviewRejected: (n: number) => `${n} rejected`,
    reviewDidNotRun: (round: number) => `Review round ${round} did not run.`, none: "None",
    truncated: "The PR body was cut at 60,000 characters. The full notes are in the run's batch.json.",
    callerSearch: "Callers in related repos", searched: "Searched", calls: "calls",
    noCallers: "No callers found. A human with access to other callers confirms before merge.",
    noRelated: "The notes file names no related repos. A human with access lists the callers before merge.",
    colon: ": ", paren: (value: string) => ` (${value})`,
  },
  zh: {
    draft: "**草稿：两轮后检查仍失败。** 这个 PR 处理完之前，这些行保持 `in progress`。",
    checks: (failed: number, total: number) => total ? failed ? `❌ 检查 ${failed}/${total} 失败` : `✅ 检查 ${total}/${total}` : "检查步骤没有运行",
    tests: (n: number) => `🧪 新增测试 ${n}`, rounds: (n: number) => `🔍 Review ${n} 轮`,
    noRestart: "无需重启。", unknownRestart: "未说明，合并前请确认。",
    behavior: "**草稿：这个 PR 改变了运行行为。** 合并前请先确认标了 *行为变化* 的决定。",
    decisions: "合并前请确认", behaviorTag: "*行为变化*", detail: "细节", changes: "改动", vulnerability: "漏洞说明", impact: "影响范围",
    noImpact: "见 Tracker 中各行的 reason。", related: "关联",
    helpers: "改动的共享 helper", callers: "处调用", vendor: "升级的 vendor 包", notInstalled: "未安装",
    restart: "需要重启的服务", rollback: "回滚步骤",
    verification: "验证", noChecks: "检查步骤没有运行。", newTests: "新增测试：",
    later: "留待以后", review: "Review 记录", reviewNonBlocking: "审查意见（非阻塞）", reviewAction: { fixed: "改：", rejected: "拒：" }, reviewFixed: (n: number) => `${n} 改`, reviewRejected: (n: number) => `${n} 拒`,
    reviewDidNotRun: (round: number) => `第 ${round} 轮 Review 没有运行。`, none: "无",
    truncated: "PR 描述超过 60,000 字符，已截断。完整内容见该次运行的 batch.json。",
    callerSearch: "相关仓库中的调用方", searched: "已搜索", calls: "调用",
    noCallers: "没有找到调用方。合并前请有权限的人确认其他调用方。",
    noRelated: "notes 文件没有列出相关仓库。合并前请有权限的人列出调用方。",
    colon: "：", paren: (value: string) => `（${value}）`,
  },
}

const EN_TEMPLATE = { description: "Description", type: "Type of Change", bugFix: "- [x] Bug fix (security)", tested: "How Has This Been Tested" }

// Agent-written values go inside code spans, so drop backticks and line breaks.
const code = (value: string) => `\`${value.replace(/[`\r\n]/g, "").slice(0, MAX_TEXT)}\``
// Escape agent prose before adding our own inline code tags.
const text = (value: string, max = MAX_TEXT) => inert(encode(value.slice(0, max))).replaceAll("`", "&#96;").replaceAll("\\", "&#92;")
  .replace(/(https?|ftp):/gi, "$1&#58;").replace(/www\./gi, prefix => `${prefix.slice(0, -1)}&#46;`)
  .replace(/&#96;(.*?)&#96;/g, "<code>$1</code>")
const oneLine = (value: string, max = MAX_TEXT) => text(value.replace(/\r\n?|\n/g, " "), max)
// Multi-line prose (rollback steps, notes) keeps its line breaks as <br>, which GitHub renders inside list items too.
const lines = (value: string, max = MAX_TEXT) => text(value.replace(/\r\n?/g, "\n"), max).replaceAll("&#13;", "").replaceAll("&#10;", "<br>")
// GitHub rejects PR bodies over 65,536 characters. Encoding can inflate agent text, so cut the final body.
const MAX_BODY = 60_000

// batch.json is agent-written. Drop fields of the wrong shape instead of failing the PR step.
export function batchNotes(raw: unknown): BatchNotes {
  const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value)
  const n = record(raw) ? raw : {}
  const str = (value: unknown) => typeof value === "string" ? value : undefined
  const strings = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : undefined
  const records = (value: unknown) => Array.isArray(value) ? value.filter(record) : undefined
  return {
    pr_title: str(n.pr_title), fix_pattern: str(n.fix_pattern), rollback: str(n.rollback), test_note: str(n.test_note),
    vulnerability: strings(n.vulnerability)?.slice(0, MAX_ITEMS), impact: strings(n.impact)?.slice(0, MAX_ITEMS),
    later: strings(n.later), caller_repos: strings(n.caller_repos), restart: strings(n.restart)?.slice(0, MAX_ITEMS),
    review_notes: Array.isArray(n.review_notes) ? n.review_notes.flatMap((item): NonNullable<BatchNotes["review_notes"]> => typeof item === "string" ? [item]
      : record(item) && typeof item.note === "string" && (item.action === "fixed" || item.action === "rejected") ? [{ note: item.note, action: item.action }] : []) : undefined,
    review_non_blocking: strings(n.review_non_blocking),
    review_rounds: Number.isSafeInteger(n.review_rounds) && (n.review_rounds as number) >= 0 ? n.review_rounds as number : undefined,
    review_did_not_run: Array.isArray(n.review_did_not_run) ? n.review_did_not_run.filter((round): round is number => Number.isSafeInteger(round) && round > 0).slice(0, MAX_ITEMS) : undefined,
    decisions: Array.isArray(n.decisions) ? n.decisions.flatMap((d): (string | Decision)[] => typeof d === "string" ? [d]
      : record(d) && typeof d.ask === "string" ? [{ ask: d.ask, ...(typeof d.detail === "string" ? { detail: d.detail } : {}), behavior: d.behavior === true }] : []) : undefined,
    shared_helpers: records(n.shared_helpers)?.filter(h => typeof h.name === "string" && Number.isSafeInteger(h.callers)) as BatchNotes["shared_helpers"],
    vendor_upgrades: records(n.vendor_upgrades)?.filter(p => typeof p.tree === "string" && typeof p.package === "string" &&
      (p.from === null || typeof p.from === "string") && typeof p.to === "string") as BatchNotes["vendor_upgrades"],
    callers: records(n.callers)?.filter(c => typeof c.route === "string" && typeof c.repo === "string" &&
      typeof c.file === "string" && Number.isSafeInteger(c.line)) as BatchNotes["callers"],
  }
}

function titleText(value: string): string {
  // Cap before the regexes: some are quadratic on input like "[".repeat(200000).
  const clean = value.slice(0, 400).replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]*>/g, "").replace(/^\s{0,3}(?:#{1,6}\s+|[-+>]\s+)/gm, "").replace(/[`*_~\[\]<>【】]/g, "")
    .replace(/\s+/gu, " ").replace(/[\p{Cc}\p{Cf}]/gu, "").replace(/\s+/gu, " ").trim()
  return inert(clean).replaceAll("&#64;", "＠").replaceAll("&#40;", "(").replaceAll("&#41;", ")").replaceAll("#", "＃")
}

export function prTitle(category: string, fixed: Row[], notes: BatchNotes, language: OutputLanguage = "zh"): string {
  const en = language === "en"
  const priority = ["P0", "P1", "P2"].find(p => fixed.some(row => row.severity === p)) ?? "P2"
  let label = en ? EN_CATEGORY_TITLES[category] ?? EN_CATEGORY_TITLES.misc : (ZH_CATEGORY_LABELS[category] ?? ZH_CATEGORY_LABELS.misc).replace(/\s*[（(].*§.*$/, "")
  if (!en && Array.from(label).length > 8) label = label.split("/")[0]
  const names = [...new Set(fixed.map(row => basename(row.file)))]
  const fallback = `${names.slice(0, 2).map(name => Array.from(titleText(name)).slice(0, 25).join("")).join(en ? ", " : "、")}${names.length > 2 ? en ? " and more" : "等" : ""}`
  const model = Array.from(titleText(notes.pr_title ?? "")).slice(0, en ? 60 : 40).join("").trim()
  const description = /[\p{L}\p{N}]/u.test(model) ? model : `${fallback} ${en ? "hardening" : "加固"}`
  return Array.from(en ? `[${priority}·${label}] ${description}` : `【${priority}·${label}】${description}`).slice(0, 99).join("")
}

function callerSection(n: BatchNotes, t: typeof LABELS.en, head = section): string[] {
  if (!Array.isArray(n.caller_repos)) return []
  const repos = n.caller_repos.filter((repo): repo is string => typeof repo === "string")
  const callers = (Array.isArray(n.callers) ? n.callers : []).filter(c => typeof c?.route === "string" && typeof c.repo === "string" &&
    typeof c.file === "string" && Number.isInteger(c.line))
  const body = !repos.length ? t.noRelated : [`${t.searched}: ${repos.map(code).join(", ")}`, "",
    callers.length ? [...callers.slice(0, MAX_ITEMS).map(c => `- [ ] ${code(`${c.repo}:${c.file}:${c.line}`)} ${t.calls} ${code(c.route)}`), ...more(callers.length)].join("\n") : t.noCallers].join("\n")
  return [head(`${t.callerSearch} (${callers.length})`, body)]
}

// Commands sharing a "<tool> restart" prefix merge into one line, so the reviewer runs a single command.
const restartCommands = (commands: string[]) => {
  const merged = new Map<string, string[]>()
  for (const command of commands.map(c => c.replace(/[`\r\n]/g, "").trim().slice(0, MAX_TEXT))) {
    const [prefix, args] = /^(\S+ restart) (.+)$/.exec(command)?.slice(1) ?? [command, ""]
    merged.set(prefix, [...(merged.get(prefix) ?? []), ...(args ? [args] : [])])
  }
  return [...merged].map(([prefix, args]) => [prefix, ...args].join(" "))
}

export const changesBehavior = (notes: BatchNotes) => !!notes.decisions?.some(d => typeof d !== "string" && d.behavior)

const section = (title: string, body: string) => `## ${title}\n\n${body}`
const subsection = (title: string, body: string) => `### ${title}\n\n${body}`
const fold = (title: string, body: string, open = false) => `<details${open ? " open" : ""}><summary>${title}</summary>\n\n${body}\n\n</details>`
// A checkbox per question, so the reviewer can tick each one. The detail folds under it.
const asks = (decisions: (string | Decision)[], t: typeof LABELS.en) => [...decisions.slice(0, MAX_ITEMS).map(d => {
  if (typeof d === "string") return `- [ ] ${text(d)}`
  const head = `- [ ] **${text(d.ask)}**${d.behavior ? ` ${t.behaviorTag}` : ""}`
  return d.detail ? `${head}\n  <details><summary>${t.detail}</summary>\n\n  ${text(d.detail, 2000).replaceAll("&#10;", "\n  ")}\n\n  </details>` : head
}), ...more(decisions.length)].join("\n")

export function prBody(o: {
  category: string, subsystem: string, files: string[], newTests: string[], lines: number,
  fixed: (Row & { fixSummary?: string })[], notes: BatchNotes, checks: Check[] | undefined, failing: boolean, trackerUrl?: string,
  language?: OutputLanguage,
}): string {
  const en = o.language === "en"
  const t = LABELS[en ? "en" : "zh"]
  const n = o.notes
  const failed = o.checks?.filter(check => !check.ok).length ?? 0
  const checks = o.checks?.length
    ? list(o.checks.map(check => `${check.ok ? "✅" : "❌"} ${text(check.name)}${t.colon}${code(check.command)}`), t.none)
    : `- ${t.noChecks}`
  const nonBlocking = [...new Set((n.review_non_blocking ?? []).map(note => note.trim()).filter(Boolean))]
  const review = n.review_notes ?? []
  const reviewCounts = [
    [review.filter(item => typeof item !== "string" && item.action === "fixed").length, t.reviewFixed],
    [review.filter(item => typeof item !== "string" && item.action === "rejected").length, t.reviewRejected],
  ] as const
  const reviewTitle = reviewCounts.filter(([count]) => count).map(([count, label]) => label(count)).join(" · ")
  const status = [t.checks(failed, o.checks?.length ?? 0), t.tests(o.newTests.length),
    ...(n.review_rounds !== undefined ? [t.rounds(n.review_rounds)] : [])].join(" · ") + (reviewTitle ? t.paren(reviewTitle) : "")
  // The status line is the fold's summary; it opens when something needs a look.
  const evidence = fold(status, [`**${t.verification}**`, checks, `${t.newTests}\n${list(o.newTests.map(code), t.none)}`, ...(n.test_note ? [oneLine(n.test_note)] : []),
    ...(review.length ? [`**${t.review}**`, list(review.map(item => lines(typeof item === "string" ? item : `${t.reviewAction[item.action]}${item.note}`)), t.none)] : []),
  ].join("\n\n"), failed > 0 || !o.checks?.length || !!n.review_did_not_run?.length)
  const fixed = [...o.fixed].sort((a, b) => a.file.localeCompare(b.file) || Math.min(...a.lines) - Math.min(...b.lines))
  const groups = new Map<string, string[]>()
  for (const row of fixed.slice(0, MAX_ITEMS)) {
    const sites = groups.get(row.file) ?? []
    sites.push(`- ${code(`:${[...row.lines].sort((a, b) => a - b).join(",")}`)}${row.fixSummary ? ` ${oneLine(row.fixSummary)}` : ""}`)
    groups.set(row.file, sites)
  }
  const sites = [...groups].map(([file, bullets]) => `**${code(file)}**\n\n${bullets.join("\n")}`)
  const vulnerability = n.vulnerability ?? fixed.flatMap(row => {
    const reason = /Evidence:[ \t]*([^\r\n]*)/i.exec(row.reason)?.[1].trim() ||
      row.reason.split(/\r\n?|\n/).map(line => line.trim()).find(line => line && !/^(?:Verdict:|Evidence:\s*$)/i.test(line))
    return reason ? [reason.length > 120 ? `${reason.slice(0, 119)}…` : reason] : []
  })
  const warning = (value: string) => `> [!WARNING]\n> ${value}`
  const head = en ? subsection : section
  const detail = [
    ...(n.decisions?.length ? [head(`${t.decisions} (${n.decisions.length})`, asks(n.decisions, t))] : []),
    ...callerSection(n, t, head),
    ...(nonBlocking.length ? [head(t.reviewNonBlocking, list(nonBlocking.map(note => lines(note)), t.none))] : []),
    head(t.changes, [
      ...(n.fix_pattern ? [oneLine(n.fix_pattern, 2000)] : []),
      ...sites, ...more(fixed.length),
      ...(n.shared_helpers?.length ? [`${t.helpers}:\n${list(n.shared_helpers.map(h => `${code(h.name)} (${h.callers} ${t.callers})`), t.none)}`] : []),
      ...(n.vendor_upgrades?.length ? [`${t.vendor}:\n${list(n.vendor_upgrades.map(p => `${code(p.tree)}: ${code(p.package)} ${p.from === null ? t.notInstalled : text(p.from)} → ${text(p.to)}`), t.none)}`] : []),
    ].join("\n\n")),
    ...(vulnerability.length ? [head(t.vulnerability, list(vulnerability.map(item => oneLine(item)), t.none))] : []),
    head(t.impact, n.impact?.length ? list(n.impact.map(item => oneLine(item)), t.none) : t.noImpact),
    head(t.restart, n.restart ? n.restart.length ? ["```sh", ...restartCommands(n.restart), "```"].join("\n") : t.noRestart : t.unknownRestart),
  ]
  const related = section(t.related, [
    ...(o.trackerUrl ? [`- [Tracker](${o.trackerUrl})`] : []),
    ...(n.later?.length ? [fold(`${t.later} (${n.later.length})`, list(n.later.map(item => lines(item)), t.none))] : []),
  ].join("\n\n") || t.none)
  const rollback = n.rollback ? [fold(t.rollback, lines(n.rollback, 2000))] : []
  const body = [
    ...(o.failing ? [warning(t.draft)] : []),
    ...(changesBehavior(n) ? [warning(t.behavior)] : []),
    ...(n.review_did_not_run?.slice(0, MAX_ITEMS).map(round => warning(t.reviewDidNotRun(round))) ?? []),
    ...(en
      ? [section(EN_TEMPLATE.description, [...detail, ...rollback].join("\n\n")), related, section(EN_TEMPLATE.type, EN_TEMPLATE.bugFix), section(EN_TEMPLATE.tested, evidence)]
      : [...detail, related, ...rollback, evidence]),
  ].join("\n\n")
  if (body.length <= MAX_BODY) return body
  const prefix = body.slice(0, MAX_BODY)
  const cut = prefix.slice(0, Math.max(prefix.lastIndexOf("\n\n"), prefix.lastIndexOf("\n- ")))
  const prose = cut.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "")
  const openDetails = (prose.match(/<details(?: open)?>/g) ?? []).length - (prose.match(/<\/details>/g) ?? []).length
  return `${cut}${"\n\n</details>".repeat(openDetails)}\n\n> ${t.truncated}`
}

function readJSON(dir: string, name: string): unknown {
  try { return readArtifactJson(dir, name) } catch { return undefined }
}

async function releaseContainer(deps: BatchPRDeps, runId: string): Promise<void> {
  const containerId = deps.store.getContainerId(runId)
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    if (containerId) await Promise.race([
      deps.controller.stopAndRemove(containerId),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("container cleanup timed out after 30s")), 30_000)
      }),
    ])
  } catch (error) {
    console.warn(`[pick] ${runId}: container cleanup failed: ${error}`)
  } finally {
    clearTimeout(timer)
    deps.activeRuns.delete(runId)
  }
}

// After a picked fix run completes: push the batch branch, open the PR (draft if checks fail),
// update the rows, and release the container. Returns the PR number, or undefined if no PR opened.
export async function openBatchPR(deps: BatchPRDeps, runId: string, client: BatchPRClient, trackerStore: TrackerStore, repo: string): Promise<number | undefined> {
  // Any error, such as a GitHub failure or an invalid tracker table, must still release the container.
  try { return await openBatchPRSteps(deps, runId, client, trackerStore, repo) }
  catch (error) { await releaseContainer(deps, runId); throw error }
}

// GitHubClient.SUITE_BRANCH must keep matching this name.
export function batchBranch(category: string, subsystems: string[], runId: string): string {
  const sub = subsystems.length === 1 ? subsystems[0] : "mixed"
  return `security/${category}-${sub.replace(/[^\w.-]+/g, "-")}-${runId.replace(/-/g, "").slice(0, 8)}`
}

async function openBatchPRSteps(deps: BatchPRDeps, runId: string, client: BatchPRClient, trackerStore: TrackerStore, repo: string): Promise<number | undefined> {
  const run = deps.store.getRun(runId)
  const dir = join(resolve(deps.runsRootDir, runId), "artifacts")
  const rawPicked = readJSON(dir, "picked.json")
  const picked = (Array.isArray(rawPicked) ? rawPicked : []).filter((row): row is { id: string, category: string } =>
    typeof row?.id === "string" && typeof row.category === "string")
  if (run?.mode !== "fix" || !picked.length) return
  const category = picked[0].category
  const ids = new Set(picked.map(row => row.id))
  const file = (await trackerStore.read()).find(file => file.category === category)
  const rows = (file?.rows ?? []).filter(row => ids.has(row.id))
  const findings = new Map<string, Finding>(deps.store.listFindings(runId).filter(f => ids.has(f.id)).map(f => [f.id, f]))
  const tracker = new Tracker(trackerStore, repo)
  // Save human decisions before pushing or opening a PR can fail.
  const human = (fresh: Row[]) => fresh.filter(row => ids.has(row.id)).filter(row => findings.get(row.id)?.status === "needs human").map(row => {
    const finding = findings.get(row.id)!
    return { ...row, status: "needs human" as const, severity: finding.severity, reason: finding.reason || row.reason, pr: "" }
  })
  if (human(rows).length) await tracker.update(category, human, "")
  const { files, newTests, lines } = patchFiles((() => { try { return readArtifact(dir, "working.patch") } catch { return "" } })())
  // A malformed check entry counts as failed.
  const rawChecks = readJSON(dir, "checks.json")
  const checks: Check[] | undefined = Array.isArray(rawChecks) ? rawChecks.map(check => ({
    name: typeof check?.name === "string" ? check.name : "", command: typeof check?.command === "string" ? check.command : "", ok: check?.ok === true,
  })) : undefined
  const failing = !checks?.length || checks.some(check => !check.ok)
  const fixed = rows.filter(row => findings.get(row.id)?.status === "fixed")
  const notes = batchNotes(readJSON(dir, "batch.json"))
  const behavior = changesBehavior(notes)
  const draft = failing || behavior || process.env["OLA_AGENT_DRAFT_PRS"] === "1"
  const setRows = (pr: string, comment: string, error?: string) => tracker.update(category, fresh => fresh.filter(row => ids.has(row.id)).map(row => {
    const finding = findings.get(row.id)
    const reason = finding?.reason || row.reason
    if (finding?.status === "needs human") return { ...row, status: "needs human" as const, severity: finding.severity, reason, pr: "" }
    if (finding?.status === "fixed") return { ...row, status: pr ? "in progress" as const : "open" as const, pr, reason: error ?? (failing ? "Checks fail in the draft PR" : behavior ? "Behavior change needs a human decision" : reason) }
    if (finding && ["ignored", "false positive", "won't fix"].includes(finding.status ?? "")) return { ...row, status: "ignored" as const, reason, pr: "" }
    return { ...row, status: "open" as const, reason, pr: "" }
  }), comment)
  const release = () => releaseContainer(deps, runId)

  if (!fixed.length || !files.length) {
    await setRows("", `Run ${runId.slice(0, 8)}: no fix to open as a PR.`)
    await release()
    return
  }
  const scanner = deps.activeRuns.get(runId)
  const subs = [...new Set(fixed.map(subsystem))]
  const branch = batchBranch(category, subs, runId)
  const pushed = scanner ? await scanner.pushToBranch(branch) : { ok: false, error: "container is gone" }
  if (!pushed.ok) {
    await setRows("", "", `Push failed: ${pushed.error ?? "unknown"}`)
    await release()
    deps.bus.publish(runId, { type: "push_result", ok: false, branch, error: pushed.error ?? "unknown" })
    return
  }
  const number = await client.createPR({
    head: branch, base: readBaseBranch(deps.runsRootDir, runId) ?? run.branch,
    title: prTitle(category, fixed, notes, run.language),
    body: prBody({ category, subsystem: subs.join(", "), files, newTests, lines,
      fixed: fixed.map(row => ({ ...row, fixSummary: findings.get(row.id)?.fixSummary, reason: findings.get(row.id)?.reason || row.reason })),
      notes, checks, failing, trackerUrl: file?.url, language: run.language }),
    draft,
  }).catch(async error => {
    const message = `Branch ${branch} pushed without a PR: ${error instanceof Error ? error.message : String(error)}`
    try {
      await setRows("", "", message)
    } finally {
      await release()
    }
    throw new Error(message, { cause: error })
  })
  // The PR already exists, so a tracker failure here must not skip linking rows, releasing or the push result.
  if (pushed.sha) try {
    await recordPR(trackerStore, number, { pushedSha: pushed.sha, rowIds: fixed.map(row => row.id) }, [category], `PR #${number} pushed: ${pushed.sha}`)
  } catch (error) { console.warn(`[pick] ${runId}: PR #${number} adoption record failed: ${error}`) }
  await setRows(`[PR #${number}](https://github.com/${repo}/pull/${number})`, "")
  const prUrl = `https://github.com/${repo}/pull/${number}`
  try { writeArtifact(dir, "push.json", JSON.stringify({ branch, pr: number, prUrl, draft, pushedSha: pushed.sha, pushedAt: Date.now() })) } catch {}
  await release()
  deps.bus.publish(runId, { type: "push_result", ok: true, branch, prUrl })
  return number
}
