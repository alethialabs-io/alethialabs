// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Authz-scope guard (project 07): user-facing entry points must authorize through the
// PDP (getPdp().enforce / authorize / authorizeCli), never ad-hoc `.eq(user_id)`
// ownership. Tenancy is the org RLS (server actions) or explicit `org_id` scoping
// (no-RLS CLI/stream paths). This lint fails on `eq(<x>.user_id, …)` or
// `x.user_id !==/===` in those surfaces. Insert *values* (`user_id: …`) and SELECT
// projections are fine; lib/ helpers are out of scope (their internal user_id
// scoping is community-correct and threaded to org separately).

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOTS = ["app/server/actions", "app/api/cli", "app/api/stream"];

// `eq(<table>.user_id, …)` filters and `x.user_id !== / ===` ownership compares.
const PATTERNS = [/\beq\(\s*\w+\.user_id\b/, /\.user_id\s*[!=]==/];

// Escape hatch for justified exceptions: a flagged line carrying a trailing
// `// authz-scope-ok: <reason>` comment is intentionally scoping the actor's own
// personal resource (already authorized upstream), not doing ad-hoc authz.
const ALLOW = /authz-scope-ok/;

function walk(dir, out) {
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) walk(full, out);
		else if (/\.tsx?$/.test(full)) out.push(full);
	}
}

const files = [];
for (const root of ROOTS) {
	try {
		walk(root, files);
	} catch {
		// root missing — ignore
	}
}

const violations = [];
for (const file of files) {
	const rel = relative(".", file);
	const lines = readFileSync(file, "utf8").split("\n");
	lines.forEach((line, i) => {
		if (ALLOW.test(line)) return;
		if (PATTERNS.some((p) => p.test(line))) {
			violations.push(`${rel}:${i + 1}: ${line.trim()}`);
		}
	});
}

if (violations.length > 0) {
	console.error(
		"Authz-scope violation — use the PDP (authorize/authorizeCli/enforce) + org scoping, not .eq(user_id):",
	);
	for (const v of violations) console.error(`  ${v}`);
	process.exit(1);
}

console.log("OK — no ad-hoc .eq(user_id) authz in server actions / CLI / stream routes.");
