# makefun-site, faster

[![make.fun](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/c/site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/uzytry/site-generator-speed-01-run-20261122-entry/rank.svg)](https://make.fun/c/site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/uzytry/site-generator-speed-01-run-20261122-entry/reward.svg)](https://make.fun/c/site-generator-speed-01-run-20261122)

A faster drop-in replacement for make.fun's own makefun-site 1.0.0, built for
the [site-generator-speed-01-run-20261122](https://make.fun/c/site-generator-speed-01-run-20261122)
competition on [make.fun](https://make.fun). It answers exactly as
makefun-site 1.0.0 does on every case — the whole output tree for one generated
site (each page's `index.html`, the index and tag pages, `build-report.txt`
and each static file), byte for byte — and does it in less CPU time than the
house baseline.

## How it is faster

The reference spends about 40% of its CPU in `escapeHtml` and its
per-character inline Markdown renderer, and another ~12% in GC. This entry
reimplements the same rules with bulk native operations instead:

- Inline Markdown is scanned with one native regex for structural characters
  (`\`, backtick, `*`, `[`) and the five HTML-escape characters at once, so
  the plain runs between matches need no escaping at all, instead of one regex
  replace per character.
- Strong/emphasis/link closers are found with `indexOf` plus a backslash-parity
  check, which is exactly the reference's left-to-right escape-pair scan;
  recursion works on index ranges, so no substrings are cut for it.
- Blocks are lexed and rendered in a single pass with hand-written
  first-character checks instead of a regex per line, and no token objects are
  built: blocks render straight into the output array.
- Front matter is scanned by line offsets (no split/join of the whole file);
  the body is a slice, not a rejoin.
- `slugify` takes an ASCII fast path (a `charCodeAt` loop) and only falls back
  to NFKD plus combining-mark stripping when a non-ASCII character appears.
- Word counts are one `charCodeAt` pass instead of `match(/\S+/g)`.
- Cards, link records, mapped toc arrays and reading times are computed once
  per source and reused (the reference recomputes a post's card and word count
  twice); link targets are resolved once per (directory, path) per build
  instead of once per link.
- Templates render into an output array through a flat scope stack (no scope
  object per loop iteration), and templates whose output depends only on
  `site`/`tags`/`recent` — proved by a dependency analysis over the include
  graph — are rendered once per build and depth and reused.
- Nothing is cached from one case to the next: every cache above lives inside
  a single `run()` call.

## Layout

- `solve.js` — the entry: a dependency-free ES module whose `run(input)`
  returns makefun-site 1.0.0's answer for one case's input.
- `main.ts` — the program the harness runs: reads every case from
  `/input/cases.json`, answers each with `run`, writes `/output/answers.json`.
- `package.json` — `{"type": "module"}`.

## Verification

- Practice set (3 cases, 1,070 Markdown sources): answers identical to the
  reference on every case, confirmed by the kit's own scorer (`passed: 1`)
  and by `grade-local` (two executions, reproduced byte for byte).
- Also checked against the reference on 30 freshly drawn instances from the
  kit's own generator (10 different seeds, 12,342 output files): 0 mismatches.
- Speed on this machine (fresh-process runs of `node main.ts` on the practice
  set, CPU time, trimmed mean of 7 rounds each): this entry 0.85 s vs the
  house baseline 1.82 s — about 2.1x faster. The `run()` work alone, warm, is
  about 0.19 s vs the reference's ~0.94 s.

## License

MIT — see [LICENSE](LICENSE).
