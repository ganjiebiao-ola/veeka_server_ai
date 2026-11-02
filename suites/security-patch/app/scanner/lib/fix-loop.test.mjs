import { test } from "node:test";
import assert from "node:assert/strict";
import { fixLoop, parseNotes, reviewToolAllowed } from "./fix-loop.mjs";

const run = async (answers, opts = {}) => {
  const calls = [];
  const result = await fixLoop({
    inspect: async (round) => { calls.push(`inspect${round}`); return answers[round - 1] ?? []; },
    fix: async (_notes, round) => { calls.push(`fix${round}`); },
    ...opts,
  });
  return { ...result, calls };
};

test("review loop stops after 2 rounds even when notes remain", async () => {
  const r = await run([["a"], ["b"], ["c"]], { recheck: false });
  assert.deepEqual(r.calls, ["inspect1", "fix1", "inspect2", "fix2"]);
  assert.equal(r.clean, false);
});

test("loop stops early when an inspection is clean", async () => {
  const r = await run([["a"], []], { recheck: false });
  assert.deepEqual(r.calls, ["inspect1", "fix1", "inspect2"]);
  assert.deepEqual([r.clean, r.rounds], [true, 1]);
  assert.deepEqual((await run([[]])).calls, ["inspect1"]);
});

test("check loop rechecks after the last fix", async () => {
  const fail = await run([["x"], ["x"], ["x"]]);
  assert.deepEqual(fail.calls, ["inspect1", "fix1", "inspect2", "fix2", "inspect3"]);
  assert.equal(fail.clean, false);
  const pass = await run([["x"], ["x"], []]);
  assert.equal(pass.clean, true);
});

test("review session may only read and write its notes file", () => {
  const notes = "/workspace/artifacts/review-1.json";
  for (const tool of ["Read", "Glob", "Grep"]) assert.equal(reviewToolAllowed(tool, {}, notes), true);
  assert.equal(reviewToolAllowed("Write", { file_path: notes }, notes), true);
  assert.equal(reviewToolAllowed("Write", { file_path: "/workspace/repo/a.php" }, notes), false);
  assert.equal(reviewToolAllowed("Edit", {}, notes), false);
  assert.equal(reviewToolAllowed("Bash", { command: "git diff abc123" }, notes), true);
  assert.equal(reviewToolAllowed("Bash", { command: "git -C /workspace/repo show HEAD~1 --stat" }, notes), true);
  // Native reviewers read through the shell, including one `bash -lc` wrapper and ; / && chains.
  for (const command of ["cat a.php", "pwd && rg --files", "sed -n '290,420p' /root/SKILL.md",
    `/bin/bash -lc "cat /workspace/repo/src/lookup.php; sed -n '1,20p' /root/SKILL.md"`]) {
    assert.equal(reviewToolAllowed("Bash", { command }, notes), true, command);
  }
  for (const command of ["git diff; rm -rf /", "git commit -m x", "git diff $(id)", "git log | sh",
    "git diff --output=/workspace/repo/a.php", `printf '%s' '[]' > ${notes}`, "cat a.php > b.php",
    "cat a.php & id", `/bin/bash -lc "cat a.php; rm -rf /"`, `/bin/bash -lc "cat a.php" ; id "x"`]) {
    assert.equal(reviewToolAllowed("Bash", { command }, notes), false, command);
  }
});

test("review shell readers cannot execute commands or write files", () => {
  for (const command of ['cat a.php\ntouch stolen', '/bin/bash -lc "cat a.php\ntouch stolen"',
    "find . -delete", 'find . -exec touch stolen +', "sed -n '1w stolen' a.php",
    "sed -n '1e touch stolen' a.php", "sed -n '1p' -e '1w stolen' a.php",
    "rg --pre='touch stolen' pattern .", 'rg --hostname-bin=./untrusted --heading pattern .', 'file -C -m magic']) {
    assert.equal(reviewToolAllowed('Bash', { command }, '/workspace/artifacts/review-1.json'), false, command)
  }
})

test("review reader options are checked after shell quote and escape decoding", () => {
  const forms = word => [word, `'${word}'`, `"${word}"`, word.replace(/[-=]/g, "\\$&"),
    word.replace(/([a-z])/, "'$1'"), word.replace(/([a-z])/, '"$1"'), word.replace(/([a-z])/, "\\$1")]
  const commands = [
    ["rg", "--pre=./pre", "needle input.txt"],
    ["rg", "--pre", "./pre needle input.txt"],
    ["rg", "--pre-glob=*.txt", "needle input.txt"],
    ["rg", "--pre-glob", "input.txt needle input.txt"],
    ["rg needle input.txt", "--pre=./pre", ""],
    ["rg", "--hostname-bin=./pre", "needle input.txt"],
    ["rg", "--search-zip", "needle input.txt"],
    ["rg", "-z", "needle input.txt"],
    ["find .", "-exec", "./pre +"],
    ["find .", "-execdir", "./pre +"],
    ["find .", "-ok", "./pre +"],
    ["find .", "-okdir", "./pre +"],
    ["find .", "-delete", ""],
    ["find .", "-fprint", "stolen"],
    ["find .", "-fprintf", "stolen '%p'"],
    ["find .", "-fls", "stolen"],
    ["find .", "-fprint0", "stolen"],
    ["sed", "-i", "'1p' input.txt"],
    ["sed -n", "1w stolen", "input.txt"],
    ["sed -n", "1p", "-e 'w stolen' input.txt"],
    ["sort", "-o", "stolen input.txt"],
    ["git diff", "--output=stolen", ""],
    ["git show", "--ext-diff", "HEAD"],
    ["git log", "--output", "stolen"],
    ["cat", "--output=stolen", "input.txt"],
    ["head", "--output=stolen", "input.txt"],
    ["tail", "--output=stolen", "input.txt"],
    ["wc", "--output=stolen", "input.txt"],
    ["stat", "--output=stolen", "input.txt"],
    ["ls", "--output=stolen", "input.txt"],
    ["pwd", "--output=stolen", ""],
  ]
  for (const [reader, option, rest] of commands) {
    for (const form of forms(option)) {
      const command = `${reader} ${form} ${rest}`.trim()
      assert.equal(reviewToolAllowed("Bash", { command }, "notes.json"), false, command)
      const wrapped = `/bin/bash -lc '${command.replaceAll("'", "'\\''")}'`
      assert.equal(reviewToolAllowed("Bash", { command: wrapped }, "notes.json"), false, wrapped)
    }
  }
  for (const command of ["xargs ./pre", "tee stolen", "rg needle input.txt >stolen",
    "cat input.txt 2>>stolen", "cat input.txt | tee stolen", "cat <(./pre)",
    'rg "$(./pre)" input.txt', "rg `./pre` input.txt", "rg $'--pre=./pre' needle input.txt",
    "rg needle *", "cat input.txt # comment", "cat 'input.txt", 'cat "input.txt', "cat input.txt\\",
    "\u00a0cat input.txt", "constructor input.txt", '"rg" "--pre=./pre" needle input.txt',
    'bash -lc "cat input.txt" ignored', 'bash -ic "cat input.txt"', "cat input.txt &&"]) {
    assert.equal(reviewToolAllowed("Bash", { command }, "notes.json"), false, command)
  }
})

test("review readers keep safe quoted arguments and options", () => {
  for (const command of ["rg '-n' needle 'input file.txt'", 'rg "--context=2" needle input.txt',
    "rg --glob='*.php' needle .", "rg -nC2 needle input.txt", "rg -e '--pre=./pre' input.txt",
    "rg -- '--pre=./pre' input.txt", "rg 'needle; still data && data' input.txt", "rg 'foo$' input.txt",
    "rg needle input\\ file.txt", "rg -\\n needle input.txt", 'rg "-n" needle input.txt',
    'rg n"ee"dle input.txt', "cat -- '-file.txt'", "ls -lah .", "head -n20 input.txt",
    "tail --lines=20 input.txt", "wc -l input.txt", "stat --format='%s' input.txt",
    "sed '-n' '1,20p' 'input file.txt'", "git diff '--stat' HEAD", "git log -n 2 --oneline",
    '/bin/bash -lc "rg -n \\"needle\\" input.txt"',
    "bash -lc 'cat input.txt && sed -n '\\''1p'\\'' input.txt'"]) {
    assert.equal(reviewToolAllowed("Bash", { command }, "notes.json"), true, command)
  }
})

test("normal review reads stay allowed", () => {
  for (const command of [
    "git diff abc123", "git diff --stat", "git log --oneline -5", "git show HEAD:path",
    "rg -n pattern path", "rg -n -C 3 pattern", "grep -rn pattern dir", "sed -n 1,80p file",
    "cat file", "head -n 50 file", "tail -n 50 file", "ls -la dir", "wc -l file",
    "find dir -name '*.php' -type f",
  ]) {
    assert.equal(reviewToolAllowed("Bash", { command }, "notes.json"), true, command)
  }
})

test("git optional values never hide write or execution options", () => {
  for (const reader of ["git diff", "git show", "git log", "git log --pretty", "git log --format",
    "git diff -U", "git diff -U3", "git log --pretty=oneline", "git log --format=%s"]) {
    for (const option of ["--output=written-log", "--output written-log", "-o written-log", "-owritten-log",
      "--ext-diff", "--ext-diff=true", "--textconv", "--textconv=true",
      "-c core.pager=./untrusted", "-ccore.pager=./untrusted", "--config core.pager=./untrusted",
      "--config=core.pager=./untrusted", "--config-env=core.pager=PAGER",
      "--exec-path ./untrusted", "--exec-path=./untrusted"]) {
      const command = `${reader} ${option}`
      assert.equal(reviewToolAllowed("Bash", { command }, "notes.json"), false, command)
    }
  }
  for (const command of ["git -c core.pager=./untrusted log", "git -ccore.pager=./untrusted log",
    "git --config-env=core.pager=PAGER log", "git --exec-path=./untrusted log",
    "git log --since --output=written-log", "git log --author --ext-diff",
    "git log --max-count --output=written-log", "git log -n --output=written-log",
    "git diff -S --output=written-diff", "git diff -G --ext-diff"]) {
    assert.equal(reviewToolAllowed("Bash", { command }, "notes.json"), false, command)
  }
})

test("git accepts optional attached values and numeric history limits", () => {
  for (const command of ["git log --pretty --oneline", "git log --pretty=oneline -5",
    "git log --format --oneline", "git log --format=%s -5", "git diff -U --stat", "git diff -U3 --stat",
    "git log --oneline -1", "git log --oneline -50", "git log --oneline -n 5",
    "git log --oneline -n5", "git log --oneline --max-count=5", "git log --oneline --max-count 5"]) {
    assert.equal(reviewToolAllowed("Bash", { command }, "notes.json"), true, command)
  }
})

test("find accepts read-only predicates and rejects actions after them", () => {
  for (const command of ["find dir", "find dir -iname '*.php' -path './src/*' -type f -print",
    "find dir -maxdepth 3 -mindepth 1 -size +1k -newer reference -prune",
    "find dir -not -name '*.txt' -a -type f -o -type d", "find dir ! -name '*.txt' -print",
    "find dir \\( -name '*.php' -o -iname '*.js' \\) -a -type f", "find dir '(' -type f ')' -print",
    "find dir -name '-delete' -print"]) {
    assert.equal(reviewToolAllowed("Bash", { command }, "notes.json"), true, command)
  }
  for (const action of ["-exec ./untrusted +", "-execdir ./untrusted +", "-ok ./untrusted +",
    "-okdir ./untrusted +", "-delete", "-fprint stolen", "-fprintf stolen '%p'", "-fls stolen", "-fprint0 stolen"]) {
    const command = `find dir -name '*.php' -type f ${action}`
    assert.equal(reviewToolAllowed("Bash", { command }, "notes.json"), false, command)
  }
  for (const command of ["find dir -name", "find dir -type", "find -- dir -delete", "find dir -unknown"]) {
    assert.equal(reviewToolAllowed("Bash", { command }, "notes.json"), false, command)
  }
})

test("notes accept structured notes and legacy strings, rejecting malformed entries", () => {
  assert.deepEqual(parseNotes('["a", " ", "b"]'), [{ blocking: true, text: "a" }, { blocking: true, text: "b" }]);
  assert.deepEqual(parseNotes('[{"blocking":false,"text":" suggestion "},{"blocking":true,"text":"bug"}]'),
    [{ blocking: false, text: "suggestion" }, { blocking: true, text: "bug" }]);
  assert.deepEqual(parseNotes('[]'), []);
  for (const bad of ["", "{}", "null", "[oops", '["note", 3]', '[null]', '[{}]', '[{"blocking":"false","text":"bug"}]', '[{"blocking":true,"text":3}]' ]) assert.throws(() => parseNotes(bad));
});
