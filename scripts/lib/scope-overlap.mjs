#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The scope-glob matcher — ONE predicate for the board's anti-tangle invariant.
//
// .claude/COORDINATION.md states the invariant as: "No two open+claimable issues in a wave may
// share a scope glob — that is how the mega-commit tangle is prevented." Three call sites need to
// decide that question, and until #4115 they answered it three different ways:
//
//   · scripts/decompose-validate.mjs — the real matcher (normalize + segment walk, `**` as
//     zero-or-more, prefix subsumption, wildcard siblings), applied ONCE at seed time to a
//     proposal. Every function was module-private, so nothing else could call it.
//   · scripts/board-dashboard.mjs — a second, weaker copy: `startsWith` with no separator, so
//     `apps/console/lib` "overlapped" `apps/console/library`, and no intra-path wildcard support
//     at all, so `infra/templates/*/aws/**` matched nothing it should have.
//   · scripts/coordinate.sh — NOTHING. COORDINATION.md said its report flagged "two claimed
//     issues sharing `mutex:migration` or an overlapping `scope:`". The second half had never
//     been written, and the absence of a warning line read as an all-clear.
//
// scripts/lib/board-pr.sh's header names the hazard this file exists to close: one protocol
// duplicated across call sites, drifting silently into a false ALLOW. So the predicate lives here
// once and the three callers import or shell out to it.
//
// ── THREE OUTCOMES, NEVER TWO ────────────────────────────────────────────────────────────────
// A scope check has a third state that a collision/no-collision report cannot express: the unit
// whose scope could not be READ. A board unit with no `scope:` line, one whose declaration is
// wrapped in backticks (board #4089, live at the time of writing), one whose globs are prose —
// none of those can be compared with anything, and printing nothing for them is the same defect
// one level down. So `auditBoard` reports four verdicts and `formatAudit` always emits a line:
//
//   CLEAN            every claimable unit's scope was read; no two overlap        (exit 0)
//   COLLISIONS       at least one overlapping pair, named with the globs          (exit 3)
//   NOT-CHECKED      nothing was comparable — no claimable units, or not one      (exit 4)
//                    of them declares a readable `scope:`
//   CLEAN-WITH-GAPS  what could be read does not overlap, but N units could not   (exit 5)
//                    be read — a partial pass, reported as a partial pass
//
// ── THE GAP THAT USED TO BE HERE IS CLOSED (#4473) ───────────────────────────────────────────
// This paragraph recorded that the declaration regex did not strip fenced code blocks, and argued
// the failure direction was tolerable — "over-reporting a phantom glob, which is visible in the
// report and fails closed". That argument held for a body with a stray extra glob. It did NOT hold
// for a body quoting a whole `scope:` line ABOVE its own, because the regex was `m` but not `g` and
// took only the FIRST match: the phantom REPLACED the declaration, so the unit's real files were
// compared against nothing. #4442's body did exactly that, and the phantom collision it produced
// masked a real one underneath.
// Both halves are now fixed here, in one place, because `decompose-validate.mjs` IMPORTS these
// functions rather than carrying copies — the "moving BOTH parsers together" this paragraph warned
// about had already been done by the extraction. `blocked_by_from_body` in coordinate.sh remains a
// separate implementation of fence-stripping for a different line; #4480 tracks that convergence.
//
// Usage:
//   gh issue list --state open --limit 300 --json number,title,labels,body \
//     | node scripts/lib/scope-overlap.mjs --report      # human report  (coordinate.sh's caller)
//   … | node scripts/lib/scope-overlap.mjs --json        # the audit model
//   node scripts/lib/scope-overlap.mjs --self-test       # fixtures + mutation controls, no I/O
//
//   echo '{"board":[…],"merged":[…],"closingKeywords":[…],"debt":{…}}' \
//     | node scripts/lib/scope-overlap.mjs --shipped-report   # the possibly-shipped advisory
//   … | node scripts/lib/scope-overlap.mjs --shipped-json     # its model

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// ── the predicate (lifted verbatim from decompose-validate.mjs) ───────────────────────────────

/** Normalize a scope glob: trim, drop a leading `./`, collapse `//`, drop a trailing `/`. */
export function normalizeGlob(glob) {
	return String(glob)
		.trim()
		.replace(/^\.\//, "")
		.replace(/\/{2,}/g, "/")
		.replace(/\/+$/, "");
}

/**
 * Strip CLOSED fenced code blocks from an issue body, so a quoted machine-read line is not read as a
 * declaration (#4473).
 *
 * This is `coordinate.sh`'s `blocked_by_from_body` awk in JS, including its two judgement calls,
 * because the two machine-read lines in one body must be parsed to one standard:
 *
 *   · An UNTERMINATED fence keeps its contents. A body whose author opened a fence and never closed
 *     it is far more likely to be a typo than an intention to hide a declaration, and dropping
 *     everything after it would silently un-declare a unit's scope — the failure direction that bit
 *     #3639.
 *   · Both ``` and ~~~ open a fence, and a fence closes on either marker. Markdown is stricter than
 *     that; being looser here only ever strips MORE, and a stripped declaration is loud (the unit
 *     appears unscoped) while an unstripped quote is silent.
 *
 * @param {string} text
 * @returns {string} the body with closed fenced blocks removed, line count NOT preserved
 */
export function stripFences(text) {
	const lines = String(text ?? "").split("\n");
	const drop = new Set();
	let openAt = null;
	for (let i = 0; i < lines.length; i++) {
		if (!/^\s*(```|~~~)/.test(lines[i])) continue;
		if (openAt === null) {
			openAt = i;
		} else {
			for (let k = openAt; k <= i; k++) drop.add(k);
			openAt = null;
		}
	}
	return lines.filter((_, i) => !drop.has(i)).join("\n");
}

/**
 * Every `scope:` DECLARATION in a body, after fenced blocks are stripped — normally one.
 *
 * Exported so a caller can tell "no declaration" from "two declarations", which `scopeGlobs` cannot:
 * it answers with globs, and both cases have none to give.
 *
 * @param {string} body
 * @returns {string[][]} one token list per declaration, in document order
 */
export function scopeDeclarations(body) {
	const out = [];
	for (const line of stripFences(body).split("\n")) {
		const m = line.match(/^[ \t]*scope:[ \t]*(.+)$/i);
		if (m) out.push(m[1].trim().split(/\s+/).filter(Boolean));
	}
	return out;
}

/**
 * Parse a machine-readable scope declaration from a board issue body.
 *
 * THE ANCHOR IS THE CONTRACT. `scope:` is a machine-read line that must start at column 0 (a
 * leading indent is tolerated); a `scope:` token inside prose is not a declaration, for the same
 * reason a prose `blocked-by:` is not one. Callers that need to know an unreadable declaration
 * from an absent one want `readScope` instead — this returns `[]` for all of them.
 *
 * TWO DECLARATIONS YIELD NOTHING, and that is the fix rather than an omission (#4473). The regex was
 * `m` but not `g`, so it silently took the FIRST match — and a body that quotes another unit's scope
 * line ABOVE its own therefore had its own declaration ignored entirely. That is exactly what #4442's
 * body did: `coordinate.sh` reported a phantom collision between #4442 and #4309 over globs belonging
 * to #4309, and the real collision underneath it (#4460, on `.github/workflows/ci.yml`) was invisible
 * until the quote was de-fanged by hand. Fence-stripping removes almost every occurrence; refusing on
 * what is left is the honest answer for a genuinely ambiguous body, and it is LOUD — the unit renders
 * under the report's gaps instead of buying a verdict from a scope nobody wrote for it.
 */
export function scopeGlobs(body) {
	const decls = scopeDeclarations(body);
	return decls.length === 1 ? decls[0] : [];
}

/** Compile one path SEGMENT (no `/`) into an anchored regex; `*` → any run of non-slash chars. */
function segToRegex(seg) {
	const body = seg
		.split("*")
		.map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
		.join("[^/]*");
	return new RegExp(`^${body}$`);
}

/**
 * Do two path segments overlap — i.e. is there a filename matching both? `**` is handled by the
 * caller (multi-segment), so here a segment is a literal or a single-segment `*`-glob. Conservative
 * on purpose: when both carry intra-segment wildcards we test a few witness strings and treat them
 * as overlapping if any is matched by both, because a MISSED overlap is what causes the tangle.
 */
export function segMatch(a, b) {
	if (a === b) return true;
	if (a === "*" || b === "*") return true;
	const hasWildA = a.includes("*");
	const hasWildB = b.includes("*");
	if (!hasWildA && !hasWildB) return false; // two distinct literals — disjoint
	const rxA = segToRegex(a);
	const rxB = segToRegex(b);
	// Witnesses: each pattern with `*` collapsed to "" and to a filler run.
	const witnesses = [
		a.replace(/\*/g, ""),
		a.replace(/\*/g, "x9z"),
		b.replace(/\*/g, ""),
		b.replace(/\*/g, "x9z"),
	];
	return witnesses.some((w) => rxA.test(w) && rxB.test(w));
}

/**
 * Do two normalized globs overlap? Segment-by-segment match where `**` matches zero-or-more
 * segments; catches exact equality, prefix subsumption (`a/lib/**` ⊇ `a/lib/db/**`), and
 * wildcard siblings, while keeping disjoint dirs (`a/x/**` vs `a/y/**`) disjoint.
 */
export function globsOverlap(g1, g2) {
	const a = normalizeGlob(g1).split("/");
	const b = normalizeGlob(g2).split("/");
	/** Recursive segment matcher over the remaining segments of each glob. */
	const walk = (i, j) => {
		if (i >= a.length && j >= b.length) return true;
		if (i >= a.length) return b.slice(j).every((s) => s === "**");
		if (j >= b.length) return a.slice(i).every((s) => s === "**");
		if (a[i] === "**") return walk(i + 1, j) || walk(i, j + 1);
		if (b[j] === "**") return walk(i, j + 1) || walk(i + 1, j);
		if (segMatch(a[i], b[j])) return walk(i + 1, j + 1);
		return false;
	};
	return walk(0, 0);
}

/**
 * The first overlapping pair between two glob LISTS, or null. The list-level convenience the
 * dashboard needs; `globsOverlap` remains the single decision underneath it.
 */
export function scopeListsOverlap(a, b) {
	for (const g1 of a ?? []) {
		for (const g2 of b ?? []) {
			if (globsOverlap(g1, g2)) return { g1, g2 };
		}
	}
	return null;
}

// ── reading a scope declaration, WITH its failure modes ───────────────────────────────────────

/**
 * Characters a path glob can be made of. Anything else — a backtick, a comma, an apostrophe, a
 * markdown emphasis run — means the token came out of prose or decoration rather than out of a
 * declaration, and comparing it would be comparing noise. Deliberately a whitelist: a blacklist
 * of "characters we have seen go wrong" is a hand-written list, and those decay.
 *
 * PARENTHESES AND SQUARE BRACKETS ARE PATH CHARACTERS IN THIS REPO, not prose. The console is a
 * Next.js App Router tree, so `apps/console/app/(private)/[org]/~/support/**` is an ordinary
 * scope: a route group and two dynamic segments. The first cut of this list rejected them and the
 * live board came back with five units "unreadable" that were declared perfectly well — a guard
 * over-reporting into noise, which is how a report stops being read. The cost of admitting them is
 * that a prose fragment like `(and` is taken for a glob; it matches no file anyone owns, so at
 * worst it is one extra glob in the count, never a missed overlap.
 */
const PATH_GLOB_CHARS = /^[A-Za-z0-9._\-/*?@+~()[\]{}!]+$/;

/**
 * Classify one declared token: `null` when it is a usable glob, else the reason it is not.
 *
 * `*` and `**` alone are rejected rather than accepted-as-everything on purpose. Accepting them
 * is not wrong — a unit claiming the whole repo genuinely collides with every other unit — but it
 * turns one malformed declaration into N false collision lines, and a report nobody can read is a
 * report nobody reads. Rejected, it shows up once, in the NOT CHECKED line, naming the unit.
 */
export function globDefect(token) {
	const g = normalizeGlob(token);
	if (g === "") return "empty after normalization";
	if (!PATH_GLOB_CHARS.test(g)) return "contains characters no path glob can (markdown or prose?)";
	if (g === "*" || g === "**") return "matches the entire repository — that is not a scope";
	return null;
}

/**
 * Read a unit's scope declaration into a three-state answer.
 *
 * @returns {{status: "declared"|"missing"|"mentioned-not-declared", globs: string[],
 *            unusable: {token: string, reason: string}[]}}
 *   `status: "mentioned-not-declared"` is the case worth separating out: the body says `scope:`
 *   somewhere but never at the start of a line, which is what a backtick-wrapped or indented-in-a
 *   -bullet declaration looks like to the parser. Board #4089 was exactly this on 2026-09-03 —
 *   a unit that reads to a human as scoped and to every parser as unscoped.
 */
export function readScope(body) {
	const text = String(body ?? "");
	const decls = scopeDeclarations(text);
	if (decls.length > 1) {
		return { status: "ambiguous", globs: [], unusable: [], declarations: decls.length };
	}
	const tokens = decls.length === 1 ? decls[0] : [];
	if (tokens.length === 0) {
		return {
			// `mentioned-not-declared` is decided on the STRIPPED body: a `scope:` inside a fence is a
			// quotation, and reporting it as "mentions scope: but not as a declaration" would send a
			// reader looking for a formatting mistake they did not make.
			status: /scope:/i.test(stripFences(text)) ? "mentioned-not-declared" : "missing",
			globs: [],
			unusable: [],
		};
	}
	const globs = [];
	const unusable = [];
	for (const token of tokens) {
		const reason = globDefect(token);
		if (reason) unusable.push({ token, reason });
		else globs.push(normalizeGlob(token));
	}
	return { status: "declared", globs, unusable };
}

// ── the live-board audit ──────────────────────────────────────────────────────────────────────

/**
 * Labels that take a unit out of the simultaneously-workable set.
 *
 * MIRRORS THE EMITTER — claim-work.sh's `ready` filter (scripts/claim-work.sh:203-215), which
 * excludes claimed / blocked / needs:human / epic and requires a `class:` label — with ONE
 * deliberate difference: `claimed` is NOT excluded here. claim-work.sh excludes it because a
 * claimed unit cannot be handed out again; this audit includes it because a claimed unit is the
 * one somebody is editing files in RIGHT NOW. A claimed unit overlapping a ready one, or two
 * claimed units overlapping each other, is precisely the tangle the invariant forbids.
 */
const NOT_WORKABLE_LABELS = ["blocked", "needs:human", "epic"];

/** Is this open issue a board unit that could be worked right now (claimed or ready)? */
export function isWorkableBoardUnit(issue) {
	const labels = (issue?.labels ?? []).map((l) => (typeof l === "string" ? l : l?.name)).filter(Boolean);
	if (!labels.some((l) => l.startsWith("class:"))) return false;
	return NOT_WORKABLE_LABELS.every((l) => !labels.includes(l));
}

/** The wave label of an issue, without the prefix, or "—". */
function waveOf(labels) {
	const wave = labels.find((l) => l.startsWith("wave:"));
	return wave ? wave.slice("wave:".length) : "—";
}

/**
 * Audit an open board for overlapping scope globs among the units that can be worked at once.
 *
 * @param {Array} board `gh issue list --json number,title,labels,body` output.
 * @returns the audit model: `verdict` is one of CLEAN / COLLISIONS / CLEAN-WITH-GAPS /
 *   NOT-CHECKED, and `gaps` is never folded into `collisions` — an unread unit is not a clean one.
 */
export function auditBoard(board) {
	if (!Array.isArray(board)) {
		return {
			verdict: "NOT-CHECKED",
			reason: "the board input was not a JSON array — nothing could be compared",
			units: [],
			compared: [],
			gaps: [],
			collisions: [],
			pairs: 0,
		};
	}
	const units = board.filter(isWorkableBoardUnit).map((issue) => {
		const labels = (issue.labels ?? []).map((l) => (typeof l === "string" ? l : l?.name)).filter(Boolean);
		return {
			number: issue.number,
			title: String(issue.title ?? "(untitled)"),
			state: labels.includes("claimed") ? "claimed" : "ready",
			wave: waveOf(labels),
			...readScope(issue.body),
		};
	});
	const compared = units.filter((u) => u.globs.length > 0);
	const gaps = units.filter((u) => u.globs.length === 0 || u.unusable.length > 0);

	const collisions = [];
	for (let i = 0; i < compared.length; i++) {
		for (let j = i + 1; j < compared.length; j++) {
			const hit = scopeListsOverlap(compared[i].globs, compared[j].globs);
			if (hit) collisions.push({ a: compared[i], b: compared[j], ...hit });
		}
	}
	const pairs = (compared.length * (compared.length - 1)) / 2;

	let verdict;
	let reason = "";
	if (units.length === 0) {
		verdict = "NOT-CHECKED";
		reason = "the board read yielded no claimed-or-ready board units at all";
	} else if (compared.length === 0) {
		verdict = "NOT-CHECKED";
		reason = `not one of the ${units.length} claimed-or-ready units declares a readable \`scope:\` line`;
	} else if (collisions.length > 0) {
		verdict = "COLLISIONS";
	} else if (gaps.length > 0) {
		verdict = "CLEAN-WITH-GAPS";
	} else {
		verdict = "CLEAN";
	}
	return { verdict, reason, units, compared, gaps, collisions, pairs };
}

/**
 * Why a unit could not be (fully) compared, as one short clause.
 *
 * Exported because board-dashboard.mjs renders the same gap set in HTML: a second wording for the
 * same condition is how two surfaces start describing different boards.
 *
 * @param {{status: string, globs: string[], unusable: {token: string, reason: string}[]}} unit
 */
export function scopeGapReason(unit) {
	if (unit.status === "missing") return "no `scope:` line";
	if (unit.status === "ambiguous") {
		return (
			`${unit.declarations ?? 2} \`scope:\` declarations — ambiguous, so none is used. Quoting another ` +
			`unit's scope line? Put text before it; indenting is not enough, the anchor tolerates whitespace`
		);
	}
	if (unit.status === "mentioned-not-declared") {
		return "mentions `scope:` but not as a declaration at the start of a line (backticks? a bullet?)";
	}
	if (unit.globs.length === 0) {
		return `no usable glob — ${unit.unusable.map((u) => `"${u.token}" ${u.reason}`).join("; ")}`;
	}
	return `partly read — ${unit.unusable.map((u) => `"${u.token}" ${u.reason}`).join("; ")}`;
}

/** The exit code a verdict maps to, so a caller can branch without re-parsing the text. */
export const VERDICT_EXIT = { CLEAN: 0, COLLISIONS: 3, "NOT-CHECKED": 4, "CLEAN-WITH-GAPS": 5 };

/**
 * Render the audit as report lines (two-space indented, to sit inside coordinate.sh's report).
 *
 * EVERY verdict produces output. The whole point of #4115 is that "checked and clean" and "never
 * checked" were the same silence, so there is no branch here that returns an empty array.
 */
export function formatAudit(audit) {
	const lines = ["  ── scope collisions (the anti-tangle invariant) ──"];
	if (audit.verdict === "NOT-CHECKED") {
		lines.push(`  ⚠ scope collisions NOT CHECKED: ${audit.reason}.`);
	}
	for (const c of audit.collisions) {
		lines.push(
			`  ⚠ SCOPE COLLISION: #${c.a.number} (${c.a.state}, wave:${c.a.wave}) glob "${c.g1}" overlaps ` +
				`#${c.b.number} (${c.b.state}, wave:${c.b.wave}) glob "${c.g2}"`,
		);
		lines.push(`      #${c.a.number} ${c.a.title}`);
		lines.push(`      #${c.b.number} ${c.b.title}`);
	}
	if (audit.compared.length > 0) {
		const verb = audit.collisions.length > 0 ? "compared" : "compared, no overlap:";
		lines.push(
			`  ${audit.collisions.length > 0 ? "·" : "✓"} ${verb} ${audit.compared.length} of ` +
				`${audit.units.length} claimed-or-ready units (${audit.pairs} pair(s), ` +
				`${audit.compared.reduce((n, u) => n + u.globs.length, 0)} glob(s)).`,
		);
	}
	if (audit.gaps.length > 0) {
		lines.push(`  ⚠ NOT CHECKED — ${audit.gaps.length} unit(s) whose scope could not be read:`);
		for (const g of audit.gaps) lines.push(`      #${g.number} ${scopeGapReason(g)}`);
		lines.push(
			"      An unread scope is not a disjoint one. Add a `scope:` line at column 0 (no backticks)" +
				" to the issue body, or the invariant is unenforced for that unit.",
		);
	}
	return lines;
}

// ── possibly-shipped: merged-PR evidence, and the exact claim it can carry ────────────────────
//
// `coordinate.sh`'s possibly-shipped advisory asked ONE question — "does a merged PR mention
// `#n`?" — and printed the answer under a heading that told the reader to "close if delivered".
// That is text proximity. On the board of 2026-09-09 it was wrong 28 times out of 28; on the
// re-measurement of 2026-09-10 a further 12 of 14 were mention-only and the other 2 were partials.
// Running total: 40 wrong · 2 partial · 0 right (#4523). The recurring shape is a PR body writing
// `#n` to say "ordered behind #n", "part of #n" or "unlike #n".
//
// It is worse than noise, because the cheapest way to clear a 0-for-40 advisory is to close 40
// live units — including #3348, a production blocker, and seven `wave:cli-first` units that are
// the wave's remaining work.
//
// ── WHAT THIS ASKS INSTEAD ────────────────────────────────────────────────────────────────────
//
// The cheaper, sounder question this module already owns: did the merged PR change a file the
// unit's own `scope:` claims? That is a fact about two file sets, not about prose, and it uses the
// SAME `globsOverlap` the anti-tangle invariant is decided with — no second semantics.
//
// ── AND WHAT IT STILL CANNOT ANSWER — the reason no heading below says "close if delivered" ────
//
// Scope intersection is NECESSARY AND NOT SUFFICIENT, and that is measured, not assumed. Of the 12
// false positives re-verified on 2026-09-10, gating on intersection would have suppressed 9 — and
// still reported three, because in each of those the cited PR landed INSIDE the unit's own scope
// and the defect survived anyway:
//
//   · #3348 / #4419 — touched both files the unit names, and only improved an error message;
//     `runner.go` still calls plain `AssumeRole` on the `self` path. Production blocker, still live.
//   · #3907 / #4361 — wrote up the very audit document the unit is about; the document still says
//     "the decision on them remains open". (It also declares no `scope:` at all, so this module
//     reports it as NOT COMPARABLE rather than inventing a comparison.)
//   · #4455 / #4545 — the Go-side lock really did land, and the unit's census still reads
//     `unlocked mirrors: 8`. Substance shipped; the done-when is not met.
//
// So the claim made here is exactly this and no more: **a merged PR has already edited files this
// unit owns.** That is a reason to read the diff and to run the unit's own `check:` line — which
// every row prints, because the acceptance criterion is the only thing in this report that can
// settle delivery. Three-valued throughout: a unit whose scope cannot be read, or whose evidence
// PR's file list cannot be read, is reported as NOT COMPARABLE — never silently dropped, and never
// counted as shipped.

/**
 * `gh pr list --json files` pages at 100 files per PR, so a list of exactly that length may be
 * TRUNCATED. A truncated list can prove an intersection but can never prove its absence, so a
 * mention backed only by truncated (or absent) file lists is reported as NOT COMPARABLE. An
 * emptiness check that cannot see a withheld measurement reads "nothing there" for "did not look".
 *
 * NOT HYPOTHETICAL: six PRs in the 300-PR corpus of 2026-09-10 sit exactly at the cap, and they are
 * the promotion PRs (#4389, #3562, #4291, #3534, #3526) — the very merges most likely to name a
 * board unit in passing, each carrying hundreds of files nobody can see all of from here.
 */
const FILES_PAGE_CAP = 100;

/** Units filed by the nightly rollup close on a green RUN, not on a merge — see `--superseded-reds`. */
const NIGHTLY_LABEL = "from:e2e-nightly";

/**
 * Is one CONCRETE changed path inside a unit's scope? Returns the glob that claims it, or null.
 *
 * A concrete path is a wildcard-free glob, so the decision is `globsOverlap` with a path on one
 * side — deliberately the same call `check-pr-scope.mjs` makes for the same question, and
 * deliberately not a second matcher.
 *
 * ONE RULE IS ADDED ON TOP, and it is added rather than assumed because the matcher measurably
 * does not have it: `globsOverlap` subsumes a prefix only through `**`, so the glob
 * `packages/core/git` does NOT match `packages/core/git/git.go` (its walk runs out of segments on
 * the right and refuses). Every declared scope on this board reads to a person as "this directory
 * and what is under it", so a glob is also tried as `<glob>/**`. That delegates the decision back
 * to the same walk — no second semantics — and it is the safe direction: an over-claimed row costs
 * the reader one diff, while a missed one silently suppresses real evidence, which is the failure
 * this whole unit is about. The separator is still respected, so `apps/console/lib/billing` does
 * not claim `apps/console/lib/billing-legacy/pricing.ts`; the fixtures pin both directions.
 *
 * @param {string} path a changed file path from a PR
 * @param {string[]} globs the unit's declared scope globs
 */
export function pathInScope(path, globs) {
	const p = normalizeGlob(path);
	if (!p) return null;
	for (const g of globs ?? []) {
		const n = normalizeGlob(g);
		if (globsOverlap(p, n) || globsOverlap(p, `${n}/**`)) return g;
	}
	return null;
}

/**
 * What one merged PR's changed-file list says about one unit's scope.
 *
 * @returns {{known: boolean, truncated: boolean, hits: string[]}} `known: false` when the PR
 *   carries no `files` array at all (the field was not requested, or gh could not answer). Both
 *   `known: false` and `truncated: true` mean an empty `hits` proves NOTHING.
 */
export function prScopeEvidence(pr, globs) {
	const files = Array.isArray(pr?.files) ? pr.files : null;
	if (files === null) return { known: false, truncated: false, hits: [] };
	const paths = files.map((f) => (typeof f === "string" ? f : f?.path)).filter(Boolean);
	return {
		known: true,
		truncated: paths.length >= FILES_PAGE_CAP,
		hits: paths.filter((p) => pathInScope(p, globs) !== null),
	};
}

/**
 * The unit's acceptance command — its `check:` line — or null when it declares none or two.
 *
 * Same anchor contract as `scope:`: a declaration starts a line (leading whitespace tolerated) and
 * a `check:` inside a fence is a quotation. Two declarations yield null for the same reason
 * `scopeGlobs` refuses on two: an ambiguous body must not buy an answer nobody wrote for it.
 */
export function readCheck(body) {
	const decls = [];
	for (const line of stripFences(body).split("\n")) {
		const m = line.match(/^[ \t]*check:[ \t]*(.+)$/i);
		if (m) decls.push(m[1].trim());
	}
	return decls.length === 1 ? decls[0] : null;
}

/**
 * Issue numbers a text CLOSES, given the keyword vocabulary.
 *
 * THE VOCABULARY IS NOT RETYPED HERE. `scripts/lib/board-pr.sh` owns it in `BOARD_PR_CLOSING_KW`,
 * because there were once two copies and one of them expanded to `fixs`/`fixd` — so "Fixes #n"
 * matched nothing for as long as nobody looked. The caller passes it in; `coordinate.sh` sources
 * that file already, and `check-pr-scope.mjs` parses the same assignment for the same reason.
 * An absent vocabulary is REFUSED (see `auditShipped`), never defaulted to a guess: a guessed
 * vocabulary that matches no PR reports every one of them as a mere mention.
 *
 * `\b` after the digits so `#84` does not match `#842`.
 *
 * @param {string} text
 * @param {string[]} keywords
 * @returns {Set<number>}
 */
export function closingRefsIn(text, keywords) {
	const out = new Set();
	if (!keywords?.length) return out;
	const re = new RegExp(`\\b(?:${keywords.join("|")})\\s+#(\\d+)\\b`, "gi");
	for (const m of String(text ?? "").matchAll(re)) out.add(Number(m[1]));
	return out;
}

/** Does a text MENTION `#n` at all — the old predicate, kept as the input filter it always was. */
export function mentionsIssue(text, n) {
	return new RegExp(`#${n}\\b`).test(String(text ?? ""));
}

/**
 * Hold every open board unit against the merged-PR corpus and classify the evidence.
 *
 * @param {{board: Array, merged: Array, closingKeywords?: string[], debt?: Record<string,string>}} input
 *   `debt` maps an issue number to the exclusion register that names it — an entry there is a
 *   reviewed statement that the debt STANDS, which is stronger evidence than any merge and points
 *   the opposite way.
 * @returns the audit model. `ran: false` is its own outcome and prints as NOT CHECKED.
 */
export function auditShipped(input) {
	const board = Array.isArray(input?.board) ? input.board : null;
	const merged = Array.isArray(input?.merged) ? input.merged : null;
	if (!board || !merged) {
		return {
			ran: false,
			reason: !board
				? "the board input was not a JSON array"
				: "the merged-PR corpus was not a JSON array",
			rows: [],
			counts: { referenced: 0, mentionOnly: 0, nightly: 0 },
			keywordsRead: false,
		};
	}
	const keywords = (input?.closingKeywords ?? []).map((k) => String(k).trim()).filter(Boolean);
	const debt = input?.debt && typeof input.debt === "object" ? input.debt : {};

	// Read each PR's text ONCE. Measured 2026-09-10: 96 open units against a 300-PR corpus of
	// ~2 MB, so joining title+body — and compiling a keyword regex — per unit-PR pair is 28,800 of
	// each. The closing refs a PR declares do not depend on which unit is asking.
	const corpus = merged.map((pr) => {
		const text = `${pr?.title ?? ""}\n${pr?.body ?? ""}`;
		return { pr, text, closes: closingRefsIn(text, keywords) };
	});

	const rows = [];
	const counts = { referenced: 0, mentionOnly: 0, nightly: 0 };
	for (const issue of board) {
		const labels = (issue?.labels ?? []).map((l) => (typeof l === "string" ? l : l?.name)).filter(Boolean);
		// EXACTLY the READY predicate the dashboard's counts publish — not a stricter one. The
		// hazard is a unit that still LOOKS claimable, so the set to police is the set READY
		// publishes: a `class:` requirement here once hid #1207, which two merged PRs named in
		// their TITLES, because the issue happened to carry only `wave:connectors-v2`.
		if (["claimed", "blocked", "epic"].some((l) => labels.includes(l))) continue;

		const n = issue?.number;
		if (typeof n !== "number") continue;
		const cited = corpus.filter((c) => mentionsIssue(c.text, n));
		if (cited.length === 0) continue;
		const refs = cited.map((c) => c.pr);
		counts.referenced++;

		const title = String(issue?.title ?? "(untitled)");
		const prList = refs.map((pr) => `#${pr?.number}`).join(",");

		// A merge cannot close this class AT ALL, so a merge-based verifier has nothing to say
		// about it. Exempt before anything else is computed.
		if (labels.includes(NIGHTLY_LABEL)) {
			counts.nightly++;
			continue;
		}
		// A register naming the issue is a committed, reviewed statement that the debt still
		// stands — the mention IS the deferral, so the inference from it runs BACKWARDS.
		const register = debt[String(n)];
		if (register) {
			rows.push({ n, title, tier: "debt-recorded", register, prList, prs: [], check: null });
			continue;
		}

		const scope = readScope(issue?.body);
		const check = readCheck(issue?.body);
		if (scope.globs.length === 0) {
			rows.push({ n, title, tier: "cannot-compare", prList, prs: [], check, why: scopeGapReason(scope) });
			continue;
		}

		// A PARTLY read scope is the quiet half of the same three-valued rule. #4326 declares
		// `scope: (no repository files — a cloud console/CLI action)`: seven prose fragments the
		// glob whitelist admits, plus one token it refuses. Compare on what is readable and find
		// nothing, and the unit falls into "mention-only" — suppressed on a comparison that was
		// never complete. So an unusable token withholds the suppression, exactly as an unreadable
		// file list does.
		const evidence = refs.map((pr) => ({ number: pr?.number, ...prScopeEvidence(pr, scope.globs) }));
		const closes = keywords.length > 0 && cited.some((c) => c.closes.has(n));
		const hit = evidence.filter((e) => e.hits.length > 0);
		const blind = evidence.filter((e) => !e.known || e.truncated);

		if (closes && hit.length > 0) {
			rows.push({ n, title, tier: "closes-and-touches", prList, prs: hit, check });
		} else if (closes) {
			rows.push({ n, title, tier: "closes-only", prList, prs: [], check });
		} else if (hit.length > 0) {
			rows.push({ n, title, tier: "touches", prList, prs: hit, check });
		} else if (blind.length > 0 || scope.unusable.length > 0) {
			const why = [];
			if (blind.length > 0) {
				why.push(
					`no changed-file list to compare (${blind
						.map((e) => `#${e.number} ${e.known ? `truncated at ${FILES_PAGE_CAP} files` : "file list absent"}`)
						.join(", ")})`,
				);
			}
			if (scope.unusable.length > 0) why.push(scopeGapReason(scope));
			rows.push({ n, title, tier: "cannot-compare", prList, prs: [], check, why: why.join("; ") });
		} else {
			counts.mentionOnly++;
		}
	}
	rows.sort((a, b) => a.n - b.n);
	return { ran: true, reason: "", rows, counts, keywordsRead: keywords.length > 0 };
}

/** A title, cut to fit one report line — with an ellipsis, so a cut title cannot read as a whole one. */
function short(title, n) {
	const t = String(title ?? "");
	return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

/** One evidence row's PR clause: which merged PR touched which of the unit's files. */
function evidenceClause(prs) {
	return prs
		.map((e) => `merged #${e.number} → ${e.hits.length} file(s) in scope: ${e.hits.slice(0, 3).join(", ")}${e.hits.length > 3 ? ", …" : ""}`)
		.join("; ");
}

/**
 * Render the shipped audit as report lines, two-space indented for `coordinate.sh`'s report.
 *
 * EVERY run prints a summary line, including the run that finds nothing. "Examined 14, reported 0"
 * and "never ran" were the same silence in the version this replaces, and that is the defect
 * #4115 was filed for one section up.
 */
export function formatShipped(audit) {
	const lines = ["  ── possibly-shipped (merged-PR evidence, held against each unit's own `scope:`) ──"];
	if (!audit?.ran) {
		lines.push(`  ⚠ possibly-shipped NOT CHECKED: ${audit?.reason ?? "the audit did not run"}.`);
		return lines;
	}
	const by = (t) => audit.rows.filter((r) => r.tier === t);
	const c = audit.counts;
	lines.push(
		`  ✓ examined ${c.referenced} open unit(s) a merged PR names: ` +
			`${by("closes-and-touches").length} closing-keyword+scope · ${by("closes-only").length} closing-keyword only · ` +
			`${by("touches").length} scope-touched · ${by("cannot-compare").length} not comparable · ` +
			`${by("debt-recorded").length} debt-recorded · ${c.mentionOnly} mention-only (suppressed) · ` +
			`${c.nightly} from:e2e-nightly (exempt — they close on a green run, not a merge).`,
	);
	if (!audit.keywordsRead) {
		lines.push(
			"  ⚠ the closing-keyword half was NOT CHECKED: no vocabulary was passed in. " +
				"scripts/lib/board-pr.sh owns it (BOARD_PR_CLOSING_KW); a unit below may be understated.",
		);
	}

	/** One tier's block: a heading, then a row per unit with its evidence and its `check:`. */
	const block = (tier, heading, footer) => {
		const rows = by(tier);
		if (rows.length === 0) return;
		lines.push(`  ── ${heading} ──`);
		for (const r of rows) {
			if (tier === "debt-recorded") {
				lines.push(`  #${r.n}  debt-recorded  (${r.register})  ${short(r.title, 60)}`);
				continue;
			}
			lines.push(`  #${r.n}  ${short(r.title, 70)}`);
			lines.push(`        evidence: ${r.prs.length > 0 ? evidenceClause(r.prs) : `named by merged ${r.prList}`}`);
			if (r.why) lines.push(`        not comparable: ${r.why}`);
			lines.push(
				r.check
					? `        settle it with the unit's own check:  ${r.check}`
					: "        this unit declares no `check:` line — read the diff and the issue's done-when.",
			);
		}
		if (footer) for (const f of footer) lines.push(`     ${f}`);
	};

	block("closes-and-touches", "⚠ a merged PR CLOSES this and it is still open (keyword + #n, and it touched the unit's files)", [
		"This is the stale-open shape the advisory exists for: a keyword the close-on-dev-merge Action never fired on.",
		"`scripts/coordinate.sh --close-shipped` closes exactly the keyword set — after you have run the check above.",
	]);
	block("closes-only", "⚠ a merged PR claims to CLOSE this, but changed no file the unit's `scope:` claims", [
		"The keyword and the files disagree. Either the scope line is wrong (see scripts/ci/check-pr-scope.mjs) or the",
		"claim is. Read the PR before acting on either.",
	]);
	block("touches", "⚠ scope-touched (a merged PR changed files this unit's `scope:` claims — READ it, do not close it)", [
		"A scope hit says the ground under the unit MOVED. It does not say the unit is done: measured 2026-09-10,",
		"THREE OF THREE scope hits — #3348, #3907, #4455 — still had the defect live on origin/dev. The unit's own",
		"`check:` line is the only thing in this report that can settle delivery.",
	]);
	block("cannot-compare", "⚠ named by a merged PR and NOT COMPARABLE (this is not a clean bill, and not a delivery)", [
		"Nothing here was suppressed and nothing here was verified. Give the unit a `scope:` line at column 0 and it",
		"joins the comparison above.",
	]);
	block("debt-recorded", "debt-recorded (a merged PR named it to RECORD the debt, not to pay it — do NOT close)", [
		"An exclusion file naming an issue is a reviewed statement that the debt STANDS.",
	]);
	return lines;
}

/** Exit codes for `--shipped-report`: it ran, or it could not. Nothing found is still "it ran". */
export const SHIPPED_EXIT = { RAN: 0, "NOT-CHECKED": 4 };

// ── self-test ─────────────────────────────────────────────────────────────────────────────────

const FIXTURES = new URL("./board-body-fixtures.json", import.meta.url);

// ── shipped-advisory fixtures: MEASURED, not composed ─────────────────────────────────────────
//
// Every case below is a real board unit, a real merged PR and that PR's real changed-file list,
// taken from the two hand verifications recorded on #4523 (2026-09-09, 28 units; 2026-09-10, the
// 14 then live). A guard whose fixtures were written alongside its own fix is tautological; these
// were written by the defect.
//
// They live here rather than in `scripts/lib/board-body-fixtures.json` for one reason worth stating
// so the next reader does not take it for a preference: #4523's `scope:` is `scripts/coordinate.sh
// scripts/lib/scope-overlap.mjs`, and the fixtures file is not in it. They are still hand-authored
// DATA — no expected value below is computed by the code under test — which is the property that
// matters. Converging them into the JSON is a one-line follow-up for whoever owns that file next.
//
// The three cases that decide the design are marked ⚑: a merged PR landed INSIDE the unit's own
// scope and the defect survived anyway. They are why no tier in this report claims delivery.
const SHIPPED_FIXTURES = Object.freeze({
	// path-vs-scope decisions, for the mutation controls to disagree with.
	pathCases: [
		{ name: "the exact file a scope names", path: "apps/runner/internal/agent/runner.go", globs: ["apps/runner/internal/agent/operator_credentials.go", "apps/runner/internal/agent/runner.go"], inScope: true },
		{ name: "a file under a `**` scope", path: "apps/console/lib/billing/pricing.ts", globs: ["apps/console/lib/billing/**"], inScope: true },
		{ name: "a file under a bare DIRECTORY scope", path: "packages/core/git/git.go", globs: ["packages/core/git"], inScope: true },
		{ name: "a sibling directory sharing a prefix is NOT in scope", path: "apps/console/lib/billing-legacy/pricing.ts", globs: ["apps/console/lib/billing/**"], inScope: false },
		{ name: "…and a BARE directory scope respects the separator too", path: "apps/console/lib/billing-legacy/pricing.ts", globs: ["apps/console/lib/billing"], inScope: false },
		{ name: "a longer filename sharing a prefix is NOT in scope", path: "scripts/coordinate.sh.bak", globs: ["scripts/coordinate.sh"], inScope: false },
		{ name: "#4109's real miss: apps/cli against a packages/core/git scope", path: "apps/cli/cmd/links.go", globs: ["packages/core/git/git.go", "packages/core/git/git_ops_test.go"], inScope: false },
		{ name: "an intra-path wildcard scope", path: "infra/templates/project/aws/dns.tf", globs: ["infra/templates/*/aws/**"], inScope: true },
	],
	// Each unit as the board carries it, with the merged PRs that named it.
	units: [
		{
			name: "⚑ #3348 — #4419 touched BOTH files the unit names, and the production blocker stands",
			tier: "touches",
			issue: {
				number: 3348,
				title: "AWS and GCP cannot be provisioned in production: the deployed runner runs as `self`",
				labels: [{ name: "class:backend" }, { name: "needs:human" }],
				body: "scope: apps/runner/internal/agent/operator_credentials.go apps/runner/internal/agent/runner.go",
			},
			prs: [
				{
					number: 4419,
					title: "fix(runner): a `self` runner with no ambient credentials says so, instead of naming EC2 IMDS",
					body: "Surfaced by #3348. It does NOT restore provisioning: `runner.go` still calls plain `AssumeRole`.",
					files: [
						{ path: "apps/runner/internal/agent/operator_credentials.go" },
						{ path: "apps/runner/internal/agent/operator_credentials_test.go" },
						{ path: "apps/runner/internal/agent/runner.go" },
					],
				},
			],
		},
		{
			name: "⚑ #4176 — #4208 constrained plan prices; 12 files still carry unitAmountUsd",
			tier: "touches",
			issue: {
				number: 4176,
				title: "audit(billing): money is modelled as USD and formatted as anything",
				labels: [{ name: "class:ui" }, { name: "needs:design" }],
				body: "scope: apps/console/lib/billing/** apps/console/app/server/actions/billing.ts packages/plan-catalog/src/** packages/format/src/minor-units.ts apps/marketing/lib/billing/**",
			},
			prs: [
				{
					number: 4208,
					title: "fix(billing): constrain plan prices to supported currencies",
					body: "Narrows the type. The audit in #4176 stays open.",
					files: [
						{ path: "apps/console/lib/billing/pricing.ts" },
						{ path: "apps/marketing/lib/billing/pricing-display.ts" },
						{ path: "packages/plan-catalog/src/index.ts" },
						{ path: "packages/plan-catalog/tests/index.test.ts" },
					],
				},
			],
		},
		{
			name: "⚑ #4455 — #4545 landed the Go-side lock; the census still reads `unlocked mirrors: 8`",
			tier: "touches",
			issue: {
				number: 4455,
				title: "cli(mirrors): the eight `Mirrors the Go X` claims with nothing watching them",
				labels: [{ name: "lane:core" }, { name: "class:backend" }, { name: "wave:cli-first" }],
				body: "blocked-by: #4448\nscope: apps/console/lib/addons/types.ts apps/console/lib/evidence/receipt-anchor.ts packages/core/jsonbmirror/jsonb_mirror_test.go",
			},
			prs: [
				{
					number: 4545,
					title: "test(mirrors): the mirror lock enrols three console files, and a `Type.Field` claim is a claim",
					body: "Part of #4455.",
					files: [
						{ path: "packages/core/jsonbmirror/jsonb_mirror_test.go" },
						{ path: "packages/core/jsonbmirror/testdata/jsonb/addon_bootstrap.json" },
						{ path: "packages/core/jsonbmirror/testdata/jsonb/addon_install.json" },
					],
				},
			],
		},
		{
			name: "#4109 — #4308 is apps/cli; the unit's scope is packages/core/git (suppressed)",
			tier: "mention-only",
			issue: {
				number: 4109,
				title: "chore(core): git.Bootstrap has no caller",
				labels: [{ name: "wave:hygiene" }, { name: "lane:core" }, { name: "class:backend" }],
				body: "scope: packages/core/git/git.go packages/core/git/git_ops_test.go\ncheck: go -C packages/core test ./git/...",
			},
			prs: [
				{
					number: 4308,
					title: "feat(cli): deep links built over the console's own route tree",
					body: "Ordered behind #4109; unrelated to it.",
					files: [
						{ path: "apps/cli/cmd/links.go" },
						{ path: "apps/cli/cmd/open.go" },
						{ path: "apps/console/scripts/gen-go-routes.ts" },
						{ path: ".github/workflows/ci.yml" },
					],
				},
			],
		},
		{
			name: "#3524 — the guard PR that REQUIRES this tracker stay open (suppressed)",
			tier: "mention-only",
			issue: {
				number: 3524,
				title: "board: the coverage-exclusion tracker",
				labels: [{ name: "class:backend" }],
				body: "scope: apps/console/lib/coverage/**",
			},
			prs: [
				{
					number: 4139,
					title: "ci: exclusion issues must be OPEN",
					body: "The register names #3524 and asserts it is open.",
					files: [{ path: "scripts/check-exclusion-issues.mjs" }],
				},
			],
		},
		{
			name: "⚑ #3907 — #4361 wrote the very audit doc up, and the unit declares NO scope",
			tier: "cannot-compare",
			issue: {
				number: 3907,
				title: "legal(assets): the nine third-party marks already shipping were never cleared",
				labels: [{ name: "wave:hygiene" }, { name: "lane:docs" }, { name: "needs:human" }],
				body: "Recorded durably in `docs/legal/DESIGN_SYSTEM_AUDIT.md:91-97` as an open item for the maintainer.",
			},
			prs: [
				{
					number: 4361,
					title: "docs(legal): the nine shipping marks' terms, read mark by mark",
					body: "Feeds the decision in #3907; the decision on them remains open.",
					files: [{ path: "docs/legal/DESIGN_SYSTEM_AUDIT.md" }],
				},
			],
		},
		{
			name: "#4482's shape: a FENCED scope line is not a declaration, so it cannot be compared",
			tier: "cannot-compare",
			issue: {
				number: 4482,
				title: "board: a unit whose scope lives inside a code fence",
				labels: [{ name: "class:backend" }],
				body: "The lane is declared as:\n\n```\nscope: apps/console/lib/**\n```\n",
			},
			prs: [{ number: 4500, title: "chore: unrelated", body: "Ordered behind #4482.", files: [{ path: "apps/console/lib/x.ts" }] }],
		},
		{
			// The scope line is #4326's, verbatim. The PR is constructed: no merged PR names #4326
			// today, so the case cannot be captured whole — the half that had to be measured, and
			// was, is the declaration the parser has to survive.
			name: "#4326's real scope line is PARTLY unreadable, so an empty intersection is not an absence",
			tier: "cannot-compare",
			issue: {
				number: 4326,
				title: "cost(sandbox): the alethia-sandbox project has no budget",
				labels: [{ name: "class:backend" }],
				body: "scope: (no repository files — a cloud console/CLI action)",
			},
			prs: [{ number: 9105, title: "chore: budgets", body: "Related to #4326.", files: [{ path: "infra/sandbox/main.tf" }] }],
		},
		{
			name: "a PR whose changed-file list is ABSENT cannot prove absence",
			tier: "cannot-compare",
			issue: {
				number: 9001,
				title: "a scoped unit whose only evidence PR carries no file list",
				labels: [{ name: "class:backend" }],
				body: "scope: apps/console/lib/**\ncheck: pnpm -F console test",
			},
			prs: [{ number: 9101, title: "chore: something", body: "Mentions #9001.", files: null }],
		},
		{
			name: "a file list AT the 100-file page cap is TRUNCATED, so an empty intersection proves nothing",
			tier: "cannot-compare",
			issue: {
				number: 9002,
				title: "a scoped unit whose only evidence PR is a 100-file merge",
				labels: [{ name: "class:backend" }],
				body: "scope: apps/console/lib/**",
			},
			prs: [
				{
					number: 9102,
					title: "chore: a very large merge",
					body: "Mentions #9002.",
					// 100 paths, none of them in scope: the cap is the point, not the paths.
					files: Array.from({ length: 100 }, (_, i) => ({ path: `packages/other/file-${i}.ts` })),
				},
			],
		},
		{
			name: "the CONTROL: #4275's PR #4436 matches its scope near-exactly, with a closing keyword",
			tier: "closes-and-touches",
			closingKeywords: true,
			issue: {
				number: 4275,
				title: "test(release-gate): runners against a seeded self-runner",
				labels: [{ name: "class:backend" }, { name: "lane:console" }, { name: "wave:release-gate" }],
				body: "scope: apps/console/e2e/flows/runners.spec.ts apps/console/e2e/helpers/seed-runners.ts apps/console/components/runners/**\ncheck: pnpm -F console exec playwright test --project=qa e2e/flows/runners.spec.ts",
			},
			prs: [
				{
					number: 4436,
					title: "test(release-gate): runners against a seeded self-runner",
					body: "Closes #4275",
					files: [
						{ path: "apps/console/components/runners/pool-card.tsx" },
						{ path: "apps/console/e2e/flows/runners.spec.ts" },
						{ path: "apps/console/e2e/helpers/seed-runners.ts" },
					],
				},
			],
		},
		{
			name: "a closing keyword whose PR touched nothing the scope claims — the two signals disagree",
			tier: "closes-only",
			closingKeywords: true,
			issue: {
				number: 9003,
				title: "a unit whose closing PR landed outside its declared scope",
				labels: [{ name: "class:backend" }],
				body: "scope: packages/core/git/**",
			},
			prs: [{ number: 9103, title: "fix: something", body: "Fixes #9003", files: [{ path: "apps/cli/cmd/links.go" }] }],
		},
		{
			name: "#3855 — a from:e2e-nightly red closes on a GREEN RUN, not on a merge (exempt)",
			tier: "nightly-exempt",
			issue: {
				number: 3855,
				title: "e2e nightly: gcp RED (floor)",
				labels: [{ name: "wave:hygiene" }, { name: "lane:tests" }, { name: "from:e2e-nightly" }],
				body: "The T2 real-cloud nightly went RED for `gcp` on the floor dimension.",
			},
			prs: [{ number: 4090, title: "ci: nightly rollup", body: "Related to #3855.", files: [{ path: ".github/workflows/e2e-nightly.yml" }] }],
		},
		{
			name: "#3290 — the PR that baselined it into a register RECORDED the debt, it did not pay it",
			tier: "debt-recorded",
			debt: "infra/tfvars-safety-baseline.json",
			issue: {
				number: 3290,
				title: "infra: the two unsafe tfvars",
				labels: [{ name: "class:backend" }],
				body: "scope: infra/templates/**",
			},
			prs: [
				{
					number: 3298,
					title: "ci: the tfvars safety ratchet",
					body: "Filed rather than folded in: #3290.",
					files: [{ path: "infra/tfvars-safety-baseline.json" }, { path: "infra/templates/project/aws/main.tf" }],
				},
			],
		},
		{
			name: "a CLAIMED unit is somebody's live work and is never advised on",
			tier: "not-considered",
			issue: {
				number: 9004,
				title: "a claimed unit",
				labels: [{ name: "class:backend" }, { name: "claimed" }],
				body: "scope: apps/console/lib/**",
			},
			prs: [{ number: 9104, title: "chore", body: "Closes #9004", files: [{ path: "apps/console/lib/x.ts" }] }],
		},
	],
});


/**
 * The closing-keyword vocabulary, READ from its owner for the self-test.
 *
 * `scripts/lib/board-pr.sh` owns `BOARD_PR_CLOSING_KW`, and `scripts/ci/check-pr-scope.mjs` exports
 * the production reader of it. This suite reads the same assignment rather than importing that
 * module (which imports THIS one, so the import would be a cycle) and rather than retyping the
 * words (which is how `fixs`/`fixd` once shipped). It REFUSES if the assignment cannot be found:
 * a guessed vocabulary matches no PR and then reports every one of them as a mere mention.
 */
const BOARD_PR_SH = new URL("./board-pr.sh", import.meta.url);
function selfTestClosingKeywords() {
	let text;
	try {
		text = readFileSync(BOARD_PR_SH, "utf8");
	} catch (error) {
		console.error(`self-test: could not read ${BOARD_PR_SH.pathname}: ${error.message}`);
		process.exit(1);
	}
	const m = /^BOARD_PR_CLOSING_KW='\(([^)]+)\)/m.exec(text);
	if (!m) {
		console.error("self-test: BOARD_PR_CLOSING_KW is not readable from scripts/lib/board-pr.sh.");
		console.error("  That file owns the closing-keyword vocabulary; if the assignment moved, move this reader with it.");
		process.exit(1);
	}
	const kws = m[1].split("|").map((s) => s.trim().toLowerCase()).filter(Boolean);
	if (kws.length === 0) {
		console.error("self-test: BOARD_PR_CLOSING_KW parsed to zero keywords — refusing to test with an empty vocabulary.");
		process.exit(1);
	}
	return kws;
}


/**
 * Fixtures + MUTATION CONTROLS.
 *
 * A self-test whose expected values are computed by the implementation under test proves only
 * that the implementation agrees with itself (`.claude` memory: "a guard shipped with its fix is
 * tautological"). So every expected value below is hand-authored DATA in
 * scripts/lib/board-body-fixtures.json, and the suite additionally runs the overlap fixtures
 * against two DELIBERATELY WRONG matchers — byte equality, and the `startsWith`-with-no-separator
 * predicate board-dashboard.mjs actually shipped — and FAILS if either of them passes the suite.
 * If a broken matcher can satisfy the fixtures, the fixtures do not discriminate and a green here
 * means nothing.
 */
function runSelfTest() {
	let fails = 0;
	let checks = 0;
	/** Assert `actual` deep-equals `expected`, printing an ok/FAIL line. */
	const eq = (name, actual, expected) => {
		checks++;
		const a = JSON.stringify(actual);
		const e = JSON.stringify(expected);
		if (a === e) {
			console.log(`ok   - ${name}`);
		} else {
			fails++;
			console.error(`FAIL - ${name}: want ${e} got ${a}`);
		}
	};

	let fixtures;
	try {
		fixtures = JSON.parse(readFileSync(FIXTURES, "utf8"));
	} catch (error) {
		console.error(`self-test: could not read ${FIXTURES.pathname}: ${error.message}`);
		console.error("  Unreadable fixtures are a FAILURE, not an empty suite.");
		process.exit(1);
	}

	const scopeCases = Array.isArray(fixtures.scopeCases) ? fixtures.scopeCases : [];
	const overlapCases = Array.isArray(fixtures.overlapCases) ? fixtures.overlapCases : [];
	const boardCases = Array.isArray(fixtures.boardCases) ? fixtures.boardCases : [];
	// AN EMPTY SUITE IS A FAILURE — the same rule coordinate.sh's --self-test already applies to
	// its own cases. Asserting nothing is not passing.
	for (const [name, list] of [
		["scopeCases", scopeCases],
		["overlapCases", overlapCases],
		["boardCases", boardCases],
	]) {
		if (list.length === 0) {
			console.error(`self-test: ${FIXTURES.pathname} carries NO ${name} — asserting nothing is not passing.`);
			process.exit(1);
		}
	}

	// (1) the declaration parser, including its two failure modes.
	for (const c of scopeCases) {
		const got = readScope(c.body);
		eq(`scope parse: ${c.name}`, { status: got.status, globs: got.globs }, { status: c.status, globs: c.globs });
		if (Array.isArray(c.unusable)) {
			eq(`scope parse (unusable): ${c.name}`, got.unusable.map((u) => u.token), c.unusable);
		}
	}

	// (2) the overlap predicate, both directions, against hand-authored expectations.
	for (const c of overlapCases) {
		eq(`overlap: ${c.name}`, globsOverlap(c.a, c.b), c.overlap);
		eq(`overlap (commuted): ${c.name}`, globsOverlap(c.b, c.a), c.overlap);
	}

	// (3) MUTATION CONTROLS — the fixtures must be able to tell a right matcher from a wrong one.
	const naiveEquality = (a, b) => normalizeGlob(a) === normalizeGlob(b);
	/** The predicate board-dashboard.mjs shipped before #4115: prefix match with no separator. */
	const naivePrefix = (a, b) => {
		const norm = (g) => g.replace(/\*+$/g, "").replace(/\/+$/g, "");
		const x = norm(a);
		const y = norm(b);
		return x === y || x.startsWith(y) || y.startsWith(x);
	};
	for (const [name, mutant] of [
		["byte equality", naiveEquality],
		["dashboard's separator-less prefix match", naivePrefix],
	]) {
		checks++;
		const disagreements = overlapCases.filter((c) => mutant(c.a, c.b) !== c.overlap);
		if (disagreements.length > 0) {
			console.log(`ok   - mutation control: ${name} fails ${disagreements.length} fixture(s) — the suite discriminates`);
		} else {
			fails++;
			console.error(
				`FAIL - mutation control: ${name} PASSES every overlap fixture. The fixtures do not ` +
					"discriminate a correct matcher from a broken one, so a green above proves nothing. " +
					"Add a case the broken predicate gets wrong.",
			);
		}
	}

	// (4) the board audit's four verdicts, and the report text each one produces.
	for (const c of boardCases) {
		const audit = auditBoard(c.board);
		eq(`board verdict: ${c.name}`, audit.verdict, c.verdict);
		eq(
			`board collisions: ${c.name}`,
			audit.collisions.map((x) => [x.a.number, x.b.number]),
			c.collisions ?? [],
		);
		eq(`board gaps: ${c.name}`, audit.gaps.map((g) => g.number), c.gaps ?? []);
		eq(`board exit code: ${c.name}`, VERDICT_EXIT[audit.verdict], VERDICT_EXIT[c.verdict]);

		// The report must SAY something for every verdict — that is the whole defect #4115 names.
		const text = formatAudit(audit).join("\n");
		checks++;
		if (formatAudit(audit).length >= 2 && text.trim() !== "") {
			console.log(`ok   - board report is non-empty: ${c.name}`);
		} else {
			fails++;
			console.error(`FAIL - board report is non-empty: ${c.name}: the report printed nothing`);
		}
		// …and a board that could not be checked must NEVER render the clean marker. This is the
		// failing case the issue is about: silence, or a ✓, standing in for a check that never ran.
		checks++;
		const claimsClean = /✓ compared, no overlap/.test(text);
		const shouldClaimClean = c.verdict === "CLEAN" || c.verdict === "CLEAN-WITH-GAPS";
		if (claimsClean === shouldClaimClean) {
			console.log(`ok   - clean marker only when clean: ${c.name}`);
		} else {
			fails++;
			console.error(
				`FAIL - clean marker only when clean: ${c.name}: verdict ${audit.verdict} ` +
					`${claimsClean ? "printed" : "withheld"} the ✓ marker`,
			);
		}
		// A NOT-CHECKED or gapped board must name the units it could not read, by number.
		if ((c.gaps ?? []).length > 0) {
			checks++;
			const named = (c.gaps ?? []).every((n) => text.includes(`#${n}`));
			if (named) {
				console.log(`ok   - unreadable units are named: ${c.name}`);
			} else {
				fails++;
				console.error(`FAIL - unreadable units are named: ${c.name}: report omits one of ${c.gaps.join(", ")}`);
			}
		}
	}

	// (5) the workable-unit filter mirrors claim-work.sh's ready filter (minus the claimed rule).
	const unit = (labels) => ({ number: 1, title: "t", labels: labels.map((name) => ({ name })), body: "scope: a/**" });
	eq("workable: a ready class unit", isWorkableBoardUnit(unit(["class:backend", "wave:W1"])), true);
	eq("workable: a CLAIMED class unit is still workable", isWorkableBoardUnit(unit(["class:backend", "claimed"])), true);
	eq("workable: blocked is not", isWorkableBoardUnit(unit(["class:backend", "blocked"])), false);
	eq("workable: needs:human is not", isWorkableBoardUnit(unit(["class:backend", "needs:human"])), false);
	eq("workable: an epic is not", isWorkableBoardUnit(unit(["class:backend", "epic"])), false);
	eq("workable: no class: label is not a board unit", isWorkableBoardUnit(unit(["wave:W1"])), false);

	// ── (6) the possibly-shipped advisory, against MEASURED evidence ──────────────────────────
	//
	// The property under test is not "does it find things". It is WHAT IT CLAIMS: a mention alone
	// is suppressed, a scope hit is reported as a scope hit and never as a delivery, and everything
	// it could not compare is named rather than dropped. Every case is a real unit and a real PR
	// file list (see SHIPPED_FIXTURES).
	const kws = selfTestClosingKeywords();
	eq("closing vocabulary: read from board-pr.sh, and it spells the tenses out", kws.includes("fixes") && kws.includes("resolved"), true);

	for (const c of SHIPPED_FIXTURES.pathCases) {
		eq(`path in scope: ${c.name}`, pathInScope(c.path, c.globs) !== null, c.inScope);
	}

	// MUTATION CONTROLS on the path decision. If a broken predicate satisfies the path fixtures,
	// the fixtures do not discriminate and every green above means nothing.
	const alwaysIn = () => true;
	const byteEqual = (p, globs) => globs.some((g) => normalizeGlob(g) === normalizeGlob(p));
	const separatorlessPrefix = (p, globs) =>
		globs.some((g) => {
			const y = normalizeGlob(g).replace(/\*+$/g, "").replace(/\/+$/g, "");
			return normalizeGlob(p).startsWith(y);
		});
	for (const [name, mutant] of [
		["everything intersects", alwaysIn],
		["byte equality", byteEqual],
		["the dashboard's separator-less prefix match", separatorlessPrefix],
	]) {
		checks++;
		const wrong = SHIPPED_FIXTURES.pathCases.filter((c) => mutant(c.path, c.globs) !== c.inScope);
		if (wrong.length > 0) {
			console.log(`ok   - mutation control (paths): ${name} fails ${wrong.length} fixture(s)`);
		} else {
			fails++;
			console.error(
				`FAIL - mutation control (paths): ${name} PASSES every path fixture, so the fixtures do not ` +
					"discriminate a correct containment test from a broken one.",
			);
		}
	}

	/** One fixture unit as a one-unit board, so a tier can be asserted in isolation. */
	const auditOne = (c) =>
		auditShipped({
			board: [c.issue],
			merged: c.prs,
			closingKeywords: kws,
			debt: c.debt ? { [String(c.issue.number)]: c.debt } : {},
		});

	for (const c of SHIPPED_FIXTURES.units) {
		const audit = auditOne(c);
		const row = audit.rows.find((r) => r.n === c.issue.number);
		const tier = row?.tier ?? (audit.counts.referenced === 0 ? "not-considered" : audit.counts.nightly > 0 ? "nightly-exempt" : "mention-only");
		eq(`shipped tier: ${c.name}`, tier, c.tier);

		const text = formatShipped(audit).join("\n");
		// THE HEADLINE CLAIM. The advisory this replaces printed "verify vs origin/dev, close if
		// delivered" over a 0-for-40 predicate, and the cheapest way to clear it was to close 40
		// live units. No tier may invite that, and a scope hit least of all.
		checks++;
		if (/close if delivered/i.test(text)) {
			fails++;
			console.error(`FAIL - the report invites closing on evidence it does not have: ${c.name}`);
		} else {
			console.log(`ok   - no "close if delivered" anywhere in the report: ${c.name}`);
		}

		// A suppressed mention must be COUNTED and must not be listed. A counted-but-unlisted unit
		// is the difference between "we looked and it was noise" and "we never looked".
		if (c.tier === "mention-only" || c.tier === "nightly-exempt") {
			eq(`suppressed units are not listed: ${c.name}`, text.includes(`#${c.issue.number} `), false);
			eq(`…but the run still says it examined something: ${c.name}`, /examined \d+ open unit/.test(text), true);
		}
		// Everything reported names its unit, and everything that could not be compared says WHY.
		if (row) {
			eq(`the row names its unit: ${c.name}`, text.includes(`#${c.issue.number}`), true);
			if (c.tier === "cannot-compare") {
				eq(`a not-comparable row carries its reason: ${c.name}`, Boolean(row.why) && text.includes(row.why.slice(0, 24)), true);
			}
			// A tier that reports evidence must hand the reader the thing that actually settles it.
			// …and a unit that declares NO `check:` line must be told so, not left with a row that
			// looks settled. Three of the four measured scope hits declare none — that absence is
			// itself the finding, and the reader has to see it to know the issue's done-when is the
			// only thing left to read.
			if (c.tier === "touches" || c.tier === "closes-and-touches") {
				const check = readCheck(c.issue.body);
				eq(
					`the row hands over what settles it: ${c.name}`,
					check === null ? text.includes("declares no `check:` line") : text.includes(check),
					true,
				);
			}
		}
	}

	// The whole fixture board at once — the shape coordinate.sh actually runs.
	const whole = auditShipped({
		board: SHIPPED_FIXTURES.units.map((c) => c.issue),
		merged: SHIPPED_FIXTURES.units.flatMap((c) => c.prs),
		closingKeywords: kws,
		debt: Object.fromEntries(SHIPPED_FIXTURES.units.filter((c) => c.debt).map((c) => [String(c.issue.number), c.debt])),
	});
	const wholeText = formatShipped(whole).join("\n");
	eq(
		"whole board: every fixture unit lands in the tier it was measured in",
		SHIPPED_FIXTURES.units.map((c) => whole.rows.find((r) => r.n === c.issue.number)?.tier ?? null),
		SHIPPED_FIXTURES.units.map((c) => (["mention-only", "nightly-exempt", "not-considered"].includes(c.tier) ? null : c.tier)),
	);
	eq("whole board: the mention-only ones are counted, not dropped", whole.counts.mentionOnly, SHIPPED_FIXTURES.units.filter((c) => c.tier === "mention-only").length);
	eq("whole board: the nightly ones are exempt, not dropped", whole.counts.nightly, SHIPPED_FIXTURES.units.filter((c) => c.tier === "nightly-exempt").length);
	eq("whole board: a run that reports nothing still prints its summary", /examined \d+ open unit/.test(wholeText), true);

	// EVERY TIER THE RENDERER KNOWS MUST BE EXERCISED. Without this, deleting the three ⚑ cases
	// leaves a green suite that no longer tests the thing the unit exists for.
	for (const tier of ["touches", "closes-and-touches", "closes-only", "cannot-compare", "debt-recorded", "mention-only", "nightly-exempt"]) {
		checks++;
		if (SHIPPED_FIXTURES.units.some((c) => c.tier === tier)) {
			console.log(`ok   - the fixtures exercise the ${tier} tier`);
		} else {
			fails++;
			console.error(`FAIL - no fixture exercises the ${tier} tier — that branch is untested.`);
		}
	}

	// MUTATION CONTROLS on the ADVISORY ITSELF, stated as the two wrong predicates this unit exists
	// to rule out. Each must disagree with the measured expectations; if either can satisfy them,
	// the fixtures cannot tell the fix from the defect.
	const tierOf = (c) => (["mention-only", "nightly-exempt", "not-considered"].includes(c.tier) ? null : c.tier);
	for (const [name, mutant] of [
		// The predicate being replaced: a mention IS a delivery.
		["a mention is a delivery (the 40-for-40 predicate)", (c) => (c.tier === "not-considered" ? null : "touches")],
		// The obvious fix, taken one step too far: intersection PROVES delivery. The three ⚑ cases
		// are exactly the measurement that refutes it.
		["a scope hit PROVES delivery", (c) => (tierOf(c) === "touches" ? "closes-and-touches" : tierOf(c))],
	]) {
		checks++;
		const wrong = SHIPPED_FIXTURES.units.filter((c) => mutant(c) !== tierOf(c));
		if (wrong.length > 0) {
			console.log(`ok   - mutation control (advisory): "${name}" contradicts ${wrong.length} measured case(s)`);
		} else {
			fails++;
			console.error(`FAIL - mutation control (advisory): "${name}" agrees with every fixture. The suite cannot tell it from the fix.`);
		}
	}

	// The two ways this audit can fail to run at all. Both must SAY so rather than render an
	// all-clear, the same three-valued rule the collision half above is built on.
	for (const [name, input] of [
		["a board that is not an array", { board: null, merged: [] }],
		["a merged corpus that is not an array", { board: [], merged: null }],
	]) {
		const a = auditShipped(input);
		eq(`shipped audit refuses: ${name}`, a.ran, false);
		eq(`…and says NOT CHECKED: ${name}`, /NOT CHECKED/.test(formatShipped(a).join("\n")), true);
		eq(`…with a non-zero exit: ${name}`, SHIPPED_EXIT["NOT-CHECKED"], 4);
	}
	// A vocabulary that could not be read is a WITHHELD measurement, not a "no keyword" answer.
	const ctrl = SHIPPED_FIXTURES.units.find((c) => c.tier === "closes-and-touches");
	const noKw = auditShipped({ board: [ctrl.issue], merged: ctrl.prs, closingKeywords: [] });
	eq("no keyword vocabulary: the run says the keyword half was NOT CHECKED", /closing-keyword half was NOT CHECKED/.test(formatShipped(noKw).join("\n")), true);


	if (fails > 0) {
		console.error(`self-test: ${fails} of ${checks} check(s) FAILED`);
		process.exit(1);
	}
	console.log(`self-test: all ${checks} passed`);
}

// ── CLI ───────────────────────────────────────────────────────────────────────────────────────

/** Read all of stdin as a string. */
function readStdin() {
	try {
		return readFileSync(0, "utf8");
	} catch (error) {
		console.error(`could not read the board JSON from stdin: ${error.message}`);
		process.exit(1);
	}
}

// `pathToFileURL`, not string concatenation: a checkout path with a space or a non-ASCII
// character produces a different href than `file://` + the raw path, and the CLI would then
// silently do nothing — a script that exits 0 having performed nothing is the shape this module
// is written to make impossible.
const isMain = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
	const arg = process.argv[2] ?? "--report";
	if (arg === "--self-test") {
		runSelfTest();
	} else if (arg === "--report" || arg === "--json") {
		let board;
		try {
			board = JSON.parse(readStdin());
		} catch (error) {
			console.error(`the board JSON on stdin did not parse: ${error.message}`);
			process.exit(1);
		}
		const audit = auditBoard(board);
		if (arg === "--json") {
			console.log(JSON.stringify(audit, null, 2));
		} else {
			for (const line of formatAudit(audit)) console.log(line);
		}
		process.exit(VERDICT_EXIT[audit.verdict] ?? 1);
	} else if (arg === "--shipped-report" || arg === "--shipped-json") {
		// stdin is ONE object — `{board, merged, closingKeywords, debt}` — not the bare board the
		// two arms above take. The corpus of merged PRs carries file lists and runs to megabytes,
		// so it arrives on stdin like everything else here and never as an argv string: that is the
		// ARG_MAX break coordinate.sh's `fetch_merged_prs` header records, where a jq the kernel
		// refused to exec read as "found nothing" on every run for weeks.
		let input;
		try {
			input = JSON.parse(readStdin());
		} catch (error) {
			console.error(`the shipped-report input on stdin did not parse: ${error.message}`);
			process.exit(1);
		}
		const audit = auditShipped(input);
		if (arg === "--shipped-json") {
			console.log(JSON.stringify(audit, null, 2));
		} else {
			for (const line of formatShipped(audit)) console.log(line);
		}
		process.exit(audit.ran ? SHIPPED_EXIT.RAN : SHIPPED_EXIT["NOT-CHECKED"]);
	} else {
		console.error(
			`unknown arg: ${arg}\nusage: scope-overlap.mjs [--report|--json|--shipped-report|--shipped-json|--self-test]`,
		);
		process.exit(2);
	}
}
