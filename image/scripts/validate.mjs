import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import crypto from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const REPOSITORY_ROOT = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const MAX_BYTES = 25 * 1024 * 1024;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const CASE_IDS = ['openai-official-01', 'xai-official-01'];
const ROUTE_IDS = ['codex-image', 'grok-image'];
const EXPECTED = Object.freeze({
  'openai-official-01': Object.freeze({
    title: 'Veterinarian and baby otter',
    prompt: "A children's book drawing of a veterinarian using a stethoscope to listen to the heartbeat of a baby otter.",
    publisher: 'OpenAI',
    url: 'https://developers.openai.com/api/docs/guides/image-generation'
  }),
  'xai-official-01': Object.freeze({
    title: 'London landmark stencil collage',
    prompt: 'A collage of London landmarks in a stenciled street-art style',
    publisher: 'xAI',
    url: 'https://docs.x.ai/developers/model-capabilities/images/generation'
  })
});
const EXPECTED_ROUTES = Object.freeze({
  'codex-image': Object.freeze({
    provider: 'OpenAI',
    requested: Object.freeze({ kind: 'model-family', id: 'gpt-image-2' }),
    execution: Object.freeze({ kind: 'codex-image-generation', entitlement: 'codex' })
  }),
  'grok-image': Object.freeze({
    provider: 'xAI',
    requested: Object.freeze({ kind: 'exact-model', id: 'grok-imagine-image-2.0' }),
    execution: Object.freeze({ kind: 'sub2api', api: 'image-generations' })
  })
});
const DISCLOSURE_KEYS = [
  'generated_media',
  'sampling',
  'inference',
  'comparability',
  'model_identity',
  'code_license',
  'prompt_rights',
  'media_rights'
];

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function exactKeys(value, expectedKeys, location, errors) {
  if (!isPlainObject(value)) {
    errors.push({ code: 'object', path: location, message: 'expected an object' });
    return false;
  }
  const expected = new Set(expectedKeys);
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) errors.push({ code: 'unknown-key', path: `${location}.${key}`, message: 'unknown key' });
  }
  for (const key of expectedKeys) {
    if (!hasOwn(value, key)) errors.push({ code: 'missing-key', path: `${location}.${key}`, message: 'required key is missing' });
  }
  return true;
}

function rejectNulls(value, location, errors, seen = new WeakSet()) {
  if (value === null) {
    errors.push({ code: 'null', path: location, message: 'null is not an allowed absence variant' });
    return;
  }
  if (typeof value !== 'object') return;
  if (seen.has(value)) {
    errors.push({ code: 'cycle', path: location, message: 'cyclic data is not valid JSON' });
    return;
  }
  seen.add(value);
  if (Array.isArray(value)) value.forEach((item, index) => rejectNulls(item, `${location}[${index}]`, errors, seen));
  else Object.entries(value).forEach(([key, item]) => rejectNulls(item, `${location}.${key}`, errors, seen));
  seen.delete(value);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function isSha256(value) {
  return typeof value === 'string' && HASH_PATTERN.test(value);
}

function isSafeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function isIsoDate(value) {
  if (typeof value !== 'string' || !DATE_PATTERN.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

function isIsoInstant(value) {
  if (typeof value !== 'string' || !INSTANT_PATTERN.test(value)) return false;
  const date = new Date(value);
  return !Number.isNaN(date.valueOf()) && date.toISOString() === value;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isPlainObject(value)) {
    return Object.keys(value).sort().reduce((result, key) => {
      result[key] = canonicalize(value[key]);
      return result;
    }, {});
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

export function canonicalRequest(manifest, caseId, routeId) {
  return {
    repository: manifest.repository,
    media_kind: manifest.media_kind,
    case_id: caseId,
    route_id: routeId,
    prompt: manifest.cases[caseId].prompt.text,
    prompt_sha256: manifest.cases[caseId].prompt.sha256,
    requested_model: manifest.routes[routeId].requested_model,
    parameters: manifest.samples[caseId][routeId].parameters
  };
}

export function requestDigest(manifest, caseId, routeId) {
  return sha256(canonicalJson(canonicalRequest(manifest, caseId, routeId)));
}

export function hasExactServedModel(route, servedModel) {
  if (route?.requested_model?.kind !== 'exact-model') return true;
  return servedModel?.kind === 'provider-reported' && servedModel.id === route.requested_model.id;
}

export function parseManifest(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`manifest JSON parse failed: ${error.message}`);
  }
  const errors = [];
  rejectNulls(parsed, '$', errors);
  if (!isPlainObject(parsed)) throw new Error('manifest must be an object');
  if (errors.length) throw new Error(`manifest contains null or cyclic values at ${errors[0].path}`);
  const report = validateManifest(parsed, 'manifest');
  if (report.length) throw new Error(report.map((finding) => `${finding.path}: ${finding.message}`).join('; '));
  return parsed;
}

function validateManifest(manifest, location = 'manifest') {
  const errors = [];
  if (!exactKeys(manifest, ['schema_version', 'repository', 'media_kind', 'cases', 'routes', 'samples', 'disclosure'], location, errors)) return errors;
  if (manifest.schema_version !== 1) errors.push({ code: 'schema-version', path: `${location}.schema_version`, message: 'must be 1' });
  if (manifest.repository !== 'official-prompt-image-gallery') errors.push({ code: 'repository', path: `${location}.repository`, message: 'must identify the image gallery' });
  if (manifest.media_kind !== 'image') errors.push({ code: 'media-kind', path: `${location}.media_kind`, message: 'must be image' });

  if (exactKeys(manifest.cases, CASE_IDS, `${location}.cases`, errors)) {
    for (const caseId of CASE_IDS) validateCase(manifest.cases[caseId], caseId, `${location}.cases.${caseId}`, errors);
  }
  if (exactKeys(manifest.routes, ROUTE_IDS, `${location}.routes`, errors)) {
    for (const routeId of ROUTE_IDS) validateRoute(manifest.routes[routeId], routeId, `${location}.routes.${routeId}`, errors);
  }
  if (exactKeys(manifest.samples, CASE_IDS, `${location}.samples`, errors)) {
    for (const caseId of CASE_IDS) {
      if (exactKeys(manifest.samples[caseId], ROUTE_IDS, `${location}.samples.${caseId}`, errors)) {
        for (const routeId of ROUTE_IDS) validateSample(manifest.samples[caseId][routeId], manifest, caseId, routeId, `${location}.samples.${caseId}.${routeId}`, errors);
      }
    }
  }
  if (exactKeys(manifest.disclosure, DISCLOSURE_KEYS, `${location}.disclosure`, errors)) {
    for (const key of DISCLOSURE_KEYS) {
      if (typeof manifest.disclosure[key] !== 'string' || !manifest.disclosure[key].trim()) errors.push({ code: 'disclosure', path: `${location}.disclosure.${key}`, message: 'must be a non-empty string' });
    }
  }
  return errors;
}

function validateCase(promptCase, caseId, location, errors) {
  if (!exactKeys(promptCase, ['title', 'prompt', 'source'], location, errors)) return;
  const expected = EXPECTED[caseId];
  if (promptCase.title !== expected.title) errors.push({ code: 'case-title', path: `${location}.title`, message: 'does not match the official case contract' });
  if (!exactKeys(promptCase.prompt, ['text', 'sha256'], `${location}.prompt`, errors)) return;
  if (promptCase.prompt.text !== expected.prompt) errors.push({ code: 'prompt-text', path: `${location}.prompt.text`, message: 'must match the exact official prompt' });
  if (!isSha256(promptCase.prompt.sha256)) errors.push({ code: 'prompt-hash', path: `${location}.prompt.sha256`, message: 'must be a lowercase SHA-256' });
  else if (sha256(promptCase.prompt.text) !== promptCase.prompt.sha256) errors.push({ code: 'prompt-hash', path: `${location}.prompt.sha256`, message: 'does not match prompt text' });
  if (!exactKeys(promptCase.source, ['publisher', 'title', 'canonical_url', 'accessed_on', 'location_note'], `${location}.source`, errors)) return;
  if (promptCase.source.publisher !== expected.publisher) errors.push({ code: 'publisher', path: `${location}.source.publisher`, message: 'does not match the official publisher' });
  if (typeof promptCase.source.title !== 'string' || !promptCase.source.title.trim()) errors.push({ code: 'citation-title', path: `${location}.source.title`, message: 'must be non-empty' });
  if (promptCase.source.canonical_url !== expected.url) errors.push({ code: 'citation-url', path: `${location}.source.canonical_url`, message: 'must match the canonical official guide URL' });
  validateCitationUrl(promptCase.source.canonical_url, caseId, `${location}.source.canonical_url`, errors);
  if (!isIsoDate(promptCase.source.accessed_on)) errors.push({ code: 'accessed-on', path: `${location}.source.accessed_on`, message: 'must be a real YYYY-MM-DD date' });
  if (typeof promptCase.source.location_note !== 'string' || !promptCase.source.location_note.trim()) errors.push({ code: 'location-note', path: `${location}.source.location_note`, message: 'must be non-empty' });
}

function validateCitationUrl(value, caseId, location, errors) {
  if (typeof value !== 'string' || !value.startsWith('https://')) {
    errors.push({ code: 'citation-url', path: location, message: 'must use HTTPS' });
    return;
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    errors.push({ code: 'citation-url', path: location, message: 'is not a valid URL' });
    return;
  }
  const allowedHost = caseId === 'openai-official-01' ? 'developers.openai.com' : 'docs.x.ai';
  if (parsed.hostname !== allowedHost) errors.push({ code: 'citation-host', path: location, message: `must use ${allowedHost}` });
  if (parsed.username || parsed.password || parsed.port) errors.push({ code: 'citation-url', path: location, message: 'must not contain credentials or a port' });
}

function validateRoute(route, routeId, location, errors) {
  if (!exactKeys(route, ['label', 'provider', 'requested_model', 'execution'], location, errors)) return;
  const expected = EXPECTED_ROUTES[routeId];
  if (typeof route.label !== 'string' || !route.label.trim()) errors.push({ code: 'route-label', path: `${location}.label`, message: 'must be non-empty' });
  if (route.provider !== expected.provider) errors.push({ code: 'route-provider', path: `${location}.provider`, message: 'does not match route contract' });
  if (!exactKeys(route.requested_model, ['kind', 'id'], `${location}.requested_model`, errors)) return;
  if (route.requested_model.kind !== expected.requested.kind || route.requested_model.id !== expected.requested.id) errors.push({ code: 'requested-model', path: `${location}.requested_model`, message: 'does not match requested model contract' });
  if (!exactKeys(route.execution, Object.keys(expected.execution), `${location}.execution`, errors)) return;
  for (const [key, value] of Object.entries(expected.execution)) if (route.execution[key] !== value) errors.push({ code: 'execution', path: `${location}.execution.${key}`, message: 'does not match route contract' });
}

function validateSample(sample, manifest, caseId, routeId, location, errors) {
  const keys = ['state', 'served_model', 'parameters', 'cost', 'generated_at', 'asset', 'media_facts', 'receipt_sha256', 'alt_text', 'admission'];
  if (!exactKeys(sample, keys, location, errors)) return;
  if (!exactKeys(sample.parameters, ['kind', 'aspect_ratio', 'requested_size', 'quality', 'seed'], `${location}.parameters`, errors)) return;
  if (sample.parameters.kind !== 'image') errors.push({ code: 'parameters-kind', path: `${location}.parameters.kind`, message: 'must be image' });
  if (sample.parameters.aspect_ratio !== '1:1') errors.push({ code: 'aspect-ratio', path: `${location}.parameters.aspect_ratio`, message: 'must be 1:1' });
  if (!exactKeys(sample.parameters.requested_size, ['kind', 'width', 'height'], `${location}.parameters.requested_size`, errors)) return;
  if (sample.parameters.requested_size.kind !== 'pixel-dimensions' || sample.parameters.requested_size.width !== 1024 || sample.parameters.requested_size.height !== 1024) errors.push({ code: 'requested-size', path: `${location}.parameters.requested_size`, message: 'must request 1024 by 1024' });
  if (!exactKeys(sample.parameters.quality, ['kind', 'value'], `${location}.parameters.quality`, errors) || sample.parameters.quality.kind !== 'requested' || sample.parameters.quality.value !== 'medium') errors.push({ code: 'quality', path: `${location}.parameters.quality`, message: 'must record medium as requested quality' });
  const seedKinds = routeId === 'codex-image' ? ['route-does-not-accept-seed'] : ['provider-assigned-not-exposed', 'route-does-not-accept-seed'];
  if (!isPlainObject(sample.parameters.seed) || !seedKinds.includes(sample.parameters.seed.kind) || Object.keys(sample.parameters.seed).length !== 1) errors.push({ code: 'seed', path: `${location}.parameters.seed`, message: 'must use an explicit seed evidence variant' });

  validateServedModel(sample.served_model, routeId, `${location}.served_model`, errors);
  if (sample.state?.kind === 'generated' && !hasExactServedModel(manifest.routes[routeId], sample.served_model)) {
    errors.push({ code: 'exact-model-evidence', path: `${location}.served_model`, message: 'generated exact-model cells require matching provider-reported served identity' });
  }
  validateCost(sample.cost, routeId, `${location}.cost`, errors);
  if (typeof sample.alt_text !== 'string' || !sample.alt_text.trim()) errors.push({ code: 'alt-text', path: `${location}.alt_text`, message: 'must be non-empty' });
  validateStateAndEvidence(sample, manifest, caseId, routeId, location, errors);
}

function validateServedModel(value, routeId, location, errors) {
  if (!isPlainObject(value) || typeof value.kind !== 'string') {
    errors.push({ code: 'served-model', path: location, message: 'must be a tagged variant' });
    return;
  }
  if (value.kind === 'not-exposed') {
    if (!exactKeys(value, ['kind', 'reason'], location, errors)) return;
    const allowed = routeId === 'codex-image' ? ['codex-route-does-not-return-served-snapshot'] : ['provider-response-omits-model'];
    if (!allowed.includes(value.reason)) errors.push({ code: 'served-model', path: `${location}.reason`, message: 'has an invalid absence reason for this route' });
  } else if (value.kind === 'provider-reported') {
    if (!exactKeys(value, ['kind', 'id', 'receipt_field'], location, errors)) return;
    if (typeof value.id !== 'string' || !value.id.trim() || typeof value.receipt_field !== 'string' || !value.receipt_field.trim()) errors.push({ code: 'served-model', path: location, message: 'provider-reported identity needs id and receipt field' });
  } else if (value.kind === 'operator-verified-local-deployment') {
    errors.push({ code: 'served-model', path: location, message: 'local deployment identity is not valid for image routes' });
  } else {
    errors.push({ code: 'served-model', path: `${location}.kind`, message: 'unknown served-model variant' });
  }
}

function validateCost(value, routeId, location, errors) {
  if (!isPlainObject(value) || typeof value.kind !== 'string') {
    errors.push({ code: 'cost', path: location, message: 'must be a tagged variant' });
    return;
  }
  if (value.kind === 'included-entitlement-amount-not-exposed') {
    if (Object.keys(value).length !== 1 || routeId !== 'codex-image') errors.push({ code: 'cost', path: location, message: 'invalid entitlement absence variant' });
  } else if (value.kind === 'paid-route-amount-not-exposed') {
    if (Object.keys(value).length !== 1 || routeId !== 'grok-image') errors.push({ code: 'cost', path: location, message: 'invalid paid-route absence variant' });
  } else if (value.kind === 'reported') {
    if (!exactKeys(value, ['kind', 'currency', 'decimal_amount'], location, errors)) return;
    if (value.currency !== 'USD' || typeof value.decimal_amount !== 'string' || !/^\d+(?:\.\d+)?$/.test(value.decimal_amount)) errors.push({ code: 'cost', path: location, message: 'reported cost must be a decimal USD amount' });
  } else {
    errors.push({ code: 'cost', path: `${location}.kind`, message: 'unknown cost variant' });
  }
}

function validateStateAndEvidence(sample, manifest, caseId, routeId, location, errors) {
  if (!isPlainObject(sample.state) || typeof sample.state.kind !== 'string') {
    errors.push({ code: 'state', path: `${location}.state`, message: 'must be planned or generated' });
    return;
  }
  if (sample.state.kind === 'planned') {
    if (Object.keys(sample.state).length !== 1) errors.push({ code: 'state', path: `${location}.state`, message: 'planned state has unexpected fields' });
    if (!isPlainObject(sample.generated_at) || sample.generated_at.kind !== 'not-generated' || Object.keys(sample.generated_at).length !== 1) errors.push({ code: 'planned-evidence', path: `${location}.generated_at`, message: 'planned cell needs not-generated timestamp variant' });
    validateAbsent(sample.asset, `${location}.asset`, 'not-generated', errors);
    validateAbsent(sample.media_facts, `${location}.media_facts`, 'not-generated', errors);
    validateAbsent(sample.receipt_sha256, `${location}.receipt_sha256`, 'not-generated', errors);
    if (!isPlainObject(sample.admission) || sample.admission.kind !== 'not-admitted' || sample.admission.reason !== 'not-generated' || Object.keys(sample.admission).length !== 2) errors.push({ code: 'planned-evidence', path: `${location}.admission`, message: 'planned cell needs not-admitted evidence variant' });
    return;
  }
  if (sample.state.kind !== 'generated') {
    errors.push({ code: 'state', path: `${location}.state.kind`, message: 'unknown state variant' });
    return;
  }
  if (!exactKeys(sample.state, ['kind', 'request_sha256'], `${location}.state`, errors)) return;
  if (!isSha256(sample.state.request_sha256)) errors.push({ code: 'request-hash', path: `${location}.state.request_sha256`, message: 'must be a lowercase SHA-256' });
  else if (sample.state.request_sha256 !== requestDigest(manifest, caseId, routeId)) errors.push({ code: 'request-hash', path: `${location}.state.request_sha256`, message: 'does not match canonical request fields' });
  if (typeof sample.generated_at !== 'string' || !isIsoInstant(sample.generated_at)) errors.push({ code: 'generated-at', path: `${location}.generated_at`, message: 'must be a canonical UTC instant' });
  validateGeneratedAsset(sample.asset, `${location}.asset`, errors);
  validateGeneratedFacts(sample.media_facts, `${location}.media_facts`, errors);
  if (!isSha256(sample.receipt_sha256)) errors.push({ code: 'receipt-hash', path: `${location}.receipt_sha256`, message: 'must be a lowercase SHA-256' });
  if (!isPlainObject(sample.admission) || !exactKeys(sample.admission, ['full_decode', 'nonblank_review'], `${location}.admission`, errors)) return;
  const decode = sample.admission.full_decode;
  if (!isPlainObject(decode) || !exactKeys(decode, ['tool', 'version'], `${location}.admission.full_decode`, errors) || typeof decode.tool !== 'string' || !decode.tool.trim() || typeof decode.version !== 'string' || !decode.version.trim()) errors.push({ code: 'decode', path: `${location}.admission.full_decode`, message: 'must identify a decode tool and version' });
  if (!isPlainObject(sample.admission.nonblank_review) || !exactKeys(sample.admission.nonblank_review, ['kind', 'reviewed_on'], `${location}.admission.nonblank_review`, errors) || sample.admission.nonblank_review.kind !== 'human-reviewed' || !isIsoDate(sample.admission.nonblank_review.reviewed_on)) errors.push({ code: 'nonblank', path: `${location}.admission.nonblank_review`, message: 'must record human-reviewed and a date' });
}

function validateAbsent(value, location, reason, errors) {
  if (!isPlainObject(value) || Object.keys(value).length !== 2 || value.kind !== 'absent' || value.reason !== reason) errors.push({ code: 'absence', path: location, message: `must use absent/${reason}` });
}

function validateGeneratedAsset(value, location, errors) {
  if (!isPlainObject(value) || !exactKeys(value, ['kind', 'sha256', 'bytes', 'provenance'], location, errors)) return;
  if (value.kind !== 'public-asset' || !isSha256(value.sha256) || !isSafeInteger(value.bytes) || value.bytes <= 0 || value.bytes >= MAX_BYTES) errors.push({ code: 'asset', path: location, message: 'must describe a non-empty sub-25 MiB public asset' });
  if (!isPlainObject(value.provenance) || typeof value.provenance.kind !== 'string') {
    errors.push({ code: 'provenance', path: `${location}.provenance`, message: 'must be a tagged provenance variant' });
  } else if (value.provenance.kind === 'direct-provider-output') {
    if (Object.keys(value.provenance).length !== 1) errors.push({ code: 'provenance', path: `${location}.provenance`, message: 'unexpected direct-output fields' });
  } else if (value.provenance.kind === 'web-derivative') {
    if (!exactKeys(value.provenance, ['kind', 'source_sha256', 'transform'], `${location}.provenance`, errors)) return;
    const transform = value.provenance.transform;
    const transformValid = isPlainObject(transform) && exactKeys(transform, ['tool', 'version', 'arguments'], `${location}.provenance.transform`, errors) && typeof transform.tool === 'string' && Boolean(transform.tool.trim()) && typeof transform.version === 'string' && Boolean(transform.version.trim()) && Array.isArray(transform.arguments) && transform.arguments.every((item) => typeof item === 'string');
    if (!isSha256(value.provenance.source_sha256) || !transformValid) errors.push({ code: 'provenance', path: `${location}.provenance.transform`, message: 'derivative transform is incomplete' });
  } else {
    errors.push({ code: 'provenance', path: `${location}.provenance.kind`, message: 'unknown provenance variant' });
  }
}

function validateGeneratedFacts(value, location, errors) {
  if (!isPlainObject(value) || !exactKeys(value, ['kind', 'format', 'width', 'height', 'alpha'], location, errors)) return;
  if (value.kind !== 'image' || !['png', 'jpeg', 'webp'].includes(value.format) || !Number.isSafeInteger(value.width) || value.width <= 0 || value.width > 16384 || !Number.isSafeInteger(value.height) || value.height <= 0 || value.height > 16384 || typeof value.alpha !== 'boolean') errors.push({ code: 'media-facts', path: location, message: 'must contain plausible PNG, JPEG, or WebP facts' });
}

export function expectedSampleKeys(manifest) {
  return new Set(CASE_IDS.flatMap((caseId) => ROUTE_IDS.map((routeId) => `${caseId}--${routeId}`)));
}

export function mediaPath(mediaKind, caseId, routeId) {
  if (mediaKind !== 'image') throw new Error('image validator only derives image paths');
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(caseId) || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(routeId)) throw new Error('case and route IDs must be lowercase kebab case');
  return `media/${caseId}--${routeId}.webp`;
}

export function receiptPath(caseId, routeId) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(caseId) || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(routeId)) throw new Error('case and route IDs must be lowercase kebab case');
  return `receipts/${caseId}--${routeId}.json`;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function htmlAttribute(tag, name) {
  return tag.match(new RegExp(`${name}=["']([^"']+)["']`, 'i'))?.[1] || '';
}

export function validateHtmlProjection(html, manifest) {
  const errors = [];
  if (typeof html !== 'string' || !html.trim()) return [{ code: 'html', path: 'index.html', message: 'HTML is empty' }];
  const visibleHtml = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<script\b[\s\S]*?<\/script>/gi, '').replace(/<style\b[\s\S]*?<\/style>/gi, '');
  const comparisonAt = visibleHtml.indexOf('id="comparison"');
  const methodologyAt = visibleHtml.indexOf('METHODOLOGY.md');
  if (comparisonAt < 0) errors.push({ code: 'html-anchor', path: 'index.html', message: 'missing comparison section' });
  if (methodologyAt >= 0 && comparisonAt >= 0 && methodologyAt < comparisonAt) errors.push({ code: 'html-order', path: 'index.html', message: 'methodology must follow the comparison' });
  if (!/<main\b/i.test(visibleHtml) || !/<noscript\b/i.test(visibleHtml)) errors.push({ code: 'html-semantic', path: 'index.html', message: 'main and no-JavaScript projection are required' });
  if (!/assets\/image-inspector\.js/i.test(html)) errors.push({ code: 'html-script', path: 'index.html', message: 'image inspector script is not referenced' });
  if (/data-(?:winner|rank|score|preferred|recommend)/i.test(visibleHtml) || /<(?:winner|rank|score|recommendation)\b/i.test(visibleHtml)) errors.push({ code: 'html-policy', path: 'index.html', message: 'winner, rank, score, or recommendation markup is forbidden' });

  const figures = [...visibleHtml.matchAll(/<figure\b[^>]*data-case-id="([^"]+)"[^>]*data-route-id="([^"]+)"[^>]*>([\s\S]*?)<\/figure>/gi)];
  const seen = new Set();
  for (const match of figures) {
    const [, caseId, routeId, body] = match;
    const key = `${caseId}--${routeId}`;
    if (seen.has(key)) errors.push({ code: 'html-cell', path: `index.html:${key}`, message: 'duplicate output figure' });
    seen.add(key);
    if (!CASE_IDS.includes(caseId) || !ROUTE_IDS.includes(routeId)) errors.push({ code: 'html-cell', path: `index.html:${key}`, message: 'unknown output figure key' });
    const expectedPath = mediaPath('image', caseId, routeId);
    const sample = CASE_IDS.includes(caseId) && ROUTE_IDS.includes(routeId) ? manifest.samples[caseId][routeId] : null;
    if (sample?.state.kind === 'planned') {
      if (!new RegExp(`data-asset-path="${escapeRegExp(expectedPath)}"`, 'i').test(body)) errors.push({ code: 'html-path', path: `index.html:${key}`, message: `missing planned asset path ${expectedPath}` });
      if (!/src="assets\/planned-image\.webp"/i.test(body)) errors.push({ code: 'html-path', path: `index.html:${key}`, message: 'missing local planned placeholder' });
    } else {
      const imagePattern = new RegExp(`<img\\b[^>]*src="${escapeRegExp(expectedPath)}"`, 'i');
      const linkPattern = new RegExp(`<a\\b[^>]*href="${escapeRegExp(expectedPath)}"`, 'i');
      if (!imagePattern.test(body)) errors.push({ code: 'html-path', path: `index.html:${key}`, message: `missing image src ${expectedPath}` });
      if (!linkPattern.test(body)) errors.push({ code: 'html-path', path: `index.html:${key}`, message: `missing ordinary image link ${expectedPath}` });
    }
    const stateMatch = match[0].match(/data-state="(planned|generated)"/i);
    if (!stateMatch) errors.push({ code: 'html-state', path: `index.html:${key}`, message: 'figure must project planned or generated state' });
    if (CASE_IDS.includes(caseId) && ROUTE_IDS.includes(routeId)) {
      if (stateMatch && stateMatch[1].toLowerCase() !== sample.state.kind) errors.push({ code: 'html-state', path: `index.html:${key}`, message: `figure state must match manifest (${sample.state.kind})` });
      const statusExpected = sample.state.kind === 'generated' ? 'GENERATED' : 'PLANNED';
      if (!new RegExp(`<span\\b[^>]*class="status-tag"[^>]*>${statusExpected}<\\/span>`, 'i').test(body)) errors.push({ code: 'html-status', path: `index.html:${key}`, message: `status tag must be ${statusExpected}` });
      const noteExpected = sample.state.kind === 'generated' ? 'Admitted output' : 'Awaiting admitted output';
      if (!new RegExp(`<p\\b[^>]*class="planned-note"[^>]*>${escapeRegExp(noteExpected)}<\\/p>`, 'i').test(body)) errors.push({ code: 'html-status', path: `index.html:${key}`, message: `media note must be ${noteExpected}` });
      if (!new RegExp(`alt="${escapeRegExp(sample.alt_text)}"`, 'i').test(body)) errors.push({ code: 'html-alt', path: `index.html:${key}`, message: 'figure alt text differs from manifest' });
      const requestedId = manifest.routes[routeId].requested_model.id;
      if (!body.includes(requestedId)) errors.push({ code: 'html-model', path: `index.html:${key}`, message: 'requested model is not visible' });
      const imageTag = body.match(/<img\b[^>]*>/i);
      if (imageTag && sample.state.kind === 'generated') {
        if (Number(htmlAttribute(imageTag[0], 'width')) !== sample.media_facts.width || Number(htmlAttribute(imageTag[0], 'height')) !== sample.media_facts.height) errors.push({ code: 'html-dimensions', path: `index.html:${key}`, message: 'image dimensions must match the admitted manifest facts' });
      }
    }
  }
  if (figures.length !== 4 || seen.size !== 4) errors.push({ code: 'html-cross-product', path: 'index.html', message: 'exactly four unique output figures are required' });
  for (const caseId of CASE_IDS) {
    const expected = EXPECTED[caseId];
    if (!visibleHtml.includes(expected.prompt)) errors.push({ code: 'html-prompt', path: `index.html:${caseId}`, message: 'exact prompt is not visible' });
    if (!new RegExp(`<a\\b[^>]*href="${escapeRegExp(expected.url)}"`, 'i').test(visibleHtml)) errors.push({ code: 'html-citation', path: `index.html:${caseId}`, message: 'official citation link is not visible' });
  }
  const disclosureNeedles = ['AI-generated', 'one sample', 'capability-aligned', 'No winner'];
  disclosureNeedles.forEach((needle) => {
    if (!visibleHtml.toLowerCase().includes(needle.toLowerCase())) errors.push({ code: 'html-disclosure', path: 'index.html', message: `visible disclosure must mention ${needle}` });
  });
  return errors;
}

function imageHeader(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 12) return { format: 'unknown', mime: 'application/octet-stream' };
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (png.every((value, index) => bytes[index] === value)) {
    const width = bytes.length >= 24 ? bytes.readUInt32BE(16) : 0;
    const height = bytes.length >= 24 ? bytes.readUInt32BE(20) : 0;
    const colorType = bytes.length >= 26 ? bytes[25] : -1;
    return { format: 'png', mime: 'image/png', width, height, alpha: colorType === 4 || colorType === 6, animated: false };
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return parseJpegHeader(bytes);
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return parseWebpHeader(bytes);
  return { format: 'unknown', mime: 'application/octet-stream', width: 0, height: 0, alpha: false, animated: false };
}

function parseJpegHeader(bytes) {
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1];
    offset += 2;
    if (marker === 0xd8 || marker === 0xd9) continue;
    if (offset + 2 > bytes.length) break;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) break;
    const isSof = (marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf);
    if (isSof && length >= 7) return { format: 'jpeg', mime: 'image/jpeg', width: bytes.readUInt16BE(offset + 5), height: bytes.readUInt16BE(offset + 3), alpha: false, animated: false };
    offset += length;
  }
  return { format: 'jpeg', mime: 'image/jpeg', width: 0, height: 0, alpha: false, animated: false };
}

function parseWebpHeader(bytes) {
  const chunk = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]);
  if (chunk === 'VP8X' && bytes.length >= 30) {
    const flags = bytes[20];
    const width = 1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16);
    const height = 1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16);
    return { format: 'webp', mime: 'image/webp', width, height, alpha: Boolean(flags & 0x10), animated: Boolean(flags & 0x02) };
  }
  if (chunk === 'VP8L' && bytes.length >= 25) {
    const bits = bytes[21] | (bytes[22] << 8) | (bytes[23] << 16) | (bytes[24] << 24);
    return { format: 'webp', mime: 'image/webp', width: 1 + (bits & 0x3fff), height: 1 + ((bits >>> 14) & 0x3fff), alpha: true, animated: false };
  }
  if (chunk === 'VP8 ' && bytes.length >= 30) return { format: 'webp', mime: 'image/webp', width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff, alpha: false, animated: false };
  return { format: 'webp', mime: 'image/webp', width: 0, height: 0, alpha: false, animated: false };
}

export function inspectImageHeader(bytes) {
  return imageHeader(bytes);
}

async function readFileIfExists(filePath) {
  try {
    return await fs.readFile(filePath);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function checkFileMime(filePath, expectedMime) {
  try {
    const result = await execFile('file', ['--brief', '--mime-type', filePath], { maxBuffer: 4096 });
    const mime = result.stdout.trim().split(';')[0];
    return mime === expectedMime || (expectedMime === 'image/jpeg' && mime === 'image/jpg');
  } catch {
    return false;
  }
}

function validateReceipt(receipt, sample, routeId, location, errors, manifest, caseId) {
  if (!isPlainObject(receipt) || !exactKeys(receipt, ['schema_version', 'operation_key', 'request_sha256', 'terminal_status', 'started_at', 'completed_at', 'transport', 'served_model', 'cost', 'response_media_sha256'], location, errors)) return;
  const expectedRequest = requestDigest(manifest, caseId, routeId);
  if (receipt.schema_version !== 1 || !isSha256(receipt.operation_key) || !isSha256(receipt.request_sha256) || receipt.request_sha256 !== sample.state.request_sha256 || receipt.operation_key !== sample.state.request_sha256 || receipt.operation_key !== expectedRequest) errors.push({ code: 'receipt', path: location, message: 'receipt identity does not match the generated cell' });
  if (receipt.terminal_status !== 'succeeded' || !isIsoInstant(receipt.started_at) || !isIsoInstant(receipt.completed_at)) errors.push({ code: 'receipt', path: location, message: 'receipt must describe a succeeded UTC operation' });
  if (!isPlainObject(receipt.transport) || !exactKeys(receipt.transport, ['status_code', 'media_content_type'], `${location}.transport`, errors) || !Number.isInteger(receipt.transport.status_code) || receipt.transport.status_code < 200 || receipt.transport.status_code >= 400 || typeof receipt.transport.media_content_type !== 'string' || !/^image\/(?:png|jpe?g|webp)$/i.test(receipt.transport.media_content_type)) errors.push({ code: 'receipt-transport', path: `${location}.transport`, message: 'transport evidence is incomplete or unsafe' });
  validateServedModel(receipt.served_model, routeId, `${location}.served_model`, errors);
  if (!hasExactServedModel(manifest.routes[routeId], receipt.served_model)) {
    errors.push({ code: 'exact-model-evidence', path: `${location}.served_model`, message: 'exact-model receipts require matching provider-reported served identity' });
  }
  validateCost(receipt.cost, routeId, `${location}.cost`, errors);
  if (!isSha256(receipt.response_media_sha256)) errors.push({ code: 'receipt-media', path: `${location}.response_media_sha256`, message: 'must be a media SHA-256' });
  if (isSha256(receipt.response_media_sha256) && sample.asset?.provenance?.kind === 'web-derivative' && receipt.response_media_sha256 !== sample.asset.provenance.source_sha256) errors.push({ code: 'receipt-media', path: `${location}.response_media_sha256`, message: 'does not match derivative source hash' });
  if (isSha256(receipt.response_media_sha256) && sample.asset?.provenance?.kind === 'direct-provider-output' && receipt.response_media_sha256 !== sample.asset.sha256) errors.push({ code: 'receipt-media', path: `${location}.response_media_sha256`, message: 'does not match public asset hash' });
}

async function inspectPublicFiles(manifest, root, mode, errors) {
  const mediaDir = path.join(root, 'media');
  const receiptsDir = path.join(root, 'receipts');
  const expectedMedia = new Set();
  const expectedReceipts = new Set();
  let generatedCount = 0;
  let plannedCount = 0;
  for (const caseId of CASE_IDS) {
    for (const routeId of ROUTE_IDS) {
      const sample = manifest.samples[caseId][routeId];
      const relativeMedia = mediaPath(manifest.media_kind, caseId, routeId);
      const relativeReceipt = receiptPath(caseId, routeId);
      expectedMedia.add(path.basename(relativeMedia));
      expectedReceipts.add(path.basename(relativeReceipt));
      const mediaFile = path.join(root, relativeMedia);
      const receiptFile = path.join(root, relativeReceipt);
      if (sample.state.kind === 'planned') {
        plannedCount += 1;
        if (await readFileIfExists(mediaFile)) errors.push({ code: 'planned-media', path: relativeMedia, message: 'planned cell must not include a public media file' });
        if (await readFileIfExists(receiptFile)) errors.push({ code: 'planned-receipt', path: relativeReceipt, message: 'planned cell must not include a public receipt' });
        continue;
      }
      generatedCount += 1;
      const bytes = await readFileIfExists(mediaFile);
      if (!bytes) {
        errors.push({ code: 'missing-media', path: relativeMedia, message: 'generated cell media is missing' });
      } else {
        const actualHash = sha256(bytes);
        if (actualHash !== sample.asset.sha256) errors.push({ code: 'media-hash', path: relativeMedia, message: 'SHA-256 does not match manifest' });
        if (bytes.length !== sample.asset.bytes) errors.push({ code: 'media-bytes', path: relativeMedia, message: 'byte count does not match manifest' });
        if (bytes.length >= MAX_BYTES) errors.push({ code: 'media-size', path: relativeMedia, message: 'file must be strictly smaller than 25 MiB' });
        const facts = imageHeader(bytes);
        if (facts.format !== 'webp' || facts.mime !== 'image/webp') errors.push({ code: 'media-signature', path: relativeMedia, message: 'public image must be a WebP file' });
        if (facts.animated) errors.push({ code: 'media-animation', path: relativeMedia, message: 'animated images are not allowed' });
        if (facts.format !== sample.media_facts.format || facts.width !== sample.media_facts.width || facts.height !== sample.media_facts.height || facts.alpha !== sample.media_facts.alpha) errors.push({ code: 'media-facts', path: relativeMedia, message: 'header facts differ from manifest' });
        if (!(await checkFileMime(mediaFile, facts.mime))) errors.push({ code: 'media-file-type', path: relativeMedia, message: 'file command MIME does not match image header' });
        if (mode === 'publish' && !isSafeInteger(sample.asset.bytes)) errors.push({ code: 'media-bytes', path: relativeMedia, message: 'unsafe byte count' });
      }
      const receipt = await readFileIfExists(receiptFile);
      if (!receipt) errors.push({ code: 'missing-receipt', path: relativeReceipt, message: 'generated cell receipt is missing' });
      else if (sha256(receipt) !== sample.receipt_sha256) errors.push({ code: 'receipt-hash', path: relativeReceipt, message: 'receipt SHA-256 does not match manifest' });
      else {
        try { validateReceipt(JSON.parse(receipt.toString('utf8')), sample, routeId, relativeReceipt, errors, manifest, caseId); }
        catch (error) { errors.push({ code: 'receipt', path: relativeReceipt, message: `receipt JSON is invalid: ${error.message}` }); }
      }
    }
  }
  for (const directory of [mediaDir, receiptsDir]) {
    let entries = [];
    try { entries = await fs.readdir(directory, { withFileTypes: true }); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const expected = directory === mediaDir ? expectedMedia : expectedReceipts;
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      if (!entry.isFile() || !expected.has(entry.name)) errors.push({ code: 'unreferenced-file', path: path.relative(root, path.join(directory, entry.name)), message: 'file is not a derived output path' });
    }
  }
  return { generatedCount, plannedCount };
}

async function validateScripts(root, errors) {
  for (const relative of ['assets/image-inspector.js', 'scripts/validate.mjs', 'scripts/capture.mjs']) {
    const file = path.join(root, relative);
    try {
      await execFile(process.execPath, ['--check', file], { maxBuffer: 16 * 1024 });
    } catch (error) {
      errors.push({ code: 'syntax', path: relative, message: (error.stderr || error.message || 'syntax check failed').trim().split('\n')[0] });
    }
  }
}

export async function validateRepository(root = REPOSITORY_ROOT, mode = 'publish') {
  const errors = [];
  if (!['authoring', 'publish'].includes(mode)) errors.push({ code: 'mode', path: 'argv', message: 'mode must be authoring or publish' });
  const manifestPath = path.join(root, 'data/comparison.json');
  const htmlPath = path.join(root, 'index.html');
  let manifest;
  try {
    manifest = parseManifest(await fs.readFile(manifestPath, 'utf8'));
  } catch (error) {
    errors.push({ code: 'manifest', path: 'data/comparison.json', message: error.message });
    return { mode, errors, generatedCount: 0, plannedCount: 0 };
  }
  let html = '';
  try { html = await fs.readFile(htmlPath, 'utf8'); } catch (error) { errors.push({ code: 'html', path: 'index.html', message: error.message }); }
  errors.push(...validateHtmlProjection(html, manifest));
  const fileReport = await inspectPublicFiles(manifest, root, mode, errors);
  if (mode === 'publish' && fileReport.plannedCount > 0) errors.push({ code: 'planned-publish', path: 'data/comparison.json', message: `${fileReport.plannedCount} planned cell(s) remain; publish requires four generated cells` });
  await validateScripts(root, errors);
  errors.sort((left, right) => `${left.code}:${left.path}`.localeCompare(`${right.code}:${right.path}`));
  return { mode, errors, generatedCount: fileReport.generatedCount, plannedCount: fileReport.plannedCount };
}

function printReport(report) {
  const status = report.errors.length ? 'FAIL' : 'PASS';
  console.log(`${status} official image gallery validation (${report.mode})`);
  console.log(`cells: ${report.generatedCount} generated, ${report.plannedCount} planned`);
  if (report.errors.length) {
    report.errors.forEach((finding) => console.log(`ERROR ${finding.code} ${finding.path}: ${finding.message}`));
    console.log(`summary: ${report.errors.length} error(s)`);
  } else {
    console.log('summary: 0 errors');
  }
}

function parseCli(argv) {
  const options = { mode: 'publish', root: REPOSITORY_ROOT };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--mode') options.mode = argv[++index] === 'fixture' ? 'authoring' : (argv[index] || '');
    else if (argument === '--fixture') options.mode = 'authoring';
    else if (argument === '--root') options.root = path.resolve(argv[++index] || '.');
    else if (argument === '--help' || argument === '-h') options.help = true;
    else throw new Error(`unknown argument: ${argument}`);
  }
  return options;
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  try {
    const options = parseCli(process.argv.slice(2));
    if (options.help) {
      console.log('Usage: node scripts/validate.mjs [--mode authoring|publish] [--fixture] [--root PATH]');
      process.exit(0);
    }
    const report = await validateRepository(options.root, options.mode);
    printReport(report);
    process.exitCode = report.errors.length ? 1 : 0;
  } catch (error) {
    console.error(`validation error: ${error.message}`);
    process.exitCode = 1;
  }
}
