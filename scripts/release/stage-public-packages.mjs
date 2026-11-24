#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Builds and stages the workspace packages that are published to npm as `@alethialabs/*`
 * (packages/public-packages.json; the flow is docs/contributing/releasing-packages.md).
 *
 * Inside the monorepo the packages keep their `@repo/*` names and ship raw TypeScript; about two
 * hundred files import them that way and none of that changes. This script produces, per package,
 * a publishable copy under `.release/packages/<name>/`:
 *   - `dist/`: ES modules plus `.d.ts`, compiled by the package's own TypeScript in bundler mode
 *     (relative imports in these packages carry no extension, and the consumers are bundlers);
 *     `"use client"` prologues are kept. Non-TypeScript assets under `src/` (CSS, fonts) are copied
 *     next to the compiled files so relative references keep working.
 *   - `src/` as well, for packages whose source a consumer's Tailwind must scan (`shipSource`).
 *   - a rewritten `package.json`: the public name, the real version, `exports` pointing at `dist/`,
 *     `@repo/*` dependencies renamed to `@alethialabs/*` at `^<their version>`, no devDependencies,
 *     no `private`, AGPL-3.0-only, and `repository.directory` (npm provenance checks it). Provenance
 *     itself is a flag of the real publish (publish-public-packages.mjs), not of the package, so the
 *     dry run on pull requests, which have no OIDC token, can pack the same files.
 *
 * It REFUSES (exit 1) rather than publish something broken: a published package that depends on an
 * unpublished workspace package; an export outside `src/` that the manifest does not list in
 * `omitExports`; an export whose compiled file or type definition is missing after the build; a
 * dependency cycle.
 *
 * While one package compiles, imports of the other published packages resolve to THEIR staged
 * `dist/` type definitions (a `paths` map in a generated tsconfig), so a package's declarations are
 * built against what its consumers will actually install, and no other package's source is pulled
 * into its program.
 *
 * Usage: node scripts/release/stage-public-packages.mjs [--self-test] [--only <name,...>]
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const STAGE = path.join(ROOT, ".release", "packages");
const REPO_URL = "git+https://github.com/alethialabs-io/alethialabs.git";
const TS_SOURCE = /\.(ts|tsx|mts|cts)$/;
const TEST_FILE = /(\.test\.|\.spec\.|__tests__|\.stories\.)/;

/** Reads the publish manifest. */
export function readManifest(root = ROOT) {
	return JSON.parse(fs.readFileSync(path.join(root, "packages", "public-packages.json"), "utf8"));
}

/** Returns the workspace (`@repo/*`) dependency short names of a package.json, across all runtime fields. */
export function workspaceDeps(pkg) {
	const out = new Set();
	for (const field of ["dependencies", "peerDependencies", "optionalDependencies"]) {
		for (const name of Object.keys(pkg[field] ?? {})) if (name.startsWith("@repo/")) out.add(name.slice(6));
	}
	return [...out];
}

/** Orders package short names so every package comes after the published packages it depends on; throws on a cycle. */
export function topoOrder(names, depsOf) {
	const order = [];
	const state = new Map();
	const visit = (n, trail) => {
		if (state.get(n) === "done") return;
		if (state.get(n) === "visiting") throw new Error(`dependency cycle: ${[...trail, n].join(" -> ")}`);
		state.set(n, "visiting");
		for (const d of depsOf(n)) if (names.includes(d)) visit(d, [...trail, n]);
		state.set(n, "done");
		order.push(n);
	};
	for (const n of [...names].sort()) visit(n, []);
	return order;
}

/**
 * Maps a workspace `exports` object to the published one. `./src/x.ts(x)` becomes
 * `{ types: ./dist/x.d.ts, default: ./dist/x.js }`; other `./src/` files (CSS) move to `./dist/`;
 * wildcards keep their `*`. Keys in `omit` are dropped; anything else outside `src/` is an error.
 */
export function transformExports(exportsMap, omit = []) {
	const out = {};
	const errors = [];
	for (const [key, target] of Object.entries(exportsMap ?? {})) {
		if (omit.includes(key)) continue;
		if (typeof target !== "string" || !target.startsWith("./src/")) {
			errors.push(`export "${key}" -> ${JSON.stringify(target)} is outside src/ and not listed in omitExports`);
			continue;
		}
		const rel = target.slice("./src/".length);
		if (TS_SOURCE.test(rel)) {
			const base = `./dist/${rel.replace(TS_SOURCE, "")}`;
			out[key] = { types: `${base}.d.ts`, default: `${base}.js` };
		} else {
			out[key] = `./dist/${rel}`;
		}
	}
	return { exports: out, errors };
}

/** Renames `@repo/*` dependencies to the public scope at `^<version>`; returns errors for unpublished ones. */
export function transformDeps(deps, { scope, published, versions }) {
	const out = {};
	const errors = [];
	for (const [name, range] of Object.entries(deps ?? {})) {
		if (!name.startsWith("@repo/")) {
			out[name] = range;
			continue;
		}
		const short = name.slice(6);
		if (!published.includes(short)) {
			errors.push(`depends on ${name}, which is not published (add it to packages/public-packages.json or drop the dependency)`);
			continue;
		}
		out[`${scope}/${short}`] = `^${versions[short]}`;
	}
	return { deps: out, errors };
}

/** Builds a tsconfig `paths` map that points imports of published packages at their staged declarations. */
export function pathsFor(depShortNames, exportsOf, stageDir) {
	const paths = {};
	for (const short of depShortNames) {
		for (const [key, target] of Object.entries(exportsOf(short))) {
			if (typeof target !== "string" || !target.startsWith("./src/")) continue;
			const spec = key === "." ? `@repo/${short}` : `@repo/${short}/${key.slice(2)}`;
			const rel = target.slice("./src/".length).replace(TS_SOURCE, "");
			paths[spec] = [path.join(stageDir, short, "dist", rel)];
		}
	}
	return paths;
}

/** Copies every file under `from` that `keep` accepts to `to`, preserving relative paths. */
function copyTree(from, to, keep) {
	for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
		const src = path.join(from, entry.name);
		const dst = path.join(to, entry.name);
		if (entry.isDirectory()) copyTree(src, dst, keep);
		else if (keep(src)) {
			fs.mkdirSync(path.dirname(dst), { recursive: true });
			fs.copyFileSync(src, dst);
		}
	}
}

/** Compiles one package into `<stage>/<name>/dist` with a generated tsconfig. */
function compile(short, pkgDir, outDir, paths) {
	const tsconfig = path.join(outDir, "..", "tsconfig.release.json");
	const src = path.join(pkgDir, "src");
	fs.writeFileSync(
		tsconfig,
		JSON.stringify(
			{
				extends: path.join(pkgDir, "tsconfig.json"),
				compilerOptions: {
					noEmit: false,
					noEmitOnError: true,
					module: "esnext",
					moduleResolution: "bundler",
					declaration: true,
					declarationMap: false,
					sourceMap: false,
					incremental: false,
					composite: false,
					rootDir: src,
					outDir,
					paths,
				},
				include: [path.join(src, "**", "*")],
				exclude: ["**/*.test.ts", "**/*.test.tsx", "**/*.spec.ts", "**/*.spec.tsx", "**/__tests__/**", "**/*.stories.tsx"],
			},
			null,
			"\t",
		),
	);
	execFileSync("pnpm", ["-C", pkgDir, "exec", "tsc", "-p", tsconfig], { stdio: "inherit" });
}

/** Stages every package in the manifest (or `only`); returns the staged directories in publish order. */
export function stageAll({ root = ROOT, only } = {}) {
	const manifest = readManifest(root);
	const published = Object.keys(manifest.packages);
	const pkgJson = (s) => JSON.parse(fs.readFileSync(path.join(root, "packages", s, "package.json"), "utf8"));
	const versions = Object.fromEntries(published.map((s) => [s, pkgJson(s).version]));
	const order = topoOrder(published, (s) => workspaceDeps(pkgJson(s)));
	const targets = only ? order.filter((s) => only.includes(s) || order.indexOf(s) < Math.max(...only.map((o) => order.indexOf(o)))) : order;
	const problems = [];
	const staged = [];
	fs.rmSync(STAGE, { recursive: true, force: true });
	for (const short of targets) {
		const pkgDir = path.join(root, "packages", short);
		const pkg = pkgJson(short);
		const conf = manifest.packages[short];
		const outRoot = path.join(STAGE, short);
		const dist = path.join(outRoot, "dist");
		fs.mkdirSync(dist, { recursive: true });

		const ex = transformExports(pkg.exports, conf.omitExports ?? []);
		const opts = { scope: manifest.scope, published, versions };
		const dep = transformDeps(pkg.dependencies, opts);
		const peer = transformDeps(pkg.peerDependencies, opts);
		const opt = transformDeps(pkg.optionalDependencies, opts);
		const errs = [...ex.errors, ...dep.errors, ...peer.errors, ...opt.errors];
		if (errs.length) {
			problems.push(...errs.map((e) => `@repo/${short}: ${e}`));
			continue;
		}

		const deps = workspaceDeps(pkg).filter((d) => published.includes(d));
		compile(short, pkgDir, dist, pathsFor(deps, (d) => pkgJson(d).exports ?? {}, STAGE));
		copyTree(path.join(pkgDir, "src"), dist, (f) => !TS_SOURCE.test(f) && !TEST_FILE.test(f));
		if (conf.shipSource) copyTree(path.join(pkgDir, "src"), path.join(outRoot, "src"), (f) => !TEST_FILE.test(f));

		for (const [key, target] of Object.entries(ex.exports)) {
			const files = typeof target === "string" ? [target] : [target.types, target.default];
			for (const f of files) {
				if (f.includes("*")) continue;
				if (!fs.existsSync(path.join(outRoot, f))) problems.push(`@repo/${short}: export "${key}" -> ${f} was not produced by the build`);
			}
		}

		const published_pkg = {
			name: `${manifest.scope}/${short}`,
			version: pkg.version,
			description: pkg.description ?? `Alethia ${short}`,
			license: "AGPL-3.0-only",
			author: "Alethia Labs <legal@alethialabs.io>",
			homepage: "https://alethialabs.io",
			repository: { type: "git", url: REPO_URL, directory: `packages/${short}` },
			bugs: { url: "https://github.com/alethialabs-io/alethialabs/issues" },
			type: "module",
			sideEffects: ["**/*.css"],
			exports: ex.exports,
			files: conf.shipSource ? ["dist", "src"] : ["dist"],
			...(Object.keys(dep.deps).length ? { dependencies: dep.deps } : {}),
			...(Object.keys(peer.deps).length ? { peerDependencies: peer.deps } : {}),
			...(Object.keys(opt.deps).length ? { optionalDependencies: opt.deps } : {}),
			publishConfig: { access: "public" },
		};
		fs.writeFileSync(path.join(outRoot, "package.json"), `${JSON.stringify(published_pkg, null, "\t")}\n`);
		fs.copyFileSync(path.join(root, "LICENSES", "AGPL-3.0-only.txt"), path.join(outRoot, "LICENSE"));
		const readme = path.join(pkgDir, "README.md");
		fs.writeFileSync(
			path.join(outRoot, "README.md"),
			fs.existsSync(readme)
				? fs.readFileSync(readme, "utf8")
				: `# ${published_pkg.name}\n\nPart of [Alethia](https://alethialabs.io), published from the \`packages/${short}\` workspace package of [alethialabs-io/alethialabs](https://github.com/alethialabs-io/alethialabs). Licensed AGPL-3.0-only.\n`,
		);
		fs.rmSync(path.join(outRoot, "tsconfig.release.json"), { force: true });
		staged.push(outRoot);
	}
	return { staged, problems, order: targets };
}

/** Exercises the pure transforms with planted defects; exits non-zero on any miss. */
function selfTest() {
	const fails = [];
	const expect = (cond, msg) => cond || fails.push(msg);

	const ex = transformExports(
		{ ".": "./src/index.ts", "./b": "./src/b.tsx", "./*": "./src/*.tsx", "./t.css": "./src/t.css", "./c": "./conformance/c.ts", "./x": "./other/x.ts" },
		["./c"],
	);
	expect(JSON.stringify(ex.exports["."]) === JSON.stringify({ types: "./dist/index.d.ts", default: "./dist/index.js" }), "ts export not mapped to dist");
	expect(ex.exports["./*"]?.default === "./dist/*.js", "wildcard export not kept");
	expect(ex.exports["./t.css"] === "./dist/t.css", "css export not moved to dist");
	expect(!("./c" in ex.exports), "omitted export was published");
	expect(ex.errors.length === 1 && ex.errors[0].includes('"./x"'), "an export outside src/ was not refused");

	const dp = transformDeps(
		{ react: "^19", "@repo/ui": "workspace:*", "@repo/secret": "workspace:*" },
		{ scope: "@alethialabs", published: ["ui"], versions: { ui: "0.2.0" } },
	);
	expect(dp.deps.react === "^19", "third-party dependency changed");
	expect(dp.deps["@alethialabs/ui"] === "^0.2.0", "workspace dependency not renamed with its version");
	expect(dp.errors.length === 1 && dp.errors[0].includes("@repo/secret"), "unpublished workspace dependency not refused");

	const deps = { brand: ["ui", "legal"], ui: [], legal: [] };
	const order = topoOrder(Object.keys(deps), (n) => deps[n]);
	expect(order.indexOf("brand") > order.indexOf("ui") && order.indexOf("brand") > order.indexOf("legal"), "dependent ordered before its dependency");
	let cycle = false;
	try {
		topoOrder(["a", "b"], (n) => (n === "a" ? ["b"] : ["a"]));
	} catch {
		cycle = true;
	}
	expect(cycle, "dependency cycle not refused");

	const p = pathsFor(["ui"], () => ({ "./button": "./src/button.tsx", ".": "./src/index.ts" }), "/stage");
	expect(p["@repo/ui/button"]?.[0] === path.join("/stage", "ui", "dist", "button"), "paths map does not point at the staged declarations");
	expect(p["@repo/ui"]?.[0] === path.join("/stage", "ui", "dist", "index"), "root export missing from paths map");

	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "stage-selftest-"));
	fs.mkdirSync(path.join(tmp, "packages"), { recursive: true });
	fs.writeFileSync(path.join(tmp, "packages", "public-packages.json"), JSON.stringify({ scope: "@x", packages: { a: {} } }));
	expect(readManifest(tmp).packages.a !== undefined, "manifest not read");
	fs.rmSync(tmp, { recursive: true, force: true });

	if (fails.length) {
		console.error(`stage-public-packages self-test FAILED:\n  - ${fails.join("\n  - ")}`);
		process.exit(1);
	}
	console.log("stage-public-packages self-test: every planted defect caught.");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	if (process.argv.includes("--self-test")) {
		selfTest();
	} else {
		const i = process.argv.indexOf("--only");
		const only = i > 0 ? process.argv[i + 1].split(",") : undefined;
		const { staged, problems, order } = stageAll({ only });
		if (problems.length) {
			console.error(`stage-public-packages: ${problems.length} problem(s):\n  - ${problems.join("\n  - ")}`);
			process.exit(1);
		}
		console.log(`stage-public-packages: staged ${staged.length} package(s) in publish order: ${order.join(", ")} → .release/packages/`);
	}
}
