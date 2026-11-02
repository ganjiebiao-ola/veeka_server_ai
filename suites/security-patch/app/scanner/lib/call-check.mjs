import fs from "node:fs"
import { runAsAgent } from "./agent-fs.mjs"
import path from "node:path"

const MAX_FILE_BYTES = 2 * 1024 * 1024
const MAX_TOTAL_TOKENS = 16000000
const implicitMethods = new Set([
  "__call", "__callstatic", "__construct", "__destruct", "__tostring", "__get", "__set", "__isset", "__unset", "__invoke",
  "__wakeup", "__unserialize", "__sleep", "__serialize", "__clone", "__set_state", "__debuginfo",
  "offsetget", "offsetset", "offsetexists", "offsetunset", "getiterator", "current", "key", "next",
  "rewind", "valid", "seek", "count", "jsonserialize", "serialize", "unserialize",
])

const namePattern = /^[\\\p{L}_][\\\p{L}\p{N}_]*/u
const lower = value => value.replaceAll("/", "\\").replace(/^\\/, "").toLowerCase()
const within = (file, tree) => file.startsWith(`${tree}/`)
const add = (map, key, value) => {
  if (!map.has(key)) map.set(key, [])
  map.get(key).push(value)
}

function decodeString(value) {
  return value.slice(1, -1).replace(/\\([\\'"])/g, "$1")
}

// Keep strings and comments out of the delimiter stack, including heredocs and inline HTML.
function tokenize(source, budget = MAX_TOTAL_TOKENS) {
  const tokens = []
  const pairs = new Map()
  const stack = []
  let offset = 0
  let line = 1
  let php = false
  let valid = true
  const advance = end => {
    for (let i = offset; i < end; i++) if (source[i] === "\n") line++
    offset = end
  }
  while (offset < source.length) {
    if (tokens.length >= budget) break
    const rest = source.slice(offset)
    if (!php) {
      const opening = /<\?(?:php\b|=)?/i.exec(rest)
      if (!opening) break
      advance(offset + opening.index + opening[0].length)
      php = true
      continue
    }
    if (rest.startsWith("?>")) {
      advance(offset + 2)
      php = false
      continue
    }
    const space = /^\s+/.exec(rest)
    if (space) {
      advance(offset + space[0].length)
      continue
    }
    if (/^(?:\/\/|#(?!\[))/.test(rest)) {
      const end = rest.search(/\n|\?>/)
      advance(end < 0 ? source.length : offset + end)
      continue
    }
    if (rest.startsWith("/*")) {
      const end = source.indexOf("*/", offset + 2)
      if (end < 0) {
        valid = false
        break
      }
      advance(end + 2)
      continue
    }
    const heredoc = /^<<<[ \t]*(['"]?)([A-Za-z_]\w*)\1[^\n]*\n/.exec(rest)
    if (heredoc) {
      const ending = new RegExp(`^[ \\t]*${heredoc[2]}(?=[;,\\s)]|$)`, "m")
        .exec(rest.slice(heredoc[0].length))
      if (!ending) {
        valid = false
        break
      }
      const end = offset + heredoc[0].length + ending.index + ending[0].length
      tokens.push({ value: source.slice(offset, end), kind: "opaque", line, offset })
      advance(end)
      continue
    }
    const quote = source[offset]
    if (quote === "'" || quote === '"' || quote === "`") {
      let end = offset + 1
      while (end < source.length && source[end] !== quote) {
        if (source[end] === "\\") end++
        end++
      }
      if (end >= source.length) {
        valid = false
        break
      }
      const raw = source.slice(offset, end + 1)
      tokens.push({ value: decodeString(raw), kind: quote === "`" || (quote === '"' && raw.includes("$")) ? "opaque" : "string", line, offset })
      advance(end + 1)
      continue
    }
    const variable = /^\$[\p{L}_][\p{L}\p{N}_]*/u.exec(rest)
    const name = namePattern.exec(rest)
    const value = variable?.[0] || name?.[0] || /^(?:\?->|->|::|=>|\.\.\.)/.exec(rest)?.[0] || quote
    const index = tokens.length
    tokens.push({ value, kind: variable ? "variable" : name ? "name" : "symbol", line, offset })
    if (["{", "(", "["].includes(value)) stack.push(index)
    if (["}", ")", "]"].includes(value)) {
      const open = stack.pop()
      if (open === undefined || "{([".indexOf(tokens[open].value) !== "})]".indexOf(value)) valid = false
      else {
        pairs.set(open, index)
        pairs.set(index, open)
      }
    }
    advance(offset + value.length)
  }
  const exhausted = offset < source.length && tokens.length >= budget
  return { tokens, pairs, valid: valid && stack.length === 0 && !exhausted, exhausted }
}

function resolveName(name, context, kind = "classes") {
  if (name.startsWith("\\")) return lower(name)
  if (/^namespace\\/i.test(name)) return lower(`${context.namespace}\\${name.slice(10)}`)
  const parts = name.split("\\")
  const alias = context[kind].get(parts[0].toLowerCase())
  return alias ? lower([alias, ...parts.slice(1)].join("\\")) : lower([context.namespace, name].filter(Boolean).join("\\"))
}

function imports(tokens, start, end, context) {
  let kind = "classes"
  let prefix = ""
  let parts = []
  const save = () => {
    if (!parts.length || kind === "const") return
    const name = `${prefix}${parts[0]}`
    const alias = parts[1] || name.split("\\").at(-1)
    context[kind].set(alias.toLowerCase(), lower(name))
    parts = []
  }
  for (let i = start; i < end; i++) {
    const value = tokens[i].value
    if (value === "function") kind = "functions"
    else if (value === "const") kind = "const"
    else if (value === "{") {
      prefix = parts[0]
      parts = []
    }
    else if (value === "," || value === "}") save()
    else if (tokens[i].kind === "name" && value.toLowerCase() !== "as") parts.push(value)
  }
  save()
}

function declarations(parsed, file) {
  const { tokens, pairs } = parsed
  const contexts = []
  const ignored = new Set()
  const pending = new Map()
  const stack = []
  const callables = []
  const classes = []
  let context = { namespace: "", classes: new Map(), functions: new Map(), klass: null, owner: null }
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    const word = token.value.toLowerCase()
    contexts[i] = context
    if (word === "namespace" && tokens[i + 1]?.value !== "\\") {
      let end = i + 1
      while (end < tokens.length && ![";", "{"].includes(tokens[end].value)) {
        ignored.add(end)
        end++
      }
      const next = { namespace: tokens[i + 1]?.kind === "name" ? tokens[i + 1].value : "", classes: new Map(), functions: new Map(), klass: null, owner: null }
      if (tokens[end]?.value === "{") pending.set(end, next)
      else context = next
    }
    if (word === "use" && !context.klass && !context.owner && tokens[i + 1]?.value !== "(") {
      let end = i + 1
      while (end < tokens.length && tokens[end].value !== ";") {
        ignored.add(end)
        end++
      }
      imports(tokens, i + 1, end, context)
    }
    if (["class", "interface", "trait", "enum"].includes(word) && tokens[i - 1]?.value !== "::") {
      let end = i + 1
      while (end < tokens.length && tokens[end].value !== "{") end++
      if (!pairs.has(end)) {
        parsed.valid = false
        continue
      }
      const named = tokens[i + 1]?.kind === "name"
      if (named) ignored.add(i + 1)
      const klass = { name: named ? lower([context.namespace, tokens[i + 1].value].filter(Boolean).join("\\")) : null, parents: [], magic: false, path: file.path, start: token.line, end: tokens[pairs.get(end)].line }
      let bases = false
      for (let j = i + 2; j < end; j++) {
        if (["extends", "implements"].includes(tokens[j].value.toLowerCase())) bases = true
        else if (bases && tokens[j].kind === "name") klass.parents.push(resolveName(tokens[j].value, context))
      }
      classes.push(klass)
      pending.set(end, { ...context, klass })
    }
    if (word === "use" && context.klass && !context.owner) {
      let j = i + 1
      for (; j < tokens.length && ![";", "{"].includes(tokens[j].value); j++) {
        if (tokens[j].kind === "name") context.klass.parents.push(resolveName(tokens[j].value, context))
      }
      // shortcut: trait adaptations stay unknown until alias and precedence resolution is supported.
      if (tokens[j]?.value === "{") file.uncertain = true
    }
    if (word === "function" && !ignored.has(i)) {
      let next = i + 1
      if (tokens[next]?.value === "&") next++
      const named = tokens[next]?.kind === "name"
      const name = named ? tokens[next++].value : null
      if (named) ignored.add(next - 1)
      if (tokens[next]?.value !== "(" || !pairs.has(next)) {
        parsed.valid = false
        continue
      }
      let end = pairs.get(next) + 1
      while (end < tokens.length && !["{", ";"].includes(tokens[end].value)) end++
      if (end === tokens.length) {
        parsed.valid = false
        continue
      }
      const owner = { kind: context.klass && !context.owner && named ? "method" : "function", name: name ? lower(context.klass && !context.owner ? name : [context.namespace, name].filter(Boolean).join("\\")) : null, klass: context.klass, path: file.path, start: token.line, end: tokens[pairs.get(end) ?? end].line }
      callables.push(owner)
      if (context.klass && ["__call", "__callstatic"].includes(owner.name)) context.klass.magic = true
      if (tokens[end].value === "{") pending.set(end, { ...context, owner })
    }
    // shortcut: arrows and variable variables stay unknown until a PHP parser provides data flow.
    if (word === "fn" || (word === "$" && tokens[i + 1]?.kind === "variable")) file.uncertain = true
    if (token.value === "{") {
      stack.push(context)
      context = pending.get(i) || context
    }
    if (token.value === "}") context = stack.pop() || context
  }
  return { contexts, ignored, callables, classes }
}

const nonCalls = new Set(["if", "elseif", "while", "for", "foreach", "switch", "catch", "isset", "empty", "unset", "array", "list", "echo", "print", "exit", "die", "eval", "include", "include_once", "require", "require_once", "match", "declare", "function", "fn", "use"])

function indexFile(file, parsed, index) {
  const { tokens } = parsed
  const model = declarations(parsed, file)
  file.callables = model.callables
  file.classes = model.classes
  file.valid = parsed.valid
  file.references = new Set()
  file.callKeys = new Set()
  for (const klass of model.classes) if (klass.name) index.classes.set(klass.name, klass)
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    const value = token.value.toLowerCase()
    const context = model.contexts[i]
    const previous = tokens[i - 1]?.value.toLowerCase()
    const next = tokens[i + 1]?.value
    const event = { path: file.path, line: token.line, owner: context.owner, vendor: file.vendor, file }
    if (!file.vendor && ["name", "string", "opaque"].includes(token.kind)) {
      const name = token.kind === "name" ? value.split("\\").at(-1) : value
      const key = `${token.kind}:${name}`
      if (!index.appMentions.has(key)) index.appMentions.set(key, { value: name, kind: token.kind, path: file.path, line: token.line })
    }
    if (value === "use" && !context.klass && !context.owner) {
      for (const name of context.classes.values()) {
        file.references.add(name)
        add(index.classReferences, name, event)
        if (!file.vendor) index.appClasses.add(name)
      }
    }
    if (token.kind === "string") {
      add(index.strings, lower(token.value), event)
      // Class::class in an array callable follows namespace imports, unlike a quoted class name.
      if (previous === "," && tokens[i - 2]?.value.toLowerCase() === "class" && tokens[i - 3]?.value === "::" && tokens[i - 4]?.kind === "name" && ["[", "("].includes(tokens[i - 5]?.value)) {
        const name = resolveName(tokens[i - 4].value, context)
        add(index.strings, `${name}::${value}`, event)
      }
    }
    const callback = ["call_user_func", "call_user_func_array"].includes(value) && next === "(" && tokens[i + 2]?.kind !== "string" && !["[", "array"].includes(tokens[i + 2]?.value)
    if (token.kind === "opaque" || (value === "eval" && next === "(") || (token.kind === "variable" && next === "(") || callback || (value === "new" && tokens[i + 1]?.kind === "variable") || (["->", "?->", "::"].includes(value) && (tokens[i + 1]?.kind === "variable" || next === "{"))) {
      index.dynamic.push(event)
      if (event.owner) event.owner.dynamic = true
      else file.dynamic = true
    }
    if (["include", "include_once", "require", "require_once"].includes(value)) {
      let end = i + 1
      while (end < tokens.length && tokens[end].value !== ";") end++
      const expression = tokens.slice(i + 1, end)
      const included = literalPath(expression, file.path, index.repoDir)
      const local = literalPath(expression, file.path, index.repoDir, true)
      if (included) add(index.includes, included, event)
      if (local && local !== included) add(index.includes, local, event)
      if (!included && !local) {
        index.dynamic.push(event)
        if (event.owner) event.owner.dynamic = true
        else file.dynamic = true
      }
    }
    if (token.kind !== "name" || model.ignored.has(i) || nonCalls.has(value)) continue
    if (["->", "?->"].includes(previous) && next === "(") {
      const receiver = tokens[i - 2]?.value === "$this" ? context.klass?.name : null
      add(index.methods, value, { ...event, receiver })
      continue
    }
    if (previous === "::" && next === "(") continue
    let resolved = resolveName(token.value, context)
    if (["self", "static"].includes(value)) resolved = context.klass?.name
    if (value === "parent") resolved = context.klass?.parents[0]
    if (resolved && (next !== "(" || previous === "new") && previous !== "function") {
      file.references.add(resolved)
      add(index.classReferences, resolved, event)
      if (!file.vendor) index.appClasses.add(resolved)
    }
    if (resolved && previous === "new") {
      add(index.calls, `${resolved}::__construct`, event)
      file.callKeys.add(`${resolved}::__construct`)
    }
    if (resolved && next === "::" && tokens[i + 2]?.kind === "name" && tokens[i + 3]?.value === "(") {
      add(index.calls, `${resolved}::${tokens[i + 2].value.toLowerCase()}`, event)
      file.callKeys.add(`${resolved}::${tokens[i + 2].value.toLowerCase()}`)
    }
    if (next === "(" && !["new", "::", "->", "?->"].includes(previous)) {
      add(index.calls, resolveName(token.value, context, "functions"), event)
      if (!token.value.includes("\\") && !context.functions.has(value) && context.namespace) add(index.calls, value, event)
    }
  }
}

function literalPath(tokens, file, repoDir, relativeToFile = false) {
  const text = tokens.map(token => token.kind === "string" ? JSON.stringify(token.value) : token.value).join("")
    .replace(/dirname\(__DIR__\)/gi, JSON.stringify(path.posix.dirname(path.posix.dirname(file))))
    .replace(/__DIR__/gi, JSON.stringify(path.posix.dirname(file)))
    .replace(/__FILE__/gi, JSON.stringify(file))
  const expression = text.replace(/^\((.*)\)$/, "$1")
  if (!/^(?:"(?:[^"\\]|\\.)*"|\s|\.)+$/.test(expression)) return null
  const parts = expression.match(/"(?:[^"\\]|\\.)*"/g)
  if (!parts) return null
  let result = parts.map(part => JSON.parse(part)).join("")
  if (relativeToFile && !path.posix.isAbsolute(result) && !tokens.some(token => ["__dir__", "__file__"].includes(token.value.toLowerCase()))) result = path.posix.join(path.posix.dirname(file), result)
  result = path.posix.normalize(result)
  const relative = path.isAbsolute(result) ? path.relative(repoDir, result).split(path.sep).join("/") : result
  return relative === ".." || relative.startsWith("../") ? null : relative.replace(/^\.\//, "")
}

function autoload(source, file, index) {
  const tree = file.vendor
  const vendorDir = path.posix.dirname(path.posix.dirname(file.path))
  const baseDir = path.posix.dirname(vendorDir)
  const expanded = source.replace(/\$vendorDir\b/g, `'${vendorDir}'`).replace(/\$baseDir\b/g, `'${baseDir}'`)
  const parsed = tokenize(expanded, index.remainingTokens)
  index.remainingTokens -= parsed.tokens.length
  const { tokens, pairs, valid } = parsed
  if (parsed.exhausted) {
    index.incomplete = true
    return
  }
  if (!valid) index.incomplete = true
  const kind = path.posix.basename(file.path)
  // Composer emits literal keys and concatenated paths. Never evaluate its generated PHP.
  const entry = /(['"])((?:\\.|(?!\1)[^\\])*)\1\s*=>/g
  const positions = new Map(tokens.map((token, i) => [token.offset, i]))
  let matched = 0
  for (const match of expanded.matchAll(entry)) {
    const key = decodeString(`${match[1]}${match[2]}${match[1]}`)
    const startIndex = positions.get(match.index) + 2
    let endIndex = startIndex
    while (endIndex < tokens.length && ![",", ";", ")", "]"].includes(tokens[endIndex].value)) endIndex = (pairs.get(endIndex) ?? endIndex) + 1
    const valueTokens = tokens.slice(startIndex, endIndex)
    const paths = []
    let start = valueTokens.findIndex(token => token.value === "(" || token.value === "[")
    if (valueTokens[0]?.value === "array" || valueTokens[0]?.value === "[") {
      start++
      for (let i = start; i <= valueTokens.length; i++) if (!valueTokens[i] || [",", ")", "]"].includes(valueTokens[i].value)) {
        const resolved = literalPath(valueTokens.slice(start, i), file.path, index.repoDir)
        if (resolved) paths.push(resolved)
        start = i + 1
      }
    } else {
      const resolved = literalPath(valueTokens, file.path, index.repoDir)
      if (resolved) paths.push(resolved)
    }
    if (!paths.length) {
      index.incomplete = true
      continue
    }
    matched++
    for (const resolved of paths) {
      if (kind === "autoload_files.php") index.autoloadFiles.set(resolved, tree)
      else if (kind === "autoload_classmap.php") add(index.classmap, resolved, lower(key))
      else index.prefixes.push({ prefix: lower(key), directory: resolved, psr0: kind === "autoload_namespaces.php" })
    }
  }
  if (!matched && tokens.some(token => token.value === "=>")) index.incomplete = true
}

function buildIndex(repoDir, trees) {
  repoDir = fs.realpathSync(repoDir)
  const index = { repoDir, remainingTokens: MAX_TOTAL_TOKENS, classReferences: new Map(), files: new Map(), calls: new Map(), methods: new Map(), strings: new Map(), appMentions: new Map(), includes: new Map(), classes: new Map(), children: new Map(), appClasses: new Set(), dynamic: [], classmap: new Map(), prefixes: [], autoloadFiles: new Map(), traces: new Map(), incomplete: false }
  const walk = directory => {
    let entries
    try { entries = fs.readdirSync(path.join(repoDir, directory), { withFileTypes: true }) }
    catch {
      index.incomplete = true
      return
    }
    for (const entry of entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      if (entry.name === ".git" || entry.isSymbolicLink()) continue
      const relative = path.posix.join(directory, entry.name)
      if (entry.isDirectory()) {
        walk(relative)
        continue
      }
      if (!entry.isFile() || !/\.(?:php\d*|phtml|phps|inc|module|tpl)$/i.test(entry.name)) continue
      const file = { kind: "file", path: relative, vendor: trees.find(tree => within(relative, tree)) || null }
      index.files.set(relative, file)
      try {
        const sourcePath = fs.realpathSync(path.join(repoDir, relative))
        if (!sourcePath.startsWith(repoDir + path.sep)) throw new Error("PHP path outside repository")
        const stat = fs.lstatSync(sourcePath)
        if (!(stat.mode & 0o444) || !stat.isFile() || stat.size > MAX_FILE_BYTES || index.remainingTokens <= 0) throw new Error("unreadable or oversized PHP file, or token budget exhausted")
        const source = fs.readFileSync(sourcePath, "utf8")
        if (Buffer.byteLength(source, "utf8") > MAX_FILE_BYTES) throw new Error("PHP file grew past the size limit")
        if (/\.(?:module|tpl)$/i.test(entry.name) && !/<\?(?:php\b|=)/i.test(source)) {
          index.files.delete(relative)
          continue
        }
        const parsed = tokenize(source, index.remainingTokens)
        index.remainingTokens -= parsed.tokens.length
        if (parsed.exhausted) throw new Error("token budget exhausted")
        indexFile(file, parsed, index)
        if (file.vendor && /^autoload_(?:classmap|psr4|namespaces|files)\.php$/.test(entry.name) && path.posix.dirname(relative) === `${file.vendor}/composer`) autoload(source, file, index)
        if (!file.valid || file.uncertain) index.incomplete = true
      } catch {
        file.valid = false
        index.incomplete = true
      }
    }
  }
  walk("")
  for (const included of index.includes.keys()) {
    if (!index.files.has(included) && fs.existsSync(path.join(repoDir, included))) index.incomplete = true
  }
  for (const file of index.files.values()) {
    const mapped = index.classmap.get(file.path) || index.prefixes.flatMap(({ prefix, directory, psr0 }) => {
      if (!within(file.path, directory)) return []
      const suffix = file.path.slice(directory.length + 1, -4).replaceAll("/", "\\")
      return [psr0 ? lower(suffix) : `${prefix}${lower(suffix)}`]
    })
    for (const klass of file.classes || []) {
      if (klass.name?.includes("\\")) continue
      const name = mapped.find(candidate => candidate.split("\\").at(-1) === klass.name)
      if (name && name !== klass.name) {
        for (const key of file.callKeys) {
          if (!key.startsWith(`${klass.name}::`)) continue
          for (const event of index.calls.get(key) || []) if (event.path === file.path) add(index.calls, `${name}${key.slice(klass.name.length)}`, event)
        }
        index.classes.delete(klass.name)
        klass.name = name
        index.classes.set(name, klass)
      }
    }
  }
  for (const klass of index.classes.values()) for (const parent of klass.parents) add(index.children, parent, klass.name)
  return index
}

function callers(symbol, index) {
  if (symbol.kind === "file") {
    const events = [...(index.includes.get(symbol.path) || [])]
    const tree = index.autoloadFiles.get(symbol.path)
    if (tree) events.push(...(index.includes.get(`${tree}/autoload.php`) || []))
    return events
  }
  if (!symbol.name) return []
  if (symbol.kind !== "method") return index.calls.get(symbol.name) || []
  const klass = symbol.klass?.name
  if (!klass) return []
  const receivers = new Set([klass])
  for (const receiver of receivers) for (const child of index.children.get(receiver) || []) receivers.add(child)
  const events = [...receivers].flatMap(receiver => index.calls.get(`${receiver}::${symbol.name}`) || [])
  if (implicitMethods.has(symbol.name)) {
    for (const receiver of receivers) events.push(...(index.classReferences.get(receiver) || []))
  }
  for (const event of index.methods.get(symbol.name) || []) {
    if (receivers.has(event.receiver) || [...receivers].some(receiver => event.vendor ? event.file.references.has(receiver) : index.appClasses.has(receiver))) events.push(event)
  }
  return events
}

function hasMagic(klass, index, seen = new Set()) {
  if (!klass || seen.has(klass.name)) return false
  seen.add(klass.name)
  return klass.magic || klass.parents.some(parent => hasMagic(index.classes.get(parent), index, seen))
}

function trace(symbol, index) {
  const cacheKey = `${symbol.path}:${symbol.start ?? 0}:${symbol.name ?? "file"}`
  if (index.traces.has(cacheKey)) return index.traces.get(cacheKey)
  const queue = [{ symbol, depth: 0, chain: [] }]
  const seen = new Set()
  let uncertain = false
  for (let offset = 0; offset < queue.length; offset++) {
    const current = queue[offset]
    const key = `${current.symbol.path}:${current.symbol.start ?? 0}:${current.symbol.name ?? "file"}`
    if (seen.has(key)) continue
    seen.add(key)
    if (current.symbol.kind === "method" && implicitMethods.has(current.symbol.name)) uncertain = true
    for (const event of callers(current.symbol, index)) {
      if (!event.file.valid) {
        uncertain = true
        continue
      }
      if (!event.vendor) {
        const result = { event, chain: [...current.chain].reverse() }
        index.traces.set(cacheKey, result)
        return result
      }
      const owner = event.owner || event.file
      if (owner.kind === "file" && index.autoloadFiles.has(owner.path)) uncertain = true
      if (!owner.name && owner.kind !== "file") {
        uncertain = true
        continue
      }
      if (owner.dynamic) uncertain = true
      if (current.depth === 3) {
        uncertain = true
        continue
      }
      queue.push({ symbol: owner, depth: current.depth + 1, chain: [...current.chain, owner.kind === "method" ? `${owner.klass?.name}::${owner.name}` : owner.name || owner.path] })
    }
  }
  const result = { uncertain }
  index.traces.set(cacheKey, result)
  return result
}

/** Return call evidence for vendor hits in input order without changing the scanned repo. */
export function checkVendorCalls(repoDir, trees, hits) {
  if (process.getuid?.() === 0) return runAsAgent(import.meta.url, "checkVendorCalls", [repoDir, trees, hits])
  const vendorHits = hits.filter(hit => hit.vendorTree)
  if (!vendorHits.length) return []
  const safeTrees = trees.filter(tree => typeof tree === "string" && tree && !path.posix.isAbsolute(tree) && !tree.split("/").includes(".."))
  const index = buildIndex(repoDir, safeTrees)
  return vendorHits.map(hit => {
    const identity = {}
    const unknown = evidence => ({ ...identity, status: "unknown", caller: null, evidence })
    const file = index.files.get(hit.path)
    if (!file?.valid || !file.vendor || !Number.isInteger(hit.start?.line) || hit.start.line < 1) return unknown("The vendor hit file could not be read or parsed.")
    const enclosing = file.callables.filter(owner => owner.start <= hit.start.line && owner.end >= hit.start.line).sort((a, b) => b.start - a.start)
    if (enclosing.length > 1 && enclosing[0].start === enclosing[1].start) return unknown("Several functions share the hit line, so the enclosing function is ambiguous.")
    const symbol = enclosing[0]
    if (symbol?.name) identity.function = symbol.kind === "method" ? `${symbol.klass?.name}::${symbol.name}` : symbol.name
    const target = symbol || { kind: "file", path: file.path }
    const found = trace(target, index)
    if (found.event) {
      const label = symbol?.kind === "method" ? `${symbol.klass?.name}::${symbol.name}` : symbol?.name || hit.path
      const loaded = index.autoloadFiles.has(hit.path) ? "autoloaded " : ""
      return { ...identity, status: "called", caller: { path: found.event.path, line: found.event.line }, evidence: `App code reaches ${loaded}${[...found.chain, label].join(" -> ")}.` }
    }
    if (!symbol?.name) return unknown("No app include resolved the file-level code or anonymous function.")
    if (symbol.kind === "method" && implicitMethods.has(symbol.name)) return unknown("An implicit PHP method may run without an explicit caller.")
    if (hasMagic(symbol.klass, index)) return unknown("The hit class or its parent defines a magic call handler.")
    const name = symbol.name.split("\\").at(-1)
    for (const mention of index.appMentions.values()) {
      const offset = mention.kind === "name" ? (mention.value === name ? 0 : -1) : mention.value.indexOf(name)
      if (offset < 0) continue
      const line = mention.line + (mention.value.slice(0, offset).match(/\n/g) || []).length
      return unknown(`App code mentions ${name} at ${mention.path}:${line}, so a caller cannot be ruled out.`)
    }
    const receivers = new Set(symbol.klass?.name ? [symbol.klass.name] : [])
    for (const receiver of receivers) for (const child of index.children.get(receiver) || []) receivers.add(child)
    const names = [symbol.name, name, ...receivers, ...[...receivers].map(receiver => `${receiver}::${symbol.name}`)]
    const dynamic = names.flatMap(name => index.strings.get(name) || [])
    const loaded = event => !event.owner && index.autoloadFiles.has(event.path)
    index.reachableDynamic ??= index.dynamic.some(event => !event.vendor || loaded(event) || trace(event.owner || event.file, index).event)
    if (index.reachableDynamic || dynamic.some(event => !event.vendor || loaded(event) || trace(event.owner || event.file, index).event)) return unknown("Dynamic dispatch or a matching string may reach the vendor symbol.")
    if (symbol.kind === "method" && (index.methods.get(symbol.name) || []).some(event => !event.vendor || trace(event.owner || event.file, index).event)) return unknown("Reachable code calls the method name without a resolved class reference.")
    if (found.uncertain || index.incomplete) return unknown("An unreadable file, incomplete parse, or bounded call chain prevents a decision.")
    return { ...identity, status: "not called", caller: null, evidence: `Searched app references and three vendor caller hops for ${symbol.klass?.name ? `${symbol.klass.name}::` : ""}${symbol.name}.` }
  })
}
