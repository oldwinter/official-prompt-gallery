import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { checkLanding } from '../check-landing.mjs';

const fixtureRoot = await mkdtemp(path.join(tmpdir(), 'landing-check-'));
await mkdir(path.join(fixtureRoot, 'assets'));
await writeFile(path.join(fixtureRoot, 'assets/landing.css'), '/* fixture */');

async function check(reference) {
  await writeFile(path.join(fixtureRoot, 'index.html'), `<!doctype html><link rel="stylesheet" href="${reference}">`);
  return checkLanding(fixtureRoot);
}

let report = await check('assets/landing.css');
assert.deepEqual(report, { checked: 1, errors: [] }, 'relative stylesheet must resolve inside the deployed tree');

report = await check('/official-prompt-gallery/assets/landing.css');
assert.deepEqual(report, { checked: 1, errors: [] }, 'project-prefixed stylesheet must resolve to the same checkout file');

report = await check('/official-prompt-gallery/');
assert.deepEqual(report, { checked: 1, errors: [] }, 'bare project path maps to the repository root index.html');

report = await check('/assets/landing.css');
assert.equal(report.checked, 1, 'root-absolute reference still targets the deployed origin');
assert.equal(report.errors.length, 1, 'root-absolute reference must fail: the browser resolves it outside /official-prompt-gallery/');
assert.match(report.errors[0].message, /outside/, 'root-absolute failure must name the base-path escape');

report = await check('https://oldwinter.github.io/official-prompt-gallery/assets/landing.css');
assert.deepEqual(report, { checked: 1, errors: [] }, 'full same-origin URL inside the project base must resolve');

report = await check('https://oldwinter.github.io/other-project/landing.css');
assert.equal(report.checked, 1);
assert.equal(report.errors.length, 1, 'same-origin URL outside the project base must fail even though it is reachable');

report = await check('../landing.css');
assert.equal(report.checked, 1);
assert.equal(report.errors.length, 1, 'relative reference escaping the project base must fail');

report = await check('https://github.com/oldwinter/official-prompt-gallery');
assert.deepEqual(report, { checked: 0, errors: [] }, 'off-origin links are not part of the deployed tree');

assert.deepEqual(await checkLanding(), { checked: 6, errors: [] }, 'the real landing page must still pass');
console.log('PASS landing reference smoke fixture');
