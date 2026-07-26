// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Board-proposal validator for the `decompose` skill (spec → GitHub-Issues board).
//
// Decomposition used to be 100% manual: a maintainer hand-authored the seams issue +
// every fine lane, hand-checking that no two claimable units shared a `scope:` glob.
// That hand-check is exactly what stops the mega-commit tangle (two instances editing
// the same files, then one `git add -A` sweeping both features into one commit — see
// .claude/COORDINATION.md and the "Shared-checkout entanglement" incident). This script
// makes that check mechanical so the `decompose` skill can refuse to seed a bad board.
//
// It takes a JSON array of PROPOSED issues (pre-creation, dry-run) on stdin or a file
// arg and enforces the board contract:
//   (a) NO two units share a scope glob — the anti-tangle invariant. Overlap is detected
//       structurally (normalize + segment-match), so `lib/**` vs `lib/db/**` (prefix
//       subsumption) and `*.tf` vs `main.tf` collide, not just byte-identical globs.
//   (b) Every NON-seams unit declares at least one `blockedBy` (the interface-first shape:
//       one seams issue with no blocked-by; every fine lane blocked-by the seams issue).
//   (c) Every label is from the known board set (coordinate.sh --init-labels), and each
//       unit carries exactly one class: and at least one wave: label.
//   (d) The blockedBy graph (over in-proposal references) is ACYCLIC.
//
// Proposal unit shape (see .claude/skills/decompose/SKILL.md for the authored contract):
//   {
//     "id": 1,                                        // optional; defaults to 1-based index
//     "title": "seams: project_* shared types + schema",
//     "labels": ["wave:W1", "lane:schema", "class:backend"],
//     "scope": ["apps/console/lib/db/schema/project_*.ts"],
//     "blockedBy": []                                 // refs other units' ids (the seams unit)
//   }
// A unit is the "seams" unit when its title matches /\bseams?\b/i AND it has no blockedBy.
//
// Usage:
//   node scripts/decompose-validate.mjs proposal.json   # validate a file
//   cat proposal.json | node scripts/decompose-validate.mjs
//   node scripts/decompose-validate.mjs --self-test     # inline fixtures (no I/O)
// Exits 0 on PASS, non-zero on FAIL / bad input.

import { readFileSync } from "node:fs";

// ── the known board label set (mirror of coordinate.sh --init-labels) ──────────
const WAVE_LABELS = new Set([
	"wave:W1",
	"wave:W2",
	"wave:W3",
	"wave:W4",
	"wave:W5",
	"wave:W6",
	"wave:W7",
	"wave:hygiene",
]);
const LANE_LABELS = new Set([
	"lane:schema",
	"lane:server",
	"lane:runner",
	"lane:core",
	"lane:canvas",
	"lane:tests",
	"lane:docs",
]);
const CLASS_LABELS = new Set(["class:backend", "class:ui"]);
// Operational labels are maintained at RUNTIME by claim-work.sh / coordinate.sh — a fresh
// proposal must not pre-set them (they'd corrupt the claim/blocked bookkeeping). mutex/needs
// labels ARE legitimately authored into a proposal.
const RUNTIME_LABELS = new Set(["claimed", "blocked"]);
const AUTHORABLE_EXTRA = new Set([
	"mutex:migration",
	"needs:design",
	"needs:human",
]);
const KNOWN_LABELS = new Set([
	...WAVE_LABELS,
	...LANE_LABELS,
	...CLASS_LABELS,
	...RUNTIME_LABELS,
	...AUTHORABLE_EXTRA,
]);

/** Normalize a scope glob: trim, drop a leading `./`, collapse `//`, drop a trailing `/`. */
function normalizeGlob(glob) {
	return String(glob)
		.trim()
		.replace(/^\.\//, "")
		.replace(/\/{2,}/g, "/")
		.replace(/\/+$/, "");
}

/** Compile one path SEGMENT (no `/`) into an anchored regex; `*` → any run of non-slash chars. */
function segToRegex(seg) {
	const body = seg
		.split("*")
		.map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
		.join("[^/]*");
	return new RegExp(`^${body}$`);
}

/**
 * Do two path segments overlap — i.e. is there a filename matching both? `**` is handled by the
 * caller (multi-segment), so here a segment is a literal or a single-segment `*`-glob. Conservative
 * on purpose: when both carry intra-segment wildcards we test a few witness strings and treat them
 * as overlapping if any is matched by both, because a MISSED overlap is what causes the tangle.
 */
function segMatch(a, b) {
	if (a === b) return true;
	if (a === "*" || b === "*") return true;
	const hasWildA = a.includes("*");
	const hasWildB = b.includes("*");
	if (!hasWildA && !hasWildB) return false; // two distinct literals — disjoint
	const rxA = segToRegex(a);
	const rxB = segToRegex(b);
	// Witnesses: each pattern with `*` collapsed to "" and to a filler run.
	const witnesses = [
		a.replace(/\*/g, ""),
		a.replace(/\*/g, "x9z"),
		b.replace(/\*/g, ""),
		b.replace(/\*/g, "x9z"),
	];
	return witnesses.some((w) => rxA.test(w) && rxB.test(w));
}

/**
 * Do two normalized globs overlap? Segment-by-segment match where `**` matches zero-or-more
 * segments; catches exact equality, prefix subsumption (`a/lib/**` ⊇ `a/lib/db/**`), and
 * wildcard siblings, while keeping disjoint dirs (`a/x/**` vs `a/y/**`) disjoint.
 */
function globsOverlap(g1, g2) {
	const a = normalizeGlob(g1).split("/");
	const b = normalizeGlob(g2).split("/");
	/** Recursive segment matcher over the remaining segments of each glob. */
	const walk = (i, j) => {
		if (i >= a.length && j >= b.length) return true;
		if (i >= a.length) return b.slice(j).every((s) => s === "**");
		if (j >= b.length) return a.slice(i).every((s) => s === "**");
		if (a[i] === "**") return walk(i + 1, j) || walk(i, j + 1);
		if (b[j] === "**") return walk(i, j + 1) || walk(i + 1, j);
		if (segMatch(a[i], b[j])) return walk(i + 1, j + 1);
		return false;
	};
	return walk(0, 0);
}

/** A unit is the interface-first "seams" issue when its title says so and it has no blocked-by. */
function isSeams(unit) {
	return /\bseams?\b/i.test(unit.title ?? "") && (unit.blockedBy ?? []).length === 0;
}

/**
 * Validate a proposed issue set against the board contract. Returns { errors, warnings } —
 * `errors` non-empty ⇒ the board must NOT be seeded.
 */
function validate(proposal) {
	const errors = [];
	const warnings = [];

	if (!Array.isArray(proposal)) {
		return { errors: ["proposal must be a JSON array of issue objects"], warnings };
	}
	if (proposal.length === 0) {
		return { errors: ["proposal is empty — nothing to seed"], warnings };
	}

	// Assign a stable id to each unit (explicit `id`, else 1-based index) + basic shape checks.
	const units = proposal.map((u, idx) => ({
		id: u.id ?? idx + 1,
		title: u.title ?? "",
		labels: Array.isArray(u.labels) ? u.labels : [],
		scope: Array.isArray(u.scope) ? u.scope.filter(Boolean) : [],
		blockedBy: Array.isArray(u.blockedBy) ? u.blockedBy : [],
		_idx: idx,
	}));

	const seen = new Set();
	for (const u of units) {
		const tag = `#${u.id} "${u.title || "(untitled)"}"`;
		if (seen.has(u.id)) errors.push(`duplicate unit id ${u.id}`);
		seen.add(u.id);
		if (!u.title) errors.push(`unit ${tag} has no title`);
		if (u.scope.length === 0) errors.push(`unit ${tag} declares no scope: glob`);
	}

	// ── (c) labels are from the known set; exactly one class: + at least one wave: ──────
	for (const u of units) {
		const tag = `#${u.id} "${u.title}"`;
		for (const label of u.labels) {
			if (!KNOWN_LABELS.has(label)) {
				errors.push(`unit ${tag} has unknown label "${label}" (not in the board label set)`);
			} else if (RUNTIME_LABELS.has(label)) {
				errors.push(
					`unit ${tag} pre-sets runtime label "${label}" — claimed/blocked are set by ` +
						`claim-work.sh / coordinate.sh, never authored into a proposal`,
				);
			}
		}
		const classes = u.labels.filter((l) => CLASS_LABELS.has(l));
		if (classes.length !== 1) {
			errors.push(`unit ${tag} must carry exactly one class: label (has ${classes.length})`);
		}
		const waves = u.labels.filter((l) => WAVE_LABELS.has(l));
		if (waves.length < 1) errors.push(`unit ${tag} carries no wave: label`);
		if (waves.length > 1) warnings.push(`unit ${tag} carries multiple wave: labels`);
		if (!u.labels.some((l) => LANE_LABELS.has(l))) {
			warnings.push(`unit ${tag} carries no lane: label (recommended for board reporting)`);
		}
	}

	// ── (b) every non-seams unit declares a blocked-by; exactly one seams root ──────────
	const seamsUnits = units.filter(isSeams);
	if (seamsUnits.length === 0) {
		errors.push(
			"no interface-first seams unit found — expected exactly one unit whose title says " +
				'"seams" with an empty blockedBy (the shared types/schema/contract everything blocks on)',
		);
	} else if (seamsUnits.length > 1) {
		warnings.push(
			`${seamsUnits.length} seams units found (${seamsUnits
				.map((u) => `#${u.id}`)
				.join(", ")}); the interface-first pattern seeds ONE seams root per wave`,
		);
	}
	for (const u of units) {
		if (isSeams(u)) continue;
		if (u.blockedBy.length === 0) {
			errors.push(
				`unit #${u.id} "${u.title}" has no blockedBy — every non-seams lane must be blocked-by ` +
					"the seams issue (interface-first: schema/contract lands before the lanes)",
			);
		}
	}

	// ── build the in-proposal blockedBy graph (shared by the scope + cycle checks) ──────
	const idSet = new Set(units.map((u) => u.id));
	const edges = new Map(); // id -> [ids it is blocked-by, restricted to in-proposal units]
	for (const u of units) {
		edges.set(
			u.id,
			u.blockedBy.filter((d) => idSet.has(d) && d !== u.id),
		);
		if (u.blockedBy.includes(u.id)) errors.push(`unit #${u.id} is blocked-by itself`);
	}

	/** Can `from` reach `to` by following blockedBy edges? (i.e. `to` transitively blocks `from`.) */
	const reaches = (from, to) => {
		const visited = new Set();
		const stack = [...(edges.get(from) ?? [])];
		while (stack.length) {
			const n = stack.pop();
			if (n === to) return true;
			if (visited.has(n)) continue;
			visited.add(n);
			stack.push(...(edges.get(n) ?? []));
		}
		return false;
	};

	// ── (a) no two CO-CLAIMABLE units share a scope glob (the anti-tangle invariant) ────
	// The invariant is over open+CLAIMABLE units. A unit and something that (transitively)
	// blocks it are never claimable at once — the blocked one waits — so a seams↔dependent
	// scope overlap is NOT a live tangle and is allowed. Only siblings (neither blocks the
	// other) can be worked simultaneously, so only those must have disjoint scopes.
	for (let i = 0; i < units.length; i++) {
		for (let j = i + 1; j < units.length; j++) {
			const a = units[i];
			const b = units[j];
			if (reaches(a.id, b.id) || reaches(b.id, a.id)) continue; // ordered by blocked-by
			for (const g1 of a.scope) {
				for (const g2 of b.scope) {
					if (globsOverlap(g1, g2)) {
						errors.push(
							`SCOPE COLLISION: #${a.id} ("${a.title}") glob "${g1}" overlaps ` +
								`#${b.id} ("${b.title}") glob "${g2}" — these units are co-claimable ` +
								"(neither blocks the other), so sharing files is the mega-commit tangle the board forbids",
						);
					}
				}
			}
		}
	}

	// ── (d) the blockedBy graph (over in-proposal refs) is acyclic ──────────────────────
	const WHITE = 0;
	const GREY = 1;
	const BLACK = 2;
	const color = new Map(units.map((u) => [u.id, WHITE]));
	const stack = [];
	let cycle = null;
	/** DFS that paints GREY on the recursion stack; a GREY re-visit is a back edge = cycle. */
	const dfs = (node) => {
		color.set(node, GREY);
		stack.push(node);
		for (const next of edges.get(node) ?? []) {
			if (color.get(next) === GREY) {
				const from = stack.indexOf(next);
				cycle = [...stack.slice(from), next];
				return true;
			}
			if (color.get(next) === WHITE && dfs(next)) return true;
		}
		stack.pop();
		color.set(node, BLACK);
		return false;
	};
	for (const u of units) {
		if (color.get(u.id) === WHITE && dfs(u.id)) break;
	}
	if (cycle) {
		errors.push(`blockedBy CYCLE: ${cycle.map((n) => `#${n}`).join(" → ")}`);
	}

	return { errors, warnings };
}

/** Print a PASS/FAIL report for a validation result and return the process exit code. */
function report(proposal, { errors, warnings }) {
	for (const w of warnings) console.warn(`  ⚠ ${w}`);
	if (errors.length === 0) {
		const n = Array.isArray(proposal) ? proposal.length : 0;
		console.log(`✓ PASS — ${n} proposed unit(s) form a well-shaped, tangle-free board.`);
		return 0;
	}
	console.error(`✗ FAIL — ${errors.length} problem(s); do NOT seed this board:\n`);
	for (const e of errors) console.error(`  • ${e}`);
	console.error(
		"\n  Fix the proposal (split overlapping scopes into disjoint lanes, add the missing\n" +
			"  blocked-by, correct the labels) and re-validate. See .claude/skills/decompose/SKILL.md.\n",
	);
	return 1;
}

// ── self-test: inline fixtures (no board / no I/O), mirroring claim-work.sh's run_self_test ──
function runSelfTest() {
	let fails = 0;
	/** Assert a fixture validates to the expected pass/fail, printing an ok/FAIL line. */
	const expect = (name, prop, shouldPass) => {
		const { errors } = validate(prop);
		const passed = errors.length === 0;
		if (passed === shouldPass) {
			console.log(`ok   - ${name}`);
		} else {
			fails++;
			console.error(
				`FAIL - ${name}: expected ${shouldPass ? "PASS" : "FAIL"} but got ${
					passed ? "PASS" : "FAIL"
				}${errors.length ? ` (${errors[0]})` : ""}`,
			);
		}
	};

	// A clean interface-first set: one seams root, three disjoint lanes blocked-by it.
	const clean = [
		{
			id: 1,
			title: "seams: project_* shared types + schema contract",
			labels: ["wave:W1", "lane:schema", "class:backend"],
			scope: ["apps/console/lib/db/schema/project_shared.ts"],
			blockedBy: [],
		},
		{
			id: 2,
			title: "server actions for project placement",
			labels: ["wave:W1", "lane:server", "class:backend"],
			scope: ["apps/console/app/server/actions/placement/**"],
			blockedBy: [1],
		},
		{
			id: 3,
			title: "runner placement executor",
			labels: ["wave:W1", "lane:runner", "class:backend"],
			scope: ["apps/runner/internal/agent/placement/**"],
			blockedBy: [1],
		},
		{
			id: 4,
			title: "placement canvas node config sheet",
			labels: ["wave:W1", "lane:canvas", "class:ui"],
			scope: ["apps/console/components/canvas/placement/**"],
			blockedBy: [1],
		},
	];
	expect("clean interface-first set PASSes", clean, true);

	// Overlapping scope between two SIBLING lanes (both blocked-by the seams, so co-claimable):
	// prefix subsumption `lib/db/**` ⊇ `lib/db/schema/project.ts`.
	const overlap = [
		{
			id: 1,
			title: "seams: shared schema",
			labels: ["wave:W1", "lane:schema", "class:backend"],
			scope: ["apps/console/lib/db/schema/shared.ts"],
			blockedBy: [],
		},
		{
			id: 2,
			title: "db lane",
			labels: ["wave:W1", "lane:schema", "class:backend"],
			scope: ["apps/console/lib/db/**"],
			blockedBy: [1],
		},
		{
			id: 3,
			title: "placement schema lane",
			labels: ["wave:W1", "lane:server", "class:backend"],
			scope: ["apps/console/lib/db/schema/project.ts"],
			blockedBy: [1],
		},
	];
	expect("overlapping sibling scope (prefix subsumption) FAILs", overlap, false);

	// Seams ⊇ dependent overlap is ALLOWED — the dependent is blocked-by the seams, so they are
	// never claimable at the same time (no live tangle). This is the interface-first pattern.
	const seamsDependentOverlap = [
		{
			id: 1,
			title: "seams: shared schema contract",
			labels: ["wave:W1", "lane:schema", "class:backend"],
			scope: ["apps/console/lib/db/schema/**"],
			blockedBy: [],
		},
		{
			id: 2,
			title: "placement schema lane",
			labels: ["wave:W1", "lane:schema", "class:backend"],
			scope: ["apps/console/lib/db/schema/project.ts"],
			blockedBy: [1],
		},
	];
	expect("seams ⊇ dependent overlap PASSes (not co-claimable)", seamsDependentOverlap, true);

	// Wildcard-sibling overlap: `*.tf` vs `main.tf` in the same directory.
	const wildcardOverlap = [
		{
			id: 1,
			title: "seams: tofu contract",
			labels: ["wave:W2", "lane:core", "class:backend"],
			scope: ["packages/core/verify/report.go"],
			blockedBy: [],
		},
		{
			id: 2,
			title: "aws template lane",
			labels: ["wave:W2", "lane:core", "class:backend"],
			scope: ["infra/templates/project/aws/*.tf"],
			blockedBy: [1],
		},
		{
			id: 3,
			title: "aws main override lane",
			labels: ["wave:W2", "lane:core", "class:backend"],
			scope: ["infra/templates/project/aws/main.tf"],
			blockedBy: [1],
		},
	];
	expect("wildcard-sibling scope overlap FAILs", wildcardOverlap, false);

	// Disjoint sibling dirs must NOT be flagged.
	const disjoint = [
		{
			id: 1,
			title: "seams: shared",
			labels: ["wave:W1", "lane:schema", "class:backend"],
			scope: ["apps/console/lib/db/schema/shared.ts"],
			blockedBy: [],
		},
		{
			id: 2,
			title: "aws lane",
			labels: ["wave:W1", "lane:core", "class:backend"],
			scope: ["infra/templates/project/aws/**"],
			blockedBy: [1],
		},
		{
			id: 3,
			title: "gcp lane",
			labels: ["wave:W1", "lane:core", "class:backend"],
			scope: ["infra/templates/project/gcp/**"],
			blockedBy: [1],
		},
	];
	expect("disjoint sibling dirs PASS (no false positive)", disjoint, true);

	// Missing blocked-by on a non-seams lane.
	const missingBlockedBy = [
		{
			id: 1,
			title: "seams: shared",
			labels: ["wave:W1", "lane:schema", "class:backend"],
			scope: ["apps/console/lib/db/schema/shared.ts"],
			blockedBy: [],
		},
		{
			id: 2,
			title: "server lane with no blocker",
			labels: ["wave:W1", "lane:server", "class:backend"],
			scope: ["apps/console/app/server/actions/foo/**"],
			blockedBy: [],
		},
	];
	expect("non-seams unit missing blockedBy FAILs", missingBlockedBy, false);

	// Cyclic blocked-by.
	const cyclic = [
		{
			id: 1,
			title: "seams: shared",
			labels: ["wave:W1", "lane:schema", "class:backend"],
			scope: ["apps/console/lib/db/schema/shared.ts"],
			blockedBy: [3],
		},
		{
			id: 2,
			title: "server lane",
			labels: ["wave:W1", "lane:server", "class:backend"],
			scope: ["apps/console/app/server/actions/foo/**"],
			blockedBy: [1],
		},
		{
			id: 3,
			title: "runner lane",
			labels: ["wave:W1", "lane:runner", "class:backend"],
			scope: ["apps/runner/internal/agent/foo/**"],
			blockedBy: [2],
		},
	];
	expect("cyclic blockedBy FAILs", cyclic, false);

	// Unknown label.
	const badLabel = [
		{
			id: 1,
			title: "seams: shared",
			labels: ["wave:W9", "lane:schema", "class:backend"],
			scope: ["apps/console/lib/db/schema/shared.ts"],
			blockedBy: [],
		},
	];
	expect("unknown label FAILs", badLabel, false);

	// Two class labels.
	const twoClasses = [
		{
			id: 1,
			title: "seams: shared",
			labels: ["wave:W1", "lane:schema", "class:backend", "class:ui"],
			scope: ["apps/console/lib/db/schema/shared.ts"],
			blockedBy: [],
		},
	];
	expect("unit with two class: labels FAILs", twoClasses, false);

	if (fails === 0) {
		console.log("\nself-test: all passed");
		process.exit(0);
	}
	console.error(`\nself-test: ${fails} check(s) FAILED`);
	process.exit(1);
}

// ── entry point ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
if (args.includes("--self-test")) {
	runSelfTest();
}

let raw;
const fileArg = args.find((a) => !a.startsWith("-"));
try {
	raw = fileArg ? readFileSync(fileArg, "utf8") : readFileSync(0, "utf8");
} catch (err) {
	console.error(`✗ could not read proposal (${fileArg ?? "stdin"}): ${err.message}`);
	process.exit(2);
}

let proposal;
try {
	proposal = JSON.parse(raw);
} catch (err) {
	console.error(`✗ proposal is not valid JSON: ${err.message}`);
	process.exit(2);
}

process.exit(report(proposal, validate(proposal)));
