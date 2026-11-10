import { JsonNumber } from "testar-evidence";

/** Detach selected values once; cached projections never freeze or modify caller-owned input. */
export function immutableCopy<T>(value: T): T {
    const copies = new WeakMap<object, object>();
    const copy = (item: unknown): unknown => {
        if (item === null || typeof item !== "object" || item instanceof JsonNumber) {
            return item;
        }
        const previous = copies.get(item);
        if (previous) {
            return previous;
        }
        if (Array.isArray(item)) {
            const result: unknown[] = [];
            copies.set(item, result);
            for (const child of item) {
                result.push(copy(child));
            }
            return Object.freeze(result);
        }
        const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
        copies.set(item, result);
        for (const [key, child] of Object.entries(item)) {
            result[key] = copy(child);
        }
        return Object.freeze(result);
    };
    return copy(value) as T;
}

/** New model containers are owned here; previously frozen projections can be shared unchanged. */
export function freezeSnapshot<T>(value: T): T {
    const freeze = (item: unknown): void => {
        if (item === null || typeof item !== "object" || Object.isFrozen(item)) {
            return;
        }
        for (const child of Object.values(item)) {
            freeze(child);
        }
        Object.freeze(item);
    };
    freeze(value);
    return value;
}
