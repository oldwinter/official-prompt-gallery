import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  EXPECTED_MODELS,
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
  const resolution = params.requested_resolution.kind === "short-edge-pixels"
    ? `${params.requested_resolution.pixels}px-short-edge`
    : params.requested_resolution.value;
  return {
    model: request.requested_model,
    prompt: request.prompt,
    duration: params.duration_seconds,
    duration_seconds: params.duration_seconds,
    aspect_ratio: params.aspect_ratio,
    resolution,
  };
}

function routeBase(routeId) {
  if (routeId === "minimax-h3") return (process.env.H3_API_BASE || H3_DEFAULT_BASE).replace(/\/$/, "");
  if (routeId === "grok-video") {
    if (!process.env.GROK_BASE_URL) throw new Error("GROK_BASE_URL is required for the Grok route");
    return process.env.GROK_BASE_URL.replace(/\/$/, "");
  }
  throw new Error(`unsupported route ${routeId}`);
}

function routeHeaders(routeId, operation) {
  const headers = {
    accept: "application/json",
    "content-type": "application/json",
    "idempotency-key": operation,
  };
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
  const failed = ["failed", "error", "cancelled", "canceled", "rejected"].includes(status);
  if (failed) throw new Error("provider reported a terminal failure");
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
  const response = await fetch(url, options);
  const text = await response.text();
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
        const result = await requestJson(`${base}/v1/videos`, { method: "POST", headers: routeHeaders(routeId, operation), body: JSON.stringify(routePayload(request)) });
        return parseProviderResponse(routeId, result.body);
      },
      poll: async (request, operation, remoteJobRef) => {
        const base = routeBase(routeId);
        const result = await requestJson(`${base}/v1/videos/${encodeURIComponent(remoteJobRef)}`, { headers: { ...routeHeaders(routeId, operation), accept: "application/json" } });
        return parseProviderResponse(routeId, result.body);
      },
      contentUrl: (remoteJobRef) => `${routeBase(routeId)}/v1/videos/${encodeURIComponent(remoteJobRef)}/content`,
    };
  }
  return {
    submit: async (request, operation) => {
      const base = routeBase(routeId);
      const result = await requestJson(`${base}/v1/videos/generations`, { method: "POST", headers: routeHeaders(routeId, operation), body: JSON.stringify(routePayload(request)) });
      return parseProviderResponse(routeId, result.body);
    },
    poll: async (request, operation, remoteJobRef) => {
      const base = routeBase(routeId);
      const result = await requestJson(`${base}/v1/videos/generations/${encodeURIComponent(remoteJobRef)}`, { headers: { ...routeHeaders(routeId, operation), accept: "application/json" } });
      return parseProviderResponse(routeId, result.body);
    },
    contentUrl: () => undefined,
  };
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
  try {
    await mkdir(lock, { recursive: false, mode: 0o700 });
  } catch (error) {
    if (error.code === "EEXIST") throw new Error("operation is already being handled by another process");
    throw error;
  }
  return async () => rm(lock, { recursive: true, force: true });
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
    submitted: ["phase", "operation_key", "request_sha256", "remote_job_ref"],
    ambiguous: ["phase", "operation_key", "request_sha256", "reason"],
    downloaded: ["phase", "operation_key", "request_sha256", "raw_sha256", "file", "content_type"],
    admitted: ["phase", "operation_key", "request_sha256", "public_sha256"],
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
    if (state.phase === "ambiguous") throw new Error("operation is ambiguous; reconcile it before running again");
    const adapter = adapterFor(request.route_id);
    let result;
    let remoteJobRef = state.remote_job_ref;
    try {
      if (state.phase === "reserved") {
        result = await adapter.submit(request, key);
        if (result.remote_job_ref) remoteJobRef = result.remote_job_ref;
        if (result.phase === "pending" && !remoteJobRef) throw new Error("provider returned pending without a job reference");
        if (remoteJobRef) {
          state = { phase: "submitted", operation_key: key, request_sha256: state.request_sha256, remote_job_ref: remoteJobRef };
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
      if (state.phase === "reserved") {
        await atomicJson(join(dir, "state.json"), {
          phase: "ambiguous",
          operation_key: key,
          request_sha256: state.request_sha256,
          reason: "submission outcome could not be established; reconcile before retrying",
        });
      }
      throw error;
    }
    const mediaUrl = result.media_url || adapter.contentUrl(state.remote_job_ref);
    if (!mediaUrl) throw new Error("provider completed without a media URL");
    const parsedUrl = new URL(mediaUrl);
    if (!["http:", "https:"].includes(parsedUrl.protocol)) throw new Error("provider media URL must use HTTP or HTTPS");
    const response = await fetch(parsedUrl, { headers: request.route_id === "grok-video" ? { authorization: `Bearer ${process.env.GROK_API_KEY}` } : {} });
    if (!response.ok) throw new Error(`media download failed with status ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    const extension = (result.content_type || response.headers.get("content-type") || "video/mp4").includes("webm") ? ".webm" : ".mp4";
    const rawFile = join(dir, `raw${extension}`);
    await writeFile(rawFile, bytes, { mode: 0o600 });
    const downloaded = {
      phase: "downloaded",
      operation_key: key,
      request_sha256: state.request_sha256,
      raw_sha256: sha256(bytes),
      file: basename(rawFile),
      content_type: result.content_type || response.headers.get("content-type") || "video/mp4",
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

async function importFile(operationDir, sourcePath, posterSource, metadata) {
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

function defaultGeneratedEvidence(routeId, providerEvidence) {
  if (providerEvidence?.served_model) return providerEvidence.served_model;
  if (routeId === "minimax-h3") return { kind: "operator-verified-local-deployment", id: "MiniMax-H3", evidence: "local runtime model check" };
  return { kind: "not-exposed", reason: "provider-response-omits-model" };
}

function defaultCost(routeId, providerEvidence) {
  if (providerEvidence?.cost) return providerEvidence.cost;
  return routeId === "minimax-h3" ? { kind: "local-compute-not-priced" } : { kind: "paid-route-amount-not-exposed" };
}

/** Atomically promote a downloaded, reviewed operation into media, receipt, and the planned cell. */
export async function admitOperation(operationDirInput, repositoryRoot = REPOSITORY_ROOT) {
  const operationDir = fileURLToPathIfUrl(operationDirInput);
  const root = fileURLToPathIfUrl(repositoryRoot);
  const state = await readJson(join(operationDir, "state.json"));
  if (state.phase !== "downloaded") throw new Error(`admit requires downloaded state, found ${state.phase}`);
  const requestRecord = await readJson(join(operationDir, "request.json"));
  const manifestPath = join(root, "data", "comparison.json");
  const manifest = parseManifest(await readFile(manifestPath, "utf8"));
  ensureId(requestRecord.case_id, REQUIRED_CASES, "case");
  ensureId(requestRecord.route_id, REQUIRED_ROUTES, "route");
  if (requestRecord.prompt_sha256 !== manifest.cases[requestRecord.case_id].prompt.sha256) throw new Error("operation prompt digest does not match the current manifest");
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
    served_model: defaultGeneratedEvidence(routeId, providerEvidence),
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
  const operationForReceipt = { operation_key: state.operation_key, request_sha256: state.request_sha256, created_at: now() };
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
  const admitted = { phase: "admitted", operation_key: state.operation_key, request_sha256: state.request_sha256, public_sha256: generated.asset.sha256 };
  await atomicJson(join(operationDir, "state.json"), admitted);
  return { state: admitted, asset: assetRelative, poster: posterRelative, receipt: receiptRelative };
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
  process.stdout.write(`admitted ${result.asset}\n`);
}

async function commandReconcile(args) {
  const key = operationKeyFromArgument(args.flags.operation);
  const dir = operationDirectory(key);
  const statePath = join(dir, "state.json");
  const state = await readJson(statePath);
  if (state.phase !== "ambiguous") throw new Error(`reconcile requires ambiguous state, found ${state.phase}`);
  if (args.flags["remote-job-ref"]) {
    const next = { phase: "submitted", operation_key: state.operation_key, request_sha256: state.request_sha256, remote_job_ref: String(args.flags["remote-job-ref"]) };
    await atomicJson(statePath, next);
    process.stdout.write("reconciled to submitted; rerun run to poll the existing job\n");
    return;
  }
  if (args.flags.file) {
    const result = await importFile(dir, args.flags.file, args.flags.poster, {});
    process.stdout.write(`reconciled to ${result.phase}; admit after review\n`);
    return;
  }
  throw new Error("reconcile requires --remote-job-ref or --file");
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
