#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Publishes the packages staged by stage-public-packages.mjs (`.release/packages/<name>/`) to npm,
 * in dependency order. Run it only from .github/workflows/release-packages.yml on `main`.
 *
 * - A version that is already on npm is SKIPPED, not re-published, so re-running the workflow after
 *   a partial failure finishes the release instead of erroring on the packages that made it.
 * - A package still at 0.0.0 is REFUSED: it has never been through a "Version packages" PR. The dry
 *   run only warns, because every PR before the first version bump would otherwise fail.
 * - Each real publish passes `--provenance`, which needs the job's OIDC token (`id-token: write`).
 *   Authentication is npm trusted publishing only; no npm token is stored.
 * - `--dry-run` runs `npm publish --dry-run` (packs, prints the tarball contents, uploads nothing).
 *   CI runs it on every PR that touches a published package.
 *
 * Usage: node scripts/release/publish-public-packages.mjs [--dry-run]
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readManifest, topoOrder, workspaceDeps } from "./stage-public-packages.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const STAGE = path.join(ROOT, ".release", "packages");

/** True when name@version already exists on the registry. */
function isPublished(name, version) {
	try {
		const out = execFileSync("npm", ["view", `${name}@${version}`, "version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
		return out.trim() === version;
	} catch {
		return false;
	}
}

const dryRun = process.argv.includes("--dry-run");
const manifest = readManifest();
const published = Object.keys(manifest.packages);
const wsPkg = (s) => JSON.parse(fs.readFileSync(path.join(ROOT, "packages", s, "package.json"), "utf8"));
const order = topoOrder(published, (s) => workspaceDeps(wsPkg(s)));

let done = 0;
let skipped = 0;
for (const short of order) {
	const dir = path.join(STAGE, short);
	if (!fs.existsSync(path.join(dir, "package.json"))) {
		console.error(`publish-public-packages: ${short} is not staged; run stage-public-packages.mjs first.`);
		process.exit(1);
	}
	const { name, version } = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
	if (version === "0.0.0") {
		if (!dryRun) {
			console.error(`publish-public-packages: ${name} is still at 0.0.0; it has never been versioned by a changeset.`);
			process.exit(1);
		}
		console.warn(`! ${name} is still at 0.0.0 (fine for a dry run; a real publish refuses it).`);
	}
	if (!dryRun && isPublished(name, version)) {
		console.log(`= ${name}@${version} is already on npm, skipped`);
		skipped++;
		continue;
	}
	const args = ["publish", dir, "--access", "public"];
	args.push(dryRun ? "--dry-run" : "--provenance");
	console.log(`${dryRun ? "~" : "+"} ${name}@${version}`);
	execFileSync("npm", args, { stdio: "inherit", cwd: ROOT });
	done++;
}
console.log(`publish-public-packages: ${dryRun ? "dry-ran" : "published"} ${done}, skipped ${skipped} already on npm.`);
