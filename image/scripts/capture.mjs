import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import crypto from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import {
  canonicalJson,
  inspectImageHeader,
  mediaPath,
  parseManifest,
  receiptPath
} from './validate.mjs';

const execFile = promisify(execFileCallback);
const REPOSITORY_ROOT = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const PRIVATE_ROOT = path.join(REPOSITORY_ROOT, '.work');
const OPERATIONS_ROOT = path.join(PRIVATE_ROOT, 'operations');
const MAX_BYTES = 25 * 1024 * 1024;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function now() {
  return new Date().toISOString();
}

function isHash(value) {
  return typeof value === 'string' && HASH_PATTERN.test(value);
}

function isInstant(value) {
  return typeof value === 'string' && INSTANT_PATTERN.test(value) && !Number.isNaN(new Date(value).valueOf());
}

function isDate(value) {
  if (typeof value !== 'string' || !DATE_PATTERN.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function assertIdentifier(value, label) {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) throw new Error(`${label} must be a lowercase kebab-case identifier`);
}

function assertInside(root, candidate, label) {
  const relative = path.relative(root, candidate);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`${label} must remain inside the private work area`);
}

async function ensurePrivateRoot() {
  await fs.mkdir(OPERATIONS_ROOT, { recursive: true, mode: 0o700 });
  await fs.chmod(PRIVATE_ROOT, 0o700).catch(() => {});
  await fs.chmod(OPERATIONS_ROOT, 0o700).catch(() => {});
}

async function atomicWrite(filePath, data, mode = 0o600) {
  const directory = path.dirname(filePath);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(5).toString('hex')}.tmp`);
  try {
    await fs.writeFile(temporary, data, { encoding: 'utf8', mode });
    await fs.chmod(temporary, mode).catch(() => {});
    await fs.rename(temporary, filePath);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

async function atomicCopy(source, destination) {
  const directory = path.dirname(destination);
  await fs.mkdir(directory, { recursive: true, mode: 0o755 });
  const temporary = path.join(directory, `.${path.basename(destination)}.${process.pid}.${crypto.randomBytes(5).toString('hex')}.tmp`);
  try {
    await fs.copyFile(source, temporary);
    await fs.chmod(temporary, 0o644).catch(() => {});
    await fs.rename(temporary, destination);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

async function loadManifest() {
  return parseManifest(await fs.readFile(path.join(REPOSITORY_ROOT, 'data/comparison.json'), 'utf8'));
}

function requestFor(manifest, caseId, routeId) {
  assertIdentifier(caseId, 'case');
  assertIdentifier(routeId, 'route');
  if (!manifest.cases[caseId]) throw new Error(`unknown case: ${caseId}`);
  if (!manifest.routes[routeId]) throw new Error(`unknown route: ${routeId}`);
  const sample = manifest.samples[caseId]?.[routeId];
  if (!sample) throw new Error(`missing sample cell: ${caseId}/${routeId}`);
  return {
    repository: manifest.repository,
    media_kind: manifest.media_kind,
    case_id: caseId,
    route_id: routeId,
    prompt: manifest.cases[caseId].prompt.text,
    prompt_sha256: manifest.cases[caseId].prompt.sha256,
    requested_model: manifest.routes[routeId].requested_model,
    parameters: sample.parameters
  };
}

/** Derive a stable operation key from public canonical request fields only. */
export function operationKey(request) {
  if (!request || typeof request !== 'object') throw new Error('capture request must be an object');
  return sha256(canonicalJson(request));
}

function operationDirectory(operationKeyValue) {
  if (!isHash(operationKeyValue)) throw new Error('operation key must be a lowercase SHA-256');
  const directory = path.join(OPERATIONS_ROOT, operationKeyValue);
  assertInside(OPERATIONS_ROOT, directory, 'operation directory');
  return directory;
}

function statePath(operationDirectoryValue) {
  return path.join(operationDirectoryValue, 'state.json');
}

async function acquireLock(operationDirectoryValue) {
  await fs.mkdir(operationDirectoryValue, { recursive: true, mode: 0o700 });
  const lockPath = path.join(operationDirectoryValue, '.lock');
  try {
    const handle = await fs.open(lockPath, 'wx', 0o600);
    return async function release() {
      await handle.close().catch(() => {});
      await fs.rm(lockPath, { force: true }).catch(() => {});
    };
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error('operation is already being handled by another process');
    throw error;
  }
}

function publicRequestShape(request) {
  return {
    repository: request.repository,
    media_kind: request.media_kind,
    case_id: request.case_id,
    route_id: request.route_id,
    prompt_sha256: request.prompt_sha256,
    requested_model: request.requested_model,
    parameters: request.parameters
  };
}

function newReservedState(request, key) {
  return {
    schema_version: 1,
    phase: 'reserved',
    operation_key: key,
    request_sha256: key,
    case_id: request.case_id,
    route_id: request.route_id,
    request: publicRequestShape(request),
    created_at: now(),
    updated_at: now()
  };
}

function sanitizedSummary(state) {
  return {
    operation_key: state.operation_key,
    request_sha256: state.request_sha256,
    case_id: state.case_id,
    route_id: state.route_id,
    phase: state.phase
  };
}

async function readOperation(operationKeyValue) {
  const directory = operationDirectory(operationKeyValue);
  try {
    return { directory, state: await readJson(statePath(directory)) };
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`operation not found: ${operationKeyValue}`);
    throw error;
  }
}

async function writeState(directory, state) {
  state.updated_at = now();
  await atomicWrite(statePath(directory), `${JSON.stringify(state, null, 2)}\n`);
}

function routeDefaults(routeId) {
  if (routeId === 'codex-image') {
    return {
      served_model: { kind: 'not-exposed', reason: 'codex-route-does-not-return-served-snapshot' },
      cost: { kind: 'included-entitlement-amount-not-exposed' }
    };
  }
  return {
    served_model: { kind: 'not-exposed', reason: 'provider-response-omits-model' },
    cost: { kind: 'paid-route-amount-not-exposed' }
  };
}

function parseCost(value, routeId) {
  if (value && typeof value === 'object') {
    const amount = value.amount ?? value.total ?? value.cost;
    if ((typeof amount === 'number' && Number.isFinite(amount)) || (typeof amount === 'string' && /^\d+(?:\.\d+)?$/.test(amount))) {
      return { kind: 'reported', currency: 'USD', decimal_amount: String(amount) };
    }
  }
  return routeDefaults(routeId).cost;
}

function parseServedModel(value, routeId) {
  if (typeof value === 'string' && value.trim()) return { kind: 'provider-reported', id: value.trim(), receipt_field: 'model' };
  if (value && typeof value === 'object') {
    const model = value.model ?? value.served_model ?? value.id;
    if (typeof model === 'string' && model.trim()) return { kind: 'provider-reported', id: model.trim(), receipt_field: 'model' };
  }
  return routeDefaults(routeId).served_model;
}

function looksLikeDataUrl(value) {
  return typeof value === 'string' && /^data:image\/(?:png|jpe?g|webp);base64,/i.test(value);
}

function decodeDataUrl(value) {
  if (!looksLikeDataUrl(value)) return null;
  const encoded = value.slice(value.indexOf(',') + 1);
  return Buffer.from(encoded, 'base64');
}

/** Convert one untrusted provider response to a small domain result. */
export function parseProviderResponse(route, response) {
  if (!route || typeof route !== 'object' || !response || typeof response !== 'object') throw new Error('provider response is not an object');
  const routeId = route.id || route.route_id || (route.requested_model?.id === 'grok-imagine-image-2.0' ? 'grok-image' : 'codex-image');
  const status = typeof response.status === 'string' ? response.status.toLowerCase() : '';
  const data = Array.isArray(response.data) ? response.data[0] : response.data;
  const result = data && typeof data === 'object' ? data : response.result && typeof response.result === 'object' ? response.result : response;
  const inline = result && (result.b64_json || result.base64 || result.image_base64 || result.data_url);
  const remoteUrl = result && (result.url || result.image_url || result.output_url);
  const pending = ['queued', 'pending', 'processing', 'in_progress', 'running'].includes(status) || (!inline && !remoteUrl && (result?.id || response.id) && status !== 'succeeded' && status !== 'completed' && status !== 'success');
  if (pending) return { kind: 'pending', remote_job_ref: String(result?.id || response.id), status: status || 'pending' };
  if (!inline && !remoteUrl) {
    if (status && ['failed', 'error', 'cancelled', 'canceled'].includes(status)) throw new Error('provider reported a failed image operation');
    throw new Error('provider response did not contain image data');
  }
  const bytes = inline ? decodeDataUrl(String(inline)) || Buffer.from(String(inline), 'base64') : null;
  return {
    kind: 'completed',
    remote_job_ref: result?.id || response.id ? String(result?.id || response.id) : undefined,
    download_url: bytes ? undefined : String(remoteUrl),
    inline_bytes: bytes || undefined,
    served_model: parseServedModel(result?.model || response.model || result?.served_model, routeId),
    cost: parseCost(result?.usage || result?.cost || response.usage || response.cost, routeId),
    transport_status: 200,
    media_content_type: typeof result?.mime_type === 'string' ? result.mime_type : 'image/unknown'
  };
}

function routeRequest(request) {
  const model = request.requested_model.id;
  const size = request.parameters.requested_size;
  const body = {
    model,
    prompt: request.prompt,
    n: 1,
    size: `${size.width}x${size.height}`,
    quality: request.parameters.quality.value
  };
  return body;
}

function privateCredential(name) {
  const value = process.env[name];
  if (!value || !value.trim()) throw new Error(`${name} is required in the private environment`);
  return value.trim();
}

function baseUrl(value) {
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error('GROK_BASE_URL must be a valid HTTPS or loopback URL'); }
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && ['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname))) throw new Error('GROK_BASE_URL must use HTTPS except for loopback development');
  return parsed.toString().replace(/\/$/, '');
}

function createGrokAdapter() {
  const endpoint = baseUrl(process.env.GROK_BASE_URL || 'http://127.0.0.1:8000');
  const token = privateCredential('GROK_API_KEY');
  return {
    async submit(request, key) {
      const response = await fetch(`${endpoint}/v1/images/generations`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'idempotency-key': key
        },
        body: JSON.stringify(routeRequest(request))
      });
      let payload;
      try { payload = await response.json(); } catch { throw new Error(`provider returned HTTP ${response.status} without JSON`); }
      if (!response.ok && response.status !== 202) throw new Error(`provider returned HTTP ${response.status}`);
      const parsed = parseProviderResponse({ id: 'grok-image' }, payload);
      parsed.transport_status = response.status;
      return parsed;
    },
    async poll(remoteJobRef) {
      const response = await fetch(`${endpoint}/v1/images/generations/${encodeURIComponent(remoteJobRef)}`, {
        headers: { authorization: `Bearer ${token}` }
      });
      let payload;
      try { payload = await response.json(); } catch { throw new Error(`provider polling returned HTTP ${response.status}`); }
      if (!response.ok) throw new Error(`provider polling returned HTTP ${response.status}`);
      const parsed = parseProviderResponse({ id: 'grok-image' }, payload);
      parsed.transport_status = response.status;
      return parsed;
    },
    async download(remoteUrl) {
      const parsed = new URL(remoteUrl);
      if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && ['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname))) throw new Error('provider media URL was not HTTPS or loopback');
      const response = await fetch(parsed, { headers: { authorization: `Bearer ${token}` } });
      if (!response.ok) throw new Error(`provider media download returned HTTP ${response.status}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      return { bytes, media_content_type: response.headers.get('content-type') || 'image/unknown', transport_status: response.status };
    }
  };
}

async function copyCompletedResult(result, directory, adapter) {
  let bytes;
  let mediaContentType = result.media_content_type;
  let statusCode = result.transport_status || 200;
  if (result.inline_bytes) bytes = Buffer.from(result.inline_bytes);
  else if (result.download_url) {
    const downloaded = await adapter.download(result.download_url);
    bytes = downloaded.bytes;
    mediaContentType = downloaded.media_content_type;
    statusCode = downloaded.transport_status;
  } else throw new Error('completed provider result had no media bytes');
  if (!bytes.length || bytes.length >= MAX_BYTES) throw new Error('downloaded image is empty or exceeds 25 MiB');
  const header = inspectImageHeader(bytes);
  if (header.format === 'unknown' || header.animated) throw new Error('downloaded result is not a supported non-animated image');
  const rawPath = path.join(directory, 'raw', `provider.${header.format === 'jpeg' ? 'jpg' : header.format}`);
  await fs.mkdir(path.dirname(rawPath), { recursive: true, mode: 0o700 });
  await fs.writeFile(rawPath, bytes, { mode: 0o600 });
  return { rawPath, raw_sha256: sha256(bytes), served_model: result.served_model, cost: result.cost, media_content_type: mediaContentType, transport_status: statusCode };
}

async function reserve(request, options = {}) {
  const key = operationKey(request);
  const directory = operationDirectory(key);
  const existingStatePath = statePath(directory);
  if (options.dryRun) {
    try {
      const existing = await readJson(existingStatePath);
      if (existing.request_sha256 !== key) throw new Error('operation key collision with a different request');
      return { key, directory, state: existing, created: false, dryRun: true };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    return { key, directory, state: newReservedState(request, key), created: false, dryRun: true };
  }
  await ensurePrivateRoot();
  try {
    const existing = await readJson(existingStatePath);
    if (existing.request_sha256 !== key) throw new Error('operation key collision with a different request');
    return { key, directory, state: existing, created: false };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const release = await acquireLock(directory);
  try {
    try {
      const existing = await readJson(existingStatePath);
      return { key, directory, state: existing, created: false };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const state = newReservedState(request, key);
    await atomicWrite(existingStatePath, `${JSON.stringify(state, null, 2)}\n`);
    return { key, directory, state, created: true };
  } finally {
    await release();
  }
}

function printDryRun(request, key) {
  console.log(JSON.stringify({ operation_key: key, request: publicRequestShape(request) }, null, 2));
}

async function submitGrokOperation(request, directory, state) {
  const adapter = createGrokAdapter();
  let result;
  try {
    result = state.phase === 'submitted' ? await adapter.poll(state.remote_job_ref) : await adapter.submit(request, state.operation_key);
  } catch {
    if (state.phase !== 'submitted') {
      state.phase = 'ambiguous';
      state.reason = 'transport outcome was not knowable; reconcile before retrying';
      await writeState(directory, state);
    }
    throw new Error('provider transport failed; operation is held for reconciliation');
  }
  if (result.kind === 'pending') {
    state.phase = 'submitted';
    state.remote_job_ref = result.remote_job_ref;
    state.remote_status = result.status;
    await writeState(directory, state);
    throw new Error('provider operation is still pending; rerun run to resume polling');
  }
  const completed = await copyCompletedResult(result, directory, adapter);
  state.phase = 'downloaded';
  state.file = path.relative(directory, completed.rawPath);
  state.raw_sha256 = completed.raw_sha256;
  state.served_model = completed.served_model;
  state.cost = completed.cost;
  state.transport = { status_code: completed.transport_status, media_content_type: completed.media_content_type };
  state.completed_at = now();
  await writeState(directory, state);
  return state;
}

async function runOperation(request, options = {}) {
  const reservation = await reserve(request, options);
  if (options.dryRun) {
    printDryRun(request, reservation.key);
    return reservation.state;
  }
  const { key, directory } = reservation;
  const release = await acquireLock(directory);
  try {
    let state = await readJson(statePath(directory));
    if (state.phase === 'admitted') return state;
    if (state.phase === 'downloaded') return state;
    if (state.phase === 'ambiguous') throw new Error('operation is ambiguous; use reconcile before another provider call');
    if (request.route_id === 'codex-image') {
      await writeState(directory, state);
      console.log(JSON.stringify({ operation_key: key, phase: state.phase, next: 'import the private Codex image result, then run admit' }));
      return state;
    }
    state = await submitGrokOperation(request, directory, state);
    return state;
  } finally {
    await release();
  }
}

function sourcePathFromState(directory, state) {
  if (typeof state.file !== 'string' || !state.file) throw new Error('operation has no downloaded private file');
  const candidate = path.resolve(directory, state.file);
  assertInside(directory, candidate, 'operation file');
  return candidate;
}

async function importOperation(operationPath, sourceFile) {
  const directory = path.resolve(operationPath);
  assertInside(OPERATIONS_ROOT, directory, 'operation directory');
  const state = await readJson(statePath(directory));
  if (!['reserved', 'submitted', 'ambiguous', 'downloaded'].includes(state.phase)) throw new Error(`cannot import into ${state.phase} operation`);
  const source = path.resolve(sourceFile);
  const sourceBytes = await fs.readFile(source);
  if (!sourceBytes.length || sourceBytes.length >= MAX_BYTES) throw new Error('imported image is empty or exceeds 25 MiB');
  const header = inspectImageHeader(sourceBytes);
  if (header.format === 'unknown' || header.animated || !header.width || !header.height) throw new Error('imported file is not a supported non-animated image');
  const rawPath = path.join(directory, 'raw', `import.${header.format === 'jpeg' ? 'jpg' : header.format}`);
  await fs.mkdir(path.dirname(rawPath), { recursive: true, mode: 0o700 });
  await fs.writeFile(rawPath, sourceBytes, { mode: 0o600 });
  state.phase = 'downloaded';
  state.file = path.relative(directory, rawPath);
  state.raw_sha256 = sha256(sourceBytes);
  state.served_model = state.served_model || routeDefaults(state.route_id).served_model;
  state.cost = state.cost || routeDefaults(state.route_id).cost;
  state.transport = state.transport || { status_code: 200, media_content_type: header.mime };
  state.completed_at = state.completed_at || now();
  await writeState(directory, state);
  return state;
}

async function identifyImage(filePath) {
  try {
    const result = await execFile('magick', ['identify', '-format', '%m %w %h', filePath], { maxBuffer: 4096 });
    const [format, width, height] = result.stdout.trim().split(/\s+/);
    return { tool: 'ImageMagick', version: format || 'identify', width: Number(width), height: Number(height) };
  } catch {
    try {
      const result = await execFile('identify', ['-format', '%m %w %h', filePath], { maxBuffer: 4096 });
      const [format, width, height] = result.stdout.trim().split(/\s+/);
      return { tool: 'ImageMagick', version: format || 'identify', width: Number(width), height: Number(height) };
    } catch {
      return { tool: 'header-audit', version: 'node-signature-reader', width: 0, height: 0 };
    }
  }
}

async function toWebp(sourcePath, directory, sourceHeader) {
  const destination = path.join(directory, 'raw', 'admitted.webp');
  if (sourceHeader.format === 'webp') {
    await atomicCopy(sourcePath, destination);
    return { path: destination, provenance: { kind: 'direct-provider-output' }, source_sha256: sha256(await fs.readFile(sourcePath)) };
  }
  const temporary = path.join(directory, 'raw', `admitted.${process.pid}.tmp.webp`);
  try {
    await execFile('magick', [sourcePath, '-strip', '-quality', '92', `webp:${temporary}`], { maxBuffer: 4096 });
  } catch {
    throw new Error('non-WebP input requires ImageMagick for the public WebP derivative');
  }
  await fs.chmod(temporary, 0o600).catch(() => {});
  await fs.rename(temporary, destination);
  return {
    path: destination,
    provenance: {
      kind: 'web-derivative',
      source_sha256: sha256(await fs.readFile(sourcePath)),
      transform: { tool: 'ImageMagick', version: 'runtime', arguments: ['-strip', '-quality', '92', 'webp'] }
    }
  };
}

function receiptFor(state, publicHash, completedAt, mediaContentType) {
  return {
    schema_version: 1,
    operation_key: state.operation_key,
    request_sha256: state.request_sha256,
    terminal_status: 'succeeded',
    started_at: state.created_at,
    completed_at: completedAt,
    transport: state.transport || { status_code: 200, media_content_type: mediaContentType || 'image/webp' },
    served_model: state.served_model || routeDefaults(state.route_id).served_model,
    cost: state.cost || routeDefaults(state.route_id).cost,
    response_media_sha256: state.raw_sha256 || publicHash
  };
}

export function sanitizeReceipt(result, operation) {
  const state = operation?.state || operation;
  if (!state || !isHash(state.operation_key) || !isHash(state.request_sha256)) throw new Error('operation state is incomplete');
  const publicHash = result?.public_sha256 || result?.response_media_sha256;
  if (!isHash(publicHash)) throw new Error('receipt needs a media SHA-256');
  return receiptFor(state, publicHash, result?.completed_at || now(), result?.media_content_type || 'image/webp');
}

async function updateHtmlState(caseId, routeId, stateKind) {
  const htmlPath = path.join(REPOSITORY_ROOT, 'index.html');
  const html = await fs.readFile(htmlPath, 'utf8');
  const keyPattern = new RegExp(`(<figure\\b[^>]*data-case-id="${caseId}"[^>]*data-route-id="${routeId}"[^>]*data-state=")planned("[^>]*>)`, 'i');
  if (!keyPattern.test(html)) return;
  const updated = html.replace(keyPattern, `$1${stateKind}$2`);
  const cardPattern = new RegExp(`(<figure\\b[^>]*data-case-id="${caseId}"[^>]*data-route-id="${routeId}"[\\s\\S]*?<span class="status-tag">)PLANNED(</span>[\\s\\S]*?<p class="planned-note">)Awaiting admitted output(</p>)`, 'i');
  const withLabel = updated.replace(cardPattern, '$1GENERATED$2Admitted output$3');
  await atomicWrite(htmlPath, withLabel, 0o644);
}

async function updateManifest(state, publicHash, publicBytes, facts, receiptHash, admission) {
  const manifestPath = path.join(REPOSITORY_ROOT, 'data/comparison.json');
  const manifest = parseManifest(await fs.readFile(manifestPath, 'utf8'));
  const sample = manifest.samples[state.case_id]?.[state.route_id];
  if (!sample) throw new Error('operation references an unknown manifest cell');
  if (sample.state.kind === 'generated') return manifest;
  const next = JSON.parse(JSON.stringify(manifest));
  const target = next.samples[state.case_id][state.route_id];
  target.state = { kind: 'generated', request_sha256: state.request_sha256 };
  target.generated_at = state.completed_at || now();
  target.asset = {
    kind: 'public-asset',
    sha256: publicHash,
    bytes: publicBytes,
    provenance: admission.provenance
  };
  target.media_facts = {
    kind: 'image',
    format: facts.format,
    width: facts.width,
    height: facts.height,
    alpha: facts.alpha
  };
  target.receipt_sha256 = receiptHash;
  target.served_model = state.served_model || target.served_model;
  target.cost = state.cost || target.cost;
  target.admission = {
    full_decode: { tool: admission.decode.tool, version: admission.decode.version },
    nonblank_review: { kind: 'human-reviewed', reviewed_on: admission.reviewed_on }
  };
  await atomicWrite(manifestPath, `${JSON.stringify(next, null, 2)}\n`, 0o644);
  return next;
}

export async function admitOperation(operationPath, repositoryRoot = REPOSITORY_ROOT, options = {}) {
  const directory = path.resolve(operationPath);
  assertInside(OPERATIONS_ROOT, directory, 'operation directory');
  const release = await acquireLock(directory);
  try {
    const state = await readJson(statePath(directory));
    if (state.phase === 'admitted') return state;
    if (state.phase !== 'downloaded') throw new Error(`operation must be downloaded before admission (currently ${state.phase})`);
    const sourcePath = sourcePathFromState(directory, state);
    const sourceBytes = await fs.readFile(sourcePath);
    const sourceHeader = inspectImageHeader(sourceBytes);
    if (sourceHeader.format === 'unknown' || sourceHeader.animated) throw new Error('private source is not a supported non-animated image');
    const reviewDate = options.reviewedOn || process.env.IMAGE_REVIEWED_ON;
    if (!isDate(reviewDate)) throw new Error('admission requires --reviewed-on YYYY-MM-DD or IMAGE_REVIEWED_ON');
    if (options.dryRun) {
      console.log(JSON.stringify({ operation_key: state.operation_key, phase: state.phase, source_sha256: sha256(sourceBytes), next: 'promote WebP after human review' }));
      return state;
    }
    const derivative = await toWebp(sourcePath, directory, sourceHeader);
    const publicBytes = await fs.readFile(derivative.path);
    if (!publicBytes.length || publicBytes.length >= MAX_BYTES) throw new Error('admitted WebP is empty or exceeds 25 MiB');
    const facts = inspectImageHeader(publicBytes);
    if (facts.format !== 'webp' || !facts.width || !facts.height || facts.animated) throw new Error('admitted derivative is not a valid non-animated WebP');
    const decode = await identifyImage(derivative.path);
    if (decode.width && (decode.width !== facts.width || decode.height !== facts.height)) throw new Error('decode dimensions differ from WebP header');
    const publicHash = sha256(publicBytes);
    const relativeMedia = mediaPath('image', state.case_id, state.route_id);
    const publicMediaPath = path.resolve(repositoryRoot, relativeMedia);
    assertInside(path.resolve(repositoryRoot), publicMediaPath, 'public media path');
    await atomicCopy(derivative.path, publicMediaPath);
    const completedAt = now();
    const receipt = receiptFor(state, publicHash, completedAt, 'image/webp');
    const receiptBytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
    const receiptHash = sha256(receiptBytes);
    const publicReceiptPath = path.resolve(repositoryRoot, receiptPath(state.case_id, state.route_id));
    assertInside(path.resolve(repositoryRoot), publicReceiptPath, 'public receipt path');
    await atomicWrite(publicReceiptPath, receiptBytes.toString('utf8'), 0o644);
    await updateManifest(state, publicHash, publicBytes.length, facts, receiptHash, { provenance: derivative.provenance, decode, reviewed_on: reviewDate });
    state.phase = 'admitted';
    state.public_sha256 = publicHash;
    state.public_bytes = publicBytes.length;
    state.public_media = relativeMedia;
    state.public_receipt = receiptPath(state.case_id, state.route_id);
    state.completed_at = completedAt;
    await writeState(directory, state);
    await updateHtmlState(state.case_id, state.route_id, 'generated');
    return state;
  } finally {
    await release();
  }
}

async function reconcileOperation(operationPath, options) {
  const directory = path.resolve(operationPath);
  assertInside(OPERATIONS_ROOT, directory, 'operation directory');
  const release = await acquireLock(directory);
  try {
    const state = await readJson(statePath(directory));
    if (state.phase !== 'ambiguous' && state.phase !== 'reserved' && state.phase !== 'submitted') throw new Error(`cannot reconcile ${state.phase} operation`);
    if (options.file) {
      // Import performs its own header and size checks; release first to avoid nested lock acquisition.
      state.phase = state.phase === 'ambiguous' ? 'reserved' : state.phase;
      await writeState(directory, state);
    } else if (options.remoteJobRef) {
      const remoteJobRef = String(options.remoteJobRef);
      if (!/^[A-Za-z0-9._:-]{1,200}$/.test(remoteJobRef)) throw new Error('remote job reference contains unsupported characters');
      state.phase = 'submitted';
      state.remote_job_ref = remoteJobRef;
      delete state.reason;
      await writeState(directory, state);
      return state;
    } else {
      throw new Error('reconcile requires --file or --remote-job-ref');
    }
  } finally {
    await release();
  }
  if (options.file) return importOperation(directory, path.resolve(options.file));
  return readJson(statePath(directory));
}

function parseArgs(argv) {
  const [command = ''] = argv;
  const options = { command };
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--case') options.caseId = argv[++index];
    else if (argument === '--route') options.routeId = argv[++index];
    else if (argument === '--operation') options.operation = argv[++index];
    else if (argument === '--file') options.file = argv[++index];
    else if (argument === '--remote-job-ref') options.remoteJobRef = argv[++index];
    else if (argument === '--reviewed-on') options.reviewedOn = argv[++index];
    else if (argument === '--dry-run') options.dryRun = true;
    else if (argument === '--help' || argument === '-h') options.help = true;
    else throw new Error(`unknown argument: ${argument}`);
  }
  return options;
}

async function main(argv) {
  const options = parseArgs(argv);
  if (options.help || !options.command) {
    console.log('Usage: node scripts/capture.mjs <reserve|run|import|admit|reconcile> [options]');
    console.log('  reserve/run: --case CASE --route ROUTE [--dry-run]');
    console.log('  import: --operation .work/operations/KEY --file PRIVATE_IMAGE');
    console.log('  admit: --operation .work/operations/KEY --reviewed-on YYYY-MM-DD [--dry-run]');
    console.log('  reconcile: --operation .work/operations/KEY (--file PRIVATE_IMAGE | --remote-job-ref REF)');
    return;
  }
  if (['reserve', 'run'].includes(options.command)) {
    const manifest = await loadManifest();
    const request = requestFor(manifest, options.caseId, options.routeId);
    if (options.command === 'reserve') {
      const result = await reserve(request, options);
      if (options.dryRun) printDryRun(request, result.key);
      else console.log(JSON.stringify(sanitizedSummary(result.state)));
      return;
    }
    const state = await runOperation(request, options);
    console.log(JSON.stringify(sanitizedSummary(state)));
    return;
  }
  if (options.command === 'import') {
    if (!options.operation || !options.file) throw new Error('import requires --operation and --file');
    const state = await importOperation(options.operation, options.file);
    console.log(JSON.stringify(sanitizedSummary(state)));
    return;
  }
  if (options.command === 'admit') {
    if (!options.operation) throw new Error('admit requires --operation');
    const state = await admitOperation(options.operation, REPOSITORY_ROOT, options);
    console.log(JSON.stringify(sanitizedSummary(state)));
    return;
  }
  if (options.command === 'reconcile') {
    if (!options.operation) throw new Error('reconcile requires --operation');
    const state = await reconcileOperation(options.operation, options);
    console.log(JSON.stringify(sanitizedSummary(state)));
    return;
  }
  throw new Error(`unknown command: ${options.command}`);
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(`capture error: ${error.message}`);
    process.exitCode = 1;
  }
}
