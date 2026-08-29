# Validation fixture

The checked-in manifest starts with four `planned` cells, so it can be checked
without downloading media:

```console
node scripts/validate.mjs --mode authoring
```

The authoring mode exercises the complete case/route cross-product, prompt
hashes, source allowlist, HTML projection, and script syntax while permitting
the four intentionally absent image files. The default publish mode becomes a
release gate after `capture.mjs admit` has atomically added every image and
sanitized receipt.
