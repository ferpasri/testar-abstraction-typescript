import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { unzipSync } from "fflate";

export const DEFAULT_CACHE = fileURLToPath(new URL("../.cache/specs/", import.meta.url));
const RELEASES = "https://api.github.com/repos/ferpasri/testar-abstraction-specs/releases";
const ARCHIVES = "https://api.github.com/repos/ferpasri/testar-abstraction-specs/zipball/";
const decoder = new TextDecoder("utf-8", { fatal: true });
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

export interface CaseManifest {
    case_format_version: number;
    evidence_schema: number;
    rule_language: number;
    behavior_version: string;
    suites: Record<"states" | "actions", { directory: string; cases: string[] }>;
}
interface Release {
    id: number;
    tag_name: string;
    draft: boolean;
    published_at: string | null;
    zipball_url: string;
}
interface Selection {
    release: string;
    directory: string;
    archive_sha256: string;
    files: Record<string, string>;
}

function safeRelative(value: string): boolean {
    return (
        !/[\\:\u0000-\u001f]/u.test(value) &&
        value.split("/").every((part) => part.length > 0 && part !== "." && part !== "..")
    );
}

async function download(request: typeof fetch, url: string, limit: number): Promise<Uint8Array> {
    const response = await request(url, {
        headers: {
            Accept: "application/vnd.github+json",
            "User-Agent": "testar-abstraction-typescript",
        },
        signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok || !response.body) {
        throw new Error(`Specs download failed: HTTP ${response.status}`);
    }
    const chunks: Uint8Array[] = [];
    let length = 0;
    for await (const chunk of response.body) {
        length += chunk.length;
        if (length > limit) {
            throw new Error("Specs download exceeds its size limit.");
        }
        chunks.push(chunk);
    }
    return new Uint8Array(Buffer.concat(chunks));
}

function validateCases(files: Record<string, Uint8Array>): CaseManifest {
    const definition = files["conformance/manifest.json"];
    if (!definition) {
        throw new Error("Specs release has no conformance manifest.");
    }
    const manifest = JSON.parse(decoder.decode(definition)) as CaseManifest;
    if (
        manifest.case_format_version !== 1 ||
        !Number.isInteger(manifest.evidence_schema) ||
        !Number.isInteger(manifest.rule_language) ||
        typeof manifest.behavior_version !== "string"
    ) {
        throw new Error("Unsupported or invalid conformance manifest.");
    }
    const listed = new Set<string>();
    for (const suite of ["states", "actions"] as const) {
        const entry = manifest.suites?.[suite];
        if (
            !entry ||
            !["cases", "action-cases"].includes(entry.directory) ||
            !Array.isArray(entry.cases) ||
            entry.cases.length === 0
        ) {
            throw new Error(`Invalid conformance suite: ${suite}`);
        }
        for (const name of entry.cases) {
            if (typeof name !== "string" || !/^[a-z0-9-]+$/u.test(name)) {
                throw new Error("Unsafe or invalid conformance case name.");
            }
            const directory = `conformance/${entry.directory}/${name}`;
            if (listed.has(directory)) {
                throw new Error("Duplicate conformance case.");
            }
            listed.add(directory);
            for (const filename of ["input.json", "rules.json", "expected.json"]) {
                const bytes = files[`${directory}/${filename}`];
                if (!bytes) {
                    throw new Error(`Incomplete conformance case: ${directory}/${filename}`);
                }
                JSON.parse(decoder.decode(bytes));
            }
        }
    }
    for (const name of Object.keys(files)) {
        const match = /^(conformance\/(?:cases|action-cases)\/[^/]+)\//u.exec(name);
        if (match && !listed.has(match[1])) {
            throw new Error(`Unlisted conformance case: ${match[1]}`);
        }
    }
    return manifest;
}

function extractCases(archive: Uint8Array): Record<string, Uint8Array> {
    const names = new Set<string>();
    let expanded = 0;
    const entries = unzipSync(archive, {
        filter: (entry) => {
            if (!/^[^/]+\/conformance\//u.test(entry.name) || entry.name.endsWith("/")) {
                return false;
            }
            const relative = entry.name.split("/").slice(1).join("/");
            if (!safeRelative(relative) || names.has(relative)) {
                throw new Error("Unsafe or duplicate conformance archive path.");
            }
            names.add(relative);
            expanded += entry.originalSize;
            if (
                entry.originalSize > 8 * 1024 ** 2 ||
                expanded > 128 * 1024 ** 2 ||
                names.size > 10_000
            ) {
                throw new Error("Specs archive exceeds extraction limits.");
            }
            return true;
        },
    });
    return Object.fromEntries(
        Object.entries(entries).map(([name, bytes]) => [name.split("/").slice(1).join("/"), bytes]),
    );
}

export async function prepareConformance(options: { cache?: string; request?: typeof fetch } = {}) {
    const cache = options.cache ?? DEFAULT_CACHE;
    const request = options.request ?? fetch;
    const releases: Release[] = [];
    for (let page = 1; page <= 20; page++) {
        const data = JSON.parse(
            decoder.decode(
                await download(request, `${RELEASES}?per_page=100&page=${page}`, 4 * 1024 ** 2),
            ),
        ) as Release[];
        if (!Array.isArray(data)) {
            throw new Error("Invalid specs release listing.");
        }
        releases.push(...data);
        if (data.length < 100) {
            break;
        }
        if (page === 20) {
            throw new Error("Specs release discovery exceeds its page limit.");
        }
    }
    const release = releases
        .filter((item) => !item.draft && item.published_at)
        .sort(
            (a, b) => Date.parse(b.published_at!) - Date.parse(a.published_at!) || b.id - a.id,
        )[0];
    if (!release || !release.zipball_url?.startsWith(ARCHIVES)) {
        throw new Error("No published testar-abstraction-specs release was found.");
    }
    const archive = await download(request, release.zipball_url, 64 * 1024 ** 2);
    const files = extractCases(archive);
    const manifest = validateCases(files);
    const directory = `${release.id}-${randomUUID()}`;
    const output = path.join(cache, directory);
    const hashes: Record<string, string> = {};
    for (const [name, bytes] of Object.entries(files)) {
        const destination = path.join(output, name);
        await mkdir(path.dirname(destination), { recursive: true });
        await writeFile(destination, bytes);
        hashes[name] = digest(bytes);
    }
    const selection: Selection = {
        release: release.tag_name,
        directory,
        archive_sha256: digest(archive),
        files: hashes,
    };
    const temporary = path.join(cache, `selection-${randomUUID()}.json`);
    await writeFile(temporary, JSON.stringify(selection, null, 4) + "\n");
    await rename(temporary, path.join(cache, "current.json"));
    return { selection, manifest };
}

export async function loadPreparedConformance(cache = DEFAULT_CACHE) {
    let selection: Selection;
    try {
        selection = JSON.parse(
            await readFile(path.join(cache, "current.json"), "utf8"),
        ) as Selection;
    } catch (cause) {
        throw new Error("Shared cases are not prepared. Run npm run prepare:conformance.", {
            cause,
        });
    }
    if (
        !/^[0-9]+-[0-9a-f-]+$/u.test(selection.directory) ||
        !/^[0-9a-f]{64}$/u.test(selection.archive_sha256) ||
        typeof selection.release !== "string" ||
        !selection.files ||
        Object.keys(selection.files).length > 10_000
    ) {
        throw new Error("Invalid prepared conformance metadata.");
    }
    const directory = path.join(cache, selection.directory);
    const files: Record<string, Uint8Array> = {};
    for (const [name, hash] of Object.entries(selection.files)) {
        if (!name.startsWith("conformance/") || !safeRelative(name)) {
            throw new Error("Unsafe prepared conformance path.");
        }
        const bytes = await readFile(path.join(directory, name));
        if (digest(bytes) !== hash) {
            throw new Error(`Modified conformance file: ${name}`);
        }
        files[name] = bytes;
    }
    return { directory, manifest: validateCases(files), selection };
}
