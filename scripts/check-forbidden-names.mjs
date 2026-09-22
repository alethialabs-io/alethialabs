#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
//
// Fails when a name that must not appear in this PUBLIC repository appears in a tracked file.
//
// WHY THIS EXISTS, measured. A third-party company's name — a real firm, unaffiliated with
// Alethia Labs — was used as a test-fixture org slug and is embedded in the e2e GCP project id.
// On 2026-09-22 it was present on 80 lines across 7 tracked files of a public repo. It had been
// removed once already: commit 0a2e9a42d, "chore: remove the former client's name from the public
// repo (#2416)". That cleanup ran, and 80 occurrences survived it — because a one-pass
// search-and-replace removes what exists today and says nothing about tomorrow. Nothing failed
// when it came back. This guard is the part #2416 was missing.
//
// GCP project ids are IMMUTABLE, so the id cannot be fixed by renaming the project. Docs and
// runbooks refer to it as ${GCP_E2E_PROJECT_ID}; the literal lives only in repo variables.
//
// WHY THE GUARD STORES HASHES, NOT THE NAMES. A guard holding the forbidden literal reintroduces
// the exact exposure it exists to prevent — grep the repo for the name and the guard hands it to
// you. So compliance/forbidden-name-hashes.json stores salted SHA-256 digests, and this script
// hashes candidate tokens to compare. Read that file's $comment for what this deliberately does
// NOT provide: the salt is committed, the inputs are short, so it is brute-forceable and is not a
// secret store. The property bought is that the name is absent from PLAINTEXT in a public tree and
// cannot return by accident.
//
// WHAT IS DELIBERATELY NOT COVERED, so nobody reads this as more than it is:
//   · git HISTORY. The name remains in commits back to #446. Rewriting public history invalidates
//     every clone and fork, breaks PR refs, and GitHub serves orphaned commits by SHA until
//     support garbage-collects. Recorded decision 2026-09-22: tree only.
//   · Repo VARIABLES and Actions logs. E2E_GCP_SA_EMAIL and E2E_GCP_EXTERNAL_DNS_SA contain the
//     project id. They are not in the tree, so this guard cannot see them, and it does not pretend
//     to. E2E_GCP_WIF_PROVIDER uses the project NUMBER and is the pattern to copy.
//   · UNTRACKED files, and anything outside `git ls-files`.
//   · A name split across lines, or obfuscated. This matches whole tokens, nothing cleverer.
//
// Usage:  node scripts/check-forbidden-names.mjs [--self-test]

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG = "compliance/forbidden-name-hashes.json";

/** Largest file we will read. Proof logs are big; anything past this is not prose. */
const MAX_BYTES = 4 * 1024 * 1024;

/**
 * Split a line into lowercased candidate tokens. A hyphenated token is yielded whole AND in
 * parts, so that both `name-adp` and a bare `name` are caught by their own digests.
 */
function tokens(line) {
	const out = new Set();
	for (const raw of line.toLowerCase().match(/[a-z][a-z0-9-]{2,63}/g) ?? []) {
		const trimmed = raw.replace(/-+$/, "");
		if (trimmed.length < 3) continue;
		out.add(trimmed);
		if (trimmed.includes("-")) {
			for (const part of trimmed.split("-")) {
				if (part.length >= 3) out.add(part);
			}
		}
	}
	return out;
}

/** Load the digest set. Returns {salt, digests: Map<digest, why>}. */
function loadConfig(root) {
	const parsed = JSON.parse(readFileSync(join(root, CONFIG), "utf8"));
	const digests = new Map();
	for (const e of parsed.entries ?? []) digests.set(e.digest, e.why ?? "");
	return { salt: parsed.salt, digests };
}

/** List the tracked files this guard reads. */
function trackedFiles(root) {
	const out = execFileSync("git", ["ls-files", "-z"], { cwd: root, maxBuffer: 64 * 1024 * 1024 });
	return out
		.toString("utf8")
		.split("\0")
		.filter(Boolean)
		.filter((f) => f !== CONFIG);
}

/**
 * Scan `files` under `root` for tokens whose salted digest is in `digests`.
 * Returns findings as {file, line, digest, why} — never the offending token itself.
 */
function scan(root, files, salt, digests) {
	const findings = [];
	const memo = new Map();
	const digestOf = (token) => {
		let d = memo.get(token);
		if (d === undefined) {
			d = createHash("sha256").update(salt + token, "utf8").digest("hex");
			memo.set(token, d);
		}
		return d;
	};

	for (const file of files) {
		let buf;
		try {
			buf = readFileSync(join(root, file));
		} catch {
			continue; // deleted between ls-files and now, or unreadable
		}
		if (buf.length > MAX_BYTES) continue;
		if (buf.includes(0)) continue; // binary

		const lines = buf.toString("utf8").split("\n");
		for (let i = 0; i < lines.length; i++) {
			for (const token of tokens(lines[i])) {
				const d = digestOf(token);
				if (digests.has(d)) {
					findings.push({ file, line: i + 1, digest: d, why: digests.get(d) });
				}
			}
		}
	}
	return findings;
}

/**
 * Exercise the mechanism on a throwaway fixture, using a salt and token generated here rather
 * than the real ones — the real literal is not in the repo and must not be written into it.
 * Asserts BOTH directions: a planted token fails, and its absence passes.
 */
function selfTest() {
	const dir = mkdtempSync(join(tmpdir(), "forbidden-names-"));
	let failures = 0;
	try {
		execFileSync("git", ["init", "-q"], { cwd: dir });
		const salt = "0123456789abcdef";
		const token = "zzzsentinelzzz";
		const digest = createHash("sha256").update(salt + token, "utf8").digest("hex");
		writeFileSync(
			join(dir, CONFIG.split("/").pop()),
			JSON.stringify({ salt, entries: [{ digest, why: "self-test sentinel" }] }),
		);
		const cfg = { salt, digests: new Map([[digest, "self-test sentinel"]]) };

		// 1 · a clean file must produce nothing
		writeFileSync(join(dir, "clean.txt"), "nothing to see here\nsecond line\n");
		const clean = scan(dir, ["clean.txt"], cfg.salt, cfg.digests);
		if (clean.length !== 0) {
			console.error(`self-test FAIL: clean file produced ${clean.length} finding(s)`);
			failures++;
		}

		// 2 · a planted bare token must be caught, on the right line
		writeFileSync(join(dir, "dirty.txt"), `line one\nhere is ${token} in prose\n`);
		const dirty = scan(dir, ["dirty.txt"], cfg.salt, cfg.digests);
		if (dirty.length !== 1 || dirty[0].line !== 2) {
			console.error(`self-test FAIL: expected 1 finding on line 2, got ${JSON.stringify(dirty)}`);
			failures++;
		}

		// 3 · a hyphenated compound must be caught by its PART's digest
		writeFileSync(join(dir, "compound.txt"), `id=projects/${token}-adp/zones/x\n`);
		const compound = scan(dir, ["compound.txt"], cfg.salt, cfg.digests);
		if (compound.length !== 1) {
			console.error(`self-test FAIL: hyphenated compound not caught: ${JSON.stringify(compound)}`);
			failures++;
		}

		// 4 · case must not matter
		writeFileSync(join(dir, "case.txt"), `${token.toUpperCase()}\n`);
		if (scan(dir, ["case.txt"], cfg.salt, cfg.digests).length !== 1) {
			console.error("self-test FAIL: uppercase occurrence not caught");
			failures++;
		}

		// 5 · a binary file must be skipped, not crash
		writeFileSync(join(dir, "bin.dat"), Buffer.from([0x00, 0x01, 0x02]));
		if (scan(dir, ["bin.dat"], cfg.salt, cfg.digests).length !== 0) {
			console.error("self-test FAIL: binary file was scanned");
			failures++;
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}

	if (failures > 0) {
		console.error(`\n✗ check-forbidden-names self-test: ${failures} failure(s)`);
		process.exit(1);
	}
	console.log("✓ check-forbidden-names self-test: 5/5 — planted token caught bare, hyphenated and upper-cased; clean and binary files pass");
}

function main() {
	if (process.argv.includes("--self-test")) return selfTest();

	const { salt, digests } = loadConfig(ROOT);
	if (!salt || digests.size === 0) {
		console.error(`✗ ${CONFIG} has no salt or no entries — the guard would pass vacuously.`);
		process.exit(1);
	}

	const files = trackedFiles(ROOT);
	const findings = scan(ROOT, files, salt, digests);

	if (findings.length === 0) {
		console.log(
			`✓ check-forbidden-names: ${files.length} tracked file(s) scanned, ${digests.size} forbidden name(s), 0 occurrences.`,
		);
		return;
	}

	console.error(`✗ check-forbidden-names: ${findings.length} occurrence(s) of a forbidden name.\n`);
	const byFile = new Map();
	for (const f of findings) {
		if (!byFile.has(f.file)) byFile.set(f.file, []);
		byFile.get(f.file).push(f);
	}
	for (const [file, hits] of byFile) {
		console.error(`  ${file}`);
		for (const h of hits) console.error(`    line ${h.line}  digest ${h.digest.slice(0, 12)}…`);
		console.error(`    why: ${hits[0].why}`);
		console.error("");
	}
	console.error("The offending token is deliberately NOT printed — printing it here would put it");
	console.error("in CI logs, which is the exposure this guard exists to prevent. Find it with:");
	console.error(`    SALT=$(jq -r .salt ${CONFIG})`);
	console.error("    # hash the candidate you suspect and compare to the digest above");
	process.exit(1);
}

main();
