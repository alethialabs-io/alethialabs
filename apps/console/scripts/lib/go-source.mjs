// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Reading Go source as TEXT, for the generators that mirror a Go decision into TypeScript.
//
// Alethia has a recurring shape: a capability is decided in Go by the code that implements it, and
// the console has to know the answer before it renders a control. Hand-mirroring the answer detects
// drift at best; generating it makes drift impossible (#1510). Each such generator needs the same
// three primitives to read Go safely, so they live here rather than being hand-rolled per consumer —
// three copies of a brace matcher is three ways for the same file to be misread.
//
// Consumers today:
//   · lib/keyless-cells.mjs        — `var keylessCells` (packages/core/manifests/keyless.go)
//   · lib/secrets-runtime-read.mjs — `register("secrets", …)` (packages/core/categories/secrets_*.go)
//
// This is a TEXT parse, not a Go parse, and that boundary is deliberate: the alternative is a Go
// program emitting JSON, which puts a compile step between a one-line source edit and the guard that
// is supposed to catch it. The safety comes from failing LOUDLY on anything unrecognised — never from
// defaulting — so a source shape these primitives cannot read stops the generator instead of silently
// producing a table that reads as permissive.

/** Blank BRACES inside Go string literals, and nothing else.
 *
 * Load-bearing for the brace matcher: a stray brace inside a literal would end a body early and the
 * caller would read a truncated table. Blanking the whole literal is the obvious version and it is
 * wrong — callers match ON string literals (`case "aws":`, `register("secrets", "vault"`). */
export function neutralizeBracesInStrings(src) {
	const scrub = (m) => m.replace(/[{}]/g, " ");
	return src.replace(/`[^`]*`/g, scrub).replace(/"(?:[^"\\\n]|\\.)*"/g, scrub);
}

/** Strip `//` line comments, so a leg only DESCRIBED in a doc comment never counts as implemented. */
export function stripComments(src) {
	return src
		.split("\n")
		.map((l) => l.replace(/(^|\s)\/\/.*$/, ""))
		.join("\n");
}

/** The `{ … }` block starting at or after `from`, brace-matched, without its outer braces.
 *
 * Brace-matched rather than regex-delimited because these bodies nest (a `behavior{}` literal holds
 * func literals holding composite literals). A non-greedy regex would stop at the first inner `}` and
 * report the outer declaration as not containing what it plainly contains. */
export function bracedBodyAt(src, from) {
	const open = src.indexOf("{", from);
	if (open === -1) return "";
	let depth = 0;
	for (let i = open; i < src.length; i++) {
		if (src[i] === "{") depth++;
		else if (src[i] === "}" && --depth === 0) return src.slice(open + 1, i);
	}
	return "";
}

/** The body of a top-level Go func, brace-matched. "" when the func is absent — an absent renderer is
 * a missing leg, which is the honest reading. */
export function funcBody(src, name) {
	const start = src.indexOf(`func ${name}(`);
	if (start === -1) return "";
	return bracedBodyAt(src, start);
}
