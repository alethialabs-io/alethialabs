#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
//
// programme-rollup — derive PROGRAMME.md's generated half from the tree.
//
// WHY THIS EXISTS. The MVP programme is "5 clouds × the capability surface, proven e2e, driven from
// the CLI". Its state was spread across ~15 hand-maintained Markdown boards, a Go harness and the
// issue board, so answering "where are we?" meant re-reading all of it — and the boards did not
// agree with each other:
//
//   · docs/testing/provisioning-e2e-parity.md cited #1714/#1716/#1722/#2058 as OPEN blockers. All
//     four are CLOSED.
//   · docs/testing/runner-xcloud-parity.md says hetzner is `✅ (nightly)` for cluster provision while
//     provisioning-e2e-parity.md says `🚫` — two files, one directory, contradicting each other,
//     both passing CI.
//   · Both boards imply clouds have been proven. The proof LEDGER says otherwise: every 2026-07-22
//     PASS was later RETRACTED as a gate-off skip, so the honest count of proven cells is ZERO.
//
// A hand-maintained board rots because nothing makes it agree with the tree. So this derives the
// status half of PROGRAMME.md and CI diff-gates the result: the numbers cannot be typed, and a stale
// file fails the build. It is deliberately NOT a 16th board — it is the join of the boards' inputs.
//
// PURE and OFFLINE: reads files, writes one file, never calls gh or a cloud. The live-board half of
// PROGRAMME.md (open REDs, blocked-on-human, board delta) is a separate cron-committed snapshot, so
// that this — the half every PR diff-gates — stays a deterministic function of the tree.
//
// ── What is DERIVED, and therefore cannot be faked ──
//
// Everything below. There is no hand-authored verdict table anywhere in this design, on purpose:
//
//   `proven`     a ledger row for (cloud × dimension) whose latest claim is PASS, NOT superseded by
//                a later RETRACTED, AND whose bundle is a path that EXISTS in the tree.
//   `failing`    the latest claim is FAIL.
//   `blocked`    the latest claim is BLOCKED (the harness refused before spending).
//   `never_run`  no surviving claim, and a vehicle exists.
//   `no_vehicle` nothing asserts this cell at all.
//   `ceiling`    the cloud genuinely cannot (MaxConfigCarriage.CloudCeiling / CLIReach.CloudManual).
//   `deferred`   OUR debt — a shipped chart backs it and only the mapping is missing
//                (MaxConfigCarriage.DeferredInProduct). Kept apart from `ceiling` because a ceiling
//                is about the cloud and deferral is about us; merging them is how hetzner's
//                registry→Harbor and secret→Vault stopped being counted.
//
// The two hand-asserted verdicts (`ceiling`, `deferred`) are NOT authored here — they are read from
// the Go tables that already own and validate them, via test/e2e/generated/programme.json. One
// deriver, every consumer.
//
// Run: `node scripts/programme-rollup.mjs`            check + print the diff, exit 2 if stale
//      `node scripts/programme-rollup.mjs --write`    rewrite the generated region in place
//      `node scripts/programme-rollup.mjs --self-test`
//
// Exit codes — a non-zero must MEAN something:
//   0  clean
//   1  INTEGRITY failure: a cell is lying, or a required invariant broke
//   2  the generated region is stale (run --write and commit)
//   3  a required input is unreadable — never degrade silently to a prettier-looking answer

import fs from "node:fs";
import path from "node:path";

const LEDGER = "demos/proofs/provisioning-e2e-log.md";
const SPINE = "test/e2e/generated/programme.json";
const WORKFLOW = ".github/workflows/e2e-nightly.yml";
const UNSUPPORTED_KINDS = "apps/console/lib/cloud-providers/unsupported-kinds.ts";
const PROOFS_DIR = "demos/proofs";
const TARGET = "PROGRAMME.md";

const BEGIN = "<!-- BEGIN GENERATED: programme-rollup · tree-derived · DO NOT EDIT BELOW -->";
const END = "<!-- END GENERATED: programme-rollup -->";

/**
 * The dimensions one cloud must clear, in the order they are attempted, and the gate that turns each
 * on. Vocabulary is `provisioning-e2e.sh`'s (`floor|maxconfig|addons|byo|day2|full`) so a row it
 * appends and a cell rendered here always name the same thing.
 *
 * `full` is deliberately NOT a cell: it is the composite that runs every dimension in one apply, so
 * a `full` PASS is evidence for ALL of them. Treating it as a sixth column would let a cloud look
 * 1/6 proven when a full bar had in fact proven everything.
 */
// `gateNames` is the CONCRETE list checked against the workflow — never parsed back out of `gate`,
// which is display prose and once contained a `*` wildcard that resolved to a name nothing declares
// and rendered a false "no".
const DIMENSIONS = [
	{ id: "floor", label: "floor", gate: "(the cloud gate alone)", gateNames: [], what: "real apply → cluster_ready → ArgoCD Healthy+Synced over the derived app set" },
	{ id: "maxconfig", label: "all kinds", gate: "ALETHIA_E2E_MAX_CONFIG", gateNames: ["ALETHIA_E2E_MAX_CONFIG"], what: "every kind this cloud offers lands in tofu state (or converges as its named Application)" },
	{ id: "addons", label: "18 add-ons", gate: "ALETHIA_E2E_ALL_ADDONS", gateNames: ["ALETHIA_E2E_ALL_ADDONS"], what: "all 18 marketplace add-ons Healthy+Synced" },
	{ id: "byo", label: "BYO-IaC", gate: "ALETHIA_E2E_ARGO_APPS_REPO + E2E_GIT_TOKEN", gateNames: ["ALETHIA_E2E_ARGO_APPS_REPO", "E2E_GIT_TOKEN"], what: "customer IaC/charts applied, and Alethia services bound to their outputs" },
	{ id: "day2", label: "day-2", gate: "ALETHIA_E2E_SOAK / E2E_DAY2_ACCESS", gateNames: ["ALETHIA_E2E_SOAK", "E2E_DAY2_ACCESS"], what: "a real access path beyond the soak — kubeconfig / ArgoCD surface" },
];
/** The composite dimension: a PASS here is evidence for every entry in DIMENSIONS. */
const COMPOSITE = "full";

const LEDGER_VERDICTS = new Set(["PASS", "FAIL", "RETRACTED", "BLOCKED"]);

// ───────────────────────────── parsing ─────────────────────────────

/**
 * Parse the append-only proof ledger. Rows are `| date | sha | cloud | dimension | **VERDICT** |
 * detail | bundle | issue |`. Order matters: the file is append-only and a RETRACTED row VOIDS the
 * earlier claim for its (cloud, dimension) pair rather than replacing it with a verdict of its own.
 * @returns {{rows: object[], errors: string[]}}
 */
export function parseLedger(text) {
	const rows = [];
	const errors = [];
	for (const [i, line] of text.split("\n").entries()) {
		if (!line.trimStart().startsWith("|")) continue;
		const cells = line.split("|").slice(1, -1).map((c) => c.trim());
		if (cells.length < 8) continue;
		if (/^UTC date$/i.test(cells[0]) || /^-+$/.test(cells[0])) continue;
		const verdict = cells[4].replace(/\*/g, "").trim().toUpperCase();
		if (!LEDGER_VERDICTS.has(verdict)) {
			errors.push(`${LEDGER}:${i + 1}: unknown verdict ${JSON.stringify(cells[4])} — expected one of ${[...LEDGER_VERDICTS].join(", ")}`);
			continue;
		}
		rows.push({
			line: i + 1,
			date: cells[0],
			sha: cells[1],
			cloud: cells[2].toLowerCase(),
			dimension: cells[3].toLowerCase(),
			verdict,
			detail: cells[5],
			bundle: cells[6].replace(/`/g, "").trim(),
			issue: cells[7] === "—" ? "" : cells[7],
		});
	}
	return { rows, errors };
}

/**
 * A bundle reference is one of three things, and the difference decides whether a PASS can be
 * believed. A committed PATH can be checked here. A bare `nightly-<run_id>` RUN TAG names a CI
 * artifact that expires (retention-days: 30) and is unverifiable offline — so it can never support
 * `proven`. Saying "unverifiable" is the whole point: the four 2026-07-22 PASSes carried run tags
 * and were later RETRACTED because no bundle had ever existed.
 * @returns {"path"|"run-tag"|"none"}
 */
export function bundleKind(ref) {
	if (!ref) return "none";
	if (ref.startsWith(`${PROOFS_DIR}/`) || /^[a-z]+\/\d{8}T\d{6}Z$/.test(ref)) return "path";
	if (/^nightly-\d+$/.test(ref) || /^gate-\d+/.test(ref)) return "run-tag";
	return "none";
}

/** Resolve a `path`-kind bundle reference to a repo path. */
export function bundlePath(ref) {
	return ref.startsWith(`${PROOFS_DIR}/`) ? ref : path.join(PROOFS_DIR, ref);
}

/**
 * Collapse the ledger into the surviving claim per (cloud × dimension). Append-only + RETRACTED
 * supersession means "the last row wins" is WRONG: a RETRACTED row removes a claim rather than being
 * one. So we replay in file order and let RETRACTED clear the slot.
 * @returns {Map<string, object|null>} "cloud/dimension" → the surviving row, or null if voided
 */
export function collapseLedger(rows) {
	/** @type {Map<string, object|null>} */
	const claims = new Map();
	for (const r of rows) {
		const key = `${r.cloud}/${r.dimension}`;
		if (r.verdict === "RETRACTED") {
			claims.set(key, null); // the earlier claim is void; the pair is back to "no evidence"
			continue;
		}
		claims.set(key, r);
	}
	return claims;
}

/**
 * Which `ALETHIA_E2E_*` / `E2E_*` / cloud-token names the nightly workflow actually references.
 *
 * "References" means the name appears anywhere executable in the file, NOT just as a YAML `env:`
 * key. The fidelity vars are exported by the resolve step as `echo "ALETHIA_E2E_MAX_CONFIG=1" >>
 * "$GITHUB_ENV"`, so an `env:`-key-only match reported the two heaviest dimensions as unreachable
 * when the workflow sets them itself — a false "no" is worse than no column, because it sends
 * somebody to wire a gate that is already wired.
 */
export function referencedGates(workflowText) {
	const names = new Set();
	for (const line of workflowText.split("\n")) {
		if (/^\s*#/.test(line)) continue;
		for (const m of line.matchAll(/\b(?:vars|secrets)\.([A-Z0-9_]+)\b/g)) names.add(m[1]);
		for (const m of line.matchAll(/\b(ALETHIA_E2E_[A-Z0-9_]+|E2E_[A-Z0-9_]+)\b/g)) names.add(m[1]);
	}
	return names;
}

/**
 * The 19-kind canvas parity grid: per cloud, which NodeKinds the product refuses. Source is the ONE
 * file that drives both the palette and the deploy-time fail-closed gate, so this cannot disagree
 * with what a user actually sees.
 * @returns {Record<string, string[]>}
 */
export function parseUnsupportedKinds(tsText) {
	const body = tsText.match(/UNSUPPORTED_KINDS_BY_PROVIDER[^=]*=\s*\{([\s\S]*?)\n\}/);
	if (body === null) return {};
	/** @type {Record<string, string[]>} */
	const out = {};
	for (const m of body[1].matchAll(/([a-z]+)\s*:\s*\[([^\]]*)\]/g)) {
		out[m[1]] = [...m[2].matchAll(/["']([a-z_]+)["']/g)].map((k) => k[1]);
	}
	return out;
}

// ───────────────────────────── derivation ─────────────────────────────

/**
 * The programme state of one (cloud × dimension) cell. Six values; there is no "unknown" that could
 * be mistaken for progress, and no default that reads as pending.
 */
export const STATE = {
	proven: "proven",
	failing: "failing",
	blocked: "blocked",
	neverRun: "never_run",
	ceiling: "ceiling",
	deferred: "deferred",
};

const STATE_GLYPH = {
	proven: "✅",
	failing: "❌",
	blocked: "⛔",
	never_run: "·",
	ceiling: "—",
	deferred: "🔶",
};

/**
 * Derive one cell. `claims` is the collapsed ledger; `composite` is the surviving `full` claim for
 * this cloud, which is evidence for every dimension.
 * @returns {{state: string, why: string, row: object|null}}
 */
export function deriveCell({ cloud, dimension, claims, bundleExists }) {
	const direct = claims.get(`${cloud}/${dimension}`) ?? null;
	const composite = claims.get(`${cloud}/${COMPOSITE}`) ?? null;
	// A direct claim beats the composite: it is the more specific statement about this dimension.
	const row = direct ?? composite;
	if (row === null) {
		return { state: STATE.neverRun, why: "no surviving ledger claim", row: null };
	}
	const via = direct === null ? ` (via the \`${COMPOSITE}\` composite run)` : "";
	if (row.verdict === "FAIL") {
		return { state: STATE.failing, why: `ledger ${row.date}${via}`, row };
	}
	if (row.verdict === "BLOCKED") {
		return { state: STATE.blocked, why: `ledger ${row.date}${via} — refused before spending`, row };
	}
	// PASS is the only verdict that must EARN its state, because it is the only one anybody is
	// tempted to overstate. A PASS whose bundle cannot be produced is not a proof.
	const kind = bundleKind(row.bundle);
	if (kind !== "path") {
		return {
			state: STATE.neverRun,
			why:
				kind === "run-tag"
					? `ledger ${row.date} claims PASS but its bundle \`${row.bundle}\` is an EXPIRING CI run tag, not a committed path — unverifiable, so not a proof`
					: `ledger ${row.date} claims PASS with no bundle reference — unverifiable, so not a proof`,
			row,
		};
	}
	if (!bundleExists(bundlePath(row.bundle))) {
		return { state: STATE.neverRun, why: `ledger ${row.date} claims PASS but bundle \`${row.bundle}\` is MISSING from the tree`, row };
	}
	return { state: STATE.proven, why: `ledger ${row.date}${via}, bundle \`${row.bundle}\``, row };
}

/**
 * Build the whole programme view. Pure — every input is passed in, so `--self-test` drives it with
 * fixtures and the real run reads files once.
 */
export function derive({ ledgerText, spine, workflowText, unsupportedText, bundleExists, exclusionCounts }) {
	const failures = [];
	const { rows, errors } = parseLedger(ledgerText);
	failures.push(...errors);
	const claims = collapseLedger(rows);
	const clouds = spine.clouds;

	// ── the proof grid: cloud × dimension ──
	/** @type {Record<string, Record<string, {state: string, why: string, row: object|null}>>} */
	const grid = {};
	for (const cloud of clouds) {
		grid[cloud] = {};
		for (const d of DIMENSIONS) {
			grid[cloud][d.id] = deriveCell({ cloud, dimension: d.id, claims, bundleExists });
		}
	}

	// ── INTEGRITY: a ledger row naming a cloud or dimension nobody declares ──
	for (const r of rows) {
		if (!clouds.includes(r.cloud)) {
			failures.push(`${LEDGER}:${r.line}: cloud ${JSON.stringify(r.cloud)} is not one of the declared clouds (${clouds.join(", ")})`);
		}
		if (r.dimension !== COMPOSITE && !DIMENSIONS.some((d) => d.id === r.dimension)) {
			failures.push(
				`${LEDGER}:${r.line}: dimension ${JSON.stringify(r.dimension)} is not one of ${DIMENSIONS.map((d) => d.id).join(", ")}, ${COMPOSITE} — ` +
					`a row nobody can render is a proof nobody counts`,
			);
		}
	}

	// ── the 11-kind carriage grid, straight from the Go mirror ──
	const carriage = { tofu: 0, in_cluster: 0, ceiling: 0, deferred: 0 };
	const deferredCells = [];
	const ceilingCells = [];
	for (const k of spine.kinds) {
		for (const cloud of clouds) {
			const cell = k.cells[cloud];
			if (cell === undefined) {
				failures.push(`${SPINE}: kind ${k.kind} has no cell for ${cloud} — the mirror is incomplete`);
				continue;
			}
			carriage[cell.carriage] = (carriage[cell.carriage] ?? 0) + 1;
			if (cell.carriage === "deferred") deferredCells.push({ cloud, kind: k.kind, chart: cell.chart, why: cell.why });
			if (cell.carriage === "ceiling") ceilingCells.push({ cloud, kind: k.kind, why: cell.why });
		}
	}

	// ── the CLI bar, straight from the Go mirror ──
	const cli = { cli: 0, cli_gap: 0, cloud_manual: 0, console_only: 0 };
	const cliBlockers = [];
	for (const s of spine.cli_steps) {
		cli[s.reach] = (cli[s.reach] ?? 0) + 1;
		if (s.reach === "cli_gap" || s.reach === "cloud_manual") {
			cliBlockers.push({ id: s.id, reach: s.reach, issue: s.issue, clouds: s.clouds ?? [], why: s.why });
		}
	}

	// ── gate reality: which dimension gates the workflow even MENTIONS ──
	const gates = referencedGates(workflowText);

	// ── the 19-kind canvas grid ──
	const unsupported = parseUnsupportedKinds(unsupportedText);

	// ── tallies ──
	const tally = { proven: 0, failing: 0, blocked: 0, never_run: 0 };
	for (const cloud of clouds) {
		for (const d of DIMENSIONS) tally[grid[cloud][d.id].state]++;
	}

	// ── the mechanical NEXT: the cheapest cell that would move the programme ──
	// Failing first (a red cell has a diagnosed cause and costs nothing new to re-drive), then
	// never-run in dimension order. Ranking, never claiming — claiming is claim-work.sh's job.
	const next = [];
	for (const d of DIMENSIONS) {
		for (const cloud of clouds) {
			if (grid[cloud][d.id].state === STATE.failing) next.push({ cloud, dimension: d.id, state: STATE.failing, why: grid[cloud][d.id].why });
		}
	}
	for (const d of DIMENSIONS) {
		for (const cloud of clouds) {
			if (grid[cloud][d.id].state === STATE.neverRun) next.push({ cloud, dimension: d.id, state: STATE.neverRun, why: grid[cloud][d.id].why });
		}
	}

	return { rows, claims, clouds, kindCount: spine.kinds.length, grid, carriage, deferredCells, ceilingCells, cli, cliBlockers, gates, unsupported, tally, next, failures, exclusionCounts };
}

// ───────────────────────────── rendering ─────────────────────────────

/** @param {ReturnType<typeof derive>} v */
export function render(v) {
	const L = [];
	const total = v.clouds.length * DIMENSIONS.length;

	L.push("## Where the programme actually is");
	L.push("");
	L.push(
		`**${v.tally.proven} of ${total} proof cells are proven.** ` +
			`${v.tally.failing} failing · ${v.tally.blocked} blocked · ${v.tally.never_run} never run.`,
	);
	L.push("");
	L.push(
		"A cell is `proven` only when the proof ledger's surviving claim is PASS **and** its bundle is a " +
			"committed path that exists. A PASS carrying an expiring CI run tag is not a proof — that is " +
			"why every 2026-07-22 row was retracted, and the rule is enforced here rather than remembered.",
	);
	L.push("");

	// ── the proof grid ──
	L.push("### Proof grid — cloud × dimension");
	L.push("");
	L.push(`| cloud | ${DIMENSIONS.map((d) => d.label).join(" | ")} |`);
	L.push(`|---|${DIMENSIONS.map(() => ":---:").join("|")}|`);
	for (const cloud of v.clouds) {
		L.push(`| **${cloud}** | ${DIMENSIONS.map((d) => STATE_GLYPH[v.grid[cloud][d.id].state]).join(" | ")} |`);
	}
	L.push("");
	L.push(`Legend: ${Object.entries(STATE_GLYPH).map(([s, g]) => `${g} ${s.replace("_", "-")}`).join(" · ")}`);
	L.push("");
	const evidence = [];
	for (const cloud of v.clouds) {
		for (const d of DIMENSIONS) {
			const c = v.grid[cloud][d.id];
			if (c.state !== STATE.neverRun || c.row !== null) evidence.push(`- \`${cloud}/${d.id}\` **${c.state}** — ${c.why}${c.row?.issue ? ` (${c.row.issue})` : ""}`);
		}
	}
	if (evidence.length > 0) {
		L.push("<details><summary>Every cell that has any evidence at all</summary>");
		L.push("");
		L.push(...evidence);
		L.push("");
		L.push("</details>");
		L.push("");
	}

	// ── the mechanical next ──
	L.push("### The mechanical next");
	L.push("");
	if (v.next.length === 0) {
		L.push("Nothing is actionable from the tree — every cell is proven, a ceiling, or blocked on a human.");
	} else {
		const n = v.next[0];
		L.push(`**\`${n.cloud}/${n.dimension}\`** — ${n.state}. ${n.why}`);
		L.push("");
		L.push(
			"Failing cells rank above never-run ones: a red cell already has a diagnosed cause and costs " +
				"nothing new to re-drive, where a never-run cell needs its gate enabled first. " +
				"This RANKS; it never claims — `scripts/claim-work.sh` claims.",
		);
		L.push("");
		L.push("<details><summary>The next 10</summary>");
		L.push("");
		for (const c of v.next.slice(0, 10)) L.push(`1. \`${c.cloud}/${c.dimension}\` — ${c.state}`);
		L.push("");
		L.push("</details>");
	}
	L.push("");

	// ── capability surface ──
	L.push("### Capability surface");
	L.push("");
	const carriageTotal = Object.values(v.carriage).reduce((a, b) => a + b, 0);
	L.push(
		`**Proof grid (${v.kindCount} provisionable kinds × ${v.clouds.length} clouds = ${carriageTotal} cells):** ` +
			`${v.carriage.tofu} carried by tofu · ${v.carriage.in_cluster} carried in-cluster · ` +
			`${v.carriage.ceiling} cloud ceilings · **${v.carriage.deferred} deferred (our debt)**.`,
	);
	L.push("");
	if (v.deferredCells.length > 0) {
		L.push(
			"The deferred cells are the last **product** debt in the capability matrix — a chart this repo " +
				"already ships backs the kind, and only the mapping is missing. They install on every " +
				"full-bar run while the kind that would use them is refused:",
		);
		L.push("");
		for (const d of v.deferredCells) L.push(`- \`${d.cloud}/${d.kind}\` → chart **${d.chart}**`);
		L.push("");
	}
	if (v.ceilingCells.length > 0) {
		L.push("Cloud ceilings (the cloud genuinely does not offer the kind — not our debt):");
		L.push("");
		for (const c of v.ceilingCells) L.push(`- \`${c.cloud}/${c.kind}\``);
		L.push("");
	}
	const unsupportedEntries = Object.entries(v.unsupported);
	L.push(
		`**Parity grid (19 canvas NodeKinds × ${v.clouds.length} clouds):** ` +
			(unsupportedEntries.length === 0
				? "every cloud backs every kind."
				: unsupportedEntries.map(([c, ks]) => `${c} refuses ${ks.length} (${ks.join(", ")})`).join("; ") +
					"; every other cloud backs all 19."),
	);
	L.push("");

	// ── the CLI bar ──
	L.push("### Driven from the CLI");
	L.push("");
	L.push(
		`**${v.cli.cli} steps CLI-driven · ${v.cli.cli_gap} CLI gaps (our debt) · ` +
			`${v.cli.cloud_manual} cloud ceilings · ${v.cli.console_only} console by design.**`,
	);
	L.push("");
	if (v.cli.cli_gap === 0) {
		L.push(
			"The CLI debt is **zero** — every remaining blocker is a thing the cloud offers no API for, " +
				"not a thing Alethia has not built. That distinction is the one worth carrying into a demo.",
		);
	}
	L.push("");
	L.push("⚠️ Reachability only. The bar asserts the command surface resolves; it does **not** provision, and its real-binary half runs only when `E2E_CLI_DEMO` is set.");
	L.push("");
	if (v.cliBlockers.length > 0) {
		L.push("| step | verdict | clouds | issue |");
		L.push("|---|---|---|---|");
		for (const b of v.cliBlockers) {
			L.push(`| \`${b.id}\` | ${b.reach} | ${b.clouds.length === 0 ? "all" : b.clouds.join(", ")} | ${b.issue || "—"} |`);
		}
		L.push("");
	}

	// ── gate reality ──
	L.push("### Gate reality");
	L.push("");
	L.push("Whether a dimension can run at all. A gate the workflow never mentions cannot be turned on by setting a variable.");
	L.push("");
	L.push("| dimension | gate | referenced by the nightly? | what it proves |");
	L.push("|---|---|:---:|---|");
	for (const d of DIMENSIONS) {
		const missing = d.gateNames.filter((n) => !v.gates.has(n) && !v.gates.has(n.replace(/^ALETHIA_/, "")));
		const seen = d.gateNames.length === 0 ? "n/a" : missing.length === 0 ? "yes" : `**no** (${missing.join(", ")})`;
		L.push(`| ${d.label} | \`${d.gate}\` | ${seen} | ${d.what} |`);
	}
	L.push("");
	L.push(
		"Whether a gate is *set* is not knowable offline, so this file never claims it. It is reported " +
			"in the live snapshot half, and a cell may not leave `never-run` on an unknown.",
	);
	L.push("");

	// ── debt ratchets ──
	if (v.exclusionCounts !== undefined) {
		L.push("### Debt ratchets");
		L.push("");
		L.push("| board | recorded debt |");
		L.push("|---|---|");
		for (const [name, counts] of Object.entries(v.exclusionCounts)) {
			L.push(`| \`${name}\` | ${Object.entries(counts).map(([k, n]) => `${k}: ${n}`).join(" · ")} |`);
		}
		L.push("");
	}

	// ── provenance ──
	L.push("### Provenance");
	L.push("");
	L.push("Every number above is derived from these, and from nothing else:");
	L.push("");
	for (const f of [SPINE, LEDGER, WORKFLOW, UNSUPPORTED_KINDS, `${PROOFS_DIR}/<cloud>/<stamp>/`]) L.push(`- \`${f}\``);
	L.push("");
	L.push(
		`Ledger rows read: **${v.rows.length}** · surviving claims: **${[...v.claims.values()].filter((c) => c !== null).length}** ` +
			`(a \`RETRACTED\` row voids a claim rather than replacing it, so surviving < rows is expected).`,
	);
	L.push("");
	L.push("_Generated by `scripts/programme-rollup.mjs`. Do not edit below the marker — run `pnpm gen:programme`._");

	return L.join("\n");
}

// ───────────────────────────── splice ─────────────────────────────

/** Replace the generated region. Hard-errors on a missing or duplicated marker. */
export function splice(existing, generated) {
	const begins = existing.split(BEGIN).length - 1;
	const ends = existing.split(END).length - 1;
	if (begins === 0 || ends === 0) {
		throw new Error(`${TARGET}: missing the generated-region markers. Expected exactly one ${BEGIN} and one ${END}.`);
	}
	if (begins > 1 || ends > 1) {
		// Splicing into the first of two would silently orphan everything after the second — the
		// classic fail-open append. Refuse.
		throw new Error(`${TARGET}: found ${begins} BEGIN and ${ends} END markers — expected exactly one of each. Refusing to guess which region is live.`);
	}
	const head = existing.slice(0, existing.indexOf(BEGIN) + BEGIN.length);
	const tail = existing.slice(existing.indexOf(END));
	return `${head}\n\n${generated}\n\n${tail}`;
}

/**
 * The intent half may state intent, decisions and identifiers — never STATUS. Anything above the
 * marker that would need editing when a test result changes is a defect. This grep is the only
 * structural reason a 16th hand-maintained board cannot re-emerge inside this very file.
 */
export function intentHalfViolations(existing) {
	const idx = existing.indexOf(BEGIN);
	const intent = idx === -1 ? existing : existing.slice(0, idx);
	const out = [];
	for (const [i, line] of intent.split("\n").entries()) {
		if (/^\s*(#|>|_)/.test(line)) continue; // headings and quoted rationale
		// A CITATION is not a claim. Strip backticked code and double-quoted spans before matching,
		// so prose may name the very phrasing it forbids — the anti-patterns section has to be able
		// to say `"is green"` without tripping the rule that forbids saying it. Without this the
		// guard's only stable state is one where nobody can document it.
		const prose = line.replace(/`[^`]*`/g, " ").replace(/"[^"]*"/g, " ").replace(/[“][^”]*[”]/g, " ");
		if (/[✅❌⛔🔶]/.test(prose)) out.push(`${TARGET}:${i + 1}: a verdict glyph in the intent half — status belongs below the marker.`);
		if (/\b\d+\s*(?:of|\/)\s*\d+\s+(?:cells|clouds|proven|passing|green)\b/i.test(prose)) {
			out.push(`${TARGET}:${i + 1}: a derived count in the intent half — it will rot. Let the rollup render it.`);
		}
		if (/\b(?:is|are)\s+(?:now\s+)?(?:green|proven|passing|red)\b/i.test(prose)) {
			out.push(`${TARGET}:${i + 1}: a status claim in the intent half ("is green"/"is proven"/…) — status belongs below the marker.`);
		}
	}
	return out;
}

// ───────────────────────────── inputs ─────────────────────────────

/** Count the sections of one exclusions YAML, without pretending to parse YAML. */
function countExclusions(file) {
	if (!fs.existsSync(file)) return undefined;
	const text = fs.readFileSync(file, "utf8");
	/** @type {Record<string, number>} */
	const counts = {};
	let section = null;
	for (const line of text.split("\n")) {
		if (/^\s*#/.test(line)) continue;
		const top = line.match(/^([a-z_]+):\s*$/);
		if (top !== null) {
			section = top[1];
			counts[section] = 0;
			continue;
		}
		const scalar = line.match(/^([a-z_]+):\s*(\d+)\s*$/);
		if (scalar !== null) {
			counts[scalar[1]] = Number(scalar[2]);
			section = null;
			continue;
		}
		if (section !== null && /^\s+-\s/.test(line)) counts[section]++;
	}
	return counts;
}

function readInputs() {
	const need = (f) => {
		if (!fs.existsSync(f)) {
			console.error(`::error::programme-rollup: required input ${f} is missing. Refusing to render a partial ledger.`);
			process.exit(3);
		}
		return fs.readFileSync(f, "utf8");
	};
	return {
		ledgerText: need(LEDGER),
		spine: JSON.parse(need(SPINE)),
		workflowText: need(WORKFLOW),
		unsupportedText: need(UNSUPPORTED_KINDS),
		bundleExists: (p) => fs.existsSync(p),
		exclusionCounts: Object.fromEntries(
			[
				["infra/offer-exclusions.yaml", countExclusions("infra/offer-exclusions.yaml")],
				["infra/config-carriage-exclusions.yaml", countExclusions("infra/config-carriage-exclusions.yaml")],
				["infra/template-parity-exclusions.yaml", countExclusions("infra/template-parity-exclusions.yaml")],
			].filter(([, c]) => c !== undefined),
		),
	};
}

// ───────────────────────────── self-test ─────────────────────────────

const FIXTURE_SPINE = {
	clouds: ["aws", "hetzner"],
	kinds: [
		{ kind: "cluster", doc: "", foundational: true, cells: { aws: { carriage: "tofu", offered: true }, hetzner: { carriage: "tofu", offered: true } } },
		{ kind: "nosql", doc: "", foundational: false, cells: { aws: { carriage: "tofu", offered: true }, hetzner: { carriage: "ceiling", offered: false, why: "no service" } } },
		{ kind: "registry", doc: "", foundational: false, cells: { aws: { carriage: "tofu", offered: true }, hetzner: { carriage: "deferred", offered: false, chart: "harbor", why: "mapping missing" } } },
	],
	cli_steps: [
		{ id: "login", title: "", reach: "cli" },
		{ id: "dns-delegation", title: "", reach: "cloud_manual", issue: "#1773", why: "registrar" },
	],
};

function runSelfTest() {
	let fails = 0;
	const ok = (name, cond, detail = "") => {
		if (cond) console.log(`ok   - ${name}`);
		else {
			console.error(`FAIL - ${name}${detail ? `: ${detail}` : ""}`);
			fails++;
		}
	};
	const base = {
		spine: FIXTURE_SPINE,
		workflowText: "        ALETHIA_E2E_MAX_CONFIG: 1\n        ALETHIA_E2E_ALL_ADDONS: 1\n",
		unsupportedText: 'export const UNSUPPORTED_KINDS_BY_PROVIDER = {\n\thetzner: ["topic", "nosql"],\n}\n',
		bundleExists: () => true,
	};
	const hdr = "| UTC date | git sha | cloud | dimension | verdict | detail | bundle | issue |\n";
	const row = (d, cloud, dim, v, bundle, issue = "—") => `| ${d} | abc1234 | ${cloud} | ${dim} | **${v}** | detail | \`${bundle}\` | ${issue} |\n`;

	// A PASS with a committed bundle path is the ONLY thing that proves a cell.
	let r = derive({ ...base, ledgerText: hdr + row("2026-08-01", "aws", "floor", "PASS", "demos/proofs/aws/20260801T000000Z") });
	ok("a PASS with an existing committed bundle is proven", r.grid.aws.floor.state === "proven", r.grid.aws.floor.why);

	// The regression that produced four retracted rows: a PASS whose bundle is an expiring run tag.
	r = derive({ ...base, ledgerText: hdr + row("2026-07-22", "aws", "floor", "PASS", "nightly-29895597616") });
	ok("a PASS carrying an expiring CI run tag is NOT proven", r.grid.aws.floor.state === "never_run", r.grid.aws.floor.why);
	ok("...and says why in terms of the run tag", /run tag/i.test(r.grid.aws.floor.why));

	// A PASS whose bundle path is absent from the tree.
	r = derive({ ...base, bundleExists: () => false, ledgerText: hdr + row("2026-08-01", "aws", "floor", "PASS", "demos/proofs/aws/20260801T000000Z") });
	ok("a PASS whose bundle is missing from the tree is NOT proven", r.grid.aws.floor.state === "never_run", r.grid.aws.floor.why);

	// RETRACTED supersession — voids the claim rather than replacing it.
	r = derive({
		...base,
		ledgerText: hdr + row("2026-07-22", "aws", "floor", "PASS", "demos/proofs/aws/20260722T000000Z") + row("2026-07-31", "aws", "floor", "RETRACTED", "demos/proofs/aws/20260722T000000Z", "#1723"),
	});
	ok("a RETRACTED row voids the earlier PASS", r.grid.aws.floor.state === "never_run", r.grid.aws.floor.why);

	// ...and a PASS recorded AFTER a retraction stands again.
	r = derive({
		...base,
		ledgerText:
			hdr +
			row("2026-07-22", "aws", "floor", "PASS", "demos/proofs/aws/a") +
			row("2026-07-31", "aws", "floor", "RETRACTED", "demos/proofs/aws/a", "#1723") +
			row("2026-08-05", "aws", "floor", "PASS", "demos/proofs/aws/b"),
	});
	ok("a later PASS after a retraction is proven again", r.grid.aws.floor.state === "proven", r.grid.aws.floor.why);

	// FAIL and BLOCKED are distinct — one spent money and broke, the other refused before spending.
	r = derive({ ...base, ledgerText: hdr + row("2026-08-01", "aws", "floor", "FAIL", "demos/proofs/aws/x", "#2329") + row("2026-08-01", "hetzner", "floor", "BLOCKED", "demos/proofs/hetzner/x") });
	ok("FAIL renders as failing", r.grid.aws.floor.state === "failing");
	ok("BLOCKED is kept distinct from failing", r.grid.hetzner.floor.state === "blocked", r.grid.hetzner.floor.why);

	// The composite: a `full` PASS is evidence for every dimension.
	r = derive({ ...base, ledgerText: hdr + row("2026-08-01", "aws", "full", "PASS", "demos/proofs/aws/full") });
	ok("a `full` PASS proves every dimension", DIMENSIONS.every((d) => r.grid.aws[d.id].state === "proven"), JSON.stringify(Object.fromEntries(DIMENSIONS.map((d) => [d.id, r.grid.aws[d.id].state]))));
	ok("...and says it came via the composite", /composite/.test(r.grid.aws.maxconfig.why));

	// A direct claim beats the composite — the more specific statement wins.
	r = derive({ ...base, ledgerText: hdr + row("2026-08-01", "aws", "full", "PASS", "demos/proofs/aws/full") + row("2026-08-02", "aws", "addons", "FAIL", "demos/proofs/aws/y", "#1") });
	ok("a direct FAIL overrides a composite PASS", r.grid.aws.addons.state === "failing", r.grid.aws.addons.why);

	// INTEGRITY: rows nobody can render.
	r = derive({ ...base, ledgerText: hdr + row("2026-08-01", "vultr", "floor", "PASS", "demos/proofs/vultr/x") });
	ok("a ledger row naming an undeclared cloud is an integrity failure", r.failures.some((f) => /not one of the declared clouds/.test(f)), JSON.stringify(r.failures));
	r = derive({ ...base, ledgerText: hdr + row("2026-08-01", "aws", "vibes", "PASS", "demos/proofs/aws/x") });
	ok("a ledger row naming an unknown dimension is an integrity failure", r.failures.some((f) => /not one of/.test(f)), JSON.stringify(r.failures));
	r = derive({ ...base, ledgerText: hdr + "| 2026-08-01 | abc | aws | floor | **PROBABLY** | d | `b` | — |\n" });
	ok("an unknown verdict is an integrity failure, never a skip", r.failures.some((f) => /unknown verdict/.test(f)), JSON.stringify(r.failures));

	// The Go mirror carries the two exclusions apart.
	r = derive({ ...base, ledgerText: hdr });
	ok("deferred debt is surfaced separately from ceilings", r.carriage.deferred === 1 && r.carriage.ceiling === 1, JSON.stringify(r.carriage));
	ok("...and the deferred cell names its chart", r.deferredCells[0]?.chart === "harbor", JSON.stringify(r.deferredCells));
	ok("cloud_manual CLI steps are surfaced as blockers", r.cliBlockers.some((b) => b.id === "dns-delegation"));
	ok("the 19-kind grid is read from unsupported-kinds.ts", (r.unsupported.hetzner ?? []).join(",") === "topic,nosql", JSON.stringify(r.unsupported));

	// VACUITY. An empty ledger must report every cell never-run, not zero cells.
	const empty = derive({ ...base, ledgerText: hdr });
	const cells = empty.clouds.length * DIMENSIONS.length;
	ok("vacuity: an empty ledger reports every cell never-run", empty.tally.never_run === cells && empty.tally.proven === 0, JSON.stringify(empty.tally));
	ok("vacuity: the grid is fully populated", empty.clouds.every((c) => DIMENSIONS.every((d) => empty.grid[c][d.id] !== undefined)));
	ok("vacuity: rendering an all-never-run grid still produces the tables", (() => {
		const out = render(empty);
		return out.includes("Proof grid") && out.includes("The mechanical next") && out.includes("Provenance");
	})());

	// The mechanical next ranks failing above never-run.
	r = derive({ ...base, ledgerText: hdr + row("2026-08-01", "hetzner", "day2", "FAIL", "demos/proofs/hetzner/x", "#1") });
	ok("the mechanical next puts a failing cell first", r.next[0]?.state === "failing" && r.next[0]?.dimension === "day2", JSON.stringify(r.next[0]));

	// splice() refuses ambiguity rather than silently appending into the first region.
	ok("splice writes between the markers", splice(`intro\n${BEGIN}\nstale\n${END}\ntail`, "FRESH").includes("FRESH"));
	ok("splice drops the previous generated content", !splice(`intro\n${BEGIN}\nstale\n${END}\ntail`, "FRESH").includes("stale"));
	ok("splice preserves the intent half and the tail", (() => {
		const out = splice(`intro\n${BEGIN}\nstale\n${END}\ntail`, "FRESH");
		return out.startsWith("intro") && out.endsWith("tail");
	})());
	for (const [name, doc] of [
		["a missing marker", "no markers here"],
		["a duplicated BEGIN", `${BEGIN}\na\n${BEGIN}\nb\n${END}`],
		["a duplicated END", `${BEGIN}\na\n${END}\nb\n${END}`],
	]) {
		let threw = false;
		try {
			splice(doc, "X");
		} catch {
			threw = true;
		}
		ok(`splice refuses ${name}`, threw);
	}

	// The intent-half grep — the structural reason a hand board cannot re-emerge inside this file.
	ok("a verdict glyph above the marker is rejected", intentHalfViolations(`we are ✅ on aws\n${BEGIN}\n${END}`).length > 0);
	ok("a derived count above the marker is rejected", intentHalfViolations(`3 of 5 clouds proven\n${BEGIN}\n${END}`).length > 0);
	ok("a status claim above the marker is rejected", intentHalfViolations(`azure is green now\n${BEGIN}\n${END}`).length > 0);
	ok("ordinary intent prose is accepted", intentHalfViolations(`Order: floor, then all kinds, then the full bar. Next: #2356.\n${BEGIN}\n${END}`).length === 0);
	ok("a heading naming a glyph is not a false positive", intentHalfViolations(`# Anti-patterns: never type ✅\n${BEGIN}\n${END}`).length === 0);
	// A citation is not a claim: the anti-patterns section must be able to name the phrasing it
	// forbids. Both directions are asserted, because an over-broad strip would gut the rule.
	ok('a QUOTED example of forbidden phrasing is accepted', intentHalfViolations(`Never write "is green" here.\n${BEGIN}\n${END}`).length === 0);
	ok("a BACKTICKED glyph is accepted", intentHalfViolations(`Legend lives below: \`✅\`.\n${BEGIN}\n${END}`).length === 0);
	ok(
		"...but an UNQUOTED claim on the same line as a quoted one is still caught",
		intentHalfViolations(`Never write "is green"; but azure is proven today.\n${BEGIN}\n${END}`).length > 0,
	);

	// GATE DETECTION. The fidelity vars are exported by a `run:` step as
	// `echo "ALETHIA_E2E_MAX_CONFIG=1" >> "$GITHUB_ENV"`, not as a YAML `env:` key. Matching only
	// `NAME:` reported the two heaviest dimensions as unreachable while the workflow set them itself.
	// A false "no" sends somebody to wire a gate that is already wired, so both shapes are pinned.
	ok("a gate exported via $GITHUB_ENV counts as referenced", referencedGates('  run: echo "ALETHIA_E2E_MAX_CONFIG=1" >> "$GITHUB_ENV"').has("ALETHIA_E2E_MAX_CONFIG"));
	ok("a gate declared as a YAML env key counts as referenced", referencedGates("        ALETHIA_E2E_ALL_ADDONS: 1").has("ALETHIA_E2E_ALL_ADDONS"));
	ok("a gate read from vars/secrets counts as referenced", referencedGates("        FOO: ${{ secrets.E2E_GIT_TOKEN }}").has("E2E_GIT_TOKEN"));
	ok("a gate named only in a COMMENT does not count", !referencedGates("      # ALETHIA_E2E_NEVER_WIRED is a nice idea").has("ALETHIA_E2E_NEVER_WIRED"));
	ok("every declared gate name is a concrete name, never a wildcard", DIMENSIONS.every((d) => d.gateNames.every((n) => /^[A-Z0-9_]+$/.test(n))), JSON.stringify(DIMENSIONS.map((d) => d.gateNames)));

	// The cell arithmetic is rendered, so it must be counted rather than composed — this asserts the
	// grid total equals kinds × clouds, which is what a `0 cells` slip broke.
	{
		const r2 = derive({ ...base, ledgerText: hdr });
		const total = Object.values(r2.carriage).reduce((a, b) => a + b, 0);
		ok("carriage cells total kinds × clouds", total === r2.kindCount * r2.clouds.length, `${total} != ${r2.kindCount} × ${r2.clouds.length}`);
		ok("...and the rendered text says so rather than 0", render(r2).includes(`× ${r2.clouds.length} clouds = ${total} cells`), render(r2).split("\n").find((l) => l.includes("cells):")));
	}

	// bundleKind.
	ok("bundleKind: committed path", bundleKind("demos/proofs/aws/20260801T000000Z") === "path");
	ok("bundleKind: bare cloud/stamp is a path", bundleKind("hetzner/20260805T064043Z") === "path");
	ok("bundleKind: nightly run tag", bundleKind("nightly-29895597616") === "run-tag");
	ok("bundleKind: empty", bundleKind("") === "none");

	if (fails > 0) {
		console.error(`\nself-test: ${fails} check(s) FAILED`);
		process.exit(1);
	}
	console.log("\nself-test: all passed");
}

// ───────────────────────────── main ─────────────────────────────

const executedDirectly = process.argv[1] !== undefined && import.meta.url === `file://${fs.realpathSync(process.argv[1])}`;

if (!executedDirectly) {
	// imported — expose the helpers, touch nothing.
} else if (process.argv.includes("--self-test")) {
	runSelfTest();
} else {
	const view = derive(readInputs());
	const generated = render(view);

	const existing = fs.existsSync(TARGET) ? fs.readFileSync(TARGET, "utf8") : "";
	if (existing === "") {
		console.error(`::error::programme-rollup: ${TARGET} does not exist. Create it with the two generated-region markers first.`);
		process.exit(3);
	}

	const intentViolations = intentHalfViolations(existing);
	const integrity = [...view.failures, ...intentViolations];

	if (process.argv.includes("--write")) {
		fs.writeFileSync(TARGET, splice(existing, generated));
		console.log(`wrote ${TARGET} — ${view.tally.proven} proven / ${view.tally.failing} failing / ${view.tally.never_run} never-run`);
	}

	for (const f of integrity) console.error(`::error::programme-rollup: ${f}`);
	if (integrity.length > 0) {
		console.error(`\nprogramme-rollup: ${integrity.length} integrity failure(s) — a cell is lying.`);
		process.exit(1);
	}

	if (!process.argv.includes("--write")) {
		const want = splice(existing, generated);
		if (want !== fs.readFileSync(TARGET, "utf8")) {
			console.error(`::error::programme-rollup: ${TARGET}'s generated half is STALE — run \`pnpm gen:programme\` and commit.`);
			process.exit(2);
		}
		console.log(`programme-rollup: ${TARGET} is in sync — ${view.tally.proven} proven / ${view.tally.failing} failing / ${view.tally.never_run} never-run`);
	}
}
