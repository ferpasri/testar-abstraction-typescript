import { compareIndex } from "./evidence-input.js";
import type { EvidenceInput, Observation, RecordedExecution } from "./evidence-input.js";

export interface ObservationOrderLink {
    id: string;
    source: string;
    target: string;
    run: string;
}

export function observationOrderLinks(
    evidence: EvidenceInput,
    observations: Observation[],
): ObservationOrderLink[] {
    const visible = new Set(observations.map((item) => item.id));
    const sequences = new Set(observations.map((item) => item.test_sequence));
    const records = [...evidence.observations.values()].filter((item) =>
        sequences.has(item.test_sequence),
    );
    return orderLinks(
        records,
        evidence.executions.values(),
        (sequence) => evidence.sequences.get(sequence)!.test_run,
        visible,
    );
}

/** Selected runs already contain complete sequences, so model construction can use indexed records directly. */
export function orderLinks(
    observations: Iterable<Observation>,
    executions: Iterable<RecordedExecution>,
    testRun: (sequence: string) => string,
    visible?: ReadonlySet<string>,
): ObservationOrderLink[] {
    const completed = new Set<string>();
    for (const item of executions) {
        if (item.status === "completed" && item.resultingObservation) {
            completed.add(
                JSON.stringify([item.execution.source_observation, item.resultingObservation]),
            );
        }
    }
    const groups = new Map<string, Observation[]>();
    for (const item of observations) {
        const group = groups.get(item.test_sequence) ?? [];
        group.push(item);
        groups.set(item.test_sequence, group);
    }
    const result: ObservationOrderLink[] = [];
    for (const [sequence, group] of groups) {
        group.sort((left, right) => compareIndex(left.observation_index, right.observation_index));
        for (let index = 1; index < group.length; index++) {
            const source = group[index - 1].id;
            const target = group[index].id;
            const id = JSON.stringify([source, target]);
            if ((!visible || (visible.has(source) && visible.has(target))) && !completed.has(id)) {
                result.push({ id, source, target, run: testRun(sequence) });
            }
        }
    }
    return result;
}
