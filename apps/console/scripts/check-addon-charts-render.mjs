// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Every marketplace add-on's default values must RENDER against its pinned chart.
//
// This exists because #2058 shipped and nothing caught it. Loki's catalog entry set
// `deploymentMode: SingleBinary` together with non-zero `read`/`write`/`backend` replicas — two
// values that are each perfectly valid and jointly rejected by the chart's own `validate.yaml`.
// `helm template` exited non-zero, ArgoCD had no target state to compare against and reported
// `sync=Unknown`, and Loki could not install on any cloud, for any customer.
//
// Nothing in this repo could have seen it. Type-checking passes: the values are well-typed. Unit
// tests pass: they assert what the resolver emits, not what the chart accepts. The offer-parity and
// config-carriage guards both pass: neither measures add-on values. The only thing that knows the
// combination is illegal is the chart, and until this script nothing ever asked it. A comment in
// tests/lib/addons/addon-secrets.test.ts says the chart shapes were "verified against the pinned
// charts via `helm template`" — by hand, once, at the time.
//
// So the check is: for each entry, hand `helm template` the pinned chart + the catalog's own
// defaults and require an exit code of zero. It fetches real charts, which is why it lives in its
// own CI job with helm on PATH rather than inside the console's vitest run.
//
// It renders the DEFAULTS only. `toValues(config)` output is not covered, because that needs a
// user config to be meaningful — worth adding once there is a fixture per add-on, and worth saying
// plainly that a value only reachable through `toValues` is still unguarded today.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..");
const CATALOG = join(ROOT, "test", "e2e", "fixtures", "addon_catalog.json");

/** Fail loudly with a reason, never a silent skip — a renderer that renders nothing proves nothing. */
function die(msg) {
	console.error(`✗ addon chart render: ${msg}`);
	process.exit(1);
}

/** Is helm on PATH? Its absence must be an error here, not a pass. */
function requireHelm() {
	try {
		execFileSync("helm", ["version", "--short"], { stdio: "pipe" });
	} catch {
		die("`helm` is not on PATH. This check renders real charts; without helm it would pass by doing nothing, which is the failure mode it exists to prevent.");
	}
}

/** Render one add-on's pinned chart with its catalog defaults. Returns null on success, else stderr. */
function render(addon, dir) {
	const valuesPath = join(dir, `${addon.id}.yaml`);
	writeFileSync(valuesPath, JSON.stringify(addon.values ?? {}));
	try {
		execFileSync(
			"helm",
			[
				"template",
				addon.id,
				addon.chart,
				"--repo",
				addon.chartRepo,
				"--version",
				addon.version,
				"--namespace",
				addon.namespace,
				"-f",
				valuesPath,
			],
			{ stdio: "pipe", timeout: 180_000 },
		);
		return null;
	} catch (err) {
		const stderr = String(err.stderr ?? err.message ?? "");
		return stderr.trim().split("\n").slice(0, 6).join("\n");
	}
}

requireHelm();

let catalog;
try {
	catalog = JSON.parse(execFileSync("cat", [CATALOG], { encoding: "utf8" }));
} catch {
	die(`could not read the generated catalog at ${CATALOG}. Run \`pnpm -F console export:addon-catalog\`.`);
}
if (!Array.isArray(catalog) || catalog.length === 0) {
	die("the generated catalog is empty — a render check over nothing reports success and means nothing.");
}

const dir = mkdtempSync(join(tmpdir(), "addon-render-"));
const failures = [];
try {
	for (const addon of catalog) {
		const err = render(addon, dir);
		process.stdout.write(err ? `  ✗ ${addon.id}\n` : `  · ${addon.id}\n`);
		if (err) failures.push({ id: addon.id, chart: `${addon.chart}@${addon.version}`, err });
	}
} finally {
	rmSync(dir, { recursive: true, force: true });
}

if (failures.length > 0) {
	console.error(`\n✗ ${failures.length} of ${catalog.length} add-on(s) do not render with their own default values:\n`);
	for (const f of failures) {
		console.error(`  ${f.id}  (${f.chart})`);
		for (const line of f.err.split("\n")) console.error(`      ${line}`);
		console.error("");
	}
	console.error(
		"A chart that does not render produces NO manifest, so ArgoCD reports `sync=Unknown` rather than\n" +
			"OutOfSync and the add-on silently never installs. Fix the values against the chart, not the check.",
	);
	process.exit(1);
}

console.log(`\n✓ all ${catalog.length} add-ons render with their pinned chart and default values.`);
