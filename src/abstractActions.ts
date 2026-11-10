import { canonical } from "./common.js";
import { AbstractionLimitError, ComparisonBudget } from "./budget.js";
import { projectAction } from "./actionProjection.js";
import { compare, referenceKey, type EvidenceIndex } from "./evidenceIndex.js";
import { testRunForSequence } from "./evidence-input.js";
import type {
    AbstractAction,
    AbstractActionAvailability,
    AbstractActionEvidence,
    AvailableActionReference,
} from "./abstractActionTypes.js";
import type { ExecutionReference } from "./abstractModelTypes.js";
import { ABSTRACTION_LIMITS, type ActionRules } from "./types.js";

export function buildActionEvidence(
    index: EvidenceIndex,
    nodeByObservation: Map<string, string>,
    rules: ActionRules,
    projector: typeof projectAction = projectAction,
): AbstractActionEvidence {
    const result: AbstractActionEvidence = {
        actions: [],
        unmatchedAvailableActions: [],
        unmatchedExecutions: [],
    };
    const groups = new Map<string, AbstractAction>();
    const observationsByAction = new Map<string, Set<string>>();
    const bindings = new Map<
        string,
        { group?: AbstractAction; availability: AbstractActionAvailability }
    >();
    const budget = new ComparisonBudget();
    let records = 0;
    function accountRecord(): void {
        if (++records > ABSTRACTION_LIMITS.actionRecords) {
            throw new AbstractionLimitError(
                "Action comparison exceeds 100,000 records. Select fewer runs.",
            );
        }
    }
    function groupFor(
        sourceNode: string,
        projection: ReturnType<typeof projectAction>,
    ): AbstractAction {
        const id = "action:" + canonical([sourceNode, projection.comparison]);
        let group = groups.get(id);
        if (!group) {
            group = {
                id,
                sourceNode,
                ...projection,
                availability: [],
                executions: [],
                ambiguous: false,
            };
            groups.set(id, group);
        }
        return group;
    }
    for (const { reference, observation } of index.observations.values()) {
        const sourceNode = nodeByObservation.get(referenceKey(reference))!;
        for (const available of observation.available_actions) {
            accountRecord();
            const actionReference: AvailableActionReference = {
                ...reference,
                actionDescription: available.action_description,
                targetWidget: available.target_widget,
            };
            const key = canonical(actionReference);
            if (bindings.has(key)) {
                continue;
            }
            const availability: AbstractActionAvailability = {
                reference: actionReference,
                scope: observation.available_action_scope,
                recordedExecutions: [],
            };
            let projection: ReturnType<typeof projectAction>;
            try {
                projection = projector(
                    index,
                    reference,
                    available.action_description,
                    available.target_widget,
                    rules,
                );
            } catch (error) {
                result.unmatchedAvailableActions.push({
                    reference: actionReference,
                    sourceNode,
                    reason: errorMessage(error),
                    recordedExecutions: availability.recordedExecutions,
                });
                bindings.set(key, { availability });
                continue;
            }
            budget.account(projection.comparison);
            const group = groupFor(sourceNode, projection);
            let observations = observationsByAction.get(group.id);
            if (!observations) {
                observations = new Set();
                observationsByAction.set(group.id, observations);
            }
            const observationKey = referenceKey(reference);
            if (observations.has(observationKey)) {
                group.ambiguous = true;
            }
            observations.add(observationKey);
            group.availability.push(availability);
            bindings.set(key, { group, availability });
        }
    }
    for (const { source, execution } of [...index.executions.values()].sort((left, right) =>
        compare(
            canonical([left.source.id, left.execution.execution.id]),
            canonical([right.source.id, right.execution.execution.id]),
        ),
    )) {
        accountRecord();
        const data = execution.execution;
        const run = testRunForSequence(source.evidence, data.test_sequence);
        const reference: ExecutionReference = { source: source.id, run, execution: data.id };
        const observation = { source: source.id, run, observation: data.source_observation };
        const sourceNode = nodeByObservation.get(referenceKey(observation)) ?? null;
        const availableReference: AvailableActionReference = {
            ...observation,
            actionDescription: data.action_description,
            targetWidget: data.target_widget,
        };
        const binding = bindings.get(canonical(availableReference));
        binding?.availability.recordedExecutions.push(reference);
        let projection: ReturnType<typeof projectAction> | undefined;
        let diagnostic: string | undefined;
        try {
            projection = projector(
                index,
                observation,
                data.action_description,
                data.target_widget,
                rules,
                data.parameters,
            );
        } catch (error) {
            diagnostic = errorMessage(error);
        }
        if (projection) {
            budget.account(projection.comparison);
        }
        const recordedAvailableActions = binding ? [binding.availability.reference] : [];
        if (!sourceNode || !projection) {
            result.unmatchedExecutions.push({
                reference,
                sourceNode,
                reason: !sourceNode ? "The source observation is unavailable." : diagnostic!,
                possibleActionIds: binding?.group ? [binding.group.id] : [],
                recordedAvailableActions,
            });
            continue;
        }
        const group = groupFor(sourceNode, projection);
        if (binding?.group && binding.group !== group) {
            diagnostic = "The executed values differ from the reported available-action values.";
        }
        if (group.ambiguous && binding?.group !== group) {
            result.unmatchedExecutions.push({
                reference,
                sourceNode,
                reason: "The selected fields match multiple available actions in one observation.",
                possibleActionIds: [group.id],
                recordedAvailableActions,
            });
            continue;
        }
        group.executions.push({
            reference,
            status: execution.status,
            relationship: binding ? "recorded" : "abstraction",
            recordedAvailableActions,
            ...(diagnostic ? { diagnostic } : {}),
        });
    }
    result.actions = [...groups.values()].sort((left, right) => compare(left.id, right.id));
    for (const group of result.actions) {
        group.availability.sort((left, right) =>
            compare(canonical(left.reference), canonical(right.reference)),
        );
    }
    result.unmatchedAvailableActions.sort((left, right) =>
        compare(canonical(left.reference), canonical(right.reference)),
    );
    return result;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
