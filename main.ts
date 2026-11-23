// mend — one patch tool for every AI edit format (SPEC.md, MIT).
// Implements the whole of SPEC.md: the command line (§1), output and exit codes (§2), file and
// line model (§3), format detection (§4), three-tier line matching (§5), unified diffs (§6),
// SEARCH/REPLACE blocks (§7), V4A patches (§8), JSON tool calls (§9) and ordering, atomicity
// and rollback (§10). Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands
// over to runner.ts (the last lines below): keep that hand-over and runner.ts as they are.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file as SPEC.md section 3 models it: its lines, its break, and whether it ends in a break. */
interface FileState {
  lines: string[];
  br: '\n' | '\r\n';
  final: boolean;
}

function splitFile(text: string): FileState {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br: '\n' | '\r\n' = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { lines, br, final };
}

function joinFile(f: FileState): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

/** One line of a replacement block: a context line is written as the file's own line (§5). */
interface NLine {
  text: string;
  ctx: boolean;
  /** Position of this context line inside O, so the file's line can be copied. */
  oPos: number;
}

const keyAt = (line: string, tier: number): string =>
  tier === 0 ? line : tier === 1 ? line.replace(/[ \t]+$/, '') : line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');

/** Every start position where O occurs in lines at the given tier (overlaps allowed). */
function occurrences(lines: string[], o: string[], tier: number): number[] {
  const out: number[] = [];
  if (o.length === 0 || o.length > lines.length) return out;
  const keys = o.map((l) => keyAt(l, tier));
  for (let i = 0; i + o.length <= lines.length; i++) {
    let good = true;
    for (let j = 0; j < o.length; j++) {
      if (keyAt(lines[i + j]!, tier) !== keys[j]) {
        good = false;
        break;
      }
    }
    if (good) out.push(i);
  }
  return out;
}

/** The first tier (0, then 1, then 2; strict allows only 0) with at least one occurrence. */
function findTier(lines: string[], o: string[], strict: boolean): { tier: number; occ: number[] } | null {
  const max = strict ? 0 : 2;
  for (let t = 0; t <= max; t++) {
    const occ = occurrences(lines, o, t);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** Same as findTier, but only occurrences starting at or after `from` count (V4A cursor). */
function findTierFrom(lines: string[], o: string[], strict: boolean, from: number): { tier: number; occ: number[] } | null {
  const max = strict ? 0 : 2;
  for (let t = 0; t <= max; t++) {
    const occ = occurrences(lines, o, t).filter((p) => p >= from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/**
 * Build the replacement lines for an occurrence of O at `at` (§5): context lines are the file's
 * own lines; at tier 2 every other non-empty, non-whitespace-only line of N that starts with P
 * (the leading spaces/tabs of O's first line) has that P replaced by F (the leading spaces/tabs
 * of the file's first matched line). An empty O means no re-indenting at all.
 */
function buildReplacement(lines: string[], at: number, o: string[], n: NLine[], tier: number): string[] {
  const out: string[] = [];
  let p = '';
  let f = '';
  if (tier === 2 && o.length > 0) {
    p = /^[ \t]*/.exec(o[0]!)![0];
    f = /^[ \t]*/.exec(lines[at]!)![0];
  }
  for (const item of n) {
    if (item.ctx) {
      out.push(lines[at + item.oPos]!);
      continue;
    }
    let t = item.text;
    if (tier === 2 && t !== '' && !/^[ \t]+$/.test(t) && t.startsWith(p)) t = f + t.slice(p.length);
    out.push(t);
  }
  return out;
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: { old: string; new: string }[] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---- Unified diff (SPEC.md section 6) ----

interface BodyItem {
  kind: ' ' | '-' | '+' | '\\';
  text: string;
}

interface Hunk {
  a: number;
  body: BodyItem[];
  /** A `\` line follows the hunk's last context or `+` line. */
  lastOutBackslash: boolean;
  /** A `\` line follows the hunk's last `+` line. */
  lastPlusBackslash: boolean;
}

interface RawSection {
  pairOld: string | null;
  pairNew: string | null;
  hasPair: boolean;
  renameFrom?: string;
  renameTo?: string;
  gitOld?: string;
  gitNew?: string;
  isCreate: boolean;
  isDelete: boolean;
  hunks: Hunk[];
  seenHunk: boolean;
}

function finishHunk(a: number, raw: string[]): Hunk {
  while (raw.length > 0 && raw[raw.length - 1] === '') raw.pop();
  const body: BodyItem[] = raw.map((line) => {
    if (line === '') return { kind: ' ', text: '' };
    const k = line[0]!;
    if (k === ' ' || k === '-' || k === '+') return { kind: k, text: line.slice(1) };
    return { kind: '\\', text: line };
  });
  let lastOutBackslash = false;
  let lastPlusBackslash = false;
  for (let i = body.length - 1; i >= 0; i--) {
    if (body[i]!.kind === ' ' || body[i]!.kind === '+') {
      lastOutBackslash = body[i + 1] !== undefined && body[i + 1]!.kind === '\\';
      break;
    }
  }
  for (let i = body.length - 1; i >= 0; i--) {
    if (body[i]!.kind === '+') {
      lastPlusBackslash = body[i + 1] !== undefined && body[i + 1]!.kind === '\\';
      break;
    }
  }
  return { a, body, lastOutBackslash, lastPlusBackslash };
}

function hunkON(h: Hunk): { o: string[]; n: NLine[] } {
  const o: string[] = [];
  const n: NLine[] = [];
  for (const b of h.body) {
    if (b.kind === '\\') continue;
    if (b.kind === ' ') {
      o.push(b.text);
      n.push({ text: b.text, ctx: true, oPos: o.length - 1 });
    } else if (b.kind === '-') {
      o.push(b.text);
    } else {
      n.push({ text: b.text, ctx: false, oPos: -1 });
    }
  }
  return { o, n };
}

/** Apply a section's hunks in order to a file; `d` tracks the line shift so far (§6). */
function applyHunks(f: FileState, hunks: Hunk[], strict: boolean, path: string): FileState {
  let cur: FileState = { lines: [...f.lines], br: f.br, final: f.final };
  let d = 0;
  for (const h of hunks) {
    const { o, n } = hunkON(h);
    if (o.length === 0) {
      const at = Math.max(0, Math.min(h.a + d, cur.lines.length));
      const rep = buildReplacement(cur.lines, at, o, n, -1);
      const lines = [...cur.lines.slice(0, at), ...rep, ...cur.lines.slice(at)];
      let final = cur.final;
      if (at === cur.lines.length) final = !h.lastOutBackslash;
      cur = { lines, br: cur.br, final };
      d += n.length;
      continue;
    }
    const found = findTier(cur.lines, o, strict);
    if (found === null) throw new Fail('no-match', path);
    const hint = h.a - 1 + d;
    let best = found.occ[0]!;
    let bestDist = Math.abs(best - hint);
    for (const pos of found.occ) {
      const dist = Math.abs(pos - hint);
      if (dist < bestDist) {
        best = pos;
        bestDist = dist;
      }
    }
    const rep = buildReplacement(cur.lines, best, o, n, found.tier);
    const lines = [...cur.lines.slice(0, best), ...rep, ...cur.lines.slice(best + o.length)];
    let final = cur.final;
    if (best + o.length === cur.lines.length) final = !h.lastOutBackslash;
    cur = { lines, br: cur.br, final };
    d += n.length - o.length;
  }
  return cur;
}

function pairPath(text: string): string | null {
  let t = text.split('\t')[0]!.trim();
  if (t === '/dev/null') return null;
  if (t.startsWith('a/') || t.startsWith('b/')) t = t.slice(2);
  if (t === '/dev/null') return null;
  return t;
}

function sectionPaths(s: RawSection): { oldP: string | null; newP: string | null } {
  if (s.hasPair) return { oldP: s.pairOld, newP: s.pairNew };
  const pick = (a: string | undefined, b: string | undefined): string | null => {
    if (a !== undefined) return a === '/dev/null' ? null : a;
    if (b !== undefined) return b === '/dev/null' ? null : b;
    return null;
  };
  return { oldP: pick(s.renameFrom, s.gitOld), newP: pick(s.renameTo, s.gitNew) };
}

function unifiedEdit(s: RawSection, strict: boolean): Edit {
  const { oldP, newP } = sectionPaths(s);
  const isCreate = oldP === null || s.isCreate;
  const isDelete = !isCreate && (newP === null || s.isDelete);
  const isMove = !isCreate && !isDelete && oldP !== newP;
  if (isCreate) {
    if (newP === null) return () => { throw new Fail('unsafe', ''); };
    const p = newP;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const out: string[] = [];
      let finalBreak = true;
      for (const h of s.hunks) {
        let hasPlus = false;
        for (const b of h.body) {
          if (b.kind === '+') {
            out.push(b.text);
            hasPlus = true;
          }
        }
        if (hasPlus) finalBreak = !h.lastPlusBackslash;
      }
      tree.now.set(p, out.length === 0 ? '' : out.join('\n') + (finalBreak ? '\n' : ''));
    };
  }
  if (isDelete) {
    const p = oldP!;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
    };
  }
  const p = oldP!;
  const q = newP!;
  return (tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    if (isMove && !safe(q)) throw new Fail('unsafe', q);
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    if (isMove && tree.get(q) !== null) throw new Fail('exists', q);
    const f = applyHunks(splitFile(before), s.hunks, strict, p);
    const text = joinFile(f);
    if (isMove) {
      tree.now.set(q, text);
      tree.now.set(p, null);
      tree.moves.push({ old: p, new: q });
    } else {
      tree.now.set(p, text);
    }
  };
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const GIT_RE = /^diff --git a\/([^]+) b\/([^]+)$/;
  const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@.*$/;
  const sections: RawSection[] = [];
  let cur: RawSection | null = null;
  let hunkA: number | null = null;
  let rawBody: string[] | null = null;
  const newSection = (): RawSection => ({ pairOld: null, pairNew: null, hasPair: false, isCreate: false, isDelete: false, hunks: [], seenHunk: false });
  const closeBody = () => {
    if (cur !== null && hunkA !== null && rawBody !== null) cur.hunks.push(finishHunk(hunkA, rawBody));
    hunkA = null;
    rawBody = null;
  };
  const closeSection = () => {
    closeBody();
    if (cur !== null) sections.push(cur);
    cur = null;
  };
  const inHeader = (): boolean => cur !== null && !cur.seenHunk;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const next = lines[i + 1] ?? '';
    if (rawBody !== null) {
      // A `--- ` line followed by a `+++ ` line ends the body and starts a section (§6);
      // it is not a body line even though it starts with `-`.
      if (line.startsWith('--- ') && next.startsWith('+++ ')) {
        closeBody();
      } else if (line.startsWith(' ') || line.startsWith('-') || line.startsWith('+') || line.startsWith('\\') || line === '') {
        rawBody.push(line);
        continue;
      } else {
        closeBody();
      }
    }
    if (line === 'diff --git' || line.startsWith('diff --git ')) {
      const m = GIT_RE.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      closeSection();
      cur = newSection();
      cur.gitOld = m[1]!;
      cur.gitNew = m[2]!;
      continue;
    }
    if (line.startsWith('--- ') && next.startsWith('+++ ')) {
      if (cur !== null && inHeader() && !cur.hasPair) {
        cur.pairOld = pairPath(line.slice(4));
        cur.pairNew = pairPath(next.slice(4));
        cur.hasPair = true;
      } else {
        closeSection();
        cur = newSection();
        cur.pairOld = pairPath(line.slice(4));
        cur.pairNew = pairPath(next.slice(4));
        cur.hasPair = true;
      }
      i++;
      continue;
    }
    if (line.startsWith('--- ')) {
      if (inHeader()) throw new Exit2(`error: parse ${i + 2}`);
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = HUNK_RE.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur.seenHunk = true;
      hunkA = Number(m[1]);
      rawBody = [];
      continue;
    }
    if (inHeader() && cur !== null) {
      if (line.startsWith('rename from ')) cur.renameFrom = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) cur.isCreate = true;
      else if (line.startsWith('deleted file mode')) cur.isDelete = true;
    }
  }
  closeSection();
  return sections.map((s) => unifiedEdit(s, strict));
}

// ---- SEARCH/REPLACE (SPEC.md section 7) ----

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const t = tree.get(path);
    if (t === null) throw new Fail('missing', path);
    const f = splitFile(t);
    const found = findTier(f.lines, oldLines, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    const at = found.occ[0]!;
    const nItems: NLine[] = newLines.map((text) => ({ text, ctx: false, oPos: -1 }));
    const rep = buildReplacement(f.lines, at, oldLines, nItems, found.tier);
    const lines = [...f.lines.slice(0, at), ...rep, ...f.lines.slice(at + oldLines.length)];
    tree.now.set(path, joinFile({ lines, br: f.br, final: f.final }));
  };
}

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchLine = i;
    let sep = -1;
    for (let j = i + 1; j < lines.length; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '=======') {
        sep = j;
        break;
      }
      if (t === '>>>>>>> REPLACE') break;
    }
    if (sep < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    let end = -1;
    for (let j = sep + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        end = j;
        break;
      }
    }
    if (end < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    let path: string | null = null;
    for (let j = searchLine - 1; j > prevEnd; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      const t = l.trim();
      if (t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchLine + 1}`);
      path = prevPath;
    }
    edits.push(srEdit(path, lines.slice(searchLine + 1, sep), lines.slice(sep + 1, end), strict));
    prevPath = path;
    prevEnd = end;
    i = end + 1;
  }
  return edits;
}

// ---- V4A (SPEC.md section 8) ----

interface VChunk {
  anchor: string | null;
  eof: boolean;
  o: string[];
  n: NLine[];
}

function chunkON(items: BodyItem[]): { o: string[]; n: NLine[] } {
  const o: string[] = [];
  const n: NLine[] = [];
  for (const b of items) {
    if (b.kind === ' ') {
      o.push(b.text);
      n.push({ text: b.text, ctx: true, oPos: o.length - 1 });
    } else if (b.kind === '-') {
      o.push(b.text);
    } else {
      n.push({ text: b.text, ctx: false, oPos: -1 });
    }
  }
  return { o, n };
}

function applyV4aChunk(f: FileState, chunk: VChunk, cursor: number, strict: boolean, path: string): { f: FileState; cursor: number } {
  let cur = cursor;
  if (chunk.anchor !== null) {
    const a = findTierFrom(f.lines, [chunk.anchor], strict, cur);
    if (a === null) throw new Fail('no-match', path);
    cur = a.occ[0]! + 1;
  }
  if (chunk.o.length === 0) {
    const at = chunk.eof ? f.lines.length : cur;
    const rep = buildReplacement(f.lines, at, chunk.o, chunk.n, -1);
    const lines = [...f.lines.slice(0, at), ...rep, ...f.lines.slice(at)];
    return { f: { lines, br: f.br, final: f.final }, cursor: at + rep.length };
  }
  const found = findTierFrom(f.lines, chunk.o, strict, cur);
  if (found === null) throw new Fail('no-match', path);
  let pos: number | undefined;
  for (const p of found.occ) {
    if (chunk.eof && p + chunk.o.length !== f.lines.length) continue;
    pos = p;
    break;
  }
  if (pos === undefined) throw new Fail('no-match', path);
  const rep = buildReplacement(f.lines, pos, chunk.o, chunk.n, found.tier);
  const lines = [...f.lines.slice(0, pos), ...rep, ...f.lines.slice(pos + chunk.o.length)];
  return { f: { lines, br: f.br, final: f.final }, cursor: pos + rep.length };
}

function v4aEdit(header: string, secLines: { text: string; no: number }[], headerNo: number, strict: boolean): Edit {
  if (header.startsWith('*** Add File: ')) {
    const path = header.slice('*** Add File: '.length).trim();
    const out: string[] = [];
    for (const { text, no } of secLines) {
      if (text === '') out.push('');
      else if (text.startsWith('+')) out.push(text.slice(1));
      else throw new Exit2(`error: parse ${no}`);
    }
    return (tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, out.length === 0 ? '' : out.join('\n') + '\n');
    };
  }
  if (header.startsWith('*** Delete File: ')) {
    const path = header.slice('*** Delete File: '.length).trim();
    if (secLines.length > 0) throw new Exit2(`error: parse ${secLines[0]!.no}`);
    return (tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (tree.get(path) === null) throw new Fail('missing', path);
      tree.now.set(path, null);
    };
  }
  const path = header.slice('*** Update File: '.length).trim();
  let moveTo: string | null = null;
  let idx = 0;
  if (secLines.length > 0 && secLines[0]!.text.startsWith('*** Move to: ')) {
    moveTo = secLines[0]!.text.slice('*** Move to: '.length).trim();
    idx = 1;
  }
  const chunks: VChunk[] = [];
  let cur: { anchor: string | null; eof: boolean; items: BodyItem[] } | null = null;
  const flush = () => {
    if (cur === null) return;
    const { o, n } = chunkON(cur.items);
    chunks.push({ anchor: cur.anchor, eof: cur.eof, o, n });
    cur = null;
  };
  for (let k = idx; k < secLines.length; k++) {
    const { text, no } = secLines[k]!;
    if (text === '*** End of File') {
      if (cur === null) throw new Exit2(`error: parse ${no}`);
      cur.eof = true;
      flush();
      continue;
    }
    if (text.startsWith('@@')) {
      flush();
      const anchor = text.slice(2).trim();
      cur = { anchor: anchor === '' ? null : anchor, eof: false, items: [] };
      continue;
    }
    if (text.startsWith(' ') || text.startsWith('-') || text.startsWith('+')) {
      if (cur === null) {
        if (chunks.length > 0) throw new Exit2(`error: parse ${no}`);
        cur = { anchor: null, eof: false, items: [] };
      }
      cur.items.push({ kind: text[0] as ' ' | '-' | '+', text: text.slice(1) });
      continue;
    }
    if (text === '') {
      if (cur !== null) {
        cur.items.push({ kind: ' ', text: '' });
        continue;
      }
      if (chunks.length === 0) {
        cur = { anchor: null, eof: false, items: [{ kind: ' ', text: '' }] };
        continue;
      }
      continue;
    }
    throw new Exit2(`error: parse ${no}`);
  }
  flush();
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headerNo}`);
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    let f = splitFile(before);
    let cursor = 0;
    for (const chunk of chunks) {
      const r = applyV4aChunk(f, chunk, cursor, strict, path);
      f = r.f;
      cursor = r.cursor;
    }
    const text = joinFile(f);
    if (moveTo !== null) {
      tree.now.set(moveTo, text);
      tree.now.set(path, null);
      tree.moves.push({ old: path, new: moveTo });
    } else {
      tree.now.set(path, text);
    }
  };
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i++;
      continue;
    }
    if (!isSectionStart(l)) throw new Exit2(`error: parse ${i + 1}`);
    let j = i + 1;
    while (j < last && !isSectionStart(lines[j]!)) j++;
    const secLines: { text: string; no: number }[] = [];
    for (let k = i + 1; k < j; k++) secLines.push({ text: lines[k]!, no: k + 1 });
    while (secLines.length > 0 && blank(secLines[secLines.length - 1]!.text)) secLines.pop();
    edits.push(v4aEdit(l, secLines, i + 1, strict));
    i = j;
  }
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? parseUnified(lines, strict)
          : kind === 'search-replace'
            ? parseSearchReplace(lines, strict)
            : parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // Output rows (§2): a successful move is one `R <old> -> <new>` row, ordered by the new path,
  // and replaces its D/A pair; a chained move qualifies for no R at all.
  const rPairs = tree.moves.filter(
    (m) => tree.original(m.old) !== null && tree.get(m.old) === null && tree.original(m.new) === null && tree.get(m.new) !== null,
  );
  const rNew = new Map<string, string>();
  const rOld = new Set<string>();
  for (const m of rPairs) {
    rNew.set(m.new, m.old);
    rOld.add(m.old);
  }
  const changed: { key: string; row: string }[] = [];
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (rOld.has(p)) continue;
    if (rNew.has(p)) changed.push({ key: p, row: `R ${rNew.get(p)} -> ${p}` });
    else changed.push({ key: p, row: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  changed.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const rows = changed.map((c) => c.row);
  if (!check) {
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
