#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
//
// Fails when the release gate's billing flag is named anywhere it could be SET for a real
// deployment (#5443).
//
// WHY. `ALETHIA_BILLING_TEST_MARKET=1`, beside a Stripe TEST key, waives the paid-conversion gate's
// `market_closed` check so the release gate can drive the real checkout (#5412, maintainer ruling
// 2026-10-03). The code, the e2e spec and docs/legal/PAID_MARKETS.md all said it is "set only in
// release-gate.yml", and nothing made that true: a copied block in a deploy workflow, a line in an
// env example, a Helm value would each have been accepted without a word. The test-key half keeps
// a LIVE console closed whatever the flag says — but a staging or preview console runs on a test
// key, and that is exactly where an unreviewed open market would go unnoticed.
//
// THE RULE IS AN ALLOWLIST, NOT A LIST OF FORBIDDEN PLACES. The issue named deploy workflows,
// `deploy/`, `infra/` and env assembly; listing those would leave every place nobody thought of
// (a Dockerfile, docker-compose, a Helm chart, `next.config`, a new workflow) open. So the name may
// appear in exactly the tracked files below, each with its role, and in NO other tracked file.
// Every one of the issue's four zones is outside the list, so each is covered, and so is whatever
// is added next.
//
// BOTH DIRECTIONS. An allowlisted file that no longer contains the name fails too: an entry that
// outlives its subject silently widens what the list appears to account for, and a renamed flag
// would otherwise leave this guard scanning for a name nothing reads any more.
//
// WHAT THIS DOES NOT SEE, so nobody reads it as more than it is:
//   · Repo or org VARIABLES and SECRETS, and any runtime secret store (a k8s Secret, a provider's
//     secret manager). They are not in the tree. The test-key half of the seam is what covers
//     those: a live key refuses whatever the flag says.
//   · A name ASSEMBLED at runtime (`"ALETHIA_BILLING_" + "TEST_MARKET"`, `${PREFIX}_MARKET`). It
//     matches the literal name, case-sensitively, because that is the only form an env var takes
//     when a person writes one down; a deliberate obfuscation is a review question.
//   · Untracked files.
//
// Usage:  node scripts/check-billing-test-market-flag.mjs [--self-test]

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FLAG = "ALETHIA_BILLING_TEST_MARKET";
const SELF = "scripts/check-billing-test-market-flag.mjs";

/**
 * The ONLY tracked files that may name the flag, and why. Exact paths, never prefixes: a prefix
 * would let a new file under it in without anyone deciding that it should be.
 */
const ALLOWED = new Map([
	[".github/workflows/release-gate.yml", "the ONE setter — the legs that promise `stripe`"],
	["apps/console/lib/billing/eligibility.ts", "the ONE reader — defines TEST_MODE_MARKET_FLAG"],
	["apps/console/e2e/flows/billing.spec.ts", "explains which gate legs reach the real checkout"],
	["docs/legal/PAID_MARKETS.md", "the record of the maintainer's ruling (#5412)"],
	[SELF, "this guard"],
]);

/**
 * The tracked files under `root` that contain the flag's name. A git failure THROWS: an error
 * reported as "no files" would make every allowlist entry look stale and every zone look clean.
 */
function filesNamingFlag(root) {
	try {
		const out = execFileSync("git", ["grep", "-l", "-z", "-I", "-F", "-e", FLAG], {
			cwd: root,
			maxBuffer: 64 * 1024 * 1024,
			stdio: ["ignore", "pipe", "pipe"],
		});
		return out.toString("utf8").split("\0").filter(Boolean);
	} catch (err) {
		// git grep exits 1 for "no match" and >1 for an error; only the first is an answer.
		if (err && typeof err === "object" && "status" in err && err.status === 1) return [];
		throw new Error(`git grep failed in ${root}: ${err instanceof Error ? err.message : err}`);
	}
}

/**
 * The verdict for the tree at `root`: files that name the flag outside the allowlist, and
 * allowlist entries that no longer name it.
 */
function check(root, allowed = ALLOWED) {
	const found = filesNamingFlag(root);
	const foundSet = new Set(found);
	return {
		unexpected: found.filter((f) => !allowed.has(f)).sort(),
		stale: [...allowed.keys()].filter((f) => !foundSet.has(f)).sort(),
	};
}

/** Prints a verdict; returns the process exit code it implies. */
function report({ unexpected, stale }) {
	for (const f of unexpected) {
		console.error(
			`✗ ${f} names ${FLAG}. It may be set ONLY in .github/workflows/release-gate.yml: anywhere ` +
				"else, beside a Stripe test key, it opens the paid-conversion gate's market check (#5412). " +
				"Remove it — or, if this file genuinely only READS or DOCUMENTS the flag, add it to " +
				`ALLOWED in ${SELF} with its role, in a PR that says why.`,
		);
	}
	for (const f of stale) {
		console.error(
			`✗ ${f} is allowlisted in ${SELF} but no longer names ${FLAG}. Remove the entry — or, if ` +
				"the flag was renamed, rename it here too.",
		);
	}
	return unexpected.length + stale.length === 0 ? 0 : 1;
}

/** Writes `files` ({path: content}) into a fresh git repo and returns its directory. */
function fixtureRepo(files) {
	const dir = mkdtempSync(join(tmpdir(), "billing-test-market-flag-"));
	execFileSync("git", ["init", "-q"], { cwd: dir });
	for (const [path, content] of Object.entries(files)) {
		mkdirSync(dirname(join(dir, path)), { recursive: true });
		writeFileSync(join(dir, path), content);
	}
	execFileSync("git", ["add", "-A"], { cwd: dir });
	return dir;
}

/**
 * Runs the real `check` on throwaway trees. The CLEAN tree must pass and each MUTATION must fail —
 * one mutation per zone the issue named, plus the stale direction and a git error — and the exit
 * code is the result: any wrong verdict exits 1.
 */
function selfTest() {
	const allowedFiles = Object.fromEntries([...ALLOWED.keys()].map((p) => [p, `x ${FLAG} x\n`]));
	const clean = {
		...allowedFiles,
		".github/workflows/deploy-console.yml": "env:\n  STRIPE_SECRET_KEY: ${{ secrets.K }}\n",
		"deploy/prod/.env.production.example": "STRIPE_SECRET_KEY=\n",
		"infra/cp-aws/main.tf": 'variable "x" {}\n',
		".env.example": "STRIPE_SECRET_KEY=\n",
		// A near-miss that must NOT count: a different billing name in next.config's `env`.
		"apps/console/next.config.ts": "export default { env: { ALETHIA_BILLING_MODE: 'x' } };\n",
	};
	const mutations = [
		["a deploy workflow sets it", ".github/workflows/deploy-console.yml", `env:\n  ${FLAG}: "1"\n`],
		["deploy/ env example names it", "deploy/prod/.env.production.example", `${FLAG}=1\n`],
		["infra/ passes it", "infra/cp-aws/main.tf", `env = { ${FLAG} = "1" }\n`],
		["env assembly (.env.example) names it", ".env.example", `${FLAG}=1\n`],
		["next.config inlines it", "apps/console/next.config.ts", `export default { env: { ${FLAG}: "1" } };\n`],
		["a NEW workflow sets it", ".github/workflows/preview.yml", `env:\n  ${FLAG}: "1"\n`],
	];

	let failures = 0;
	const expect = (label, ok, detail) => {
		if (ok) return;
		failures++;
		console.error(`self-test FAIL: ${label} — ${detail}`);
	};

	const dirs = [];
	try {
		const c = fixtureRepo(clean);
		dirs.push(c);
		const v = check(c);
		expect("clean tree", v.unexpected.length === 0 && v.stale.length === 0, JSON.stringify(v));

		for (const [label, path, content] of mutations) {
			const d = fixtureRepo({ ...clean, [path]: content });
			dirs.push(d);
			const m = check(d);
			expect(label, m.unexpected.length === 1 && m.unexpected[0] === path, JSON.stringify(m));
		}

		const { [".github/workflows/release-gate.yml"]: _gone, ...noSetter } = clean;
		const s = fixtureRepo({ ...noSetter, ".github/workflows/release-gate.yml": "env: {}\n" });
		dirs.push(s);
		const st = check(s);
		expect(
			"an allowlisted file that stopped naming the flag",
			st.stale.length === 1 && st.stale[0] === ".github/workflows/release-gate.yml",
			JSON.stringify(st),
		);

		// A git error must throw, never read as "nothing names the flag".
		const notRepo = mkdtempSync(join(tmpdir(), "billing-test-market-flag-norepo-"));
		dirs.push(notRepo);
		let threw = false;
		try {
			check(notRepo);
		} catch {
			threw = true;
		}
		expect("git error", threw, "check() returned a verdict outside a git repository");
	} finally {
		for (const d of dirs) rmSync(d, { recursive: true, force: true });
	}

	const total = mutations.length + 3;
	if (failures > 0) {
		console.error(`\n✗ check-billing-test-market-flag self-test: ${failures}/${total} wrong`);
		process.exit(1);
	}
	console.log(
		`✓ check-billing-test-market-flag self-test: ${total}/${total} — clean tree passes; ` +
			`${mutations.length} planted settings, a stale entry and a git error all fail`,
	);
}

function main() {
	if (process.argv.includes("--self-test")) return selfTest();
	const code = report(check(ROOT));
	if (code === 0) {
		console.log(
			`✓ ${FLAG} is named only in its ${ALLOWED.size} allowlisted files; the one setter is ` +
				".github/workflows/release-gate.yml",
		);
	}
	process.exit(code);
}

main();
