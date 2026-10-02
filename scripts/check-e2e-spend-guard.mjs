#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
//
// check-e2e-spend-guard — one invariant, enforced:
//
//   "Every cloud the e2e matrix can apply to carries a PRE-APPLY SPEND CONTROL."
//
// WHY THIS EXISTS. The weekly `17 5 * * 0` full-bar cron fired ALETHIA_E2E_MAX_CONFIG=1 +
// ALETHIA_E2E_ALL_ADDONS=1 across the whole five-cloud matrix, while the pre-apply cost ceiling
// (ALETHIA_COST_CEILING_MONTHLY_USD, enforced by packages/core/provisioner/cost_ceiling.go) was
// wired for `matrix.provider == 'aws'` and nothing else. So on gcp, azure, alibaba and hetzner a
// weekly run provisioned the entire 11-kind surface with NO spend gate at all. It also bought a
// standing monthly resource on alibaba every week — `alicloud_cr_ee_instance` with
// `payment_type = "Subscription"` — and the sweep that even DETECTS a survivor only landed on
// 2026-08-11 (#2340). Two runs (2026-08-09, 2026-08-16) produced #2382/#2383/#2384 and no
// committed proof row.
//
// #2385 closed the hole per cloud. Until then this script carried an UNPRICED_EXEMPTIONS list — four
// of the five clouds "accepted" as unguarded on a watched dispatch. That list is GONE, and so is the
// mechanism: there is no way to exempt a cloud any more, only to control it.
//
// ── What counts as a control (maintainer ruling on #2385, 2026-09-23) ──
//
//   A cloud Infracost can price is controlled by a COST CEILING — a branch for it in the
//   ALETHIA_COST_CEILING_MONTHLY_USD expression. A cloud Infracost cannot price may instead be
//   controlled by a pre-apply SHAPE control (packages/core/provisioner/spend_policy.go):
//
//     ALETHIA_SPEND_HCLOUD_SERVER_TYPES  hetzner  server-type allowlist
//     ALETHIA_SPEND_REFUSE_PREPAID       alibaba  refuses Subscription / PrePaid purchases
//
// ── The rules ──
//
//   R1  every scheduled-matrix cloud has a control — a ceiling branch or its shape control. A new
//       sixth cloud therefore fails here until somebody decides its spend story.
//   R2  every control is REAL, not a name:
//         · a ceiling branch must carry a positive numeric default — `vars.X || '300'` — because an
//           unset variable evaluates to '' and cost_ceiling.go reads '' as "guard disabled", so a
//           branch with no default is a control on paper only;
//         · a shape control must carry a non-empty literal default for the same reason;
//         · a branch naming a cloud that is NOT in the matrix is stale (how a real hole hides
//           behind a reviewed-looking list), and a shape control naming a cloud it cannot guard (a
//           hetzner server-type cap on an aws leg) controls nothing.
//   R3  a control that a waiver can switch off may be waived ONLY by a dispatch input. `vars.`,
//       `secrets.` and `env.` apply to every scheduled run too, so a waiver through one of those
//       would turn the control off for a timer — which is exactly the run nobody is watching. On
//       `schedule` every `inputs.*` is empty, so an input waiver cannot fire there.
//   R4  the hetzner cap's DEFAULT admits every server type the e2e itself provisions, re-derived
//       from the files that choose them (HETZNER_TYPE_SOURCES). Without this the cap and a fixture
//       can drift apart, and the first anyone hears of it is a red paid dispatch.
//   R5  aws capacity type (#5316): every aws shape pins `capacity_type: spot` except ONE default
//       cell, and each shape's worst-case monthly cost fits under the ceiling default its leg is
//       priced against. The rules and the per-case cost assumption are stated at analyseAwsCapacity.
//
// Dispatches are NOT out of scope any more: a dispatched leg reads the same env, so a control is in
// force for a human-started run as well — the alibaba waiver is the only hatch, and it is per-run.
//
// A scheduled full bar (FULL_BAR_CRON, read from scripts/e2e/resolve-dimension.sh) is therefore no
// longer refused by THIS guard once R1–R4 hold: that was the ruling. Restoring the cron still needs
// the other gate #2385 names — a committed full-bar PASS row per cloud — which this guard does not
// read, and the note it prints says so rather than letting a green read as permission.
//
// Run: `node scripts/check-e2e-spend-guard.mjs` · `--self-test` (wired into ci.yml → guards)

import fs from "node:fs";
import path from "node:path";

const WORKFLOW = ".github/workflows/e2e-nightly.yml";
const RESOLVER = "scripts/e2e/resolve-dimension.sh";
const CEILING_ENV = "ALETHIA_COST_CEILING_MONTHLY_USD";

/**
 * The pre-apply shape controls, keyed by the env var the runner reads. `cloud` is the ONE cloud
 * the control can guard; `dispatchOnlyWaiver` marks a control whose expression may carry a waiver,
 * which R3 then restricts to dispatch inputs.
 * @type {Record<string, {cloud: string, dispatchOnlyWaiver: boolean}>}
 */
export const SHAPE_CONTROLS = {
	ALETHIA_SPEND_HCLOUD_SERVER_TYPES: { cloud: "hetzner", dispatchOnlyWaiver: false },
	ALETHIA_SPEND_REFUSE_PREPAID: { cloud: "alibaba", dispatchOnlyWaiver: true },
};

/**
 * The files that choose a hetzner server type for the e2e — the domain R4 derives from. This is a
 * HAND-WRITTEN list, and that is its limit: a new file that picks a type is invisible until it is
 * added here. Each extractor must find at least one type or the run throws, so a file that is
 * renamed or reshaped cannot quietly shrink the domain to nothing.
 * @type {{file: string, extract: (text: string) => string[]}[]}
 */
const HETZNER_TYPE_SOURCES = [
	{ file: "infra/templates/project/hetzner/variables.tf", extract: extractTfServerTypeDefaults },
	// hetzner_provider.go substitutes the CATALOG default for an empty list (#5266) — it used to carry
	// its own `workerType := "cpx22"` literal, which is what this row read. The catalog is now the one
	// place that default lives, so the catalog is what is read.
	{ file: "packages/core/catalog/catalog.json", extract: extractCatalogHetznerDefault },
	{ file: "test/e2e/maxconfig.go", extract: extractMaxconfigHetzner },
];
const HETZNER_FIXTURE_DIR = "test/e2e/fixtures";
const HETZNER_FIXTURE_RE = /^cluster_json\..+\.hetzner\.json$/;

/** @returns {string[]} non-comment `- cron: "..."` values declared in the workflow. */
export function scheduledCrons(workflowText) {
	return workflowText
		.split("\n")
		.filter((l) => !/^\s*#/.test(l))
		.map((l) => l.match(/^\s*-\s*cron:\s*["']([^"']+)["']/))
		.filter((m) => m !== null)
		.map((m) => m[1].trim());
}

/** @returns {string} the cron resolve-dimension.sh maps to the full bar. */
export function fullBarCron(resolverText) {
	const m = resolverText.match(/^FULL_BAR_CRON="([^"]+)"/m);
	if (m === null) {
		throw new Error(`${RESOLVER}: FULL_BAR_CRON is not declared — this guard cannot resolve which cron is the full bar`);
	}
	return m[1].trim();
}

/**
 * The providers a SCHEDULED run fans out to. The matrix expression is a dispatch/schedule ternary:
 * `... workflow_dispatch && fromJSON(one input) || fromJSON('["hetzner",...]')`. The `||` fallback
 * literal is the scheduled set, so we take the LAST JSON array on the line — never the dispatch
 * branch, which is one input-chosen provider (and is always one of the scheduled five).
 * @returns {string[]}
 */
export function scheduledMatrixProviders(workflowText) {
	const line = workflowText.split("\n").find((l) => !/^\s*#/.test(l) && /^\s*provider:\s*\$\{\{/.test(l));
	if (line === undefined) {
		throw new Error(`${WORKFLOW}: no \`provider:\` matrix expression found`);
	}
	const arrays = [...line.matchAll(/fromJSON\('(\[[^']*\])'\)/g)];
	if (arrays.length === 0) {
		throw new Error(`${WORKFLOW}: the \`provider:\` matrix declares no literal fromJSON array — cannot determine the scheduled set`);
	}
	return JSON.parse(arrays[arrays.length - 1][1]);
}

/**
 * The value of the first non-comment `NAME: ...` line, or undefined when no such line exists.
 * @param {string} workflowText
 * @param {string} name
 * @returns {string | undefined}
 */
export function envValue(workflowText, name) {
	const re = new RegExp(`^\\s*${name}:\\s*(.*)$`);
	for (const l of workflowText.split("\n")) {
		if (/^\s*#/.test(l)) {
			continue;
		}
		const m = l.match(re);
		if (m !== null) {
			return m[1];
		}
	}
	return undefined;
}

/**
 * Split an expression into its per-provider branches: each `matrix.provider == 'x'` owns the text
 * from just after it to the next such test. The last branch also owns the trailing `|| ''`, which
 * is why defaults are read as NON-EMPTY literals only.
 * @param {string} expr
 * @returns {Map<string, string>} provider → its branch text
 */
export function providerBranches(expr) {
	const hits = [...expr.matchAll(/matrix\.provider\s*==\s*'([a-z0-9-]+)'/g)];
	const out = new Map();
	hits.forEach((m, i) => {
		const start = (m.index ?? 0) + m[0].length;
		const end = i + 1 < hits.length ? hits[i + 1].index ?? expr.length : expr.length;
		out.set(m[1], (out.get(m[1]) ?? "") + expr.slice(start, end));
	});
	return out;
}

/**
 * Non-empty single-quoted literals in an expression branch.
 * @param {string} branch
 * @returns {string[]}
 */
function literals(branch) {
	return [...branch.matchAll(/'([^']*)'/g)].map((m) => m[1]).filter((s) => s.trim() !== "");
}

/**
 * Evaluate R1–R4 against already-read inputs. Pure, so `--self-test` drives it with fixtures.
 * @param {{workflowText: string, resolverText: string, hetznerTypes: {source: string, type: string}[]}} input
 * @returns {{failures: string[], notes: string[]}}
 */
export function analyse({ workflowText, resolverText, hetznerTypes }) {
	const failures = [];
	const notes = [];

	const crons = scheduledCrons(workflowText);
	const fullCron = fullBarCron(resolverText);
	const matrix = scheduledMatrixProviders(workflowText);

	/** @type {Map<string, string[]>} cloud → the controls that guard it */
	const controlledBy = new Map();
	const addControl = (cloud, what) => controlledBy.set(cloud, [...(controlledBy.get(cloud) ?? []), what]);

	// ── The cost ceiling. ──
	const ceiling = envValue(workflowText, CEILING_ENV);
	if (ceiling === undefined) {
		failures.push(`R1: ${CEILING_ENV} is not set anywhere in ${WORKFLOW} — no cloud has a cost ceiling.`);
	} else {
		for (const [p, branch] of providerBranches(ceiling)) {
			if (!matrix.includes(p)) {
				failures.push(`R2 ${p}: ${CEILING_ENV} has a branch for a cloud that is NOT in the scheduled matrix — a stale control; delete it.`);
				continue;
			}
			const numeric = literals(branch).filter((s) => /^\d+(\.\d+)?$/.test(s) && Number(s) > 0);
			if (numeric.length === 0) {
				failures.push(
					`R2 ${p}: the ${CEILING_ENV} branch has no positive numeric default (like \`vars.X || '300'\`). ` +
						`An unset variable evaluates to '' and cost_ceiling.go reads '' as "disabled", so this is a ceiling on paper only.`,
				);
				continue;
			}
			addControl(p, `cost ceiling (default ${numeric.join("/")} USD/mo)`);
		}
	}

	// ── The shape controls. ──
	for (const [env, spec] of Object.entries(SHAPE_CONTROLS)) {
		const expr = envValue(workflowText, env);
		if (expr === undefined) {
			notes.push(`${env} is not set — ${spec.cloud} has no shape control from it`);
			continue;
		}
		const branches = providerBranches(expr);
		if (branches.size === 0) {
			failures.push(`R2 ${spec.cloud}: ${env} is set but names no \`matrix.provider == '${spec.cloud}'\` — it is on for every leg or none, and guards nothing in particular.`);
			continue;
		}
		for (const [p, branch] of branches) {
			if (p !== spec.cloud) {
				failures.push(`R2 ${p}: ${env} has a branch for ${p}, but it can only guard ${spec.cloud} — on a ${p} leg it reads nothing.`);
				continue;
			}
			if (!matrix.includes(p)) {
				failures.push(`R2 ${p}: ${env} guards a cloud that is NOT in the scheduled matrix — a stale control; delete it.`);
				continue;
			}
			if (literals(branch).length === 0) {
				failures.push(`R2 ${p}: ${env} has no non-empty literal default, so with its variables unset it evaluates to '' — a control on paper only.`);
				continue;
			}
			if (spec.dispatchOnlyWaiver) {
				// The WHOLE expression, not the provider branch: a waiver written BEFORE the
				// `matrix.provider == …` test (`vars.X != 'true' && matrix.provider == 'alibaba' && …`)
				// sits outside the branch text and switches the refusal off just as well (PR #4977 review).
				const standing = [...expr.matchAll(/\b(vars|secrets|env)\.[A-Za-z0-9_]+/g)].map((m) => m[0]);
				if (standing.length > 0) {
					failures.push(
						`R3 ${p}: ${env} can be switched off by ${[...new Set(standing)].join(", ")}, which also applies to every SCHEDULED run. ` +
							`Its waiver must be a dispatch input (\`inputs.*\`), which is empty on a schedule.`,
					);
					continue;
				}
			}
			addControl(p, `pre-apply ${env}`);
		}
	}

	// R1 — every matrix cloud is controlled.
	for (const p of matrix.filter((p) => !controlledBy.has(p))) {
		failures.push(
			`R1 ${p}: in the scheduled matrix with NO pre-apply spend control — neither a ${CEILING_ENV} branch nor a shape control ` +
				`(${Object.keys(SHAPE_CONTROLS).join(", ")}). Add one; there is no exemption list any more.`,
		);
	}

	// R4 — the hetzner cap's default admits what the e2e provisions.
	const capExpr = envValue(workflowText, "ALETHIA_SPEND_HCLOUD_SERVER_TYPES");
	const capBranch = capExpr === undefined ? undefined : providerBranches(capExpr).get("hetzner");
	if (capBranch !== undefined) {
		const lists = literals(capBranch).filter((s) => /^[a-z0-9]+(\s*,\s*[a-z0-9]+)*$/i.test(s.trim()));
		if (lists.length === 0) {
			failures.push(`R4 hetzner: the ALETHIA_SPEND_HCLOUD_SERVER_TYPES branch has no literal type list to check the e2e's types against.`);
		} else {
			const cap = new Set(lists.flatMap((s) => s.split(",")).map((t) => t.trim().toLowerCase()));
			if (hetznerTypes.length === 0) {
				failures.push(`R4 hetzner: no server type was derived from the e2e's sources — the check would pass on nothing.`);
			}
			for (const { source, type } of hetznerTypes.filter((h) => !cap.has(h.type.toLowerCase()))) {
				failures.push(
					`R4 hetzner: ${source} provisions server type "${type}", which the cap's default [${[...cap].join(", ")}] refuses — ` +
						`the leg would go red at apply. Widen the default, or pick a type inside it.`,
				);
			}
			notes.push(`hetzner cap default: ${[...cap].join(", ")} · e2e provisions: ${[...new Set(hetznerTypes.map((h) => h.type))].join(", ")}`);
		}
	}

	// The full-bar cron is no longer refused here, and the note says what that does NOT mean.
	if (crons.includes(fullCron)) {
		notes.push(
			`a cron ("${fullCron}") SCHEDULES the full bar. Every cloud is controlled, so this guard allows it — but #2385 also ` +
				`requires a committed full-bar PASS row per cloud, which this guard does not read.`,
		);
	} else {
		notes.push(`no scheduled cron resolves to the full bar (looked for "${fullCron}") — it is dispatch-only.`);
	}
	notes.push(`scheduled crons: ${crons.length === 0 ? "(none)" : crons.map((c) => `"${c}"`).join(", ")}`);
	notes.push(`scheduled matrix: ${matrix.join(", ")}`);
	for (const p of matrix) {
		notes.push(`${p}: ${(controlledBy.get(p) ?? ["NO CONTROL"]).join(" + ")}`);
	}

	return { failures, notes };
}

// ───────────────────────────── hetzner type extraction ─────────────────────────────

/** @returns {string[]} the defaults of every `*_server_type` variable in a terraform file. */
export function extractTfServerTypeDefaults(text) {
	return [...text.matchAll(/variable\s+"[a-z_]*server_type"\s*\{[^}]*?default\s*=\s*"([^"]+)"/g)].map((m) => m[1]);
}

/** @returns {string[]} `compute.hetzner.default_instance` from catalog.json — the server type
 * hetzner_provider.go provisions for a cluster that pins none. Empty when the key is missing, which
 * readHetznerTypes turns into a refusal rather than a smaller domain. */
export function extractCatalogHetznerDefault(text) {
	const value = JSON.parse(text)?.compute?.hetzner?.default_instance;
	return typeof value === "string" && value !== "" ? [value] : [];
}

/**
 * @returns {string[]} the `instanceTypes = []string{...}` maxconfig.go assigns inside any
 * `case "hetzner":` arm. The file has several hetzner arms (k8s version, database, cache); only an
 * `instanceTypes` assignment is a server type, so the others contribute nothing.
 */
export function extractMaxconfigHetzner(text) {
	const arms = [...text.matchAll(/case\s+"hetzner":([\s\S]*?)(?=\n\s*case\s+"|\n\s*default:|\n\s*\})/g)];
	return arms.flatMap((arm) =>
		[...arm[1].matchAll(/instanceTypes\s*=\s*\[\]string\{([^}]*)\}/g)].flatMap((a) => [...a[1].matchAll(/"([^"]+)"/g)].map((q) => q[1])),
	);
}

/**
 * Read every hetzner server type the e2e provisions, from HETZNER_TYPE_SOURCES and the hetzner
 * cluster_json fixtures. Throws when a source yields nothing — a reshaped file must not shrink the
 * domain silently.
 * @returns {{source: string, type: string}[]}
 */
function readHetznerTypes() {
	const out = [];
	for (const { file, extract } of HETZNER_TYPE_SOURCES) {
		const types = extract(fs.readFileSync(file, "utf8"));
		if (types.length === 0) {
			throw new Error(`${file}: no hetzner server type found — the extractor no longer matches this file; fix it rather than let R4 check less`);
		}
		out.push(...types.map((type) => ({ source: file, type })));
	}
	const fixtures = fs.readdirSync(HETZNER_FIXTURE_DIR).filter((f) => HETZNER_FIXTURE_RE.test(f));
	if (fixtures.length === 0) {
		throw new Error(`${HETZNER_FIXTURE_DIR}: no cluster_json.*.hetzner.json fixture found`);
	}
	for (const f of fixtures) {
		const file = path.join(HETZNER_FIXTURE_DIR, f);
		const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
		const types = Array.isArray(parsed.instance_types) ? parsed.instance_types.filter((t) => typeof t === "string") : [];
		if (types.length === 0) {
			throw new Error(`${file}: no instance_types — a hetzner shape fixture that picks no type`);
		}
		out.push(...types.map((type) => ({ source: file, type })));
	}
	return out;
}

// ───────────────────────────── R5: aws capacity type and its cost (#5316) ─────────────────────────────
//
// #5266 moved the aws node group's template default from SPOT to ON_DEMAND. The e2e pins
// `capacity_type: spot` on every aws shape except ONE default cell (the workflow's
// AWS_DEFAULT_CAPACITY_DIMENSION, on its cheapest shape), which states none so the default path stays
// proven. R5 holds that decision and states the cost assumption per case:
//
//   R5a every aws shape states capacity_type "spot", except the default cell, which states NONE.
//   R5b every aws instance type the e2e provisions has a price below, so the math is never skipped.
//   R5c each shape's WORST-CASE monthly estimate fits under the ceiling default its leg is priced
//       against (the lower aws default for the cheapest shape, the higher for the heavy and demo
//       fixtures — the same split the ALETHIA_COST_CEILING_MONTHLY_USD expression makes).
//
// THE COST ASSUMPTION, PER CASE. Infracost prices an aws_eks_node_group at the purchase option its
// capacity_type names (eks_node_group.go: PurchaseOption = lower(capacity_type)), so the estimate
// cost_ceiling.go compares is the on-demand price for the default cell and a spot price for the rest.
// A spot price is not a constant, so R5c does not use one: an EKS managed node group's spot max price
// defaults to the on-demand price, so on-demand is the most a spot node can bill. R5c prices EVERY
// cell at on-demand. That is exact for the default cell and an upper bound for the spot cells, so a
// pass holds whatever the spot market does. What R5c does NOT include: the add-ons, databases and
// other managed resources a max-config run adds on top of the nodes — the ceiling's headroom above
// these figures is what is left for them, and the note prints that headroom.
//
// us-east-1 (the nightly's aws default region) on-demand list prices, USD per hour, Linux.
export const AWS_ON_DEMAND_USD_PER_HOUR = { "t3.large": 0.0832, "t3.xlarge": 0.1664 };
// Always-on per-cluster costs: the EKS control plane, and the ONE NAT gateway the nightly asks for
// (single_nat_gateway, the workflow's aws NET override).
export const AWS_FIXED_USD_PER_HOUR = { eks_control_plane: 0.1, nat_gateway: 0.045 };
// Infracost's month.
export const HOURS_PER_MONTH = 730;

// Every aws shape fixture. Each one is loaded only by a heavy-shape or fabric-demo leg, which the
// ceiling expression prices against the HIGHER default — so every fixture is a "high" cell.
const AWS_FIXTURE_DIR = "test/e2e/fixtures";
const AWS_FIXTURE_RE = /^cluster_json\..+\.aws\.json$/;

/**
 * The aws cheapest shape and the default-capacity dimension, from the `Compute cluster shape` step.
 * @param {string} workflowText
 * @returns {{shape: Record<string, unknown> | undefined, defaultDimension: string | undefined}}
 */
export function extractAwsWorkflowShape(workflowText) {
	const lines = workflowText.split("\n").filter((l) => !/^\s*#/.test(l));
	const shapeLine = lines.map((l) => l.match(/^\s*aws\)\s+SHAPE='(\{.*?\})'/)).find((m) => m !== null);
	const dimLine = lines.map((l) => l.match(/^\s*AWS_DEFAULT_CAPACITY_DIMENSION=([a-z0-9-]+)\s*$/)).find((m) => m !== null);
	return { shape: shapeLine ? JSON.parse(shapeLine[1]) : undefined, defaultDimension: dimLine?.[1] };
}

/**
 * The aws shapes the e2e provisions, as R5 cells: the cheapest shape twice (its default cell with
 * capacity_type removed, as the workflow's jq does, and every other dimension as written), plus the
 * heavy and demo fixtures.
 * @param {string} workflowText
 * @param {{file: string, shape: Record<string, unknown>, ceiling: "low" | "high"}[]} fixtures
 * @returns {{cell: string, shape: Record<string, unknown>, ceiling: "low" | "high", isDefault: boolean}[]}
 */
export function awsCells(workflowText, fixtures) {
	const { shape, defaultDimension } = extractAwsWorkflowShape(workflowText);
	if (shape === undefined) {
		throw new Error(`${WORKFLOW}: no \`aws) SHAPE='{…}'\` line — R5 has lost its subject; fix the extractor rather than let it check less`);
	}
	if (defaultDimension === undefined) {
		throw new Error(`${WORKFLOW}: no AWS_DEFAULT_CAPACITY_DIMENSION=<dimension> line — R5 cannot tell which cell stays on the default`);
	}
	const { capacity_type: _dropped, ...asDefault } = shape;
	return [
		{ cell: `cheapest shape, ${defaultDimension} (default cell)`, shape: asDefault, ceiling: "low", isDefault: true },
		{ cell: `cheapest shape, every other dimension`, shape, ceiling: "low", isDefault: false },
		...fixtures.map((f) => ({ cell: f.file, shape: f.shape, ceiling: f.ceiling, isDefault: false })),
	];
}

/**
 * R5 over already-read inputs. Pure, so `--self-test` drives it with fixtures.
 * @param {{workflowText: string, cells: {cell: string, shape: Record<string, unknown>, ceiling: "low" | "high", isDefault: boolean}[]}} input
 * @returns {{failures: string[], notes: string[]}}
 */
export function analyseAwsCapacity({ workflowText, cells }) {
	const failures = [];
	const notes = [];
	const ceilingExpr = envValue(workflowText, CEILING_ENV);
	const awsBranch = ceilingExpr === undefined ? undefined : providerBranches(ceilingExpr).get("aws");
	const defaults = awsBranch === undefined ? [] : literals(awsBranch).filter((s) => /^\d+(\.\d+)?$/.test(s)).map(Number).filter((n) => n > 0);
	if (defaults.length < 2) {
		failures.push(`R5 aws: the ${CEILING_ENV} aws branch must carry two numeric defaults (cheapest and heavy), found [${defaults.join(", ")}] — R5c has nothing to compare against.`);
		return { failures, notes };
	}
	const ceilingFor = { low: Math.min(...defaults), high: Math.max(...defaults) };

	if (cells.filter((c) => c.isDefault).length !== 1) {
		failures.push(`R5a aws: exactly ONE aws cell must stay on the default capacity type, found ${cells.filter((c) => c.isDefault).length}.`);
	}
	for (const { cell, shape, ceiling, isDefault } of cells) {
		const capacity = shape.capacity_type;
		if (isDefault && capacity !== undefined) {
			failures.push(`R5a aws: ${cell} is the default cell and must state NO capacity_type (it states "${capacity}"), so the template default decides.`);
		}
		if (!isDefault && capacity !== "spot") {
			failures.push(
				`R5a aws: ${cell} states capacity_type ${capacity === undefined ? "nothing" : `"${capacity}"`} — every aws e2e shape except the default cell pins "spot" (#5316); ` +
					`without it the run inherits ON_DEMAND.`,
			);
		}
		const types = Array.isArray(shape.instance_types) ? shape.instance_types : [];
		const nodes = Number(shape.node_desired_size ?? shape.node_min_size);
		if (types.length === 0 || !Number.isFinite(nodes) || nodes < 1) {
			failures.push(`R5b aws: ${cell} names no instance type or no node count — R5c cannot price it.`);
			continue;
		}
		// The node group may run any type in the list; price the dearest.
		const prices = types.map((t) => AWS_ON_DEMAND_USD_PER_HOUR[t]);
		if (prices.some((p) => p === undefined)) {
			failures.push(`R5b aws: ${cell} provisions ${types.filter((_, i) => prices[i] === undefined).join(", ")}, which has no price in AWS_ON_DEMAND_USD_PER_HOUR — add its us-east-1 on-demand list price.`);
			continue;
		}
		const fixed = AWS_FIXED_USD_PER_HOUR.eks_control_plane + AWS_FIXED_USD_PER_HOUR.nat_gateway;
		const perHour = fixed + nodes * Math.max(...prices);
		const monthly = perHour * HOURS_PER_MONTH;
		const limit = ceilingFor[ceiling];
		if (monthly > limit) {
			failures.push(
				`R5c aws: ${cell} — ${nodes} x ${types.join("/")} + EKS + NAT is $${monthly.toFixed(0)}/mo at on-demand, over the $${limit}/mo ceiling default its leg is priced against; ` +
					`the run would be refused before it starts.`,
			);
			continue;
		}
		const basis = isDefault ? "ON_DEMAND (template default), exact" : "SPOT, bounded above by on-demand";
		notes.push(
			`aws ${cell}: ${nodes} x ${types.join("/")} ${basis} — ≤ $${perHour.toFixed(3)}/h, ≤ $${monthly.toFixed(0)}/mo against a $${limit}/mo ceiling ($${(limit - monthly).toFixed(0)} headroom for everything else)`,
		);
	}
	return { failures, notes };
}

/**
 * Read the aws fixtures R5 prices. Throws when one is missing — a deleted fixture must not shrink
 * the domain silently.
 * @returns {{file: string, shape: Record<string, unknown>, ceiling: "low" | "high"}[]}
 */
function readAwsFixtures() {
	const files = fs.readdirSync(AWS_FIXTURE_DIR).filter((f) => AWS_FIXTURE_RE.test(f));
	if (files.length === 0) {
		throw new Error(`${AWS_FIXTURE_DIR}: no cluster_json.*.aws.json fixture found — R5 would price nothing but the cheapest shape`);
	}
	return files.map((f) => {
		const file = path.join(AWS_FIXTURE_DIR, f);
		return { file, ceiling: /** @type {const} */ ("high"), shape: JSON.parse(fs.readFileSync(file, "utf8")) };
	});
}

// ───────────────────────────── self-test ─────────────────────────────

const FIXTURE_RESOLVER = 'FULL_BAR_CRON="17 5 * * 0"\n';
const FIVE = ["hetzner", "aws", "gcp", "azure", "alibaba"];
const TODAY_CEILING = ["aws", "gcp", "azure"].map((p) => `matrix.provider == '${p}' && (vars.E2E_${p.toUpperCase()}_COST_CEILING_USD || '300')`).join(" || ");
const TODAY_CAP = `matrix.provider == 'hetzner' && (vars.E2E_HETZNER_SERVER_TYPES || 'cpx22,cpx32') || ''`;
const TODAY_PREPAID = `matrix.provider == 'alibaba' && !inputs.alibaba_allow_prepaid && '1' || ''`;
const E2E_TYPES = [
	{ source: "variables.tf", type: "cpx22" },
	{ source: "heavy.json", type: "cpx32" },
	{ source: "demo.json", type: "cpx32" },
];

/**
 * Build a workflow fixture. Any expression passed as `null` omits that env line entirely.
 * @param {{crons?: string[], matrix?: string[], ceiling?: string | null, cap?: string | null, prepaid?: string | null}} o
 * @returns {string}
 */
function fixture({ crons = ["17 3 * * *"], matrix = FIVE, ceiling = `${TODAY_CEILING} || ''`, cap = TODAY_CAP, prepaid = TODAY_PREPAID } = {}) {
	return [
		"on:",
		"  schedule:",
		...crons.map((c) => `    - cron: "${c}"`),
		"    strategy:",
		"      matrix:",
		`        provider: \${{ github.event_name == 'workflow_dispatch' && fromJSON(format('["{0}"]', github.event.inputs.provider)) || fromJSON('${JSON.stringify(matrix)}') }}`,
		"          # ALETHIA_SPEND_REFUSE_PREPAID: a comment naming the env must not count as the control",
		...(ceiling === null ? [] : [`          ${CEILING_ENV}: \${{ ${ceiling} }}`]),
		...(cap === null ? [] : [`          ALETHIA_SPEND_HCLOUD_SERVER_TYPES: \${{ ${cap} }}`]),
		...(prepaid === null ? [] : [`          ALETHIA_SPEND_REFUSE_PREPAID: \${{ ${prepaid} }}`]),
	].join("\n");
}

function runSelfTest() {
	let fails = 0;
	/** @param {string} name @param {boolean} ok @param {string} [detail] */
	const assert = (name, ok, detail = "") => {
		if (ok) {
			console.log(`ok   - ${name}`);
		} else {
			console.error(`FAIL - ${name}${detail ? `: ${detail}` : ""}`);
			fails++;
		}
	};
	/** @param {string} wf @param {{source: string, type: string}[]} [types] */
	const run = (wf, types = E2E_TYPES) => analyse({ workflowText: wf, resolverText: FIXTURE_RESOLVER, hetznerTypes: types });
	/** @param {{failures: string[]}} r @param {string} prefix */
	const has = (r, prefix) => r.failures.some((f) => f.startsWith(prefix));

	// TODAY — all five controlled.
	const today = run(fixture());
	assert("today's shape (3 ceilings + hetzner cap + alibaba prepaid refusal) passes", today.failures.length === 0, JSON.stringify(today.failures));

	// THE REGRESSION. The world before #2385: an aws-only ceiling and no shape controls.
	const before = run(fixture({ ceiling: "matrix.provider == 'aws' && (vars.X || '300') || ''", cap: null, prepaid: null }));
	assert(
		"the pre-#2385 world (aws-only ceiling, no shape controls) FAILS R1 for each of the four",
		["hetzner", "gcp", "azure", "alibaba"].every((p) => has(before, `R1 ${p}:`)),
		JSON.stringify(before.failures),
	);
	assert("...and that is so with or without a full-bar cron", has(run(fixture({ crons: ["17 5 * * 0"], cap: null })), "R1 hetzner:"));

	// Each control, removed once, goes red for exactly its cloud.
	for (const p of ["gcp", "azure"]) {
		const without = ["aws", "gcp", "azure"].filter((x) => x !== p).map((x) => `matrix.provider == '${x}' && (vars.V || '300')`).join(" || ");
		const r = run(fixture({ ceiling: `${without} || ''` }));
		assert(`removing the ${p} ceiling branch FAILS R1 ${p}`, has(r, `R1 ${p}:`) && r.failures.length === 1, JSON.stringify(r.failures));
	}
	const noCap = run(fixture({ cap: null }));
	assert("removing the hetzner cap FAILS R1 hetzner", has(noCap, "R1 hetzner:") && noCap.failures.length === 1, JSON.stringify(noCap.failures));
	const noPrepaid = run(fixture({ prepaid: null }));
	assert("removing the alibaba prepaid refusal FAILS R1 alibaba", has(noPrepaid, "R1 alibaba:") && noPrepaid.failures.length === 1, JSON.stringify(noPrepaid.failures));
	assert("a COMMENT naming the env is not the control", has(noPrepaid, "R1 alibaba:"));

	// R2 — a control by name only.
	const noDefault = run(fixture({ ceiling: `${TODAY_CEILING.replace("|| '300')", ")")} || ''` }));
	assert("a ceiling branch with no numeric default FAILS R2 (unset var ⇒ '' ⇒ disabled)", has(noDefault, "R2 aws:") && has(noDefault, "R1 aws:"), JSON.stringify(noDefault.failures));
	const zeroCeiling = run(fixture({ ceiling: `${TODAY_CEILING.replace("|| '300')", "|| '0')")} || ''` }));
	assert("a ceiling defaulting to 0 FAILS R2 (0 is the disabled value)", has(zeroCeiling, "R2 aws:"), JSON.stringify(zeroCeiling.failures));
	const capNoDefault = run(fixture({ cap: "matrix.provider == 'hetzner' && vars.E2E_HETZNER_SERVER_TYPES || ''" }));
	assert("a hetzner cap with no literal default FAILS R2", has(capNoDefault, "R2 hetzner:"), JSON.stringify(capNoDefault.failures));
	const staleCeiling = run(fixture({ ceiling: `${TODAY_CEILING} || matrix.provider == 'oracle' && '300' || ''` }));
	assert("a ceiling branch for a cloud outside the matrix FAILS R2 as stale", has(staleCeiling, "R2 oracle:"), JSON.stringify(staleCeiling.failures));
	const wrongCloud = run(fixture({ cap: `${TODAY_CAP.replace(" || ''", "")} || matrix.provider == 'aws' && 'cpx22' || ''` }));
	assert("a hetzner cap on an aws leg FAILS R2 (it guards nothing there)", has(wrongCloud, "R2 aws:"), JSON.stringify(wrongCloud.failures));
	const unscoped = run(fixture({ prepaid: "'1'" }));
	assert("a shape control naming no provider FAILS R2", has(unscoped, "R2 alibaba:"), JSON.stringify(unscoped.failures));

	// R3 — a waiver a schedule can reach.
	for (const standing of ["vars.E2E_ALIBABA_ALLOW_PREPAID", "secrets.X", "env.E2E_FULL_BAR"]) {
		const r = run(fixture({ prepaid: `matrix.provider == 'alibaba' && ${standing} != 'true' && '1' || ''` }));
		assert(`a prepaid waiver through ${standing.split(".")[0]}.* FAILS R3`, has(r, "R3 alibaba:") && has(r, "R1 alibaba:"), JSON.stringify(r.failures));
	}
	// ...including a waiver placed BEFORE the provider test, outside the provider branch's text.
	const leading = run(fixture({ prepaid: `vars.E2E_ALIBABA_ALLOW_PREPAID != 'true' && matrix.provider == 'alibaba' && '1' || ''` }));
	assert("a standing waiver placed BEFORE the provider test FAILS R3", has(leading, "R3 alibaba:"), JSON.stringify(leading.failures));
	assert("...while the dispatch-input waiver passes", !has(today, "R3"));

	// R4 — the cap vs what the e2e provisions.
	const tooTight = run(fixture({ cap: TODAY_CAP.replace(",cpx32", "") }));
	assert(
		"a cap that drops cpx32 while demo.json provisions it FAILS R4, naming the type and the file",
		tooTight.failures.some((f) => f.startsWith("R4 hetzner:") && f.includes('"cpx32"') && f.includes("demo.json")),
		JSON.stringify(tooTight.failures),
	);
	const biggerFixture = run(fixture(), [...E2E_TYPES, { source: "heavy.json", type: "ccx63" }]);
	assert("a fixture moving to a type outside the cap FAILS R4", biggerFixture.failures.some((f) => f.includes('"ccx63"')), JSON.stringify(biggerFixture.failures));
	assert("an EMPTY derived domain FAILS R4 rather than passing on nothing", has(run(fixture(), []), "R4 hetzner:"));
	assert("the cap match ignores case, as the runner does", run(fixture(), [{ source: "x", type: "CPX22" }]).failures.length === 0);

	// A new cloud.
	const sixth = run(fixture({ matrix: [...FIVE, "oracle"] }));
	assert("a sixth matrix cloud with no control FAILS R1", has(sixth, "R1 oracle:"), JSON.stringify(sixth.failures));

	// A scheduled full bar is allowed once everything is controlled — and the note does not let that read as permission.
	const cron = run(fixture({ crons: ["17 3 * * *", "17 5 * * 0"] }));
	assert("a full-bar cron with every cloud controlled passes this guard", cron.failures.length === 0, JSON.stringify(cron.failures));
	assert("...and the note names the PASS-row gate this guard does not read", cron.notes.some((n) => n.includes("PASS row")));

	// Extractors, on the shapes they read.
	assert(
		"tf extractor reads both *_server_type defaults",
		extractTfServerTypeDefaults('variable "control_plane_server_type" {\n  type = string\n  default     = "cpx22"\n}\nvariable "worker_server_type" {\n  default = "cx33"\n}\nvariable "worker_count" {\n  default = 1\n}').join() === "cpx22,cx33",
	);
	assert("catalog extractor reads compute.hetzner.default_instance", extractCatalogHetznerDefault('{"compute":{"hetzner":{"default_instance":"cpx22"}}}').join() === "cpx22");
	assert("catalog extractor yields nothing for a catalog with no hetzner default", extractCatalogHetznerDefault('{"compute":{}}').length === 0);
	assert(
		"maxconfig extractor reads the hetzner arm and not its neighbours",
		extractMaxconfigHetzner(
			'\tcase "hetzner":\n\t\treturn k.Hetzner, true\n\t}\n\tcase "azure":\n\t\tinstanceTypes = []string{"Standard_D2s_v3"}\n\tcase "hetzner":\n\t\t// c\n\t\tinstanceTypes = []string{"cx33"}\n\tcase "alibaba":\n\t\tinstanceTypes = []string{"ecs.g6.large"}\n',
		).join() === "cx33",
	);
	assert("maxconfig extractor returns nothing (so the caller throws) when the arm is gone", extractMaxconfigHetzner('case "aws":\n instanceTypes = []string{"m5.large"}\n').length === 0);

	// VACUITY — seed everything wrong at once; the guard must report a pile across every rule.
	const allWrong = run(
		fixture({
			matrix: [...FIVE, "oracle"],
			ceiling: "matrix.provider == 'aws' && vars.X || matrix.provider == 'vultr' && '300' || ''",
			cap: "matrix.provider == 'hetzner' && 'cpx22' || ''",
			prepaid: "matrix.provider == 'alibaba' && vars.W != 'true' && '1' || ''",
		}),
		[...E2E_TYPES],
	);
	assert("vacuity: a wholly broken input reports many failures", allWrong.failures.length >= 6, `only ${allWrong.failures.length}: ${JSON.stringify(allWrong.failures)}`);
	assert("vacuity: and it spans all four rules", ["R1", "R2", "R3", "R4"].every((r) => has(allWrong, r)), JSON.stringify(allWrong.failures));

	// R5 — aws capacity type and its cost (#5316).
	const AWS_SHAPE = '{"instance_types":["t3.large"],"capacity_type":"spot","node_min_size":1,"node_max_size":2,"node_desired_size":1}';
	const AWS_CEILING = "matrix.provider == 'aws' && (env.E2E_HEAVY_SHAPE == 'true' && (vars.F || '600') || (vars.L || '300')) || ''";
	/** @param {{shape?: string | null, dim?: string | null, ceiling?: string}} o */
	const awsWorkflow = ({ shape = AWS_SHAPE, dim = "floor", ceiling = AWS_CEILING } = {}) =>
		[
			`          ${CEILING_ENV}: \${{ ${ceiling} }}`,
			...(dim === null ? [] : [`          AWS_DEFAULT_CAPACITY_DIMENSION=${dim}`]),
			"          # aws) SHAPE='{\"instance_types\":[\"m5.24xlarge\"]}' a comment is not the shape",
			...(shape === null ? [] : [`            aws)     SHAPE='${shape}'; NET='{"single_nat_gateway":true}'`]),
		].join("\n");
	const HEAVY = { file: "heavy.aws.json", ceiling: /** @type {const} */ ("high"), shape: { instance_types: ["t3.xlarge"], capacity_type: "spot", node_desired_size: 3 } };
	/** @param {string} wf @param {typeof HEAVY[]} [fx] */
	const r5 = (wf, fx = [HEAVY]) => analyseAwsCapacity({ workflowText: wf, cells: awsCells(wf, fx) });
	const r5today = r5(awsWorkflow());
	assert("R5: today's aws shapes pass", r5today.failures.length === 0, JSON.stringify(r5today.failures));
	// The math, by hand: (0.10 EKS + 0.045 NAT + 1 x 0.0832) x 730 = 166.586; (0.145 + 3 x 0.1664) x 730 = 470.27.
	assert("R5: the floor cell is priced at $167/mo, exact on-demand", r5today.notes.some((n) => n.includes("(default cell)") && n.includes("ON_DEMAND") && n.includes("$167/mo") && n.includes("$300/mo")));
	assert("R5: a spot cell is priced at the on-demand bound and says so", r5today.notes.some((n) => n.includes("every other dimension") && n.includes("SPOT, bounded above by on-demand") && n.includes("$167/mo")));
	assert("R5: the heavy fixture is priced against the HIGH default, 3 x t3.xlarge = $470/mo", r5today.notes.some((n) => n.startsWith("aws heavy.aws.json") && n.includes("$470/mo") && n.includes("$600/mo")));
	const noPin = r5(awsWorkflow({ shape: AWS_SHAPE.replace('"capacity_type":"spot",', "") }));
	assert("R5a: a cheapest shape that drops the spot pin FAILS", noPin.failures.some((f) => f.startsWith("R5a aws: cheapest shape, every other dimension")), JSON.stringify(noPin.failures));
	const onDemandPin = r5(awsWorkflow(), [{ ...HEAVY, shape: { ...HEAVY.shape, capacity_type: "on_demand" } }]);
	assert("R5a: a fixture pinning on_demand FAILS", onDemandPin.failures.some((f) => f.startsWith("R5a aws: heavy.aws.json")), JSON.stringify(onDemandPin.failures));
	const unpricedType = r5(awsWorkflow(), [{ ...HEAVY, shape: { ...HEAVY.shape, instance_types: ["m5a.4xlarge"] } }]);
	assert("R5b: an instance type with no price FAILS rather than going unpriced", unpricedType.failures.some((f) => f.startsWith("R5b aws:") && f.includes("m5a.4xlarge")), JSON.stringify(unpricedType.failures));
	const tooBig = r5(awsWorkflow(), [{ ...HEAVY, shape: { ...HEAVY.shape, node_desired_size: 5 } }]);
	assert("R5c: 5 x t3.xlarge ($713/mo) over the $600 default FAILS", tooBig.failures.some((f) => f.startsWith("R5c aws: heavy.aws.json") && f.includes("$713/mo")), JSON.stringify(tooBig.failures));
	const lowCeiling = r5(awsWorkflow({ ceiling: AWS_CEILING.replace("'300'", "'150'") }));
	assert("R5c: the floor shape ($167/mo) against a $150 default FAILS", lowCeiling.failures.some((f) => f.startsWith("R5c aws: cheapest shape")), JSON.stringify(lowCeiling.failures));
	const oneDefault = r5(awsWorkflow({ ceiling: "matrix.provider == 'aws' && (vars.L || '300') || ''" }));
	assert("R5: an aws ceiling with ONE default cannot say which leg is which, and FAILS", oneDefault.failures.some((f) => f.startsWith("R5 aws:")), JSON.stringify(oneDefault.failures));
	for (const [what, wf] of [["the aws SHAPE line", awsWorkflow({ shape: null })], ["AWS_DEFAULT_CAPACITY_DIMENSION", awsWorkflow({ dim: null })]]) {
		let lost = false;
		try {
			r5(wf);
		} catch {
			lost = true;
		}
		assert(`R5: a workflow with no ${what} throws rather than checking less`, lost);
	}

	// A resolver with no FULL_BAR_CRON must throw, never default.
	let threw = false;
	try {
		analyse({ workflowText: fixture(), resolverText: "# nothing\n", hetznerTypes: E2E_TYPES });
	} catch {
		threw = true;
	}
	assert("a resolver missing FULL_BAR_CRON throws", threw);

	if (fails > 0) {
		console.error(`\nself-test: ${fails} check(s) FAILED`);
		process.exit(1);
	}
	console.log("\nself-test: all passed");
}

// ───────────────────────────── main ─────────────────────────────

// Only when EXECUTED, never on import: the analysis helpers above are exported so a test (or the
// programme rollup) can drive them with fixtures, and a module whose import reads files and can
// call process.exit is not importable.
const executedDirectly = process.argv[1] !== undefined && import.meta.url === `file://${fs.realpathSync(process.argv[1])}`;

if (!executedDirectly) {
	// imported — expose the helpers and do nothing else.
} else if (process.argv.includes("--self-test")) {
	runSelfTest();
} else {
	const workflowText = fs.readFileSync(WORKFLOW, "utf8");
	const base = analyse({
		workflowText,
		resolverText: fs.readFileSync(RESOLVER, "utf8"),
		hetznerTypes: readHetznerTypes(),
	});
	const r5 = analyseAwsCapacity({ workflowText, cells: awsCells(workflowText, readAwsFixtures()) });
	const failures = [...base.failures, ...r5.failures];
	const notes = [...base.notes, ...r5.notes];
	for (const n of notes) {
		console.log(`note: ${n}`);
	}
	if (failures.length > 0) {
		for (const f of failures) {
			console.error(`::error::e2e spend guard: ${f}`);
		}
		console.error(`\ne2e spend guard: ${failures.length} failure(s).`);
		process.exit(1);
	}
	console.log("\ne2e spend guard: OK");
}
