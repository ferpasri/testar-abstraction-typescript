import assert from "node:assert/strict";
import { equalJson, evidenceEvent, ReconstructedEvidence } from "testar-evidence";
import {
    constructAbstractModel,
    EvidenceInputBridge,
    IncrementalAbstraction,
    runKey,
    type AbstractionRules,
} from "../dist/index.js";

const argument = (name: string, fallback: number) => {
    const position = process.argv.indexOf(name);
    const value = position === -1 ? fallback : Number(process.argv[position + 1]);
    if (!Number.isSafeInteger(value) || value < 1) {
        throw new Error(name + " must be a positive integer.");
    }
    return value;
};
const observations = argument("--observations", 100);
const widgets = argument("--widgets", 30);
const rules: AbstractionRules = {
    version: 1,
    name: "Page and button structure",
    state: [{ name: "page", keys: ["ui.title"] }],
    capture: "same",
    widgets: {
        fields: [{ name: "text", keys: ["ui.text"] }],
        hierarchy: "flat",
        order: "sort",
        descendants: "exclude",
    },
    actions: { target: [{ name: "text", keys: ["ui.text"] }] },
};

async function measure(incremental: boolean) {
    const history = new ReconstructedEvidence({ schema_version: 3, evidence_id: "benchmark" });
    history.apply(
        evidenceEvent("run-event", "test_run_started", {
            id: "run",
            producer: "benchmark",
            source_run: "run",
            properties: {},
        }),
    );
    history.apply(
        evidenceEvent("sequence-event", "test_sequence_started", {
            id: "sequence",
            test_run: "run",
            sequence_index: 1,
            source_sequence: "sequence",
            properties: {},
        }),
    );
    history.apply(
        evidenceEvent("action-event", "action_described", {
            id: "click",
            action_type: "click",
            properties: {},
        }),
    );
    const bridge = new EvidenceInputBridge(history, { id: "source", label: "Benchmark trace" });
    const computation = new IncrementalAbstraction(rules);
    let elapsed = 0;
    let result: Awaited<ReturnType<typeof constructAbstractModel>> | undefined;
    for (let index = 0; index < observations; index++) {
        // Evidence creation is common setup; time only conversion and model construction.
        history.apply(
            evidenceEvent("observation-event:" + index, "observation_recorded", {
                id: "observation:" + index,
                test_sequence: "sequence",
                observation_index: index,
                timestamp_micros: index,
                recorded_state: {
                    id: "state:" + index,
                    properties: { "ui.title": "Page " + (index % 7) },
                    capture: "filtered",
                    widgets: Array.from({ length: widgets }, (_, widget) => ({
                        id: "widget:" + widget,
                        parent: null,
                        properties: { "ui.text": "Button " + widget },
                    })),
                },
                available_action_scope: "generated",
                available_actions: Array.from({ length: widgets }, (_, widget) => ({
                    action_description: "click",
                    target_widget: "widget:" + widget,
                })),
                artifacts: [],
            }),
        );
        const start = performance.now();
        const update = bridge.update();
        if (incremental) {
            computation.update(update);
            result = await computation.construct();
        } else {
            result = await constructAbstractModel([bridge.source], rules, [
                runKey("source", "run"),
            ]);
        }
        elapsed += performance.now() - start;
    }
    return { milliseconds: elapsed, result };
}

// Warm both paths on the same deterministic workload before reporting measurements.
console.log("Warming up full rebuilds...");
await measure(false);
console.log("Warming up incremental updates...");
await measure(true);
console.log("Measuring full rebuilds...");
const batch = await measure(false);
console.log("Measuring incremental updates...");
const incremental = await measure(true);
assert.equal(
    equalJson(incremental.result, batch.result),
    true,
    "Both approaches must produce the same model data.",
);
console.table({
    "Full rebuild per observation": { milliseconds: batch.milliseconds.toFixed(1) },
    "Incremental updates": { milliseconds: incremental.milliseconds.toFixed(1) },
});
console.log(
    "Full/incremental: " + (batch.milliseconds / incremental.milliseconds).toFixed(2) + "x",
);
console.log(
    "Compared " +
        observations +
        " observations with " +
        widgets +
        " widgets each; final models are identical.",
);
