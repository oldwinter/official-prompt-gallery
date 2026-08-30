import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  EXPECTED_MODELS,
  hasExactServedModel,
  REQUIRED_CASES,
  REQUIRED_ROUTES,
  mediaPath,
  posterPath,
  parseManifest,
} from "./validate.mjs";

const REPOSITORY_ROOT = fileURLToPath(new URL("../", import.meta.url));
const PRIVATE_ROOT = join(REPOSITORY_ROOT, ".work");
const OPERATIONS_ROOT = join(PRIVATE_ROOT, "operations");
const H3_DEFAULT_BASE = "http://127.0.0.1:30010";
const OPERATION_HASH_PATTERN = /^[a-f0-9]{64}$/;
const ISO_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 120_000;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

function now() {
  return new Date().toISOString().replace(/(\.\d{3})\d+Z$/, "$1Z");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function ensureId(value, allowed, label) {
  if (!allowed.includes(value)) throw new Error(`${label} must be one of ${allowed.join(", ")}`);
  return value;
}

function ensureOperationKey(value) {
  if (typeof value !== "string" || !OPERATION_HASH_PATTERN.test(value)) throw new Error("operation must be a 64-character operation key or an operation directory");
  return value;
}

function operationDirectory(operationKey, privateRoot = PRIVATE_ROOT) {
  return join(fileURLToPathIfUrl(privateRoot), "operations", ensureOperationKey(operationKey));
}

function fileURLToPathIfUrl(value) {
  return value instanceof URL ? fileURLToPath(value) : String(value);
}

function readManifest() {
  return parseManifest(readFileSync(join(REPOSITORY_ROOT, "data", "comparison.json"), "utf8"));
}

function buildCaptureRequest(manifest, caseId, routeId) {
  ensureId(caseId, REQUIRED_CASES, "case");
  ensureId(routeId, REQUIRED_ROUTES, "route");
  const promptCase = manifest.cases[caseId];
  const route = manifest.routes[routeId];
  const cell = manifest.samples[caseId][routeId];
  return {
    repository: manifest.repository,
    media_kind: manifest.media_kind,
    case_id: caseId,
    route_id: routeId,
    prompt_sha256: promptCase.prompt.sha256,
    prompt: promptCase.prompt.text,
    requested_model: route.requested_model.id,
    parameters: cell.parameters,
  };
}

/** Hash only canonical request fields. Attempt numbers are intentionally absent. */
export function operationKey(input) {
  if (!input || typeof input !== "object") throw new Error("capture request must be an object");
  const canonical = {
    repository: input.repository,
    media_kind: input.media_kind,
    case_id: input.case_id,
    route_id: input.route_id,
    prompt_sha256: input.prompt_sha256,
    requested_model: input.requested_model,
    parameters: input.parameters,
  };
  for (const key of ["repository", "media_kind", "case_id", "route_id", "prompt_sha256", "requested_model", "parameters"]) {
    if (canonical[key] === undefined) throw new Error(`capture request is missing ${key}`);
  }
  return sha256(stableJson(canonical));
}

function requestDigest(request) {
  return sha256(stableJson({
    model: request.requested_model,
    prompt: request.prompt,
    parameters: request.parameters,
  }));
}

function routePayload(request) {
  const params = request.parameters;
  return {
    model: request.requested_model,
    prompt: request.prompt,
    duration: Math.round(params.duration_seconds),
    aspect_ratio: params.aspect_ratio,
    resolution: params.requested_resolution.value,
  };
}

export function h3FormData(request) {
  const params = request.parameters;
  const form = new FormData();
  form.append("model", "/models/MiniMax-H3");
  form.append("prompt", request.prompt);
  form.append("seconds", String(Math.round(params.duration_seconds)));
  form.append("size", "1344x768");
  form.append("num_outputs_per_prompt", "1");
  form.append("extra_body", JSON.stringify({
    task: "t2va",
    conditions: [],
    target: {
      short_edge: params.requested_resolution.pixels,
      aspect_ratio: params.aspect_ratio,
      duration_seconds: params.duration_seconds,
    },
    num_outputs_per_prompt: 1,
    num_inference_steps: 50,
    flow_shift: 12,
    audio_flow_shift: 3,
    quality: "lossless",
  }));
  return form;
}

async function readLimited(response, limit = MAX_RESPONSE_BYTES) {
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > limit) throw new Error(`provider response exceeds ${limit} bytes`);
  if (!response.body) return Buffer.alloc(0);
  const chunks = [];
  let total = 0;
  for await (const chunk of response.body) {
    const bytes = Buffer.from(chunk);
    total += bytes.length;
    if (total > limit) throw new Error(`provider response exceeds ${limit} bytes`);
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, total);
}

function routeBase(routeId) {
  const configured = routeId === "minimax-h3" ? (process.env.H3_API_BASE || H3_DEFAULT_BASE) : process.env.GROK_BASE_URL;
  if (!configured) throw new Error("GROK_BASE_URL is required for the Grok route");
  const parsed = new URL(configured);
  if (parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error("API base URL must not contain credentials, query, or fragment");
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && LOOPBACK_HOSTS.has(parsed.hostname))) throw new Error("API base URL must use HTTPS except for loopback development");
  return parsed.toString().replace(/\/$/, "");
}

function endpoint(base, path) {
  const suffix = path.startsWith("/v1/") && base.endsWith("/v1") ? path.slice(3) : path;
  return `${base}${suffix}`;
}

function routeHeaders(routeId, operation, json = true) {
  const headers = {
    accept: "application/json",
    "idempotency-key": operation,
  };
  if (json) headers["content-type"] = "application/json";
  if (routeId === "grok-video") {
    if (!process.env.GROK_API_KEY) throw new Error("GROK_API_KEY is required for the Grok route");
    headers.authorization = `Bearer ${process.env.GROK_API_KEY}`;
  }
  return headers;
}

function responseField(value, keys) {
  for (const key of keys) {
    if (typeof value?.[key] === "string" && value[key].length > 0) return value[key];
  }
  return undefined;
}

function unwrapResponse(response) {
  if (!response || typeof response !== "object") throw new Error("provider response must be an object");
  if (response.data && typeof response.data === "object" && !Array.isArray(response.data)) return { ...response, ...response.data };
  if (Array.isArray(response.data) && response.data[0] && typeof response.data[0] === "object") return { ...response, ...response.data[0] };
  return response;
}

/** Parse an allowlisted provider response without retaining its wire shape. */
export function parseProviderResponse(route, response) {
  const routeKind = typeof route === "string" ? route : route?.execution?.kind === "sub2api" ? "grok-video" : "minimax-h3";
  const value = unwrapResponse(response);
  const status = String(value.status ?? value.state ?? value.phase ?? "").toLowerCase();
  const remoteJobRef = responseField(value, ["id", "request_id", "job_id", "task_id"]);
  const mediaUrl = responseField(value, ["video_url", "media_url", "download_url", "url", "content_url"]);
  const servedId = responseField(value, ["model", "served_model", "model_id"]);
  const amount = value.cost?.amount ?? value.cost?.price ?? value.amount;
  const cost = typeof amount === "number" || (typeof amount === "string" && /^\d+(?:\.\d+)?$/.test(amount))
    ? { kind: "reported", currency: "USD", decimal_amount: String(amount) }
    : routeKind === "minimax-h3" ? { kind: "local-compute-not-priced" } : { kind: "paid-route-amount-not-exposed" };
  const servedModel = servedId
    ? { kind: "provider-reported", id: servedId, receipt_field: value.model ? "model" : value.served_model ? "served_model" : "model_id" }
    : routeKind === "minimax-h3"
      ? { kind: "operator-verified-local-deployment", id: "MiniMax-H3", evidence: "local runtime model check" }
      : { kind: "not-exposed", reason: "provider-response-omits-model" };
  const terminal = ["completed", "complete", "succeeded", "success", "done", "finished"].includes(status) || Boolean(mediaUrl);
  const failed = ["failed", "error", "cancelled", "canceled", "rejected", "expired", "timeout", "timed_out", "aborted"].includes(status);
  const pending = ["", "queued", "pending", "processing", "in_progress", "running"].includes(status);
  if (failed) throw new Error("provider reported a terminal failure");
  if (!terminal && !pending) throw new Error(`provider reported an unknown status: ${status}`);
  if (!remoteJobRef && !mediaUrl && !terminal) throw new Error("provider response omitted a job reference");
  return {
    phase: terminal ? "completed" : "pending",
    remote_job_ref: remoteJobRef,
    media_url: mediaUrl,
    content_type: responseField(value, ["content_type", "mime_type"]) || "video/mp4",
    served_model: servedModel,
    cost,
  };
}

async function requestJson(url, options) {
  const response = await fetch(url, {
    ...options,
    redirect: "error",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = (await readLimited(response, 1024 * 1024)).toString("utf8");
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`provider returned non-JSON status ${response.status}`);
  }
  if (!response.ok) throw new Error(`provider request failed with status ${response.status}`);
  return { body, status: response.status };
}

function adapterFor(routeId) {
  if (routeId === "minimax-h3") {
    return {
      submit: async (request, operation) => {
        const base = routeBase(routeId);
        const result = await requestJson(endpoint(base, "/v1/videos"), { method: "POST", headers: routeHeaders(routeId, operation, false), body: h3FormData(request) });
        return parseProviderResponse(routeId, result.body);
      },
      poll: async (request, operation, remoteJobRef) => {
        const base = routeBase(routeId);
        const result = await requestJson(endpoint(base, `/v1/videos/${encodeURIComponent(remoteJobRef)}`), { headers: { ...routeHeaders(routeId, operation), accept: "application/json" } });
        return parseProviderResponse(routeId, result.body);
      },
      contentUrl: (remoteJobRef) => endpoint(routeBase(routeId), `/v1/videos/${encodeURIComponent(remoteJobRef)}/content`),
    };
  }
  return {
    submit: async (request, operation) => {
      const base = routeBase(routeId);
      const result = await requestJson(endpoint(base, "/v1/videos/generations"), { method: "POST", headers: routeHeaders(routeId, operation), body: JSON.stringify(routePayload(request)) });
      return parseProviderResponse(routeId, result.body);
    },
    poll: async (request, operation, remoteJobRef) => {
      const base = routeBase(routeId);
      const result = await requestJson(endpoint(base, `/v1/videos/${encodeURIComponent(remoteJobRef)}`), { headers: { ...routeHeaders(routeId, operation), accept: "application/json" } });
      return parseProviderResponse(routeId, result.body);
    },
    contentUrl: () => undefined,
  };
}

async function downloadMedia(routeId, mediaUrl) {
  const parsed = new URL(mediaUrl);
  const base = new URL(routeBase(routeId));
  if (parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error("provider media URL contains unsupported URL components");
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && LOOPBACK_HOSTS.has(parsed.hostname))) throw new Error("provider media URL must use HTTPS or loopback HTTP");
  const sameOrigin = parsed.origin === base.origin;
  if (routeId === "minimax-h3" && !sameOrigin) throw new Error("H3 media URL must remain on the configured H3 origin");
  if (routeId === "grok-video" && !sameOrigin && parsed.hostname !== "x.ai" && !parsed.hostname.endsWith(".x.ai")) throw new Error("Grok media URL must remain on the configured origin or an x.ai host");
  const headers = {};
  if (routeId === "grok-video" && sameOrigin) headers.authorization = `Bearer ${process.env.GROK_API_KEY}`;
  const response = await fetch(parsed, {
    headers,
    redirect: "error",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`media download failed with status ${response.status}`);
  const bytes = await readLimited(response, 25 * 1024 * 1024 - 1);
  return { bytes, contentType: response.headers.get("content-type") || "video/mp4" };
}

async function atomicJson(filePath, value, mode = 0o600) {
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode });
  await rename(temporary, filePath);
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function acquireLock(operationDir) {
  const lock = join(operationDir, ".lock");
  const staleAfter = Math.max(60_000, Number(process.env.CAPTURE_LOCK_STALE_MS || 6 * 60 * 60 * 1000));
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await mkdir(lock, { recursive: false, mode: 0o700 });
      await writeFile(join(lock, "owner"), `${process.pid}\n`, { mode: 0o600 });
      return async () => rm(lock, { recursive: true, force: true });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      try {
        if (Date.now() - lstatSync(lock).mtimeMs > staleAfter) {
          await rm(lock, { recursive: true, force: true });
          continue;
        }
      } catch (statError) {
        if (statError.code !== "ENOENT") throw statError;
        continue;
      }
      throw new Error("operation is already being handled by another process");
    }
  }
  throw new Error("could not acquire operation lock");
}

async function reserveInternal(request, privateRoot = PRIVATE_ROOT) {
  const root = fileURLToPathIfUrl(privateRoot);
  const key = operationKey(request);
  const dir = operationDirectory(key, root);
  await mkdir(join(root, "operations"), { recursive: true, mode: 0o700 });
  try {
    await mkdir(dir, { recursive: false, mode: 0o700 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  const statePath = join(dir, "state.json");
  if (existsSync(statePath)) return { key, dir, state: await readJson(statePath), existing: true };
  const unlock = await acquireLock(dir);
  try {
    if (existsSync(statePath)) return { key, dir, state: await readJson(statePath), existing: true };
    const state = {
      phase: "reserved",
      operation_key: key,
      request_sha256: requestDigest(request),
      created_at: now(),
    };
    await atomicJson(statePath, state);
    await atomicJson(join(dir, "request.json"), {
      repository: request.repository,
      media_kind: request.media_kind,
      case_id: request.case_id,
      route_id: request.route_id,
      prompt_sha256: request.prompt_sha256,
      prompt: request.prompt,
      requested_model: request.requested_model,
      parameters: request.parameters,
    });
    return { key, dir, state, existing: false };
  } finally {
    await unlock();
  }
}

function sanitizeOperationState(state) {
  const allowed = {
    reserved: ["phase", "operation_key", "request_sha256", "created_at"],
    submitting: ["phase", "operation_key", "request_sha256", "created_at"],
    submitted: ["phase", "operation_key", "request_sha256", "created_at", "remote_job_ref"],
    ambiguous: ["phase", "operation_key", "request_sha256", "created_at", "reason"],
    downloaded: ["phase", "operation_key", "request_sha256", "created_at", "raw_sha256", "file", "content_type"],
    admitted: ["phase", "operation_key", "request_sha256", "case_id", "route_id", "public_sha256"],
  };
  if (!state || !allowed[state.phase]) throw new Error("invalid operation state");
  return Object.fromEntries(allowed[state.phase].filter((key) => state[key] !== undefined).map((key) => [key, state[key]]));
}

async function submitAndDownload(request, reservation) {
  const { key, dir } = reservation;
  const unlock = await acquireLock(dir);
  try {
    let state = await readJson(join(dir, "state.json"));
    if (state.phase === "admitted" || state.phase === "downloaded") return state;
    if (state.phase === "ambiguous" || state.phase === "submitting") throw new Error("operation submission is ambiguous; reconcile it before running again");
    const adapter = adapterFor(request.route_id);
    let result;
    let remoteJobRef = state.remote_job_ref;
    try {
      if (state.phase === "reserved") {
        state = { phase: "submitting", operation_key: key, request_sha256: state.request_sha256, created_at: state.created_at };
        await atomicJson(join(dir, "state.json"), sanitizeOperationState(state));
        result = await adapter.submit(request, key);
        if (result.remote_job_ref) remoteJobRef = result.remote_job_ref;
        if (result.phase === "pending" && !remoteJobRef) throw new Error("provider returned pending without a job reference");
        if (remoteJobRef) {
          state = { phase: "submitted", operation_key: key, request_sha256: state.request_sha256, created_at: state.created_at, remote_job_ref: remoteJobRef };
          await atomicJson(join(dir, "state.json"), sanitizeOperationState(state));
        }
      }
      if (state.phase === "submitted" && !result?.media_url) {
        const attempts = Math.max(1, Number(process.env.CAPTURE_POLL_LIMIT || 30));
        const delay = Math.max(0, Number(process.env.CAPTURE_POLL_DELAY_MS || 1000));
        for (let attempt = 0; attempt < attempts; attempt += 1) {
          result = await adapter.poll(request, key, state.remote_job_ref);
          if (result.phase === "completed") break;
          if (attempt + 1 < attempts && delay) await new Promise((resolvePromise) => setTimeout(resolvePromise, delay));
        }
        if (!result || result.phase !== "completed") throw new Error("provider did not complete before the poll limit");
      }
    } catch (error) {
      if (state.phase === "reserved" || state.phase === "submitting") {
        await atomicJson(join(dir, "state.json"), {
          phase: "ambiguous",
          operation_key: key,
          request_sha256: state.request_sha256,
          created_at: state.created_at,
          reason: "submission outcome could not be established; reconcile before retrying",
        });
      }
      throw error;
    }
    const mediaUrl = result.media_url || adapter.contentUrl(state.remote_job_ref);
    if (!mediaUrl) throw new Error("provider completed without a media URL");
    const downloadedMedia = await downloadMedia(request.route_id, mediaUrl);
    const bytes = downloadedMedia.bytes;
    const extension = (result.content_type || downloadedMedia.contentType).includes("webm") ? ".webm" : ".mp4";
    const rawFile = join(dir, `raw${extension}`);
    await writeFile(rawFile, bytes, { mode: 0o600 });
    const downloaded = {
      phase: "downloaded",
      operation_key: key,
      request_sha256: state.request_sha256,
      created_at: state.created_at,
      raw_sha256: sha256(bytes),
      file: basename(rawFile),
      content_type: result.content_type || downloadedMedia.contentType,
    };
    await atomicJson(join(dir, "state.json"), sanitizeOperationState(downloaded));
    await atomicJson(join(dir, "provider-evidence.json"), {
      served_model: result.served_model,
      cost: result.cost,
      completed_at: now(),
    });
    return downloaded;
  } finally {
    await unlock();
  }
}

/** Resume a reserved/submitted operation without changing its operation key. */
export async function resumeOperation(request, privateRoot = PRIVATE_ROOT) {
  const reservation = await reserveInternal(request, privateRoot);
  return submitAndDownload(request, reservation);
}

export function sanitizeReceipt(result, operation) {
  if (!result || result.phase !== "completed") throw new Error("receipt requires a completed provider result");
  if (!OPERATION_HASH_PATTERN.test(operation.operation_key || "") || !OPERATION_HASH_PATTERN.test(operation.request_sha256 || "")) throw new Error("receipt operation hashes are invalid");
  if (!OPERATION_HASH_PATTERN.test(result.response_media_sha256 || "")) throw new Error("receipt requires the downloaded media hash");
  const started = operation.created_at || now();
  const completed = now();
  if (!ISO_INSTANT_PATTERN.test(started) || !ISO_INSTANT_PATTERN.test(completed)) throw new Error("receipt timestamps must be UTC instants");
  return {
    schema_version: 1,
    operation_key: operation.operation_key,
    request_sha256: operation.request_sha256,
    terminal_status: "succeeded",
    started_at: started,
    completed_at: completed,
    transport: {
      status_code: 200,
      media_content_type: result.content_type || "video/mp4",
    },
    served_model: result.served_model,
    cost: result.cost,
    response_media_sha256: result.response_media_sha256,
  };
}

function inspectWithFfprobe(filePath) {
  const available = spawnSync("ffprobe", ["-version"], { stdio: "ignore", timeout: 3000 });
  if (available.error || available.status !== 0) return null;
  const result = spawnSync("ffprobe", ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", filePath], { encoding: "utf8", timeout: 20000 });
  if (result.error || result.status !== 0) throw new Error("ffprobe could not decode the imported video");
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new Error("ffprobe returned invalid JSON");
  }
  const video = parsed.streams?.find((stream) => stream.codec_type === "video");
  if (!video) throw new Error("imported file has no video stream");
  const duration = Number(video.duration ?? parsed.format?.duration);
  const [numerator, denominator] = String(video.avg_frame_rate || video.r_frame_rate || "0/1").split("/").map(Number);
  return {
    container: "mp4",
    codec: String(video.codec_name || "unknown"),
    width: Number(video.width),
    height: Number(video.height),
    duration_milliseconds: Math.round(duration * 1000),
    frame_rate_millihertz: Math.round((denominator ? numerator / denominator : 0) * 1000),
    audio: parsed.streams?.some((stream) => stream.codec_type === "audio")
      ? { kind: "present", codec: String(parsed.streams.find((stream) => stream.codec_type === "audio").codec_name || "unknown") }
      : { kind: "absent" },
  };
}

function dateOnly(value = now()) {
  return value.slice(0, 10);
}

function parseFlagArgs(argv) {
  const result = { positional: [], flags: {} };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) {
      result.positional.push(item);
      continue;
    }
    const equal = item.indexOf("=");
    if (equal > 2) {
      result.flags[item.slice(2, equal)] = item.slice(equal + 1);
    } else if (argv[index + 1] && !argv[index + 1].startsWith("--")) {
      result.flags[item.slice(2)] = argv[++index];
    } else {
      result.flags[item.slice(2)] = true;
    }
  }
  return result;
}

function operationKeyFromArgument(value) {
  const raw = String(value || "");
  const candidate = basename(raw);
  return ensureOperationKey(candidate);
}

async function importFileUnlocked(operationDir, sourcePath, posterSource, metadata) {
  const statePath = join(operationDir, "state.json");
  const state = await readJson(statePath);
  if (!["reserved", "submitted", "ambiguous", "downloaded"].includes(state.phase)) throw new Error(`cannot import into ${state.phase} operation`);
  const source = resolve(sourcePath);
  const sourceInfo = lstatSync(source);
  if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink()) throw new Error("import source must be a regular non-symlink file");
  const extension = source.toLowerCase().endsWith(".webm") ? ".webm" : ".mp4";
  const rawFile = join(operationDir, `raw${extension}`);
  await copyFile(source, rawFile);
  const bytes = await readFile(rawFile);
  const next = {
    phase: "downloaded",
    operation_key: state.operation_key,
    request_sha256: state.request_sha256,
    raw_sha256: sha256(bytes),
    file: basename(rawFile),
    content_type: extension === ".webm" ? "video/webm" : "video/mp4",
  };
  await atomicJson(statePath, sanitizeOperationState(next));
  if (posterSource) {
    const poster = resolve(posterSource);
    const posterInfo = lstatSync(poster);
    if (!posterInfo.isFile() || posterInfo.isSymbolicLink()) throw new Error("poster source must be a regular non-symlink file");
    await copyFile(poster, join(operationDir, "poster.webp"));
  }
  await atomicJson(join(operationDir, "admission.json"), metadata || {});
  return next;
}

async function importFile(operationDir, sourcePath, posterSource, metadata) {
  const release = await acquireLock(operationDir);
  try {
    return await importFileUnlocked(operationDir, sourcePath, posterSource, metadata);
  } finally {
    await release();
  }
}

function defaultGeneratedEvidence(routeId, providerEvidence) {
  if (providerEvidence?.served_model) return providerEvidence.served_model;
  if (routeId === "minimax-h3") return { kind: "operator-verified-local-deployment", id: "MiniMax-H3", evidence: "local runtime model check" };
  return { kind: "not-exposed", reason: "provider-response-omits-model" };
}

function defaultCost(routeId, providerEvidence) {
  if (providerEvidence?.cost) return providerEvidence.cost;
  return routeId === "minimax-h3" ? { kind: "local-compute-not-priced" } : { kind: "paid-route-amount-not-exposed" };
}

async function updateHtmlState(caseId, routeId, repositoryRoot = REPOSITORY_ROOT) {
  const htmlPath = join(fileURLToPathIfUrl(repositoryRoot), "index.html");
  const html = await readFile(htmlPath, "utf8");
  const figurePattern = new RegExp(`(<figure\\b[^>]*data-case-id="${caseId}"[^>]*data-route-id="${routeId}"[^>]*data-state=")planned("[^>]*>)`, "i");
  if (!figurePattern.test(html)) return;
  const updated = html.replace(figurePattern, "$1generated$2");
  const statusPattern = new RegExp(`(<figure\\b[^>]*data-case-id="${caseId}"[^>]*data-route-id="${routeId}"[\\s\\S]*?<span class="state-tag">)PLANNED(</span>)`, "i");
  const statusReplacements = updated.match(statusPattern) ? 1 : 0;
  const withStatus = updated.replace(statusPattern, (match, prefix, suffix) => `${prefix}GENERATED${suffix}`);
  if (statusReplacements !== 1) throw new Error(`HTML status projection for ${caseId}/${routeId} matched ${statusReplacements} cards`);
  const temporary = `${htmlPath}.tmp-${process.pid}`;
  await writeFile(temporary, withStatus, { mode: 0o644 });
  await rename(temporary, htmlPath);
}

/** Promote a downloaded, reviewed operation with per-file atomic writes. */
async function verifyAdmittedProjection(state, repositoryRoot, operationDir) {
  const root = fileURLToPathIfUrl(repositoryRoot);
  const request = state.case_id && state.route_id ? state : await readJson(join(operationDir, "request.json"));
  const caseId = request.case_id;
  const routeId = request.route_id;
  const manifest = parseManifest(await readFile(join(root, "data", "comparison.json"), "utf8"));
  const cell = manifest.samples[caseId]?.[routeId];
  if (!cell || cell.state.kind !== "generated") throw new Error("admitted operation has no generated manifest cell");
  const media = join(root, mediaPath("video", caseId, routeId));
  const receipt = join(root, `receipts/${caseId}--${routeId}.json`);
  if (!existsSync(media) || !existsSync(receipt)) throw new Error("admitted operation is missing a public media or receipt file");
  if (sha256(readFileSync(media)) !== cell.state.asset.sha256 || sha256(readFileSync(receipt)) !== cell.state.receipt_sha256) throw new Error("admitted operation does not match public hashes");
  const html = await readFile(join(root, "index.html"), "utf8");
  const pattern = new RegExp(`<figure\\b[^>]*data-case-id="${caseId}"[^>]*data-route-id="${routeId}"[^>]*data-state="generated"`, "i");
  if (!pattern.test(html)) throw new Error("admitted operation has an out-of-date HTML projection");
}

export async function admitOperation(operationDirInput, repositoryRoot = REPOSITORY_ROOT) {
  const operationDir = fileURLToPathIfUrl(operationDirInput);
  const root = fileURLToPathIfUrl(repositoryRoot);
  const release = await acquireLock(operationDir);
  try {
    const state = await readJson(join(operationDir, "state.json"));
    if (state.phase === "admitted") {
      try {
        await verifyAdmittedProjection(state, root, operationDir);
        if (!state.case_id || !state.route_id) {
          const request = await readJson(join(operationDir, "request.json"));
          await atomicJson(join(operationDir, "state.json"), { ...state, case_id: request.case_id, route_id: request.route_id });
        }
        return state;
      } catch {
        state.phase = "downloaded";
        await atomicJson(join(operationDir, "state.json"), state);
      }
    }
    if (state.phase !== "downloaded") throw new Error(`admit requires downloaded state, found ${state.phase}`);
  const requestRecord = await readJson(join(operationDir, "request.json"));
  const manifestPath = join(root, "data", "comparison.json");
  const manifest = parseManifest(await readFile(manifestPath, "utf8"));
  ensureId(requestRecord.case_id, REQUIRED_CASES, "case");
  ensureId(requestRecord.route_id, REQUIRED_ROUTES, "route");
  if (requestRecord.prompt_sha256 !== manifest.cases[requestRecord.case_id].prompt.sha256) throw new Error("operation prompt digest does not match the current manifest");
  if (requestRecord.requested_model !== manifest.routes[requestRecord.route_id].requested_model.id || stableJson(requestRecord.parameters) !== stableJson(manifest.samples[requestRecord.case_id][requestRecord.route_id].parameters)) throw new Error("operation request does not match the current manifest");
  const expectedOperation = operationKey(requestRecord);
  if (expectedOperation !== state.operation_key) throw new Error("operation key does not match its canonical request");
  const rawPath = join(operationDir, state.file);
  const rawInfo = lstatSync(rawPath);
  if (!rawInfo.isFile() || rawInfo.isSymbolicLink()) throw new Error("downloaded media must be a regular file");
  const rawBytes = await readFile(rawPath);
  if (sha256(rawBytes) !== state.raw_sha256) throw new Error("downloaded media hash changed; import it again");
  if (rawBytes.length >= 25 * 1024 * 1024) throw new Error("media must be strictly smaller than 25 MiB");
  if (rawBytes.subarray(4, 8).toString("ascii") !== "ftyp") throw new Error("admitted media must be an MP4 file");
  const posterPathPrivate = join(operationDir, "poster.webp");
  if (!existsSync(posterPathPrivate)) throw new Error("admit requires poster.webp in the operation directory");
  const posterBytes = await readFile(posterPathPrivate);
  if (posterBytes.length >= 25 * 1024 * 1024) throw new Error("poster must be strictly smaller than 25 MiB");
  if (posterBytes.subarray(0, 4).toString("ascii") !== "RIFF" || posterBytes.subarray(8, 12).toString("ascii") !== "WEBP") throw new Error("poster must be a WebP file");
  const metadata = existsSync(join(operationDir, "admission.json")) ? await readJson(join(operationDir, "admission.json")) : {};
  const ffprobeFacts = inspectWithFfprobe(rawPath);
  const facts = ffprobeFacts || {
    container: "mp4",
    codec: metadata.codec || "unverified",
    width: Number(metadata.width || 1),
    height: Number(metadata.height || 1),
    duration_milliseconds: Number(metadata.duration_milliseconds || 5000),
    frame_rate_millihertz: Number(metadata.frame_rate_millihertz || 24000),
    audio: metadata.audio === "present" ? { kind: "present", codec: metadata.audio_codec || "unknown" } : { kind: "absent" },
  };
  if (facts.width <= 0 || facts.height <= 0 || facts.duration_milliseconds <= 0 || facts.frame_rate_millihertz <= 0) throw new Error("admission media facts must be positive");
  if (!metadata.reviewed_on || !ISO_INSTANT_PATTERN.test(`${metadata.reviewed_on}T00:00:00.000Z`)) throw new Error("admit requires reviewed_on=YYYY-MM-DD in admission metadata");
  const providerEvidence = existsSync(join(operationDir, "provider-evidence.json")) ? await readJson(join(operationDir, "provider-evidence.json")) : {};
  const routeId = requestRecord.route_id;
  const caseId = requestRecord.case_id;
  const servedModel = defaultGeneratedEvidence(routeId, providerEvidence);
  if (!hasExactServedModel(manifest.routes[routeId], servedModel)) {
    throw new Error("exact-model admission requires matching route identity evidence");
  }
  const assetRelative = mediaPath("video", caseId, routeId);
  const posterRelative = posterPath(caseId, routeId);
  const receiptRelative = `receipts/${caseId}--${routeId}.json`;
  const assetAbsolute = join(root, assetRelative);
  const posterAbsolute = join(root, posterRelative);
  const receiptAbsolute = join(root, receiptRelative);
  await mkdir(dirname(assetAbsolute), { recursive: true });
  await mkdir(dirname(receiptAbsolute), { recursive: true });
  const assetTemp = `${assetAbsolute}.tmp-${process.pid}`;
  const posterTemp = `${posterAbsolute}.tmp-${process.pid}`;
  await writeFile(assetTemp, rawBytes, { mode: 0o644 });
  await writeFile(posterTemp, posterBytes, { mode: 0o644 });
  await rename(assetTemp, assetAbsolute);
  await rename(posterTemp, posterAbsolute);
  const generated = {
    kind: "generated",
    served_model: servedModel,
    cost: defaultCost(routeId, providerEvidence),
    generated_at: providerEvidence.completed_at || now(),
    asset: {
      sha256: sha256(rawBytes),
      bytes: rawBytes.length,
      provenance: metadata.source_sha256
        ? { kind: "web-derivative", source_sha256: metadata.source_sha256, transform: { tool: metadata.transform_tool || "local-admission", version: metadata.transform_version || "1", arguments: Array.isArray(metadata.transform_arguments) ? metadata.transform_arguments : [] } }
        : { kind: "direct-provider-output" },
    },
    media_facts: {
      kind: "video",
      ...facts,
      poster: { sha256: sha256(posterBytes), bytes: posterBytes.length, width: Number(metadata.poster_width || facts.width), height: Number(metadata.poster_height || facts.height) },
    },
    receipt_sha256: "0".repeat(64),
    alt_text: metadata.alt_text || `${EXPECTED_MODELS[routeId].label} output for the ${manifest.cases[caseId].title.toLowerCase()} prompt.`,
    admission: {
      full_decode: { tool: metadata.decode_tool || (ffprobeFacts ? "ffprobe" : "operator-provided decode"), version: metadata.decode_version || "recorded at admission" },
      nonblank_review: { kind: "human-reviewed", reviewed_on: metadata.reviewed_on },
    },
  };
  const operationForReceipt = { operation_key: state.operation_key, request_sha256: state.request_sha256, created_at: state.created_at || now() };
  const receipt = {
    schema_version: 1,
    operation_key: operationForReceipt.operation_key,
    request_sha256: operationForReceipt.request_sha256,
    terminal_status: "succeeded",
    started_at: operationForReceipt.created_at,
    completed_at: now(),
    transport: { status_code: 200, media_content_type: "video/mp4" },
    served_model: generated.served_model,
    cost: generated.cost,
    response_media_sha256: generated.asset.sha256,
  };
  const receiptBytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  generated.receipt_sha256 = sha256(receiptBytes);
  const receiptTemp = `${receiptAbsolute}.tmp-${process.pid}`;
  await writeFile(receiptTemp, receiptBytes, { mode: 0o644 });
  await rename(receiptTemp, receiptAbsolute);
  manifest.samples[caseId][routeId].state = generated;
  const manifestTemp = `${manifestPath}.tmp-${process.pid}`;
  await writeFile(manifestTemp, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });
  await rename(manifestTemp, manifestPath);
    await updateHtmlState(caseId, routeId, root);
    const admitted = { phase: "admitted", operation_key: state.operation_key, request_sha256: state.request_sha256, case_id: caseId, route_id: routeId, public_sha256: generated.asset.sha256 };
    await atomicJson(join(operationDir, "state.json"), admitted);
    return { state: admitted, asset: assetRelative, poster: posterRelative, receipt: receiptRelative };
  } finally {
    await release();
  }
}

async function commandReserve(args) {
  const manifest = readManifest();
  const request = buildCaptureRequest(manifest, args.flags.case, args.flags.route);
  const key = operationKey(request);
  const sanitized = {
    operation_key: key,
    case_id: request.case_id,
    route_id: request.route_id,
    requested_model: request.requested_model,
    prompt_sha256: request.prompt_sha256,
    parameters: request.parameters,
  };
  process.stdout.write(`${JSON.stringify(sanitized, null, 2)}\n`);
  if (args.flags["dry-run"]) return;
  const reservation = await reserveInternal(request);
  process.stdout.write(`${reservation.existing ? "existing" : "reserved"} operation .work/operations/${reservation.key}\n`);
}

async function commandRun(args) {
  const manifest = readManifest();
  const request = buildCaptureRequest(manifest, args.flags.case, args.flags.route);
  const key = operationKey(request);
  process.stdout.write(`operation ${key}\n`);
  if (args.flags["dry-run"]) {
    process.stdout.write(`${JSON.stringify({ route: request.route_id, requested_model: request.requested_model, prompt_sha256: request.prompt_sha256, parameters: request.parameters }, null, 2)}\n`);
    return;
  }
  const reservation = await reserveInternal(request);
  const state = await submitAndDownload(request, reservation);
  process.stdout.write(`state ${state.phase}\n`);
}

async function commandImport(args) {
  const key = operationKeyFromArgument(args.flags.operation);
  if (!args.flags.file) throw new Error("import requires --file");
  const metadata = {};
  for (const keyName of ["reviewed-on", "width", "height", "duration-milliseconds", "frame-rate-millihertz", "codec", "audio", "audio-codec", "poster-width", "poster-height", "alt-text", "source-sha256", "transform-tool", "transform-version", "decode-tool", "decode-version"]) {
    if (args.flags[keyName] !== undefined) metadata[keyName.replaceAll("-", "_")] = args.flags[keyName];
  }
  if (metadata.width) metadata.width = Number(metadata.width);
  if (metadata.height) metadata.height = Number(metadata.height);
  if (metadata.duration_milliseconds) metadata.duration_milliseconds = Number(metadata.duration_milliseconds);
  if (metadata.frame_rate_millihertz) metadata.frame_rate_millihertz = Number(metadata.frame_rate_millihertz);
  const result = await importFile(operationDirectory(key), args.flags.file, args.flags.poster, metadata);
  process.stdout.write(`state ${result.phase}; imported bytes ${result.raw_sha256}\n`);
}

async function commandAdmit(args) {
  const key = operationKeyFromArgument(args.flags.operation);
  const result = await admitOperation(operationDirectory(key));
  process.stdout.write(result.asset ? `admitted ${result.asset}\n` : `admitted operation ${key}\n`);
}

async function commandReconcile(args) {
  const key = operationKeyFromArgument(args.flags.operation);
  const dir = operationDirectory(key);
  const statePath = join(dir, "state.json");
  const release = await acquireLock(dir);
  try {
    const state = await readJson(statePath);
    if (!["ambiguous", "submitting"].includes(state.phase)) throw new Error(`reconcile requires an ambiguous submission state, found ${state.phase}`);
    if (args.flags["remote-job-ref"]) {
      const next = { phase: "submitted", operation_key: state.operation_key, request_sha256: state.request_sha256, created_at: state.created_at, remote_job_ref: String(args.flags["remote-job-ref"]) };
      await atomicJson(statePath, next);
      process.stdout.write("reconciled to submitted; rerun run to poll the existing job\n");
      return;
    }
    if (!args.flags.file) throw new Error("reconcile requires --remote-job-ref or --file");
    if (state.phase === "ambiguous" || state.phase === "submitting") {
      await atomicJson(statePath, { ...state, phase: "reserved", reason: undefined });
    }
  } finally {
    await release();
  }
  const result = await importFile(dir, args.flags.file, args.flags.poster, {});
  process.stdout.write(`reconciled to ${result.phase}; admit after review\n`);
}

async function main(argv) {
  const args = parseFlagArgs(argv);
  const command = args.positional[0];
  if (!command || !["reserve", "run", "import", "admit", "reconcile"].includes(command)) {
    throw new Error("usage: node scripts/capture.mjs <reserve|run|import|admit|reconcile> [options]");
  }
  if (command === "reserve") return commandReserve(args);
  if (command === "run") return commandRun(args);
  if (command === "import") return commandImport(args);
  if (command === "admit") return commandAdmit(args);
  return commandReconcile(args);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`capture: ${error.message}\n`);
    process.exitCode = 1;
  }
}
