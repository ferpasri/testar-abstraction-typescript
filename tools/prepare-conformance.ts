import { prepareConformance } from "./specs-conformance.ts";

try {
    const { selection, manifest } = await prepareConformance();
    const count = Object.values(manifest.suites).reduce(
        (total, suite) => total + suite.cases.length,
        0,
    );
    console.log(`Prepared ${selection.release}: ${count} shared abstraction cases.`);
} catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
}
