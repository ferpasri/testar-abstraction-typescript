import { JsonNumber } from "testar-evidence";
import { canonical } from "./common.js";
import { removePathParameters } from "./url.js";
import {
    ABSTRACTION_LIMITS,
    type Field,
    type FieldExplanation,
    type Predicate,
    type ProjectedField,
    type Reading,
    type Transform,
} from "./types.js";

export function selectProperty(
    properties: Record<string, unknown>,
    keys: string[],
): {
    key?: string;
    reading: Reading;
} {
    for (const key of keys) {
        if (Object.hasOwn(properties, key)) {
            return { key, reading: { kind: "value", value: properties[key] } };
        }
    }
    return { reading: { kind: "missing" } };
}

export function projectFields(
    properties: Record<string, unknown>,
    fields: Field[],
): {
    projection: ProjectedField[];
    explanations: FieldExplanation[];
    informative: boolean;
} {
    let informative = false;
    const projection: ProjectedField[] = [];
    const explanations: FieldExplanation[] = [];
    for (const field of fields) {
        const selected = selectProperty(properties, field.keys);
        for (const segment of field.path ?? []) {
            const value = selected.reading.value;
            if (
                selected.reading.kind === "missing" ||
                value === null ||
                typeof value !== "object" ||
                value instanceof JsonNumber ||
                !Object.hasOwn(value, segment)
            ) {
                selected.reading = { kind: "missing" };
                break;
            }
            selected.reading = {
                kind: "value",
                value: (value as Record<string, unknown>)[segment],
            };
        }
        if (selected.reading.kind === "missing") {
            if (field.required) {
                throw new Error("Required field '" + field.name + "' has no captured property.");
            }
            projection.push({ name: field.name, reading: { kind: "missing" } });
            explanations.push({ name: field.name, missing: true });
            continue;
        }
        let value = selected.reading.value;
        assertBoundedValue(value);
        for (const transform of field.transforms ?? []) {
            value = applyTransform(value, transform, field.name);
            assertBoundedValue(value);
        }
        informative = true;
        projection.push({ name: field.name, reading: { kind: "value", value } });
        explanations.push({
            name: field.name,
            key: selected.key,
            raw: selected.reading.value,
            value,
            missing: false,
        });
    }
    return { projection, explanations, informative };
}

export function matchesPredicate(
    properties: Record<string, unknown>,
    predicate: Predicate,
): boolean {
    const { reading } = selectProperty(properties, predicate.keys);
    if (reading.kind === "missing") {
        return false;
    }
    if (predicate.op === "present") {
        return true;
    }
    if (predicate.op === "contains") {
        return typeof reading.value === "string" && reading.value.includes(predicate.value);
    }
    return canonical(reading.value) === canonical(predicate.value);
}

function applyTransform(value: unknown, transform: Transform, field: string): string {
    if (typeof value !== "string") {
        throw new Error(
            "Field '" + field + "' needs a string for transformation '" + transform.op + "'.",
        );
    }
    switch (transform.op) {
        case "trim":
            return value.trim();
        case "collapse_whitespace":
            return value.replace(/\s+/gu, " ");
        case "lowercase":
            return value.toLowerCase();
        case "replace":
            return replaceLiteral(value, transform.find, transform.with);
        case "map":
            return Object.hasOwn(transform.values, value) ? transform.values[value] : value;
        case "url": {
            let address: URL;
            try {
                address = new URL(value);
            } catch {
                throw new Error("Field '" + field + "' does not contain an absolute URL.");
            }
            const pathname = removePathParameters(
                address.pathname,
                transform.remove_path_parameters ?? [],
            );
            if (pathname !== address.pathname) {
                address.pathname = pathname;
            }
            for (const key of transform.remove_query ?? []) {
                address.searchParams.delete(key);
            }
            if (transform.remove_fragment) {
                address.hash = "";
            }
            return address.href;
        }
    }
}

function assertBoundedValue(value: unknown): void {
    const encoded = canonical(value);
    if (
        encoded === undefined ||
        new TextEncoder().encode(encoded).byteLength > ABSTRACTION_LIMITS.normalizedValueBytes
    ) {
        throw new Error("A selected value exceeds the 1 MiB normalization limit.");
    }
}

function replaceLiteral(value: string, find: string, replacement: string): string {
    let count = 0;
    let offset = value.indexOf(find);
    while (offset !== -1) {
        count++;
        if (
            value.length + count * (replacement.length - find.length) >
            ABSTRACTION_LIMITS.normalizedValueBytes
        ) {
            throw new Error("A replacement exceeds the 1 MiB normalization limit.");
        }
        offset = value.indexOf(find, offset + find.length);
    }
    return value.split(find).join(replacement);
}
