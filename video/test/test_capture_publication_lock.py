"""Publication ownership cannot be revoked by age or another owner."""
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

class PublicationOwnershipTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='publication-ownership-')
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        shutil.copytree(ROOT / 'scripts', self.root / 'scripts')
        with (self.root / 'scripts/capture.mjs').open('a') as file:
            file.write('\nexport { acquirePublicationLock };\n')

    def check(self, script):
        prefix = """
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { acquirePublicationLock } from './scripts/capture.mjs';
const root = process.cwd();
const lock = root + '/.work/publication.lock';
const old = new Date(Date.now() - 120000);
"""
        run = subprocess.run(['node','--input-type=module','-e',prefix+script],cwd=self.root,
            env=dict(os.environ,CAPTURE_LOCK_STALE_MS='60000',CAPTURE_PUBLICATION_WAIT_MS='50'),
            capture_output=True,text=True,timeout=60)
        self.assertEqual(run.returncode,0,run.stdout+run.stderr)

    def test_expired_live_lock_is_not_stolen(self):
        self.check("""
const release = await acquirePublicationLock(root);
try {
  await fs.utimes(lock,old,old);
  await assert.rejects(acquirePublicationLock(root), /gallery publication is already in progress/,
    'a second publisher must not enter while the first still holds the lock');
} finally { await release(); }
const next = await acquirePublicationLock(root);
await next();
""")

    def test_expired_abandoned_lock_blocks_both_contenders(self):
        create = "await fs.writeFile(lock,'legacy abandoned lock');" if ROOT.name=='image' else "await fs.mkdir(lock); await fs.writeFile(lock+'/owner','legacy abandoned lock');"
        self.check("await fs.mkdir(root+'/.work');"+create+"""
await fs.utimes(lock,old,old);
const results = await Promise.allSettled([acquirePublicationLock(root),acquirePublicationLock(root)]);
assert.ok(results.every(result => result.status === 'rejected' && /gallery publication is already in progress/.test(result.reason.message)),
  'neither contender may reap an abandoned lock without an operator establishing quiescence');
await fs.access(lock);
""")

    def test_release_does_not_delete_replacement_owner(self):
        self.check("""
const release = await acquirePublicationLock(root);
const directory = (await fs.stat(lock)).isDirectory();
await fs.rename(lock,root+'/displaced-lock');
if (directory) await fs.mkdir(lock);
const marker = directory ? lock+'/replacement-owner' : lock;
await fs.writeFile(marker,'replacement must survive');
await release();
assert.equal(await fs.readFile(marker,'utf8'),'replacement must survive');
""")

if __name__=='__main__':
    unittest.main()
