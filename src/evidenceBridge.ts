import type { EvidenceHistory, ReconstructedEvidence } from "testar-evidence";
import { canonical } from "./common.js";
import type {
    ActionDescription,
    EvidenceInput,
    Observation,
    RecordedExecution,
    RecordedRun,
    RecordedSequence,
} from "./evidence-input.js";
import type { AnalysisSource } from "./types.js";

export interface EvidenceChanges {
    runs: readonly RecordedRun[];
    sequences: readonly RecordedSequence[];
    observations: readonly Observation[];
    actions: readonly ActionDescription[];
    executions: readonly RecordedExecution[];
}
export interface EvidenceUpdate {
    source: AnalysisSource;
    previousFingerprint: string | null;
    changes: EvidenceChanges;
}

/** Translate accepted evidence records into abstraction input, retaining their immutable payloads. */
export class EvidenceInputBridge {
    readonly source: AnalysisSource;
    #history: EvidenceHistory | ReconstructedEvidence;
    #cursor = 0;
    #initialized = false;
    #pending = new Map<string, string>();
    #input: EvidenceInput = {
        runs: new Map(),
        sequences: new Map(),
        observations: new Map(),
        actions: new Map(),
        executions: new Map(),
    };

    constructor(
        history: EvidenceHistory | ReconstructedEvidence,
        identity: { id: string; label: string },
    ) {
        this.#history = history;
        this.source = {
            ...identity,
            fingerprint: canonical([history.manifest.evidence_id, identity.id, 0]),
            evidence: this.#input,
        };
    }

    #fingerprint(): string {
        return canonical([this.#history.manifest.evidence_id, this.source.id, this.#cursor]);
    }

    /** Translate newly accepted events; saved widget and property payloads are reused. */
    update(): EvidenceUpdate {
        const previousFingerprint = this.#initialized ? this.source.fingerprint : null;
        const expectedCount = this.#history.eventCount - this.#cursor;
        const events = expectedCount === 0 ? [] : this.#history.events.slice(this.#cursor);
        const changed = {
            runs: new Set<string>(),
            sequences: new Set<string>(),
            observations: new Set<string>(),
            actions: new Set<string>(),
            executions: new Set<string>(),
        };
        for (const envelope of events) {
            const event = envelope.event;
            switch (event.event_type) {
                case "test_run_started":
                    changed.runs.add(event.data.id);
                    break;
                case "test_run_finished":
                    changed.runs.add(event.data.test_run);
                    break;
                case "test_sequence_started":
                    changed.sequences.add(event.data.id);
                    break;
                case "test_sequence_finished": {
                    changed.sequences.add(event.data.test_sequence);
                    const execution = this.#pending.get(event.data.test_sequence);
                    if (execution) {
                        changed.executions.add(execution);
                        this.#pending.delete(event.data.test_sequence);
                    }
                    break;
                }
                case "action_described":
                    changed.actions.add(event.data.id);
                    break;
                case "observation_recorded":
                    changed.observations.add(event.data.id);
                    break;
                case "action_selected":
                    changed.executions.add(event.data.id);
                    this.#pending.set(event.data.test_sequence, event.data.id);
                    break;
                case "action_execution_reported":
                case "transition_recorded": {
                    const id = event.data.action_execution;
                    changed.executions.add(id);
                    const record = this.#history.actionExecution(id)!;
                    if (record.status === "completed" || record.status === "failed") {
                        this.#pending.delete(record.action_execution.test_sequence);
                    }
                    break;
                }
                case "oracle_result_recorded":
                    break;
            }
        }
        for (const id of changed.runs) {
            const record = this.#history.testRun(id)!;
            this.#input.runs.set(
                id,
                Object.freeze({ ...record.test_run, status: record.status, reason: record.reason }),
            );
        }
        for (const id of changed.sequences) {
            const record = this.#history.testSequence(id)!;
            this.#input.sequences.set(
                id,
                Object.freeze({
                    ...record.test_sequence,
                    status: record.status,
                    reason: record.reason,
                }),
            );
        }
        for (const id of changed.observations) {
            this.#input.observations.set(id, this.#history.observation(id)!);
        }
        for (const id of changed.actions) {
            this.#input.actions.set(id, this.#history.actionDescription(id)!);
        }
        for (const id of changed.executions) {
            const record = this.#history.actionExecution(id)!;
            this.#input.executions.set(
                id,
                Object.freeze({
                    execution: record.action_execution,
                    status: record.status,
                    executionResult: record.execution_result,
                    resultingObservation: record.resulting_observation,
                }),
            );
        }
        this.#cursor += events.length;
        this.#initialized = true;
        this.source.fingerprint = this.#fingerprint();
        return {
            source: { ...this.source },
            previousFingerprint,
            changes: {
                runs: [...changed.runs].map((id) => this.#input.runs.get(id)!),
                sequences: [...changed.sequences].map((id) => this.#input.sequences.get(id)!),
                observations: [...changed.observations].map((id) =>
                    this.#input.observations.get(id)!,
                ),
                actions: [...changed.actions].map((id) => this.#input.actions.get(id)!),
                executions: [...changed.executions].map((id) => this.#input.executions.get(id)!),
            },
        };
    }
}

/** Build a one-time input view; keep the bridge when new execution evidence will arrive. */
export function evidenceSource(
    history: EvidenceHistory | ReconstructedEvidence,
    identity: { id: string; label: string },
): AnalysisSource {
    const bridge = new EvidenceInputBridge(history, identity);
    bridge.update();
    return bridge.source;
}
