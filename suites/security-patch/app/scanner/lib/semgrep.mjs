import { agentEnv, agentSpawnSync } from "./agent-user.mjs";
import { readFileSync, realpathSync } from "node:fs"
import { runAsAgent } from "./agent-fs.mjs"
import { relative, resolve, sep } from "node:path";
import { vendorTreeForPath } from "./vendor.mjs";

// Comments must occur outside strings and block comments to suppress a hit.
function ignoreCategories(source) {
  let php = false;
  let quote = null;
  let block = false;
  let heredoc = null;
  return source.split(/\r?\n/).map((line) => {
    if (heredoc) {
      if (new RegExp(`^\\s*${heredoc}(?:[;,]|$)`).test(line)) heredoc = null;
      return undefined;
    }
    for (let i = 0; i < line.length; i++) {
      if (!php) {
        const opening = line.slice(i).match(/^<\?(?:php\b|=)/i);
        if (opening) { php = true; i += opening[0].length - 1; }
      } else if (block) {
        if (line.slice(i, i + 2) === "*/") { block = false; i++; }
      } else if (quote) {
        if (line[i] === "\\") i++;
        else if (line[i] === quote) quote = null;
      } else if (line.slice(i, i + 2) === "?>") {
        php = false;
        i++;
      } else if (line.slice(i, i + 2) === "/*") {
        block = true;
        i++;
      } else if (line.slice(i, i + 3) === "<<<") {
        heredoc = line.slice(i + 3).match(/^\s*["']?([A-Za-z_][A-Za-z0-9_]*)["']?\s*$/)?.[1] ?? null;
        break;
      } else if (line[i] === "#") {
        if (line.slice(i).includes("?>")) php = false;
        break;
      } else if (line.slice(i, i + 2) === "//") {
        const marker = line.slice(i).match(/^\/\/\s*security-patch: ignore ([a-z][a-z-]*)\s+—\s+\S.*$/)?.[1];
        if (line.slice(i).includes("?>")) php = false;
        return marker;
      } else if (["'", '"', "`"].includes(line[i])) {
        quote = line[i];
      }
    }
    return undefined;
  });
}

export function filterIgnoredHits(report, repoDir, categories = [], readSource = readFileSync) {
  if (process.getuid?.() === 0 && readSource === readFileSync) return runAsAgent(import.meta.url, "filterIgnoredHits", [report, repoDir, categories])
  const cache = new Map();
  return {
    ...report,
    results: report.results.filter((hit) => {
      const category = hit.extra?.metadata?.category;
      if (categories.length && !categories.includes(category)) return false;
      const path = resolve(repoDir, hit.path);
      if (!path.startsWith(resolve(repoDir) + sep)) throw new Error("Semgrep path outside repository");
      if (!cache.has(path)) cache.set(path, ignoreCategories(readSource(path, "utf-8")));
      const markers = cache.get(path);
      const line = hit.start.line - 1;
      return !category || (markers[line] !== category && markers[line - 1] !== category);
    }),
  };
}

function semgrepError(error, pass, repoDir) {
  const file = error.path ?? error.location?.path;
  const root = realpathSync(repoDir);
  const path = typeof file === "string" ? relative(root, resolve(root, file)).split(sep).join("/") : null;
  return {
    pass, rule: error.check_id ?? error.rule_id ?? null,
    path: path && path !== ".." && !path.startsWith("../") ? path : null,
    message: String(error.message ?? error.type ?? "Semgrep error").replace(/\s+/g, " ").slice(0, 300),
  };
}

function hitKey(hit, repoDir) {
  const position = point => [point?.line, point?.col, point?.offset];
  return JSON.stringify([hit.check_id, resolve(repoDir, hit.path), position(hit.start), position(hit.end)]);
}

function semgrepPass(repoDir, rulesDir, categories, targets, pass, flags = []) {
  let errors = [];
  try {
    const scan = (files, retry = false) => {
      // The repo is the agent's, and semgrep runs git inside it, so scan it as the agent user.
      const result = agentSpawnSync("semgrep", [
        "scan", "--config", rulesDir, "--json", "--metrics=off", "--disable-version-check",
        "--timeout", retry ? "0" : "5", ...flags, ...files,
      ], { cwd: repoDir, env: agentEnv(), encoding: "utf-8", killSignal: "SIGKILL", maxBuffer: 64 * 1024 * 1024, ...(retry ? { timeout: 60000 } : { timeout: 120000 }) });
      const report = JSON.parse(result.stdout || "{}");
      if (!retry) errors = (report.errors ?? []).map(error => semgrepError(error, pass, repoDir));
      if (result.error || result.status !== 0 || !Array.isArray(report.results)) {
        throw Object.assign(new Error("Semgrep process failed"), { code: result.error?.code ?? result.status });
      }
      return report;
    };
    const report = scan(targets);
    const timeouts = new Set((report.errors ?? []).flatMap((error, i) =>
      /timeout|timed out/i.test(String(error.type) + " " + String(error.message)) && errors[i].path ? [i] : []));
    if (timeouts.size) {
      const files = [...new Set([...timeouts].map(i => errors[i].path))];
      errors = errors.map((error, i) => timeouts.has(i) ? { ...error, retried: true } : error);
      try {
        const retry = scan(files.map(file => `./${file}`), true);
        const retryErrors = (retry.errors ?? []).map(error => semgrepError(error, pass, repoDir));
        const seen = new Set(report.results.map(hit => hitKey(hit, repoDir)));
        for (const hit of retry.results) {
          const key = hitKey(hit, repoDir);
          if (!seen.has(key)) report.results.push(hit);
          seen.add(key);
        }
        errors = errors.filter((error, i) => !timeouts.has(i) || retryErrors.some(other => !other.path || other.path === error.path));
        for (const error of retryErrors) {
          if (!errors.some(other => other.path === error.path && other.rule === error.rule && other.message === error.message)) {
            errors.push({ ...error, retried: true });
          }
        }
        if (retry.paths?.scanned) report.paths = {
          ...report.paths, scanned: [...new Set([...(report.paths?.scanned ?? []), ...retry.paths.scanned])],
        };
      } catch {
        // Keep the first pass and its errors when the retry cannot finish.
      }
    }
    report.errors = errors;
    return filterIgnoredHits(report, realpathSync(repoDir), categories.split(",").filter(Boolean), (path) => {
      if (!realpathSync(path).startsWith(realpathSync(repoDir) + sep)) throw new Error("Semgrep symlink outside repository");
      return readFileSync(path, "utf-8");
    });
  } catch (error) {
    const note = "Semgrep pre-pass failed. Continue with your own source search.";
    console.error(`${note} (${error?.code ?? error?.name ?? "Error"})`);
    return { results: [], errors: [...errors, { pass, rule: null, path: null, message: note }] };
  }
}

export function runSemgrep(repoDir, rulesDir, categories = "", targets = ["."]) {
  if (process.getuid?.() === 0) return runAsAgent(import.meta.url, "runSemgrep", [repoDir, rulesDir, categories, targets])
  return semgrepPass(repoDir, rulesDir, categories, targets, "app");
}

export function runVendorSemgrep(repoDir, rulesDir, categories, trees, appReport) {
  if (process.getuid?.() === 0) return runAsAgent(import.meta.url, "runVendorSemgrep", [repoDir, rulesDir, categories, trees, appReport])
  if (!trees.length) return appReport;
  const vendorReport = semgrepPass(repoDir, rulesDir, categories, trees.map(tree => `./${tree}`), "vendor", [
    "--x-ignore-semgrepignore-files", "--no-git-ignore",
    "--exclude", "node_modules", "--exclude", "build", "--exclude", "dist", "--",
  ]);
  const root = realpathSync(repoDir);
  const key = hit => hitKey(hit, root);
  const results = [...appReport.results];
  const seen = new Set(results.map(key));
  for (const hit of vendorReport.results) {
    const vendorTree = vendorTreeForPath(hit.path, repoDir, trees);
    if (vendorTree && !seen.has(key(hit))) results.push({ ...hit, vendorTree });
    seen.add(key(hit));
  }
  return {
    ...appReport, results, errors: [...(appReport.errors ?? []), ...vendorReport.errors],
    ...(vendorReport.paths?.scanned ? { paths: {
      ...appReport.paths, scanned: [...new Set([...(appReport.paths?.scanned ?? []), ...vendorReport.paths.scanned])],
    } } : {}),
  };
}
