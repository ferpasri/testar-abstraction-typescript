# Compatibility and releases

The package version and supported Node.js environment are recorded in [package.json](../package.json). The shared [compatibility identifiers](https://github.com/ferpasri/testar-abstraction-specs/blob/main/docs/versioning.md) describe evidence inputs, rule definitions, interpretation behavior, and fixture structure.

Tests compare the downloaded specs manifest with [compatibility.json](../compatibility.json) and `INTERPRETER_VERSION` in [src/types.ts](../src/types.ts). Preparation records the selected specs release and archive digest under `.cache/specs`; this generated data is excluded from commits and published packages.

## Prepare a release

```sh
npm ci
npm run prepare:conformance
npm run check
npm run build
npm pack --dry-run
```

Before publishing, verify that the package version, root lockfile version, and Git tag agree, including any pre-release suffix. Keep published tags unchanged. Consumers install a tag from `testar-abstraction-typescript`; the package name and imports remain `testar-abstraction`.

The package's `prepare` script builds JavaScript and declarations. It does not download conformance data. Tests and their case preparation are development checks, separate from runtime use or installation by a dashboard.
