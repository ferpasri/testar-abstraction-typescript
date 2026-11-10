import { freezeSnapshot } from "./immutable.js";
import { validateAbstractionRules } from "./abstraction-rules.js";
import { previewIndexedEvidence } from "./engine.js";
import { buildModelFromIndex } from "./abstractModel.js";
import { buildEvidenceIndex } from "./evidenceIndex.js";
import { IncrementalEvidenceIndex } from "./incrementalIndex.js";
import { ProjectionCache } from "./projectionCache.js";
import type { EvidenceUpdate } from "./evidenceBridge.js";
import type {
    AbstractionPreview,
    AbstractionProgress,
    AbstractionRules,
    AnalysisSource,
} from "./types.js";
import type { AbstractModel } from "./abstractModelTypes.js";

export interface ConstructedAbstraction {
    preview: AbstractionPreview;
    model: AbstractModel;
}

/** Construct a batch preview and model using one evidence index. */
export async function constructAbstractModel(
    sources: AnalysisSource[],
    rules: AbstractionRules,
    selectedRuns: string[],
    report?: (progress: AbstractionProgress) => void,
): Promise<ConstructedAbstraction> {
    const definition = validateAbstractionRules(rules);
    const index = buildEvidenceIndex(sources, selectedRuns);
    const cache = new ProjectionCache(definition);
    const preview = await previewIndexedEvidence(index, cache, report);
    return { preview, model: buildModelFromIndex(preview, index, cache.action) };
}

/** Keep expensive projections and lookups between updates while returning complete model snapshots on request. */
export class IncrementalAbstraction {
    #index: IncrementalEvidenceIndex;
    #projections: ProjectionCache;
    #snapshot?: ConstructedAbstraction;
    #constructing = false;

    constructor(rules: AbstractionRules, selectedRuns?: readonly string[]) {
        this.#index = new IncrementalEvidenceIndex(selectedRuns);
        this.#projections = new ProjectionCache(validateAbstractionRules(rules));
    }

    update(update: EvidenceUpdate): boolean {
        if (this.#constructing) {
            throw new Error("Wait for model construction before applying another evidence update.");
        }
        const changed = this.#index.update(update);
        if (changed) {
            this.#snapshot = undefined;
        }
        return changed;
    }

    async construct(
        report?: (progress: AbstractionProgress) => void,
    ): Promise<ConstructedAbstraction> {
        if (this.#snapshot) {
            return this.#snapshot;
        }
        if (this.#constructing) {
            throw new Error("Model construction is already running.");
        }
        this.#constructing = true;
        try {
            const preview = await previewIndexedEvidence(
                this.#index.index,
                this.#projections,
                report,
            );
            const model = buildModelFromIndex(preview, this.#index.index, this.#projections.action);
            // Reuse frozen projections while keeping each public model snapshot immutable.
            this.#snapshot = freezeSnapshot({ preview, model });
            return this.#snapshot;
        } finally {
            this.#constructing = false;
        }
    }
}
