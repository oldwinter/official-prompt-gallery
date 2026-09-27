# Landing check fixture

Offline regression fixture for `../check-landing.mjs`. It builds a scratch
deployed tree under the OS temp directory and exercises URL resolution against
the `https://oldwinter.github.io/official-prompt-gallery/` Pages base,
including root-absolute, project-prefixed, and off-origin references:

```console
node scripts/fixtures/smoke.mjs
```
