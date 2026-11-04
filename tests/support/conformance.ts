import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPreparedConformance } from "../../tools/specs-conformance.js";
import { INTERPRETER_VERSION } from "../../src/index.js";
import type { AnalysisSource, EvidenceInput } from "../../src/index.js";
import { canonical } from "../../src/common.js";

type WireEvidence = {
    [K in keyof EvidenceInput]: Array<EvidenceInput[K] extends Map<string, infer V> ? V : never>;
};
export interface ConformanceInput {
    sources: Array<{ id: string; label: string; fingerprint: string; evidence: WireEvidence }>;
    selected_runs: Array<{ source: string; run: string }>;
}

export function conformanceSources(input: ConformanceInput): AnalysisSource[] {
    return input.sources.map((source) => ({
        ...source,
        evidence: {
            runs: new Map(source.evidence.runs.map((item) => [item.id, item])),
            sequences: new Map(source.evidence.sequences.map((item) => [item.id, item])),
            observations: new Map(source.evidence.observations.map((item) => [item.id, item])),
            actions: new Map(source.evidence.actions.map((item) => [item.id, item])),
            executions: new Map(
                source.evidence.executions.map((item) => [item.execution.id, item]),
            ),
        },
    }));
}

export function ordered<T>(values: T[]): T[] {
    return [...values].sort((a, b) => canonical(a).localeCompare(canonical(b), "en"));
}

const prepared = await loadPreparedConformance();
const supported = JSON.parse(
    await readFile(fileURLToPath(new URL("../../compatibility.json", import.meta.url)), "utf8"),
) as Record<string, number>;
for (const [key, value] of Object.entries(supported)) {
    if (prepared.manifest[key as keyof typeof prepared.manifest] !== value) {
        throw new Error(`Unsupported shared conformance ${key}: ${prepared.selection.release}`);
    }
}
if (prepared.manifest.behavior_version !== INTERPRETER_VERSION) {
    throw new Error(`Unsupported abstraction behavior: ${prepared.manifest.behavior_version}`);
}

export function sharedCases(suite: "states" | "actions") {
    const entry = prepared.manifest.suites[suite];
    return {
        directory: path.join(prepared.directory, "conformance", entry.directory),
        cases: entry.cases,
    };
}
