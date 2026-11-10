import { JsonNumber } from "testar-evidence";
import type { ObservationGroup } from "./types.js";

export function groupLabel(group: ObservationGroup, index: number): string {
    const fields = group.members[0]?.stateFields.filter((field) => !field.missing) ?? [];
    const title = fields.find(
        (field) =>
            field.key === "ui.title" &&
            typeof field.value === "string" &&
            field.value.trim().length > 0,
    );
    const values: string[] = title ? [compactValue(title.value)] : [];
    for (const field of fields) {
        if (values.length === 2) {
            break;
        }
        if (field !== title && !(field.key === "ui.title" && field.value === "")) {
            values.push(field.name + ": " + compactValue(field.value));
        }
    }
    return clip(values.join(" / ") || "Group " + (index + 1), 110);
}

export function edgeLabel(kind: string, count: number): string {
    return clip(kind, 64) + (count > 1 ? " Ã— " + count : "");
}

function compactValue(value: unknown): string {
    if (value instanceof JsonNumber) {
        return clip(value.text, 80);
    }
    if (Array.isArray(value)) {
        return "[" + value.length + " values]";
    }
    if (value !== null && typeof value === "object") {
        return "{" + Object.keys(value).length + " properties}";
    }
    return clip(String(value).replace(/\s+/gu, " "), 80);
}

function clip(value: string, maximum: number): string {
    return value.length > maximum ? value.slice(0, maximum - 1) + "â€¦" : value;
}
