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
    constructAbstractModel,
    runKey,
    type AnalysisSource,
    type AbstractionRules,
} from "testar-abstraction";

async function construct(sources: AnalysisSource[], rules: AbstractionRules) {
    const selectedRuns = sources.flatMap((source) =>
        [...source.evidence.runs.keys()].map((run) => runKey(source.id, run)),
    );
    return constructAbstractModel(sources, rules, selectedRuns);
}
```

### Use evidence recorded by the TypeScript library

```typescript
import { EvidenceInputBridge, IncrementalAbstraction } from "testar-abstraction";

// history is the evidence writer's .evidence, or a ReconstructedEvidence instance.
const bridge = new EvidenceInputBridge(history, { id: "trace-1", label: "My trace" });
const abstraction = new IncrementalAbstraction(rules);
abstraction.update(bridge.update());
const { preview, model } = await abstraction.construct();

// After more events have been accepted, repeat update and request a new snapshot.
abstraction.update(bridge.update());
const next = await abstraction.construct();
```

The bridge translates record names and retains the original immutable widget and property payloads. Updates process newly accepted events, including changes to existing action execution results. Treat the bridge's input views as read-only and apply its updates in order.

Incremental construction reuses evidence indexes, state projections, action projections, and comparison identities. It returns an immutable preview and model snapshot when requested. Calling `construct()` without another update returns the existing snapshot. Create a new computation when changing rules or selected runs.

### Compare update performance

```sh
npm run benchmark:updates -- --observations 100 --widgets 30
```

This benchmark measures conversion and model construction from identical in-memory records, comparing a full rebuild after each observation with incremental updates. It verifies that both approaches produce the same final model.

Supply evidence already reconstructed and validated by an evidence reader. The result retains unmatched records, execution support, observation-order links, and optional action evidence. Original evidence remains unchanged.

- [TypeScript API and verification](docs/SPEC.md)
- [Build and release preparation](docs/versioning.md)
- [TODO](TODO.md)
- [Shared specification and language](https://github.com/ferpasri/testar-abstraction-specs)
- [Shared examples](https://github.com/ferpasri/testar-abstraction-specs/blob/main/docs/examples.md)
- [Shared conformance cases](https://github.com/ferpasri/testar-abstraction-specs/tree/main/conformance)
