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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..");
const CATALOG = join(ROOT, "test", "e2e", "fixtures", "addon_catalog.json");
// The Hetzner in-cluster data services are NOT marketplace add-ons — they are synthesized per
// component by hetznerDataServicesToAddOns — so nothing here ever rendered them, even though they
// are the charts most likely to break: the mapper hand-translates a value schema per chart, and
// hetzner-services.ts records that both the cache and the queue chart had ALREADY shipped broken
// once (a deleted Bitnami chart version, and a 404 default image). The same generated fixture the
// Go harness seeds is rendered here (#2397).
const HETZNER = join(ROOT, "test", "e2e", "fixtures", "hetzner_data_services.json");

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
	const valuesPath = join(dir, `${addon.label ?? addon.id}.yaml`.replace(/[^a-zA-Z0-9._-]/g, "_"));
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
	catalog = JSON.parse(readFileSync(CATALOG, "utf8"));
} catch {
	die(`could not read the generated catalog at ${CATALOG}. Run \`pnpm -F console export:addon-catalog\`.`);
}
if (!Array.isArray(catalog) || catalog.length === 0) {
	die("the generated catalog is empty — a render check over nothing reports success and means nothing.");
}

// The Hetzner specs carry REAL values (sizes, storage classes, replica counts) rather than a
// catalog default, so unlike the marketplace half this genuinely covers the resolver's output — the
// gap the header comment names as still unguarded.
let hetzner;
try {
	const fx = JSON.parse(readFileSync(HETZNER, "utf8"));
	// `chartedNotOffered` is where Harbor lives: #2397 wired its values but the `registry` kind is
	// still refused at deploy, so it is not part of the seeded max-config surface. It is exactly the
	// mapping that most needs asking, being the newest, so it is rendered here all the same.
	hetzner = [...fx.addons, ...(fx.chartedNotOffered ?? [])];
} catch {
	die(`could not read the generated Hetzner specs at ${HETZNER}. Run \`pnpm -F console export:hetzner-data-services\`.`);
}
if (!Array.isArray(hetzner) || hetzner.length === 0) {
	die("the generated Hetzner in-cluster spec list is empty — a render check over nothing reports success and means nothing.");
}

const specs = [
	...catalog.map((a) => ({ ...a, label: a.id })),
	...hetzner.map((a) => ({ ...a, label: `hetzner:${a.id}` })),
];

const dir = mkdtempSync(join(tmpdir(), "addon-render-"));
const failures = [];
try {
	for (const addon of specs) {
		const err = render(addon, dir);
		process.stdout.write(err ? `  ✗ ${addon.label}\n` : `  · ${addon.label}\n`);
		if (err) failures.push({ id: addon.label, chart: `${addon.chart}@${addon.version}`, err });
	}
} finally {
	rmSync(dir, { recursive: true, force: true });
}

if (failures.length > 0) {
	console.error(`\n✗ ${failures.length} of ${specs.length} chart(s) do not render with the values this repo emits:\n`);
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

console.log(
	`\n✓ all ${specs.length} charts render (${catalog.length} marketplace add-ons with their defaults, ` +
		`${hetzner.length} Hetzner in-cluster specs with their RESOLVED values).`,
);
