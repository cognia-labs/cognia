# GitHub Delivery bundle

`github-delivery-3.0.0.zip` is generated from the maintained source at
`plugins/github-delivery/src/index.ts`. Regenerate and verify source parity with:

```bash
pnpm exec tsx scripts/plugin/build-github-delivery.ts
pnpm exec tsx scripts/plugin/build-github-delivery.ts --check
```

The release pipeline signs the generated ZIP with the official key; the
private signing key is not stored in this repository.
