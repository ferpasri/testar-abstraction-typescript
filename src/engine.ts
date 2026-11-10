import { canonical } from "./common.js";
import { ComparisonBudget, AbstractionLimitError } from "./budget.js";
import { validateAbstractionRules } from "./abstraction-rules.js";
import { buildEvidenceIndex, compare, referenceKey, runKey } from "./evidenceIndex.js";
import { ProjectionCache } from "./projectionCache.js";
import type { EvidenceIndex } from "./evidenceIndex.js";
import { compareIndex } from "./evidence-input.js";
import {
    INTERPRETER_VERSION,
    type AnalysisSource,
    type AbstractionRules,
    type ObservationGroup,
    type AbstractionPreview,
    type AbstractionProgress,
    type ProjectedWidget,
    type WidgetCorrespondence,
} from "./types.js";

interface GroupBuilder {
    comparison: unknown;
    members: ObservationGroup["members"];
    widgetBuckets: Map<string, { description: unknown; members: ProjectedWidget["reference"][] }>;
}

export async function previewAbstraction(
    sources: AnalysisSource[],
    requestedDefinition: AbstractionRules,
    selectedRuns: string[],
    report: (progress: AbstractionProgress) => void = () => {},
): Promise<AbstractionPreview> {
    const definition = validateAbstractionRules(requestedDefinition);
    report({ stage: "Indexing selected evidence", completed: 0, total: sources.length });
    return previewIndexedEvidence(
        buildEvidenceIndex(sources, selectedRuns),
        new ProjectionCache(definition),
        report,
    );
}

export async function previewIndexedEvidence(
    index: EvidenceIndex,
    cache: ProjectionCache,
    report: (progress: AbstractionProgress) => void = () => {},
): Promise<AbstractionPreview> {
    const definition = cache.definition;
    const policyFingerprint = await cache.policyFingerprint();
    const builders = new Map<string, GroupBuilder>();
    const unmatched: AbstractionPreview["unmatched"] = [];
    const budget = new ComparisonBudget();
    let completed = 0;
    const observations = [...index.observations.values()].sort(
        (left, right) =>
            compare(
                index.sources.get(left.source.id)!.fingerprint,
                index.sources.get(right.source.id)!.fingerprint,
            ) ||
            compare(left.observation.test_sequence, right.observation.test_sequence) ||
            compareIndex(left.observation.observation_index, right.observation.observation_index) ||
            compare(left.observation.id, right.observation.id),
    );
    for (const indexed of observations) {
        let projected: ReturnType<ProjectionCache["observation"]>;
        try {
            projected = cache.observation(indexed, budget);
        } catch (error) {
            if (error instanceof AbstractionLimitError) {
                throw error;
            }
            unmatched.push({
                reference: indexed.reference,
                observationIndex: indexed.observation.observation_index,
                reason:
                    error instanceof Error ? error.message : "The observation cannot be compared.",
            });
            completed++;
            report({ stage: "Comparing observations", completed, total: index.observations.size });
            continue;
        }
        const { projection, comparisonKey: encoded } = projected;
        let builder = builders.get(encoded);
        if (!builder) {
            builder = { comparison: projection.comparison, members: [], widgetBuckets: new Map() };
            builders.set(encoded, builder);
        }
        builder.members.push(projection.member);
        collectWidgets(builder, projection.widgets);
        completed++;
        if (completed % 25 === 0 || completed === index.observations.size) {
            report({ stage: "Comparing observations", completed, total: index.observations.size });
        }
    }
    const entries = [...builders.entries()];
    const groups: ObservationGroup[] = [];
    for (let start = 0; start < entries.length; start += 128) {
        groups.push(
            ...(await Promise.all(
                entries.slice(start, start + 128).map(async ([comparison, builder]) => {
                    const id = await cache.groupId(comparison);
                    return {
                        id,
                        comparison: builder.comparison,
                        members: builder.members,
                        widgetCorrespondences: correspondences(id, builder),
                    };
                }),
            )),
        );
    }
    groups.sort((left, right) => compare(left.id, right.id));
    report({ stage: "Matching preview ready", completed, total: index.observations.size });
    return {
        definition,
        policyFingerprint,
        interpreterVersion: INTERPRETER_VERSION,
        inputScope: {
            sources: [...index.sources.values()]
                .sort((a, b) => compare(a.fingerprint, b.fingerprint))
                .map((source) => ({
                    id: source.id,
                    label: source.label,
                    fingerprint: source.fingerprint,
                })),
            runs: [...index.runs.values()]
                .sort(
                    (a, b) =>
                        compare(
                            index.sources.get(a.source.id)!.fingerprint,
                            index.sources.get(b.source.id)!.fingerprint,
                        ) || compare(a.run.id, b.run.id),
                )
                .map(({ source, run }) => ({
                    source: source.id,
                    run: run.id,
                })),
        },
        index: index.counts,
        groups,
        unmatched,
        counts: {
            observations: index.observations.size,
            groups: groups.length,
            sharedGroups: groups.filter(
                (group) =>
                    new Set(
                        group.members.map((member) =>
                            runKey(member.reference.source, member.reference.run),
                        ),
                    ).size > 1,
            ).length,
            unmatched: unmatched.length,
        },
    };
}

function collectWidgets(builder: GroupBuilder, widgets: ProjectedWidget[]): void {
    for (const widget of widgets) {
        if (!widget.informative) {
            continue;
        }
        const key = canonical(widget.description);
        let bucket = builder.widgetBuckets.get(key);
        if (!bucket) {
            bucket = { description: widget.description, members: [] };
            builder.widgetBuckets.set(key, bucket);
        }
        bucket.members.push(widget.reference);
    }
}

function correspondences(group: string, builder: GroupBuilder): WidgetCorrespondence[] {
    return [...builder.widgetBuckets.entries()]
        .sort(([left], [right]) => compare(left, right))
        .map(([, bucket], index) => {
            const observations = new Set<string>();
            let ambiguous = false;
            for (const member of bucket.members) {
                const { widget: _widget, ...observation } = member;
                const key = referenceKey(observation);
                if (observations.has(key)) {
                    ambiguous = true;
                }
                observations.add(key);
            }
            return {
                id: group + ":widget:" + index,
                description: bucket.description,
                members: bucket.members,
                ambiguous,
            };
        });
}
