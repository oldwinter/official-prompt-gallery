# Contributing

This repository is a static evidence sheet. The ledger is `data/comparison.json`. Do not admit media or receipts without a reviewed private capture.

## Checks

```bash
node --check assets/video-controls.js
node --check scripts/validate.mjs
node --check scripts/capture.mjs
node scripts/validate.mjs --mode authoring
node scripts/validate.mjs --mode fixture
node scripts/fixtures/smoke.mjs
python3 -m unittest discover -s test -p 'test_*.py' -v
```

`node scripts/validate.mjs` with no `--mode` is the publish gate. It is expected to fail while Grok cells stay `planned`. Use authoring mode for local work.

`node scripts/capture.mjs --help` lists private capture commands. `run` contacts a provider and is not for CI.

## Preview

Serve the repo root over HTTP (`python3 -m http.server 8765 --bind 127.0.0.1`). Do not rely on `file://`.
