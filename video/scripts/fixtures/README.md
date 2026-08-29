# Validation fixture

The checked-in ledger starts with four `planned` cells, so no media bytes or
provider receipts are needed to exercise the authoring boundary:

```console
node scripts/validate.mjs --mode fixture
```

Fixture mode runs the same structural and publication-projection checks as
authoring mode while allowing planned cells. It never contacts a provider.
Once a reviewed MP4, poster, receipt, and generated state are admitted, use
`node scripts/validate.mjs --mode authoring` to inspect the files locally and
the default command as the publish gate.
