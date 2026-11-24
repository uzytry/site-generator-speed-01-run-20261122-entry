// A faster drop-in replacement for makefun-site 1.0.0, make.fun's own static
// site generator. run(input) returns exactly makefun-site 1.0.0's build for
// every { site, templates, files } input: the same output tree, byte for byte
// (each page's index.html, the index and tag pages, build-report.txt and each
// static file). Written from the reference's README and code, not copied from
// it: every rule (front matter, template dialect, Markdown subset, slug rule,
// report) is reimplemented here, then checked against the reference on the
// practice set and on freshly drawn instances.
//
// Where the speed comes from (profiled: the reference spends ~40% of its CPU
// in escapeHtml and its per-character inline renderer, ~12% in GC):
// - Inline Markdown is scanned with one native regex for structural characters
//   (\ ` * [) and the five HTML-escape characters at once, so the plain runs
//   between matches need no escaping at all, instead of one regex replace per
//   character.
// - Strong/emphasis/link closers are found with indexOf plus a backslash-parity
//   check, which is exactly the reference's left-to-right escape-pair scan.
// - Blocks are lexed and rendered in a single pass with hand-written
//   first-character checks instead of a regex per line, and no token objects
//   are built: blocks render straight into the output array.
// - Front matter is scanned by line offsets (no split/join of the whole file);
//   the body is a slice, not a rejoin.
// - slugify takes an ASCII fast path (charCode loop) and only falls back to
//   NFKD + combining-mark stripping when a non-ASCII character appears.
// - wordsOf counts word starts in one charCode pass instead of match(/\S+/g).
// - Cards, link records, mapped toc arrays and reading times are computed once
//   per source and reused (the reference recomputes a post's card and word
//   count twice); link targets are resolved once per (directory, path) per
//   build instead of once per link.
// - Templates render into an output array through a flat scope stack (no scope
//   object per loop iteration), and templates whose output depends only on
//   site/tags/recent (proved by a dependency analysis over the include graph,
//   with a fixpoint over includes and a guard against for-loops shadowing those
//   names) are rendered once per build and depth and reused.
// - Nothing is cached from one case to the next: every cache above lives
//   inside a single run() call.

/** The report file every build writes. */
const REPORT_FILE = 'build-report.txt';

/** The top-level directories the generator writes itself. */
const RESERVED = ['posts', 'tags', 'page'];

/** The most characters a slug keeps before a collision suffix. */
const SLUG_MAX = 64;

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// ---------------------------------------------------------------- text

const ESC_RE = /[&<>"']/g;
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escRep = (c) => ESCAPES[c];

/** `text` with & < > " and ' escaped (one native pass; unchanged when none occur). */
function esc(text) {
  return text.replace(ESC_RE, escRep);
}

/** JavaScript whitespace, for the rare non-ASCII character. */
const WS_RE = /\s/;

/** `out` cut to SLUG_MAX characters, a "-" left at the cut dropped, "untitled" when empty. */
function finishSlug(out) {
  if (out.length > SLUG_MAX) out = out.slice(0, SLUG_MAX);
  let e = out.length;
  while (e > 0 && out.charCodeAt(e - 1) === 45) e--;
  if (e !== out.length) out = out.slice(0, e);
  return out === '' ? 'untitled' : out;
}

const MARK_RE = /\p{M}/gu;

/** The slug rule's slow path, for text holding a non-ASCII character: NFKD, combining marks dropped, the rest as the fast path. */
function slugifySlow(text) {
  const plain = text.normalize('NFKD').replace(MARK_RE, '');
  let out = '';
  let gap = false;
  for (const ch of plain) {
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  return finishSlug(out);
}

/**
 * The slug of `text`: NFKD, combining marks dropped, A-Z lowered, every run of
 * characters other than a-z and 0-9 one "-", none at either end, at most 64
 * characters (a "-" left at the cut dropped), "untitled" when nothing is left.
 * Pure-ASCII text is NFKD-identical with no combining marks, so the charCode
 * loop below is exactly the rule for it; anything else goes to slugifySlow.
 */
function slugify(text) {
  let out = '';
  let gap = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) {
      if (gap) {
        out += '-';
        gap = false;
      }
      out += text[i];
    } else if (c >= 65 && c <= 90) {
      if (gap) {
        out += '-';
        gap = false;
      }
      out += String.fromCharCode(c + 32);
    } else if (c > 127) {
      return slugifySlow(text);
    } else {
      gap = out.length > 0;
    }
  }
  return finishSlug(out);
}

/** `slug` made unique against `taken` (and added to it): the first of slug, slug-2, slug-3 ... not taken. */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

/** A YYYY-MM-DD date in words, from the string alone: "2026-11-09" is "9 November 2026". */
function longDate(date) {
  return `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
}

/** The words of a body: its runs of characters other than whitespace (one pass, word starts counted). */
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    let ws;
    if (c === 32 || (c >= 9 && c <= 13)) ws = true;
    else if (c < 128) ws = false;
    else ws = WS_RE.test(text[i]);
    if (ws) inWord = false;
    else if (!inWord) {
      inWord = true;
      n++;
    }
  }
  return n;
}

/** `rel` (a link's path, "/"-separated) from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const dirOf = (path) => {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
};

/** Whether `target` opens with a scheme (`https:`, `mailto:` ...): a letter, then letters/digits/+/-/. until a ":". */
function hasScheme(target) {
  const c0 = target.charCodeAt(0);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return false;
  for (let i = 1; i < target.length; i++) {
    const c = target.charCodeAt(i);
    if (c === 58) return true;
    if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 46 || c === 45)) return false;
  }
  return false;
}

// ---------------------------------------------------------------- front matter

/** The keys a source's front matter may give. */
const KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

const isDigit = (c) => c >= 48 && c <= 57;

/** A string value: "..." with \" and \\ its only escapes, or bare, the rest of the line (never opening on " or [). */
function stringOf(key, raw) {
  const prefix = `key "${key}": `;
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: `${prefix}a quoted string is not closed` };
    const inner = raw.slice(1, -1);
    if (inner.indexOf('\\') === -1 && inner.indexOf('"') === -1) return { value: inner };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: `${prefix}a quoted string holds an escape other than \\" or \\\\` };
        out += n;
        i++;
      } else if (c === '"') return { error: `${prefix}a quoted string holds a stray quote` };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: `${prefix}a bare string opens on [` };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary':
      return stringOf(key, raw);
    case 'date': {
      let ok = raw.length === 10 && raw.charCodeAt(4) === 45 && raw.charCodeAt(7) === 45;
      let y = 0;
      let mo = 0;
      let d = 0;
      if (ok) {
        for (let i = 0; i < 10; i++) {
          if (i === 4 || i === 7) continue;
          if (!isDigit(raw.charCodeAt(i))) {
            ok = false;
            break;
          }
        }
      }
      if (ok) {
        y = Number(raw.slice(0, 4));
        mo = Number(raw.slice(5, 7));
        d = Number(raw.slice(8, 10));
        if (y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) ok = false;
      }
      return ok ? { value: raw } : { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
    }
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      for (const t of tags) {
        if (t === '') return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        for (let i = 0; i < t.length; i++) {
          const c = t.charCodeAt(i);
          if (c === 34 || c === 91 || c === 93) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        }
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout': {
      let ok = raw.length > 0;
      for (let i = 0; ok && i < raw.length; i++) {
        const c = raw.charCodeAt(i);
        if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) ok = false;
      }
      return ok ? { value: raw } : { error: 'key "layout": not a template name' };
    }
    case 'slug': {
      let ok = raw.length > 0 && raw.length <= 64;
      let prevDash = true; // a slug may not open on "-"
      for (let i = 0; ok && i < raw.length; i++) {
        const c = raw.charCodeAt(i);
        if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) prevDash = false;
        else if (c === 45 && !prevDash) prevDash = true;
        else ok = false;
      }
      if (prevDash) ok = false; // a slug may not close on "-"
      return ok ? { value: raw } : { error: 'key "slug": not a slug' };
    }
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body: { data, body }, or { error } with the first
 * reason it is refused. `text` has "\n" line ends. The close line is found
 * first (a source with no close is refused for that, whatever its lines hold),
 * then the lines between are checked in order.
 */
function parseFrontMatter(text) {
  if (text !== '---' && !text.startsWith('---\n')) return { error: 'no front matter' };
  if (text.length === 3) return { error: 'the front matter is not closed' };
  let closeStart = -1;
  let closeEnd = -1;
  let pos = 4;
  while (pos <= text.length) {
    const nl = text.indexOf('\n', pos);
    const lineEnd = nl === -1 ? text.length : nl;
    if (lineEnd - pos === 3 && text.charCodeAt(pos) === 45 && text.charCodeAt(pos + 1) === 45 && text.charCodeAt(pos + 2) === 45) {
      closeStart = pos;
      closeEnd = nl === -1 ? text.length : nl + 1;
      break;
    }
    if (nl === -1) break;
    pos = nl + 1;
  }
  if (closeStart === -1) return { error: 'the front matter is not closed' };
  const data = {};
  pos = 4;
  let lineNo = 2;
  while (pos < closeStart) {
    const nl = text.indexOf('\n', pos);
    const lineEnd = nl === -1 ? closeStart : nl;
    const c0 = text.charCodeAt(pos);
    if (c0 === 35) {
      // A comment: "#" first.
    } else if (lineEnd === pos) {
      // A blank line.
    } else if (c0 === 32 || c0 === 9) {
      let blank = true;
      for (let i = pos + 1; i < lineEnd; i++) {
        const c = text.charCodeAt(i);
        if (c !== 32 && c !== 9) {
          blank = false;
          break;
        }
      }
      if (!blank) {
        const err = parseFmLine(text, pos, lineEnd, lineNo, data);
        if (err !== null) return { error: err };
      }
    } else {
      const err = parseFmLine(text, pos, lineEnd, lineNo, data);
      if (err !== null) return { error: err };
    }
    pos = nl === -1 ? closeStart : nl + 1;
    lineNo++;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(closeEnd) };
}

/** One front-matter line, `key: value` with one space after the colon: null when it reads, else the refusal reason. */
function parseFmLine(text, a, b, lineNo, data) {
  let i = a;
  while (i < b) {
    const c = text.charCodeAt(i);
    if (!((c >= 97 && c <= 122) || c === 95)) break;
    i++;
  }
  if (i === a || i >= b || text.charCodeAt(i) !== 58) return `line ${lineNo} is not "key: value"`;
  const key = text.slice(a, i);
  i++;
  let rawStart = i;
  let rawEnd = b;
  if (i < b) {
    if (text.charCodeAt(i) !== 32) return `line ${lineNo} is not "key: value"`;
    rawStart = i + 1;
  }
  while (rawEnd > rawStart) {
    const c = text.charCodeAt(rawEnd - 1);
    if (c !== 32 && c !== 9) break;
    rawEnd--;
  }
  const raw = text.slice(rawStart, rawEnd);
  if (!KEYS.has(key)) return `unknown key "${key}"`;
  if (Object.hasOwn(data, key)) return `key "${key}" is given twice`;
  if (raw === '') return `key "${key}" has no value`;
  const v = valueOf(key, raw);
  if ('error' in v) return v.error;
  data[key] = v.value;
  return null;
}

// ---------------------------------------------------------------- markdown

/** The characters a backslash escapes, by code (all below 128). */
const ESCAPABLE = new Uint8Array(128);
for (const ch of '\\`*_[]()#+-.!>') ESCAPABLE[ch.charCodeAt(0)] = 1;

/** Inline's special characters: structural ones plus the five HTML-escape ones, so plain runs need no escaping at all. */
const INLINE_RE = /[\\`*\[&<>"']/g;

/** Whether `line` is blank: spaces and tabs only. */
function isBlank(line) {
  if (line === '') return true;
  const c = line.charCodeAt(0);
  if (c !== 32 && c !== 9) return false;
  for (let i = 1; i < line.length; i++) {
    const d = line.charCodeAt(i);
    if (d !== 32 && d !== 9) return false;
  }
  return true;
}

/** A fence's language ("" for none), or null when `line` does not open a fence: ```, a language, spaces or tabs only. */
function fenceOpen(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let i = 3;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) i++;
    else break;
  }
  const lang = line.slice(3, i);
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return null;
    i++;
  }
  return lang;
}

/** Whether `line` closes a fence: ```, spaces or tabs only. */
function isFenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A heading line's level and text, or null (a heading's text is never empty; 7 or more # is not a heading). */
function headingOf(line) {
  let n = 0;
  while (n < line.length && line.charCodeAt(n) === 35) n++;
  if (n === 0 || n > 6) return null;
  let s = n;
  while (s < line.length) {
    const c = line.charCodeAt(s);
    if (c !== 32 && c !== 9) break;
    s++;
  }
  if (s === n) return null;
  let end = line.length;
  while (end > s) {
    const d = line.charCodeAt(end - 1);
    if (d !== 32 && d !== 9) break;
    end--;
  }
  const text = line.slice(s, end);
  return text === '' ? null : { depth: n, text };
}

/** Whether `line` is a thematic break: --- or ***, then spaces or tabs only. */
function isHr(line) {
  const c0 = line.charCodeAt(0);
  if (c0 !== 45 && c0 !== 42) return false;
  if (line.charCodeAt(1) !== c0 || line.charCodeAt(2) !== c0) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** Whether the character at `i` of `s` is JavaScript whitespace. */
function isSpaceChar(s, i) {
  const c = s.charCodeAt(i);
  if (c === 32 || (c >= 9 && c <= 13)) return true;
  if (c < 128) return false;
  return WS_RE.test(s[i]);
}

/** Whether `line` continues a list item: two or more spaces, then a non-space. */
function isContinued(line) {
  if (line.charCodeAt(0) !== 32 || line.charCodeAt(1) !== 32) return false;
  let i = 2;
  while (i < line.length && line.charCodeAt(i) === 32) i++;
  return i < line.length && !isSpaceChar(line, i);
}

/** A line as it is rendered: spaces and tabs at either end dropped. */
function trimLine(line) {
  const b = line.length;
  if (b === 0) return line;
  const first = line.charCodeAt(0);
  const last = line.charCodeAt(b - 1);
  if (first !== 32 && first !== 9 && last !== 32 && last !== 9) return line;
  let a = 0;
  let e = b;
  while (a < e) {
    const c = line.charCodeAt(a);
    if (c !== 32 && c !== 9) break;
    a++;
  }
  while (e > a) {
    const c = line.charCodeAt(e - 1);
    if (c !== 32 && c !== 9) break;
    e--;
  }
  return line.slice(a, e);
}

/** A list's first item: { ordered, start, text }, or null. An ordered marker is 1 to 9 digits, ". " after them. */
function listStart(line) {
  const c0 = line.charCodeAt(0);
  if ((c0 === 45 || c0 === 42) && line.charCodeAt(1) === 32) return { ordered: false, start: 1, text: line.slice(2) };
  if (c0 >= 48 && c0 <= 57) {
    let i = 0;
    while (i < line.length && i < 9) {
      const c = line.charCodeAt(i);
      if (c < 48 || c > 57) break;
      i++;
    }
    if (line.charCodeAt(i) === 46 && line.charCodeAt(i + 1) === 32) return { ordered: true, start: Number(line.slice(0, i)), text: line.slice(i + 2) };
  }
  return null;
}

/** A following item of a list of `ordered` kind: its text, or null. */
function listItem(line, ordered) {
  if (ordered) {
    const c0 = line.charCodeAt(0);
    if (c0 < 48 || c0 > 57) return null;
    let i = 0;
    while (i < line.length && i < 9) {
      const c = line.charCodeAt(i);
      if (c < 48 || c > 57) break;
      i++;
    }
    return line.charCodeAt(i) === 46 && line.charCodeAt(i + 1) === 32 ? line.slice(i + 2) : null;
  }
  const c0 = line.charCodeAt(0);
  return (c0 === 45 || c0 === 42) && line.charCodeAt(1) === 32 ? line.slice(2) : null;
}

/** Whether `line` ends a paragraph: a blank line, a fence, a heading or a thematic break. */
function endsParagraph(line) {
  return isBlank(line) || fenceOpen(line) !== null || headingOf(line) !== null || isHr(line);
}

/**
 * The first index from `from` where `s` holds `what` outside a backslash
 * escape, within [from, b), or -1. The reference scans left to right consuming
 * escape pairs; a candidate is escaped exactly when an odd run of backslashes
 * stands immediately before it (pairs consume two at a time, and the run's
 * first backslash is preceded by a non-backslash, so pairing inside the run
 * starts fresh there).
 */
function findUnescaped(s, what, from, b) {
  let j = from;
  while (true) {
    const p = s.indexOf(what, j);
    if (p === -1 || p + what.length > b) return -1;
    let bs = 0;
    for (let q = p - 1; q >= from && s.charCodeAt(q) === 92; q--) bs++;
    if (bs % 2 === 0) return p;
    j = p + 1;
  }
}

/** The first single * from `from` (one whose run is not **) outside an escape, within [from, b), or -1. */
function findSingleStar(s, from, b) {
  let j = from;
  while (true) {
    const p = s.indexOf('*', j);
    if (p === -1 || p >= b) return -1;
    let bs = 0;
    for (let q = p - 1; q >= from && s.charCodeAt(q) === 92; q--) bs++;
    if (bs % 2 === 1) {
      j = p + 1;
      continue;
    }
    if (p + 1 < b && s.charCodeAt(p + 1) === 42) {
      j = p + 2;
      continue;
    }
    return p;
  }
}

/**
 * `s[a..b)` rendered inline into `out`; `link(target)` is a link's href.
 * One native regex finds every special character (structural and HTML-escape
 * ones); the plain runs between matches are pushed as they are. Recursion
 * (strong, emphasis, link text) works on index ranges, so no substrings are
 * cut for it.
 */
function inlineRange(s, a, b, link, out) {
  let pos = a;
  while (pos < b) {
    INLINE_RE.lastIndex = pos;
    const m = INLINE_RE.exec(s);
    if (m === null || m.index >= b) {
      out.push(s.slice(pos, b));
      return;
    }
    const i = m.index;
    if (i > pos) out.push(s.slice(pos, i));
    const c = s.charCodeAt(i);
    if (c === 38) {
      out.push('&amp;');
      pos = i + 1;
      continue;
    }
    if (c === 60) {
      out.push('&lt;');
      pos = i + 1;
      continue;
    }
    if (c === 62) {
      out.push('&gt;');
      pos = i + 1;
      continue;
    }
    if (c === 34) {
      out.push('&quot;');
      pos = i + 1;
      continue;
    }
    if (c === 39) {
      out.push('&#39;');
      pos = i + 1;
      continue;
    }
    if (c === 92) {
      // A backslash: before an escapable character it writes that character (escaped); else it is itself.
      if (i + 1 < b) {
        const n = s.charCodeAt(i + 1);
        if (n < 128 && ESCAPABLE[n]) {
          out.push(n === 62 ? '&gt;' : s[i + 1]);
          pos = i + 2;
          continue;
        }
      }
      out.push('\\');
      pos = i + 1;
      continue;
    }
    if (c === 96) {
      // A code span: the next backtick closes it, with at least one character between.
      const j = s.indexOf('`', i + 1);
      if (j !== -1 && j < b && j > i + 1) {
        out.push('<code>', esc(s.slice(i + 1, j)), '</code>');
        pos = j + 1;
      } else {
        out.push('`');
        pos = i + 1;
      }
      continue;
    }
    if (c === 42) {
      if (i + 1 < b && s.charCodeAt(i + 1) === 42) {
        const j = findUnescaped(s, '**', i + 2, b);
        if (j !== -1 && j > i + 2) {
          out.push('<strong>');
          inlineRange(s, i + 2, j, link, out);
          out.push('</strong>');
          pos = j + 2;
        } else {
          out.push('**');
          pos = i + 2;
        }
      } else {
        const j = findSingleStar(s, i + 1, b);
        if (j !== -1 && j > i + 1) {
          out.push('<em>');
          inlineRange(s, i + 1, j, link, out);
          out.push('</em>');
          pos = j + 1;
        } else {
          out.push('*');
          pos = i + 1;
        }
      }
      continue;
    }
    // A link: the first unescaped ] closes the text, "(" must follow at once, the next ")" closes the target.
    const k = findUnescaped(s, ']', i + 1, b);
    let done = false;
    if (k !== -1 && k + 1 < b && s.charCodeAt(k + 1) === 40) {
      const mm = s.indexOf(')', k + 2);
      if (mm !== -1 && mm < b) {
        const target = s.slice(k + 2, mm);
        if (target !== '' && !WS_RE.test(target)) {
          out.push('<a href="', esc(link(target)), '">');
          inlineRange(s, i + 1, k, link, out);
          out.push('</a>');
          pos = mm + 1;
          done = true;
        }
      }
    }
    if (!done) {
      out.push('[');
      pos = i + 1;
    }
  }
}

/**
 * `src` rendered: its HTML (each block on its own lines, a "\n" after the
 * last), its table of contents (every level 2 and 3 heading: level, id and its
 * inline HTML) and its excerpt (the first paragraph's inline HTML, or "").
 * Blocks are lexed and rendered in one pass, straight into the output array.
 */
function renderMarkdown(src, link) {
  const lines = src.split('\n');
  const blocks = [];
  const toc = [];
  let excerpt = null;
  const ids = new Set();
  const n = lines.length;
  let i = 0;
  while (i < n) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }
    const lang = fenceOpen(line);
    if (lang !== null) {
      const bodyLines = [];
      i++;
      while (i < n && !isFenceClose(lines[i])) bodyLines.push(lines[i++]);
      i++;
      const cls = lang === '' ? '' : ` class="language-${lang}"`;
      blocks.push(`<pre><code${cls}>${bodyLines.length === 0 ? '' : `${esc(bodyLines.join('\n'))}\n`}</code></pre>`);
      continue;
    }
    const hd = headingOf(line);
    if (hd !== null) {
      const id = uniqueSlug(slugify(hd.text), ids);
      const out = [];
      inlineRange(hd.text, 0, hd.text.length, link, out);
      const html = out.join('');
      blocks.push(`<h${hd.depth} id="${id}">${html}</h${hd.depth}>`);
      if (hd.depth === 2 || hd.depth === 3) toc.push({ level: hd.depth, id, html });
      i++;
      continue;
    }
    if (isHr(line)) {
      blocks.push('<hr>');
      i++;
      continue;
    }
    if (line.charCodeAt(0) === 62) {
      const qlines = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        let l = lines[i++].slice(1);
        if (l.charCodeAt(0) === 32) l = l.slice(1);
        l = trimLine(l);
        if (l !== '') qlines.push(l);
      }
      if (qlines.length === 0) {
        blocks.push('<blockquote>\n</blockquote>');
      } else {
        const text = qlines.join('\n');
        const out = [];
        inlineRange(text, 0, text.length, link, out);
        blocks.push(`<blockquote>\n<p>${out.join('')}</p>\n</blockquote>`);
      }
      continue;
    }
    const li = listStart(line);
    if (li !== null) {
      const ordered = li.ordered;
      const items = [[trimLine(li.text)]];
      i++;
      while (i < n) {
        const m = listItem(lines[i], ordered);
        if (m !== null) {
          items.push([trimLine(m)]);
          i++;
        } else if (isContinued(lines[i])) {
          items[items.length - 1].push(trimLine(lines[i]));
          i++;
        } else break;
      }
      const tag = ordered ? 'ol' : 'ul';
      const open = ordered && li.start !== 1 ? `<ol start="${li.start}">` : `<${tag}>`;
      let s = `${open}\n`;
      for (const parts of items) {
        const text = parts.join('\n');
        const out = [];
        inlineRange(text, 0, text.length, link, out);
        s += `<li>${out.join('')}</li>\n`;
      }
      s += `</${tag}>`;
      blocks.push(s);
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const text = body.join('\n');
    const out = [];
    inlineRange(text, 0, text.length, link, out);
    const html = out.join('');
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>`);
  }
  return { html: blocks.length === 0 ? '' : `${blocks.join('\n')}\n`, toc, excerpt: excerpt === null ? '' : excerpt };
}

// ---------------------------------------------------------------- templates

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

/** Node kinds: text, {{ }}, {{{ }}}, if, for, include. */
const T_TEXT = 0;
const T_VAR = 1;
const T_RAW = 2;
const T_IF = 3;
const T_FOR = 4;
const T_INCLUDE = 5;

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** Whether `src[a..b)` holds only spaces and tabs. */
function isSpacesOnly(src, a, b) {
  for (let i = a; i < b; i++) {
    const c = src.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/**
 * `src` parsed into its tree of nodes (a TemplateError when it does not
 * parse). Tokenising and tree-building run in one pass; the rules are the
 * reference's, including a {% %} tag alone on its line taking the whole line
 * with it, its newline included.
 */
function parseTemplate(name, src) {
  const root = [];
  const stack = [{ kind: 'root', node: null, body: root }];
  let body = root;
  let text = '';
  let i = 0;
  const flushText = () => {
    if (text !== '') {
      body.push([T_TEXT, text]);
      text = '';
    }
  };
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      flushText();
      body.push([raw ? T_RAW : T_VAR, pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim())]);
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = isSpacesOnly(src, lineStart, open) && isSpacesOnly(src, end, lineEnd);
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    flushText();
    const tag = src.slice(open + 2, close).trim();
    const top = stack[stack.length - 1];
    let m;
    if ((m = FOR_RE.exec(tag)) !== null) {
      const node = [T_FOR, m[1], pathOf(name, m[2]), []];
      body.push(node);
      stack.push({ kind: 'for', node, body: node[3] });
      body = node[3];
    } else if ((m = IF_RE.exec(tag)) !== null) {
      const node = [T_IF, m[1] !== undefined, pathOf(name, m[2]), [], null];
      body.push(node);
      stack.push({ kind: 'if', node, body: node[3] });
      body = node[3];
    } else if (tag === 'else') {
      if (top.kind !== 'if' || top.node[4] !== null) throw new TemplateError(`template "${name}": an else outside an if`);
      top.node[4] = [];
      top.body = top.node[4];
      body = top.body;
    } else if (tag === 'endfor' || tag === 'endif') {
      if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
      stack.pop();
      body = stack[stack.length - 1].body;
    } else if ((m = INCLUDE_RE.exec(tag)) !== null) {
      body.push([T_INCLUDE, m[1]]);
    } else {
      throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  flushText();
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/**
 * The value at `path`: its first name from the innermost scope holding it
 * (`loop` before the element), else from the page's values; each next name an
 * own property of the value so far, or the path is undefined. `frames` is a
 * flat stack of [name, value, loop] triples, innermost last.
 */
function lookup(frames, root, path) {
  const first = path[0];
  let v;
  if (first === 'loop') {
    if (frames.length === 0) return undefined;
    v = frames[frames.length - 1];
  } else {
    let found = false;
    for (let i = frames.length - 3; i >= 0; i -= 3) {
      if (frames[i] === first) {
        v = frames[i + 1];
        found = true;
        break;
      }
    }
    if (!found) {
      if (!Object.hasOwn(root, first)) return undefined;
      v = root[first];
    }
  }
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/**
 * `nodes` rendered into `out`. `ctx` holds the parsed templates, the constant
 * templates' cache (name + depth -> rendered string) and the flat scope stack.
 */
function renderNodes(nodes, root, out, depth, ctx) {
  const frames = ctx.frames;
  for (let n = 0; n < nodes.length; n++) {
    const node = nodes[n];
    const kind = node[0];
    if (kind === T_TEXT) {
      out.push(node[1]);
      continue;
    }
    if (kind === T_VAR) {
      const v = lookup(frames, root, node[1]);
      out.push(esc(typeof v === 'string' ? v : textOf(v)));
      continue;
    }
    if (kind === T_RAW) {
      const v = lookup(frames, root, node[1]);
      out.push(typeof v === 'string' ? v : textOf(v));
      continue;
    }
    if (kind === T_IF) {
      const branch = truthy(lookup(frames, root, node[2])) !== node[1] ? node[3] : node[4];
      if (branch !== null) renderNodes(branch, root, out, depth, ctx);
      continue;
    }
    if (kind === T_FOR) {
      const xs = lookup(frames, root, node[2]);
      if (!Array.isArray(xs)) continue;
      const body = node[3];
      const len = xs.length;
      for (let k = 0; k < len; k++) {
        frames.push(node[1], xs[k], { index: k + 1, first: k === 0, last: k === len - 1, length: len });
        renderNodes(body, root, out, depth, ctx);
        frames.length -= 3;
      }
      continue;
    }
    // An include: the template in the same scope, at most INCLUDE_DEPTH deep.
    const name = node[1];
    const t = ctx.templates.get(name);
    if (t === undefined || depth >= INCLUDE_DEPTH) continue;
    if (ctx.constNames.has(name)) {
      const key = `${name}|${depth + 1}`;
      let cached = ctx.constant.get(key);
      if (cached === undefined) {
        const tmp = [];
        renderNodes(t, root, tmp, depth + 1, ctx);
        cached = tmp.join('');
        ctx.constant.set(key, cached);
      }
      out.push(cached);
      continue;
    }
    renderNodes(t, root, out, depth + 1, ctx);
  }
}

/**
 * The templates whose rendering depends only on site, tags and recent (the
 * values shared by every render of a build), so each renders once per build
 * and depth and is reused. A template's dependencies are the first names of
 * the paths it reads that no enclosing for binds, plus its includes'
 * dependencies (a fixpoint over the include graph, so cycles settle); a
 * template is constant only when every dependency is site, tags or recent and
 * no for-loop anywhere binds one of those names (else an include inside such
 * a loop would see the element, not the root value).
 */
function analyzeConstants(templates) {
  const ownDeps = new Map();
  const includes = new Map();
  const allForNames = new Set();
  for (const [name, nodes] of templates) {
    const deps = new Set();
    const inc = [];
    const walk = (ns, bound) => {
      for (const node of ns) {
        const kind = node[0];
        if (kind === T_VAR || kind === T_RAW) {
          const first = node[1][0];
          if (!bound.has(first)) deps.add(first);
        } else if (kind === T_IF) {
          const first = node[2][0];
          if (!bound.has(first)) deps.add(first);
          walk(node[3], bound);
          if (node[4] !== null) walk(node[4], bound);
        } else if (kind === T_FOR) {
          const first = node[2][0];
          if (!bound.has(first)) deps.add(first);
          allForNames.add(node[1]);
          const inner = new Set(bound);
          inner.add(node[1]);
          inner.add('loop');
          walk(node[3], inner);
        } else if (kind === T_INCLUDE) {
          inc.push(node[1]);
        }
      }
    };
    walk(nodes, new Set());
    ownDeps.set(name, deps);
    includes.set(name, inc);
  }
  const deps = new Map();
  for (const [name, d] of ownDeps) deps.set(name, new Set(d));
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, inc] of includes) {
      const d = deps.get(name);
      for (const u of inc) {
        const du = deps.get(u);
        if (du === undefined) continue;
        for (const x of du) {
          if (!d.has(x)) {
            d.add(x);
            changed = true;
          }
        }
      }
    }
  }
  const constNames = new Set();
  for (const [name, d] of deps) {
    let ok = true;
    for (const x of d) {
      if ((x !== 'site' && x !== 'tags' && x !== 'recent') || allForNames.has(x)) {
        ok = false;
        break;
      }
    }
    if (ok) constNames.add(name);
  }
  return constNames;
}

// ---------------------------------------------------------------- the build

const CRLF_RE = /\r\n?/g;

/** `site.base_url` with its trailing slashes dropped. */
function stripBase(baseUrl) {
  let e = baseUrl.length;
  while (e > 0 && baseUrl.charCodeAt(e - 1) === 47) e--;
  return e === baseUrl.length ? baseUrl : baseUrl.slice(0, e);
}

/**
 * A link's href: a target with a scheme, opening on "/" or "#", is kept as
 * written; any other is a path from the source's directory, resolved to the
 * url of the page built from that source, or <base>/<path> of a static file;
 * a target naming neither is reported as a broken link and kept as written.
 * The resolution (not the report, which names the source) is cached per
 * (directory, path) for the build.
 */
function resolveLink(target, dir, sourcePath, base, bySource, staticPaths, broken, cache) {
  if (hasScheme(target) || target.startsWith('/') || target.startsWith('#')) return target;
  const hash = target.indexOf('#');
  const rel = hash === -1 ? target : target.slice(0, hash);
  const frag = hash === -1 ? '' : target.slice(hash);
  if (rel === '') {
    broken.add(`broken-link ${sourcePath} -> ${target}`);
    return target;
  }
  const key = `${dir.length}:${dir}${rel}`;
  let hit = cache.get(key);
  if (hit === undefined) {
    const path = resolvePath(dir, rel);
    if (path !== null && bySource.has(path)) hit = bySource.get(path).url;
    else if (path !== null && staticPaths.has(path)) hit = `${base}/${path}`;
    else hit = null;
    cache.set(key, hit);
  }
  if (hit === null) {
    broken.add(`broken-link ${sourcePath} -> ${target}`);
    return target;
  }
  return hit + frag;
}

/** makefun-site 1.0.0's answer for one case's input, faster. */
export function run(input) {
  const site = input.site;
  const base = stripBase(site.base_url);

  // Templates, parsed in code-unit order of their name; one that does not parse is reported and left out.
  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort()) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (err instanceof TemplateError) report.push(err.message);
      else throw err;
    }
  }
  const ctx = { templates, constant: new Map(), constNames: analyzeConstants(templates), frames: [] };

  // Sources, in code-unit order of their paths, line ends made "\n"; a source that is not .md is static.
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      const text = f.content.indexOf('\r') === -1 ? f.content : f.content.replace(CRLF_RE, '\n');
      sources.push({ path: f.path, text });
    } else {
      statics.push(f);
    }
  }

  // Front matter: a refused source is reported and dropped, and so is a draft. The checks run in order.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    const data = fm.data;
    const post = s.path.startsWith('posts/');
    const own = s.path.startsWith('tags/') ? 'tags' : s.path.startsWith('page/') ? 'page' : null;
    if (own !== null) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (post && !Object.hasOwn(data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = data.layout ?? (post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    if (data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push({ path: s.path, body: fm.body, data, post, layout });
  }

  // Permalinks: each page's directory and url, its slug made unique in its directory, in source order.
  const taken = new Map();
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // Markdown: each body's HTML, its links resolved to the pages and static files they name.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  const linkCache = new Map();
  for (const s of kept) {
    const dir = dirOf(s.path);
    const link = (target) => resolveLink(target, dir, s.path, base, bySource, staticPaths, broken, linkCache);
    const md = renderMarkdown(s.body, link);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // Collections: the posts, newest date first, equal dates by slug; each post's newer and older neighbours.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  for (let k = 0; k < posts.length; k++) {
    posts[k].newer = k === 0 ? null : posts[k - 1];
    posts[k].older = k === posts.length - 1 ? null : posts[k + 1];
  }

  // Tags: grouped by their slug, each named as first met in the posts' order, ordered by count and then slug.
  const bySlug = new Map();
  for (const p of posts) {
    p.tagRefs = [];
    const seen = new Set();
    const names = p.data.tags ?? [];
    for (const name of names) {
      const slug = slugify(name);
      if (seen.has(slug)) continue;
      seen.add(slug);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (s.post) continue;
    s.tagRefs = [];
    const seen = new Set();
    const names = s.data.tags ?? [];
    for (const name of names) {
      const slug = slugify(name);
      if (seen.has(slug)) continue;
      seen.add(slug);
      s.tagRefs.push(bySlug.get(slug) ?? { name, slug, url: '' });
    }
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // Each source's card, link record and mapped toc, computed once and reused by every render that reads them.
  for (const s of kept) {
    const date = s.data.date;
    const dateLong = date === undefined ? '' : longDate(date);
    const dateStr = date ?? '';
    const cardTags = s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url }));
    s.card = {
      title: s.data.title,
      url: s.url,
      date: dateStr,
      date_long: dateLong,
      summary: s.data.summary ?? '',
      excerpt: s.excerpt,
      reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
      tags: cardTags,
    };
    s.link = { title: s.data.title, url: s.url, date: dateStr, date_long: dateLong };
    s.tocMapped = s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html }));
  }

  // Layouts: every page through its layout, the index pages and the tag pages through theirs.
  const output = {};
  const siteCtx = { title: site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, site.recent).map((p) => p.card);
  const render = (name, vars) => {
    const nodes = templates.get(name);
    if (nodes === undefined) return null;
    const root = { site: siteCtx, tags: allTags, recent, ...vars };
    const out = [];
    renderNodes(nodes, root, out, 0, ctx);
    return out.join('');
  };
  for (const s of kept) {
    const page = {
      ...s.card,
      slug: s.slug,
      content: s.html,
      toc: s.tocMapped,
      newer: s.post ? (s.newer === null ? null : s.newer.link) : null,
      older: s.post ? (s.older === null ? null : s.older.link) : null,
      is_post: s.post,
    };
    output[`${s.outDir}/index.html`] = render(s.layout, { page });
  }
  const per = site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => p.card),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => p.card) } });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // The report: every refusal, draft, broken link and template that did not parse, sorted, then the counts.
  const lines = [...report, ...broken].sort();
  let pageCount = 0;
  for (const s of kept) if (!s.post) pageCount++;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output[REPORT_FILE] = `${lines.join('\n')}\n`;
  return output;
}
