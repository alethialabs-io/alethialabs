// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Guard: SPDX copyright headers must be legal-form-AGNOSTIC — "Alethia Labs <legal@…>", never
// "Alethia Labs OÜ / OU / DPK / …". The volatile legal form lives ONLY in packages/brand/src/legal.ts
// (LEGAL_ENTITY) + NOTICE / LICENSE prose, so an entity rename never re-touches ~1,500 headers.
// This is the tripwire that keeps that true: it fails if any legal form leaks back into a header.
// Remediation is a one-command sweep: node scripts/normalize-copyright-headers.mjs
//
// Precise on purpose: it only inspects a genuine copyright line (SPDX-FileCopyrightText + 4-digit
// year + Alethia Labs + email), so prose / regex / step-names that mention the header string don't
// self-trip. Scans git-tracked + untracked-but-not-ignored files, so it never touches
// node_modules/.next/dist.
//
// Wired into CI (guards job) + the pre-commit hook (R4).
// Usage: node scripts/check-license-headers.mjs   (exits 1 if any offender is found)

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

const SPDX = "SPDX-FileCopyrightText";
// A real copyright line offends when a non-empty token (not whitespace, not the "<email>" delimiter)
// sits between "Alethia Labs" and the "<email>" — i.e. a legal form leaked in. The 4-digit-year
// anchor keeps this off tooling prose/regex. A clean "…Alethia Labs <legal@…>" does not match.
const OFFENDING_RE =
	/SPDX-FileCopyrightText:\s*\d{4}\s+Alethia Labs\s+[^\s<][^\n<]*</;

const files = execSync("git ls-files --cached --others --exclude-standard", {
	encoding: "utf8",
	maxBuffer: 64 * 1024 * 1024,
})
	.split("\n")
	.filter(Boolean);

const offenders = [];
for (const file of files) {
	let text;
	try {
		text = readFileSync(file, "utf8");
	} catch {
		continue; // unreadable / binary / deleted
	}
	if (!text.includes(SPDX)) continue;
	const lines = text.split("\n");
	for (let i = 0; i < lines.length; i++) {
		if (OFFENDING_RE.test(lines[i])) offenders.push(`${file}:${i + 1}`);
	}
}

if (offenders.length > 0) {
	console.error(
		`✗ ${offenders.length} SPDX header line(s) carry a legal form (must be form-agnostic "Alethia Labs <legal@…>"):`,
	);
	for (const o of offenders) console.error(`   ${o}`);
	console.error(
		"\nThe legal form (OÜ / DPK / …) belongs only in NOTICE / LICENSE / legal.ts, never in headers.",
	);
	console.error("Fix with:  node scripts/normalize-copyright-headers.mjs");
	process.exit(1);
}

console.log("✓ check-license-headers: every SPDX header is legal-form-agnostic.");
