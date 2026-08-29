# Validation fixture

The fixture command is an offline structural check and can run with any mix of
admitted and planned cells without downloading new media:

```console
node scripts/validate.mjs --mode authoring
```

The authoring mode exercises the complete case/route cross-product, prompt
hashes, source allowlist, HTML projection, and script syntax while permitting
the intentionally absent image files. The default publish mode becomes a
release gate after every cell has been admitted with a sanitized receipt.
