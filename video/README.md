# Official prompt / video evidence

This repository is a small, static evidence sheet for two exact video prompts.
It compares one sample per prompt and route after private authoring:

| Prompt source | Local route | Private route |
| --- | --- | --- |
| [MiniMax video generation guide](https://platform.minimax.io/docs/guides/video-generation) | `MiniMax-H3` through loopback SGLang | `grok-imagine-video-1.5` through Sub2API |
| [xAI video generation guide](https://docs.x.ai/developers/model-capabilities/video/generation) | `MiniMax-H3` through loopback SGLang | `grok-imagine-video-1.5` through Sub2API |

The checked-in ledger has two admitted H3 cells and two `planned` Grok cells.
The public page shows both exact prompts, citations, provider labels, and native
video controls so the evidence boundary is visible before every media route is
admitted. Outputs are
AI-generated, one sample per case and route, capability-aligned rather than
pixel-identical, and not a ranking.

No fallback Grok model is presented as Video 1.5. One private model catalog
listed the exact ID but did not expose a video-operation contract. The route
that produced earlier candidate videos neither listed the exact ID in its
catalog nor returned served-model identity. Those candidates therefore remain
unadmitted, and the cells stay `planned` until one approved execution route
supplies exact-model capability evidence.

## View and validate

The site is dependency-free. Serve the repository root over HTTP. Opening
`index.html` as a `file://` URL cannot load `assets/video-controls.js` as an ES
module, so mute/play controls never attach. No browser request is made to a
provider.

The checked-in evidence source is [`data/comparison.json`](data/comparison.json).
The HTML is a projection of that ledger.

```console
python3 -m http.server 8765 --bind 127.0.0.1
# then open http://127.0.0.1:8765/
```

```console
node scripts/validate.mjs --mode authoring
node scripts/validate.mjs --mode fixture
node scripts/validate.mjs                 # publish gate; fails while cells are planned
```

This checkout still has planned Grok cells, so the default publish command
fails. Use `--mode authoring` until all four cells are admitted.

Authoring mode validates the complete two-by-two plan and every admitted file.
Fixture mode is an offline structural check for a planned checkout. Publish
mode requires all four generated cells, hashes, receipts, media signatures,
and disclosures.

## Private capture flow

Credentials are read only from the process environment or an approved private
secret source. They are never command-line arguments, receipts, logs, or
committed files. Operation state is ignored under `.work/operations/` and is
keyed by the canonical request fields, so rerunning a command resumes the same
operation.

`node scripts/capture.mjs --help` lists reserve, run, import, admit, and reconcile.

```console
node scripts/capture.mjs reserve --case minimax-official-01 --route minimax-h3 --dry-run
node scripts/capture.mjs run --case minimax-official-01 --route grok-video --dry-run
node scripts/capture.mjs run --case minimax-official-01 --route grok-video
node scripts/capture.mjs import --operation .work/operations/OPERATION_KEY --file /private/reviewed.mp4 --poster /private/reviewed.webp --reviewed-on 2026-08-30
node scripts/capture.mjs admit --operation .work/operations/OPERATION_KEY
```

`run` is the only command that contacts a provider. It is intentionally not
used by CI. If a submission result is unknowable, the operation becomes
`ambiguous`; use `reconcile` with a recovered remote job reference or local
file before polling or admitting it. Admission uses per-file atomic writes for
the MP4, poster, sanitized receipt, and generated ledger state; the validator
is the consistency check after an interrupted admission.

## Model and rights boundary

The requested model belongs to the route. A served model is recorded only when
the provider reports it or the local deployment check attests it. Cost and seed
absence use explicit tagged variants; no `null` value means unavailable. The
MiniMax-H3 route is a local deployment and its license notice is maintained by
the model publisher; review the [MiniMax-H3 model card and license](https://huggingface.co/MiniMaxAI/MiniMax-H3)
before reuse. This repository does not include model weights. Prompts,
source pages, and generated provider media are not covered by the MIT code
license. See [METHODOLOGY.md](METHODOLOGY.md) and [DATA_NOTICE.md](DATA_NOTICE.md).

## GitHub Pages

`check.yml` is a read-only, secretless authoring check. `pages.yml` validates the
same static tree while allowing clearly marked planned cells, then uploads the
repository root as a Pages artifact; it does not build, call a provider, install
packages, or require a server. Run the default validator locally as the strict
four-cell publish gate.

Free-hosting growth for this gallery and the sibling image gallery is governed
by the canonical [hosting policy](docs/hosting-policy.md). After that document
is merged to `main`, [official-prompt-image-gallery](https://github.com/oldwinter/official-prompt-image-gallery)
must point to the same policy URL:

`https://github.com/oldwinter/official-prompt-video-gallery/blob/main/docs/hosting-policy.md`

No originals are moved to GitHub Releases or Cloudflare R2 until a threshold in
that policy is actually reached.
