#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A PR that changes what a published package ships needs a changeset (docs/contributing/releasing-packages.md).
 *
 * The packages in packages/public-packages.json are published to npm as `@alethialabs/*`. Without a
 * changeset, a change to one of them never gets a version, so the private repo that installs it can
 * never receive it, and nobody notices until someone asks why. This check reads the PR's changed
 * files and FAILS when a published package's shipped files changed and the PR adds no
 * `.changeset/*.md`.
 *
 * Counted as shipped: anything under `packages/<name>/` except tests, test fixtures and the
 * package's own lint/type/test configuration (none of those reach npm). README.md counts: it is the
 * package's npm page.
 * Exempt: the "Version packages" PR itself (head branch `changeset-release/*`), which consumes the
 * changesets instead of adding one.
 *
 * Usage:
 *   node scripts/release/check-changeset.mjs              # in CI: reads the PR from GITHUB_EVENT_PATH via gh
 *   node scripts/release/check-changeset.mjs --files a,b  # explicit list (local use)
 *   node scripts/release/check-changeset.mjs --self-test
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const NOT_SHIPPED = /(\.test\.|\.spec\.|__tests__\/|\/tests\/|\/conformance\/|\/coverage|vitest\.config|eslint\.config|tsconfig[^/]*\.json$|\.eslintrc|coverage-floors\.json|coverage-exclusions\.yaml)/;

/** Returns the published package names whose shipped files the change list touches. */
export function touchedPackages(files, published) {
	const out = new Set();
	for (const f of files) {
		const m = /^packages\/([^/]+)\//.exec(f);
		if (!m || !published.includes(m[1])) continue;
		if (NOT_SHIPPED.test(f)) continue;
		out.add(m[1]);
	}
	return [...out].sort();
}

/** True when the change list adds a changeset note (not the README or config). */
export function hasChangeset(files) {
	return files.some((f) => /^\.changeset\/[^/]+\.md$/.test(f) && f !== ".changeset/README.md");
}

/** Lists the PR's changed files through the GitHub API (the guards job is a shallow checkout). */
function prFiles() {
	const event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
	const n = event.pull_request?.number;
	if (!n) return null;
	const out = execFileSync(
		"gh",
		["api", "--paginate", `repos/${process.env.GITHUB_REPOSITORY}/pulls/${n}/files`, "--jq", ".[].filename"],
		{ encoding: "utf8" },
	);
	return out.split("\n").filter(Boolean);
}

/** Plants each case and asserts the verdict. */
function selfTest() {
	const pub = ["ui", "brand"];
	const cases = [
		[["packages/ui/src/button.tsx"], ["ui"], "a shipped source change was not counted"],
		[["packages/ui/src/button.test.tsx", "packages/ui/vitest.config.ts", "packages/ui/tsconfig.json"], [], "a test/config-only change was counted"],
		[["packages/console-only/src/x.ts"], [], "an unpublished package was counted"],
		[["packages/brand/README.md", "apps/console/x.ts"], ["brand"], "the README (the npm page) was not counted"],
	];
	const fails = [];
	for (const [files, want, msg] of cases) if (JSON.stringify(touchedPackages(files, pub)) !== JSON.stringify(want)) fails.push(msg);
	if (!hasChangeset([".changeset/quiet-owls.md"])) fails.push("a changeset note was not seen");
	if (hasChangeset([".changeset/README.md", ".changeset/config.json"])) fails.push("the README/config were taken for a changeset");
	if (fails.length) {
		console.error(`check-changeset self-test FAILED:\n  - ${fails.join("\n  - ")}`);
		process.exit(1);
	}
	console.log("check-changeset self-test: every planted case judged correctly.");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	if (process.argv.includes("--self-test")) {
		selfTest();
		process.exit(0);
	}
	if ((process.env.GITHUB_HEAD_REF ?? "").startsWith("changeset-release/")) {
		console.log("check-changeset: the Version packages PR consumes changesets; nothing to check.");
		process.exit(0);
	}
	const i = process.argv.indexOf("--files");
	const files = i > 0 ? process.argv[i + 1].split(",") : prFiles();
	if (files === null) {
		console.log("check-changeset: not a pull request; nothing to check.");
		process.exit(0);
	}
	const published = Object.keys(JSON.parse(fs.readFileSync(path.join(ROOT, "packages", "public-packages.json"), "utf8")).packages);
	const touched = touchedPackages(files, published);
	if (touched.length && !hasChangeset(files)) {
		console.error(
			`check-changeset: this PR changes published package(s) ${touched.map((t) => `@repo/${t}`).join(", ")} but adds no changeset.\n` +
				"  Run `pnpm changeset`, or add a file .changeset/<any-name>.md like:\n\n" +
				`  ---\n${touched.map((t) => `  "@repo/${t}": patch`).join("\n")}\n  ---\n\n  One line saying what changed, for the changelog.\n`,
		);
		process.exit(1);
	}
	console.log(`check-changeset: ${touched.length ? `changeset present for ${touched.join(", ")}` : "no published package changed"}.`);
}
