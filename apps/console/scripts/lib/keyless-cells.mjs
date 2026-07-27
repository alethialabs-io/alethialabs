// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// One reader for `var keylessCells` (packages/core/manifests/keyless.go), shared by the three tools
// that need it:
//
//   · check-keyless-cells.mjs — adjudicates each cell against the legs that implement it.
//   · gen-keyless-cells.mjs   — emits the TypeScript mirror the canvas and the deploy gate read.
//   · check-offer-parity.mjs  — reads the gate so gating `iam_auth` cannot delete the offer from the
//                               parity guard's vocabulary (#1510).
//
// It lives here because three consumers hand-rolling the same Go-text parse is three ways for the
// same file to be misread. The parse is already CI-load-bearing, so sharing it adds no failure mode
// that was not already present — it removes two.

import { readFileSync } from "node:fs";

/** Blank BRACES inside Go string literals, and nothing else.
 *
 * Load-bearing for the brace matcher: a stray brace inside a literal would end a body early and the
 * caller would read a truncated table. Blanking the whole literal is the obvious version and it is
 * wrong — the provider switch is matched ON string literals (`case "aws":`). */
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

/** The body of a top-level Go func, brace-matched. "" when the func is absent — an absent renderer is
 * a missing leg, which is the honest reading. */
export function funcBody(src, name) {
	const start = src.indexOf(`func ${name}(`);
	if (start === -1) return "";
	return bracedBodyAt(src, start);
}

/** The `{ … }` block starting at or after `from`, brace-matched, without its outer braces. */
function bracedBodyAt(src, from) {
	const open = src.indexOf("{", from);
	if (open === -1) return "";
	let depth = 0;
	for (let i = open; i < src.length; i++) {
		if (src[i] === "{") depth++;
		else if (src[i] === "}" && --depth === 0) return src.slice(open + 1, i);
	}
	return "";
}

/** `providerAWS` → "aws", `engineMySQL` → "mysql". The table keys are Go constants aliasing the cloud
 * enum, so the lowercased suffix is the same token the switch labels use. */
export const tokenOf = (ident) => ident.replace(/^(provider|engine)/, "").toLowerCase();

/** Every `name = "value"` string constant in the file, so a cell's `reason:` can name one.
 *
 * The exclusion prose is extracted to constants in keyless.go because each string is used more than
 * once, so a reader that only understood inline literals would report every excluded cell as having
 * no reason — and the generator would then emit empty UI copy. */
function stringConstants(src) {
	const out = new Map();
	for (const m of src.matchAll(/(\w+)\s*=\s*"((?:[^"\\]|\\.)*)"/g)) {
		out.set(m[1], JSON.parse(`"${m[2]}"`));
	}
	return out;
}

/**
 * Parse the keylessCells table.
 *
 * @returns {{cells: {cloud: string, engine: string, state: "live"|"pending"|"excluded", reason: string}[]}}
 */
export function parseKeylessCells(goSrc) {
	// Constants are read from the RAW source: brace-neutralization would not touch them, but comment
	// stripping runs on a copy anyway and the values are what we want verbatim.
	const consts = stringConstants(goSrc);
	const src = stripComments(neutralizeBracesInStrings(goSrc));

	const tableStart = src.indexOf("var keylessCells =");
	if (tableStart === -1) {
		throw new Error(
			"no `var keylessCells =` in packages/core/manifests/keyless.go — the guard reads that table " +
				"by name; if it moved or was renamed, update CELLS_SRC in the caller.",
		);
	}
	const tableBody = bracedBodyAt(src, tableStart);

	const cells = [];
	for (const m of tableBody.matchAll(/(provider[A-Za-z]+):\s*\{([\s\S]*?)\n\t\}/g)) {
		const cloud = tokenOf(m[1]);
		for (const e of m[2].matchAll(/(engine[A-Za-z]+):\s*\{([^}]*)\}/g)) {
			cells.push({ cloud, engine: tokenOf(e[1]), ...cellFields(e[2], consts) });
		}
	}
	if (cells.length === 0) {
		throw new Error("parsed the keylessCells table but found no cells in it.");
	}
	return { cells };
}

/** `state: cellExcluded, reason: alibabaKeylessExclusion` → `{state, reason}`.
 *
 * A cell with no `state:` is a parse failure, not a default: silently reading an unrecognised cell as
 * live is how a fail-closed table stops failing closed. */
function cellFields(body, consts) {
	const state = body.match(/state:\s*cell(\w+)/)?.[1]?.toLowerCase();
	if (!state || !["live", "pending", "excluded"].includes(state)) {
		throw new Error(`a keylessCells entry has no recognisable state: ${body.trim()}`);
	}
	const raw = body.match(/reason:\s*(?:"((?:[^"\\]|\\.)*)"|(\w+))/);
	const reason = raw ? (raw[1] !== undefined ? JSON.parse(`"${raw[1]}"`) : (consts.get(raw[2]) ?? "")) : "";
	return { state, reason };
}

/** Read + parse the table straight off disk. */
export function readKeylessCells(path) {
	return parseKeylessCells(readFileSync(path, "utf8"));
}
