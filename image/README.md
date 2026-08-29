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

All admitted media is AI-generated; the current checkout has two admitted Codex
outputs and two planned Grok cells because the configured gateway does not
expose the requested current xAI image model. The Codex image route requests the
`gpt-image-2` family through a private Codex entitlement path. The second
route requests `grok-imagine-image-2.0` through a private Sub2API endpoint.
The route records requested identity separately from served identity; the
Codex route does not expose a served snapshot, so the manifest says exactly
that rather than guessing.

No fallback Grok model was silently substituted: the available private gateway
rejected `grok-imagine-image-2.0`, so those two cells stay `planned` until an
approved route exposes the requested model.

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
