// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Tailwind v4's `utility-(--var)` shorthand does NOT work for z-index, and fails SILENTLY.
//
// The shorthand resolves a CSS variable for utilities that map to a THEME NAMESPACE — `origin-`,
// `bg-`, `text-` and friends. z-index has no namespace in v4 (its values are bare integers), so
// `z-(--z-overlay)` matches no utility, Tailwind emits nothing, and the element ends up with
// `z-index: auto`. No build error. No warning. The class sits in the source looking correct.
//
// Measured in a real browser on a real build, on one element carrying both forms in one class
// string — which is what makes this airtight rather than a guess:
//
//     origin-(--transform-origin)  ->  transform-origin: 53.4201px -4px   ← resolved
//     z-(--z-overlay)              ->  z-index: auto                      ← generated NOTHING
//
// That is worse than the hardcoded `z-50` it replaced: the overlay went from a wrong layer to no
// layer. The whole named-scale change would have shipped as a regression while reading as a fix.
//
// The working form is the explicit arbitrary value: `z-[var(--z-overlay)]`.
//
// This guard is deliberately narrow. It does not try to enumerate which utilities do and do not
// have a theme namespace — that list belongs to Tailwind and would rot. It checks the one case
// that bit us, in the one place a silent miss costs an invisible layering bug.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOTS = ["packages", "apps"];
const BROKEN = /\bz-\((--[a-z][\w-]*)\)/g;

function walk(dir, out) {
	for (const entry of readdirSync(dir)) {
		if (entry === "node_modules" || entry === ".next" || entry === "dist") continue;
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) walk(full, out);
		else if (/\.(tsx?|css)$/.test(full)) out.push(full);
	}
}

const files = [];
for (const r of ROOTS) {
	try {
		walk(r, files);
	} catch (err) {
		console.error(`check-z-utility-syntax: cannot walk ${r}/ — ${err.message}`);
		console.error("Run this from the repo root. The guard cannot see the code it exists to check.");
		process.exit(1);
	}
}

// Finding no source at all means the roots moved, not that the tree is clean.
if (files.length === 0) {
	console.error(`check-z-utility-syntax: found no .tsx/.css under ${ROOTS.join(", ")}/.`);
	console.error("That is not a clean tree — it means this guard is looking at the wrong thing.");
	process.exit(1);
}

const violations = [];
let scanned = 0;
for (const f of files) {
	const src = readFileSync(f, "utf8");
	scanned++;
	for (const m of src.matchAll(BROKEN)) {
		const line = src.slice(0, m.index).split("\n").length;
		violations.push({ where: `${relative(".", f)}:${line}`, found: m[0], fix: `z-[var(${m[1]})]` });
	}
}

if (violations.length > 0) {
	console.error("Tailwind's `z-(--var)` shorthand generates NOTHING — these elements have no z-index:");
	for (const v of violations) console.error(`  ${v.where}  ${v.found}  ->  ${v.fix}`);
	console.error("");
	console.error("z-index has no theme namespace in Tailwind v4, so the `(--var)` shorthand does not");
	console.error("apply to it and fails silently. Use the explicit arbitrary value instead.");
	process.exit(1);
}

console.log(`OK — ${scanned} file(s) scanned; no z-index utility uses the silently-empty (--var) shorthand.`);
