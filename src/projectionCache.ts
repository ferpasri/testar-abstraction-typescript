import { immutableCopy } from "./immutable.js";
import type { ActionDescription, Observation, Widget } from "./evidence-input.js";
import { canonical, digest } from "./common.js";
import { ComparisonBudget } from "./budget.js";
import { projectObservation } from "./projection.js";
import { projectAction } from "./actionProjection.js";
import { referenceKey, type IndexedObservation } from "./evidenceIndex.js";
import type { AbstractionRules, ObservationProjection } from "./types.js";

type Result<T> = { value: T; error?: never } | { value?: never; error: unknown };
interface CachedObservation {
    record: Observation;
    bytes: number;
    result: Result<{ projection: ObservationProjection; comparisonKey: string }>;
}
interface CachedAction {
    description: ActionDescription | undefined;
    widget: Widget | undefined;
    available?: Result<ReturnType<typeof projectAction>>;
    executed: WeakMap<Record<string, unknown>, Result<ReturnType<typeof projectAction>>>;
}

function resolve<T>(result: Result<T>): T {
    if ("error" in result) {
        throw result.error;
    }
    return result.value;
}

/** Cache rule-dependent work for accepted records; execution status changes do not change state projections. */
export class ProjectionCache {
    readonly definition: AbstractionRules;
    #observations = new Map<string, CachedObservation>();
    #actions = new Map<string, CachedAction>();
    #policyFingerprint?: Promise<string>;
    #groupIds = new Map<string, Promise<string>>();

    constructor(definition: AbstractionRules) {
        this.definition = immutableCopy(definition);
    }

    policyFingerprint(): Promise<string> {
        return (this.#policyFingerprint ??= digest(
            new TextEncoder().encode(canonical(this.definition)),
        ));
    }

    groupId(comparison: string): Promise<string> {
        let id = this.#groupIds.get(comparison);
        if (!id) {
            id = this.policyFingerprint().then((policy) =>
                digest(new TextEncoder().encode(canonical([policy, comparison]))),
            );
            this.#groupIds.set(comparison, id);
        }
        return id;
    }

    observation(indexed: IndexedObservation, budget: ComparisonBudget) {
        const key = referenceKey(indexed.reference);
        let cached = this.#observations.get(key);
        if (!cached || cached.record !== indexed.observation) {
            const measured = new ComparisonBudget();
            let result: CachedObservation["result"];
            try {
                const projection = projectObservation(indexed, this.definition, (value) =>
                    measured.account(value),
                );
                if (!projection.informative) {
                    throw new Error("None of the selected fields has a captured value.");
                }
                measured.account(projection.comparison);
                result = {
                    value: {
                        projection: immutableCopy(projection),
                        comparisonKey: canonical(projection.comparison),
                    },
                };
            } catch (error) {
                result = { error };
            }
            cached = { record: indexed.observation, bytes: measured.usedBytes, result };
            this.#observations.set(key, cached);
        }
        budget.addBytes(cached.bytes);
        return resolve(cached.result);
    }

    action: typeof projectAction = (
        index,
        observation,
        descriptionId,
        targetId,
        rules,
        parameters,
    ) => {
        const key = canonical([referenceKey(observation), descriptionId, targetId]);
        const description = index.actions.get(
            canonical([observation.source, descriptionId]),
        )?.action;
        const widget =
            targetId === null
                ? undefined
                : index.widgets.get(referenceKey({ ...observation, widget: targetId }))?.widget;
        let cached = this.#actions.get(key);
        if (!cached || cached.description !== description || cached.widget !== widget) {
            cached = { description, widget, executed: new WeakMap() };
            this.#actions.set(key, cached);
        }
        let result = parameters === undefined ? cached.available : cached.executed.get(parameters);
        if (!result) {
            try {
                result = {
                    value: immutableCopy(
                        projectAction(
                            index,
                            observation,
                            descriptionId,
                            targetId,
                            rules,
                            parameters,
                        ),
                    ),
                };
            } catch (error) {
                result = { error };
            }
            if (parameters === undefined) {
                cached.available = result;
            } else {
                cached.executed.set(parameters, result);
            }
        }
        return resolve(result);
    };
}
