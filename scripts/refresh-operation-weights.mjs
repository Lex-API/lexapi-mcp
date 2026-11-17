#!/usr/bin/env node
// Rewrites tests/fixtures/operation-weights.json from the LexAPI API's
// operation-weight module, so tests/credit-costs.test.ts compares the costs
// written in the tool descriptions with what the API charges.
//
//   node scripts/refresh-operation-weights.mjs <path to the API's server/utils/operationWeights.js>
//
// Only operation names and numbers are copied. Run it when the API changes a
// weight, then fix whatever description the test names.
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const source = process.argv[2];
if (!source) {
  console.error('usage: node scripts/refresh-operation-weights.mjs <path to operationWeights.js>');
  process.exit(2);
}

const mod = createRequire(import.meta.url)(resolve(source));
const numbers = (o) => Object.fromEntries(
  Object.entries(o).filter(([, v]) => typeof v === 'number').sort(([a], [b]) => a.localeCompare(b)),
);
const fixture = {
  weights: numbers(mod.WEIGHTS),
  corpusHit: mod.CORPUS_HIT_WEIGHT,
  cellarHit: mod.CELLAR_HIT_WEIGHT,
};
if (!Object.keys(fixture.weights).length || typeof fixture.corpusHit !== 'number' || typeof fixture.cellarHit !== 'number') {
  console.error(`${source} does not export WEIGHTS, CORPUS_HIT_WEIGHT and CELLAR_HIT_WEIGHT`);
  process.exit(1);
}

const out = fileURLToPath(new URL('../tests/fixtures/operation-weights.json', import.meta.url));
writeFileSync(out, `${JSON.stringify(fixture, null, 2)}\n`);
console.log(`wrote ${out}: ${Object.keys(fixture.weights).length} operations`);
