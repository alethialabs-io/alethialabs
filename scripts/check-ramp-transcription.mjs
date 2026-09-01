// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Ramp transcription guard — `ramp-srgb.ts` must still be a TRANSCRIPTION of `tokens.css`,
// not a fourth opinion about what the brand grays are.
//
// Why this exists: `packages/brand/src/ramp-srgb.ts` is a hand-maintained sRGB copy of the
// OKLCH ramp in `packages/brand/src/tokens.css`, kept for the three surfaces that provably
// cannot read a custom property — email, Stripe Elements across an iframe, and `next/og`.
// Its own header records what happened before it existed: the console's Stripe theme used
// `#0a0a0a` and `#171717`, the brand icons used `#1A1A1A`, "none of which are ramp values at
// all." It fixed three transcriptions by becoming a fourth — and nothing checks it.
//
// That matters more now than it did. The CLI's lipgloss ink ramp is generated FROM this file,
// so an undetected drift here propagates to the terminal, and the CLI becomes a mirror of a
// copy — one hop from truth, which is the shape CLAUDE.md's "one deriver, every consumer" rule
// exists to prevent. A guard on the copy is what makes generating from it legitimate.
//
// The check is arithmetic, not a comparison against a checked-in table, because a table would
// be a FIFTH copy. Every line of `ramp-srgb.ts` carries its source as a comment
// (`gray500: "#939393", // oklch(0.664 0 0)`) precisely so this is computable:
//
//   chroma 0  =>  Oklab a = b = 0  =>  LMS = L³  =>  linear sRGB = L³  (the matrix rows sum to 1)
//   sRGB transfer:  c <= 0.0031308 ? 12.92c : 1.055·c^(1/2.4) − 0.055
//   byte = round(255 · s)
//
// FOUR RULES:
//   1. every hex in ramp-srgb.ts is what its OWN `// oklch(...)` comment computes to
//      (catches a hex hand-edited without the comment, and vice versa)
//   2. every `// oklch(...)` comment matches tokens.css's L for the same ramp step
//      (catches tokens.css being restyled while the transcription sits still)
//   3. the two files describe the SAME SET of steps — no key in one and not the other
//   4. every ramp colour is genuinely neutral (chroma 0). The L³ shortcut above is only
//      valid for a gray; a chromatic ramp entry must REFUSE rather than be computed wrongly.
//
// Usage:  node scripts/check-ramp-transcription.mjs [--self-test]
// Wired into CI's `Authz / open-core guards` job.

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const TOKENS = "packages/brand/src/tokens.css";
const TRANSCRIPTION = "packages/brand/src/ramp-srgb.ts";

// A census floor, in the idiom `check-shared-surface.mjs` already uses. Without it, a regex
// that stops matching — a reformat, a rename, a file moved — reports "0 entries, 0 problems"
// and passes. "Nothing found" and "nothing wrong" must not share an exit code.
const MIN_STEPS = 17;

/**
 * The sRGB transfer function (IEC 61966-2-1), linear light in, display-encoded out.
 *
 * @param {number} c linear channel value in [0, 1]
 * @returns {number} display-encoded value in [0, 1]
 */
function encodeSRGB(c) {
	return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

/**
 * The byte an `oklch(L 0 0)` grey renders to in sRGB.
 *
 * Only valid at chroma 0 — see rule 4. With a = b = 0 the Oklab→LMS step is the identity, so
 * LMS = L³ and the linear sRGB channels are all L³, because each row of the LMS→sRGB matrix
 * sums to 1 for a neutral.
 *
 * @param {number} L OKLCH lightness in [0, 1]
 * @returns {number} the 0–255 channel byte, equal on all three channels
 */
function greyByte(L) {
	const linear = L * L * L;
	const encoded = encodeSRGB(Math.min(1, Math.max(0, linear)));
	return Math.round(255 * Math.min(1, Math.max(0, encoded)));
}

/**
 * Render an `oklch(L 0 0)` grey as the `#rrggbb` string the transcription should hold.
 *
 * @param {number} L OKLCH lightness in [0, 1]
 * @returns {string} lowercase six-digit hex, `#` included
 */
function greyHex(L) {
	const b = greyByte(L).toString(16).padStart(2, "0");
	return `#${b}${b}${b}`;
}

/** Normalise a ramp step name so `--gray-500` and `gray500` compare equal. */
function normaliseKey(raw) {
	return raw.replace(/^--/, "").replace(/-/g, "").toLowerCase();
}

/**
 * Parse the OKLCH ramp declarations out of tokens.css.
 *
 * Narrow by SHAPE, not by name: a literal alpha-free `oklch(L C H)` value. A `var(...)`
 * indirection or an alpha-bearing `oklch(1 0 0 / 0.10)` is the semantic layer, which is not what
 * this guard is about.
 *
 * @param {string} src the file contents
 * @returns {Map<string, {L: number, chroma: number, hue: number, line: number}>}
 */
function parseTokens(src) {
	const out = new Map();
	src.split("\n").forEach((text, i) => {
		// ANY custom property, not a `gray-*|black` allowlist. Symmetry with parseTranscription
		// matters: with a closed matcher here, a `--slate-500` added to the ramp block would be
		// invisible to the census and rule 3's "exists in tokens.css but missing from the
		// transcription" branch could never fire for it.
		//
		// What keeps this from swallowing the semantic layer is the SHAPE, not a name list: the
		// pattern requires `oklch(L C H)` and nothing else before the `)`, so all 12 non-ramp
		// oklch tokens — every one of which carries an alpha (`oklch(1 0 0 / 0.10)`) — fail to
		// match. Verified against tokens.css: the 17 alpha-free declarations are exactly the ramp.
		// A CHROMATIC step added here still matches and is then refused by rule 4, so it is seen
		// rather than skipped.
		const m = /^\s*(--[a-z0-9-]+)\s*:\s*oklch\(\s*([0-9.]+)\s+([0-9.]+)\s+([0-9.]+)\s*\)/.exec(text);
		if (!m) return;
		out.set(normaliseKey(m[1]), {
			L: Number(m[2]),
			chroma: Number(m[3]),
			hue: Number(m[4]),
			line: i + 1,
		});
	});
	return out;
}

/**
 * Parse the transcription's entries — the hex it claims, and the OKLCH it claims to be
 * transcribing. Both halves are required: an entry with no `// oklch(...)` comment is a
 * FAILURE, not a skip, because the comment is the only thing that makes the hex checkable
 * and dropping it is exactly how this guard would be silently defeated.
 *
 * @param {string} src the file contents
 * @returns {{entries: Map<string, {hex: string, L: number, chroma: number, hue: number, line: number}>, uncommented: {key: string, line: number}[]}}
 */
function parseTranscription(src) {
	const entries = new Map();
	const uncommented = [];
	src.split("\n").forEach((text, i) => {
		// ANY identifier, not just `gray*`/`black`. Matching only the names we expect would make
		// rule 3's "a value from nowhere" branch dead code for the exact case it exists to catch:
		// a `slate500: "#1a1a1a"` added to RAMP would be invisible to the matcher, the census
		// would still read 17, and the guard would print OK over the fourth transcription this
		// file was written to end. A matcher that only sees what it already approves of is not a
		// census.
		const decl = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*"(#[0-9a-fA-F]{6})"\s*,/.exec(text);
		if (!decl) return;
		const line = i + 1;
		const note = /\/\/\s*oklch\(\s*([0-9.]+)\s+([0-9.]+)\s+([0-9.]+)\s*\)/.exec(text);
		if (!note) {
			uncommented.push({ key: decl[1], line });
			return;
		}
		entries.set(normaliseKey(decl[1]), {
			hex: decl[2].toLowerCase(),
			L: Number(note[1]),
			chroma: Number(note[2]),
			hue: Number(note[3]),
			line,
		});
	});
	return { entries, uncommented };
}

/**
 * Apply the four rules to an already-parsed pair.
 *
 * Separated from I/O so `--self-test` can drive it with fixtures and prove the guard FAILS
 * when it should. A guard whose failure branch has never run is a guard nobody has tested.
 *
 * @returns {string[]} one problem per entry; empty means clean
 */
function compare(tokens, parsed) {
	const problems = [];

	for (const { key, line } of parsed.uncommented) {
		problems.push(
			`${TRANSCRIPTION}:${line}: \`${key}\` has no \`// oklch(...)\` comment — the comment is what ` +
				`makes the hex checkable; without it this guard cannot verify the value`,
		);
	}

	// Rule 4 stops the run, because every later rule's arithmetic assumes a neutral and would
	// otherwise report a confident wrong byte. It is collected SEPARATELY from `problems` on
	// purpose: an uncommented entry (above) blocks only its own line, so short-circuiting the
	// whole comparison on it would hide every other drift in the file behind one missing
	// comment — a guard reporting less the more wrong the file gets.
	const notNeutral = [];
	for (const [key, v] of parsed.entries) {
		if (v.chroma !== 0) {
			notNeutral.push(
				`${TRANSCRIPTION}:${v.line}: \`${key}\` is oklch(${v.L} ${v.chroma} ${v.hue}) — chroma is not 0, ` +
					`so the L³ neutral shortcut this guard uses is invalid. A chromatic ramp entry needs a real ` +
					`Oklab→sRGB conversion; refusing rather than computing a wrong byte.`,
			);
		}
	}
	for (const [key, v] of tokens) {
		if (v.chroma !== 0) {
			notNeutral.push(`${TOKENS}:${v.line}: \`${key}\` is not neutral (chroma ${v.chroma}) — see above`);
		}
	}
	if (notNeutral.length > 0) return [...problems, ...notNeutral];

	// Rule 1 — the hex is what its own comment computes to.
	for (const [key, v] of parsed.entries) {
		const want = greyHex(v.L);
		if (v.hex !== want) {
			problems.push(
				`${TRANSCRIPTION}:${v.line}: \`${key}\` is ${v.hex} but oklch(${v.L} 0 0) computes to ${want} — ` +
					`the hex and its own comment disagree`,
			);
		}
	}

	// Rule 2 — the comment matches tokens.css.
	for (const [key, v] of parsed.entries) {
		const src = tokens.get(key);
		if (!src) continue; // rule 3 reports this
		if (src.L !== v.L) {
			problems.push(
				`${TRANSCRIPTION}:${v.line}: \`${key}\` transcribes oklch(${v.L} 0 0) but ${TOKENS}:${src.line} ` +
					`now says oklch(${src.L} 0 0) — tokens.css moved and the transcription did not. ` +
					`The value should be ${greyHex(src.L)}.`,
			);
		}
	}

	// Rule 3 — same set of steps, both directions.
	//
	// An entry that lost its `// oklch(...)` comment is NOT missing: it is present and
	// unverifiable, and it was already reported as exactly that above. Reporting it a second time
	// as "missing from the transcription" would be a false statement about the file, and it is the
	// kind a reader trusts because it came from a guard.
	const uncommentedKeys = new Set(parsed.uncommented.map((u) => normaliseKey(u.key)));
	for (const key of tokens.keys()) {
		if (!parsed.entries.has(key) && !uncommentedKeys.has(key)) {
			problems.push(`${TRANSCRIPTION}: \`${key}\` exists in ${TOKENS} but is missing from the transcription`);
		}
	}
	for (const key of parsed.entries.keys()) {
		if (!tokens.has(key)) {
			problems.push(
				`${TRANSCRIPTION}: \`${key}\` is not a ramp step in ${TOKENS} — it is a value from nowhere, ` +
					`which is precisely what this file was created to end`,
			);
		}
	}

	return problems;
}

/**
 * Prove the guard can fail. Every rule gets a case that MUST be caught and a clean control
 * that must not be — a guard tested in one direction only is one that reports green.
 */
function selfTest() {
	const cleanTokens = "  --gray-500:  oklch(0.664 0 0);\n  --black:     oklch(0.09 0 0);\n";
	const cleanSrc = '\tgray500: "#939393", // oklch(0.664 0 0)\n\tblack: "#020202", // oklch(0.09 0 0)\n';

	const cases = [
		["clean pair passes", cleanTokens, cleanSrc, 0],
		[
			"rule 1 — hex edited, comment left alone",
			cleanTokens,
			'\tgray500: "#949494", // oklch(0.664 0 0)\n\tblack: "#020202", // oklch(0.09 0 0)\n',
			1,
		],
		[
			"rule 2 — tokens.css restyled, transcription stale",
			"  --gray-500:  oklch(0.700 0 0);\n  --black:     oklch(0.09 0 0);\n",
			cleanSrc,
			1,
		],
		[
			"rule 3 — step missing from the transcription",
			cleanTokens,
			'\tblack: "#020202", // oklch(0.09 0 0)\n',
			1,
		],
		[
			"rule 3 — step in the transcription that tokens.css does not have",
			"  --black:     oklch(0.09 0 0);\n",
			cleanSrc,
			1,
		],
		[
			// The case the matcher used to be blind to. A colour under a NAME the ramp does not
			// have is the original sin this file records — #0a0a0a, #171717, #1A1A1A, "none of
			// which are ramp values at all". If the matcher only recognises `gray*`, this passes.
			"rule 3 — a colour under a name the ramp does not have is SEEN, not skipped",
			cleanTokens,
			'\tgray500: "#939393", // oklch(0.664 0 0)\n\tblack: "#020202", // oklch(0.09 0 0)\n' +
				'\tslate500: "#1a1a1a", // oklch(0.205 0 0)\n',
			2, // its hex disagrees with its own comment (#171717), AND it is not a ramp step
		],
		[
			"rule 4 — a chromatic entry refuses instead of computing",
			cleanTokens,
			'\tgray500: "#939393", // oklch(0.664 0.11 240)\n\tblack: "#020202", // oklch(0.09 0 0)\n',
			1,
		],
		[
			// Exactly ONE problem: the entry is present but unverifiable. It is NOT also "missing
			// from the transcription" — saying so would be a false statement about the file, and
			// the first cut of this guard made it.
			"the comment cannot simply be dropped to dodge rule 1",
			cleanTokens,
			'\tgray500: "#ff0000",\n\tblack: "#020202", // oklch(0.09 0 0)\n',
			1,
		],
		[
			// The tokens.css side of the same blindness. With a `gray-*|black` allowlist in
			// parseTokens this ramp step is invisible and the guard prints OK.
			"a new ramp step in tokens.css under an unexpected NAME is seen",
			cleanTokens + "  --slate-500: oklch(0.664 0 0);\n",
			cleanSrc,
			1,
		],
		[
			// ...while the semantic layer is still excluded, by SHAPE rather than by name.
			"an alpha-bearing oklch token is not mistaken for a ramp step",
			cleanTokens + "  --overlay: oklch(0 0 0 / 0.45);\n",
			cleanSrc,
			0,
		],
	];

	let failed = 0;
	for (const [name, tokensSrc, transcriptionSrc, wantCount] of cases) {
		const got = compare(parseTokens(tokensSrc), parseTranscription(transcriptionSrc));
		const ok = got.length === wantCount;
		if (!ok) {
			failed++;
			console.error(`  ✗ ${name}: expected ${wantCount} problem(s), got ${got.length}`);
			got.forEach((p) => console.error(`      ${p}`));
		} else {
			console.log(`  ✓ ${name}`);
		}
	}

	// The arithmetic itself, against the values the ramp has carried since it was written.
	// If the transfer function is ever "simplified", this is what notices.
	const known = [
		[1, "#ffffff"],
		[0.985, "#fafafa"],
		[0.664, "#939393"],
		[0.556, "#737373"],
		[0.205, "#171717"],
		[0.09, "#020202"],
	];
	for (const [L, want] of known) {
		if (greyHex(L) !== want) {
			failed++;
			console.error(`  ✗ arithmetic: oklch(${L} 0 0) should be ${want}, got ${greyHex(L)}`);
		}
	}
	if (failed === 0) console.log(`  ✓ arithmetic reproduces ${known.length} known ramp values`);

	if (failed > 0) {
		console.error(`\nFAIL: ${failed} self-test case(s) failed — the guard itself is broken`);
		process.exit(1);
	}
	console.log("\nOK: self-test passed");
}

function main() {
	if (process.argv.includes("--self-test")) {
		selfTest();
		return;
	}

	let tokensSrc;
	let transcriptionSrc;
	try {
		tokensSrc = readFileSync(join(ROOT, TOKENS), "utf8");
		transcriptionSrc = readFileSync(join(ROOT, TRANSCRIPTION), "utf8");
	} catch (err) {
		// An unreadable input RAISES. Treating it as "nothing to check" is how a guard goes
		// green over a file somebody moved.
		console.error(`FAIL: cannot read a ramp source — ${err.message}`);
		process.exit(1);
	}

	const tokens = parseTokens(tokensSrc);
	const parsed = parseTranscription(transcriptionSrc);
	const seen = parsed.entries.size + parsed.uncommented.length;

	// Vacuity, per file and with distinct messages, so the fix is obvious from the failure.
	if (tokens.size === 0) {
		console.error(
			`FAIL: parsed 0 ramp declarations from ${TOKENS}. The file exists, so either the ramp moved ` +
				`or its formatting changed and this guard's matcher no longer sees it. It has NOT been checked.`,
		);
		process.exit(1);
	}
	if (seen === 0) {
		console.error(
			`FAIL: parsed 0 entries from ${TRANSCRIPTION}. The file exists, so its shape changed and this ` +
				`guard's matcher no longer sees it. It has NOT been checked.`,
		);
		process.exit(1);
	}
	if (tokens.size < MIN_STEPS || seen < MIN_STEPS) {
		console.error(
			`FAIL: expected at least ${MIN_STEPS} ramp steps, saw ${tokens.size} in ${TOKENS} and ${seen} in ` +
				`${TRANSCRIPTION}. Steps were removed, or the matcher is seeing only part of the ramp. ` +
				`If the ramp genuinely shrank, lower MIN_STEPS in the same commit and say why.`,
		);
		process.exit(1);
	}

	const problems = compare(tokens, parsed);

	console.log(`ramp transcription: ${tokens.size} steps in tokens.css · ${seen} in the transcription`);
	if (problems.length > 0) {
		console.error(`\nFAIL: ${problems.length} problem(s) — ${TRANSCRIPTION} is no longer a transcription\n`);
		problems.forEach((p) => console.error(`  ${p}`));
		console.error(
			`\n${TOKENS} is the source of truth. Fix the transcription to match it — do not edit the ` +
				`\`// oklch(...)\` comments to match the hex, which would make the two agree about a value ` +
				`the brand does not have.`,
		);
		process.exit(1);
	}
	console.log("OK: every hex reproduces from its own oklch() comment, and every comment matches tokens.css");
}

main();
