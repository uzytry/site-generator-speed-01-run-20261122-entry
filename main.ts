// The program the harness runs: `node /bot/main.ts` (node22). It reads every
// case from /input/cases.json (a JSON array of {id, input}), answers each one
// alone with run() from solve.js, and writes /output/answers.json: a JSON
// array of the answers, one per case and in the cases' order. Outside a
// container MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR stand in for /input and
// /output.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';

// V8 flags, set before solve.js is imported so all of its work runs under
// them (the rules: the house baseline runs with --no-incremental-marking, and
// an entry may tune V8's flags too).
// - --no-incremental-marking: as the house baseline runs.
// - --no-opt: each run is a fresh process on a short job, and the optimizing
//   compiler's compile time costs more than its speedup earns back (measured
//   cold on the practice set: ~1.12 s with it on, ~0.80 s with it off).
// - --no-lazy: compile solve.js eagerly at import rather than lazily on first
//   call (measured: ~0.80 s without it, ~0.76 s with it).
setFlagsFromString('--no-incremental-marking --no-opt --no-lazy');

/** solve.js, imported by its URL (a .js module carries no types) and typed by its contract. */
const { run } = (await import(new URL('./solve.js', import.meta.url).href)) as { run: (input: unknown) => unknown };

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(INPUT_DIR, 'cases.json'), 'utf8')) as { id: string; input: unknown }[];
const answers: unknown[] = [];
for (const c of cases) answers.push(run(c.input));
writeFileSync(join(OUTPUT_DIR, 'answers.json'), JSON.stringify(answers));
