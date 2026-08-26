#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Catches a Tailwind arbitrary-property utility that sets a CSS variable which a brand
 * device already declares in an UNLAYERED rule. The utility applies, computes to the
 * device's value, and does nothing.
 *
 *     <div className="vx-clamp [--cl-len:20px]">   // reads 7px, not 20px
 *
 * Tailwind emits arbitrary properties into `@layer utilities`. `.vx-clamp` and friends
 * are declared in packages/brand/src/tokens.css outside any layer, and an unlayered
 * declaration beats a layered one regardless of specificity or source order. So the
 * class is right there in `className`, devtools shows it applied, and the value is the
 * device default.
 *
 * This shipped once: the auth card asked for 20px corner arms and rendered 7px ones all
 * the way through review and into dev, because nothing anywhere disagrees with you.
 *
 * The fix is a modifier next to the device that owns the variable (`.vx-clamp--card`),
 * which is unlayered too and therefore actually wins.
 *
 * Scope is deliberately narrow — only variables the brand sheet declares unlayered. An
 * arbitrary property setting a variable nobody else owns is fine and stays allowed.
 */

import { readFileSync, globSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const ROOT = path.resolve(import.meta.dirname, "..");
const TOKENS = "packages/brand/src/tokens.css";

/** CSS variables tokens.css declares OUTSIDE any `@theme` block — i.e. unlayered. */
function unlayeredVars() {
	const css = readFileSync(path.join(ROOT, TOKENS), "utf8");
	let masked = css;
	const re = /@theme(\s+inline)?\s*\{/g;
	const spans = [];
	let m;
	while ((m = re.exec(masked)) !== null) {
		let depth = 1;
		let i = re.lastIndex;
		while (i < masked.length && depth > 0) {
			if (masked[i] === "{") depth++;
			else if (masked[i] === "}") depth--;
			i++;
		}
		spans.push([m.index, i]);
	}
	for (const [a, b] of spans) {
		masked = masked.slice(0, a) + " ".repeat(b - a) + masked.slice(b);
	}
	return new Set([...masked.matchAll(/(--[A-Za-z0-9_-]+)\s*:/g)].map((d) => d[1]));
}

const owned = unlayeredVars();
if (owned.size === 0) {
	console.error(
		`✗ check-var-utility-shadowing: parsed no unlayered variables out of ${TOKENS}.\n` +
			"  That is not a pass — the file moved or its shape changed. Fix this check.",
	);
	process.exit(1);
}

const sources = globSync("{apps,packages}/*/**/*.{tsx,ts}", {
	cwd: ROOT,
	exclude: (p) => p.includes("node_modules") || p.includes(".next"),
});

let bad = 0;
let scanned = 0;

/**
 * Blanks comments, preserving length so reported line numbers stay true.
 *
 * Not optional: the first version of this check flagged the JSDoc that DOCUMENTS the
 * trap, in the very file that fixes it. A guard that cannot tell code from prose fails
 * the moment anyone explains it, and gets deleted for being noise.
 *
 * `//` is only treated as a line comment when it is not part of `://`, so a URL inside a
 * string does not blank the rest of its line and hide a real hit behind it.
 */
function stripComments(src) {
	// Newlines are KEPT. Blanking a block comment to plain spaces eats its line breaks,
	// and every hit after it is then reported at the wrong line — which sends a reader to
	// unrelated code and is worse than not reporting a line at all.
	const blank = (m) => m.replace(/[^\n]/g, " ");
	let out = src.replace(/\/\*[\s\S]*?\*\//g, blank);
	out = out.replace(/(^|[^:])\/\/[^\n]*/g, (m, pre) => pre + blank(m.slice(pre.length)));
	return out;
}

for (const rel of sources) {
	const raw = readFileSync(path.join(ROOT, rel), "utf8");
	if (!raw.includes("[--")) continue;
	scanned++;
	const src = stripComments(raw);
	for (const hit of src.matchAll(/\[(--[A-Za-z0-9_-]+):[^\]]*\]/g)) {
		const name = hit[1];
		if (!owned.has(name)) continue;
		const line = src.slice(0, hit.index).split("\n").length;
		bad++;
		console.error(
			`✗ ${rel}:${line}: \`${hit[0]}\` sets a variable that ${TOKENS} declares unlayered.\n` +
				"  Tailwind puts arbitrary properties in `@layer utilities`, and unlayered wins — so\n" +
				`  this class applies and computes to the device's own value. Add a modifier beside the\n` +
				`  rule that owns \`${name}\` instead (see \`.vx-clamp--card\`).`,
		);
	}
}

if (bad > 0) {
	console.error(`\n${bad} shadowed variable utility/utilities.`);
	process.exit(1);
}

console.log(
	`✓ check-var-utility-shadowing: ${owned.size} brand variables, ${scanned} candidate file(s) — none shadowed.`,
);
