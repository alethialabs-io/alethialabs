#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The seal on the contributor agreements (#2374).
 *
 * A CLA signature record names a version and a document hash. That is only worth anything if the
 * text behind that version cannot move — otherwise "signed ICLA v1.1" describes whatever v1.1 says
 * today, which may not be what the contributor read.
 *
 * The agreements are still DRAFTS, and sealing them now is the point rather than a contradiction:
 * the window between counsel approving the text and `pnpm legal:activate-ip` switching enforcement
 * on is exactly when an unnoticed edit would be most damaging. `cla/ACTIVE` is what activates; this
 * only pins.
 *
 *   node scripts/legal/check-cla-hashes.mjs          # verify (CI)
 *   node scripts/legal/check-cla-hashes.mjs --seal   # re-seal after a deliberate edit
 *
 * `--seal` refuses when the document changed but its version did not, unless `--same-version` says
 * the edit was non-material. Same rule as the public legal documents
 * (scripts/check-legal-document-hashes.mjs), and for the same reason: re-sealing under an unchanged
 * version makes every existing signature describe text nobody signed.
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const MANIFEST = join(ROOT, "cla/DOCUMENTS.json");

const argv = process.argv.slice(2);
const seal = argv.includes("--seal");
const sameVersion = argv.includes("--same-version");

const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
const docs = Array.isArray(manifest.documents) ? manifest.documents : [];
if (docs.length === 0) {
	console.error(
		"::error::check-cla-hashes: cla/DOCUMENTS.json declares no documents — the seal is checking nothing.",
	);
	process.exit(1);
}

const sha256 = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");

const stale = [];
for (const doc of docs) {
	for (const field of ["id", "version", "source", "sha256"]) {
		if (!doc[field]) {
			console.error(`::error::check-cla-hashes: a document declares no ${field}: ${JSON.stringify(doc)}`);
			process.exit(1);
		}
	}
	let actual;
	try {
		actual = sha256(join(ROOT, doc.source));
	} catch (err) {
		console.error(`::error::check-cla-hashes: cannot read ${doc.source} — ${err.message}`);
		process.exit(1);
	}
	if (actual !== doc.sha256) stale.push({ ...doc, actual });
}

// ACTIVATION GUARD. Once cla/ACTIVE exists it names the version and hash the gate enforces, and it
// must agree with what was sealed — otherwise a signature is recorded against one text while the
// gate checks another.
let active = null;
try {
	active = JSON.parse(readFileSync(join(ROOT, "cla/ACTIVE"), "utf8"));
} catch {
	// Absent is the expected state before activation, and is not an error.
}
if (active) {
	const icla = docs.find((d) => d.id === "icla");
	if (icla && active.cla_version !== icla.version) {
		console.error(
			`::error::check-cla-hashes: cla/ACTIVE enforces v${active.cla_version} but the sealed ICLA is ` +
				`v${icla.version}. A signature would be recorded against a version the gate does not check.`,
		);
		process.exit(1);
	}
	if (icla && active.icla_sha256 && active.icla_sha256 !== icla.sha256) {
		console.error(
			`::error::check-cla-hashes: cla/ACTIVE pins ICLA hash ${active.icla_sha256}, the seal says ` +
				`${icla.sha256}. One of them describes text nobody signed.`,
		);
		process.exit(1);
	}
	for (const d of docs) {
		if (d.status !== "active") {
			console.error(
				`::error::check-cla-hashes: cla/ACTIVE exists but ${d.id} is still marked "${d.status}". ` +
					`Enforcement is on against a document this manifest says is not final.`,
			);
			process.exit(1);
		}
	}
}

if (stale.length === 0) {
	console.log(`✓ check-cla-hashes: ${docs.length} contributor agreement(s) match their sealed hash.`);
	process.exit(0);
}

if (!seal) {
	for (const d of stale) {
		console.error(
			`::error file=${d.source}::check-cla-hashes: ${d.id} (v${d.version}) has CHANGED since it was sealed.\n` +
				`  sealed: ${d.sha256}\n  actual: ${d.actual}\n` +
				`  If the change alters what a contributor agrees to, bump \`version\` in cla/DOCUMENTS.json and\n` +
				`  re-seal — existing signatures stay pinned to the old version, which is the point.\n` +
				`  Re-seal with: node scripts/legal/check-cla-hashes.mjs --seal`,
		);
	}
	process.exit(1);
}

if (!sameVersion) {
	const { execSync } = await import("node:child_process");
	let head = null;
	try {
		head = JSON.parse(
			execSync("git show HEAD:cla/DOCUMENTS.json", { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }),
		);
	} catch {
		// No history to compare against (fresh checkout, shallow clone): sealing is harmless there.
	}
	if (head) {
		const before = new Map((head.documents ?? []).map((d) => [d.id, d.version]));
		const unbumped = stale.filter((d) => before.get(d.id) === d.version);
		if (unbumped.length > 0) {
			for (const d of unbumped) {
				console.error(
					`::error file=${d.source}::check-cla-hashes: ${d.id} changed but its version is still ` +
						`"${d.version}".\n  Every signature names a version. Re-sealing under an unchanged one makes ` +
						`those records describe text nobody signed.\n  If the edit is genuinely non-material (a typo, ` +
						`formatting), re-run with --same-version to say so.`,
				);
			}
			process.exit(1);
		}
	}
}

for (const d of stale) {
	const target = manifest.documents.find((x) => x.id === d.id);
	target.sha256 = d.actual;
	console.log(`  sealed ${d.id} (v${d.version}) → ${d.actual}${sameVersion ? "  [--same-version]" : ""}`);
}
writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`✓ re-sealed ${stale.length} contributor agreement(s).`);
