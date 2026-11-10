import { JsonNumber } from "testar-evidence";
import { canonical } from "./common.js";
import { ABSTRACTION_LIMITS } from "./types.js";

export class AbstractionLimitError extends Error {}

export class ComparisonBudget {
    private bytes = 0;

    get usedBytes(): number {
        return this.bytes;
    }

    addBytes(bytes: number): void {
        this.add(bytes);
    }

    account(value: unknown): void {
        if (Array.isArray(value)) {
            this.add(2 + Math.max(0, value.length - 1));
            for (const item of value) {
                this.account(item);
            }
            return;
        }
        if (value !== null && typeof value === "object" && !(value instanceof JsonNumber)) {
            const entries = Object.entries(value);
            this.add(2 + Math.max(0, entries.length - 1));
            for (const [key, item] of entries) {
                this.add(new TextEncoder().encode(JSON.stringify(key)).byteLength + 1);
                this.account(item);
            }
            return;
        }
        this.add(new TextEncoder().encode(canonical(value)).byteLength);
    }

    private add(bytes: number): void {
        this.bytes += bytes;
        if (this.bytes > ABSTRACTION_LIMITS.comparisonBytes) {
            throw new AbstractionLimitError(
                "Comparison data exceeds 32 MiB. Select fewer runs or fewer properties.",
            );
        }
    }
}
