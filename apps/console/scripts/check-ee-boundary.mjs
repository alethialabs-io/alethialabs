// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Open-core boundary guard (spec 12): the AGPL core must NEVER import the
// commercial `@alethia/ee` package. The community build must be complete and
// buildable with `ee/` absent. The ONLY permitted touchpoint is the allowlisted
// loader (lib/enterprise.ts), which does a single tolerant dynamic load and routes
// everything else through the seams. Without this lint the boundary silently rots.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOTS = ["app", "lib", "components", "hooks"];
const ALLOWLIST = new Set(["lib/enterprise.ts"]);

// Any reference to the enterprise package specifier (static import, dynamic import,
// require, or re-export).
const EE_IMPORT = /@alethia\/ee\b/;

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
	if (ALLOWLIST.has(rel)) continue;
	const lines = readFileSync(file, "utf8").split("\n");
	lines.forEach((line, i) => {
		if (EE_IMPORT.test(line)) {
			violations.push(`${rel}:${i + 1}: ${line.trim()}`);
		}
	});
}

if (violations.length > 0) {
	console.error(
		`Open-core boundary violation — core must not import @alethia/ee (allowlist: lib/enterprise.ts):`,
	);
	for (const v of violations) console.error(`  ${v}`);
	process.exit(1);
}

console.log(
	"OK — no core → @alethia/ee imports outside the allowlisted loader.",
);
