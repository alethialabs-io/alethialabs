#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
//
// TEMPLATE-VARIABLE PARITY RATCHET (#2004)
//
// ── The hole this fills ─────────────────────────────────────────────────────────────────────────
//
// Two guards already measure cross-cloud parity, and BOTH derive their surface from the canvas:
//
//   check-offer-parity.mjs    builds MEASURED_KINDS from the canvas offer surface
//   check-config-carriage.mjs walks user-settable COLUMNS from storage -> Go -> tfvars -> template
//
// So a capability that is a TEMPLATE VARIABLE and not a canvas offer is invisible to both. No guard
// can red it, and no deferral written about it can ever go stale. That is not hypothetical: AWS has
// envelope-encrypted Kubernetes Secrets under a customer-managed key since the template was written
// — the upstream EKS module defaults `create_kms_key = true` — while GKE, AKS and ACK had nothing.
// The gap was not boarded, not excluded, and not in the parity doc for the whole life of the
// templates (#2004). The silent third state the cloud-parity rule exists to forbid.
//
// ── What it measures, and what it deliberately does NOT ────────────────────────────────────────
//
// It measures ONE fully-derived property: which root template variables exist on which clouds.
// A variable declared on some clouds and absent on others is a parity SUSPECT.
//
// It does NOT try to decide whether `eks_kms_key_users` and `gke_secrets_encryption_enabled` are
// "the same capability". That mapping cannot be derived — the names are per-cloud by nature — and a
// hand-written one drifts exactly the way the thing it guards drifts, which is the lesson #1419
// already paid for. So the guard answers the question it CAN answer without guessing, and the
// human-meaningful grouping lives in the exclusions file next to the reason.
//
// The verdict is therefore about ASYMMETRY, not about correctness: a variable on 1 of 5 clouds is
// either a real gap, or a genuine per-cloud ceiling that should be written down. Both outcomes are
// fine. Neither being recorded is not.
//
// ── Ratchet semantics ───────────────────────────────────────────────────────────────────────────
//
// `infra/template-parity-exclusions.yaml`, same four-section shape as its siblings:
//
//   exclusions: permanent — a cloud CANNOT express this. Reason must carry provider evidence.
//   baseline:   tracked debt — an asymmetry that exists today, with an `issue:`.
//   uniform:    the variable is deliberately single-cloud and implies no parity question at all
//               (a cloud-specific escape hatch, a provider-shaped knob with no analogue).
//
// Today's asymmetries land in `baseline:` and do not fail the build. A NEW asymmetry fails. A
// baseline entry that stops reproducing must be deleted. The list can only shrink.
//
// Usage:  node scripts/check-template-parity.mjs [--matrix] [--self-test]

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { readGoPackage, traceField } from "./lib/go-tfvars-trace.mjs";
import { readTfWiring, selfCheck as tfWiringSelfCheck } from "./lib/tf-wiring.mjs";

const ROOT = "../..";
const TEMPLATES = `${ROOT}/infra/templates/project`;
const PROVIDERS = `${ROOT}/packages/core/cloud`;
const EXCLUSIONS = `${ROOT}/infra/template-parity-exclusions.yaml`;
const MATRIX_OUT = `${ROOT}/docs/testing/template-parity.md`;

const args = new Set(process.argv.slice(2));
const WANT_MATRIX = args.has("--matrix");

// Prove the reader still reads before trusting a word it says. A parser that silently returns
// nothing would report perfect parity — the loudest possible lie this guard could tell.
tfWiringSelfCheck();

/** Strip `#` and `//` line comments, leaving strings intact. */
function stripLineComments(src) {
	let out = "";
	let inStr = false;
	for (let i = 0; i < src.length; i++) {
		const c = src[i];
		if (inStr) {
			out += c;
			if (c === "\\") {
				out += src[++i] ?? "";
			} else if (c === '"') inStr = false;
			continue;
		}
		if (c === '"') {
			inStr = true;
			out += c;
			continue;
		}
		if (c === "#" || (c === "/" && src[i + 1] === "/")) {
			while (i < src.length && src[i] !== "\n") i++;
			out += "\n";
			continue;
		}
		out += c;
	}
	return out;
}

/** Every .tf file under a directory, recursively, with its path — the shape readTfWiring wants. */
function readTfFiles(dir) {
	if (!existsSync(dir)) return [];
	const out = [];
	for (const e of readdirSync(dir, { withFileTypes: true })) {
		if (e.name === ".terraform") continue;
		const full = join(dir, e.name);
		if (e.isDirectory()) out.push(...readTfFiles(full));
		else if (e.name.endsWith(".tf")) out.push({ path: full, text: stripLineComments(readFileSync(full, "utf8")) });
	}
	return out;
}

// Clouds with a GO PROVIDER, not merely a template directory — the same split
// check-config-carriage.mjs makes, and for the same reason. `infra/templates/project/local` is a
// kind cluster for development with no Go provider at all; counting it would make every real
// cloud's variables look asymmetric against a template nothing provisions, manufacturing a whole
// column of false gaps.
const GO_PKG = readGoPackage(PROVIDERS);
const CLOUDS = readdirSync(TEMPLATES, { withFileTypes: true })
	.filter((e) => e.isDirectory() && existsSync(`${TEMPLATES}/${e.name}/variables.tf`))
	.map((e) => e.name)
	.filter((c) => !traceField(GO_PKG, c, "AlethiaProbeField").entryMissing)
	.sort();

if (CLOUDS.length < 2) {
	console.error(`✗ template parity: found ${CLOUDS.length} cloud template(s) under ${TEMPLATES} — the comparison would be vacuous.`);
	process.exit(1);
}

// cloud -> Set(root variable name)
const rootVars = new Map();
for (const cloud of CLOUDS) {
	const wiring = readTfWiring(readTfFiles(`${TEMPLATES}/${cloud}`), `${TEMPLATES}/${cloud}`);
	// ROOT variables only — a submodule declaring the same name buys a tfvars value nothing, because
	// OpenTofu drops a value whose ROOT variable is undeclared.
	const names = new Set(wiring.rootVariableNames());
	if (names.size === 0) {
		console.error(`✗ template parity: parsed ZERO root variables for ${cloud} — the reader is broken, not the template.`);
		process.exit(1);
	}
	rootVars.set(cloud, names);
}

// ── the exclusions file ─────────────────────────────────────────────────────────────────────────
/** Minimal YAML reader for the four-section shape these files use. Deliberately not a dependency:
 * the sibling guards parse their own, and the shape is fixed. */
function readExclusions(path) {
	const out = { exclusions: [], baseline: [], uniform: [] };
	if (!existsSync(path)) return out;
	let section = null;
	let cur = null;
	for (const raw of readFileSync(path, "utf8").split("\n")) {
		const line = raw.replace(/\s+$/, "");
		if (/^[a-z_]+:\s*$/.test(line)) {
			section = line.slice(0, -1);
			cur = null;
			continue;
		}
		if (!section || !(section in out)) continue;
		const item = line.match(/^\s*-\s+([a-z_]+):\s*(.*)$/);
		if (item) {
			cur = { [item[1]]: stripQuotes(item[2]) };
			out[section].push(cur);
			continue;
		}
		const kv = line.match(/^\s+([a-z_]+):\s*(.*)$/);
		if (kv && cur) cur[kv[1]] = stripQuotes(kv[2]);
	}
	return out;
}
function stripQuotes(v) {
	const t = v.trim();
	if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) return t.slice(1, -1);
	return t;
}

const recorded = readExclusions(EXCLUSIONS);
/** variable name -> the record that covers it, whatever section it came from. */
const covered = new Map();
for (const section of ["exclusions", "baseline", "uniform"]) {
	for (const r of recorded[section]) {
		if (!r.variable) continue;
		covered.set(r.variable, { ...r, section });
	}
}

// ── the measurement ─────────────────────────────────────────────────────────────────────────────
const allVars = new Set();
for (const s of rootVars.values()) for (const n of s) allVars.add(n);

/** variable -> clouds that declare it */
const presence = new Map();
for (const name of allVars) {
	presence.set(
		name,
		CLOUDS.filter((c) => rootVars.get(c).has(name)),
	);
}

const asymmetric = [...allVars]
	.filter((n) => presence.get(n).length < CLOUDS.length)
	.sort();

const unrecorded = asymmetric.filter((n) => !covered.has(n));
const staleRecords = [...covered.entries()].filter(([name]) => allVars.has(name) && presence.get(name).length === CLOUDS.length);
const goneRecords = [...covered.entries()].filter(([name]) => !allVars.has(name));

// ── report ──────────────────────────────────────────────────────────────────────────────────────
let failed = false;

if (unrecorded.length > 0) {
	failed = true;
	console.error(`\n✗ template parity — ${unrecorded.length} UNRECORDED asymmetric root variable(s):\n`);
	for (const n of unrecorded) {
		const on = presence.get(n);
		const off = CLOUDS.filter((c) => !on.includes(c));
		console.error(`  ${n}`);
		console.error(`      on:  ${on.join(", ")}`);
		console.error(`      off: ${off.join(", ")}`);
	}
	console.error(`\n  Each is either a real parity gap or a per-cloud ceiling. Record it in`);
	console.error(`  infra/template-parity-exclusions.yaml — exclusions: (cannot), baseline: (debt, with an`);
	console.error(`  issue), or uniform: (single-cloud by nature). An unrecorded asymmetry is the silent`);
	console.error(`  third state this guard exists to remove.\n`);
}

if (staleRecords.length > 0) {
	failed = true;
	console.error(`\n✗ template parity — ${staleRecords.length} record(s) whose asymmetry is FIXED:\n`);
	for (const [name, r] of staleRecords) console.error(`  ${name}  (${r.section}${r.issue ? ` · ${r.issue}` : ""}) — now on every cloud`);
	console.error(`\n  Delete them; the list can only shrink.\n`);
}

if (goneRecords.length > 0) {
	failed = true;
	console.error(`\n✗ template parity — ${goneRecords.length} record(s) for a variable that no longer exists:\n`);
	for (const [name, r] of goneRecords) console.error(`  ${name}  (${r.section}) — declared on no cloud`);
	console.error("");
}

if (WANT_MATRIX) {
	const lines = [];
	lines.push("<!-- GENERATED by apps/console/scripts/check-template-parity.mjs — do not edit by hand. -->");
	lines.push("");
	lines.push("# Template-variable parity");
	lines.push("");
	lines.push("Which root template variables each cloud declares, for every variable that is **not** on all");
	lines.push("of them. Derived from the templates themselves; the reasons come from");
	lines.push("`infra/template-parity-exclusions.yaml`.");
	lines.push("");
	lines.push("This is the surface the offer-parity and config-carriage guards cannot see: both build their");
	lines.push("view from the canvas, so a capability that is only a template variable is invisible to them.");
	lines.push("");
	lines.push(`| Variable | ${CLOUDS.join(" | ")} | State | Why |`);
	lines.push(`|---|${CLOUDS.map(() => "---").join("|")}|---|---|`);
	for (const n of asymmetric) {
		const on = presence.get(n);
		const rec = covered.get(n);
		const cells = CLOUDS.map((c) => (on.includes(c) ? "✅" : "🚫")).join(" | ");
		const state = rec ? (rec.section === "exclusions" ? "ceiling" : rec.section) : "**UNRECORDED**";
		const why = rec ? `${rec.reason ?? ""}${rec.issue ? ` (${rec.issue})` : ""}` : "—";
		lines.push(`| \`${n}\` | ${cells} | ${state} | ${why} |`);
	}
	lines.push("");
	writeFileSync(MATRIX_OUT, `${lines.join("\n")}\n`);
	console.log(`wrote ${MATRIX_OUT}`);
}

if (failed) process.exit(1);

console.log(
	`✓ template parity — ${allVars.size} root variable(s) across ${CLOUDS.length} clouds; ${asymmetric.length} asymmetric, all recorded.`,
);
console.log(
	`✓ ${recorded.exclusions.length} ceiling(s), ${recorded.baseline.length} tracked gap(s), ${recorded.uniform.length} single-cloud-by-nature.`,
);
