import test from "node:test"
import assert from "node:assert/strict"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import fs from "node:fs"
import { execFileSync } from "node:child_process"
import { checkVendorCalls } from "./call-check.mjs"

const tree = "app/libs/vendor"
const target = `${tree}/acme/Client.php`
const client = `<?php
namespace Acme;
class Client {
  public function dangerous() {
    query($input);
  }
}
`
const hit = (file = target, line = 5, vendorTree = tree) => ({ vendorTree, path: file, start: { line }, check_id: "test.sql" })

function fixture(t, files) {
  const directory = fs.realpathSync(mkdtempSync(path.join(os.tmpdir(), "vendor-call-check-")))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  for (const [file, source] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(directory, file)), { recursive: true })
    writeFileSync(path.join(directory, file), source)
  }
  return directory
}

function check(t, app, files = {}, finding = hit(), trees = [tree]) {
  const directory = fixture(t, { [target]: client, "app/index.php": app, ...files })
  return checkVendorCalls(directory, trees, [finding])[0]
}

function called(result, file = "app/index.php", line = 2) {
  assert.equal(result.status, "called", result.evidence)
  assert.deepEqual(result.caller, { path: file, line })
}

function status(result, expected) {
  assert.equal(result.status, expected, result.evidence)
  assert.equal(result.caller, null)
  assert.ok(result.evidence.length > 0)
  assert.ok(!result.evidence.includes("\n"))
}

test("new reaches a constructor and reports its app line", t => {
  const source = client.replace("dangerous", "__construct")
  called(check(t, "<?php\nnew \\Acme\\Client();", { [target]: source }))
})

test("a use alias resolves a static method call", t => {
  called(check(t, "<?php use Acme\\Client as Api;\nApi::dangerous();"))
})

test("a fully qualified call resolves through a Composer classmap without a use import", t => {
  const result = check(t, "<?php\n\\Acme\\Client::dangerous();", {
    [target]: client.replace("namespace Acme;", ""),
    [`${tree}/composer/autoload_classmap.php`]: `<?php
$vendorDir = dirname(__DIR__);
$baseDir = dirname($vendorDir);
return array(
  'Acme\\\\Client' => $vendorDir . '/acme/Client.php',
);
`,
  }, hit(target, 4))
  called(result)
})

test("functions from autoload_files are reached through function imports", t => {
  const file = `${tree}/acme/functions.php`
  const result = check(t, "<?php use function Acme\\dangerous as run;\nrun($input);", {
    [file]: "<?php\nnamespace Acme;\nfunction dangerous($input) {\nquery($input);\n}",
    [`${tree}/composer/autoload_files.php`]: `<?php
return array(
  'hash' => __DIR__ . '/../acme/functions.php',
);
`,
  }, hit(file, 4))
  called(result)
  assert.match(result.evidence, /autoloaded/)
})

test("a global function call needs no class reference", t => {
  const file = `${tree}/acme/functions.php`
  called(check(t, "<?php\ndangerous($input);", { [file]: "<?php function dangerous($input) {\nquery($input);\n}" }, hit(file, 2)))
})

test("follows one vendor helper back to the app call", t => {
  const result = check(t, "<?php\n\\Acme\\helper();", {
    [`${tree}/acme/helpers.php`]: "<?php namespace Acme;\nfunction helper() { Client::dangerous(); }",
  })
  called(result)
  assert.match(result.evidence, /acme\\helper -> acme\\client::dangerous/)
})

test("follows three vendor callers and stops safely at a fourth", t => {
  const helpers = {
    [`${tree}/acme/helpers.php`]: `<?php namespace Acme;
function first() { Client::dangerous(); }
function second() { first(); }
function third() { second(); }
function fourth() { third(); }
`,
  }
  called(check(t, "<?php\n\\Acme\\third();", helpers))
  status(check(t, "<?php\n\\Acme\\fourth();", helpers), "unknown")
})

for (const app of [
  '<?php\n$class = "Acme\\\\Client"; new $class();',
  '<?php\n$class = "Acme/Client";',
  '<?php\ncall_user_func("dangerous", $input);',
  '<?php\ncall_user_func_array(["Acme\\\\Client", "dangerous"], []);',
  '<?php\n$class::$method($input);',
  '<?php\n$obj->$method($input);',
  '<?php\nnew $class();',
  '<?php\n$obj->{"dangerous"}($input);',
]) {
  test(`dynamic calls remain unknown: ${app.split("\n")[1]}`, t => {
    status(check(t, app), "unknown")
  })
}

test("a method call without its class reference is unknown", t => {
  status(check(t, "<?php\n$obj->dangerous($input);"), "unknown")
})

for (const reference of [
  "new \\Acme\\Client();",
  "function handle(\\Acme\\Client $client): \\Acme\\Client { return $client; }",
  "class Child extends \\Acme\\Client {}",
  "class Child implements \\Acme\\Client {}",
  "$yes = $obj instanceof \\Acme\\Client;",
]) {
  test(`class references support object method calls: ${reference}`, t => {
    called(check(t, `<?php ${reference}\n$obj->dangerous($input);`))
  })
}

test("class references can appear in a different app file", t => {
  called(check(t, "<?php\n$obj->dangerous($input);", { "app/types.php": "<?php function handle(\\Acme\\Client $client) {}" }))
})

test("a use import also supplies the class reference for object methods", t => {
  called(check(t, "<?php use Acme\\Client as Api;\n$obj->dangerous($input);"))
})

test("a class reference alone does not call an ordinary method", t => {
  status(check(t, "<?php\nnew \\Acme\\Client();"), "not called")
})

test("magic __call makes unresolved calls unknown", t => {
  status(check(t, "<?php unrelated();", {
    [target]: client.replace("class Client {", "class Client {\n public function __call($name, $args) {}"),
  }, hit(target, 6)), "unknown")
})

test("magic __callStatic on a parent makes unresolved calls unknown", t => {
  status(check(t, "<?php unrelated();", {
    [target]: client.replace("class Client {", "class Client extends Base {"),
    [`${tree}/acme/Base.php`]: "<?php namespace Acme; class Base { public static function __callStatic($name, $args) {} }",
  }), "unknown")
})

test("an unrelated app has no caller", t => {
  status(check(t, "<?php\nfunction other() { return true; }"), "not called")
})

test("vendor code is never reported as the app caller", t => {
  status(check(t, "<?php unrelated();", {
    [`${tree}/entry.php`]: "<?php \\Acme\\Client::dangerous();",
  }), "not called")
})

test("all supplied vendor trees are excluded from app callers", t => {
  const other = "cli/vendor"
  status(check(t, "<?php unrelated();", { [`${other}/entry.php`]: "<?php \\Acme\\Client::dangerous();" }, hit(), [tree, other]), "not called")
})

test("file-level hits are unknown unless app code includes their file", t => {
  const file = `${tree}/boot.php`
  const files = { [file]: "<?php\nquery($input);" }
  status(check(t, "<?php unrelated();", files, hit(file, 2)), "unknown")
  called(check(t, `<?php\nrequire __DIR__ . '/libs/vendor/boot.php';`, files, hit(file, 2)))
  called(check(t, `<?php\nrequire 'libs/vendor/boot.php';`, files, hit(file, 2)))
})

test("autoload_files file-level code resolves to the app autoloader include", t => {
  const file = `${tree}/boot.php`
  called(check(t, "<?php\nrequire __DIR__ . '/libs/vendor/autoload.php';", {
    [file]: "<?php\nquery($input);",
    [`${tree}/composer/autoload_files.php`]: `<?php return array(
  'hash' => __DIR__ . '/../boot.php',
);`,
  }, hit(file, 2)))
})

test("autoloaded vendor entry code stays unknown without an app include site", t => {
  status(check(t, "<?php unrelated();", {
    [`${tree}/boot.php`]: "<?php \\Acme\\Client::dangerous();",
    [`${tree}/composer/autoload_files.php`]: "<?php return ['hash' => __DIR__ . '/../boot.php'];",
  }), "unknown")
})

test("comments and string braces do not change the enclosing method", t => {
  const source = `<?php
namespace Acme {
class Client {
  /* function fake() { } */
  function dangerous() {
    $text = '} function fake() {';
    // } }
    query($input);
  }
}
}`
  called(check(t, "<?php use Acme\\Client;\nClient::dangerous();", { [target]: source }, hit(target, 8)))
})

test("heredoc braces and inline HTML cannot become declarations or calls", t => {
  const source = `<?php
namespace Acme;
class Client {
  function dangerous() {
    $text = <<<'TEXT'
} function fake() {
TEXT;
    query($input);
  }
}`
  called(check(t, "<?php use Acme\\Client;\nClient::dangerous();", { [target]: source }, hit(target, 8)))
  status(check(t, "Acme\\Client::dangerous();\n<?php unrelated();"), "not called")
})

test("grouped use aliases resolve within bracketed namespaces", t => {
  called(check(t, "<?php namespace App { use Acme\\{Client as Api};\nApi::dangerous(); }"))
})

test("self calls inside a vendor method are traced through the enclosing method", t => {
  const result = check(t, "<?php\n\\Acme\\Client::entry();", {
    [target]: client.replace("class Client {", "class Client {\n public static function entry() { self::dangerous(); }"),
  }, hit(target, 6))
  called(result)
  assert.match(result.evidence, /acme\\client::entry/)
})

test("calls through a subclass reach its inherited vendor method", t => {
  called(check(t, "<?php class Child extends \\Acme\\Client {}\nChild::dangerous();"))
})

test("calls through a trait user reach the vendor method", t => {
  called(check(t, "<?php class Child { use \\Acme\\Client; }\nChild::dangerous();", {
    [target]: client.replace("class Client", "trait Client"),
  }))
})

for (const adaptation of [
  "dangerous as run;",
  "\\Acme\\Client::dangerous insteadof Other; \\Acme\\Client::dangerous as run;",
]) {
  test(`trait adaptations cannot rule out the vendor method: ${adaptation}`, t => {
    status(check(t, "<?php\nChild::run();", {
      [target]: client.replace("class Client", "trait Client"),
      [`${tree}/Child.php`]: `<?php trait Other { function dangerous() {} }
class Child { use \\Acme\\Client, Other { ${adaptation} } }`,
    }), "unknown")
  })
}

test("app trait aliases cannot rule out the vendor method", t => {
  status(check(t, "<?php class Child { use \\Acme\\Client { dangerous as run; } }\nChild::run();", {
    [target]: client.replace("class Client", "trait Client"),
  }), "unknown")
})

test("PSR-4 maps recover an unqualified class name", t => {
  called(check(t, "<?php\n\\Acme\\Client::dangerous();", {
    [target]: client.replace("namespace Acme;", ""),
    [`${tree}/composer/autoload_psr4.php`]: `<?php
return array(
 'Acme\\\\' => array(__DIR__ . '/../acme'),
);
`,
  }, hit(target, 4)))
})

test("PSR-0 maps recover a class namespace from its path", t => {
  const file = `${tree}/legacy/Acme/Client.php`
  called(check(t, "<?php\n\\Acme\\Client::dangerous();", {
    [file]: client.replace("namespace Acme;", ""),
    [`${tree}/composer/autoload_namespaces.php`]: `<?php
return array(
 'Acme\\\\' => array(__DIR__ . '/../legacy'),
);
`,
  }, hit(file, 4)))
})

test("compact Composer array syntax resolves classmap and autoload_files entries", t => {
  called(check(t, "<?php\n\\Acme\\Client::dangerous();", {
    [target]: client.replace("namespace Acme;", ""),
    [`${tree}/composer/autoload_classmap.php`]: "<?php return ['Acme\\\\Client' => __DIR__ . '/../acme/Client.php'];",
  }, hit(target, 4)))
  const file = `${tree}/boot.php`
  called(check(t, "<?php\nrequire __DIR__ . '/libs/vendor/autoload.php';", {
    [file]: "<?php query($input);",
    [`${tree}/composer/autoload_files.php`]: "<?php return ['hash' => __DIR__ . '/../boot.php'];",
  }, hit(file, 1)))
})

test("classmap recovery also resolves self calls through vendor helpers", t => {
  called(check(t, "<?php\n\\Acme\\Client::entry();", {
    [target]: client.replace("namespace Acme;", "").replace("class Client {", "class Client {\npublic static function entry() { self::dangerous(); }"),
    [`${tree}/composer/autoload_classmap.php`]: "<?php return ['Acme\\\\Client' => __DIR__ . '/../acme/Client.php'];",
  }))
})

test("eval prevents a negative conclusion", t => {
  status(check(t, "<?php eval($code);"), "unknown")
})

test("a missing hit file is unknown", t => {
  status(check(t, "<?php unrelated();", {}, hit(`${tree}/missing.php`, 1)), "unknown")
})

test("an unreadable hit file is unknown", t => {
  const directory = fixture(t, { [target]: client })
  chmodSync(path.join(directory, target), 0)
  status(checkVendorCalls(directory, [tree], [hit()])[0], "unknown")
})

for (const source of [
  client.replace("query($input);", "query($input); /* unfinished"),
  client.slice(0, -3),
  client.replace("query($input);", '$text = "unfinished;'),
  "<?php function broken { query($input); }",
]) {
  test(`broken PHP returns unknown: ${source.slice(-35)}`, t => {
    status(check(t, "<?php unrelated();", { [target]: source }), "unknown")
  })
}

test("a broken app file prevents a negative conclusion", t => {
  status(check(t, "<?php function broken( {"), "unknown")
})

test("matching dynamic strings in a vendor caller are unknown", t => {
  status(check(t, "<?php\n\\Acme\\helper();", {
    [`${tree}/acme/helpers.php`]: '<?php namespace Acme; function helper() { call_user_func("dangerous"); }',
  }), "unknown")
})

test("dynamic dispatch in a reachable vendor helper is unknown", t => {
  status(check(t, "<?php\n\\Acme\\helper();", {
    [`${tree}/acme/helpers.php`]: "<?php namespace Acme; function helper() { $obj->$method(); }",
  }), "unknown")
})

test("unresolved object methods in reachable vendor helpers are unknown", t => {
  status(check(t, "<?php\n\\Acme\\helper();", {
    [`${tree}/acme/helpers.php`]: "<?php namespace Acme; function helper() { $obj->dangerous(); }",
  }), "unknown")
})

test("an unrelated unreachable vendor string does not imply a caller", t => {
  status(check(t, "<?php unrelated();", {
    [`${tree}/acme/helpers.php`]: '<?php namespace Acme; function helper() { return "dangerous"; }',
  }), "not called")
})

test("a literal callback to an unrelated function does not imply a caller", t => {
  status(check(t, '<?php call_user_func("unrelated");'), "not called")
})

test("skips symlinks and .git rather than following their PHP code", t => {
  const directory = fixture(t, { [target]: client, ".git/ignored.php": "<?php \\Acme\\Client::dangerous();", "external.txt": "<?php \\Acme\\Client::dangerous();" })
  symlinkSync(path.join(directory, "external.txt"), path.join(directory, "linked.php"))
  symlinkSync(path.join(directory, ".git"), path.join(directory, "linked-directory"))
  status(checkVendorCalls(directory, [tree], [hit()])[0], "not called")
})

test("ignores app hits and preserves vendor-hit order", t => {
  const directory = fixture(t, { [target]: client, "app/index.php": "<?php\n\\Acme\\Client::dangerous();" })
  const results = checkVendorCalls(directory, [tree], [hit("app/index.php", 2, null), hit(), hit(`${tree}/missing.php`, 1)])
  assert.equal(results.length, 2)
  called(results[0])
  status(results[1], "unknown")
  assert.deepEqual(checkVendorCalls("/missing", [tree], [hit("app/index.php", 2, null)]), [])
})

test("ambiguous functions on the same hit line stay unknown", t => {
  status(check(t, "<?php \\Acme\\Client::dangerous();", {
    [target]: "<?php namespace Acme; class Client { function other() {} function dangerous() { query($input); } }",
  }, hit(target, 1)), "unknown")
})

test("reads each PHP file once even with many vendor hits", t => {
  const directory = fixture(t, {
    [target]: client,
    "app/index.php": "<?php\n\\Acme\\Client::dangerous();",
    [`${tree}/composer/autoload_classmap.php`]: "<?php return [];",
  })
  const reads = new Map()
  const original = fs.readFileSync
  fs.readFileSync = (file, ...args) => {
    if (String(file).startsWith(directory)) reads.set(String(file), (reads.get(String(file)) || 0) + 1)
    return original(file, ...args)
  }
  t.after(() => {
    fs.readFileSync = original
  })
  const results = checkVendorCalls(directory, [tree], Array.from({ length: 105 }, () => hit()))
  assert.equal(results.length, 105)
  assert.ok(results.every(result => result.status === "called"))
  assert.equal(reads.size, 3)
  assert.ok([...reads.values()].every(count => count === 1))

  writeFileSync(path.join(directory, "app/index.php"), "<?php\n$label = 'prefix DANGEROUS suffix';")
  reads.clear()
  const unknowns = checkVendorCalls(directory, [tree], Array.from({ length: 105 }, () => hit()))
  for (const result of unknowns) {
    status(result, "unknown")
    assert.match(result.evidence, /app\/index\.php:2\b/)
  }
  assert.equal(reads.size, 3)
  assert.ok([...reads.values()].every(count => count === 1))
})

test("unchanged classmap names finish with many classes and call keys", { timeout: 20000 }, t => {
  const names = Array.from({ length: 512 }, (_, i) => `Client${i}`)
  const directory = fixture(t, {
    [target]: "<?php\n" + names.map(name => `class ${name} {\n  static function entry() { self::dangerous(); }\n  static function dangerous() { query($input); }\n}`).join("\n"),
    [`${tree}/composer/autoload_classmap.php`]: "<?php return [\n" + names.map(name => `'${name}' => __DIR__ . '/../acme/Client.php',`).join("\n") + "\n];",
    "app/index.php": "<?php\nClient0::entry();",
  })
  // A child timeout catches a growing array iterator without hanging the test runner.
  const script = `import { checkVendorCalls } from ${JSON.stringify(new URL("./call-check.mjs", import.meta.url).href)}
console.log(JSON.stringify(checkVendorCalls(${JSON.stringify(directory)}, ${JSON.stringify([tree])}, ${JSON.stringify([hit(target, 4)])})))`
  const output = execFileSync(process.execPath, ["--eval", script], { encoding: "utf8", timeout: 15000, killSignal: "SIGKILL" })
  const results = JSON.parse(output)
  assert.equal(results.length, 1)
  called(results[0])
  assert.match(results[0].evidence, /client0::entry -> client0::dangerous/)
})

for (const method of ["__call", "__callStatic", "__construct", "__destruct", "__toString", "__get", "__set", "__isset", "__unset", "__invoke", "__wakeup", "__unserialize", "__sleep", "__serialize", "__clone", "__set_state", "__debugInfo", "offsetGet", "offsetSet", "offsetExists", "offsetUnset", "getIterator", "current", "key", "next", "rewind", "valid", "count", "jsonSerialize"]) {
  test(`implicit ${method} is called by a class reference and never ruled out`, t => {
    const files = { [target]: client.replace("dangerous", method) }
    called(check(t, "<?php\nnew \\Acme\\Client();", files))
    called(check(t, "<?php\nfunction consume(\\Acme\\Client $client) {}", files))
    status(check(t, "<?php unrelated();", files), "unknown")
  })
}

test("implicit methods trace through a vendor factory and an inherited class", t => {
  const result = check(t, "<?php\n\\Acme\\factory();", {
    [target]: client.replace("dangerous", "__destruct"),
    [`${tree}/factory.php`]: "<?php namespace Acme; class Child extends Client {}\nfunction factory() { return new Child(); }",
  })
  called(result)
})

for (const callback of [
  "call_user_func('Acme\\\\Client::dangerous');",
  "call_user_func_array('Acme\\\\Client::dangerous', []);",
  "$callback = 'Acme\\\\Client::dangerous'; $callback();",
  "call_user_func([Client::class, 'dangerous']);",
  "call_user_func(['Acme\\\\Client', 'dangerous']);",
  "call_user_func(array(Client::class, 'dangerous'));",
]) {
  test(`callable cannot be ruled out: ${callback}`, t => {
    status(check(t, `<?php use Acme\\Client;\n${callback}`), "unknown")
  })
}

test("a matching static callback in a reachable vendor helper stays unknown", t => {
  status(check(t, "<?php\n\\Acme\\helper();", {
    [`${tree}/helper.php`]: "<?php namespace Acme; function helper() { call_user_func('Acme\\\\Client::dangerous'); }",
  }), "unknown")
})

for (const callback of [
  "call_user_func('Child::dangerous');",
  "call_user_func_array('Grandchild::dangerous', []);",
  "call_user_func([Grandchild::class, 'dangerous']);",
]) {
  test(`inherited callbacks cannot rule out the vendor method: ${callback}`, t => {
    status(check(t, `<?php class Child extends \\Acme\\Client {}\nclass Grandchild extends Child {}\n${callback}`), "unknown")
    // Keep the method name out of app code to test callback matching independently of the safety net.
    status(check(t, "<?php\nhelper();", {
      [`${tree}/helper.php`]: `<?php class Child extends \\Acme\\Client {}
class Grandchild extends Child {}
function helper() { ${callback} }`,
    }), "unknown")
  })
}

for (const mention of [
  "function DANGEROUS() {}",
  "const DANGEROUS = true;",
  "use function Other\\DANGEROUS as unrelated;",
  "$label = 'prefix DANGEROUS suffix';",
  "$label = 'Other::DANGEROUS';",
]) {
  test(`app name safety net reports the first match: ${mention}`, t => {
    const result = check(t, `<?php unrelated();\n${mention}\nfunction dangerous() {}`, {
      "app/z-later.php": "<?php function dangerous() {}",
    })
    status(result, "unknown")
    assert.match(result.evidence, /app\/index\.php:2\b/)
  })
}

test("the name safety net reports the matching line inside a multiline string", t => {
  const result = check(t, "<?php\n$label = 'prefix\nDANGEROUS suffix';")
  status(result, "unknown")
  assert.match(result.evidence, /app\/index\.php:3\b/)
})

test("the name safety net also checks namespaced function names", t => {
  const file = `${tree}/acme/functions.php`
  const result = check(t, "<?php\nfunction DANGEROUS() {}", {
    [file]: "<?php namespace Acme;\nfunction dangerous() { query($input); }",
  }, hit(file, 2))
  status(result, "unknown")
  assert.match(result.evidence, /app\/index\.php:2\b/)
})

test("the name safety net excludes every vendor tree and nonmatching app tokens", t => {
  const other = "cli/vendor"
  status(check(t, "<?php // dangerous\nfunction notDangerous() {} $dangerous = true;", {
    [`${other}/entry.php`]: "<?php function dangerous() {} $label = 'prefix dangerous suffix';",
  }, hit(), [tree, other]), "not called")
})

test("unrelated static callback strings do not reach the target", t => {
  status(check(t, "<?php call_user_func('Other\\\\Client::other');"), "not called")
})

for (const extension of ["inc", "phtml", "php5", "phps", "module", "tpl"]) {
  test(`indexes PHP code in .${extension} files`, t => {
    called(check(t, "<?php unrelated();", { [`app/caller.${extension}`]: "HTML\n<?php \\Acme\\Client::dangerous();" }), `app/caller.${extension}`)
  })
}

test("an existing include with an unindexed extension prevents a negative conclusion", t => {
  status(check(t, "<?php require __DIR__ . '/caller.custom';", {
    "app/caller.custom": "<?php \\Acme\\Client::dangerous();",
  }), "unknown")
})

test("files over 2 MB are not read and prevent a negative conclusion", t => {
  const large = "<?php /*" + "x".repeat(2 * 1024 * 1024) + "*/ \\Acme\\Client::dangerous();"
  const directory = fixture(t, { [target]: client, "app/large.php": large })
  const original = fs.readFileSync
  let oversizedReads = 0
  fs.readFileSync = (file, ...args) => {
    if (String(file).endsWith("large.php")) oversizedReads++
    return original(file, ...args)
  }
  t.after(() => { fs.readFileSync = original })
  status(checkVendorCalls(directory, [tree], [hit()])[0], "unknown")
  assert.equal(oversizedReads, 0)
})

test("the total token budget prevents a negative conclusion when later files are skipped", { timeout: 20000 }, t => {
  const directory = fixture(t, { [target]: client, "m-budget.php": "<?php " + ";".repeat(100), "z-caller.php": "<?php \\Acme\\Client::dangerous();" })
  const source = fs.readFileSync(new URL("./call-check.mjs", import.meta.url), "utf8")
  assert.match(source, /const MAX_TOTAL_TOKENS = \d+/)
  const script = path.join(directory, "bounded.mjs")
  writeFileSync(script, source.replace(/const MAX_TOTAL_TOKENS = \d+/, "const MAX_TOTAL_TOKENS = 64").replace('"./agent-fs.mjs"', JSON.stringify(new URL("./agent-fs.mjs", import.meta.url).href)))
  const result = execFileSync(process.execPath, ["--eval", `
    import fs from "node:fs"
    import { checkVendorCalls } from ${JSON.stringify(script)}
    const readdir = fs.readdirSync
    fs.readdirSync = (...args) => readdir(...args).sort((a, b) => a.name.localeCompare(b.name))
    console.log(JSON.stringify(checkVendorCalls(${JSON.stringify(directory)}, [${JSON.stringify(tree)}], [${JSON.stringify(hit())}])))
  `], { encoding: "utf8", timeout: 15000, killSignal: "SIGKILL" })
  const finding = JSON.parse(result)[0]
  status(finding, "unknown")
  assert.equal(finding.function, "acme\\client::dangerous")
})

for (const extension of ["inc", "phtml", "php5"]) {
  test(`indexes short PHP tags in .${extension} files`, t => {
    called(check(t, "<?php unrelated();", { [`app/caller.${extension}`]: "HTML\n<? \\Acme\\Client::dangerous();" }), `app/caller.${extension}`)
  })
}

test("reports the enclosing method for ignored finding IDs", t => {
  const result = check(t, "<?php unrelated();")
  status(result, "not called")
  assert.equal(result.function, "acme\\client::dangerous")
})


test("helpers reached through an implicit method remain uncertain without an app reference", t => {
  const files = { [target]: client.replace("class Client {", "class Client {\n public function __destruct() { $this->dangerous(); }") }
  called(check(t, "<?php\nnew \\Acme\\Client();", files, hit(target, 6)))
  status(check(t, "<?php unrelated();", files, hit(target, 6)), "unknown")
})
