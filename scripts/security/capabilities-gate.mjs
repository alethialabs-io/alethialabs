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
// ── Scope is the whole gate (#1789) ──
// Everything below is downstream of one decision: which changed files this gate looks at AT ALL. A file
// outside that set is not "passed" — it is never read, and the check goes green. The first version of
// this list named roughly the console-lib third of the keyless surface #1500 shipped, so a PEM added to
// apps/runner/internal/agent/authproxy.go, or an `as any` on the fail-closed keyless gate in
// app/server/actions/projects.ts, was a GREEN `capabilities-security`.
//
// So scope is expressed as a PROPERTY of a file, in three layers, not as a list of today's files:
//   1. AREAS   — directories that ARE this surface end to end (every file in them is in scope).
//   2. NAMED   — any path whose own segments carry the surface's vocabulary (keyless, connector,
//                credential, authproxy, oidc, cloud-identity, …), anywhere in the tree.
//   3. SYMBOLS — any source file whose CONTENT reaches the keyless/capability API, wherever it lives.
//                This is what puts projects.ts in scope: it is not named for keyless, it *holds* the
//                fail-closed keyless gate. A file that starts touching this API is guarded from that
//                commit on, with nobody remembering to add it here.
//
// A derived list is not available: `gen:keyless-cells` (apps/console/scripts/gen-keyless-cells.mjs)
// emits a provider × engine STATE matrix — nothing in its output names a file path. So the layers below
// are authored, and `--self-test` guards them: it asserts every known-guarded path both still EXISTS and
// still MATCHES (a rename that silently drops a file out of scope reds the guards job), and that
// out-of-scope paths still do not match (so "widen everything" cannot pass trivially).
//
// ── Invariants enforced (deterministic — precise enough not to false-positive a required check) ──
//   A. RLS registration: a NEW `cloud_capability_*` / `cloud_identity_id`-bearing table must be added to
//      the `owner_all` RLS loop in programmables.sql (else it's world-readable via the service role).
//   B. Cross-provider-leak: a query against a `cloud_capability_*` table must filter by `provider`.
//   C. No `as any` / `as unknown as` in changed relevant TS.
//      This is the WHOLE of invariant C. The sibling CLAUDE.md rule — never `Record<string, unknown>`
//      for a JSONB field whose shape is known — is NOT enforced here and this gate claims no coverage
//      of it: deciding whether a shape is "known" is human judgment, and jsonb.types.ts legitimately
//      uses `Record<string, unknown>` for genuinely dynamic fields (AddOnValues, StagedChangePayload,
//      tool-call args). A blanket check would false-positive, and a false positive on a REQUIRED check
//      wedges unrelated PRs. It stays a convention (CLAUDE.md §6) + a review item.
//   D. No static credentials in code (AWS access-key ids, embedded PEM private keys) on the keyless
//      surface — belt-and-suspenders alongside the repo-wide gitleaks job, scoped + fail-closed here.
//
// Run: `node scripts/security/capabilities-gate.mjs` (wired into .github/workflows/capabilities-security.yml).
// Self-test: `node scripts/security/capabilities-gate.mjs --self-test` (wired into ci.yml's `guards` job).

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// ── Layer 1: AREAS — directories that ARE the capabilities/connector/keyless surface ─────────────────
// Whole directories, not the interesting files inside them, and deliberately wider than the invariants
// strictly need: each invariant carries its own precise filter (A keys on the TABLE name, B on the
// queried table, C/D on file content), so pre-filtering by filename here only ever creates blind spots.
const SURFACE_AREAS = [
	/^apps\/console\/lib\/cloud-providers\//,
	/^apps\/console\/lib\/connectors\//,
	// Every schema file: invariant A keys on the table NAME, so a cloud_capability_* table declared in
	// any schema file must be seen — not only one declared in a file called cloud-*.
	/^apps\/console\/lib\/db\/schema\//,
	/^apps\/console\/lib\/db\/programmables\.sql$/,
	// Every query module: invariant B decides for itself whether a file queries a capability table.
	/^apps\/console\/lib\/queries\//,
	// Every server action: this is the console's trust boundary — where a request becomes a decision
	// about a tenant's cloud identity. #1510's fail-closed keyless gate lives in projects.ts.
	/^apps\/console\/app\/server\/actions\//,
	/^apps\/console\/app\/\(private\)\/dashboard\/providers\//,
	/^apps\/console\/types\/jsonb\.types\.ts$/,
	/^packages\/core\/cloud\//,
	// The renderers that decide what a keyless binding emits (keyless*.go, generate.go, bootstrap_job.go).
	/^packages\/core\/manifests\//,
	// The runner mints and hands out every cloud credential — authproxy*.go, db_token.go, db_bootstrap.go,
	// *_credentials.go. There was no apps/runner pattern here at all until #1789.
	/^apps\/runner\/internal\/agent\//,
];

// ── Layer 2: NAMED — the surface's vocabulary appearing anywhere in a path ────────────────────────────
const SURFACE_NAMED =
	/(keyless|capabilit|connector|credential|authproxy|oidc|iam[-_]?auth|inventor|cloud[-_]?identit|db[-_]?(token|bootstrap)|secret[-_]?store|secrets[-_]?runtime)/i;

// ── Layer 3: SYMBOLS — the keyless/capability API reached from a file's content ───────────────────────
const SURFACE_SYMBOLS =
	/(keylessCell\w*|keylessUnavailableReason\w*|keylessAuthGate\w*|KEYLESS_CELLS|cloudCapabilit\w*|cloudIdentit\w*|\biam_auth\b|\bcloud_identity\b)/;

/** Source files whose CONTENT is worth reading for layer 3 — code, not prose or fixtures. */
const SOURCE_EXT = /\.(ts|tsx|mjs|go|sql)$/;

// Prose and marketing trees: no cloud-identity code path runs from them, and a docs page that quotes an
// example key must not wedge a REQUIRED check. Committed secrets there are still caught repo-wide by the
// gitleaks job in ci.yml. They are excluded from layers 2 and 3 only — never from an AREA.
const PROSE_TREES = [/^apps\/docs\//, /^docs\//, /^demos\//, /^\.claude\//, /^apps\/marketing\//];

/** True for a test file (TS or Go) — tests legitimately carry fake credentials and cast freely. */
const isTest = (f) => /\.(test|spec)\.(ts|tsx)$|_test\.go$|\/tests?\//.test(f);
/** True for a TypeScript source file — the only files invariants B and C can read. */
const isTs = (f) => /\.(ts|tsx)$/.test(f);
/** True for a drizzle schema file — where invariant A looks for a new tenant table. */
const isSchema = (f) => /^apps\/console\/lib\/db\/schema\//.test(f);

/** True when a path is documentation, marketing or design prose rather than product code. */
function isProse(file) {
	return PROSE_TREES.some((re) => re.test(file));
}

/** True when this file is on the capabilities/connector/keyless surface, and therefore gets inspected.
 *
 * `content` is the file's current text; it is only consulted for layer 3 (SYMBOLS) and may be empty for
 * a file whose path already decides the answer. */
function isRelevant(file, content = "") {
	if (SURFACE_AREAS.some((re) => re.test(file))) return true;
	if (isProse(file)) return false;
	if (SURFACE_NAMED.test(file)) return true;
	return SOURCE_EXT.test(file) && SURFACE_SYMBOLS.test(content);
}

// ── The invariants, as pure functions over one entry ─────────────────────────────────────────────────
// An `entry` is `{ file, content, added }`: the path, the file's current text, and the `+` lines this PR
// added to it. Every check is total over an entry and returns the violations it found, so the self-test
// can drive them from inline fixtures without shelling out to git.

/** A violation record — the file that broke an invariant and the operator-facing why. */
const violation = (file, msg) => ({ file, msg });

/** A. RLS registration — a new cloud_capability_* / cloud_identity table must join the owner_all loop. */
function checkRlsRegistration(entry, programmables) {
	const out = [];
	if (!isSchema(entry.file)) return out;
	for (const line of entry.added) {
		const m = line.match(/pgTable\(\s*["'`]([a-z0-9_]+)["'`]/);
		if (!m) continue;
		const table = m[1];
		// Only the capability/identity-scoped surface needs the owner_all tenant-isolation policy.
		if (!/^cloud_capability_/.test(table) && !/cloud_identit/.test(table)) continue;
		// The table name must appear in programmables.sql (its owner_all RLS loop). If programmables.sql
		// wasn't updated to register it, it ships world-readable under the RLS-bypassing service role.
		if (!new RegExp(`["']${table}["']`).test(programmables)) {
			out.push(
				violation(
					entry.file,
					`new tenant table "${table}" is not registered in programmables.sql's owner_all RLS loop — add it so RLS isolates it per tenant (cloud_identity ownership).`,
				),
			);
		}
	}
	return out;
}

/** B. Cross-provider-leak — a query against a cloud_capability_* table must filter by provider. */
function checkCrossProviderLeak(entry) {
	if (!isTs(entry.file) || isTest(entry.file)) return [];
	if (isSchema(entry.file)) return []; // schema DEFINES the tables, doesn't query them
	const queriesCapabilityTable =
		/cloudCapabilit\w*/.test(entry.content) &&
		/\.(from|select|where|update|delete|insert)\s*\(/.test(entry.content);
	if (queriesCapabilityTable && !/\bprovider\b/.test(entry.content)) {
		return [
			violation(
				entry.file,
				"queries a cloud_capability_* table but never references `provider` — every capabilities query MUST filter by provider (cross-provider-leak rule).",
			),
		];
	}
	return [];
}

/** C. No unsafe casts. `as any` / `as unknown as` on the keyless/connector surface can smuggle a wrong
 * shape past the type system (e.g. a credential or a JSONB blob). Precise + zero false-positive over the
 * real tree. See the header for what invariant C deliberately does NOT cover. */
function checkUnsafeCasts(entry) {
	if (!isTs(entry.file) || isTest(entry.file)) return [];
	const out = [];
	entry.content.split("\n").forEach((line, i) => {
		const stripped = line.replace(/\/\/.*$/, "");
		if (/\bas\s+any\b/.test(stripped) || /\bas\s+unknown\s+as\b/.test(stripped)) {
			out.push(
				violation(entry.file, `unsafe cast on line ${i + 1}: use the real type or narrow \`unknown\`.`),
			);
		}
	});
	return out;
}

const AKIA = /\bAKIA[0-9A-Z]{16}\b/;
const PEM = /-----BEGIN (?:RSA |EC |OPENSSH |)PRIVATE KEY-----/;

/** D. Keyless-only — no static credentials in code on the keyless surface (tests carry fake creds). */
function checkStaticCredentials(entry) {
	if (isTest(entry.file)) return [];
	const out = [];
	if (AKIA.test(entry.content)) {
		out.push(
			violation(
				entry.file,
				"contains a static AWS access-key id (AKIA…) — the platform is keyless (assume-role/WIF/federated), never a stored key.",
			),
		);
	}
	if (PEM.test(entry.content)) {
		out.push(
			violation(
				entry.file,
				"contains an embedded PEM private key — credentials must never be committed to the keyless surface.",
			),
		);
	}
	return out;
}

/** Evaluate every invariant over the relevant entries, check-major (A, then B, then C, then D) so the
 * failure report groups by invariant rather than by file. */
function evaluate(entries, programmables) {
	const violations = [];
	for (const e of entries) violations.push(...checkRlsRegistration(e, programmables));
	for (const e of entries) violations.push(...checkCrossProviderLeak(e));
	for (const e of entries) violations.push(...checkUnsafeCasts(e));
	for (const e of entries) violations.push(...checkStaticCredentials(e));
	return violations;
}

// ── git / filesystem I/O (everything above is pure) ──────────────────────────────────────────────────

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
	return out
		.split("\n")
		.map((s) => s.trim())
		.filter(Boolean);
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

/** Read a file, or "" when it is unreadable (deleted, binary, outside the checkout). */
const read = (f) => {
	try {
		return fs.readFileSync(f, "utf8");
	} catch {
		return "";
	}
};

/** Writes a human-readable verdict to the GitHub step summary (no-op locally). */
function writeSummary(relevantCount, vs) {
	const summaryPath = process.env.GITHUB_STEP_SUMMARY;
	if (!summaryPath) return;
	const lines = ["## capabilities-security gate", ""];
	if (vs.length === 0) {
		lines.push(
			relevantCount
				? `PASS — ${relevantCount} relevant file(s) evaluated, no violations.`
				: "PASS — no capabilities/connector/keyless paths changed (no-op).",
		);
	} else {
		lines.push(`**FAILED** — ${vs.length} violation(s):`, "");
		for (const v of vs) lines.push(`- \`${v.file}\` — ${v.msg}`);
	}
	try {
		fs.appendFileSync(summaryPath, `${lines.join("\n")}\n`);
	} catch {
		/* best-effort */
	}
}

/** The real gate: diff the PR, keep the relevant files, evaluate the invariants, exit 0/1. */
function main() {
	const base = baseRef();
	const changed = changedFiles(base);

	const entries = [];
	for (const file of changed) {
		// Read first, ask second: layer 3 decides relevance from the file's own content, and every
		// invariant needs the text anyway. A PR's file list is bounded, so this stays cheap.
		const content = read(file);
		if (!isRelevant(file, content)) continue;
		// `added` only feeds invariant A, which only looks at schema files — don't shell out per file.
		entries.push({ file, content, added: isSchema(file) ? addedLines(base, file) : [] });
	}

	if (entries.length === 0) {
		console.log("capabilities-security: no capabilities/connector/keyless paths changed — no-op PASS.");
		writeSummary(0, []);
		return 0;
	}

	console.log(
		`capabilities-security: evaluating ${entries.length} relevant changed file(s):\n  ${entries
			.map((e) => e.file)
			.join("\n  ")}`,
	);

	const violations = evaluate(entries, read("apps/console/lib/db/programmables.sql"));
	writeSummary(entries.length, violations);

	if (violations.length === 0) {
		console.log(
			`capabilities-security: ${entries.length} relevant file(s) evaluated — no violations. PASS.`,
		);
		return 0;
	}
	for (const v of violations) {
		console.error(`::error file=${v.file}::capabilities-security: ${v.msg}`);
	}
	console.error(
		`\ncapabilities-security FAILED with ${violations.length} violation(s). This is the fail-closed replacement for the #982 review — fix the invariant(s) above (or run the alethia-security-review skill).`,
	);
	return 1;
}

// ── self-test ────────────────────────────────────────────────────────────────────────────────────────
// The guard's own guard (#1789). Two halves, and both are load-bearing:
//   • scope — every known-guarded path still EXISTS and still MATCHES, and out-of-scope paths still
//     do NOT match. Without the negative half, "widen everything" would pass trivially.
//   • invariants — A/B/C/D still fire, and still stay quiet on the shapes they must not flag. Driven
//     from inline fixtures. Mirrors scripts/decompose-validate.mjs's runSelfTest.
// It reads the checkout (that is the point of the scope half) but runs no git and touches no network.

/** Paths that MUST be in scope. Each is a real repo path — the self-test reads it, so a rename or a
 * deletion that quietly drops it out of scope fails here rather than months later on a green PR. */
const GUARDED_PATHS = [
	// console — the third the gate already covered
	"apps/console/lib/cloud-providers/keyless.ts",
	"apps/console/lib/cloud-providers/generated/keyless-cells.ts",
	"apps/console/lib/db/schema/cloud-capabilities.ts",
	"apps/console/lib/db/schema/cloud-inventory.ts",
	"apps/console/lib/db/programmables.sql",
	"apps/console/lib/queries/capabilities.ts",
	"apps/console/types/jsonb.types.ts",
	"apps/console/app/server/actions/connectors.ts",
	"apps/console/app/(private)/dashboard/providers/actions.ts",
	// the #1510 fail-closed keyless gate — the file the old actions regex could not match
	"apps/console/app/server/actions/projects.ts",
	// in scope only because of what they CONTAIN (layer 3) — nothing in their path says "keyless"
	"apps/console/lib/stores/use-canvas-store.ts",
	"apps/console/lib/promotions/diff.ts",
	"packages/core/provisioner/deploy.go",
	"packages/core/types/project_config.go",
	// console — named for the surface, outside every area (layer 2)
	"apps/console/app/api/cli/cloud-identities/route.ts",
	"apps/console/components/connector/aws-connection.tsx",
	"apps/console/lib/oidc/issuer.ts",
	// packages/core — the Go ORIGINALS behind the generated console mirror
	"packages/core/manifests/keyless.go",
	"packages/core/manifests/generate.go",
	"packages/core/manifests/bootstrap_job.go",
	"packages/core/categories/secrets_keyless.go",
	"packages/core/cloud/aws_provider.go",
	"packages/core/cloud/alibaba_tenant_identity.go",
	// runner — mints and hands out every cloud credential
	"apps/runner/internal/agent/authproxy.go",
	"apps/runner/internal/agent/authproxy_mysql.go",
	"apps/runner/internal/agent/db_bootstrap.go",
	"apps/runner/internal/agent/db_token.go",
	"apps/runner/internal/agent/aws_credentials.go",
];

/** Real paths that must stay OUT of scope — the half that stops "widen everything" from passing. */
const OUT_OF_SCOPE_PATHS = [
	"packages/ui/src/accordion.tsx",
	"apps/console/components/ui/bubble.tsx",
	"apps/console/lib/db/migrations/meta/_journal.json",
	// Prose carve-out: named for the surface, but documentation, not a code path.
	"apps/docs/content/docs/console/connectors/aws.mdx",
	"apps/docs/content/docs/console/design-project/keyless-database-auth.mdx",
	"apps/marketing/components/landing/home/sections/keyless.tsx",
];

/** Run the inline fixtures. Returns the process exit code. */
function runSelfTest() {
	let fails = 0;
	/** Assert a named condition, printing an ok/FAIL line and counting failures. */
	const check = (name, ok, detail = "") => {
		if (ok) {
			console.log(`ok   - ${name}`);
			return;
		}
		fails++;
		console.error(`FAIL - ${name}${detail ? `: ${detail}` : ""}`);
	};
	/** Assert a file's relevance verdict, reading its real content from the checkout. */
	const expectScope = (file, shouldMatch) => {
		const abs = path.join(REPO_ROOT, file);
		const exists = fs.existsSync(abs);
		if (shouldMatch && !exists) {
			check(`guarded path exists: ${file}`, false, "file is gone — it was renamed or deleted, so the gate no longer inspects it. Re-point GUARDED_PATHS at wherever this surface moved.");
			return;
		}
		const content = exists ? read(abs) : "";
		check(
			`${shouldMatch ? "in scope" : "out of scope"}: ${file}`,
			isRelevant(file, content) === shouldMatch,
			shouldMatch
				? "a known-guarded path stopped matching — the gate would now skip it and report GREEN."
				: "an unrelated path started matching — scope has been widened past the surface this gate is named for.",
		);
	};
	/** Assert an inline entry set produces (or does not produce) violations. */
	const expectGate = (name, entries, programmables, shouldPass) => {
		const vs = evaluate(
			entries.map((e) => ({ content: "", added: [], ...e })),
			programmables,
		);
		check(
			name,
			(vs.length === 0) === shouldPass,
			shouldPass ? `expected PASS, got: ${vs[0]?.msg}` : "expected a violation, got none",
		);
	};

	console.log("── scope: every known-guarded path exists and matches ──");
	for (const f of GUARDED_PATHS) expectScope(f, true);

	console.log("\n── scope: unrelated paths still do not match ──");
	for (const f of OUT_OF_SCOPE_PATHS) expectScope(f, false);
	// Synthetic negatives: a source file with no surface vocabulary and no surface symbols.
	check(
		"out of scope: a plain store with no surface symbols",
		!isRelevant("apps/console/lib/stores/use-theme-store.ts", "export const useTheme = () => 1;"),
	);
	check(
		"out of scope: a runner file outside the agent package",
		!isRelevant("apps/runner/internal/logging/logger.go", "package logging"),
	);
	check(
		"in scope: any file that reaches the keyless API, wherever it lives",
		isRelevant(
			"apps/console/lib/promotions/diff.ts",
			"const changed = a.iam_auth !== b.iam_auth;",
		),
	);

	console.log("\n── invariant A: RLS registration ──");
	expectGate(
		"new cloud_capability_* table missing from programmables.sql FAILs",
		[
			{
				file: "apps/console/lib/db/schema/cloud-capabilities.ts",
				added: ['export const x = pgTable("cloud_capability_zones", {'],
			},
		],
		"for t in ('cloud_capability_regions') loop",
		false,
	);
	expectGate(
		"new cloud_capability_* table registered in programmables.sql PASSes",
		[
			{
				file: "apps/console/lib/db/schema/cloud-capabilities.ts",
				added: ['export const x = pgTable("cloud_capability_zones", {'],
			},
		],
		"for t in ('cloud_capability_regions','cloud_capability_zones') loop",
		true,
	);
	expectGate(
		"a non-tenant table needs no owner_all registration",
		[{ file: "apps/console/lib/db/schema/billing.ts", added: ['pgTable("invoices", {'] }],
		"",
		true,
	);

	console.log("\n── invariant B: cross-provider leak ──");
	expectGate(
		"capability query with no provider filter FAILs",
		[
			{
				file: "apps/console/lib/queries/capabilities.ts",
				content: "db.select().from(cloudCapabilityRegions).where(eq(x.id, id))",
			},
		],
		"",
		false,
	);
	expectGate(
		"capability query filtered by provider PASSes",
		[
			{
				file: "apps/console/lib/queries/capabilities.ts",
				content: "db.select().from(cloudCapabilityRegions).where(eq(x.provider, provider))",
			},
		],
		"",
		true,
	);
	expectGate(
		"the schema file that DEFINES the table is not a query",
		[
			{
				file: "apps/console/lib/db/schema/cloud-capabilities.ts",
				content: 'export const cloudCapabilityRegions = pgTable("cloud_capability_regions", {})',
			},
		],
		"",
		true,
	);

	console.log("\n── invariant C: unsafe casts ──");
	expectGate(
		"`as any` in the keyless gate in projects.ts FAILs",
		[
			{
				file: "apps/console/app/server/actions/projects.ts",
				content: "const reason = keylessUnavailableReasonForCloud(identity as any, engine);",
			},
		],
		"",
		false,
	);
	expectGate(
		"`as unknown as` on the connector surface FAILs",
		[
			{
				file: "apps/console/lib/connectors/verify.ts",
				content: "const c = raw as unknown as Credentials;",
			},
		],
		"",
		false,
	);
	expectGate(
		"a cast named in a comment is not a cast",
		[
			{
				file: "apps/console/lib/connectors/verify.ts",
				content: "// never write `as any` here — narrow instead\nconst c = parse(raw);",
			},
		],
		"",
		true,
	);
	expectGate(
		"a test file may cast",
		[
			{
				file: "apps/console/tests/lib/connectors/verify.test.ts",
				content: "const c = raw as any;",
			},
		],
		"",
		true,
	);
	expectGate(
		"`Record<string, unknown>` is NOT invariant C (see the header)",
		[
			{
				file: "apps/console/types/jsonb.types.ts",
				content: "export type AddOnValues = Record<string, unknown>;",
			},
		],
		"",
		true,
	);

	console.log("\n── invariant D: static credentials ──");
	// Assembled from halves ON PURPOSE: written whole, these fixtures would make invariant D flag THIS
	// file (which is in scope — it is named for the surface), wedging every PR that edits the gate. The
	// check sees the same joined string at runtime, so the fixtures stay honest.
	const fakeAkia = `AKIA${"IOSFODNN7EXAMPLE"}`;
	const fakePem = `-----BEGIN RSA PRIVATE${" KEY-----"}`;
	expectGate(
		"a PEM private key in the runner's auth proxy FAILs",
		[{ file: "apps/runner/internal/agent/authproxy.go", content: `const k = \`${fakePem}\nMII...\`` }],
		"",
		false,
	);
	expectGate(
		"a static AWS access-key id on the keyless surface FAILs",
		[{ file: "packages/core/manifests/keyless.go", content: `const id = "${fakeAkia}"` }],
		"",
		false,
	);
	expectGate(
		"a Go test may carry a fake credential",
		[{ file: "apps/runner/internal/agent/authproxy_test.go", content: `const id = "${fakeAkia}"` }],
		"",
		true,
	);
	expectGate(
		"a clean runner file PASSes",
		[{ file: "apps/runner/internal/agent/db_token.go", content: "package agent" }],
		"",
		true,
	);

	console.log("\n── the no-op PASS path ──");
	check("nothing relevant changed → no violations", evaluate([], "").length === 0);

	if (fails === 0) {
		console.log(`\nself-test: all passed (${GUARDED_PATHS.length} guarded paths still in scope)`);
		return 0;
	}
	console.error(`\nself-test: ${fails} check(s) FAILED`);
	return 1;
}

// ── entry point ──────────────────────────────────────────────────────────────────────────────────────
process.exit(process.argv.slice(2).includes("--self-test") ? runSelfTest() : main());
