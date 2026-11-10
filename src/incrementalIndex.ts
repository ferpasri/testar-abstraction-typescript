import { canonical } from "./common.js";
import { buildEvidenceIndex, referenceKey, runKey, type EvidenceIndex } from "./evidenceIndex.js";
import { testRunForSequence } from "./evidence-input.js";
import type { EvidenceUpdate } from "./evidenceBridge.js";
import { ABSTRACTION_LIMITS } from "./types.js";

/** Extend lookup tables from a bridge's new records instead of scanning old widget trees again. */
export class IncrementalEvidenceIndex {
    readonly index: EvidenceIndex = buildEvidenceIndex([], []);
    #selected?: Set<string>;
    #fingerprints = new Map<string, string>();

    constructor(selectedRuns?: readonly string[]) {
        this.#selected = selectedRuns ? new Set(selectedRuns) : undefined;
    }

    update(update: EvidenceUpdate): boolean {
        const { source, changes, previousFingerprint } = update;
        const previous = this.#fingerprints.get(source.id);
        if (previous === source.fingerprint) {
            return false;
        }
        if ((previous ?? null) !== previousFingerprint) {
            throw new Error("Apply evidence updates in the order they were read.");
        }
        for (const [id, fingerprint] of this.#fingerprints) {
            if (id !== source.id && fingerprint === source.fingerprint) {
                throw new Error("Each evidence source must have a unique fingerprint.");
            }
        }
        const included = (sequence: string) => {
            const run = testRunForSequence(source.evidence, sequence);
            return !this.#selected || this.#selected.has(runKey(source.id, run));
        };
        const selectedRuns = changes.runs.filter(
            (run) => !this.#selected || this.#selected.has(runKey(source.id, run.id)),
        );
        const observations = changes.observations.filter((observation) =>
            included(observation.test_sequence),
        );
        const executions = changes.executions.filter((record) =>
            included(record.execution.test_sequence),
        );
        let widgets = 0;
        let additionalObservations = 0;
        for (const observation of observations) {
            const reference = {
                source: source.id,
                run: testRunForSequence(source.evidence, observation.test_sequence),
                observation: observation.id,
            };
            const previousObservation = this.index.observations.get(referenceKey(reference));
            if (previousObservation && previousObservation.observation !== observation) {
                throw new Error(
                    "Recorded observations are immutable; create a new computation for replacement input.",
                );
            }
            if (!previousObservation) {
                additionalObservations++;
                widgets += observation.recorded_state.widgets.length;
            }
        }
        if (
            this.index.observations.size + additionalObservations >
                ABSTRACTION_LIMITS.observations ||
            this.index.widgets.size + widgets > ABSTRACTION_LIMITS.widgets
        ) {
            throw new Error("The selected evidence exceeds the abstraction processing limits.");
        }
        for (const run of selectedRuns) {
            this.index.runs.set(runKey(source.id, run.id), { source, run });
        }
        if (selectedRuns.length || this.index.sources.has(source.id)) {
            this.index.sources.set(source.id, source);
        }
        const descriptions = new Set<string>();
        for (const observation of observations) {
            const reference = {
                source: source.id,
                run: testRunForSequence(source.evidence, observation.test_sequence),
                observation: observation.id,
            };
            const key = referenceKey(reference);
            if (!this.index.observations.has(key)) {
                this.index.observations.set(key, { source, reference, observation });
                for (const widget of observation.recorded_state.widgets) {
                    const widgetReference = { ...reference, widget: widget.id };
                    this.index.widgets.set(referenceKey(widgetReference), {
                        reference: widgetReference,
                        widget,
                    });
                }
            }
            for (const action of observation.available_actions) {
                descriptions.add(action.action_description);
            }
        }
        for (const record of executions) {
            const run = testRunForSequence(source.evidence, record.execution.test_sequence);
            this.index.executions.set(canonical([source.id, run, record.execution.id]), {
                source,
                execution: record,
            });
            descriptions.add(record.execution.action_description);
        }
        for (const description of changes.actions) {
            const key = canonical([source.id, description.id]);
            if (this.index.actions.has(key)) {
                this.index.actions.set(key, { source, action: description });
            }
        }
        for (const id of descriptions) {
            const action = source.evidence.actions.get(id);
            if (action) {
                this.index.actions.set(canonical([source.id, id]), { source, action });
            }
        }
        this.#fingerprints.set(source.id, source.fingerprint);
        this.index.counts = {
            sources: this.index.sources.size,
            runs: this.index.runs.size,
            observations: this.index.observations.size,
            widgets: this.index.widgets.size,
            actions: this.index.actions.size,
            executions: this.index.executions.size,
        };
        return true;
    }
}
