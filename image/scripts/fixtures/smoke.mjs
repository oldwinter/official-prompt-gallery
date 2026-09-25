import assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseProviderResponse, operationKey, updateHtmlState } from '../capture.mjs';
import { hasExactServedModel, parseManifest, validateHtmlProjection } from '../validate.mjs';

const manifest = parseManifest(await readFile(new URL('../../data/comparison.json', import.meta.url), 'utf8'));
const request = {
  repository: manifest.repository,
  media_kind: manifest.media_kind,
  case_id: 'openai-official-01',
  route_id: 'grok-image',
  prompt: manifest.cases['openai-official-01'].prompt.text,
  prompt_sha256: manifest.cases['openai-official-01'].prompt.sha256,
  requested_model: manifest.routes['grok-image'].requested_model,
  parameters: manifest.samples['openai-official-01']['grok-image'].parameters,
};
assert.equal(operationKey(request), operationKey({ ...request }), 'operation keys must be stable');
assert.equal(parseProviderResponse({ id: 'grok-image' }, { status: 'pending', id: 'job-1' }).kind, 'pending');
assert.throws(() => parseProviderResponse({ id: 'grok-image' }, { status: 'expired', id: 'job-1' }), /failed image operation/);
assert.throws(() => parseProviderResponse({ id: 'grok-image' }, { status: 'unknown', id: 'job-1' }), /image data/);
assert.equal(hasExactServedModel(manifest.routes['grok-image'], { kind: 'not-exposed', reason: 'provider-response-omits-model' }), false);
assert.equal(hasExactServedModel(manifest.routes['grok-image'], { kind: 'provider-reported', id: 'grok-imagine-image-1.0', receipt_field: 'model' }), false);
assert.equal(hasExactServedModel(manifest.routes['grok-image'], { kind: 'provider-reported', id: 'grok-imagine-image-2.0', receipt_field: 'model' }), true);

const html = await readFile(new URL('../../index.html', import.meta.url), 'utf8');
assert.deepEqual(validateHtmlProjection(html, manifest), [], 'HTML projection must match the ledger');

const fixtureRoot = await mkdtemp(path.join(tmpdir(), 'image-admission-'));
await cp(fileURLToPath(new URL('../../index.html', import.meta.url)), path.join(fixtureRoot, 'index.html'));
await mkdir(path.join(fixtureRoot, 'data'));
await cp(fileURLToPath(new URL('../../data/comparison.json', import.meta.url)), path.join(fixtureRoot, 'data/comparison.json'));
await updateHtmlState('xai-official-01', 'grok-image', 'generated', fixtureRoot, { width: 1536, height: 1024 });
const projected = await readFile(path.join(fixtureRoot, 'index.html'), 'utf8');
const admittedManifest = JSON.parse(JSON.stringify(manifest));
const admittedCell = admittedManifest.samples['xai-official-01']['grok-image'];
admittedCell.state = { kind: 'generated', request_sha256: 'a'.repeat(64) };
admittedCell.media_facts = { kind: 'image', format: 'webp', width: 1536, height: 1024, alpha: false };
assert.deepEqual(validateHtmlProjection(projected, admittedManifest), [], 'admission must project complete generated markup');
assert.match(projected, /data-case-id="xai-official-01"[^>]*data-route-id="grok-image"[^>]*data-state="generated"/, 'admitted cell must project generated state');
assert.match(projected, /<a\b[^>]*class="asset-link"[^>]*href="media\/xai-official-01--grok-image\.webp"/, 'admitted cell must link the public media');
assert.match(projected, /<button\b[^>]*data-inspect/, 'admitted cell must restore the inspect action');
console.log('PASS image capture/ledger smoke fixture');
