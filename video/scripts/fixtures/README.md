# Validation fixture

The fixture command is an offline structural check. The checked-in ledger may
contain admitted cells as well as planned cells, and no provider call is made:

```console
node scripts/validate.mjs --mode fixture
```

Fixture mode runs the same structural and publication-projection checks as
authoring mode while allowing planned cells. It never contacts a provider.
Once a reviewed MP4, poster, receipt, and generated state are admitted, use
`node scripts/validate.mjs --mode authoring` to inspect the files locally and
the default command as the publish gate.
