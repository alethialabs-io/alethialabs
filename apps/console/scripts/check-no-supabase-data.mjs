// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Guard for the de-Supabase migration (P1): asserts that no Supabase *data* access
// (`supabase.from("…")` / `supabase.rpc(…)`) remains in app/ + lib/. Every read and
// write must go through Drizzle (getServiceDb / withOwnerScope). Supabase auth
// (`supabase.auth.*`), realtime (`.channel`), and storage are intentionally out of
// scope (P3/P4). Drizzle's own `.from(table)` takes an identifier, not a string,
// so matching `.from("`/`.from('` cleanly targets Supabase calls only.
//
// ALLOWLIST: client components/stores that still read via the browser Supabase
// client. These are realtime-coupled and migrate alongside the realtime→SSE work
// (P4) by moving their initial reads into Drizzle-backed server actions. Remove
// each entry as it is migrated; the goal is an empty allowlist.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOTS = ["app", "lib"];
const ALLOWLIST = new Set([
	"app/(private)/dashboard/page.tsx",
	"app/(private)/dashboard/jobs/[id]/page.tsx",
	"lib/stores/use-tendrils-store.ts",
]);

const DATA_ACCESS = /\.from\(["']|\.rpc\(/;

/** Recursively collects .ts/.tsx files under a directory. */
function walk(dir, out) {
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) {
			walk(full, out);
		} else if (/\.tsx?$/.test(full)) {
			out.push(full);
		}
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
	if (ALLOWLIST.has(rel)) continue;
	const lines = readFileSync(file, "utf8").split("\n");
	lines.forEach((line, i) => {
		if (DATA_ACCESS.test(line)) {
			violations.push(`${rel}:${i + 1}: ${line.trim()}`);
		}
	});
}

if (violations.length > 0) {
	console.error(
		`Found ${violations.length} Supabase data-access call(s) that must use Drizzle:`,
	);
	for (const v of violations) console.error(`  ${v}`);
	process.exit(1);
}

console.log(
	`OK — no Supabase data access in app/ + lib/ (allowlist: ${ALLOWLIST.size} P4 client file(s)).`,
);
