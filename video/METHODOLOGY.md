# Methodology

## Prompt selection

The two cases preserve the exact example wording from the linked official
guides. Punctuation and capitalization are part of the prompt record, and each
prompt has a SHA-256 digest in `data/comparison.json` so accidental edits fail
validation. The source URL, publisher, retrieval date, and location note stay
next to the text.

## Routes and requested capability

Both cases are sent to the same two route identities:

- `MiniMax-H3` on a local OpenAI-compatible SGLang video endpoint. The request
  targets a 768 px short edge and records local compute as unpriced.
- `grok-imagine-video-1.5` through a private Sub2API video-generation route.
  The request uses the provider's 480p preset; paid-route amount and provider
  assigned seed are recorded only when exposed.

Both routes request 5 seconds and a 16:9 aspect ratio. The resolution profiles,
serving infrastructure, codecs, and response metadata can differ. This is a
capability-aligned comparison, not a pixel-identical or frame-matched test.

## Sampling and interpretation

There is one sample for each of the two prompts on each route: four cells in
total. A single sample is useful for direct inspection of a route's output, but
it cannot support a quality score, a winner, a rank, or a general claim about a
model. The page therefore uses qualitative language only and exposes run facts
without a preference marker.

## Admission and derivatives

Generation occurs outside GitHub Pages. A private operation is reserved before
transport, and an ambiguous submission is never retried automatically. A
reviewed MP4 and WebP poster are imported into the ignored work area, decoded,
hashed, and promoted with per-file atomic writes. If a browser derivative is used to stay below
the 25 MiB per-file admission guard, the manifest records the source digest and the
transform tool/version/arguments. That 25 MiB guard is the local hard limit
aligned with GitHub's documented browser-upload cap; GitHub Pages itself
publishes a 1 GB site cap and a 100 GB/month soft bandwidth cap, not a separate
per-file Pages byte limit. See [docs/hosting-policy.md](docs/hosting-policy.md)
for measured sizes, documented GitHub and Cloudflare limits, local review
thresholds, and the no-migration-before-threshold rule that also binds the
sibling image gallery. After merge, the image repository must cite
`https://github.com/oldwinter/official-prompt-video-gallery/blob/main/docs/hosting-policy.md`.
Public receipts contain only an allowlisted transport status, evidence
variants, timestamps, and hashes.

Full decode and a nonblank human review are authoring evidence. CI independently
checks the checked-in bytes, signatures, sizes, hashes, and recorded facts; it
does not claim to have repeated a paid generation or the human visual review.

## Validation boundary

`scripts/validate.mjs` is dependency-free and offline. It enforces the literal
two-case/two-route contract, nested cross-product, canonical citations, tagged
absence variants, derived paths, HTML projection, no-ranking policy, script
syntax, and the strict per-file 25 MiB limit. Authoring mode permits planned
cells. The default publish mode fails until all four cells are generated and
their media and receipts are present.
