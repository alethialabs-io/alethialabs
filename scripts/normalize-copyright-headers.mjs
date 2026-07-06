// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Idempotent sweep that makes SPDX copyright headers FORM-AGNOSTIC — it strips ANY legal form
// (OÜ / OU / DPK / …) from the copyright line, collapsing it to a bare "Alethia Labs <legal@…>".
// The volatile legal form does NOT live in the ~1,500 file headers — the exact current entity lives
// in packages/brand/src/legal.ts (LEGAL_ENTITY) + NOTICE / LICENSE. So a future entity rename /
// re-domiciliation never re-touches these headers; re-running this is a harmless no-op.
//
// Precise on purpose: it only rewrites a genuine copyright line — "SPDX-FileCopyrightText:" + a
// 4-digit year + "Alethia Labs" + "<email>" — so prose / regex / step-names that merely MENTION the
// header string (this file, the guard, CI, docs) are left untouched.
//
// Scope: LICENSE / NOTICE / legal-page prose keep the full legal name and are edited by hand. Targets
// git-tracked + untracked-but-not-ignored files, so it never touches node_modules/.next/dist. Run
// from the repo root when the working tree is quiesced:
//
//   node scripts/normalize-copyright-headers.mjs
//
// Enforced by scripts/check-license-headers.mjs (CI guards job + pre-commit R4) so it can't drift.

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const SPDX = "SPDX-FileCopyrightText";
// Match a real copyright line and collapse whatever legal form sits between "Alethia Labs" and the
// "<email>" down to a single space. The 4-digit-year anchor keeps this off tooling prose/regex.
const FORM_RE = /(SPDX-FileCopyrightText:\s*\d{4}\s+Alethia Labs)[^\n<]*(<)/g;

const files = execSync("git ls-files --cached --others --exclude-standard", {
	encoding: "utf8",
	maxBuffer: 64 * 1024 * 1024,
})
	.split("\n")
	.filter(Boolean);

let changed = 0;
for (const file of files) {
	let text;
	try {
		text = readFileSync(file, "utf8");
	} catch {
		continue; // unreadable / binary / deleted
	}
	if (!text.includes(SPDX)) continue;
	const out = text.replace(FORM_RE, "$1 $2");
	if (out !== text) {
		writeFileSync(file, out);
		changed++;
	}
}

console.log(`normalize-copyright-headers: updated ${changed} file(s)`);
