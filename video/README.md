# Official prompt / video evidence

This repository is a small, static evidence sheet for two exact video prompts.
It compares one sample per prompt and route after private authoring:

| Prompt source | Local route | Private route |
| --- | --- | --- |
| [MiniMax video generation guide](https://platform.minimax.io/docs/guides/video-generation) | `MiniMax-H3` through loopback SGLang | `grok-imagine-video-1.5` through Sub2API |
| [xAI video generation guide](https://docs.x.ai/developers/model-capabilities/video/generation) | `MiniMax-H3` through loopback SGLang | `grok-imagine-video-1.5` through Sub2API |

The checked-in ledger currently has four `planned` cells. The public page still
shows both exact prompts, citations, provider labels, and native video controls
so the evidence boundary is visible before media is admitted. Outputs are
AI-generated, one sample per case and route, capability-aligned rather than
pixel-identical, and not a ranking.

## View and validate

The site is dependency-free. Open `index.html` locally or serve the repository
root with any static file server. No browser request is made to a provider.

```console
node scripts/validate.mjs --mode authoring
node scripts/validate.mjs --mode fixture
node scripts/validate.mjs                 # publish gate; fails while cells are planned
```

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
file before polling or admitting it. Admission atomically promotes the MP4,
poster, sanitized receipt, and generated ledger state.

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

`check.yml` is a read-only, secretless authoring check. `pages.yml` repeats the
default publish validation and uploads the repository root as a Pages artifact;
it does not build, call a provider, install packages, or require a server.
