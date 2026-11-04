import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
    buildAbstractModel,
    parseAbstractionRules,
    previewAbstraction,
    runKey,
    ABSTRACTION_LIMITS,
    AbstractionLimitError,
    projectFields,
    type AbstractModel,
} from "../src/index.js";
import { canonical } from "../src/common.js";
import {
    conformanceSources,
    ordered,
    sharedCases,
    type ConformanceInput,
} from "./support/conformance.js";

function reverseMap<T>(records: Map<string, T>): Map<string, T> {
    return new Map([...records].reverse());
}
function semanticResult(model: AbstractModel) {
    const evidence = model.actionEvidence!;
    return {
        actions: evidence.actions.map((action) => ({
            state: model.nodes.find((node) => node.id === action.sourceNode)!.members,
            comparison: action.comparison,
            availability: action.availability,
            executions: action.executions.map(({ diagnostic, ...item }) => ({
                ...item,
                diagnostic: diagnostic !== undefined,
            })),
            ambiguous: action.ambiguous,
        })),
        unmatched_available: evidence.unmatchedAvailableActions.map(
            ({ reason, sourceNode, ...item }) => ({
                ...item,
                state: model.nodes.find((node) => node.id === sourceNode)!.members,
                diagnostic: reason.length > 0,
            }),
        ),
        unmatched_executions: evidence.unmatchedExecutions.map((item) => ({
            reference: item.reference,
            diagnostic: item.reason.length > 0,
            possible_actions: item.possibleActionIds.length,
            recordedAvailableActions: item.recordedAvailableActions,
        })),
        transitions: model.edges
            .filter((edge) => edge.kind === "execution")
            .map((edge) => ({
                executions: edge.executions,
                matched_action: edge.abstractAction !== undefined,
            })),
    };
}
function normalize(value: unknown): unknown {
    if (Array.isArray(value)) {
        return ordered(value.map(normalize));
    }
    if (value !== null && typeof value === "object") {
        return Object.fromEntries(
            Object.entries(value).map(([key, item]) => [key, normalize(item)]),
        );
    }
    return value;
}
const { directory, cases } = sharedCases("actions");
describe("shared action abstraction conformance", () => {
    for (const name of cases) {
        it(name, async () => {
            const input = JSON.parse(
                await readFile(`${directory}/${name}/input.json`, "utf8"),
            ) as ConformanceInput;
            const before = canonical(input);
            const evidence = conformanceSources(input);
            const rules = parseAbstractionRules(
                await readFile(`${directory}/${name}/rules.json`, "utf8"),
            );
            const selected = input.selected_runs.map((run) => runKey(run.source, run.run));
            const expected = normalize(
                JSON.parse(await readFile(`${directory}/${name}/expected.json`, "utf8")),
            );
            const preview = await previewAbstraction(evidence, rules, selected);
            const model = buildAbstractModel(preview, evidence);
            expect(normalize(semanticResult(model))).toEqual(expected);
            expect(canonical(input)).toBe(before);
            const reversed = [...evidence].reverse().map((source) => ({
                ...source,
                evidence: {
                    runs: reverseMap(source.evidence.runs),
                    sequences: reverseMap(source.evidence.sequences),
                    observations: reverseMap(source.evidence.observations),
                    actions: reverseMap(source.evidence.actions),
                    executions: reverseMap(source.evidence.executions),
                },
            }));
            const repeated = await previewAbstraction(reversed, rules, [...selected].reverse());
            expect(normalize(semanticResult(buildAbstractModel(repeated, reversed)))).toEqual(
                expected,
            );
            for (const action of model.actionEvidence!.actions) {
                expect(action.availability.length + action.executions.length).toBeGreaterThan(0);
            }
        });
    }
});

async function example(name = "available-and-executed") {
    const input = JSON.parse(
        await readFile(`${directory}/${name}/input.json`, "utf8"),
    ) as ConformanceInput;
    const evidence = conformanceSources(input);
    const rules = parseAbstractionRules(await readFile(`${directory}/${name}/rules.json`, "utf8"));
    return {
        evidence,
        rules,
        selected: input.selected_runs.map((run) => runKey(run.source, run.run)),
    };
}
async function construct(input: Awaited<ReturnType<typeof example>>) {
    const preview = await previewAbstraction(input.evidence, input.rules, input.selected);
    return buildAbstractModel(preview, input.evidence);
}

describe("action rule boundaries", () => {
    it("keeps action details opt-in", async () => {
        const input = await example();
        delete input.rules.actions;
        const model = await construct(input);
        expect(model).not.toHaveProperty("actionEvidence");
        expect(model.edges.filter((edge) => edge.kind === "execution")).toHaveLength(2);
    });
    it("compares operation alone only when explicitly selected", async () => {
        const input = await example();
        input.rules.actions = { type: input.rules.actions!.type };
        const evidence = (await construct(input)).actionEvidence!;
        expect(evidence.actions).toHaveLength(1);
        expect(evidence.actions[0].ambiguous).toBe(true);
        expect(evidence.unmatchedExecutions).toHaveLength(1);
    });
    it("keeps duplicate availability entries from creating false ambiguity", async () => {
        const input = await example();
        const observation = input.evidence[0].evidence.observations.get("o1")!;
        observation.available_actions.push({ ...observation.available_actions[0] });
        const evidence = (await construct(input)).actionEvidence!;
        expect(evidence.actions.every((action) => !action.ambiguous)).toBe(true);
        expect(evidence.actions.flatMap((action) => action.availability)).toHaveLength(10);
    });
    it("uses the bound widget as well as the action description for recorded links", async () => {
        const input = await example("ambiguous-targets");
        const source = input.evidence[0];
        source.evidence.observations.get("o1")!.available_actions[1].action_description = "a1";
        const action = (await construct(input)).actionEvidence!.actions[0];
        expect(action.ambiguous).toBe(true);
        expect(action.executions[0].recordedAvailableActions[0].targetWidget).toBe("one");
        expect(
            action.availability.find((item) => item.reference.targetWidget === "two")!
                .recordedExecutions,
        ).toEqual([]);
    });
    it("preserves recorded selection when parameter information is missing", async () => {
        const input = await example("recorded-input-difference");
        input.evidence[0].evidence.executions.get("e")!.execution.parameters = {};
        const evidence = (await construct(input)).actionEvidence!;
        expect(evidence.actions[0].executions).toEqual([]);
        expect(evidence.actions[0].availability[0].recordedExecutions).toHaveLength(1);
        expect(evidence.unmatchedExecutions[0].recordedAvailableActions[0].actionDescription).toBe(
            "a",
        );
        expect(evidence.unmatchedExecutions[0].reason).toContain("Required field");
    });
    it("reports target fields that were not captured instead of matching empty targets", async () => {
        const input = await example();
        input.rules.actions!.target = [{ name: "role", keys: ["ui.role"] }];
        const evidence = (await construct(input)).actionEvidence!;
        expect(evidence.actions).toHaveLength(0);
        expect(evidence.unmatchedAvailableActions).toHaveLength(10);
        expect(evidence.unmatchedExecutions).toHaveLength(2);
    });
    it("supports action-description comparisons without widget targets", async () => {
        const input = await example();
        delete input.rules.actions!.target;
        input.rules.actions!.description = [{ name: "label", keys: ["label"], required: true }];
        for (const source of input.evidence) {
            for (const action of source.evidence.actions.values()) {
                action.properties.label = source.id === "beta" ? "a5" : action.id;
            }
        }
        expect((await construct(input)).actionEvidence!.actions).toHaveLength(5);
    });
    it("retains executions when no available actions were reported", async () => {
        const input = await example();
        for (const source of input.evidence) {
            for (const observation of source.evidence.observations.values()) {
                observation.available_actions = [];
            }
        }
        const actions = (await construct(input)).actionEvidence!.actions;
        expect(actions).toHaveLength(2);
        expect(actions.every((action) => action.availability.length === 0)).toBe(true);
        expect(actions.flatMap((action) => action.executions)).toHaveLength(2);
    });
    it("uses only selected runs", async () => {
        const input = await example();
        input.selected = [runKey("beta", "run")];
        const evidence = (await construct(input)).actionEvidence!;
        expect(evidence.actions).toHaveLength(1);
        expect(evidence.actions[0].availability).toEqual([]);
        expect(evidence.actions[0].executions[0].reference.source).toBe("beta");
    });
    it("rejects mismatched planned and executed parameter field names", async () => {
        const input = await example("selected-parameters");
        input.rules.actions!.parameters!.executed[0].name = "different";
        expect(() => parseAbstractionRules(JSON.stringify(input.rules))).toThrow("same names");
    });
    it("rejects unknown action options", async () => {
        const input = await example();
        expect(() =>
            parseAbstractionRules(
                JSON.stringify({
                    ...input.rules,
                    actions: { ...input.rules.actions, inferToolSemantics: true },
                }),
            ),
        ).toThrow();
    });
    it("reads nested fields through own properties and distinguishes null from missing", () => {
        const field = { name: "amount", keys: ["input"], path: ["amount"] };
        expect(projectFields({ input: { amount: null } }, [field]).projection[0].reading).toEqual({
            kind: "value",
            value: null,
        });
        expect(projectFields({ input: {} }, [field]).projection[0].reading).toEqual({
            kind: "missing",
        });
        expect(projectFields({ input: Object.create({ amount: 1 }) }, [field]).informative).toBe(
            false,
        );
        expect(projectFields({ input: {} }, [{ ...field, path: ["__proto__"] }]).informative).toBe(
            false,
        );
    });
    it("keeps unmatched availability linked to its recorded execution", async () => {
        const input = await example("missing-targets");
        input.evidence[0].evidence.executions.get("e")!.execution.target_widget = "missing";
        const evidence = (await construct(input)).actionEvidence!;
        expect(evidence.unmatchedAvailableActions[0].recordedExecutions).toEqual([
            { source: "alpha", run: "run", execution: "e" },
        ]);
    });
    it("stops on the action record limit", async () => {
        const input = await example();
        const original = ABSTRACTION_LIMITS.actionRecords;
        try {
            ABSTRACTION_LIMITS.actionRecords = 1;
            await expect(construct(input)).rejects.toThrow(AbstractionLimitError);
        } finally {
            ABSTRACTION_LIMITS.actionRecords = original;
        }
    });
    it("stops on the comparison budget instead of converting it to an unmatched action", async () => {
        const input = await example();
        const preview = await previewAbstraction(input.evidence, input.rules, input.selected);
        const original = ABSTRACTION_LIMITS.comparisonBytes;
        try {
            ABSTRACTION_LIMITS.comparisonBytes = 1;
            expect(() => buildAbstractModel(preview, input.evidence)).toThrow(
                AbstractionLimitError,
            );
        } finally {
            ABSTRACTION_LIMITS.comparisonBytes = original;
        }
    });
});
