import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPOSITORY_ROOT = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const DEPLOYED_BASE_URL = new URL('https://oldwinter.github.io/official-prompt-gallery/');
const REFERENCE_PATTERN = /\b(?:href|src)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+))/gi;

function landingReferences(html) {
  const references = [];
  const seen = new Set();
  for (const match of html.matchAll(REFERENCE_PATTERN)) {
    const raw = (match[1] ?? match[2] ?? match[3] ?? '').trim();
    const reference = raw.split(/[?#]/, 1)[0];
    if (!reference || seen.has(reference)) continue;
    seen.add(reference);
    references.push({ reference, line: html.slice(0, match.index).split('\n').length });
  }
  return references;
}

function deployedSitePath(pathname) {
  const base = DEPLOYED_BASE_URL.pathname;
  if (pathname === base.slice(0, -1)) return '';
  if (pathname.startsWith(base)) return pathname.slice(base.length);
  return null;
}

async function statKind(filePath) {
  try {
    const stats = await fs.stat(filePath);
    return stats.isDirectory() ? 'directory' : 'file';
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return 'missing';
    throw error;
  }
}

export async function checkLanding(root = REPOSITORY_ROOT) {
  const errors = [];
  let html;
  try {
    html = await fs.readFile(path.join(root, 'index.html'), 'utf8');
  } catch (error) {
    return { checked: 0, errors: [{ code: 'landing', path: 'index.html', message: `cannot read the Pages landing page: ${error.message}` }] };
  }
  const references = landingReferences(html);
  let checked = 0;
  for (const { reference, line } of references) {
    const location = `index.html:${line}`;
    let url;
    try {
      url = new URL(reference, DEPLOYED_BASE_URL);
    } catch {
      errors.push({ code: 'reference', path: location, message: `${reference} cannot be resolved against ${DEPLOYED_BASE_URL}` });
      continue;
    }
    if (url.origin !== DEPLOYED_BASE_URL.origin) continue;
    checked += 1;
    const sitePath = deployedSitePath(url.pathname);
    if (sitePath === null) {
      errors.push({ code: 'reference', path: location, message: `${reference} resolves to ${url.pathname}, outside the ${DEPLOYED_BASE_URL.pathname} Pages tree` });
      continue;
    }
    let decoded;
    try {
      decoded = decodeURIComponent(sitePath);
    } catch {
      errors.push({ code: 'reference', path: location, message: `${reference} is not valid percent-encoding` });
      continue;
    }
    const resolved = path.resolve(root, decoded);
    const relative = path.relative(root, resolved);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      errors.push({ code: 'reference', path: location, message: `${reference} escapes the deployed tree` });
      continue;
    }
    const kind = await statKind(resolved);
    if (kind === 'file') continue;
    if (kind === 'missing') {
      errors.push({ code: 'missing-file', path: location, message: `${reference} does not exist in the deployed tree` });
      continue;
    }
    if (await statKind(path.join(resolved, 'index.html')) !== 'file') {
      errors.push({ code: 'missing-file', path: location, message: `${reference} is a directory without index.html` });
    }
  }
  return { checked, errors };
}

function printReport(report) {
  const status = report.errors.length ? 'FAIL' : 'PASS';
  console.log(`${status} landing page local references`);
  console.log(`references: ${report.checked} local href/src value(s)`);
  report.errors.forEach((finding) => console.log(`ERROR ${finding.code} ${finding.path}: ${finding.message}`));
  console.log(`summary: ${report.errors.length} error(s)`);
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  try {
    const report = await checkLanding();
    printReport(report);
    process.exitCode = report.errors.length ? 1 : 0;
  } catch (error) {
    console.error(`landing check error: ${error.message}`);
    process.exitCode = 1;
  }
}
