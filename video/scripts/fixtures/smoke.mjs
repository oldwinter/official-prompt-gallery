import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { h3FormData, parseProviderResponse, operationKey } from '../capture.mjs';
import { parseManifest, validateHtmlProjection } from '../validate.mjs';

const manifest = parseManifest(await readFile(new URL('../../data/comparison.json', import.meta.url), 'utf8'));
const request = {
  repository: manifest.repository,
  media_kind: manifest.media_kind,
  case_id: 'minimax-official-01',
  route_id: 'grok-video',
  prompt_sha256: manifest.cases['minimax-official-01'].prompt.sha256,
  prompt: manifest.cases['minimax-official-01'].prompt.text,
  requested_model: manifest.routes['grok-video'].requested_model.id,
  parameters: manifest.samples['minimax-official-01']['grok-video'].parameters,
};
assert.equal(operationKey(request), operationKey({ ...request }), 'operation keys must be stable');
const h3Form = h3FormData({ ...request, requested_model: 'MiniMax-H3', parameters: manifest.samples['minimax-official-01']['minimax-h3'].parameters });
assert.equal(h3Form.get('model'), '/models/MiniMax-H3');
assert.equal(JSON.parse(h3Form.get('extra_body')).task, 't2va');
assert.equal(parseProviderResponse('grok-video', { status: 'pending', request_id: 'job-1' }).phase, 'pending');
assert.throws(() => parseProviderResponse('grok-video', { status: 'expired', request_id: 'job-1' }), /terminal failure/);
assert.throws(() => parseProviderResponse('grok-video', { status: 'unknown', request_id: 'job-1' }), /unknown status/);

const html = await readFile(new URL('../../index.html', import.meta.url), 'utf8');
assert.deepEqual(validateHtmlProjection(html, manifest), [], 'HTML projection must match the ledger');
console.log('PASS video capture/ledger smoke fixture');
