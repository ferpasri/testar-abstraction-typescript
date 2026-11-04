# TESTAR Abstraction TypeScript

TypeScript implementation of the shared TESTAR abstraction language. Apply explicit rules to reconstructed evidence and build an abstract model that retains references to its supporting records.

The package runs in a browser, a Web Worker, or Node.js. Supported build environments and the package version are recorded in [package.json](package.json). The npm package name remains `testar-abstraction`.

## Install a GitHub release

```sh
npm install github:ferpasri/testar-abstraction-typescript#RELEASE_TAG
```

Choose a tag from this repository's published releases. npm builds the tagged source through `prepare`; consumers continue to import `testar-abstraction`. Commit the consumer lockfile to retain the resolved revision.

## Build and test

```sh
npm ci
npm run build
npm run prepare:conformance
npm run check
```

`prepare:conformance` downloads the newest published specs release, including pre-releases, into an ignored `.cache/specs` directory. It records the release, archive digest, and file digests. Tests verify the prepared files and supported compatibility identifiers. Prepare again to check a newer release; tests report unsupported identifiers rather than switching to different fixtures.

The shared repository needs a published release before this download can succeed. Runtime model construction uses supplied records and does not download specifications or cases.

## Use the package

```typescript
import {
    parseAbstractionRules,
    previewAbstraction,
    buildAbstractModel,
    runKey,
    type AnalysisSource,
} from "testar-abstraction";

async function construct(sources: AnalysisSource[], rulesJson: string) {
    const selectedRuns = sources.flatMap((source) =>
        [...source.evidence.runs.keys()].map((run) => runKey(source.id, run)),
    );
    const rules = parseAbstractionRules(rulesJson);
    const preview = await previewAbstraction(sources, rules, selectedRuns);
    return { preview, model: buildAbstractModel(preview, sources) };
}
```

Supply evidence already reconstructed and validated by an evidence reader. The result retains unmatched records, execution support, observation-order links, and optional action evidence. Original evidence remains unchanged.

- [TypeScript API and verification](docs/SPEC.md)
- [Build and release preparation](docs/versioning.md)
- [TODO](TODO.md)
- [Shared specification and language](https://github.com/ferpasri/testar-abstraction-specs)
- [Shared examples](https://github.com/ferpasri/testar-abstraction-specs/blob/main/docs/examples.md)
- [Shared conformance cases](https://github.com/ferpasri/testar-abstraction-specs/tree/main/conformance)
