# Official Prompt Gallery

Static, source-cited evidence sheets that run prompts copied from official
provider guides across private generation routes, one sample per cell, with no
winner, score, or rank.

| Gallery | Directory | Site |
| --- | --- | --- |
| Image | [`image/`](image/) | <https://oldwinter.github.io/official-prompt-gallery/image/> |
| Video | [`video/`](video/) | <https://oldwinter.github.io/official-prompt-gallery/video/> |

Each gallery is self-contained: its own `index.html`, `data/comparison.json`
evidence manifest, `receipts/`, `media/`, and `scripts/` (capture, validate,
smoke fixture). Run commands from inside the gallery directory:

```bash
cd image   # or video
node scripts/validate.mjs --mode authoring
node scripts/fixtures/smoke.mjs
```

Both galleries share one [hosting policy](docs/hosting-policy.md) and deploy
together as one GitHub Pages tree (`.github/workflows/pages.yml`);
`.github/workflows/check.yml` validates both on every push and pull request.

## History

The galleries were separate repositories until 2026-09-25:
`oldwinter/official-prompt-image-gallery` and
`oldwinter/official-prompt-video-gallery`. Their full histories were merged here
under `image/` and `video/`; their unmerged branches are kept as
`image/<branch>` and `video/<branch>`, and their open issues and pull requests
moved here. The old Pages URLs redirect to the new ones.

MIT licensed; see [LICENSE](LICENSE). Generated media is AI-generated; see each
gallery's `DATA_NOTICE.md`.
