import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { zipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";
import { loadPreparedConformance, prepareConformance } from "../tools/specs-conformance.js";

const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const manifest = {
    case_format_version: 1,
    evidence_schema: 3,
    rule_language: 1,
    behavior_version: "1.2.0",
    suites: {
        states: { directory: "cases", cases: ["state"] },
        actions: { directory: "action-cases", cases: ["action"] },
    },
};
function fixtureFiles(): Record<string, Uint8Array> {
    const files: Record<string, Uint8Array> = {
        "snapshot/conformance/manifest.json": encode(manifest),
    };
    for (const directory of ["cases/state", "action-cases/action"]) {
        for (const filename of ["input.json", "rules.json", "expected.json"]) {
            files[`snapshot/conformance/${directory}/${filename}`] = encode({});
        }
    }
    return files;
}
function release(id: number, published: string, draft = false) {
    return {
        id,
        tag_name: `release-${id}`,
        draft,
        published_at: published,
        zipball_url: `https://api.github.com/repos/ferpasri/testar-abstraction-specs/zipball/release-${id}`,
    };
}
const temporary: string[] = [];
async function cache() {
    const directory = await mkdtemp(path.join(tmpdir(), "abstraction-cases-"));
    temporary.push(directory);
    return directory;
}
afterEach(async () => {
    for (const directory of temporary.splice(0)) {
        if (
            !path
                .resolve(directory)
                .startsWith(path.resolve(tmpdir()) + path.sep + "abstraction-cases-")
        ) {
            throw new Error("Unexpected temporary directory.");
        }
        await rm(directory, { recursive: true, force: true });
    }
});
function downloads(files = fixtureFiles(), releases = [release(1, "2026-01-01T00:00:00Z")]) {
    const urls: string[] = [];
    const request: typeof fetch = async (input) => {
        const url = String(input);
        urls.push(url);
        return url.includes("/releases?")
            ? Response.json(releases)
            : new Response(new Uint8Array(zipSync(files)).buffer);
    };
    return { request, urls };
}

describe("published abstraction cases", () => {
    it("selects the newest published release including prereleases and records verified files", async () => {
        const directory = await cache();
        const latest = {
            ...release(2, "2026-02-01T00:00:00Z"),
            tag_name: "v-next-pre",
            prerelease: true,
        };
        const download = downloads(fixtureFiles(), [
            release(3, "2026-03-01T00:00:00Z", true),
            release(1, "2026-01-01T00:00:00Z"),
            latest,
        ]);
        await prepareConformance({ cache: directory, request: download.request });
        const prepared = await loadPreparedConformance(directory);
        expect(prepared.selection.release).toBe("v-next-pre");
        expect(prepared.manifest).toEqual(manifest);
        expect(Object.keys(prepared.selection.files)).toHaveLength(7);
        expect(prepared.selection.archive_sha256).toMatch(/^[0-9a-f]{64}$/u);
        expect(download.urls[1].endsWith("/zipball/release-2")).toBe(true);
    });
    it("rejects incomplete cases without replacing a previously verified selection", async () => {
        const directory = await cache();
        await prepareConformance({ cache: directory, ...downloads() });
        const before = await readFile(path.join(directory, "current.json"), "utf8");
        const files = fixtureFiles();
        delete files["snapshot/conformance/cases/state/expected.json"];
        await expect(prepareConformance({ cache: directory, ...downloads(files) })).rejects.toThrow(
            "Incomplete",
        );
        expect(await readFile(path.join(directory, "current.json"), "utf8")).toBe(before);
    });
    it("rejects unsafe archive paths before writing extracted data", async () => {
        const files = { ...fixtureFiles(), "snapshot/conformance/../../outside.json": encode({}) };
        await expect(
            prepareConformance({ cache: await cache(), ...downloads(files) }),
        ).rejects.toThrow("Unsafe");
    });
    it("detects modified prepared fixtures before conformance execution", async () => {
        const directory = await cache();
        await prepareConformance({ cache: directory, ...downloads() });
        const prepared = await loadPreparedConformance(directory);
        await writeFile(path.join(prepared.directory, "conformance/cases/state/input.json"), "{} ");
        await expect(loadPreparedConformance(directory)).rejects.toThrow(
            "Modified conformance file",
        );
    });
    it("reports absent releases and unsupported case formats explicitly", async () => {
        await expect(
            prepareConformance({ cache: await cache(), ...downloads(fixtureFiles(), []) }),
        ).rejects.toThrow("No published");
        const files = fixtureFiles();
        files["snapshot/conformance/manifest.json"] = encode({
            ...manifest,
            case_format_version: 99,
        });
        await expect(
            prepareConformance({ cache: await cache(), ...downloads(files) }),
        ).rejects.toThrow("Unsupported");
    });
});
