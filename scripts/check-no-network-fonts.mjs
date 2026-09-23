#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
//
// Guard (#4986): no app or package may load a font through Next's Google Fonts loader.
//
// That loader downloads the font files from fonts.gstatic.com AT BUILD TIME, and when the request
// fails Turbopack fails the whole `next build`. Two unrelated PRs went red on it in one day and one
// green PR was dequeued. The fix is the vendored faces in packages/brand/src/fonts, loaded with
// next/font/local through `@repo/brand/fonts`. This guard keeps the network loader from coming back.
//
// WHAT IT MATCHES: the module specifier as a QUOTED string literal ("…" or '…'), for both the current
// `next/font/google` and the legacy `@next/font/google` package. That covers `import … from`,
// `export … from`, `require(…)` and `import(…)`. A mention in prose (a comment in backticks, a
// Markdown page) is not a load, so it is deliberately NOT matched.
// WHAT IT DOES NOT MATCH, stated so nobody reads it as more: a specifier assembled at runtime or
// written in a template literal. Neither is something the next/font compiler accepts, so neither
// can load a font.
// SCOPE: every git-tracked (or untracked, not ignored) .ts/.tsx/.js/.jsx/.mjs/.cjs file under
// apps/ and packages/.
//
// Usage: node scripts/check-no-network-fonts.mjs [--self-test]

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

const SPECIFIER_RE = /["'](?:@next|next)\/font\/google["']/;
const SOURCE_RE = /\.(?:[cm]?js|jsx|tsx?)$/;

/**
 * Return the 1-based line numbers in `text` that load a font through the Google Fonts loader.
 *
 * @param {string} text
 * @returns {number[]}
 */
export function findNetworkFontLoads(text) {
	const hits = [];
	text.split("\n").forEach((line, i) => {
		if (SPECIFIER_RE.test(line)) hits.push(i + 1);
	});
	return hits;
}

/**
 * List the source files under apps/ and packages/ that git knows about (tracked, or untracked and
 * not ignored — so node_modules and build output are never read).
 *
 * @returns {string[]}
 */
function sourceFiles() {
	return execSync("git ls-files --cached --others --exclude-standard -- apps packages", {
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
	})
		.split("\n")
		.filter((f) => f && SOURCE_RE.test(f));
}

/**
 * Exercise the matcher on both sides, so a matcher that never fires cannot pass.
 *
 * @returns {boolean} true when every assertion held
 */
function selfTest() {
	const cases = [
		['import { Geist } from "next/font/google";', true],
		["import { Geist } from 'next/font/google';", true],
		['import { Inter } from "@next/font/google";', true],
		['export { Geist } from "next/font/google";', true],
		['const f = require("next/font/google");', true],
		["const f = await import('next/font/google');", true],
		['import localFont from "next/font/local";', false],
		["// the next/font Google loader fetched at build time", false],
		["// replaces `next/font/google` (#4986)", false],
	];
	let ok = true;
	for (const [src, want] of cases) {
		const got = findNetworkFontLoads(src).length > 0;
		const pass = got === want;
		ok &&= pass;
		console.log(`${pass ? "ok  " : "FAIL"} - ${want ? "flags" : "ignores"}: ${src}`);
	}
	const multi = findNetworkFontLoads('a\nb\nimport { Geist } from "next/font/google";\n');
	const lineOk = multi.length === 1 && multi[0] === 3;
	ok &&= lineOk;
	console.log(`${lineOk ? "ok  " : "FAIL"} - reports the line the load is on`);
	console.log(ok ? "\nself-test: all passed" : "\nself-test: FAILED");
	return ok;
}

/** Scan the tree and exit non-zero on any Google Fonts loader import. */
function main() {
	if (process.argv.includes("--self-test")) process.exit(selfTest() ? 0 : 1);
	const files = sourceFiles();
	const offenders = [];
	for (const file of files) {
		let text;
		try {
			text = readFileSync(file, "utf8");
		} catch {
			continue; // deleted in the working tree but still in the index
		}
		for (const line of findNetworkFontLoads(text)) offenders.push(`${file}:${line}`);
	}
	if (offenders.length > 0) {
		console.error(`✗ ${offenders.length} import(s) of the Google Fonts loader, which downloads fonts at build time (#4986):`);
		for (const o of offenders) console.error(`   ${o}`);
		console.error('\nUse the vendored faces instead:  import { brandFontVariables } from "@repo/brand/fonts";');
		process.exit(1);
	}
	console.log(`✓ check-no-network-fonts: ${files.length} source file(s) under apps/ and packages/, none loads a font from the network.`);
}

main();
