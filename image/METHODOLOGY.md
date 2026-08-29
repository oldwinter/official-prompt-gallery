# Methodology

## Prompt selection

The gallery freezes one exact example prompt from each official guide:

1. OpenAI: "A children's book drawing of a veterinarian using a stethoscope to listen to the heartbeat of a baby otter."
2. xAI: "A collage of London landmarks in a stenciled street-art style"

The canonical URLs and retrieval date are stored in `data/comparison.json` and
are repeated as visible links in each case article. The validator recomputes
the SHA-256 of each prompt so punctuation and spacing changes are visible.

## Request matrix

Each prompt is requested once through each route: the private Codex image
entitlement requesting `gpt-image-2`, and the private Sub2API route requesting
`grok-imagine-image-2.0`. Both planned requests use a 1:1 aspect ratio,
1024 × 1024 output, and medium quality where the route accepts that field.
Seed behavior is recorded as an explicit evidence variant. A route that does
not expose a served snapshot or exact cost is labelled as such; no identity or
price is inferred from the requested model name.

## What the sample means

There is one sample per prompt and route. This supports close visual
inspection, not a benchmark, ranking, or claim about general model quality.
The routes are capability-aligned rather than pixel-identical: private route
defaults, safety systems, and provider preprocessing can differ. No attempt is
made to make those differences disappear.

## Admission and derivatives

Capture state is private under ignored `.work/`. A source image is checked for
an image signature and dimensions, fully decoded with the available local image
tool when possible, and reviewed for nonblank content by a person before
admission. The browser receives a WebP derivative below GitHub Pages' 25 MiB
per-file limit. Its SHA-256, source hash, and transform arguments are recorded
in the manifest and receipt. CI checks the admitted bytes and headers offline;
it does not claim to repeat the human visual review or call a provider.

## Reproducibility boundary

`scripts/validate.mjs` is deterministic and network-free. `scripts/capture.mjs`
is an authoring tool, not part of the published runtime. Credentials,
provider responses, signed URLs, raw images, and remote job references remain
in private local state and never enter the public ledger.
