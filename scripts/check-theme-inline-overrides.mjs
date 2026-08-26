#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Catches a theme variable that is declared `@theme inline` and then overridden later —
 * typically inside a `@media` block. That pair does not do what it looks like it does.
 *
 * Tailwind's `inline` option makes a utility use the variable's VALUE rather than a
 * `var()` reference:
 *
 *     @theme inline { --text-display-lg: 56px; }   ->   .text-display-lg { font-size: 56px }
 *
 * Overriding `--text-display-lg` on `:root` afterwards therefore changes nothing that
 * any utility reads. It compiles, it lints, it looks like a responsive type ladder, and
 * it is dead. That is exactly how the marketing hero shipped at 56px on a 375px phone
 * while three `@media` blocks sat directly beneath the declaration claiming otherwise.
 *
 * There is no error and no warning for this anywhere in the toolchain — the only signal
 * is someone opening the site on a phone — so it gets a guard.
 *
 * Drop `inline` from the block to fix it. `inline` is only actually needed when a theme
 * value is itself a `var()` reference (`--font-sans: var(--font-geist-sans)`), which is
 * the indirection the option exists for; a literal length never needs it.
 */

import { readFileSync } from "node:fs";
import { globSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const ROOT = path.resolve(import.meta.dirname, "..");

/** Every CSS file that can declare theme variables. */
function sheets() {
	return globSync("{packages,apps}/*/**/*.css", {
		cwd: ROOT,
		exclude: (p) => p.includes("node_modules") || p.includes(".next"),
	});
}

/**
 * The variable names declared inside `@theme inline { … }` blocks.
 * Brace-counts rather than regex-matching the block, so a nested rule cannot end it early.
 */
function inlineThemeVars(css) {
	const names = new Set();
	const re = /@theme\s+inline\s*\{/g;
	let m;
	while ((m = re.exec(css)) !== null) {
		let depth = 1;
		let i = re.lastIndex;
		const start = i;
		while (i < css.length && depth > 0) {
			if (css[i] === "{") depth++;
			else if (css[i] === "}") depth--;
			i++;
		}
		for (const d of css.slice(start, i - 1).matchAll(/(--[A-Za-z0-9_-]+)\s*:/g)) {
			names.add(d[1]);
		}
	}
	return names;
}

/**
 * Variables assigned anywhere OUTSIDE an `@theme` block — i.e. the overrides. Everything
 * inside any `@theme`/`@theme inline` block is blanked first so a declaration is never
 * mistaken for an override of itself.
 */
function overriddenVars(css) {
	let masked = css;
	const re = /@theme(\s+inline)?\s*\{/g;
	let m;
	const spans = [];
	while ((m = re.exec(masked)) !== null) {
		let depth = 1;
		let i = re.lastIndex;
		const start = m.index;
		while (i < masked.length && depth > 0) {
			if (masked[i] === "{") depth++;
			else if (masked[i] === "}") depth--;
			i++;
		}
		spans.push([start, i]);
	}
	// Blank the theme blocks, preserving offsets so reported line numbers stay true.
	for (const [a, b] of spans) {
		masked = masked.slice(0, a) + " ".repeat(b - a) + masked.slice(b);
	}

	const hits = new Map();
	for (const d of masked.matchAll(/(--[A-Za-z0-9_-]+)\s*:/g)) {
		const name = d[1];
		const line = masked.slice(0, d.index).split("\n").length;
		if (!hits.has(name)) hits.set(name, []);
		hits.get(name).push(line);
	}
	return hits;
}

let bad = 0;
let scanned = 0;

for (const rel of sheets()) {
	const css = readFileSync(path.join(ROOT, rel), "utf8");
	if (!css.includes("@theme")) continue;
	scanned++;

	const declared = inlineThemeVars(css);
	if (declared.size === 0) continue;
	const overrides = overriddenVars(css);

	for (const name of declared) {
		const lines = overrides.get(name);
		if (!lines) continue;
		bad++;
		console.error(
			`✗ ${rel}: \`${name}\` is declared in an \`@theme inline\` block and reassigned ` +
				`at line${lines.length > 1 ? "s" : ""} ${lines.join(", ")}.\n` +
				`  With \`inline\`, utilities compile to the literal value, so that reassignment ` +
				`is read by nothing.\n` +
				`  Drop \`inline\` from the block declaring \`${name}\`, or delete the dead override.`,
		);
	}
}

// A guard that cannot tell "found nothing" from "looked at nothing" is not a guard.
if (scanned === 0) {
	console.error(
		"✗ check-theme-inline-overrides: found no stylesheet containing `@theme` at all.\n" +
			"  That is not a pass — the glob or the layout changed. Fix this check.",
	);
	process.exit(1);
}

if (bad > 0) {
	console.error(`\n${bad} inert theme override(s) across ${scanned} stylesheet(s).`);
	process.exit(1);
}

console.log(
	`✓ check-theme-inline-overrides: ${scanned} stylesheet(s) — no @theme inline variable is overridden.`,
);
