#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
//
// WHICH DIRECTORIES THE CONSOLE IS COMPILED FROM — derived from the workspace, never typed — and
// the ledger that says every scoped package is either one of them or recorded as not.
//
// TWO CALLERS, TWO QUESTIONS, ONE WALK.
//
//   node scripts/ci/check-console-surface.mjs --json    → the surface, for release-gate.yml
//   node scripts/ci/check-console-surface.mjs           → the surface AND the ledger, for CI
//   node scripts/ci/check-console-surface.mjs --self-test
//
// `.github/workflows/release-gate.yml`'s label check asks "is this changed path something a leg
// measures", and the console's compiled-from set is half its answer. It used to carry this walk
// inline, and the ledger with it — which put a REPO INVARIANT inside a PER-PR GATE, and the
// placement was wrong in both directions at once (#4606, found in review):
//
//   · the gate's check returns early whenever the gate RUNS, so a promotion PR, a dispatch, and
//     any PR carrying `release-gate:run` never evaluated the ledger at all. The PR that lands a
//     new `@repo/foo` the console does not use is exactly the PR most likely to be labelled.
//   · every unlabelled dev PR afterwards merged that package into its merge commit and was RED for
//     it — an author whose diff has nothing to do with it, told to edit a JS object literal inside
//     a YAML heredoc in a workflow.
//
// So the ledger moved here, into a guard that runs in `Authz / open-core guards` on every PR: the
// PR that introduces the drift is the PR that pays for it. And the gate reads `--json`, which
// derives the surface and refuses a broken derivation but does NOT enforce the ledger — a stale
// record must never be able to fail the `legs` job, because on a promotion PR that would skip the
// gate, leave the seven `Release gate (<leg>)` contexts unreported, and make deploy-console.yml's
// receipt refuse production over a bookkeeping entry.

import fs from "node:fs";

/**
 * Packages that carry a `@repo/`/`@alethia/` name and are deliberately NOT compiled into the
 * console. Every other scoped package in the tree must be on the surface.
 *
 * SHRINK-ONLY IN BOTH DIRECTIONS, like the repo's other exception ledgers: an entry for a package
 * that HAS since joined the surface is stale and fails, because a record that outlives its subject
 * suppresses a real finding forever.
 */
export const NOT_COMPILED_IN = {
	"@repo/eslint-config": "lint configuration; it reaches the console only through a surface package's devDependencies",
	"@repo/typescript-config": "tsconfig bases, the same way — neither changes what the browser renders",
	"@repo/e2e-issuer": "a standalone OIDC issuer the E2E rig runs as its own app; the console never imports it",
};

/** The package whose dependency graph IS the surface. */
const ROOT = "apps/console";

/** Only these two scopes are ledgered — see `surfaceReport` for the bound that puts on it. */
const SCOPED = /^@(repo|alethia)\//;

/**
 * Every workspace package as `name -> dir`, read out of `pnpm-workspace.yaml`'s `packages:` list.
 *
 * ONLY THAT LIST, AND `!` ENTRIES ARE EXCLUSIONS. A reader that takes every `- item` line in the
 * file is wrong twice on a file pnpm accepts: the file carries other top-level lists
 * (`onlyBuiltDependencies:`, `catalog:`, `ignoredBuiltDependencies:`) whose items are package
 * NAMES, and `packages:` itself may carry `!` exclusions. Measured before this was fixed: an
 * exclusion whose path carries a wildcard segment — pnpm's own documented form, spelled out in the
 * self-test below rather than here, because the two characters that end it also end a JSDoc block —
 * and a `vendor` glob under another key each made the walk list a directory that does not exist and
 * fail, which turned every unlabelled dev PR red. A fail-closed check that fires on a valid file is
 * an outage, not a check.
 *
 * @param {{readFile: (p: string) => string, readdir: (p: string) => string[]}} io
 * @returns {{byName: Map<string, string>, warnings: string[]}}
 */
export function workspacePackages(io) {
	const warnings = [];
	const ws = io.readFile("pnpm-workspace.yaml");
	const globs = [];
	let inside = false;
	for (const raw of ws.split("\n")) {
		const line = raw.replace(/\s+#.*$/, "");
		if (/^\S/.test(line)) {
			inside = /^packages:\s*$/.test(line);
			continue;
		}
		if (!inside) continue;
		// Either quote style: `- 'ee'` and `- "ee" # optional` are two shapes a stricter reader
		// dropped SILENTLY, taking the package with them.
		const m = /^\s*-\s*(.+?)\s*$/.exec(line);
		if (m !== null) globs.push(m[1].replace(/^(['"])(.*)\1$/, "$2"));
	}
	const excluded = globs.filter((g) => g.startsWith("!")).map((g) => g.slice(1));
	const byName = new Map();
	for (const glob of globs.filter((g) => !g.startsWith("!"))) {
		let dirs = [glob];
		if (glob.endsWith("/*")) {
			const base = glob.slice(0, -2);
			// A glob that matches nothing is ORDINARY — pnpm allows one, and a `tools/*` added before
			// its directory exists must not fail the repo. Quiet is safe here because the checks that
			// protect the ANSWER still fire: an unresolved dependency below, and an empty map here.
			try {
				dirs = io.readdir(base).map((d) => `${base}/${d}`);
			} catch {
				warnings.push(`pnpm-workspace.yaml globs \`${glob}\`, which matches nothing in this tree`);
				dirs = [];
			}
		}
		for (const d of dirs) {
			if (excluded.some((e) => d === e || (e.endsWith("/*") && d.startsWith(e.slice(0, -1))))) continue;
			let pkg = null;
			try {
				pkg = JSON.parse(io.readFile(`${d}/package.json`));
			} catch {
				continue;
			}
			if (pkg !== null && typeof pkg.name === "string") byName.set(pkg.name, d);
		}
	}
	return { byName, warnings };
}

/**
 * The surface, the ledger's verdict, and the warnings — computed once, reported by both callers.
 *
 * FAILS CLOSED AT EVERY STEP OF THE WALK, because the first version failed OPEN at four of them and
 * each was silent: quoting the globs with `'`, a trailing `# optional`, a malformed or renamed
 * `package.json`, an unlistable glob. Three of those cut the surface and turned a PR touching the
 * dropped directory GREEN.
 *
 * THE LEDGER IS THE INVERSE QUESTION, and it exists because none of those refusals catches a
 * dependency quietly REMOVED: delete `@alethia/ee` from the console's `optionalDependencies`, or
 * move `@repo/brand` into `devDependencies`, and the walk completes, resolves everything it is
 * asked to resolve, and returns a surface with a package missing. Both were measured doing exactly
 * that. A size floor is no help — losing ten of fourteen directories would clear any floor worth
 * setting — so the question is asked the other way round.
 *
 * THE BOUND: only SCOPED packages are ledgered. Six workspace packages have bare names (`console`,
 * `docs`, `admin`, `blog`, `alethia`, `marketing`); if the console ever depended on one, the walk
 * would put it on the surface but its later removal would pass unnoticed here — the exact class
 * this catches, one prefix away. Widen `SCOPED` if that day comes; today none of the six is a
 * console dependency.
 *
 * @param {{readFile: (p: string) => string, readdir: (p: string) => string[]}} io
 * @returns {{dirs: string[], failures: string[], warnings: string[]}}
 */
export function surfaceReport(io = { readFile: (p) => fs.readFileSync(p, "utf8"), readdir: (p) => fs.readdirSync(p) }) {
	const failures = [];
	const fail = (m) => failures.push(m);
	let byName;
	let warnings = [];
	try {
		({ byName, warnings } = workspacePackages(io));
	} catch {
		return { dirs: [], warnings, failures: ["could not read `pnpm-workspace.yaml`. A surface that could not be derived is not an empty surface."] };
	}
	if (byName.size === 0) {
		return { dirs: [], warnings, failures: ["`pnpm-workspace.yaml` resolved to NO workspace packages at all — the reader has stopped reading, and an empty map must not read as an empty workspace."] };
	}
	let rootPkg = null;
	try {
		rootPkg = JSON.parse(io.readFile(`${ROOT}/package.json`));
	} catch {
		return { dirs: [], warnings, failures: [`could not read \`${ROOT}/package.json\`, so the console's dependency graph cannot be walked.`] };
	}

	const dirs = new Set([ROOT]);
	const queue = [[ROOT, rootPkg]];
	while (queue.length > 0) {
		const [from, pkg] = queue.shift();
		// `dependencies` and `optionalDependencies` only — `@alethia/ee` is declared in the second.
		// devDependencies are deliberately out: `@repo/eslint-config` and `@repo/typescript-config`
		// reach the console only through those, and tooling does not change what the browser renders.
		for (const field of ["dependencies", "optionalDependencies"]) {
			for (const [name, spec] of Object.entries(pkg[field] || {})) {
				if (!String(spec).startsWith("workspace:")) continue;
				const dir = byName.get(name);
				if (dir === undefined) {
					fail(`\`${from}/package.json\` declares the workspace dependency \`${name}\`, which resolved to NO directory in this tree.`);
					continue;
				}
				if (dirs.has(dir)) continue;
				dirs.add(dir);
				let next = null;
				try {
					next = JSON.parse(io.readFile(`${dir}/package.json`));
				} catch {
					fail(`\`${dir}/package.json\` is missing or unparseable, so whatever IT pulls into the console is invisible here.`);
					continue;
				}
				queue.push([dir, next]);
			}
		}
	}

	for (const [name, dir] of byName) {
		if (!SCOPED.test(name)) continue;
		const recorded = Object.hasOwn(NOT_COMPILED_IN, name);
		if (dirs.has(dir) && recorded) {
			fail(`\`${name}\` (\`${dir}\`) IS compiled into the console and is ALSO recorded in \`NOT_COMPILED_IN\` — one of the two is stale, and a record that outlives its subject suppresses a real finding forever. Delete the record.`);
		}
		if (!dirs.has(dir) && !recorded) {
			fail(
				`\`${name}\` (\`${dir}\`) is a workspace package this tree carries that is neither compiled into the console nor recorded in \`NOT_COMPILED_IN\`. ` +
					"If the console never used it, add it there with the reason. If the console STOPPED using it, that is the bug this asks about: " +
					"the release gate derives what it measures from this same graph, so a dependency dropped by accident silently shrinks what a leg is asked to cover.",
			);
		}
	}
	return { dirs: [...dirs].sort(), failures, warnings };
}

/** Fixture trees for the self-test — a tiny in-memory workspace with the shapes that matter. */
function fixture({ ws, pkgs }) {
	return {
		readFile: (p) => {
			if (p === "pnpm-workspace.yaml") return ws;
			const m = /^(.*)\/package\.json$/.exec(p);
			if (m && Object.hasOwn(pkgs, m[1])) return JSON.stringify(pkgs[m[1]]);
			throw new Error(`ENOENT ${p}`);
		},
		readdir: (base) => {
			const out = Object.keys(pkgs)
				.filter((d) => d.startsWith(`${base}/`) && !d.slice(base.length + 1).includes("/"))
				.map((d) => d.slice(base.length + 1));
			if (out.length === 0) throw new Error(`ENOENT ${base}`);
			return out;
		},
	};
}

function selfTest() {
	let fails = 0;
	const ok = (name, cond, detail = "") => {
		if (cond) {
			console.log(`ok   - ${name}`);
			return;
		}
		fails += 1;
		console.log(`FAIL - ${name} ${detail}`);
	};

	const WS = 'packages:\n  - "apps/*"\n  - "packages/*"\n  # a comment\n  - "ee"\n';
	const base = {
		ws: WS,
		pkgs: {
			"apps/console": { name: "console", dependencies: { "@repo/ui": "workspace:*" }, optionalDependencies: { "@alethia/ee": "workspace:*" } },
			"apps/cli": { name: "cli" },
			"packages/ui": { name: "@repo/ui", dependencies: { "@repo/brand": "workspace:*" } },
			"packages/brand": { name: "@repo/brand" },
			ee: { name: "@alethia/ee" },
		},
	};
	const clean = surfaceReport(fixture(base));
	ok("the surface is the console plus its transitive workspace deps", JSON.stringify(clean.dirs) === JSON.stringify(["apps/console", "ee", "packages/brand", "packages/ui"]), JSON.stringify(clean.dirs));
	ok("...and a clean tree has no failures", clean.failures.length === 0, JSON.stringify(clean.failures));

	// ── the four ways the walk used to fail OPEN ──
	const quoted = surfaceReport(fixture({ ...base, ws: WS.replace(/"/g, "'") }));
	ok("single-quoted globs are read, not dropped", JSON.stringify(quoted.dirs) === JSON.stringify(clean.dirs), JSON.stringify(quoted.dirs));
	const inline = surfaceReport(fixture({ ...base, ws: WS.replace('- "ee"', '- "ee" # optional') }));
	ok("an inline comment after an entry is read, not dropped", inline.dirs.includes("ee"), JSON.stringify(inline.dirs));
	const renamed = surfaceReport(fixture({ ...base, pkgs: { ...base.pkgs, "packages/ui": { name: "@repo/ui-renamed" } } }));
	ok("a renamed package REFUSES rather than shrinking the surface", renamed.failures.some((f) => /`@repo\/ui`, which resolved to NO directory/.test(f)), JSON.stringify(renamed.failures));
	const noWs = surfaceReport({ readFile: () => { throw new Error("nope"); }, readdir: () => { throw new Error("nope"); } });
	ok("an unreadable workspace file REFUSES", noWs.failures.length === 1 && noWs.dirs.length === 0);

	// ── the shapes that used to make a VALID file fail ──
	const excl = surfaceReport(fixture({ ...base, ws: `${WS}  - "!packages/*/fixtures/*"\n` }));
	ok("a `!` exclusion is an exclusion, not a directory", excl.failures.length === 0 && JSON.stringify(excl.dirs) === JSON.stringify(clean.dirs), JSON.stringify(excl.failures));
	const other = surfaceReport(fixture({ ...base, ws: `${WS}onlyBuiltDependencies:\n  - esbuild\ncatalog:\n  - "vendor/*"\n` }));
	ok("a list under another top-level key is not a package glob", other.failures.length === 0 && JSON.stringify(other.dirs) === JSON.stringify(clean.dirs), JSON.stringify(other.failures));
	const empty = surfaceReport(fixture({ ...base, ws: `${WS}  - "tools/*"\n` }));
	ok("a glob matching nothing warns, and does not fail", empty.failures.length === 0 && empty.warnings.length === 1, JSON.stringify(empty));
	// ...but excluding something the console DEPENDS on is still a refusal, not a quiet shrink.
	const exclReal = surfaceReport(fixture({ ...base, ws: `${WS}  - "!packages/ui"\n` }));
	ok("excluding a package the console depends on REFUSES", exclReal.failures.some((f) => /`@repo\/ui`, which resolved to NO directory/.test(f)), JSON.stringify(exclReal.failures));

	// ── the ledger, both directions ──
	const dropped = surfaceReport(fixture({ ...base, pkgs: { ...base.pkgs, "apps/console": { name: "console", dependencies: { "@repo/ui": "workspace:*" } } } }));
	ok("a dependency quietly REMOVED is caught by the ledger", dropped.failures.some((f) => /`@alethia\/ee`.*neither compiled into the console nor recorded/.test(f)), JSON.stringify(dropped.failures));
	const moved = surfaceReport(fixture({
		...base,
		pkgs: { ...base.pkgs, "packages/ui": { name: "@repo/ui", devDependencies: { "@repo/brand": "workspace:*" } } },
	}));
	ok("...and so is one moved into devDependencies", moved.failures.some((f) => /`@repo\/brand`.*neither compiled into the console nor recorded/.test(f)), JSON.stringify(moved.failures));
	// The reverse direction needs a real ledger entry, so it is asserted against the REAL one.
	const real = surfaceReport();
	ok("the real tree is clean", real.failures.length === 0, JSON.stringify(real.failures));
	ok("...and its surface is plural", real.dirs.length >= 10, JSON.stringify(real.dirs));
	for (const name of Object.keys(NOT_COMPILED_IN)) {
		const { byName } = workspacePackages({ readFile: (p) => fs.readFileSync(p, "utf8"), readdir: (p) => fs.readdirSync(p) });
		ok(`the \`${name}\` record still names a package this tree has`, byName.has(name), "a record for something that does not exist is the same stale-evidence shape it was meant to expose");
	}

	if (fails > 0) {
		console.error(`\ncheck-console-surface self-test: ${fails} failure(s)`);
		process.exit(1);
	}
	console.log("\nself-test: all passed");
}

if (process.argv.includes("--self-test")) {
	selfTest();
} else {
	const { dirs, failures, warnings } = surfaceReport();
	if (process.argv.includes("--json")) {
		// The gate's half: the surface, and a refusal only if the DERIVATION is broken. A ledger
		// disagreement must not fail this mode — see the header for what that would cost.
		const derivation = failures.filter((f) => !/NOT_COMPILED_IN/.test(f));
		if (derivation.length > 0) {
			for (const f of derivation) console.error(`::error::console-surface: ${f}`);
			process.exit(1);
		}
		console.log(JSON.stringify(dirs));
	} else {
		for (const w of warnings) console.log(`::warning::console-surface: ${w}`);
		for (const f of failures) console.error(`::error::console-surface: ${f}`);
		if (failures.length > 0) process.exit(1);
		console.log(`console-surface: the console is compiled from ${dirs.length} workspace director(ies) — ${dirs.join(", ")}; every @repo/* and @alethia/* package in the tree is either one of them or recorded in NOT_COMPILED_IN (${Object.keys(NOT_COMPILED_IN).length} record(s)).`);
	}
}
