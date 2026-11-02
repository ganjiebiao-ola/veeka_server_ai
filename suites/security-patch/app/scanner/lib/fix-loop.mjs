// Batch fix helpers. Pure, so they can be unit-tested with `bun test`.

// inspect(round) returns notes. Each round with notes sends them to fix(notes, round).
// recheck: inspect once more after the last fix, so the result reflects the final code.
export async function fixLoop({ inspect, fix, maxRounds = 2, recheck = true }) {
  let notes = [];
  for (let round = 1; round <= maxRounds; round++) {
    notes = await inspect(round);
    if (!notes.length) return { clean: true, rounds: round - 1, notes };
    await fix(notes, round);
  }
  if (!recheck) return { clean: false, rounds: maxRounds, notes };
  notes = await inspect(maxRounds + 1);
  return { clean: !notes.length, rounds: maxRounds, notes };
}

// Reviewers may use these reader options. Unknown options fail closed.
const READER_OPTIONS = {
  pwd: { short: "LP" },
  ls: { short: "alhAdrtSFR1", long: ["--all", "--almost-all", "--directory", "--human-readable", "--recursive"] },
  cat: { short: "AbenstuvET", long: ["--number", "--number-nonblank", "--squeeze-blank", "--show-all", "--show-ends", "--show-tabs"] },
  head: { short: "qv", values: ["-n", "-c", "--lines", "--bytes"] },
  tail: { short: "qv", values: ["-n", "-c", "--lines", "--bytes"] },
  wc: { short: "clmwL", long: ["--bytes", "--chars", "--lines", "--words", "--max-line-length"] },
  stat: { short: "Lft", values: ["-c", "--format", "--printf"] },
  find: {
    long: ["-print", "-prune", "-not", "!", "-o", "-a", "(", ")"],
    values: ["-name", "-iname", "-path", "-type", "-maxdepth", "-mindepth", "-size", "-newer"],
  },
  rg: {
    short: "nNiIlLHhsoqvuwxUFSPac",
    long: ["--files", "--hidden", "--no-ignore", "--no-ignore-vcs", "--line-number", "--files-with-matches", "--files-without-match", "--count", "--fixed-strings", "--ignore-case", "--no-heading", "--heading", "--no-config"],
    values: ["-e", "-f", "-g", "-t", "-T", "-m", "-A", "-B", "-C", "--regexp", "--file", "--glob", "--iglob", "--type", "--type-not", "--max-count", "--after-context", "--before-context", "--context"],
  },
  grep: {
    short: "EFGPivwxoanHhslLcrRq",
    long: ["--extended-regexp", "--fixed-strings", "--ignore-case", "--line-number", "--recursive", "--files-with-matches", "--files-without-match", "--count"],
    values: ["-e", "-f", "-m", "-A", "-B", "-C", "--regexp", "--file", "--max-count", "--after-context", "--before-context", "--context", "--include", "--exclude", "--exclude-dir"],
  },
  git: {
    short: "pwsbz",
    long: ["--stat", "--numstat", "--shortstat", "--name-only", "--name-status", "--patch", "--no-patch", "--raw", "--oneline", "--reverse", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", "--check"],
    values: ["-n", "-S", "-G", "--max-count", "--since", "--until", "--author", "--grep"],
    optionalValues: ["-U", "--format", "--pretty"],
  },
}

// Decode literal shell words and ; / && chains. Reject expansion and other shell syntax.
function shellCommands(command) {
  if (/[\x00-\x08\x0a-\x1f\x7f]/.test(command)) return null
  const commands = [[]]
  let word = "", quote = "", started = false
  const finishWord = () => {
    if (started) commands.at(-1).push(word)
    word = ""
    started = false
  }
  for (let i = 0; i < command.length; i++) {
    const char = command[i]
    if (quote === "'") {
      if (char === "'") quote = ""
      else word += char
    } else if (char === "\\") {
      if (++i === command.length) return null
      // Double quotes preserve backslashes except before these shell characters.
      if (quote === '"' && !'$`"\\'.includes(command[i])) word += "\\"
      word += command[i]
      started = true
    } else if (quote === '"') {
      if (char === '"') quote = ""
      else if (char === "$" || char === "`") return null
      else word += char
    } else if (char === "'" || char === '"') {
      quote = char
      started = true
    } else if (char === " " || char === "\t") {
      finishWord()
    } else if (char === ";" || command.slice(i, i + 2) === "&&") {
      finishWord()
      if (!commands.at(-1).length) return null
      commands.push([])
      if (char === "&") i++
    } else if (/[|&<>(){}$`*?\[\]#]/.test(char) || (char === "~" && !started)) {
      return null
    } else {
      word += char
      started = true
    }
  }
  if (quote) return null
  finishWord()
  return commands.at(-1).length ? commands : null
}

function readOnlyReader([reader, ...args]) {
  if (reader === "sed") {
    if (args[0] !== "-n" || !/^\d+(?:,\d+)?p$/.test(args[1] ?? "")) return false
    const files = args.slice(2)
    if (files[0] === "--") return files.length > 1
    return files.length > 0 && files.every(file => !file.startsWith("-"))
  }
  if (!Object.hasOwn(READER_OPTIONS, reader)) return false
  if (reader === "git") {
    if (args[0] === "-C" && args[1] === "/workspace/repo") args.splice(0, 2)
    if (!["diff", "show", "log"].includes(args.shift())) return false
  }
  const options = READER_OPTIONS[reader]
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (reader === "find") {
      if (options.long.includes(arg)) continue
      if (options.values.includes(arg)) {
        if (++i === args.length) return false
      } else if (arg.startsWith("-")) return false
      continue
    }
    if (arg === "--") break
    if (arg === "-" || !arg.startsWith("-")) continue
    if (reader === "git" && /^-\d+$/.test(arg)) continue
    if (arg.startsWith("--")) {
      const option = arg.split("=", 1)[0]
      if (options.long?.includes(arg)) continue
      // Git optional values attach to the option, so the next token is still checked.
      if (options.optionalValues?.includes(option)) continue
      if (!options.values?.includes(option)) return false
      if (!arg.includes("=") && (++i === args.length || (reader === "git" && args[i].startsWith("-")))) return false
    } else {
      for (let j = 1; j < arg.length; j++) {
        if (options.short?.includes(arg[j])) continue
        if (options.optionalValues?.includes(`-${arg[j]}`)) break
        if (!options.values?.includes(`-${arg[j]}`)) return false
        if (j === arg.length - 1 && (++i === args.length || (reader === "git" && args[i].startsWith("-")))) return false
        break
      }
    }
  }
  return true
}

function readOnlyShell(command) {
  let commands = shellCommands(command)
  // Decode the wrapper first, because its quotes and escapes affect the payload too.
  if (commands?.length === 1 && /^(?:\/bin\/)?(?:ba)?sh$/.test(commands[0][0])) {
    const [, flag, payload, ...extra] = commands[0]
    if (!["-c", "-lc"].includes(flag) || payload === undefined || extra.length) return false
    commands = shellCommands(payload)
  }
  return commands !== null && commands.every(readOnlyReader)
}
export function reviewToolAllowed(toolName, input, notesFile) {
  if (["Read", "Glob", "Grep", "Skill"].includes(toolName)) return true;
  if (toolName === "Write") return input?.file_path === notesFile;
  if (toolName === "Bash") return readOnlyShell(String(input?.command ?? ""))
  return false;
}

// Invalid reviewer output must not count as a clean review.
export function parseNotes(text) {
  const notes = JSON.parse(text);
  if (!Array.isArray(notes)) throw new Error("Review notes must be a JSON array");
  return notes.map(note => {
    if (typeof note === "string") return { blocking: true, text: note.trim() };
    if (!note || typeof note.blocking !== "boolean" || typeof note.text !== "string") {
      throw new Error("Review notes require blocking (boolean) and text (string)");
    }
    return { blocking: note.blocking, text: note.text.trim() };
  }).filter(note => note.text);
}
