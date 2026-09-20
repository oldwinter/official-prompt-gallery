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
assert.equal(parseProviderResponse({ id: 'grok-image' }, { id: 'job-1' }).kind, 'pending');
assert.equal(parseProviderResponse({ id: 'grok-image' }, { status: 'processing', id: 'job-1', url: 'https://example.invalid/preview.webp' }).kind, 'pending');
const completedImage = Buffer.from('offline image fixture');
const completedInline = parseProviderResponse({ id: 'grok-image' }, {
  id: 'job-completed-inline',
  data: [{ b64_json: completedImage.toString('base64') }],
});
assert.equal(completedInline.kind, 'completed', 'image data without a status must not become pending just because an ID is present');
assert.equal(completedInline.remote_job_ref, 'job-completed-inline');
assert.deepEqual(completedInline.inline_bytes, completedImage);
const completedUrl = parseProviderResponse({ id: 'grok-image' }, {
  data: [{ id: 'job-completed-url', url: 'https://example.invalid/completed.webp' }],
});
assert.equal(completedUrl.kind, 'completed', 'an image URL without a status is a completed response');
assert.equal(completedUrl.remote_job_ref, 'job-completed-url');
assert.equal(completedUrl.download_url, 'https://example.invalid/completed.webp');
assert.throws(() => parseProviderResponse({ id: 'grok-image' }, { status: 'expired', id: 'job-1' }), /failed image operation/);
assert.throws(() => parseProviderResponse({ id: 'grok-image' }, { status: 'unknown', id: 'job-1' }), /image data/);
assert.equal(hasExactServedModel(manifest.routes['grok-image'], { kind: 'not-exposed', reason: 'provider-response-omits-model' }), false);
assert.equal(hasExactServedModel(manifest.routes['grok-image'], { kind: 'provider-reported', id: 'grok-imagine-image-1.0', receipt_field: 'model' }), false);
assert.equal(hasExactServedModel(manifest.routes['grok-image'], { kind: 'provider-reported', id: 'grok-imagine-image-2.0', receipt_field: 'model' }), true);

const html = await readFile(new URL('../../index.html', import.meta.url), 'utf8');
assert.deepEqual(validateHtmlProjection(html, manifest), [], 'HTML projection must match the ledger');
console.log('PASS image capture/ledger smoke fixture');
