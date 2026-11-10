# TypeScript API and verification

The package implements the [shared abstraction specification](https://github.com/ferpasri/testar-abstraction-specs/blob/main/docs/SPEC.md) and [rule language](https://github.com/ferpasri/testar-abstraction-specs/blob/main/docs/language.md). Those documents and their conformance cases define grouping and matching behavior.

## API

| API                                                               | Purpose                                                                                                                  |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `parseAbstractionRules(text)`                                     | Validate a rule definition and return its typed representation.                                                          |
| `previewAbstraction(sources, rules, selectedRuns, progress?)`     | Compare selected evidence and return groups, explanations, widget correspondences, and unmatched observations.           |
| `buildAbstractModel(preview, sources)`                            | Verify source fingerprints and selected runs, then construct abstract states, transitions, and optional action evidence. |
| `constructAbstractModel(sources, rules, selectedRuns, progress?)` | Construct a preview and model using one evidence index.                                                                  |
| `evidenceSource(history, identity)`                               | Convert accepted TypeScript evidence into a one-time abstraction source.                                                 |
| `EvidenceInputBridge`                                             | Translate new evidence records while retaining immutable payloads and execution updates.                                 |
| `IncrementalAbstraction`                                          | Extend indexes and reuse projections between complete model snapshots.                                                   |
| `runKey(source, run)` / `referenceKey(reference)`                 | Scope identifiers to their source and supporting records.                                                                |
| `DEFAULT_PRESETS`                                                 | Ready-to-edit rule definitions for common comparisons.                                                                   |
| `INTERPRETER_VERSION`                                             | Interpretation behavior identifier included in previews.                                                                 |
| `ABSTRACTION_LIMITS` / `AbstractionLimitError`                    | Processing bounds and the error used when a bound is exceeded.                                                           |

`AnalysisSource` supplies a source identity, label, fingerprint, and `EvidenceInput`. The input uses maps named `runs`, `sequences`, `observations`, `actions`, and `executions`. Map keys are record IDs; execution keys are `execution.id`. Large indexes can use `bigint` in memory. Inputs remain caller-owned.

An `AbstractionPreview` retains the applied rules, behavior identifier, source fingerprints, and selected runs. `AbstractModel` contains nodes, edges, unmatched observations, and unlinked executions. Optional `actionEvidence` retains abstract actions, availability and execution support, ambiguity, and unmatched reasons. Type declarations expose the full returned structures.

## Numeric values

The implementation uses the evidence library's exact JSON values. Equivalent numeric forms compare equally; distinct precise decimals and ordinary objects remain distinct. Large integers can use `bigint` and exact decimal values use `JsonNumber` from `testar-evidence`. Rules and conformance inputs are parsed without rounding their numbers.

## Incremental construction

A bridge is attached to one accepted evidence history. Its input maps reuse immutable recorded observations and action descriptions; small wrappers translate run, sequence, and execution field names. Each update carries changed records and the previous source-prefix identity. The bridge identifies a prefix by the evidence collection ID, source ID, and accepted event count.

`IncrementalAbstraction.update` extends selected records and replaces updated execution statuses. New observations are indexed once. Projections and group identities are reused for unchanged records. Complete snapshots still assemble their current groups, links, support collections, and processing-budget totals. Updates must arrive in order.

Rules and optional selected runs are fixed for a computation. Observation and action changes must be reported as new evidence records. Returned snapshots retain the state at construction time and are immutable. Repeating construction without another update returns the same snapshot.

The bridge reads only newly accepted event payloads; obtaining the event list from the evidence API currently creates an outer array of event references. It retains the original widget and property objects.

## Runtime

Computation reads supplied records and makes no file or network requests. It uses URL processing, UTF-8 encoding, and Web Crypto available in the supported browser and Node.js environments. A caller can use a worker and cancel by terminating that worker. The caller's evidence reader validates concrete trace records before constructing the input maps.

## Verification

The conformance tests load published cases from `testar-abstraction-specs`, verify their digests and compatibility identifiers, and compare portable memberships and relationships. The test adapter converts generic record arrays into the maps used by this API. Source-order reversal and input-preservation checks remain part of the suite.

Local unit tests cover parser boundaries, normalization, processing limits, model provenance, and TypeScript API behavior. Batch and incremental results are also compared, including execution lifecycle changes, queued updates, exact values, and projection reuse. Shared fixtures have one owner in the specs repository; test code and API-specific boundary checks remain here.
