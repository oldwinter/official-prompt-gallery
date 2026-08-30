# Official Prompt Image Gallery

This repository is a static evidence sheet for two image prompts copied from
official OpenAI and xAI guides. Open `index.html` locally or visit the GitHub
Pages site after deployment. The first screen contains the first prompt, its
source citation, and the two route cells; JavaScript only adds tabs and an
image focus dialog.

The comparison is deliberately small and honest:

- four cells: two exact prompts crossed with two private routes;
- one sample per case and route, for qualitative inspection only;
- capability-aligned requests, not pixel-identical conditions;
- no winner, score, rank, or recommendation.

All admitted media is AI-generated; the current checkout has four admitted
cells. The Codex image route requests the `gpt-image-2` family through a
private Codex entitlement path. The second route requests
`grok-imagine-image-2.0`; those two cells were completed with Grok CLI
`/imagine` (`image_gen`) and admitted through the same capture flow. The route
records requested identity separately from served identity; neither route
exposes a served snapshot, so the manifest says exactly that rather than
guessing.

## Validate

There is no package manager, build step, server, or generation call in CI.
Node's built-in APIs are enough:

```console
node scripts/validate.mjs --mode authoring
node scripts/validate.mjs
```

Authoring mode permits planned cells. The default publish
mode is the release gate and requires all four admitted images and sanitized
receipts below 25 MiB.

## Private capture flow

Credentials are read from the process environment only. They are never put in
arguments, receipts, or public files. The Codex route is operator-mediated:

```console
node scripts/capture.mjs reserve --case openai-official-01 --route codex-image
node scripts/capture.mjs import --operation .work/operations/OPERATION_KEY --file /private/result.png
node scripts/capture.mjs admit --operation .work/operations/OPERATION_KEY --reviewed-on 2026-08-30
```

The Grok route supports the same resumable `reserve` and `run` commands with
`GROK_BASE_URL` and `GROK_API_KEY`. Use `--dry-run` to inspect the sanitized
request shape without writing state or contacting a provider. An ambiguous
submission is held until `reconcile`; rerunning never silently authorizes a
second paid request.

## Provenance and licensing

The prompt cases cite the [OpenAI image generation guide](https://developers.openai.com/api/docs/guides/image-generation)
and the [xAI image generation guide](https://docs.x.ai/developers/model-capabilities/images/generation),
retrieved on 2026-08-30. Prompt text remains attributed to those publishers.
The repository's MIT license covers the code and documentation only. It does
not grant rights to official prompt text or provider-generated media; those
remain subject to the relevant source and provider terms. See
[`METHODOLOGY.md`](METHODOLOGY.md) and [`DATA_NOTICE.md`](DATA_NOTICE.md).

## GitHub Pages

The public site deploys as a static GitHub Pages tree from the repository root.
`pages.yml` uploads that tree without a build, provider call, or server. Run the
default validator locally as the strict four-cell publish gate.

This image gallery does not maintain a duplicate hosting policy. Free-hosting
growth for both public galleries is governed by the canonical
[hosting policy](https://github.com/oldwinter/official-prompt-video-gallery/blob/main/docs/hosting-policy.md)
in the sibling video repository:

`https://github.com/oldwinter/official-prompt-video-gallery/blob/main/docs/hosting-policy.md`

Admitted images remain on GitHub Pages. Originals are not moved to GitHub
Releases or Cloudflare R2 until a threshold in that policy is actually reached.
