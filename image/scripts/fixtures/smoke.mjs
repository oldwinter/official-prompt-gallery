import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseProviderResponse, operationKey } from '../capture.mjs';
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
console.log('PASS image capture/ledger smoke fixture');
