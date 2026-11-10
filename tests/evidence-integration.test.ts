import { describe, expect, it, vi } from "vitest";
import { evidenceEvent, JsonNumber, parseJson, ReconstructedEvidence } from "testar-evidence";
import {
    constructAbstractModel,
    EvidenceInputBridge,
    evidenceSource,
    IncrementalAbstraction,
    projectFields,
    runKey,
    type AbstractionRules,
    type EvidenceUpdate,
} from "../src/index.js";
import { canonical } from "../src/common.js";
import * as stateProjection from "../src/projection.js";
import * as actionProjection from "../src/actionProjection.js";

const rules: AbstractionRules = {
    version: 1,
    name: "Page and available buttons",
    state: [{ name: "title", keys: ["ui.title"] }],
    capture: "same",
    widgets: {
        fields: [{ name: "text", keys: ["ui.text"] }],
        hierarchy: "flat",
        order: "sort",
        descendants: "exclude",
    },
    actions: { target: [{ name: "text", keys: ["ui.text"] }] },
};

function history() {
    const evidence = new ReconstructedEvidence({ schema_version: 3, evidence_id: "trace" });
    evidence.apply(
        evidenceEvent("run-event", "test_run_started", {
            id: "run",
            producer: "example",
            source_run: "original-run",
            properties: { "evidence.test_objective": "Submit a form" },
        }),
    );
    evidence.apply(
        evidenceEvent("sequence-event", "test_sequence_started", {
            id: "sequence",
            test_run: "run",
            sequence_index: 1,
            source_sequence: "original-sequence",
            properties: {},
        }),
    );
    evidence.apply(
        evidenceEvent("describe-event", "action_described", {
            id: "click",
            action_type: "click",
            properties: {},
        }),
    );
    return evidence;
}

function observation(id: string, index: number, title = "Form") {
    return evidenceEvent("event:" + id, "observation_recorded", {
        id,
        test_sequence: "sequence",
        observation_index: index,
        timestamp_micros: BigInt(index),
        recorded_state: {
            id: "state:" + id,
            properties: { "ui.title": title },
            widgets: [{ id: "button", parent: null, properties: { "ui.text": "Submit" } }],
            capture: "filtered",
        },
        available_action_scope: "generated",
        available_actions: [{ action_description: "click", target_widget: "button" }],
        artifacts: [],
    });
}

describe("Evidence records used for abstraction", () => {
    it("converts record names and retains the original immutable GUI payloads", () => {
        const evidence = history();
        evidence.apply(observation("before", 1));
        const source = evidenceSource(evidence, { id: "source", label: "Example trace" });
        expect(source.evidence.observations.get("before")).toBe(evidence.observation("before"));
        expect(source.evidence.observations.get("before")!.recorded_state.widgets).toBe(
            evidence.observation("before")!.recorded_state.widgets,
        );
        expect(source.evidence.runs.get("run")!.properties).toBe(
            evidence.testRun("run")!.test_run.properties,
        );
        expect(source.evidence.actions.get("click")).toBe(evidence.actionDescription("click"));
    });

    it("groups equivalent exact decimals and keeps different values and objects separate", async () => {
        const values = [
            new JsonNumber("1.0"),
            new JsonNumber("1.00"),
            1,
            parseJson("0.10000000000000000001"),
            parseJson("0.10000000000000000002"),
            { text: "1.0" },
            18446744073709551615n,
            new JsonNumber("1.8446744073709551615e19"),
        ];
        const sources = values.map((value, index) => {
            const evidence = history();
            const event = observation("observation", 1);
            evidence.apply({
                ...event,
                event: {
                    ...event.event,
                    data: {
                        ...event.event.data,
                        recorded_state: {
                            ...event.event.data.recorded_state,
                            properties: { value },
                        },
                    },
                },
            });
            return evidenceSource(evidence, { id: "source-" + index, label: "Recorded value" });
        });
        const definition: AbstractionRules = {
            version: 1,
            name: "Recorded value",
            state: [{ name: "value", keys: ["value"] }],
            capture: "ignore",
        };
        const result = await constructAbstractModel(
            sources,
            definition,
            sources.map((source) => runKey(source.id, "run")),
        );
        expect(result.preview.groups.map((group) => group.members.length).sort()).toEqual([
            1, 1, 1, 2, 3,
        ]);
        expect(canonical(new JsonNumber("-0.00"))).toBe(canonical(0));
        expect(canonical(new JsonNumber("1e100000"))).toBe(canonical(new JsonNumber("10e99999")));
        expect(canonical(true)).not.toBe(canonical(1));
    });

    it("does not expose a numeric representation as nested widget or state properties", () => {
        const projected = projectFields({ value: new JsonNumber("1.5") }, [
            { name: "internal", keys: ["value"], path: ["text"] },
        ]);
        expect(projected.projection[0].reading.kind).toBe("missing");
    });
});

describe("Updating an abstract model while a test is running", () => {
    it("matches full reconstruction after every observation and execution result", async () => {
        const evidence = history();
        const bridge = new EvidenceInputBridge(evidence, { id: "source", label: "Example trace" });
        const incremental = new IncrementalAbstraction(rules);
        const events = [
            observation("before", 1),
            evidenceEvent("select", "action_selected", {
                id: "execution",
                test_sequence: "sequence",
                source_observation: "before",
                action_description: "click",
                target_widget: "button",
                parameters: {},
            }),
            evidenceEvent("returned", "action_execution_reported", {
                action_execution: "execution",
                outcome: "returned",
                error: null,
            }),
            observation("after", 2, "Confirmation"),
            evidenceEvent("transition", "transition_recorded", {
                action_execution: "execution",
                resulting_observation: "after",
            }),
            evidenceEvent("select-again", "action_selected", {
                id: "unfinished",
                test_sequence: "sequence",
                source_observation: "after",
                action_description: "click",
                target_widget: "button",
                parameters: {},
            }),
            evidenceEvent("sequence-end", "test_sequence_finished", {
                test_sequence: "sequence",
                reason: "stopped",
            }),
            evidenceEvent("run-end", "test_run_finished", { test_run: "run", reason: "completed" }),
        ];
        incremental.update(bridge.update());
        const initial = await incremental.construct();
        for (const event of events) {
            evidence.apply(event);
            incremental.update(bridge.update());
            const actual = await incremental.construct();
            const expected = await constructAbstractModel([bridge.source], rules, [
                runKey("source", "run"),
            ]);
            expect(canonical(actual)).toBe(canonical(expected));
        }
        const result = await incremental.construct();
        expect(result.model.counts.completedExecutions).toBe(1);
        expect(result.model.unlinkedExecutions[0].status).toBe("incomplete");
        expect(initial.model.counts.observations).toBe(0);
        expect(initial.preview.inputScope.sources[0].fingerprint).not.toBe(
            result.preview.inputScope.sources[0].fingerprint,
        );
        expect(incremental.update(bridge.update())).toBe(false);
        expect(await incremental.construct()).toBe(result);
        expect(() =>
            result.model.nodes.push({ id: "changed", label: "changed", members: [] }),
        ).toThrow();
    });

    it("reuses state and action projections when only the execution status changes", async () => {
        const evidence = history();
        evidence.apply(observation("before", 1));
        evidence.apply(
            evidenceEvent("select", "action_selected", {
                id: "execution",
                test_sequence: "sequence",
                source_observation: "before",
                action_description: "click",
                target_widget: "button",
                parameters: {},
            }),
        );
        const bridge = new EvidenceInputBridge(evidence, { id: "source", label: "Example trace" });
        const incremental = new IncrementalAbstraction(rules);
        const states = vi.spyOn(stateProjection, "projectObservation");
        const actions = vi.spyOn(actionProjection, "projectAction");
        try {
            incremental.update(bridge.update());
            await incremental.construct();
            expect(states).toHaveBeenCalledTimes(1);
            expect(actions).toHaveBeenCalledTimes(2);
            states.mockClear();
            actions.mockClear();

            // The call returns, but the page and its available action have not been captured again.
            evidence.apply(
                evidenceEvent("returned", "action_execution_reported", {
                    action_execution: "execution",
                    outcome: "returned",
                    error: null,
                }),
            );
            incremental.update(bridge.update());
            const result = await incremental.construct();
            expect(result.model.unlinkedExecutions[0].status).toBe(
                "awaiting_resulting_observation",
            );
            expect(states).not.toHaveBeenCalled();
            expect(actions).not.toHaveBeenCalled();
        } finally {
            states.mockRestore();
            actions.mockRestore();
        }
    });

    it("retains an execution error without creating a completed transition", async () => {
        const evidence = history();
        evidence.apply(observation("before", 1));
        const bridge = new EvidenceInputBridge(evidence, { id: "source", label: "Example trace" });
        const incremental = new IncrementalAbstraction(rules);
        incremental.update(bridge.update());
        evidence.apply(
            evidenceEvent("select", "action_selected", {
                id: "execution",
                test_sequence: "sequence",
                source_observation: "before",
                action_description: "click",
                target_widget: "button",
                parameters: {},
            }),
        );
        evidence.apply(
            evidenceEvent("failed", "action_execution_reported", {
                action_execution: "execution",
                outcome: "error",
                error: "Operation failed",
            }),
        );
        incremental.update(bridge.update());
        const result = await incremental.construct();
        expect(result.model.counts.completedExecutions).toBe(0);
        expect(result.model.unlinkedExecutions[0].status).toBe("failed");
        expect(bridge.source.evidence.executions.get("execution")!.executionResult!.error).toBe(
            "Operation failed",
        );
    });

    it("retains each prefix when two updates are collected before they are applied", async () => {
        const evidence = history();
        const bridge = new EvidenceInputBridge(evidence, { id: "source", label: "Example trace" });
        const incremental = new IncrementalAbstraction(rules);
        evidence.apply(observation("before", 1));
        const first = bridge.update();
        evidence.apply(observation("after", 2, "Confirmation"));
        const second = bridge.update();
        expect(first.source.fingerprint).not.toBe(second.source.fingerprint);
        incremental.update(first);
        expect((await incremental.construct()).model.counts.observations).toBe(1);
        incremental.update(second);
        expect((await incremental.construct()).model.counts.observations).toBe(2);
    });

    it("constructs a valid deep widget hierarchy without applying JSON-record depth limits to the derived model", async () => {
        const evidence = history();
        const event = observation("before", 1);
        event.event.data.recorded_state.widgets = Array.from({ length: 40 }, (_, index) => ({
            id: "widget:" + index,
            parent: index === 0 ? null : "widget:" + (index - 1),
            properties: { "ui.text": "Item" },
        }));
        event.event.data.available_actions = [];
        evidence.apply(event);
        const bridge = new EvidenceInputBridge(evidence, { id: "source", label: "Deep hierarchy" });
        const definition: AbstractionRules = {
            ...rules,
            widgets: { ...rules.widgets!, hierarchy: "tree" },
        };
        const incremental = new IncrementalAbstraction(definition);
        incremental.update(bridge.update());
        const actual = await incremental.construct();
        const expected = await constructAbstractModel([bridge.source], definition, [
            runKey("source", "run"),
        ]);
        expect(canonical(actual)).toBe(canonical(expected));
        expect(actual.preview.groups[0].members[0].includedWidgets).toBe(40);
    });

    it("requires updates in order and leaves the existing model available after an invalid update", async () => {
        const evidence = history();
        const bridge = new EvidenceInputBridge(evidence, { id: "source", label: "Example trace" });
        const incremental = new IncrementalAbstraction(rules);
        const first = bridge.update();
        incremental.update(first);
        const before = await incremental.construct();
        const invalid: EvidenceUpdate = {
            ...first,
            source: { ...bridge.source, fingerprint: "another-prefix" },
            previousFingerprint: "wrong-prefix",
        };
        expect(() => incremental.update(invalid)).toThrow(/order/u);
        expect(await incremental.construct()).toBe(before);
    });
});
