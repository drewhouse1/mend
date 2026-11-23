// Edge/adversarial suite for mend (SPEC.md corners the 100 public practice checks do not cover).
// Node 22, stdlib only. Run: `node tests/edge.mjs` from the repo root.
// Each case runs main.ts in a fresh temp dir and asserts exit code, stdout and the whole
// final tree byte-for-byte. These tests assert the SPEC as read in BUILD.md; they guard
// regressions, they are not a second source of truth.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const MAIN = resolve(dirname(process.argv[1]), '..', 'main.ts');

const C = (name, files, patch, argv, expect) => ({ name, files, patch, argv, expect });

function writeTree(dir, files) {
  for (const [p, content] of Object.entries(files)) {
    const full = join(dir, p);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
}

function readTree(dir, base = dir, out = {}) {
  for (const e of readdirSync(dir)) {
    const full = join(dir, e);
    const rel = full.slice(base.length + 1);
    if (statSync(full).isDirectory()) readTree(full, base, out);
    else out[rel] = readFileSync(full, 'utf8');
  }
  return out;
}

function runCase(c) {
  const dir = mkdtempSync(join(tmpdir(), 'mend-edge-'));
  try {
    writeTree(dir, c.files);
    const positional = c.argv.find((a) => !a.startsWith('-'));
    let input = null;
    if (positional !== undefined && c.patch !== null) {
      const full = join(dir, positional);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, c.patch);
    } else if (positional === undefined) {
      input = c.patch;
    }
    const r = spawnSync(process.execPath, [MAIN, ...c.argv], { cwd: dir, input, encoding: 'utf8' });
    const after = readTree(dir);
    const problems = [];
    if (r.status !== c.expect.exit) problems.push(`exit: got ${r.status}, want ${c.expect.exit}`);
    if (r.stdout !== c.expect.stdout) problems.push(`stdout: got ${JSON.stringify(r.stdout)}, want ${JSON.stringify(c.expect.stdout)}`);
    const wantFiles = { ...c.expect.files };
    if (positional !== undefined && c.patch !== null) wantFiles[positional] = c.patch;
    const keys = new Set([...Object.keys(after), ...Object.keys(wantFiles)]);
    for (const k of [...keys].sort()) {
      if (!(k in after)) problems.push(`file ${k}: missing, want ${JSON.stringify(wantFiles[k])}`);
      else if (!(k in wantFiles)) problems.push(`file ${k}: unexpected, got ${JSON.stringify(after[k])}`);
      else if (after[k] !== wantFiles[k]) problems.push(`file ${k}: got ${JSON.stringify(after[k])}, want ${JSON.stringify(wantFiles[k])}`);
    }
    if (r.stderr) problems.push(`stderr: ${JSON.stringify(r.stderr.slice(0, 300))}`);
    return problems;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const CASES = [];
const add = (...args) => CASES.push(C(...args));

// ---- Unified diff ----
add('u-crlf-file',
  { 'a.js': 'function f() {\r\n  return 1;\r\n}\r\n' },
  '--- a/a.js\n+++ b/a.js\n@@ -1,3 +1,3 @@\n function f() {\n-  return 1;\n+  return 2;\n }\n',
  ['p.diff'],
  { exit: 0, stdout: 'M a.js\nok: 1 file\n', files: { 'a.js': 'function f() {\r\n  return 2;\r\n}\r\n' } });
add('u-create-noeol',
  {},
  '--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1,2 @@\n+hello\n+world\n\\ No newline at end of file\n',
  ['p.diff'],
  { exit: 0, stdout: 'A new.txt\nok: 1 file\n', files: { 'new.txt': 'hello\nworld' } });
add('u-create-eol',
  {},
  '--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1,2 @@\n+hello\n+world\n',
  ['p.diff'],
  { exit: 0, stdout: 'A new.txt\nok: 1 file\n', files: { 'new.txt': 'hello\nworld\n' } });
add('u-del-parse-error',
  { 'old.txt': 'a\nb\n' },
  '--- a/old.txt\n+++ /dev/null\n@@ -x +y @@\n-a\n',
  ['p.diff'],
  { exit: 2, stdout: 'error: parse 3\n', files: { 'old.txt': 'a\nb\n' } });
add('u-rename-only',
  { 'a.txt': 'one\ntwo\n' },
  'diff --git a/a.txt b/b.txt\nrename from a.txt\nrename to b.txt\n@@ -1,2 +1,2 @@\n one\n-two\n+three\n',
  ['p.diff'],
  { exit: 0, stdout: 'R a.txt -> b.txt\nok: 1 file\n', files: { 'b.txt': 'one\nthree\n' } });
add('u-header-lone-dashes',
  { 'a.txt': 'one\n' },
  'diff --git a/a.txt b/a.txt\n--- a/a.txt\nindex 123..456\n',
  ['p.diff'],
  { exit: 2, stdout: 'error: parse 3\n', files: { 'a.txt': 'one\n' } });
add('u-lone-dashes-prose',
  { 'a.txt': 'one\n' },
  '--- a/a.txt\nindex 123..456\n',
  ['p.diff'],
  // A lone `--- ` line before any section is prose, not a header: no format is detected.
  { exit: 2, stdout: 'error: format\n', files: { 'a.txt': 'one\n' } });
add('u-hunk-before-section',
  { 'a.txt': 'one\n' },
  '@@ -1 +1 @@\n-one\n+two\n',
  ['p.diff'],
  // No diff --git line and no ---/+++ pair: the format is not even detected.
  { exit: 2, stdout: 'error: format\n', files: { 'a.txt': 'one\n' } });
add('u-pure-insert-top',
  { 'a.txt': 'one\ntwo\n' },
  '--- a/a.txt\n+++ b/a.txt\n@@ -0,0 +1 @@\n+zero\n',
  ['p.diff'],
  { exit: 0, stdout: 'M a.txt\nok: 1 file\n', files: { 'a.txt': 'zero\none\ntwo\n' } });
add('u-pure-insert-beyond',
  { 'a.txt': 'one\ntwo\n' },
  '--- a/a.txt\n+++ b/a.txt\n@@ -99,0 +100 @@\n+three\n',
  ['p.diff'],
  { exit: 0, stdout: 'M a.txt\nok: 1 file\n', files: { 'a.txt': 'one\ntwo\nthree\n' } });
add('u-nearest-tie',
  { 'a.txt': 'x\nfoo\nx\nfoo\nx\n' },
  '--- a/a.txt\n+++ b/a.txt\n@@ -3,1 +3,1 @@\n-foo\n+bar\n',
  ['p.diff'],
  // occurrences of [foo] at 1 and 3; hint A-1 = 2, equidistant -> earlier (1) wins.
  { exit: 0, stdout: 'M a.txt\nok: 1 file\n', files: { 'a.txt': 'x\nbar\nx\nfoo\nx\n' } });
add('u-overlap-occ',
  { 'a.txt': 'a\na\na\n' },
  '--- a/a.txt\n+++ b/a.txt\n@@ -2,2 +2,2 @@\n a\n-a\n+b\n',
  ['p.diff'],
  // O = [a, a] occurs at 0 and 1; hint A-1+d = 1 -> occurrence at 1 wins.
  { exit: 0, stdout: 'M a.txt\nok: 1 file\n', files: { 'a.txt': 'a\na\nb\n' } });
add('u-tier2-reindent',
  { 'a.py': 'def f():\n        x = 1\n        y = 2\n' },
  '--- a/a.py\n+++ b/a.py\n@@ -1,3 +1,3 @@\n def f():\n-    x = 1\n+    x = 9\n     y = 2\n',
  ['p.diff'],
  // O = [def f():, '    x = 1', '    y = 2'] matches only at tier 2. P is the leading
  // whitespace of O's FIRST line ('def f():' -> ''), F is '' too, so the re-indent rule
  // is a no-op here: the new line keeps the patch's 4-space indent while the file's
  // context lines keep their 8. Literal section 5 reading.
  { exit: 0, stdout: 'M a.py\nok: 1 file\n', files: { 'a.py': 'def f():\n    x = 9\n        y = 2\n' } });
add('u-multi-hunk-drift',
  { 'a.txt': 'l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\n' },
  '--- a/a.txt\n+++ b/a.txt\n@@ -1,1 +1,3 @@\n l1\n+A\n+B\n@@ -7,1 +9,1 @@\n-l7\n+L7\n',
  ['p.diff'],
  { exit: 0, stdout: 'M a.txt\nok: 1 file\n', files: { 'a.txt': 'l1\nA\nB\nl2\nl3\nl4\nl5\nl6\nL7\nl8\n' } });
add('u-move-chain',
  { 'a.txt': 'hello\n' },
  '--- a/a.txt\n+++ b/b.txt\n@@ -1,1 +1,1 @@\n-hello\n+hello\n--- a/b.txt\n+++ b/c.txt\n@@ -1,1 +1,1 @@\n-hello\n+hello\n',
  ['p.diff'],
  // a->b then b->c: no R row qualifies; net effect D a + A c, ordered by path.
  { exit: 0, stdout: 'D a.txt\nA c.txt\nok: 2 files\n', files: { 'c.txt': 'hello\n' } });
add('u-create-exists',
  { 'a.txt': 'one\n' },
  '--- /dev/null\n+++ b/a.txt\n@@ -0,0 +1 @@\n+two\n',
  ['p.diff'],
  { exit: 1, stdout: 'error: exists a.txt\nfailed: 1 of 1 edits\n', files: { 'a.txt': 'one\n' } });
add('u-change-missing',
  {},
  '--- a/nope.txt\n+++ b/nope.txt\n@@ -1,1 +1,1 @@\n-a\n+b\n',
  ['p.diff'],
  { exit: 1, stdout: 'error: missing nope.txt\nfailed: 1 of 1 edits\n', files: {} });
add('u-move-exists',
  { 'a.txt': 'one\n', 'b.txt': 'two\n' },
  '--- a/a.txt\n+++ b/b.txt\n@@ -1,1 +1,1 @@\n-one\n+one\n',
  ['p.diff'],
  { exit: 1, stdout: 'error: exists b.txt\nfailed: 1 of 1 edits\n', files: { 'a.txt': 'one\n', 'b.txt': 'two\n' } });
add('u-unsafe-dotdot',
  { 'a.txt': 'one\n' },
  '--- a/../a.txt\n+++ b/../a.txt\n@@ -1,1 +1,1 @@\n-one\n+two\n',
  ['p.diff'],
  { exit: 1, stdout: 'error: unsafe ../a.txt\nfailed: 1 of 1 edits\n', files: { 'a.txt': 'one\n' } });
add('u-empty-file-insert',
  { 'a.txt': '' },
  '--- a/a.txt\n+++ b/a.txt\n@@ -0,0 +1 @@\n+only\n',
  ['p.diff'],
  { exit: 0, stdout: 'M a.txt\nok: 1 file\n', files: { 'a.txt': 'only\n' } });
add('u-context-only-hunk',
  { 'a.txt': 'one\ntwo\n' },
  '--- a/a.txt\n+++ b/a.txt\n@@ -1,2 +1,2 @@\n one\n two\n',
  ['p.diff'],
  { exit: 0, stdout: 'ok: 0 files\n', files: { 'a.txt': 'one\ntwo\n' } });
add('u-noeol-insert-at-end',
  { 'a.txt': 'a\nb' },
  '--- a/a.txt\n+++ b/a.txt\n@@ -2,0 +3 @@\n+c\n',
  ['p.diff'],
  // Insert at end, no backslash line: the result ends in a line break (SPEC section 6).
  { exit: 0, stdout: 'M a.txt\nok: 1 file\n', files: { 'a.txt': 'a\nb\nc\n' } });

// ---- SEARCH/REPLACE ----
add('s-crlf',
  { 'a.js': 'function f() {\r\n  return 1;\r\n}\r\n' },
  'a.js\n<<<<<<< SEARCH\n  return 1;\n=======\n  return 2;\n>>>>>>> REPLACE\n',
  [],
  { exit: 0, stdout: 'M a.js\nok: 1 file\n', files: { 'a.js': 'function f() {\r\n  return 2;\r\n}\r\n' } });
add('s-ambiguous',
  { 'a.txt': 'foo\nfoo\n' },
  'a.txt\n<<<<<<< SEARCH\nfoo\n=======\nbar\n>>>>>>> REPLACE\n',
  [],
  { exit: 1, stdout: 'error: ambiguous a.txt\nfailed: 1 of 1 edits\n', files: { 'a.txt': 'foo\nfoo\n' } });
add('s-tier1',
  { 'a.txt': 'keep  \n' },
  'a.txt\n<<<<<<< SEARCH\nkeep\n=======\nkept\n>>>>>>> REPLACE\n',
  [],
  { exit: 0, stdout: 'M a.txt\nok: 1 file\n', files: { 'a.txt': 'kept\n' } });
add('s-create-then-use',
  {},
  'new.txt\n<<<<<<< SEARCH\n=======\nfirst\n>>>>>>> REPLACE\n<<<<<<< SEARCH\nfirst\n=======\nsecond\n>>>>>>> REPLACE\n',
  [],
  { exit: 0, stdout: 'A new.txt\nok: 1 file\n', files: { 'new.txt': 'second\n' } });
add('s-path-fence',
  { 'a.py': 'x = 1\n' },
  '```python\na.py\n```\n<<<<<<< SEARCH\nx = 1\n=======\nx = 2\n>>>>>>> REPLACE\n',
  [],
  { exit: 0, stdout: 'M a.py\nok: 1 file\n', files: { 'a.py': 'x = 2\n' } });
add('s-no-path-first',
  { 'a.txt': 'x\n' },
  '<<<<<<< SEARCH\nx\n=======\ny\n>>>>>>> REPLACE\n',
  [],
  { exit: 2, stdout: 'error: parse 1\n', files: { 'a.txt': 'x\n' } });
add('s-missing-sep',
  { 'a.txt': 'x\n' },
  'a.txt\n<<<<<<< SEARCH\nx\n>>>>>>> REPLACE\n',
  [],
  { exit: 2, stdout: 'error: parse 2\n', files: { 'a.txt': 'x\n' } });
add('s-unsafe',
  { 'a.txt': 'x\n' },
  'a/../b.txt\n<<<<<<< SEARCH\nx\n=======\ny\n>>>>>>> REPLACE\n',
  [],
  { exit: 1, stdout: 'error: unsafe a/../b.txt\nfailed: 1 of 1 edits\n', files: { 'a.txt': 'x\n' } });
add('s-empty-old-create',
  {},
  'new.txt\n<<<<<<< SEARCH\n=======\nline1\nline2\n>>>>>>> REPLACE\n',
  [],
  { exit: 0, stdout: 'A new.txt\nok: 1 file\n', files: { 'new.txt': 'line1\nline2\n' } });
add('s-empty-old-exists',
  { 'a.txt': 'x\n' },
  'a.txt\n<<<<<<< SEARCH\n=======\ny\n>>>>>>> REPLACE\n',
  [],
  { exit: 1, stdout: 'error: exists a.txt\nfailed: 1 of 1 edits\n', files: { 'a.txt': 'x\n' } });

// ---- V4A ----
add('v-crlf',
  { 'a.js': 'function f() {\r\n  return 1;\r\n}\r\n' },
  '*** Begin Patch\n*** Update File: a.js\n function f() {\n-  return 1;\n+  return 2;\n }\n*** End Patch\n',
  [],
  { exit: 0, stdout: 'M a.js\nok: 1 file\n', files: { 'a.js': 'function f() {\r\n  return 2;\r\n}\r\n' } });
add('v-move-exists',
  { 'a.txt': 'one\n', 'b.txt': 'two\n' },
  '*** Begin Patch\n*** Update File: a.txt\n*** Move to: b.txt\n one\n-two\n+one\n*** End Patch\n',
  [],
  { exit: 1, stdout: 'error: exists b.txt\nfailed: 1 of 1 edits\n', files: { 'a.txt': 'one\n', 'b.txt': 'two\n' } });
add('v-no-chunks',
  { 'a.txt': 'one\n' },
  '*** Begin Patch\n*** Update File: a.txt\n*** End Patch\n',
  [],
  { exit: 2, stdout: 'error: parse 2\n', files: { 'a.txt': 'one\n' } });
add('v-eof-anchor-tier2',
  { 'a.py': '  def f():\n    x = 1\n    return 1\n' },
  '*** Begin Patch\n*** Update File: a.py\n@@ def f():\n     x = 1\n-    return 1\n+    return 2\n*** End of File\n*** End Patch\n',
  [],
  // Anchor 'def f():' matches the file's indented def line only at tier 2; the chunk's O
  // (which does not include the anchor line) ends at the file's last line.
  { exit: 0, stdout: 'M a.py\nok: 1 file\n', files: { 'a.py': '  def f():\n    x = 1\n    return 2\n' } });
add('v-anchor-second-copy',
  { 'a.txt': 'x = 1\ny = 2\n\ndef marker():\n    pass\n\nx = 1\ny = 2\n' },
  '*** Begin Patch\n*** Update File: a.txt\n@@ def marker():\n x = 1\n-y = 2\n+y = 9\n*** End Patch\n',
  [],
  // O = [x = 1, y = 2] occurs twice; the anchor sits between the copies, so the chunk
  // takes the second copy (y = 3 -> y = 9), not the first.
  { exit: 0, stdout: 'M a.txt\nok: 1 file\n', files: { 'a.txt': 'x = 1\ny = 2\n\ndef marker():\n    pass\n\nx = 1\ny = 9\n' } });
add('v-add-blank-line',
  {},
  '*** Begin Patch\n*** Add File: notes.md\n+# Title\n+\n+body\n*** End Patch\n',
  [],
  { exit: 0, stdout: 'A notes.md\nok: 1 file\n', files: { 'notes.md': '# Title\n\nbody\n' } });
add('v-delete-blank-mid',
  { 'a.txt': 'one\n' },
  '*** Begin Patch\n*** Delete File: a.txt\n\nfoo\n*** End Patch\n',
  [],
  // A Delete section with lines (a blank then a stray line) is a parse fault, at the
  // section's first line.
  { exit: 2, stdout: 'error: parse 3\n', files: { 'a.txt': 'one\n' } });
add('v-delete-trailing-blank',
  { 'a.txt': 'one\n' },
  '*** Begin Patch\n*** Delete File: a.txt\n\n*** End Patch\n',
  [],
  // A blank line at the end of a section (before End Patch) is not part of it: the
  // Delete section has no lines and is valid.
  { exit: 0, stdout: 'D a.txt\nok: 1 file\n', files: {} });
add('v-begin-only',
  {},
  '*** Begin Patch\n*** End Patch\n',
  [],
  { exit: 2, stdout: 'error: parse 1\n', files: {} });
add('v-no-end',
  { 'a.txt': 'one\n' },
  '*** Begin Patch\n*** Update File: a.txt\n one\n-two\n+three\n',
  [],
  { exit: 2, stdout: 'error: parse 6\n', files: { 'a.txt': 'one\n' } });
add('v-bad-line',
  { 'a.txt': 'one\n' },
  '*** Begin Patch\n*** Update File: a.txt\n one\nhello world\n*** End Patch\n',
  [],
  { exit: 2, stdout: 'error: parse 4\n', files: { 'a.txt': 'one\n' } });
add('v-cursor-two-chunks',
  { 'a.txt': 'def g():\n    return 1\n\ndef g():\n    return 1\n' },
  '*** Begin Patch\n*** Update File: a.txt\n def g():\n-    return 1\n+    return 9\n@@ def g():\n-    return 1\n+    return 8\n*** End Patch\n',
  [],
  // First chunk (no anchor) takes the first copy; cursor moves past it; the anchored second
  // chunk (O does not include the anchor line) takes the second copy.
  { exit: 0, stdout: 'M a.txt\nok: 1 file\n', files: { 'a.txt': 'def g():\n    return 9\n\ndef g():\n    return 8\n' } });
add('v-eof-no-final-break',
  { 'a.txt': 'head\nfirst\nlast' },
  '*** Begin Patch\n*** Update File: a.txt\n@@ head\n first\n-last\n+LAST\n*** End of File\n*** End Patch\n',
  [],
  { exit: 0, stdout: 'M a.txt\nok: 1 file\n', files: { 'a.txt': 'head\nfirst\nLAST' } });
add('v-move-only',
  { 'a.txt': 'one\ntwo\n' },
  '*** Begin Patch\n*** Update File: a.txt\n*** Move to: b.txt\n*** End Patch\n',
  [],
  { exit: 0, stdout: 'R a.txt -> b.txt\nok: 1 file\n', files: { 'b.txt': 'one\ntwo\n' } });

// ---- JSON ----
add('j-array-fault-line',
  { 'a.txt': 'x\n' },
  '[{"path": "a.txt", "command": "str_replace", "old_str": "x", "new_str": "y"},\n {"path": "a.txt", "command": "bogus"}]\n',
  [],
  // Array fault: parse at the line the array starts on (line 1).
  { exit: 2, stdout: 'error: parse 1\n', files: { 'a.txt': 'x\n' } });
add('j-jsonl-fault-line',
  { 'a.txt': 'x\n' },
  '{"path": "a.txt", "command": "str_replace", "old_str": "x", "new_str": "y"}\n{"path": "a.txt", "command": "bogus"}\n',
  [],
  { exit: 2, stdout: 'error: parse 2\n', files: { 'a.txt': 'x\n' } });
add('j-str-overlap',
  { 'a.txt': 'aaa\n' },
  '[{"path": "a.txt", "command": "str_replace", "old_str": "aa", "new_str": "b"}]\n',
  [],
  // 'aa' occurs twice (overlapping, indexOf+1 counting) -> ambiguous.
  { exit: 1, stdout: 'error: ambiguous a.txt\nfailed: 1 of 1 edits\n', files: { 'a.txt': 'aaa\n' } });
add('j-insert-out-of-range',
  { 'a.txt': 'x\n' },
  '[{"path": "a.txt", "command": "insert", "insert_line": 5, "new_str": "y"}]\n',
  [],
  { exit: 1, stdout: 'error: no-match a.txt\nfailed: 1 of 1 edits\n', files: { 'a.txt': 'x\n' } });
add('j-create-bytes',
  {},
  '[{"path": "a.txt", "command": "create", "file_text": "a\\r\\nb\\r\\n"}]\n',
  [],
  { exit: 0, stdout: 'A a.txt\nok: 1 file\n', files: { 'a.txt': 'a\r\nb\r\n' } });
add('j-insert-crlf',
  { 'a.txt': 'x\r\ny\r\n' },
  '[{"path": "a.txt", "command": "insert", "insert_line": 1, "new_str": "mid"}]\n',
  [],
  { exit: 0, stdout: 'M a.txt\nok: 1 file\n', files: { 'a.txt': 'x\r\nmid\r\ny\r\n' } });

// ---- CLI / atomicity / determinism ----
add('c-rollback',
  { 'a.txt': 'one\n', 'b.txt': 'two\n' },
  '--- a/a.txt\n+++ b/a.txt\n@@ -1,1 +1,1 @@\n-one\n+ONE\n--- a/b.txt\n+++ b/b.txt\n@@ -1,1 +1,1 @@\n-nomatch\n+two\n',
  ['p.diff'],
  { exit: 1, stdout: 'error: no-match b.txt\nfailed: 1 of 2 edits\n', files: { 'a.txt': 'one\n', 'b.txt': 'two\n' } });
add('c-check-ok',
  { 'a.txt': 'one\n' },
  '--- a/a.txt\n+++ b/a.txt\n@@ -1,1 +1,1 @@\n-one\n+ONE\n',
  ['--check', 'p.diff'],
  { exit: 0, stdout: 'M a.txt\nok: 1 file\n', files: { 'a.txt': 'one\n' } });
add('c-check-fail',
  { 'a.txt': 'one\n' },
  '--- a/a.txt\n+++ b/a.txt\n@@ -1,1 +1,1 @@\n-nomatch\n+ONE\n',
  ['--check', 'p.diff'],
  { exit: 1, stdout: 'error: no-match a.txt\nfailed: 1 of 1 edits\n', files: { 'a.txt': 'one\n' } });
add('c-strict-tier1-fails',
  { 'a.txt': 'keep  \n' },
  'a.txt\n<<<<<<< SEARCH\nkeep\n=======\nkept\n>>>>>>> REPLACE\n',
  ['--strict'],
  { exit: 1, stdout: 'error: no-match a.txt\nfailed: 1 of 1 edits\n', files: { 'a.txt': 'keep  \n' } });
add('c-empty-patch',
  {},
  '',
  [],
  { exit: 2, stdout: 'error: format\n', files: {} });
add('c-prose-only',
  { 'a.txt': 'one\n' },
  'Here is a patch that changes things.\n\nTrust me.\n',
  ['p.diff'],
  // No format signature at all: detection fails before parsing.
  { exit: 2, stdout: 'error: format\n', files: { 'a.txt': 'one\n' } });
add('c-format-flag-wrong',
  { 'a.txt': 'one\n' },
  '--- a/a.txt\n+++ b/a.txt\n@@ -1,1 +1,1 @@\n-one\n+two\n',
  ['p.diff', '--format=json'],
  { exit: 2, stdout: 'error: parse 1\n', files: { 'a.txt': 'one\n' } });
add('c-noop-identical',
  { 'a.txt': 'one\n' },
  '--- a/a.txt\n+++ b/a.txt\n@@ -1,1 +1,1 @@\n-one\n+one\n',
  ['p.diff'],
  { exit: 0, stdout: 'ok: 0 files\n', files: { 'a.txt': 'one\n' } });
add('c-unsafe-abs',
  {},
  '[{"path": "/etc/x.txt", "command": "create", "file_text": "x"}]\n',
  [],
  { exit: 1, stdout: 'error: unsafe /etc/x.txt\nfailed: 1 of 1 edits\n', files: {} });
add('c-move-order',
  { 'z.txt': 'z\n', 'a.txt': 'a\n', 'm.txt': 'm\n' },
  '--- a/z.txt\n+++ b/y.txt\n@@ -1,1 +1,1 @@\n-z\n+z\n--- a/a.txt\n+++ b/a.txt\n@@ -1,1 +1,1 @@\n-a\n+A\n--- a/m.txt\n+++ b/m.txt\n@@ -1,1 +1,1 @@\n-m\n+M\n',
  ['p.diff'],
  // Rows sorted by path byte order; the R row sorts under its new path y.txt.
  { exit: 0, stdout: 'M a.txt\nM m.txt\nR z.txt -> y.txt\nok: 3 files\n', files: { 'y.txt': 'z\n', 'a.txt': 'A\n', 'm.txt': 'M\n' } });
add('c-usage-twice',
  { 'a.txt': 'one\n' },
  '--- a/a.txt\n+++ b/a.txt\n@@ -1,1 +1,1 @@\n-one\n+two\n',
  ['p.diff', '--check', '--check'],
  { exit: 2, stdout: 'error: usage\n', files: { 'a.txt': 'one\n' } });
add('c-no-patch-file',
  {},
  null,
  ['missing.patch'],
  { exit: 2, stdout: 'error: no-patch\n', files: {} });

// ---- determinism: the same scenario run twice must be byte-identical ----
{
  const dir1 = mkdtempSync(join(tmpdir(), 'mend-det1-'));
  const dir2 = mkdtempSync(join(tmpdir(), 'mend-det2-'));
  try {
    const files = { 'a.txt': 'one\ntwo\nthree\n', 'b.py': 'x = 1\n' };
    const patch = '--- a/a.txt\n+++ b/a.txt\n@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n three\n--- a/b.py\n+++ b/b.py\n@@ -1,1 +1,1 @@\n-x = 1\n+x = 2\n';
    for (const d of [dir1, dir2]) {
      writeTree(d, files);
      writeFileSync(join(d, 'p.diff'), patch);
    }
    const r1 = spawnSync(process.execPath, [MAIN, 'p.diff'], { cwd: dir1, encoding: 'utf8' });
    const r2 = spawnSync(process.execPath, [MAIN, 'p.diff'], { cwd: dir2, encoding: 'utf8' });
    const t1 = readTree(dir1);
    const t2 = readTree(dir2);
    const same = r1.status === r2.status && r1.stdout === r2.stdout && JSON.stringify(t1) === JSON.stringify(t2);
    CASES.push({ name: 'c-deterministic', run: () => (same ? [] : ['two runs differed']) });
  } finally {
    rmSync(dir1, { recursive: true, force: true });
    rmSync(dir2, { recursive: true, force: true });
  }
}

// ---- runner ----
let pass = 0;
let fail = 0;
for (const c of CASES) {
  const problems = c.run !== undefined ? c.run() : runCase(c);
  if (problems.length === 0) {
    pass++;
  } else {
    fail++;
    console.log(`FAIL ${c.name}`);
    for (const p of problems) console.log(`  ${p}`);
  }
}
console.log(`${pass} passed, ${fail} failed, ${CASES.length} total`);
process.exitCode = fail === 0 ? 0 : 1;
