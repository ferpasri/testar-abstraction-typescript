import type { projectAction } from "./actionProjection.js";
import type { AbstractAction } from "./abstractActionTypes.js";
import { buildActionEvidence } from "./abstractActions.js";
import { testRunForSequence } from "./evidence-input.js";
import { canonical } from "./common.js";
import type { Observation, RecordedExecution } from "./evidence-input.js";
import { orderLinks } from "./observation-order.js";
import {
    buildEvidenceIndex,
    compare,
    referenceKey,
    runKey,
    type EvidenceIndex,
} from "./evidenceIndex.js";
import { edgeLabel, groupLabel } from "./abstractModelLabels.js";
import type {
    AbstractModelEdge,
    AbstractModel,
    AbstractModelNode,
    ExecutionReference,
    UnlinkedExecution,
} from "./abstractModelTypes.js";
import type { AnalysisSource, EvidenceReference, AbstractionPreview } from "./types.js";

export function buildAbstractModel(
    preview: AbstractionPreview,
    sources: AnalysisSource[],
): AbstractModel {
    return buildModelFromIndex(preview, scopedIndex(preview, sources));
}

export function buildModelFromIndex(
    preview: AbstractionPreview,
    index: EvidenceIndex,
    projector?: typeof projectAction,
): AbstractModel {
    const nodes: AbstractModelNode[] = [];
    const nodeByObservation = new Map<string, string>();
    const nodeIds = new Set<string>();
    for (const [position, group] of [...preview.groups]
        .sort((left, right) => compare(left.id, right.id))
        .entries()) {
        if (group.members.length === 0) {
            throw new Error("An observation group must contain an original observation.");
        }
        const node: AbstractModelNode = {
            id: group.id,
            label: groupLabel(group, position),
            groupId: group.id,
            members: group.members.map((member) => ({ ...member.reference })),
        };
        addNode(node, index, nodes, nodeByObservation, nodeIds);
    }
    const unmatched = new Map(
        preview.unmatched.map((item) => [referenceKey(item.reference), item.reason]),
    );
    for (const indexed of index.observations.values()) {
        const key = referenceKey(indexed.reference);
        if (nodeByObservation.has(key)) {
            continue;
        }
        addNode(
            {
                id: "unmatched:" + key,
                label: "Unmatched observation " + indexed.observation.observation_index,
                members: [{ ...indexed.reference }],
                unmatchedReason:
                    unmatched.get(key) ??
                    "This observation is not represented in the abstraction preview.",
            },
            index,
            nodes,
            nodeByObservation,
            nodeIds,
        );
    }
    const actionEvidence = preview.definition.actions
        ? buildActionEvidence(index, nodeByObservation, preview.definition.actions, projector)
        : undefined;
    const actionByExecution = actionEvidence
        ? new Map(
              actionEvidence.actions.flatMap((action) =>
                  action.executions.map((item) => [canonical(item.reference), action] as const),
              ),
          )
        : undefined;
    const edges = new Map<string, AbstractModelEdge>();
    const unlinkedExecutions: UnlinkedExecution[] = [];
    for (const { source, execution } of index.executions.values()) {
        connectExecution(
            source,
            execution,
            index,
            nodeByObservation,
            edges,
            unlinkedExecutions,
            actionByExecution,
        );
    }
    connectObservationOrder(index, nodeByObservation, edges);
    nodes.sort((left, right) => compare(left.id, right.id));
    const orderedEdges = [...edges.values()].sort((left, right) => compare(left.id, right.id));
    for (const edge of orderedEdges) {
        edge.executions.sort((left, right) => compare(canonical(left), canonical(right)));
        edge.orderLinks.sort((left, right) => compare(canonical(left), canonical(right)));
        edge.label =
            edge.kind === "execution"
                ? edgeLabel(edge.actionType!, edge.executions.length)
                : edgeLabel("Observation order", edge.orderLinks.length);
    }
    unlinkedExecutions.sort((left, right) =>
        compare(canonical(left.reference), canonical(right.reference)),
    );
    return {
        ...(actionEvidence ? { actionEvidence } : {}),
        nodes,
        edges: orderedEdges,
        unlinkedExecutions,
        counts: {
            matchedNodes: nodes.filter((node) => node.groupId !== undefined).length,
            unmatchedNodes: nodes.filter((node) => node.groupId === undefined).length,
            observations: index.observations.size,
            executionEdges: orderedEdges.filter((edge) => edge.kind === "execution").length,
            completedExecutions: orderedEdges.reduce(
                (total, edge) => total + edge.executions.length,
                0,
            ),
            unlinkedExecutions: unlinkedExecutions.length,
            orderEdges: orderedEdges.filter((edge) => edge.kind === "observation_order").length,
            orderLinks: orderedEdges.reduce((total, edge) => total + edge.orderLinks.length, 0),
        },
    };
}

function scopedIndex(preview: AbstractionPreview, sources: AnalysisSource[]): EvidenceIndex {
    const selectedSources: AnalysisSource[] = [];
    const sourceIds = new Set<string>();
    for (const requested of preview.inputScope.sources) {
        if (sourceIds.has(requested.id)) {
            throw new Error("The abstraction preview repeats a source identity.");
        }
        sourceIds.add(requested.id);
        const matches = sources.filter((source) => source.id === requested.id);
        if (matches.length !== 1 || matches[0].fingerprint !== requested.fingerprint) {
            throw new Error(
                "The original evidence for this abstraction preview is missing or has changed.",
            );
        }
        selectedSources.push(matches[0]);
    }
    const selectedRuns = preview.inputScope.runs.map((reference) => {
        if (!sourceIds.has(reference.source)) {
            throw new Error("The abstraction preview refers to a run outside its source scope.");
        }
        return runKey(reference.source, reference.run);
    });
    return buildEvidenceIndex(selectedSources, selectedRuns);
}

function addNode(
    node: AbstractModelNode,
    index: EvidenceIndex,
    nodes: AbstractModelNode[],
    nodeByObservation: Map<string, string>,
    nodeIds: Set<string>,
): void {
    if (nodeIds.has(node.id)) {
        throw new Error("The abstraction preview repeats an abstract state identity.");
    }
    nodeIds.add(node.id);
    for (const reference of node.members) {
        const key = referenceKey(reference);
        if (reference.widget !== undefined || !index.observations.has(key)) {
            throw new Error(
                "An observation group refers to an observation outside the selected evidence.",
            );
        }
        if (nodeByObservation.has(key)) {
            throw new Error("An observation belongs to more than one abstract state.");
        }
        nodeByObservation.set(key, node.id);
    }
    node.members.sort((left, right) => compare(referenceKey(left), referenceKey(right)));
    nodes.push(node);
}

function connectExecution(
    source: AnalysisSource,
    execution: RecordedExecution,
    index: EvidenceIndex,
    nodeByObservation: Map<string, string>,
    edges: Map<string, AbstractModelEdge>,
    unlinked: UnlinkedExecution[],
    actionByExecution?: Map<string, AbstractAction>,
): void {
    const data = execution.execution;
    const reference: ExecutionReference = {
        source: source.id,
        run: testRunForSequence(source.evidence, data.test_sequence),
        execution: data.id,
    };
    const origin: EvidenceReference = {
        source: source.id,
        run: testRunForSequence(source.evidence, data.test_sequence),
        observation: data.source_observation,
    };
    const sourceNode = nodeByObservation.get(referenceKey(origin)) ?? null;
    if (execution.status !== "completed") {
        unlinked.push({
            reference,
            sourceNode,
            status: execution.status,
            reason: executionReason(execution.status),
        });
        return;
    }
    const result: EvidenceReference = {
        source: source.id,
        run: testRunForSequence(source.evidence, data.test_sequence),
        observation: execution.resultingObservation ?? "",
    };
    const targetNode = nodeByObservation.get(referenceKey(result));
    const action = index.actions.get(canonical([source.id, data.action_description]))?.action;
    if (!sourceNode || !targetNode || !action) {
        unlinked.push({
            reference,
            sourceNode,
            status: execution.status,
            reason: !sourceNode
                ? "The source observation is unavailable in the selected evidence."
                : !targetNode
                  ? "The resulting observation is unavailable in the selected run."
                  : "The original action description is unavailable.",
        });
        return;
    }
    const abstractAction = actionByExecution?.get(canonical(reference));
    const actionType = abstractAction?.actionType ?? action.action_type;
    const id = canonical([
        "execution",
        sourceNode,
        targetNode,
        actionType,
        ...(actionByExecution ? [abstractAction?.id ?? canonical(reference)] : []),
    ]);
    let edge = edges.get(id);
    if (!edge) {
        edge = {
            id,
            kind: "execution",
            source: sourceNode,
            target: targetNode,
            label: "",
            actionType,
            ...(abstractAction ? { abstractAction: abstractAction.id } : {}),
            executions: [],
            orderLinks: [],
        };
        edges.set(id, edge);
    }
    edge.executions.push(reference);
}

function connectObservationOrder(
    index: EvidenceIndex,
    nodeByObservation: Map<string, string>,
    edges: Map<string, AbstractModelEdge>,
): void {
    const observationsBySource = new Map<string, Observation[]>();
    const executionsBySource = new Map<string, RecordedExecution[]>();
    for (const item of index.observations.values()) {
        const observations = observationsBySource.get(item.source.id) ?? [];
        observations.push(item.observation);
        observationsBySource.set(item.source.id, observations);
    }
    for (const item of index.executions.values()) {
        const executions = executionsBySource.get(item.source.id) ?? [];
        executions.push(item.execution);
        executionsBySource.set(item.source.id, executions);
    }
    for (const source of index.sources.values()) {
        for (const orderLink of orderLinks(
            observationsBySource.get(source.id) ?? [],
            executionsBySource.get(source.id) ?? [],
            (sequence) => testRunForSequence(source.evidence, sequence),
        )) {
            const origin = { source: source.id, run: orderLink.run, observation: orderLink.source };
            const result = { source: source.id, run: orderLink.run, observation: orderLink.target };
            const sourceNode = nodeByObservation.get(referenceKey(origin));
            const targetNode = nodeByObservation.get(referenceKey(result));
            if (!sourceNode || !targetNode) {
                throw new Error("An observation-order link has no original observation node.");
            }
            const id = canonical(["observation_order", sourceNode, targetNode]);
            let edge = edges.get(id);
            if (!edge) {
                edge = {
                    id,
                    kind: "observation_order",
                    source: sourceNode,
                    target: targetNode,
                    label: "",
                    executions: [],
                    orderLinks: [],
                };
                edges.set(id, edge);
            }
            edge.orderLinks.push({ source: origin, target: result });
        }
    }
}

function executionReason(status: RecordedExecution["status"]): string {
    switch (status) {
        case "awaiting_execution_result":
            return "The action was selected without a recorded execution result or resulting observation.";
        case "awaiting_resulting_observation":
            return "The action returned without a recorded resulting observation.";
        case "failed":
            return "The action execution reported an error; no recorded transition is available.";
        case "incomplete":
            return "The execution ended without a recorded resulting observation.";
        case "completed":
            return "The recorded resulting observation is unavailable.";
    }
}
