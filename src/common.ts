import { JsonNumber, parseJson as parseEvidenceJson } from "testar-evidence";

export class AbstractionError extends Error {}

function requireAbstraction(condition: unknown, message: string): asserts condition {
    if (!condition) {
        throw new AbstractionError(message);
    }
}

/** Compare numeric values rather than their decimal spelling, without expanding huge exponents. */
function canonicalNumber(value: number | bigint | JsonNumber): string {
    if (typeof value === "number") {
        requireAbstraction(Number.isFinite(value), "JSON numbers must be finite.");
        requireAbstraction(
            !Number.isInteger(value) || Number.isSafeInteger(value),
            "Use bigint or JsonNumber for an integer outside JavaScript's safe range.",
        );
    }
    const text = value instanceof JsonNumber ? value.text : String(value);
    const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/u.exec(text)!;
    const digits = (match[2] + (match[3] ?? "")).replace(/^0+/u, "");
    if (digits.length === 0) {
        return "0";
    }
    const coefficient = digits.replace(/0+$/u, "");
    const exponent =
        BigInt(match[4] ?? "0") -
        BigInt((match[3] ?? "").length) +
        BigInt(digits.length - coefficient.length);
    if (exponent >= 0n && BigInt(coefficient.length) + exponent <= 1024n) {
        return match[1] + coefficient + "0".repeat(Number(exponent));
    }
    if (exponent < 0n && exponent >= -1024n && coefficient.length <= 1024) {
        const point = coefficient.length + Number(exponent);
        return (
            match[1] +
            (point > 0
                ? coefficient.slice(0, point) + "." + coefficient.slice(point)
                : "0." + "0".repeat(-point) + coefficient)
        );
    }
    return match[1] + coefficient + "e" + exponent.toString();
}

export function canonical(value: unknown): string {
    if (value instanceof JsonNumber || typeof value === "number" || typeof value === "bigint") {
        return canonicalNumber(value);
    }
    if (Array.isArray(value)) {
        return "[" + value.map(canonical).join(",") + "]";
    }
    if (value !== null && typeof value === "object") {
        const record = value as Record<string, unknown>;
        return (
            "{" +
            Object.keys(record)
                .sort()
                .map((key) => JSON.stringify(key) + ":" + canonical(record[key]))
                .join(",") +
            "}"
        );
    }
    return JSON.stringify(value);
}

export function parseJson(text: string): unknown {
    let value: unknown;
    try {
        value = parseEvidenceJson(text);
    } catch (cause) {
        throw new AbstractionError(cause instanceof Error ? cause.message : "Invalid JSON.");
    }
    const pending = [{ value, depth: 0 }];
    while (pending.length > 0) {
        const item = pending.pop()!;
        requireAbstraction(item.depth <= 48, "JSON exceeds the nesting limit of 48.");
        if (
            item.value !== null &&
            typeof item.value === "object" &&
            !(item.value instanceof JsonNumber)
        ) {
            for (const child of Object.values(item.value)) {
                pending.push({ value: child, depth: item.depth + 1 });
            }
        }
    }
    return value;
}

export async function digest(bytes: BufferSource): Promise<string> {
    const hash = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(hash), (value) => value.toString(16).padStart(2, "0")).join(
        "",
    );
}
