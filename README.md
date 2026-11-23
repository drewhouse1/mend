# mend: one patch tool for every AI edit format

`mend` is a command-line tool that applies the edits AI models write, in four formats, to a tree
of files. `SPEC.md` is the whole specification; `main.ts` implements all of it.

## Usage

    node main.ts [options] [PATCH]

`PATCH` is a patch file; `-` or no argument reads the patch from stdin. Options:

- `--format=<name>` — `auto` (default), `unified`, `search-replace`, `v4a`, `json`.
- `--check` — report what would change and exit with the same code, without writing anything.
- `--strict` — match lines exactly only (tier 0); without it, mend also matches lines whose
  trailing whitespace drifted (tier 1) or whose leading and trailing whitespace drifted (tier 2).

## The four formats

- **Unified diff** — `diff --git` sections and `---`/`+++` pairs, hunks with `@@ -A,B +C,D @@`
  headers. Line numbers may be wrong: a hunk finds the occurrence nearest to its stated
  position. `--- /dev/null` creates a file, `+++ /dev/null` deletes one, different paths move
  one (reported as `R old -> new`).
- **SEARCH/REPLACE** — blocks delimited by `<<<<<<< SEARCH`, `=======`, `>>>>>>> REPLACE`,
  with the path on the nearest line above the block. An empty old block creates the file.
- **V4A** — `*** Begin Patch` / `*** End Patch`, with `*** Add File:`, `*** Delete File:` and
  `*** Update File:` sections. Update chunks may carry an `@@ anchor` line (search resumes after
  the anchor), a `*** Move to:` line, and `*** End of File` (the chunk must end at the file's
  last line).
- **JSON tool calls** — one JSON array, or JSON Lines: `create` (exact bytes), `str_replace`
  (exactly one occurrence), `insert` (after a line number).

## Matching

A block's old lines are found in the first tier with at least one occurrence: exact (tier 0),
then trailing whitespace ignored (tier 1), then leading and trailing whitespace ignored
(tier 2). At tier 2 the replacement lines are re-indented to the file's indentation. A block
that matches nowhere is `no-match`; a SEARCH/REPLACE or JSON block that matches more than once
is `ambiguous`.

## Output and exit codes

On success mend prints one row per changed path (`A`, `D`, `M`, or `R old -> new`, byte-ordered)
and `ok: N file(s)`. On failure it prints one `error: <code> <path>` line per failed edit and
`failed: K of N edits`, exits 1, and writes nothing at all: every edit is validated before
anything is committed, and a failed edit rolls the tree back. Parse and usage problems exit 2
with a single `error: ...` line. Paths are checked for safety (`..`, absolute paths, backslashes
and empty segments are `unsafe`) before anything else about the edit.

## Files

- `main.ts` — the CLI, Node 22 and its standard library alone. Its last lines hand a trial over
  to `runner.ts` when `MAKEFUN_ENV_URL` is set: keep them.
- `runner.ts` — keep it as it is. In a trial it reads the checks from the env, runs
  `node main.ts` on each one in a fresh directory, and posts what main.ts did.
- `check.ts` — the practice set on your own machine (the kit carries it at
  `program/generator/practice.json`):

      node check.ts ../program/generator/practice.json
      node check.ts ../program/generator/practice.json u-offset s-basic

  It prints every check main.ts gets wrong, with what differed, and the practice score.
- `tests/edge.mjs` — an additional edge/adversarial suite (65 cases) covering SPEC corners the
  public practice set does not: CRLF in every format, overlapping occurrences, nearest-tie
  choice, move chains, unsafe paths, rollback, `--check`/`--strict`, empty patches, V4A
  anchors at tier 2, JSON fault line numbers, and a determinism check. Run with
  `node tests/edge.mjs`.
- `SPEC.md` — the specification.
- `LICENSE` — MIT.

## A check

A check is one run: its arguments, its standard input (or none) and the files it starts with. It
passes when the exit code, everything written to stdout and every file afterwards are exactly
what SPEC.md says. Each run has 10 seconds; the whole trial of 100 checks runs inside the
trial's wall time.

## What makes a good entry

The checks are written the way models get edits wrong: wrong line numbers, drifted whitespace and
indentation, blank context lines without their leading space, prose and code fences around the
patch, CRLF files, files without a final line break, blocks that occur twice. Read SPEC.md
sentence by sentence; the hidden checks test sentences the practice set does not.
