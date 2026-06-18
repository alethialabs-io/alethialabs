// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Guard: asserts that NO Supabase usage remains in the console source. The whole
// platform now runs on Drizzle (data), Better Auth (auth), SSE + Postgres
// LISTEN/NOTIFY (realtime), and S3 (storage). The `@supabase/*` import ban is the
// load-bearing check — without a Supabase client you can't call .from/.rpc/.auth/
// .channel/.storage — and the explicit patterns catch accidental reintroduction.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOTS = ["app", "lib", "components", "hooks"];

const FORBIDDEN = [
	{ re: /@supabase\//, label: "@supabase/* import" },
	{
		re: /\bsupabase\s*\.\s*(from|rpc|auth|channel|storage|realtime|removeChannel)\b/,
		label: "supabase client call",
	},
	{ re: /\.channel\(/, label: "realtime .channel()" },
];

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
	const lines = readFileSync(file, "utf8").split("\n");
	lines.forEach((line, i) => {
		for (const { re, label } of FORBIDDEN) {
			if (re.test(line)) {
				violations.push(`${rel}:${i + 1} [${label}]: ${line.trim()}`);
			}
		}
	});
}

if (violations.length > 0) {
	console.error(`Found ${violations.length} Supabase reference(s) — none allowed:`);
	for (const v of violations) console.error(`  ${v}`);
	process.exit(1);
}

console.log("OK — zero Supabase references in app/ + lib/ + components/ + hooks/.");
