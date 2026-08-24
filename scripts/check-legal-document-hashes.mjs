#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The seal on every public legal document (#2372).
 *
 * A clickwrap record says "this user accepted Terms v2026-08-12 at 14:02". That is worth nothing
 * unless somebody can still say what v2026-08-12 SAID. `LEGAL_DOCUMENTS[].contentHash` pins the
 * exact bytes of the source that renders it, and this script is what keeps the pin honest: edit the
 * document without re-sealing and CI goes red.
 *
 * A CHECK by default, on purpose. Auto-regenerating would silently re-seal changed text under the
 * SAME version — which would leave every existing acceptance pointing at words the user never saw,
 * and would do it invisibly. That decision belongs to a person.
 *
 *   node scripts/check-legal-document-hashes.mjs            # verify (CI)
 *   node scripts/check-legal-document-hashes.mjs --seal     # re-seal, after bumping the version
 *   node scripts/check-legal-document-hashes.mjs --seal --same-version
 *                                                          # re-seal WITHOUT a version bump —
 *                                                          # only for a non-material edit (a typo,
 *                                                          # a formatting change, a refactor that
 *                                                          # does not alter what the reader agrees
 *                                                          # to). Says so out loud.
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DOCUMENTS_TS = join(ROOT, "packages/legal/src/documents.ts");

const argv = process.argv.slice(2);
const seal = argv.includes("--seal");
const sameVersion = argv.includes("--same-version");

/**
 * Reads the declared documents straight out of the TypeScript source.
 *
 * A regex rather than an import because this runs as plain node in CI with no transpile step, and
 * because the shape it needs is four flat string fields. It is deliberately strict: a document whose
 * block does not match is REPORTED, never skipped — a silently-unchecked legal document is the one
 * failure this script cannot be allowed to have.
 */
function readDeclaredDocuments() {
	const src = readFileSync(DOCUMENTS_TS, "utf8");
	const blocks = src.split(/\n\t\{\n/).slice(1);
	const docs = [];
	for (const block of blocks) {
		const body = block.split(/\n\t\},?/)[0];
		const field = (name) => {
			const m = body.match(new RegExp(`\\b${name}:\\s*\\n?\\s*"([^"]*)"`));
			return m ? m[1] : null;
		};
		const id = field("id");
		if (!id) continue;
		docs.push({
			id,
			version: field("version"),
			contentHash: field("contentHash"),
			source: field("source"),
		});
	}
	return { src, docs };
}

function sha256(path) {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

const { src, docs } = readDeclaredDocuments();
if (docs.length === 0) {
	console.error(
		"::error::check-legal-document-hashes: parsed NO documents out of packages/legal/src/documents.ts — " +
			"the parser has drifted from the file's shape, so this guard is checking nothing.",
	);
	process.exit(1);
}

const problems = [];
const stale = [];
for (const doc of docs) {
	if (!doc.source || !doc.contentHash) {
		problems.push(
			`${doc.id}: declares no ${!doc.source ? "source" : "contentHash"} — a document nobody can pin ` +
				`cannot be evidence of what was accepted.`,
		);
		continue;
	}
	let actual;
	try {
		actual = sha256(join(ROOT, doc.source));
	} catch (err) {
		problems.push(`${doc.id}: cannot read ${doc.source} — ${err.message}`);
		continue;
	}
	if (actual !== doc.contentHash) {
		stale.push({ ...doc, actual });
	}
}

if (problems.length > 0) {
	for (const p of problems) console.error(`::error::check-legal-document-hashes: ${p}`);
	process.exit(1);
}

if (stale.length === 0) {
	console.log(
		`✓ check-legal-document-hashes: ${docs.length} legal document(s) match their sealed hash.`,
	);
	process.exit(0);
}

if (!seal) {
	for (const d of stale) {
		console.error(
			`::error file=${d.source}::check-legal-document-hashes: ${d.id} (v${d.version}) has CHANGED since it was ` +
				`sealed.\n  sealed: ${d.contentHash}\n  actual: ${d.actual}\n` +
				`  If the change alters what a reader agrees to, bump \`version\` in packages/legal/src/documents.ts ` +
				`and re-seal — existing acceptances stay pinned to the old version, which is the point.\n` +
				`  Re-seal with: node scripts/check-legal-document-hashes.mjs --seal`,
		);
	}
	console.error(
		"\nWhy this is a hard failure: a clickwrap record names a version. If the text behind that version " +
			"can move, the record proves nothing about what the user actually agreed to.",
	);
	process.exit(1);
}

// --seal. Refuse to re-seal a changed document under an unchanged version unless told explicitly:
// that is the case where existing acceptances silently start pointing at text nobody accepted.
if (!sameVersion) {
	const gitVersions = new Map();
	try {
		const { execSync } = await import("node:child_process");
		const head = execSync(`git show HEAD:packages/legal/src/documents.ts`, {
			cwd: ROOT,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		});
		for (const block of head.split(/\n\t\{\n/).slice(1)) {
			const body = block.split(/\n\t\},?/)[0];
			const id = body.match(/\bid:\s*"([^"]*)"/)?.[1];
			const version = body.match(/\bversion:\s*"([^"]*)"/)?.[1];
			if (id) gitVersions.set(id, version);
		}
	} catch {
		// No git history to compare against (a fresh checkout, a shallow clone): fall through and
		// seal. Refusing here would make the tool unusable in exactly the case where it is harmless.
	}
	const unbumped = stale.filter(
		(d) => gitVersions.has(d.id) && gitVersions.get(d.id) === d.version,
	);
	if (unbumped.length > 0) {
		for (const d of unbumped) {
			console.error(
				`::error file=${d.source}::check-legal-document-hashes: ${d.id} changed but its version is still ` +
					`"${d.version}".\n  Bump the version if the change alters what a reader agrees to — every existing ` +
					`acceptance record names the OLD version, and re-sealing under it makes those records describe text ` +
					`the user never saw.\n  If the edit is genuinely non-material (a typo, formatting, a refactor), ` +
					`re-run with --same-version to say so.`,
			);
		}
		process.exit(1);
	}
}

let out = src;
for (const d of stale) {
	if (!out.includes(d.contentHash)) {
		console.error(`::error::check-legal-document-hashes: could not locate ${d.id}'s hash to replace.`);
		process.exit(1);
	}
	out = out.replace(d.contentHash, d.actual);
	console.log(
		`  sealed ${d.id} (v${d.version}) → ${d.actual}${sameVersion ? "  [--same-version: declared non-material]" : ""}`,
	);
}
writeFileSync(DOCUMENTS_TS, out);
console.log(`✓ re-sealed ${stale.length} legal document(s).`);
