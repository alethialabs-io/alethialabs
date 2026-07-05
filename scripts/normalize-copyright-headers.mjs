// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// One-time, idempotent sweep that makes SPDX copyright headers FORM-AGNOSTIC:
//   "SPDX-FileCopyrightText: <year> Alethia Labs OÜ <legal@…>"  ->  "… Alethia Labs <legal@…>"
// The volatile legal form (OÜ / DPK / …) no longer lives in ~1,400 file headers — the exact current
// entity lives in packages/brand/src/legal.ts (LEGAL_ENTITY) + NOTICE / LICENSE. So this is the LAST
// time headers change for an entity rename; if it ever churns again it's a one-command re-run.
//
// Scope: only SPDX copyright LINES (LICENSE/NOTICE/legal-page prose keep the full legal name and are
// edited by hand). Targets git-tracked + untracked-but-not-ignored files, so it never touches
// node_modules/.next/dist. Run from the repo root when the working tree is quiesced:
//
//   node scripts/normalize-copyright-headers.mjs

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const FROM = "Alethia Labs OÜ";
const TO = "Alethia Labs"; // form-agnostic — full entity lives in LEGAL_ENTITY / NOTICE
const SPDX = "SPDX-FileCopyrightText";

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
	if (!text.includes(SPDX) || !text.includes(FROM)) continue;
	const out = text
		.split("\n")
		.map((line) => (line.includes(SPDX) ? line.split(FROM).join(TO) : line))
		.join("\n");
	if (out !== text) {
		writeFileSync(file, out);
		changed++;
	}
}

console.log(`normalize-copyright-headers: updated ${changed} file(s)`);
