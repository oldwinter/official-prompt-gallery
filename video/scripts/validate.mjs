import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const REQUIRED_CASES = Object.freeze([
  "minimax-official-01",
  "xai-official-01",
]);
export const REQUIRED_ROUTES = Object.freeze(["minimax-h3", "grok-video"]);
export const EXPECTED_PROMPTS = Object.freeze({
  "minimax-official-01": "A tiktok dancer is dancing on a drone, doing flips and tricks.",
  "xai-official-01": "A glowing crystal-powered rocket launching from the red dunes of Mars, ancient alien ruins lighting up in the background as it soars into a sky full of unfamiliar constellations",
});
export const EXPECTED_SOURCES = Object.freeze({
  "minimax-official-01": {
    publisher: "MiniMax",
    url: "https://platform.minimax.io/docs/guides/video-generation",
    host: "platform.minimax.io",
  },
  "xai-official-01": {
    publisher: "xAI",
    url: "https://docs.x.ai/developers/model-capabilities/video/generation",
    host: "docs.x.ai",
  },
});
export const EXPECTED_MODELS = Object.freeze({
  "minimax-h3": { provider: "MiniMax", label: "MiniMax-H3", id: "MiniMax-H3" },
  "grok-video": { provider: "xAI", label: "grok-imagine-video-1.5", id: "grok-imagine-video-1.5" },
});

const HASH_PATTERN = /^[a-f0-9]{64}$/;
const CASE_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const ISO_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const ASPECT_PATTERN = /^\d+:\d+$/;

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(path, message) {
  throw new Error(`${path}: ${message}`);
}

function exactKeys(value, expected, path) {
  if (!isRecord(value)) fail(path, "must be an object");
  const expectedSet = new Set(expected);
  for (const key of Object.keys(value)) {
    if (!expectedSet.has(key)) fail(`${path}.${key}`, "unknown field");
  }
  for (const key of expected) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) fail(`${path}.${key}`, "missing field");
    if (value[key] === null) fail(`${path}.${key}`, "null is not a valid absence marker");
  }
}

function stringValue(value, path, { nonempty = true } = {}) {
  if (typeof value !== "string" || (nonempty && value.length === 0)) fail(path, "must be a non-empty string");
  return value;
}

function integerValue(value, path, { min = Number.MIN_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < min) fail(path, `must be a safe integer >= ${min}`);
  return value;
}

function hashValue(value, path) {
  stringValue(value, path);
  if (!HASH_PATTERN.test(value)) fail(path, "must be 64 lowercase hexadecimal characters");
  return value;
}

function dateValue(value, path) {
  stringValue(value, path);
  if (!ISO_DATE_PATTERN.test(value)) fail(path, "must be YYYY-MM-DD");
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) fail(path, "is not a calendar date");
  return value;
}

function instantValue(value, path) {
  stringValue(value, path);
  if (!ISO_INSTANT_PATTERN.test(value) || Number.isNaN(new Date(value).valueOf())) fail(path, "must be a UTC RFC 3339 instant");
  return value;
}

function parsePromptCase(value, path) {
  exactKeys(value, ["title", "prompt", "source"], path);
  stringValue(value.title, `${path}.title`);
  exactKeys(value.prompt, ["text", "sha256"], `${path}.prompt`);
  stringValue(value.prompt.text, `${path}.prompt.text`);
  hashValue(value.prompt.sha256, `${path}.prompt.sha256`);
  exactKeys(value.source, ["publisher", "title", "canonical_url", "accessed_on", "location_note"], `${path}.source`);
  stringValue(value.source.publisher, `${path}.source.publisher`);
  stringValue(value.source.title, `${path}.source.title`);
  stringValue(value.source.canonical_url, `${path}.source.canonical_url`);
  dateValue(value.source.accessed_on, `${path}.source.accessed_on`);
  stringValue(value.source.location_note, `${path}.source.location_note`);
}

function parseRequestedModel(value, path) {
  exactKeys(value, ["kind", "id"], path);
  if (value.kind !== "exact-model") fail(`${path}.kind`, "must be exact-model for this video repository");
  stringValue(value.id, `${path}.id`);
}

function parseExecution(value, path) {
  if (!isRecord(value)) fail(path, "must be an object");
  stringValue(value.kind, `${path}.kind`);
  if (value.kind === "local-sglang") {
    exactKeys(value, ["kind", "api", "endpoint_scope"], path);
    if (value.api !== "openai-compatible-video") fail(`${path}.api`, "must be openai-compatible-video");
    if (value.endpoint_scope !== "loopback") fail(`${path}.endpoint_scope`, "must be loopback");
    return;
  }
  if (value.kind === "sub2api") {
    exactKeys(value, ["kind", "api"], path);
    if (value.api !== "video-generations") fail(`${path}.api`, "must be video-generations");
    return;
  }
  fail(`${path}.kind`, "must be local-sglang or sub2api");
}

function parseRoute(value, path) {
  exactKeys(value, ["label", "provider", "requested_model", "execution"], path);
  stringValue(value.label, `${path}.label`);
  stringValue(value.provider, `${path}.provider`);
  parseRequestedModel(value.requested_model, `${path}.requested_model`);
  parseExecution(value.execution, `${path}.execution`);
}

function parseSeed(value, path) {
  if (!isRecord(value)) fail(path, "must be a tagged seed variant");
  stringValue(value.kind, `${path}.kind`);
  if (value.kind === "requested") {
    exactKeys(value, ["kind", "value"], path);
    integerValue(value.value, `${path}.value`, { min: 0 });
    return;
  }
  if (value.kind === "route-does-not-accept-seed" || value.kind === "provider-assigned-not-exposed") {
    exactKeys(value, ["kind"], path);
    return;
  }
  fail(`${path}.kind`, "unknown seed variant");
}

function parseParameters(value, path) {
  exactKeys(value, ["kind", "duration_seconds", "aspect_ratio", "requested_resolution", "seed"], path);
  if (value.kind !== "video") fail(`${path}.kind`, "must be video");
  if (typeof value.duration_seconds !== "number" || !Number.isFinite(value.duration_seconds) || value.duration_seconds <= 0 || value.duration_seconds > 60) {
    fail(`${path}.duration_seconds`, "must be a finite number in (0, 60]");
  }
  stringValue(value.aspect_ratio, `${path}.aspect_ratio`);
  if (!ASPECT_PATTERN.test(value.aspect_ratio)) fail(`${path}.aspect_ratio`, "must use width:height notation");
  exactKeys(value.requested_resolution, ["kind", ...(value.requested_resolution?.kind === "short-edge-pixels" ? ["pixels"] : ["value"])], `${path}.requested_resolution`);
  if (value.requested_resolution.kind === "short-edge-pixels") {
    integerValue(value.requested_resolution.pixels, `${path}.requested_resolution.pixels`, { min: 1 });
  } else if (value.requested_resolution.kind === "provider-preset") {
    if (value.requested_resolution.value !== "480p") fail(`${path}.requested_resolution.value`, "must be 480p for the Grok route");
  } else {
    fail(`${path}.requested_resolution.kind`, "unknown video resolution variant");
  }
  parseSeed(value.seed, `${path}.seed`);
}

function parseServedModel(value, path) {
  if (!isRecord(value)) fail(path, "must be a tagged served-model variant");
  stringValue(value.kind, `${path}.kind`);
  if (value.kind === "provider-reported") {
    exactKeys(value, ["kind", "id", "receipt_field"], path);
    stringValue(value.id, `${path}.id`);
    stringValue(value.receipt_field, `${path}.receipt_field`);
    return;
  }
  if (value.kind === "operator-verified-local-deployment") {
    exactKeys(value, ["kind", "id", "evidence"], path);
    if (value.id !== "MiniMax-H3") fail(`${path}.id`, "must identify MiniMax-H3");
    stringValue(value.evidence, `${path}.evidence`);
    return;
  }
  if (value.kind === "not-exposed") {
    exactKeys(value, ["kind", "reason"], path);
    if (!["provider-response-omits-model", "route-does-not-return-served-model"].includes(value.reason)) {
      fail(`${path}.reason`, "unknown not-exposed reason");
    }
    return;
  }
  fail(`${path}.kind`, "unknown served-model variant");
}

function parseCost(value, path) {
  if (!isRecord(value)) fail(path, "must be a tagged cost variant");
  stringValue(value.kind, `${path}.kind`);
  if (value.kind === "reported") {
    exactKeys(value, ["kind", "currency", "decimal_amount"], path);
    if (value.currency !== "USD") fail(`${path}.currency`, "must be USD");
    if (!/^\d+(?:\.\d{1,8})?$/.test(value.decimal_amount)) fail(`${path}.decimal_amount`, "must be a canonical non-negative decimal");
    return;
  }
  const noValueKinds = [
    "local-compute-not-priced",
    "included-entitlement-amount-not-exposed",
    "paid-route-amount-not-exposed",
  ];
  if (noValueKinds.includes(value.kind)) {
    exactKeys(value, ["kind"], path);
    return;
  }
  fail(`${path}.kind`, "unknown cost variant");
}

function parseProvenance(value, path) {
  if (!isRecord(value)) fail(path, "must be a tagged provenance variant");
  stringValue(value.kind, `${path}.kind`);
  if (value.kind === "direct-provider-output") {
    exactKeys(value, ["kind"], path);
    return;
  }
  if (value.kind === "web-derivative") {
    exactKeys(value, ["kind", "source_sha256", "transform"], path);
    hashValue(value.source_sha256, `${path}.source_sha256`);
    exactKeys(value.transform, ["tool", "version", "arguments"], `${path}.transform`);
    stringValue(value.transform.tool, `${path}.transform.tool`);
    stringValue(value.transform.version, `${path}.transform.version`);
    if (!Array.isArray(value.transform.arguments) || value.transform.arguments.some((item) => typeof item !== "string")) {
      fail(`${path}.transform.arguments`, "must be an array of strings");
    }
    return;
  }
  fail(`${path}.kind`, "unknown provenance variant");
}

function parseAudio(value, path) {
  if (!isRecord(value)) fail(path, "must be a tagged audio variant");
  stringValue(value.kind, `${path}.kind`);
  if (value.kind === "absent") {
    exactKeys(value, ["kind"], path);
  } else if (value.kind === "present") {
    exactKeys(value, ["kind", "codec"], path);
    stringValue(value.codec, `${path}.codec`);
  } else {
    fail(`${path}.kind`, "unknown audio variant");
  }
}

function parseMediaFacts(value, path) {
  exactKeys(value, ["kind", "container", "codec", "width", "height", "duration_milliseconds", "frame_rate_millihertz", "audio", "poster"], path);
  if (value.kind !== "video") fail(`${path}.kind`, "must be video");
  if (value.container !== "mp4") fail(`${path}.container`, "must be mp4");
  stringValue(value.codec, `${path}.codec`);
  integerValue(value.width, `${path}.width`, { min: 1 });
  integerValue(value.height, `${path}.height`, { min: 1 });
  integerValue(value.duration_milliseconds, `${path}.duration_milliseconds`, { min: 1 });
  integerValue(value.frame_rate_millihertz, `${path}.frame_rate_millihertz`, { min: 1 });
  parseAudio(value.audio, `${path}.audio`);
  exactKeys(value.poster, ["sha256", "bytes", "width", "height"], `${path}.poster`);
  hashValue(value.poster.sha256, `${path}.poster.sha256`);
  integerValue(value.poster.bytes, `${path}.poster.bytes`, { min: 1 });
  integerValue(value.poster.width, `${path}.poster.width`, { min: 1 });
  integerValue(value.poster.height, `${path}.poster.height`, { min: 1 });
}

function parseAdmission(value, path) {
  exactKeys(value, ["full_decode", "nonblank_review"], path);
  exactKeys(value.full_decode, ["tool", "version"], `${path}.full_decode`);
  stringValue(value.full_decode.tool, `${path}.full_decode.tool`);
  stringValue(value.full_decode.version, `${path}.full_decode.version`);
  exactKeys(value.nonblank_review, ["kind", "reviewed_on"], `${path}.nonblank_review`);
  if (value.nonblank_review.kind !== "human-reviewed") fail(`${path}.nonblank_review.kind`, "must be human-reviewed");
  dateValue(value.nonblank_review.reviewed_on, `${path}.nonblank_review.reviewed_on`);
}

function parseGeneratedState(value, path) {
  exactKeys(value, ["kind", "served_model", "cost", "generated_at", "asset", "media_facts", "receipt_sha256", "alt_text", "admission"], path);
  if (value.kind !== "generated") fail(`${path}.kind`, "must be generated");
  parseServedModel(value.served_model, `${path}.served_model`);
  parseCost(value.cost, `${path}.cost`);
  instantValue(value.generated_at, `${path}.generated_at`);
  exactKeys(value.asset, ["sha256", "bytes", "provenance"], `${path}.asset`);
  hashValue(value.asset.sha256, `${path}.asset.sha256`);
  integerValue(value.asset.bytes, `${path}.asset.bytes`, { min: 1 });
  parseProvenance(value.asset.provenance, `${path}.asset.provenance`);
  parseMediaFacts(value.media_facts, `${path}.media_facts`);
  hashValue(value.receipt_sha256, `${path}.receipt_sha256`);
  stringValue(value.alt_text, `${path}.alt_text`);
  parseAdmission(value.admission, `${path}.admission`);
}

function parseCell(value, path) {
  exactKeys(value, ["parameters", "state"], path);
  parseParameters(value.parameters, `${path}.parameters`);
  if (!isRecord(value.state)) fail(`${path}.state`, "must be an object");
  stringValue(value.state.kind, `${path}.state.kind`);
  if (value.state.kind === "planned") {
    exactKeys(value.state, ["kind", "reason"], `${path}.state`);
    stringValue(value.state.reason, `${path}.state.reason`);
  } else if (value.state.kind === "generated") {
    parseGeneratedState(value.state, `${path}.state`);
  } else {
    fail(`${path}.state.kind`, "must be planned or generated");
  }
}

function parseDisclosure(value, path) {
  exactKeys(value, ["generated_media", "sampling", "inference", "comparability", "code_license", "prompt_rights", "media_rights"], path);
  for (const key of ["generated_media", "sampling", "inference", "comparability", "code_license", "prompt_rights", "media_rights"]) {
    stringValue(value[key], `${path}.${key}`);
  }
}

/** Parse and structurally validate the public ledger. */
export function parseManifest(raw) {
  let manifest = raw;
  if (typeof raw === "string") {
    try {
      manifest = JSON.parse(raw);
    } catch (error) {
      throw new Error(`manifest: invalid JSON (${error.message})`);
    }
  }
  exactKeys(manifest, ["schema_version", "repository", "media_kind", "cases", "routes", "samples", "disclosure"], "manifest");
  if (manifest.schema_version !== 1) fail("manifest.schema_version", "must be 1");
  if (manifest.repository !== "official-prompt-video-gallery") fail("manifest.repository", "must identify the video gallery");
  if (manifest.media_kind !== "video") fail("manifest.media_kind", "must be video");
  exactKeys(manifest.cases, REQUIRED_CASES, "manifest.cases");
  for (const caseId of REQUIRED_CASES) {
    if (!CASE_PATTERN.test(caseId)) fail(`manifest.cases.${caseId}`, "unsafe case id");
    parsePromptCase(manifest.cases[caseId], `manifest.cases.${caseId}`);
  }
  exactKeys(manifest.routes, REQUIRED_ROUTES, "manifest.routes");
  for (const routeId of REQUIRED_ROUTES) {
    if (!CASE_PATTERN.test(routeId)) fail(`manifest.routes.${routeId}`, "unsafe route id");
    parseRoute(manifest.routes[routeId], `manifest.routes.${routeId}`);
  }
  exactKeys(manifest.samples, REQUIRED_CASES, "manifest.samples");
  for (const caseId of REQUIRED_CASES) {
    exactKeys(manifest.samples[caseId], REQUIRED_ROUTES, `manifest.samples.${caseId}`);
    for (const routeId of REQUIRED_ROUTES) parseCell(manifest.samples[caseId][routeId], `manifest.samples.${caseId}.${routeId}`);
  }
  parseDisclosure(manifest.disclosure, "manifest.disclosure");
  return manifest;
}

export function expectedSampleKeys(manifest) {
  return new Set(Object.keys(manifest.cases).flatMap((caseId) => Object.keys(manifest.routes).map((routeId) => `${caseId}--${routeId}`)));
}

export function mediaPath(mediaKind, caseId, routeId) {
  if (mediaKind !== "video") throw new Error("mediaPath only supports video in this repository");
  return `media/${caseId}--${routeId}.mp4`;
}

export function posterPath(caseId, routeId) {
  return `media/${caseId}--${routeId}.poster.webp`;
}

export function receiptPath(caseId, routeId) {
  return `receipts/${caseId}--${routeId}.json`;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function readBytes(root, relativePath) {
  const absolute = resolve(root, relativePath);
  const relativePathFromRoot = relative(root, absolute);
  if (relativePathFromRoot === ".." || relativePathFromRoot.startsWith(`..${String.fromCharCode(47)}`)) {
    throw new Error(`${relativePath}: path escapes repository root`);
  }
  if (!existsSync(absolute)) throw new Error(`${relativePath}: file does not exist`);
  const info = lstatSync(absolute);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${relativePath}: must be a regular non-symlink file`);
  return readFileSync(absolute);
}

function isMp4(bytes) {
  return bytes.length >= 12 && bytes.subarray(4, 8).toString("ascii") === "ftyp";
}

function isWebp(bytes) {
  return bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP";
}

function commandAvailable(command) {
  const result = spawnSync(command, ["-version"], { stdio: "ignore", timeout: 3000 });
  return !result.error && result.status === 0;
}

function inspectWithFfprobe(absolutePath) {
  const result = spawnSync("ffprobe", [
    "-v", "error",
    "-print_format", "json",
    "-show_streams",
    "-show_format",
    absolutePath,
  ], { encoding: "utf8", timeout: 15000 });
  if (result.error || result.status !== 0) return { ok: false, reason: "ffprobe could not decode file" };
  try {
    const parsed = JSON.parse(result.stdout);
    const video = parsed.streams?.find((stream) => stream.codec_type === "video");
    if (!video) return { ok: false, reason: "ffprobe found no video stream" };
    const duration = Number(video.duration ?? parsed.format?.duration);
    const frameRate = String(video.r_frame_rate ?? "").split("/");
    const fps = frameRate.length === 2 && Number(frameRate[1]) ? Number(frameRate[0]) / Number(frameRate[1]) : Number(video.avg_frame_rate);
    return {
      ok: true,
      codec: String(video.codec_name ?? ""),
      width: Number(video.width),
      height: Number(video.height),
      durationMilliseconds: Math.round(duration * 1000),
      frameRateMillihertz: Math.round(fps * 1000),
      audioCodec: parsed.streams?.find((stream) => stream.codec_type === "audio")?.codec_name ?? null,
    };
  } catch {
    return { ok: false, reason: "ffprobe returned invalid JSON" };
  }
}

function validateReceipt(receipt, path, findings) {
  try {
    exactKeys(receipt, ["schema_version", "operation_key", "request_sha256", "terminal_status", "started_at", "completed_at", "transport", "served_model", "cost", "response_media_sha256"], path);
    if (receipt.schema_version !== 1) fail(`${path}.schema_version`, "must be 1");
    hashValue(receipt.operation_key, `${path}.operation_key`);
    hashValue(receipt.request_sha256, `${path}.request_sha256`);
    if (receipt.terminal_status !== "succeeded") fail(`${path}.terminal_status`, "must be succeeded");
    instantValue(receipt.started_at, `${path}.started_at`);
    instantValue(receipt.completed_at, `${path}.completed_at`);
    exactKeys(receipt.transport, ["status_code", "media_content_type"], `${path}.transport`);
    integerValue(receipt.transport.status_code, `${path}.transport.status_code`, { min: 200 });
    if (receipt.transport.status_code >= 300) fail(`${path}.transport.status_code`, "must be a successful status");
    stringValue(receipt.transport.media_content_type, `${path}.transport.media_content_type`);
    parseServedModel(receipt.served_model, `${path}.served_model`);
    parseCost(receipt.cost, `${path}.cost`);
    hashValue(receipt.response_media_sha256, `${path}.response_media_sha256`);
    const serialized = JSON.stringify(receipt);
    if (/["'](?:authorization|cookie|api[_-]?key|token|signed[_-]?url|download[_-]?url|job[_-]?id|remote[_-]?job)/i.test(serialized)) {
      fail(path, "contains a forbidden credential or remote-operation field");
    }
  } catch (error) {
    findings.push({ code: "receipt-shape", path, message: error.message });
  }
}

function attr(tag, name) {
  const match = tag.match(new RegExp(`${name}\\s*=\\s*["']([^"']+)["']`, "i"));
  return match?.[1] ?? "";
}

/** Validate the fixed, HTML-first publication projection. */
export function validateHtmlProjection(html, manifest) {
  const findings = [];
  if (typeof html !== "string") return [{ code: "html", path: "index.html", message: "must be UTF-8 text" }];
  const figurePattern = /<figure\b[^>]*data-case-id=["'][^"']+["'][^>]*data-route-id=["'][^"']+["'][^>]*>/gi;
  const figures = [...html.matchAll(figurePattern)].map((match) => match[0]);
  const figureKeys = figures.map((tag) => `${attr(tag, "data-case-id")}--${attr(tag, "data-route-id")}`);
  const expected = expectedSampleKeys(manifest);
  if (figures.length !== expected.size) findings.push({ code: "html-cell-count", path: "index.html", message: `expected ${expected.size} output figures, found ${figures.length}` });
  if (new Set(figureKeys).size !== figureKeys.length) findings.push({ code: "html-cell-duplicate", path: "index.html", message: "output figure keys must be unique" });
  for (const key of expected) {
    if (!figureKeys.includes(key)) findings.push({ code: "html-cell-missing", path: "index.html", message: `missing output figure ${key}` });
    const [caseId, routeId] = key.split("--");
    const media = mediaPath(manifest.media_kind, caseId, routeId);
    const poster = posterPath(caseId, routeId);
    if (!html.includes(media)) findings.push({ code: "html-media-path", path: "index.html", message: `missing ${media}` });
    if (!html.includes(poster)) findings.push({ code: "html-poster-path", path: "index.html", message: `missing ${poster}` });
    if (!html.includes(manifest.routes[routeId].label)) findings.push({ code: "html-model-label", path: "index.html", message: `missing model label ${manifest.routes[routeId].label}` });
  }
  for (const caseId of REQUIRED_CASES) {
    const prompt = manifest.cases[caseId].prompt.text;
    const source = manifest.cases[caseId].source.canonical_url;
    if (!html.includes(prompt)) findings.push({ code: "html-prompt", path: "index.html", message: `exact prompt for ${caseId} is not visible` });
    if (!html.includes(source)) findings.push({ code: "html-citation", path: "index.html", message: `citation for ${caseId} is not visible` });
    if (!html.includes(`data-case-id="${caseId}"`)) findings.push({ code: "html-case-anchor", path: "index.html", message: `case ${caseId} is not represented` });
  }
  if (!html.includes("data-video-comparison") || !html.includes("data-video-player")) findings.push({ code: "html-video-anchors", path: "index.html", message: "video comparison anchors are required" });
  if ((html.match(/<video\b[^>]*\bcontrols\b/gi) ?? []).length !== expected.size) findings.push({ code: "html-native-controls", path: "index.html", message: "each output must retain native video controls" });
  if (!html.includes("data-case-tabs") || !html.includes("data-case-tab")) findings.push({ code: "html-case-tabs", path: "index.html", message: "prompt case tabs are required" });
  const firstComparison = html.indexOf("data-video-comparison");
  const methodology = html.indexOf("id=\"methodology\"");
  if (firstComparison < 0 || methodology < 0 || methodology < firstComparison) findings.push({ code: "html-order", path: "index.html", message: "comparison must precede methodology" });
  const lower = html.toLowerCase();
  if (/<[^>]+(?:data-(?:winner|rank|score|preferred-provider)|(?:class|id|aria-label)=["'][^"']*(?:winner|ranked?|score|preferred-provider)[^"']*)[^>]*>/i.test(html)) {
    findings.push({ code: "html-ranking-markup", path: "index.html", message: "winner, rank, score, and preferred-provider markup is forbidden" });
  }
  for (const phrase of ["ai-generated", "one sample", "capability-aligned", "not a ranking", "excluded from the code license"]) {
    if (!lower.includes(phrase)) findings.push({ code: "html-disclosure", path: "index.html", message: `visible disclosure phrase missing: ${phrase}` });
  }
  if (/<script\b[^>]*\bsrc=["']https?:/i.test(html)) findings.push({ code: "html-remote-script", path: "index.html", message: "scripts must be local" });
  if (html.includes("scrollIntoView")) findings.push({ code: "html-scroll-api", path: "index.html", message: "scrollIntoView is not permitted" });
  return findings;
}

function listFiles(root, directory) {
  const absolute = join(root, directory);
  if (!existsSync(absolute)) return [];
  const entries = readdirSync(absolute, { withFileTypes: true });
  const result = [];
  for (const entry of entries) {
    const relativePath = `${directory}/${entry.name}`;
    const entryAbsolute = join(root, relativePath);
    if (entry.isDirectory()) result.push(...listFiles(root, relativePath));
    else result.push({ relativePath, absolutePath: entryAbsolute, isSymlink: entry.isSymbolicLink(), isFile: entry.isFile() });
  }
  return result;
}

function addFinding(findings, code, path, message) {
  findings.push({ code, path, message });
}

function compareFfprobe(facts, observed, path, findings) {
  if (!observed.ok) {
    addFinding(findings, "video-decode", path, observed.reason);
    return;
  }
  if (observed.width !== facts.width || observed.height !== facts.height) addFinding(findings, "video-facts", path, "recorded dimensions do not match ffprobe");
  if (Math.abs(observed.durationMilliseconds - facts.duration_milliseconds) > 100) addFinding(findings, "video-facts", path, "recorded duration does not match ffprobe");
  if (observed.frameRateMillihertz > 0 && Math.abs(observed.frameRateMillihertz - facts.frame_rate_millihertz) > 10) addFinding(findings, "video-facts", path, "recorded frame rate does not match ffprobe");
  if (facts.audio.kind === "absent" && observed.audioCodec) addFinding(findings, "video-facts", path, "recorded audio absence does not match ffprobe");
  if (facts.audio.kind === "present" && !observed.audioCodec) addFinding(findings, "video-facts", path, "recorded audio presence does not match ffprobe");
}

function validateGeneratedCell(root, caseId, routeId, state, findings, ffprobeAvailable) {
  const media = mediaPath("video", caseId, routeId);
  const poster = posterPath(caseId, routeId);
  const receipt = receiptPath(caseId, routeId);
  let mediaBytes;
  try {
    mediaBytes = readBytes(root, media);
  } catch (error) {
    addFinding(findings, "asset-missing", media, error.message);
    return;
  }
  if (mediaBytes.length >= MAX_FILE_BYTES) addFinding(findings, "asset-size", media, `must be strictly smaller than ${MAX_FILE_BYTES} bytes`);
  if (sha256(mediaBytes) !== state.asset.sha256) addFinding(findings, "asset-hash", media, "sha256 does not match manifest");
  if (mediaBytes.length !== state.asset.bytes) addFinding(findings, "asset-bytes", media, "byte count does not match manifest");
  if (!isMp4(mediaBytes)) addFinding(findings, "asset-signature", media, "does not have an MP4 ftyp signature");

  let posterBytes;
  try {
    posterBytes = readBytes(root, poster);
  } catch (error) {
    addFinding(findings, "poster-missing", poster, error.message);
  }
  if (posterBytes) {
    const posterFacts = state.media_facts.poster;
    if (!isWebp(posterBytes)) addFinding(findings, "poster-signature", poster, "does not have a WebP RIFF signature");
    if (sha256(posterBytes) !== posterFacts.sha256) addFinding(findings, "poster-hash", poster, "sha256 does not match manifest");
    if (posterBytes.length !== posterFacts.bytes) addFinding(findings, "poster-bytes", poster, "byte count does not match manifest");
    if (posterBytes.length >= MAX_FILE_BYTES) addFinding(findings, "poster-size", poster, `must be strictly smaller than ${MAX_FILE_BYTES} bytes`);
  }
  try {
    const receiptBytes = readBytes(root, receipt);
    if (sha256(receiptBytes) !== state.receipt_sha256) addFinding(findings, "receipt-hash", receipt, "sha256 does not match manifest");
    let parsed;
    try {
      parsed = JSON.parse(receiptBytes.toString("utf8"));
    } catch (error) {
      addFinding(findings, "receipt-json", receipt, `invalid JSON (${error.message})`);
    }
    if (parsed) validateReceipt(parsed, receipt, findings);
  } catch (error) {
    addFinding(findings, "receipt-missing", receipt, error.message);
  }
  if (ffprobeAvailable) compareFfprobe(state.media_facts, inspectWithFfprobe(resolve(root, media)), media, findings);
}

function validateManifestPolicy(manifest, findings) {
  for (const caseId of REQUIRED_CASES) {
    const expectedPrompt = EXPECTED_PROMPTS[caseId];
    const actualPrompt = manifest.cases[caseId].prompt;
    if (actualPrompt.text !== expectedPrompt) addFinding(findings, "prompt-text", `cases.${caseId}.prompt.text`, "does not match the exact official prompt");
    const expectedHash = sha256(Buffer.from(expectedPrompt, "utf8"));
    if (actualPrompt.sha256 !== expectedHash) addFinding(findings, "prompt-hash", `cases.${caseId}.prompt.sha256`, "does not match the exact prompt");
    const expectedSource = EXPECTED_SOURCES[caseId];
    const source = manifest.cases[caseId].source;
    if (source.publisher !== expectedSource.publisher) addFinding(findings, "citation-publisher", `cases.${caseId}.source.publisher`, `must be ${expectedSource.publisher}`);
    if (source.canonical_url !== expectedSource.url) addFinding(findings, "citation-url", `cases.${caseId}.source.canonical_url`, "must be the canonical official URL");
    try {
      const parsed = new URL(source.canonical_url);
      if (parsed.protocol !== "https:") addFinding(findings, "citation-https", `cases.${caseId}.source.canonical_url`, "must use HTTPS");
      if (parsed.hostname !== expectedSource.host) addFinding(findings, "citation-host", `cases.${caseId}.source.canonical_url`, `host must be ${expectedSource.host}`);
      if (parsed.username || parsed.password || parsed.search || parsed.hash) addFinding(findings, "citation-url", `cases.${caseId}.source.canonical_url`, "must not contain credentials, query, or fragment");
    } catch {
      addFinding(findings, "citation-url", `cases.${caseId}.source.canonical_url`, "must be a valid URL");
    }
  }
  for (const routeId of REQUIRED_ROUTES) {
    const route = manifest.routes[routeId];
    const expected = EXPECTED_MODELS[routeId];
    if (route.label !== expected.label) addFinding(findings, "route-label", `routes.${routeId}.label`, `must be ${expected.label}`);
    if (route.provider !== expected.provider) addFinding(findings, "route-provider", `routes.${routeId}.provider`, `must be ${expected.provider}`);
    if (route.requested_model.id !== expected.id) addFinding(findings, "requested-model", `routes.${routeId}.requested_model.id`, `must be ${expected.id}`);
    if (routeId === "minimax-h3" && route.execution.kind !== "local-sglang") addFinding(findings, "route-execution", `routes.${routeId}.execution`, "must be local-sglang");
    if (routeId === "grok-video" && route.execution.kind !== "sub2api") addFinding(findings, "route-execution", `routes.${routeId}.execution`, "must be sub2api");
  }
  for (const caseId of REQUIRED_CASES) {
    for (const routeId of REQUIRED_ROUTES) {
      const cell = manifest.samples[caseId][routeId];
      if (cell.parameters.duration_seconds !== 5) addFinding(findings, "parameters", `samples.${caseId}.${routeId}.parameters.duration_seconds`, "must be 5 seconds");
      if (cell.parameters.aspect_ratio !== "16:9") addFinding(findings, "parameters", `samples.${caseId}.${routeId}.parameters.aspect_ratio`, "must be 16:9");
      if (routeId === "minimax-h3" && (cell.parameters.requested_resolution.kind !== "short-edge-pixels" || cell.parameters.requested_resolution.pixels !== 768)) addFinding(findings, "parameters", `samples.${caseId}.${routeId}.parameters.requested_resolution`, "H3 must target a 768 px short edge");
      if (routeId === "grok-video" && (cell.parameters.requested_resolution.kind !== "provider-preset" || cell.parameters.requested_resolution.value !== "480p")) addFinding(findings, "parameters", `samples.${caseId}.${routeId}.parameters.requested_resolution`, "Grok must use the 480p provider preset");
    }
  }
  const requiredDisclosures = {
    generated_media: "all-cells-ai-generated",
    sampling: "one-sample-per-case-route",
    inference: "qualitative-only-no-winner",
    comparability: "capability-aligned-not-identical",
    code_license: "MIT-for-code-only",
    prompt_rights: "excluded-from-code-license",
    media_rights: "excluded-from-code-license",
  };
  for (const [key, expected] of Object.entries(requiredDisclosures)) {
    if (manifest.disclosure[key] !== expected) addFinding(findings, "disclosure", `disclosure.${key}`, `must be ${expected}`);
  }
}

/** Validate the repository tree in authoring, fixture, or publish mode. */
export async function validateRepository(root = fileURLToPath(new URL("../", import.meta.url)), mode = "publish") {
  const rootPath = root instanceof URL ? fileURLToPath(root) : resolve(String(root));
  const findings = [];
  let manifest;
  const manifestPath = join(rootPath, "data", "comparison.json");
  try {
    manifest = parseManifest(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    addFinding(findings, "manifest", "data/comparison.json", error.message);
    return { ok: false, mode, findings, planned: 0, generated: 0 };
  }
  validateManifestPolicy(manifest, findings);
  let html = "";
  try {
    html = readFileSync(join(rootPath, "index.html"), "utf8");
    findings.push(...validateHtmlProjection(html, manifest));
  } catch (error) {
    addFinding(findings, "html", "index.html", error.message);
  }

  let planned = 0;
  let generated = 0;
  const expectedMediaFiles = new Set();
  const expectedReceiptFiles = new Set();
  const ffprobeAvailable = mode === "authoring" && commandAvailable("ffprobe");
  for (const caseId of REQUIRED_CASES) {
    for (const routeId of REQUIRED_ROUTES) {
      const cell = manifest.samples[caseId][routeId];
      const media = mediaPath("video", caseId, routeId);
      const poster = posterPath(caseId, routeId);
      const receipt = receiptPath(caseId, routeId);
      if (cell.state.kind === "planned") {
        planned += 1;
        if (existsSync(join(rootPath, media)) || existsSync(join(rootPath, poster)) || existsSync(join(rootPath, receipt))) {
          addFinding(findings, "planned-files", `${caseId}--${routeId}`, "planned cells cannot have public media or receipts");
        }
      } else {
        generated += 1;
        expectedMediaFiles.add(media);
        expectedMediaFiles.add(poster);
        expectedReceiptFiles.add(receipt);
        validateGeneratedCell(rootPath, caseId, routeId, cell.state, findings, ffprobeAvailable);
      }
    }
  }
  for (const file of listFiles(rootPath, "media")) {
    if (!expectedMediaFiles.has(file.relativePath)) addFinding(findings, "unreferenced-media", file.relativePath, "file is not referenced by a generated cell");
  }
  for (const file of listFiles(rootPath, "receipts")) {
    if (!expectedReceiptFiles.has(file.relativePath)) addFinding(findings, "unreferenced-receipt", file.relativePath, "file is not referenced by a generated cell");
  }

  for (const script of ["assets/video-controls.js", "scripts/validate.mjs", "scripts/capture.mjs"]) {
    const check = spawnSync(process.execPath, ["--check", join(rootPath, script)], { encoding: "utf8" });
    if (check.status !== 0) addFinding(findings, "script-syntax", script, (check.stderr || check.stdout || "syntax check failed").trim());
  }
  if (mode === "publish" && planned > 0) addFinding(findings, "planned-cell", "data/comparison.json", `${planned} planned cell(s) remain; publish requires four generated cells`);
  if (!(["authoring", "publish", "fixture"].includes(mode))) addFinding(findings, "mode", "--mode", `unknown mode ${mode}`);
  return {
    ok: findings.length === 0,
    mode,
    findings: findings.sort((left, right) => `${left.code}\u0000${left.path}`.localeCompare(`${right.code}\u0000${right.path}`)),
    planned,
    generated,
    ffprobe_checked: ffprobeAvailable,
  };
}

function parseMode(argv) {
  const index = argv.indexOf("--mode");
  if (index === -1) return "publish";
  return argv[index + 1] || "";
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mode = parseMode(process.argv.slice(2));
  const report = await validateRepository(fileURLToPath(new URL("../", import.meta.url)), mode === "fixture" ? "authoring" : mode);
  if (mode === "fixture") process.stdout.write("fixture mode: structural authoring checks\n");
  for (const finding of report.findings) process.stdout.write(`${finding.code} ${finding.path}: ${finding.message}\n`);
  process.stdout.write(`${report.ok ? "PASS" : "FAIL"} mode=${mode} planned=${report.planned} generated=${report.generated}${report.ffprobe_checked ? " ffprobe=checked" : ""}\n`);
  process.exitCode = report.ok ? 0 : 1;
}
