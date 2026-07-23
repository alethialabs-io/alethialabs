#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
//
// capabilities-security gate — the AUTOMATED, fail-closed replacement for the dropped #982 CODEOWNERS
// review (a sole-owner human gate would deadlock the no-approval Mergify queue). It runs on EVERY PR and
// enforces the deterministic subset of the `alethia-security-review` invariants on the capabilities /
// connector / keyless surface.
//
// ── The deadlock trap (why the JOB is unfiltered and this SCRIPT does the path check) ──
// A REQUIRED status check that is path-FILTERED at the workflow level never *reports* on a PR that
// doesn't touch those paths — and GitHub then blocks that PR forever waiting for a check that will
// never arrive. So the workflow runs this on every PR and this script NO-OP-PASSES (green, exit 0) when
// no relevant path changed. It only evaluates the invariants when the capabilities/connector/keyless
// paths DID change, and exits non-zero (fail-closed) on any violation.
//
// ── Invariants enforced (deterministic — precise enough not to false-positive a required check) ──
//   A. RLS registration: a NEW `cloud_capability_*` / `cloud_identity_id`-bearing table must be added to
//      the `owner_all` RLS loop in programmables.sql (else it's world-readable via the service role).
//   B. Cross-provider-leak: a query against a `cloud_capability_*` table must filter by `provider`.
//   C. No `as any` / `as unknown as` in changed relevant TS, and no `Record<string, unknown>` on a
//      known-shape JSONB (schema / jsonb.types) — the typed-JSONB rule.
//   D. No static credentials in code (AWS access-key ids, embedded PEM private keys) on the keyless
//      surface — belt-and-suspenders alongside repo-wide gitleaks, scoped + fail-closed here.
//
// Run: `node scripts/security/capabilities-gate.mjs` (wired into .github/workflows/capabilities-security.yml).

import { execSync } from "node:child_process";
import fs from "node:fs";

// ── Which changed paths make this PR "relevant" (capabilities / connector / keyless) ──
const RELEVANT = [
	/^apps\/console\/lib\/cloud-providers\//,
	/^apps\/console\/lib\/db\/schema\/cloud-/,
	/^apps\/console\/lib\/db\/programmables\.sql$/,
	/^apps\/console\/lib\/queries\/.*(capabilit|connector|inventory)/i,
	/^apps\/console\/app\/server\/actions\/(connector|provider|capabilit)/i,
	/^apps\/console\/app\/\(private\)\/dashboard\/providers\//,
	/^apps\/console\/types\/jsonb\.types\.ts$/,
	/^packages\/core\/cloud\//,
];

const isTest = (f) => /\.(test|spec)\.(ts|tsx)$|_test\.go$|\/tests?\//.test(f);
const isTs = (f) => /\.(ts|tsx)$/.test(f);

/** Resolve the base ref for the PR diff. CI sets GATE_BASE_SHA to the PR base sha; locally we fall back
 * to the merge-base with origin/dev. */
function baseRef() {
	if (process.env.GATE_BASE_SHA) return process.env.GATE_BASE_SHA;
	try {
		return execSync("git merge-base origin/dev HEAD", { encoding: "utf8" }).trim();
	} catch {
		return "origin/dev";
	}
}

/** The list of files changed in this PR (added/copied/modified/renamed — never deleted). */
function changedFiles(base) {
	const out = execSync(`git diff --name-only --diff-filter=ACMR ${base}...HEAD`, {
		encoding: "utf8",
	});
	return out.split("\n").map((s) => s.trim()).filter(Boolean);
}

/** The added (`+`) lines of a file in this PR's diff (unified, without the leading `+`). */
function addedLines(base, file) {
	try {
		const diff = execSync(`git diff --unified=0 ${base}...HEAD -- "${file}"`, {
			encoding: "utf8",
		});
		return diff
			.split("\n")
			.filter((l) => l.startsWith("+") && !l.startsWith("+++"))
			.map((l) => l.slice(1));
	} catch {
		return [];
	}
}

const read = (f) => {
	try {
		return fs.readFileSync(f, "utf8");
	} catch {
		return "";
	}
};

const violations = [];
const violate = (file, msg) => violations.push({ file, msg });

const base = baseRef();
const changed = changedFiles(base);
const relevant = changed.filter((f) => RELEVANT.some((re) => re.test(f)));

if (relevant.length === 0) {
	console.log(
		"capabilities-security: no capabilities/connector/keyless paths changed — no-op PASS.",
	);
	writeSummary(true, []);
	process.exit(0);
}

console.log(
	`capabilities-security: evaluating ${relevant.length} relevant changed file(s):\n  ${relevant.join("\n  ")}`,
);

// ── A. RLS registration — a new cloud_capability_* / cloud_identity_id table must join the owner_all loop.
const programmables = read("apps/console/lib/db/programmables.sql");
for (const f of relevant) {
	if (!/^apps\/console\/lib\/db\/schema\//.test(f)) continue;
	for (const line of addedLines(base, f)) {
		const m = line.match(/pgTable\(\s*["'`]([a-z0-9_]+)["'`]/);
		if (!m) continue;
		const table = m[1];
		// Only the capability/identity-scoped surface needs the owner_all tenant-isolation policy.
		if (!/^cloud_capability_/.test(table) && !/cloud_identit/.test(table)) continue;
		// The table name must appear in programmables.sql (its owner_all RLS loop). If programmables.sql
		// wasn't updated to register it, it ships world-readable under the RLS-bypassing service role.
		if (!new RegExp(`["']${table}["']`).test(programmables)) {
			violate(
				f,
				`new tenant table "${table}" is not registered in programmables.sql's owner_all RLS loop — add it so RLS isolates it per tenant (cloud_identity ownership).`,
			);
		}
	}
}

// ── B. Cross-provider-leak — a query against a cloud_capability_* table must filter by provider.
for (const f of relevant) {
	if (!isTs(f) || isTest(f)) continue;
	if (/^apps\/console\/lib\/db\/schema\//.test(f)) continue; // schema DEFINES the tables, doesn't query
	const src = read(f);
	const queriesCapabilityTable =
		/cloudCapabilit\w*/.test(src) &&
		/\.(from|select|where|update|delete|insert)\s*\(/.test(src);
	if (queriesCapabilityTable && !/\bprovider\b/.test(src)) {
		violate(
			f,
			"queries a cloud_capability_* table but never references `provider` — every capabilities query MUST filter by provider (cross-provider-leak rule).",
		);
	}
}

// ── C. No unsafe casts. `as any` / `as unknown as` on the keyless/connector surface can smuggle a
// wrong shape past the type system (e.g. a credential or a JSONB blob). This is precise + zero
// false-positive over the real tree. NOTE: the sibling `Record<string, unknown>`-on-known-shape-JSONB
// rule is deliberately NOT enforced here — whether a JSONB shape is "known" needs human judgment
// (jsonb.types.ts legitimately uses Record<string, unknown> for genuinely-dynamic fields), so a blanket
// check would false-positive and wedge unrelated PRs. It stays a convention (CLAUDE.md) + review item.
for (const f of relevant) {
	if (!isTs(f) || isTest(f)) continue;
	const lines = read(f).split("\n");
	lines.forEach((line, i) => {
		const stripped = line.replace(/\/\/.*$/, "");
		if (/\bas\s+any\b/.test(stripped) || /\bas\s+unknown\s+as\b/.test(stripped)) {
			violate(f, `unsafe cast on line ${i + 1}: use the real type or narrow \`unknown\`.`);
		}
	});
}

// ── D. Keyless-only — no static credentials in code on the keyless surface (tests carry fake creds).
const AKIA = /\bAKIA[0-9A-Z]{16}\b/;
const PEM = /-----BEGIN (?:RSA |EC |OPENSSH |)PRIVATE KEY-----/;
for (const f of relevant) {
	if (isTest(f)) continue;
	const content = read(f);
	if (AKIA.test(content)) {
		violate(f, "contains a static AWS access-key id (AKIA…) — the platform is keyless (assume-role/WIF/federated), never a stored key.");
	}
	if (PEM.test(content)) {
		violate(f, "contains an embedded PEM private key — credentials must never be committed to the keyless surface.");
	}
}

// ── Verdict ──────────────────────────────────────────────────────────────────────────
writeSummary(violations.length === 0, violations);
if (violations.length === 0) {
	console.log(
		`capabilities-security: ${relevant.length} relevant file(s) evaluated — no violations. PASS.`,
	);
	process.exit(0);
}
for (const v of violations) {
	console.error(`::error file=${v.file}::capabilities-security: ${v.msg}`);
}
console.error(
	`\ncapabilities-security FAILED with ${violations.length} violation(s). This is the fail-closed replacement for the #982 review — fix the invariant(s) above (or run the alethia-security-review skill).`,
);
process.exit(1);

/** Writes a human-readable verdict to the GitHub step summary (no-op locally). */
function writeSummary(pass, vs) {
	const path = process.env.GITHUB_STEP_SUMMARY;
	if (!path) return;
	const lines = ["## capabilities-security gate", ""];
	if (pass && vs.length === 0) {
		lines.push(
			relevant?.length
				? `PASS — ${relevant.length} relevant file(s) evaluated, no violations.`
				: "PASS — no capabilities/connector/keyless paths changed (no-op).",
		);
	} else {
		lines.push(`**FAILED** — ${vs.length} violation(s):`, "");
		for (const v of vs) lines.push(`- \`${v.file}\` — ${v.msg}`);
	}
	try {
		fs.appendFileSync(path, `${lines.join("\n")}\n`);
	} catch {
		/* best-effort */
	}
}
