#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
//
// ONE REACT, ONE REACT-DOM PEERED ON IT, AND THE OVERRIDES THE MANIFESTS ASK FOR (#6137).
//
// `react-dom/server` calls `ensureCorrectIsomorphicReactVersion`, which throws when the react-dom
// doing the render was installed against a different react. A lockfile entry such as
// `react-dom@19.3.1(react@19.2.8)` is that exact case, and every transactional email rendered
// through it throws (#2151).
//
// That split has landed three times, and CI was green every time:
//   · df0a3c87b (2026-07-27), fixed by #2151;
//   · #4885 (9ca719f9d, 2026-09-19), a Dependabot `npm-minor-patch` bump of the react manifests that
//     wrote `react-dom@19.3.0(react@19.2.8)`. Mergify auto-merged it and dev carried the split for a
//     month; #6102 only moved it to 19.3.1;
//   · fixed by #6137.
// The mechanism is the same each time. Root `package.json` `pnpm.overrides` forces react, but
// Dependabot never edits overrides. A package that reaches react-dom only as an auto-installed peer
// (packages/brand through `next`, packages/support through `@react-email/components`) gets a fresh
// react-dom that the override does not reach. No step read the lockfile for it, so nothing went red.
//
// ── WHAT THIS ASSERTS ────────────────────────────────────────────────────────────────────────────
//
//   1. `pnpm.overrides` pins `react` and `react-dom` to the SAME exact version X, and pins `zod`.
//   2. pnpm-lock.yaml names exactly one react version, and it is X.
//   3. Every react-dom reference is X. At least one `react-dom@X(react@X)` key exists, and no
//      `react-dom@A(react@B)` pair appears with A ≠ X or B ≠ X.
//   4. Every zod reference in the lock is `pnpm.overrides.zod`.
//   5. Every manifest the lock lists as an importer, in dependencies, devDependencies and
//      peerDependencies, names a react / react-dom / @types/react / @types/react-dom / zod range
//      that the overridden version satisfies.
//
// Rule 5 is what turns a Dependabot bump that skips the override red: the bump raises a manifest
// to `^19.3.2`, the override still forces 19.3.1, and 19.3.1 does not satisfy `^19.3.2`. Rules 2
// and 3 catch the split whether or not a manifest moved. Since #6137, packages/brand and
// packages/support declare react-dom themselves, so the override reaches them, but a new package
// that forgets to declare it is not prevented by anything else.
//
// ── HOW IT READS ─────────────────────────────────────────────────────────────────────────────────
//
// There is no YAML library in a de-hydrated worktree, so the lock is read as text. A reference is
// `name@version` where the name is not the tail of a longer name: `@types/react@` and
// `drizzle-zod@` are not react or zod. The importer list is the `importers:` block's keys. A range
// form the matcher does not know is a REFUSAL (exit 1), not a pass.
//
// Usage:
//   node scripts/ci/check-react-pair.mjs --self-test   # hermetic fixtures + one mutation of the real lock
//   node scripts/ci/check-react-pair.mjs               # live: package.json, pnpm-lock.yaml, manifests

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const LOCK = "pnpm-lock.yaml";
const MANIFEST_PACKAGES = ["react", "react-dom", "@types/react", "@types/react-dom", "zod"];
const DEP_FIELDS = ["dependencies", "devDependencies", "peerDependencies"];

/**
 * Every version the lock names for a bare package, optionally with a `(peer@v)` suffix.
 *
 * @param {string} lock pnpm-lock.yaml text
 * @param {string} name a bare package name such as `react`
 * @returns {{ version: string, peer: string | null }[]} one entry per reference
 */
export function references(lock, name) {
	const esc = name.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");
	// Not preceded by a name character, `/` or `@`: `@types/react@`, `foo-react@` and `drizzle-zod@` are other packages.
	const re = new RegExp(`(?<![\\w/@.-])${esc}@(\\d[^\\s():'",]*)(?:\\(react@(\\d[^\\s():'",]*)\\))?`, "g");
	const out = [];
	for (const m of lock.matchAll(re)) out.push({ version: m[1], peer: m[2] ?? null });
	return out;
}

/**
 * The importer directories the lock lists (`.` is the root).
 *
 * @param {string} lock pnpm-lock.yaml text
 * @returns {string[]} importer keys in file order
 * @throws when there is no `importers:` block
 */
export function importers(lock) {
	const lines = lock.split("\n");
	const start = lines.indexOf("importers:");
	if (start === -1) throw new Error(`${LOCK}: no \`importers:\` block`);
	const out = [];
	for (let i = start + 1; i < lines.length; i += 1) {
		const l = lines[i];
		if (/^\S/.test(l)) break;
		const m = /^ {2}([^\s:][^:]*):/.exec(l);
		if (m) out.push(m[1].replace(/^'|'$/g, ""));
	}
	if (out.length === 0) throw new Error(`${LOCK}: the \`importers:\` block is empty`);
	return out;
}

/**
 * Parses `x`, `x.y` or `x.y.z` into a numeric triple; prerelease and build tags are refused.
 *
 * @param {string} v a version
 * @returns {number[]} [major, minor, patch]
 * @throws on anything else
 */
function triple(v) {
	const m = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(v);
	if (!m) throw new Error(`not a plain version: ${v}`);
	return [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)];
}

/** @param {number[]} a @param {number[]} b @returns {number} sign of a − b */
function cmp(a, b) {
	for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
	return 0;
}

/**
 * Whether an exact version satisfies a range: exact, `^`, `~`, `>=`, `*`, or `workspace:`/`catalog:`.
 *
 * @param {string} version an exact version, e.g. `19.3.1`
 * @param {string} range a manifest range
 * @returns {boolean}
 * @throws on a range form this matcher does not know, which is a refusal, not a pass
 */
export function satisfies(version, range) {
	const r = range.trim();
	if (r === "*" || r === "") return true;
	const v = triple(version);
	if (/^\d/.test(r)) {
		if (!/^\d+(\.\d+){0,2}$/.test(r)) throw new Error(`unrecognised range \`${range}\``);
		if (/^\d+(\.\d+){2}$/.test(r)) return cmp(v, triple(r)) === 0;
		const parts = r.split(".").map(Number); // `19` or `19.3`: an x-range
		return parts.every((p, i) => v[i] === p);
	}
	const m = /^(\^|~|>=)(\d+(?:\.\d+){0,2})$/.exec(r);
	if (!m) throw new Error(`unrecognised range \`${range}\``);
	const [, op, base] = m;
	const b = triple(base);
	if (cmp(v, b) < 0) return false;
	if (op === ">=") return true;
	if (op === "~") return v[0] === b[0] && v[1] === b[1];
	// `^`: the leftmost non-zero component is fixed.
	if (b[0] !== 0) return v[0] === b[0];
	if (b[1] !== 0) return v[0] === 0 && v[1] === b[1];
	return cmp(v, b) === 0;
}

/**
 * Every finding against one lockfile, its root package.json and its importers' manifests.
 *
 * @param {{ lock: string, rootPkg: { pnpm?: { overrides?: Record<string, string> } }, manifests: Record<string, { [field: string]: unknown }> }} input
 *   `manifests` maps an importer key to its parsed package.json
 * @returns {string[]} findings; empty means clean
 * @throws when the input cannot be measured (missing overrides, no react-dom pair, unknown range)
 */
export function findings({ lock, rootPkg, manifests }) {
	const ov = rootPkg.pnpm?.overrides ?? {};
	for (const k of ["react", "react-dom", "zod", "@types/react", "@types/react-dom"]) {
		if (typeof ov[k] !== "string" || !/^\d+\.\d+\.\d+$/.test(ov[k])) {
			throw new Error(`package.json pnpm.overrides["${k}"] is not an exact version (got ${JSON.stringify(ov[k])})`);
		}
	}
	const out = [];
	const X = ov.react;
	if (ov["react-dom"] !== X) {
		out.push(`pnpm.overrides pins react ${X} but react-dom ${ov["react-dom"]}. They must be the SAME version (#2151).`);
	}

	const reactVersions = [...new Set(references(lock, "react").map((r) => r.version))];
	if (reactVersions.length !== 1 || reactVersions[0] !== X) {
		out.push(`${LOCK} resolves react [${reactVersions.join(", ")}]; exactly one, ${X} (pnpm.overrides.react), is required.`);
	}

	const dom = references(lock, "react-dom");
	const pairs = dom.filter((r) => r.peer !== null);
	if (pairs.length === 0) throw new Error(`${LOCK}: no \`react-dom@X(react@Y)\` reference at all. That is no measurement, not a clean one.`);
	const badPairs = [...new Set(pairs.filter((p) => p.version !== X || p.peer !== X).map((p) => `react-dom@${p.version}(react@${p.peer})`))];
	for (const p of badPairs) {
		out.push(`${LOCK} holds ${p}. Only react-dom@${X}(react@${X}) may exist; a mismatched pair makes react-dom/server throw on every render (#2151, #4885).`);
	}
	const domVersions = [...new Set(dom.map((r) => r.version))].filter((v) => v !== X);
	if (domVersions.length > 0) out.push(`${LOCK} resolves react-dom [${domVersions.join(", ")}] besides ${X}.`);

	const zodVersions = [...new Set(references(lock, "zod").map((r) => r.version))];
	if (zodVersions.length !== 1 || zodVersions[0] !== ov.zod) {
		out.push(`${LOCK} resolves zod [${zodVersions.join(", ")}]; exactly one, ${ov.zod} (pnpm.overrides.zod), is required.`);
	}

	for (const [dir, pkg] of Object.entries(manifests)) {
		for (const field of DEP_FIELDS) {
			const deps = pkg[field];
			if (!deps || typeof deps !== "object") continue;
			for (const name of MANIFEST_PACKAGES) {
				const range = deps[name];
				if (typeof range !== "string") continue;
				let ok;
				try {
					ok = satisfies(ov[name], range);
				} catch (err) {
					throw new Error(`${dir}/package.json ${field}["${name}"]: ${err instanceof Error ? err.message : String(err)}`);
				}
				if (!ok) {
					out.push(
						`${dir}/package.json ${field}["${name}"] is \`${range}\`, but pnpm.overrides forces ${ov[name]}, which does not ` +
							`satisfy it. Dependabot raises manifests and never the overrides. Move pnpm.overrides["${name}"] in the same PR` +
							(name === "react" || name === "react-dom" ? " (react and react-dom together, to one version)." : "."),
					);
				}
			}
		}
	}
	return out;
}

/**
 * Hermetic fixtures, plus one mutation of the real lockfile; the exit code is the result.
 *
 * @returns {boolean} true when every case passed
 */
function selfTest() {
	let fails = 0;
	/** @param {string} name @param {boolean} cond @param {string} [detail] */
	const ok = (name, cond, detail) => {
		if (cond) {
			console.log(`ok   ${name}`);
			return;
		}
		fails += 1;
		console.error(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
	};
	/** @param {() => unknown} fn @returns {boolean} */
	const throws = (fn) => {
		try {
			fn();
			return false;
		} catch {
			return true;
		}
	};

	const overrides = { react: "19.3.1", "react-dom": "19.3.1", "@types/react": "19.3.0", "@types/react-dom": "19.3.0", zod: "4.6.7" };
	const rootPkg = (o = {}) => ({ pnpm: { overrides: { ...overrides, ...o } } });
	const lock = (extra = "") =>
		[
			"lockfileVersion: '9.0'",
			"importers:",
			"  .: {}",
			"  packages/support:",
			"    dependencies:",
			"      '@react-email/components':",
			"        version: 1.0.12(react-dom@19.3.1(react@19.3.1))(react@19.3.1)",
			"      drizzle-zod:",
			"        version: 0.8.3(zod@4.6.7)",
			"packages:",
			"  '@types/react@19.3.0':",
			"  '@types/react@19.2.8':",
			"  drizzle-zod@0.8.3:",
			"  react-dom@19.3.1:",
			"  react@19.3.1:",
			"  zod@4.6.7:",
			"snapshots:",
			"  react-dom@19.3.1(react@19.3.1):",
			"  react@19.3.1: {}",
			"  zod@4.6.7: {}",
			extra,
		].join("\n");
	const manifests = (support = {}) => ({
		".": { devDependencies: {} },
		"packages/support": { dependencies: { react: "^19.3.1", "react-dom": "^19.3.1", zod: "^4.6.7", ...support } },
		"apps/console": { devDependencies: { "@types/react": "^19", "@types/react-dom": "^19" } },
	});
	const run = (o) => findings({ lock: lock(), rootPkg: rootPkg(), manifests: manifests(), ...o });

	ok("a consistent tree is clean", run({}).length === 0, run({}).join(" | "));
	ok("`@types/react@` and `drizzle-zod@` are other packages", references(lock(), "react").every((r) => r.version === "19.3.1"));
	ok("importers are read", importers(lock()).join() === ".,packages/support");

	// THE DEFECT, as #4885 wrote it.
	const split = run({ lock: lock("  react-dom@19.3.0(react@19.2.8):\n  react@19.2.8: {}\n") });
	ok("MUTATION: a split react-dom@A(react@B) pair is RED", split.some((f) => f.includes("react-dom@19.3.0(react@19.2.8)")), split.join(" | "));
	ok("…and the second react version is RED too", split.some((f) => f.includes("resolves react [")));

	const mismatch = run({ rootPkg: rootPkg({ react: "19.3.2", "react-dom": "19.3.2" }) });
	ok("MUTATION: an override the lock does not hold is RED", mismatch.some((f) => f.includes("exactly one, 19.3.2")), mismatch.join(" | "));

	const zod = run({ rootPkg: rootPkg({ zod: "4.6.8" }) });
	ok("MUTATION: a zod override the lock does not hold is RED", zod.some((f) => f.includes("zod [4.6.7]")), zod.join(" | "));

	const apart = run({ rootPkg: rootPkg({ "react-dom": "19.3.0" }) });
	ok("MUTATION: react and react-dom overridden to different versions is RED", apart.some((f) => f.includes("SAME version")));

	// The Dependabot case: a manifest raised, the override left behind, the lock otherwise consistent.
	const bump = run({ manifests: manifests({ react: "^19.3.2", "react-dom": "^19.3.2" }) });
	ok("MUTATION: a Dependabot bump that leaves the override behind is RED", bump.some((f) => f.includes("`^19.3.2`")), bump.join(" | "));

	ok("no react-dom pair at all REFUSES", throws(() => findings({ lock: "importers:\n  .: {}\nreact@19.3.1:\n", rootPkg: rootPkg(), manifests: {} })));
	ok("a missing override REFUSES", throws(() => run({ rootPkg: { pnpm: { overrides: { react: "19.3.1" } } } })));
	ok("an unknown range form REFUSES", throws(() => run({ manifests: manifests({ react: "19.x || 20" }) })));

	ok("satisfies: ^", satisfies("19.3.1", "^19.3.1") && !satisfies("19.3.1", "^19.3.2") && !satisfies("20.0.0", "^19.3.1"));
	ok("satisfies: exact and x-range", satisfies("19.3.1", "19.3.1") && !satisfies("19.3.1", "19.3.0") && satisfies("19.3.0", "^19") && satisfies("19.3.0", "19"));
	ok("satisfies: ~ and >=", satisfies("4.6.9", "~4.6.7") && !satisfies("4.7.0", "~4.6.7") && satisfies("5.0.0", ">=4"));

	// One mutation of the REAL lock: the clean tree passes, and the same tree with one pair split fails.
	const realLock = readFileSync(resolve(ROOT, LOCK), "utf8");
	const real = live(realLock);
	ok("the real tree is clean", real.length === 0, real.join(" | "));
	const X = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8")).pnpm.overrides.react;
	const mutated = realLock.replace(`react-dom@${X}(react@${X})`, `react-dom@${X}(react@0.0.1)`);
	ok("MUTATION: the real lock with one pair split is RED", mutated !== realLock && live(mutated).some((f) => f.includes("(react@0.0.1)")));

	console.log(fails === 0 ? "\ncheck-react-pair self-test: all passed" : `\ncheck-react-pair self-test: ${fails} FAILED`);
	return fails === 0;
}

/**
 * Findings for a lock text against this repository's package.json and importer manifests.
 *
 * @param {string} lock pnpm-lock.yaml text
 * @returns {string[]} findings
 */
function live(lock) {
	const rootPkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8"));
	/** @type {Record<string, { [field: string]: unknown }>} */
	const manifests = {};
	for (const dir of importers(lock)) {
		const path = resolve(ROOT, dir, "package.json");
		if (!existsSync(path)) throw new Error(`${LOCK} lists importer ${dir}, which has no package.json`);
		manifests[dir] = JSON.parse(readFileSync(path, "utf8"));
	}
	return findings({ lock, rootPkg, manifests });
}

/** Live run against the repository. */
function main() {
	const argv = process.argv.slice(2);
	if (argv.includes("--self-test")) process.exit(selfTest() ? 0 : 1);
	if (argv.length > 0) {
		console.error(`::error::check-react-pair: unknown argument(s): ${argv.join(" ")}`);
		process.exit(2);
	}
	let out;
	try {
		out = live(readFileSync(resolve(ROOT, LOCK), "utf8"));
	} catch (err) {
		console.error(`::error::check-react-pair: ${err instanceof Error ? err.message : String(err)}. That is no measurement, not a clean one.`);
		process.exit(1);
	}
	if (out.length > 0) {
		for (const f of out) console.error(`::error::check-react-pair: ${f}`);
		process.exit(1);
	}
	console.log("check-react-pair: one react, one react-dom peered on it, zod as overridden, and every manifest range satisfied.");
}

if (import.meta.url === `file://${process.argv[1]}`) main();
