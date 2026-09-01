#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
//
// CLAUDE.md §6's shared-surface table, made mechanical for every row where a token shape can carry
// the rule and the drift was measured — five of its seven, plus the section's closing "No stat-card
// strips". StatusBadge and the filter standard are the two that stay prose, and the list below says
// why each of them does.
//
// WHY THIS EXISTS. That table states its own reason — "if two pages disagree about how something
// looks or reads, the user is being told the product is two products" — and no row of it was
// guarded by anything. Measured on dev at af8d63dc: `projects.estimated_monthly_cost` is ONE
// `numeric` column and the console rendered it three ways, `$12.50/mo` in twelve places,
// `~$12/mo` in three and `€12.50` in one; in-app page titles rendered at FIVE sizes, from
// `text-base` to `text-4xl`. Neither `check:dead-code` (knip) nor `check:action-boundary` can see
// either, and packages/eslint-config carries no `no-restricted-syntax`.
//
// The rows added in #3615 were measured the same way, on an unmodified `dev`, and found 88 more
// occurrences: the SAME heading rung typeset at five sizes across 24 `<h2>`, 33 hand-rolled empty
// states at six different heights (four of them byte-identical across two sibling sheets), four
// stat-card strips against a ban with no qualifier on it, three grids standing in for tables, one
// raw `<table>`, two raw stacking levels in the gap the layer scale leaves empty, and the two money
// sites whose currency symbol reaches the number by a route the `$${` matcher cannot see.
//
//   node scripts/check-shared-surface.mjs
//   node scripts/check-shared-surface.mjs --self-test
//
// Do NOT pipe it. `node scripts/check-shared-surface.mjs | tail` reports TAIL's exit code, which
// is always 0, and every failure below becomes invisible.
//
// ── WHAT IS GUARDED, AND WHAT IS NOT ─────────────────────────────────────────────────────────
//
// Guarded, with the exact token shape and the exact directories, because "the @repo/format row is
// enforced" is the sentence a reader turns into "nothing else can drift":
//
//   @repo/format   `.toFixed(`, `.toLocaleDateString(`, `.toLocaleTimeString(`, and a literal `$`
//                  written in front of an interpolation (`` `$${n}` ``), in
//                  apps/console/{components,app,lib,hooks} — every top-level console directory
//                  that holds code. It reaches `lib/` because that is where the FOURTH spelling of
//                  the monthly cost was hiding: `lib/promotions/gates.ts` built a user-visible
//                  `Cost +$12.50/mo` by hand while three components had already been converted.
//
//   @repo/format   DIVISION by 1024, in apps/console/{components,app} ONLY. `lib/` is excluded
//                  from this one matcher on purpose and with evidence: six sites under
//                  `lib/cloud-providers/capabilities/**` divide a provider's MB by 1024 to
//                  normalise it into GB for the capabilities catalog. That is arithmetic on a
//                  datum, not a rendering, and `formatBytes` returns a STRING — it cannot be the
//                  answer there. Widening the matcher would have bought six allowlist entries
//                  that are not decisions.
//
//   @repo/format   MONEY THAT NEVER WRITES ITS OWN `$`, in apps/console/{components,app,lib,hooks}.
//                  Two shapes the `$${` matcher above structurally CANNOT see, because in neither
//                  of them is the currency symbol a literal next to the number:
//                  an interpolation sitting directly behind another (`` `${symbol}${n.toLocale…}` ``
//                  — the symbol is a VARIABLE), and a bare currency symbol handed to a component as
//                  a prop (`prefix="$"`). The header used to record `.toLocaleString(` as
//                  unguardable because a bare call is how a COUNT gets separators; that is still
//                  true, and neither matcher here looks at a bare call. What they look at is the
//                  SYMBOL arriving by another route.
//
//   @repo/ui/page-header   a raw `<h1>`, in apps/console/app/(private)/** and components/**.
//
//   @repo/ui/page-header   a raw `<h2>` or `<h3>`, same scope, as the SEPARATE `section_header`
//                  rule. This is a reversal of what this header said until #3615, and the reason it
//                  reversed is worth keeping: the old text argued that "a class-name match cannot
//                  tell a section heading from a bold label", and declined the row. That argument
//                  was about the CLASS NAME, and the matcher does not read one — a raw `<h2>` in
//                  the console is a heading whatever it is wearing, because the tag is the thing
//                  that lands in the accessibility tree. Measured when the rule was added: 24
//                  `<h2>` across at least five type scales (`text-[19px]`, `[17px]`, `[15px]`,
//                  `[14.5px]`, `text-lg`/`2xl`), so the same rung of the same document outline is
//                  rendered five sizes, and 17 `<h3>` under them. `PageHeader` takes `level={n}`
//                  for exactly this.
//
//   @repo/ui/empty  a CENTRED BLOCK STANDING IN FOR CONTENT, in apps/console/{components,app}: one
//                  class string carrying both `text-center` and `py-6`…`py-16`. The vertical
//                  padding is the whole shape — it is what separates a block placed where rows
//                  would have been from a centred label, a table cell, or a caption, none of which
//                  buy themselves 24px of air. Measured: 33 of them across six different heights.
//
//   no stat-card strip  a container element opening directly onto a `<Stat`, and the `Stat` cell
//                  primitive itself, in apps/console/{components,app}. §6's ban is one line with no
//                  qualifier ("No stat-card strips"), and both halves have to be matched or fixing
//                  it looks like moving it: deleting a strip while leaving the primitive it was
//                  built from leaves the next strip one import away.
//
//   a `--z-*` token  a RAW stacking level of 40 or more, in apps/console/{components,app}. Not
//                  every bare `z-*`: `packages/brand/src/tokens.css` puts its in-flow lifts at
//                  10/20/30 and starts the page chrome at 100, so a bare `z-10` is an unnamed rung
//                  that nevertheless IS a rung, while `z-40` and `z-50` name a level in the gap the
//                  scale deliberately leaves empty — below the header, below every overlay, above
//                  every in-flow lift. That is not a style preference: the hand-rolled combobox
//                  popover at `z-50` paints UNDER the site header. `z-[95]` and any other
//                  arbitrary numeric value are matched for the same reason; `z-[var(--z-overlay)]`
//                  is the fix and is not matched.
//
//   DataTable       a grid used as a table, and a raw `<table>`, in apps/console/{components,app}.
//                  This too is a reversal, and the old text set the bar it had to clear: the a11y
//                  defect "needs a SHAPE test — a header row, repeated row children — not a
//                  class-name match", because "a guard that cannot separate a layout from a table
//                  is noise, and noise is how a guard gets disabled". So it is a shape test. A
//                  match needs THREE things in one class string: `grid`, a BRACKETED column
//                  template (`grid-cols-[2fr_1fr_auto]` — somebody spelling out column widths,
//                  which is what a table has and an N-up card grid does not), that template
//                  UNPREFIXED by a breakpoint, and a row marker (`uppercase`, the typesetting of a
//                  `<th>`, or `hover:bg-`, which only a row highlights on). The breakpoint test is
//                  the one that carries it: a table's columns are the same at every width, so
//                  `lg:grid-cols-[280px_1fr]` is a page layout stacking on a phone and is not a
//                  table. Measured: 22 bracketed-template sites in the console, 19 of them honest
//                  layouts, 3 matches in 2 files — plus the one raw `<table>`, which is the same
//                  defect arriving from the other direction (a real table element that is not
//                  `@repo/ui/table`, so it agrees with nothing).
//
// NOT guarded, and the omission is stated here rather than left for a reader to infer that the
// whole table is enforced:
//
//   StatusBadge      — 33 files, the best-adopted row, and the one with no negative form to match:
//                      the defect is "a `<Badge>` plus a LOCAL colour map", and a local colour map
//                      is an object literal, which is exactly the thing a token-shape scan cannot
//                      tell from any other object literal. #3622 and #3623 name the live ones.
//   EmptyState's negative form — "a page that should have shown an empty state and showed nothing"
//                      is not a grep either, and the matcher above cannot see it: it finds the
//                      empty states somebody wrote by hand, never the ones nobody wrote at all.
//   the filter standard's server half — `apps/console/lib/queries/facets.ts` and the `query*Page`
//                      builders. "A facet pass sees only the scope predicates" is a real check and
//                      a real unit test; it is not a text match.
//   `date-fns` direct — 11 console files still import `formatDistanceToNow` rather than
//                      `formatRelative`. A bare import name is a weak signal (the package has
//                      honest non-formatting uses), so this row is prose, not a matcher.
//   a bare `.toLocaleString(…)` — still not matched, and for the reason first recorded here: with
//                      no options it is the correct way to put separators in a COUNT and appears
//                      ~20 times, so no shape separates the money sites from the counts. The two
//                      money matchers above do not relax this — they match the SYMBOL's route in,
//                      never the call.
//   a NEGATIVE `-z-*`  — none exist, and a level below the flow is a different question from
//                      claiming one above it.
//
// ── HOW IT MATCHES ───────────────────────────────────────────────────────────────────────────
//
// Node ships no TypeScript parser and this repo's worktrees are de-hydrated (no node_modules), so
// a real parse is not available — the same constraint scripts/ts-coverage.mjs states for itself.
// What it does instead is match TOKEN SHAPES on comment-stripped source: a leading `.` and a
// trailing `(` for a member call, a following `[\s/>]` for a JSX tag, a leading `/` for a DIVISION
// (so `10 * 1024 * 1024` defining a size limit is not a byte rendering and is not flagged).
//
// Matching runs over a TWO-LINE WINDOW, and a match counts only when it STARTS on the first of the
// pair, so every match is found exactly once and attributed to the line it opens on. A line at a
// time was not enough: Prettier and Biome break a binary expression after the operator, so
// `bytes /\n\t1024` is one edit away from any flagged division and a per-line matcher reads it as
// clean — the direction that reports green. The same window is what lets `<h1` be found when the
// className sits on the next line.
//
// The comment stripper is deliberately line-oriented: whole-line `//`, and block comments that
// OPEN a line (`/*`, `/**`) plus JSX comments (`{/*`) anywhere quotes are balanced ahead of them.
// It does not try to find a trailing `//`, because telling one from `"https://…"` inside a JSX
// string needs the parser we do not have — and getting THAT wrong blanks live code, which makes
// the guard report green on what it never read. A trailing comment that happens to contain
// `.toFixed(` is a false positive instead: loud, and fixable. That asymmetry is the whole reason
// for the choice, and it is why an unterminated block comment REFUSES the file rather than
// blanking the rest of it.
//
// The same asymmetry has a second consequence worth stating, because it is a real cost and not a
// bug to be fixed later: a matcher fires inside an ordinary string literal too. A console file
// holding `const HTML = "<h1>Hi</h1>"` reds this check. That is the loud direction, and the remedy
// is to move the sample out of the console tree — not an allowlist entry, which this file reserves
// for decisions about real surfaces.
//
// HOW IT KNOWS IT LOOKED. Five controls, because each catches something the others cannot, and
// this guard was reviewed for reporting a clean tree over files it never opened:
//   - a per-ROOT and per-EXTENSION floor of one file, per scope. Catches a root that moved, an
//     extension list that was edited, a walker that broke.
//   - a per-scope CENSUS FLOOR checked into apps/console/shared-surface-allowlist.yaml. This is
//     the only one that sees a root DELETED from the scope declaration above, because the per-root
//     check is BUILT from that declaration: with `apps/console/app` removed, every remaining root
//     was healthy and the run printed `✓` over 299 unread route files.
//   - a directory the walker cannot read RAISES rather than counting as empty.
//   - an unterminated block comment REFUSES its file rather than being scanned blank.
//   - a permanent PROBE and ANTI-PROBE per matcher, fired on every run. The others prove the guard
//     read the tree; this one proves each matcher can still find and still discriminate, which is
//     the control that has to outlive the drift — the day the last entry is fixed there is nothing
//     else left to notice a matcher that has quietly stopped matching.
//
// ── WHY THERE ARE TWO LEDGERS, AND WHY THE SECOND ONE IS NOT AN ALLOWLIST ─────────────────────
//
// The exception list has always said an entry is a DECISION and never "we haven't got to it yet",
// which is the right rule and the reason the eleven `page_header` reasons are worth reading. It is
// also, on its own, a rule that stops a guard from ever being ADDED to a surface that has already
// drifted: the six rules above were measured on an unmodified `dev` and found 88 occurrences, and
// there is no honest sentence in the product's voice that calls any of them a different thing.
// Writing 88 fake decisions would empty the word "decision" of meaning; leaving the guard red would
// mean it never lands, which is how the drift got to 88.
//
// So an entry is one of two kinds, and the file says which:
//   `reason:` — a DECISION. This surface is genuinely different. Counts against `baseline`.
//   `lifts:`  — DEBT. Measured drift, kept per file and per occurrence so it can only shrink, and
//               naming the board issue that removes it. Counts against `debt`, never `baseline`.
// Both numbers are checked in BOTH directions, so neither can grow and neither can be under-spent.
// Everything else — the per-occurrence `hits`, the entry-matches-nothing failure, the printed
// text — is identical, because a debt row is a measurement and has to be as precise as a decision.
//
// The guard cannot match itself: its scopes are all under `apps/console/**` and it lives in
// `scripts/`, and its fixtures are strings held in this file, never files on disk. The self-test
// asserts both.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const ROOT = path.resolve(import.meta.dirname, "..");
const ALLOWLIST = "apps/console/shared-surface-allowlist.yaml";

/**
 * A separator that cannot occur in a rule id or a repo path. Written as an ESCAPE, never as a
 * literal byte: three raw NULs in this file's source made `rg` and `grep -r` classify it as
 * binary and refuse to print any line of it, for a guard whose entire value is that the next
 * reader can find and read its stated scope.
 */
const SEP = "\u0000";

/**
 * Where a matcher is allowed to look. Named, because two matchers in the SAME rule need different
 * answers — see the byte-division note in the header — and because the vacuity check below reports
 * per root and per extension, which needs the pair to still be visible at check time.
 */
const SCOPES = {
	// Every top-level console directory that holds code. `lib/` and `hooks/` are in it because a
	// user-visible string does not stop being one for living outside a component.
	console_code: {
		roots: ["apps/console/components", "apps/console/app", "apps/console/lib", "apps/console/hooks"],
		exts: [".ts", ".tsx"],
	},
	// The rendering layer only. See the header for why the byte matcher stops here.
	console_view: {
		roots: ["apps/console/components", "apps/console/app"],
		exts: [".ts", ".tsx"],
	},
	// In-app pages. `app/(public)/**` is out on purpose: those routes are the signed-out,
	// marketing-shaped surfaces the allowlist's display-heading reason already covers, and they
	// are not "in-app page titles" at all.
	console_pages: {
		roots: ["apps/console/app/(private)", "apps/console/components"],
		exts: [".tsx"],
	},
};

/**
 * The guarded rows. `id` is also the allowlist's section name, so a section this file does not
 * know about is a parse error rather than a silently ignored block of exceptions.
 */
const RULES = [
	{
		id: "format",
		surface: "@repo/format",
		matchers: [
			{
				scope: "console_code",
				re: /\.\s*toFixed\s*\(/g,
				say: "hand-rolls decimals with `toFixed`. Use `formatMonthlyRate` for a monthly cost, `formatMoney` for a billed amount (it takes CENTS), or `formatMinutes`/`formatBytes`/`formatDuration`.",
				probe: "const s = `$${cost.toFixed(2)}/mo`;",
				antiProbe: "const toFixed = 1;",
			},
			{
				scope: "console_code",
				re: /\.\s*toLocaleDateString\s*\(/g,
				say: "builds its own date. Use `formatDate` — it fixes the locale and documents the server/client timezone hydration trap this call site is exposed to.",
				probe: "const d = new Date(v).toLocaleDateString();",
				antiProbe: "const d = v.toLocaleString();",
			},
			{
				scope: "console_code",
				re: /\.\s*toLocaleTimeString\s*\(/g,
				say: "builds its own time. Use `formatRelative` for a feed, or `formatDate(value, \"time\")` for a log gutter.",
				probe: "const t = new Date(v).toLocaleTimeString();",
				antiProbe: "const t = v.toLocaleString();",
			},
			{
				// A literal `$` in front of an interpolation. Measured before adding it: seven hits
				// in the whole console and all seven were money, including the two file-local
				// `currency()` helpers that rendered `estimated_monthly_cost` a second way and the
				// promotion-gate detail string that rendered it a third. It is the shape that
				// separates a hand-written currency symbol from a formatted quantity, which
				// `toLocaleString` alone cannot do.
				scope: "console_code",
				re: /\$\$\{/g,
				say: "writes its own currency symbol in front of a number. Use `formatMonthlyRate` for a recurring cost or `formatMoney` for a billed amount — they own the symbol, the separators and the decimals, so two screens cannot disagree about them.",
				probe: "const s = `$${n}`;",
				antiProbe: "const s = `${n}`;",
			},
			{
				// A DIVISION by 1024 is a byte rendering. A multiplication is a size limit
				// (`10 * 1024 * 1024`) and is not one, which is why the leading `/` is required.
				scope: "console_view",
				re: /\/\s*\(?\s*1024\b/g,
				say: "divides bytes by 1024 by hand. Use `formatBytes`, which steps the units and keeps one decimal only above kilobytes.",
				probe: "const mb = bytes / (1024 * 1024);",
				antiProbe: "const MAX = 10 * 1024 * 1024;",
			},
			{
				// MONEY BEHIND A VARIABLE. `$${` cannot see this one: the symbol is chosen at run
				// time (`const symbol = currency === "eur" ? "€" : "$"`), so nothing in the source
				// puts a `$` in front of the number. What IS in the source is an interpolation
				// sitting directly against another whose expression formats a number — no
				// separator, no space, no text between them, which is what glueing a symbol onto a
				// figure looks like and what a sentence built from two values never does.
				scope: "console_code",
				re: /\}\$\{[^`{}\n]*\.\s*toLocaleString\s*\(/g,
				say: "glues a run-time currency symbol onto a formatted number. Use `formatMoney` (it takes CENTS) or `formatMonthlyRate` — they own the symbol for every currency, so a checkout and an invoice cannot disagree about how €12.50 is written.",
				probe: "const s = `${symbol}${n.toLocaleString(\"en-US\")}`;",
				// The anti-probe varies the axis that MATTERS, which is not the one it first varied.
				// Two interpolations with a separator between them (`${a} / ${b.toLocaleString()}`)
				// tests the adjacency and leaves the CONTENT untested — and adjacency alone is 48
				// sites in this console, almost all of them an id glued to a suffix. Widening the
				// matcher to a bare `}${` was the one mutation the anti-probes did not kill.
				antiProbe: "const s = `${context.resource_type}${suffix}`;",
			},
			{
				// MONEY BEHIND A PROP. The symbol is not next to the number here either — it is
				// handed to a component that renders `{prefix}{n}` somewhere else entirely. A JSX
				// attribute whose whole value is a currency symbol is the one shape that survives
				// that hand-off, and it is worth matching precisely because the render site is
				// unreachable: `{prefix}` on one line and `{n}` on the next is not a money shape.
				//
				// `\w+=` with no space around it is a JSX attribute and not an assignment, because
				// the formatter puts spaces around `=` in `const symbol = "$"` — measured: one hit
				// in the whole console, the prop. If that ever stops being true the cost is a false
				// positive, which is the loud direction.
				scope: "console_code",
				re: /\w+=["'][$€£¥]["']/g,
				say: "passes a currency symbol to a component as a prop, which puts the symbol at one end of a prop and the number at the other. Use `formatMoney`/`formatMonthlyRate` at the call site and hand the component the finished string.",
				probe: 'const a = <Stat n={12} prefix="$" />;',
				antiProbe: 'const a = <Stat n={12} prefix="~" />;',
			},
		],
	},
	{
		id: "page_header",
		surface: "@repo/ui/page-header",
		matchers: [
			{
				// `|$` for the last line of a file, where the two-line window has no next line to
				// supply the `\s` that error-state.tsx's `<h1`-then-className shape matches on.
				scope: "console_pages",
				re: /<h1(?=[\s/>]|$)/g,
				say: "hand-writes a page title. Use `PageHeader` from `@repo/ui/page-header`, with `level` when it heads a section rather than the page.",
				probe: 'const a = <h1 className="text-2xl">Clusters</h1>;',
				antiProbe: "const a = <h10>x</h10>;",
			},
		],
	},
	{
		// A SEPARATE rule from `page_header`, not two more matchers inside it, because the allowlist
		// is keyed per file per SECTION: a file carrying an allowlisted `<h1>` and a new `<h2>` would
		// otherwise merge into one entry whose recorded reason describes only the `<h1>`, and the
		// per-occurrence ratchet would be spent on a heading nobody decided about.
		id: "section_header",
		surface: "@repo/ui/page-header with `level`",
		matchers: [
			{
				scope: "console_pages",
				re: /<h2(?=[\s/>]|$)/g,
				say: "hand-writes a section heading. Use `PageHeader` with `level={2}` — it owns the one size, weight and spacing a second-level heading gets, which is why the console currently renders that same rung at five different sizes.",
				probe: 'const a = <h2 className="text-lg font-semibold">Usage</h2>;',
				antiProbe: "const a = <h20>x</h20>;",
			},
			{
				scope: "console_pages",
				re: /<h3(?=[\s/>]|$)/g,
				say: "hand-writes a third-level heading. Use `PageHeader` with `level={3}`, so a heading nested under a section is a rung of one outline rather than whatever size its own file chose.",
				probe: 'const a = <h3 className="text-sm font-semibold">Members</h3>;',
				antiProbe: "const a = <h30>x</h30>;",
			},
		],
	},
	{
		id: "empty_state",
		surface: "@repo/ui/empty",
		matchers: [
			{
				// One class string carrying BOTH `text-center` and a vertical padding of 6 or more.
				// The padding is the discriminator and it is doing real work: `text-center` alone is
				// 73 sites, most of them a centred cell, a caption or a label. A block that also buys
				// itself 24px or more of air above and below is standing where rows would have been,
				// which is the definition of an empty state and nothing else's.
				//
				// `[^"\n]*` and not `[^"]*`: a JS string cannot contain a raw newline, so a pair of
				// quotes spanning one would be the CLOSING quote of this line married to an OPENING
				// quote of the next — a match assembled out of two unrelated strings.
				scope: "console_view",
				re: /"(?=[^"\n]*\btext-center\b)(?=[^"\n]*\bpy-(?:[6-9]|1[0-6])\b)[^"\n]*"/g,
				say: "hand-rolls an empty state. Use `EmptyState` from `@repo/ui/empty` — six different heights of centred nothing is six answers to the same question, and the one thing a user meets when a list is empty should not change shape between two pages.",
				probe: 'const a = <div className="px-4 py-16 text-center">No runners yet</div>;',
				antiProbe: 'const a = <td className="px-3 py-2.5 text-center">{v}</td>;',
			},
		],
	},
	{
		// §6 ends on one unqualified line: "No stat-card strips." Both halves are matched — the
		// strip and the cell primitive it is built from — because fixing only the first looks
		// identical to moving it.
		id: "stat_strip",
		surface: "no stat-card strip",
		matchers: [
			{
				// A container element opening DIRECTLY onto a `<Stat`. The two-line window is what
				// makes this readable at all: in all four live strips the container is on one line
				// and the first cell on the next, which a per-line matcher reads as clean. The `|$`
				// on the end matters as much: in two of the four the cell's own props wrap, so
				// `<Stat` ENDS the window and a lookahead demanding a following character misses
				// exactly the strips whose formatting is loosest.
				scope: "console_view",
				re: /<(?:div|section|dl)\b[^>]*>\s*<Stat(?=[\s/>]|$)/g,
				say: "lays out a stat-card strip. CLAUDE.md §6 bans them outright, with no qualifier: a row of big numbers tells the reader what is countable rather than what to do, and it takes the space the thing they came for was going to occupy.",
				probe: '<div className="grid grid-cols-4">\n\t<Stat label="Jobs" value={n} />',
				antiProbe: '<div className="grid grid-cols-4">\n\t<StatusBadge tone="ok" />',
			},
			{
				// The primitive. Without this the fix is one import away from being undone, and the
				// two live copies of it already disagree — one renders a label above the figure, the
				// other a caption below. `function Stat` and not also `const Stat = (` because both
				// live copies are declarations and a second alternative would be a shape with no
				// occurrence to prove it still matches — the probe would be the only thing holding
				// it, which is exactly the arrangement this file spent its census floors avoiding.
				scope: "console_view",
				re: /\bfunction Stat\s*\(/g,
				say: "defines a stat-card cell. Delete it with the strip it feeds — a `Stat` primitive left behind is the next strip's first line, and the console already carries two copies of this one that disagree about where the label goes.",
				probe: "function Stat({ label, value }) { return null; }",
				antiProbe: "function StatusDot({ status }) { return null; }",
			},
		],
	},
	{
		id: "layer_token",
		surface: "a `--z-*` token from packages/brand/src/tokens.css",
		matchers: [
			{
				// 40 and above — the gap (40..99) and everything past the chrome (100+) — plus any
				// arbitrary NUMERIC value. See the header: the scale's in-flow lifts stop at 30 and
				// its chrome starts at 100, so 0/10/20/30 are rungs written without their names
				// while anything above is a level nobody agreed on. `(?<![-:\w])` keeps the matcher
				// off `--z-overlay` itself, which is how the token is spelled everywhere it is used
				// correctly; a NEGATIVE `-z-*` is excluded by the same lookbehind, and the header
				// says why that is the right call rather than an accident.
				scope: "console_view",
				re: /(?<![-:\w])z-(?:[4-9]\d|\d{3,}|\[\d)/g,
				say: "picks its own stacking level. Use a `--z-*` token — `z-[var(--z-overlay)]` for anything that floats over the page. The scale's in-flow lifts stop at 30 and its chrome starts at 100, so a level in between paints UNDER the site header and under every real overlay, whatever it was reaching over.",
				probe: 'const a = <div className="absolute z-50 bg-popover" />;',
				antiProbe: 'const a = <div className="absolute z-[var(--z-overlay)] bg-popover" />;',
			},
		],
	},
	{
		id: "data_table",
		surface: "DataTable, or @repo/ui/table",
		matchers: [
			{
				// THE SHAPE TEST this row waited for. Two things in one class string: a BRACKETED
				// column template that is NOT behind a breakpoint (which is a grid by construction —
				// nothing else spells its columns out), and a row marker, `uppercase` for a header
				// row or `hover:bg-` for a data row. See the header for why the breakpoint test is
				// the one that carries it.
				scope: "console_view",
				re: /"(?=[^"\n]*(?<![-:\w])grid-cols-\[)(?=[^"\n]*(?:\buppercase\b|\bhover:bg-))[^"\n]*"/g,
				say: "builds a table out of a grid. Use `DataTable`, or `@repo/ui/table` for a shape it cannot express — a `<div className=\"grid\">` reads to a screen reader as a stack of buttons, so these columns reach a blind user unlabelled.",
				probe: 'const a = <div className="grid grid-cols-[2fr_1fr] uppercase tracking-[0.1em]" />;',
				antiProbe: 'const a = <div className="grid grid-cols-1 gap-4 lg:grid-cols-[280px_1fr] hover:bg-muted/30" />;',
			},
			{
				// The same defect from the other side: a real `<table>` that is not `@repo/ui/table`,
				// so it agrees with nothing about padding, borders, header type or the empty row.
				scope: "console_view",
				re: /<table(?=[\s/>]|$)/g,
				say: "hand-writes a table element. Use `DataTable`, or `@repo/ui/table` — a raw `<table>` agrees with no other table in the console about its header type, its row rule or what it shows when there is nothing in it.",
				probe: 'const a = <table className="w-full">{rows}</table>;',
				antiProbe: "const a = <Table>{rows}</Table>;",
			},
		],
	},
];

// ── source scanning ───────────────────────────────────────────────────────────────────────────

/**
 * True when every quote character is closed before `index` on this line, i.e. `index` is NOT
 * inside a string literal that opened on this line.
 *
 * This is the cheapest honest answer available without a parser, and it exists for one shape:
 * `const g = "a{/*}b"` used to latch the block-comment state from inside a string and blank every
 * line after it. It is deliberately conservative in the LOUD direction — an apostrophe in JSX text
 * (`<p>Don't</p>{/* note *\/}`) leaves the counts odd, so the comment after it is scanned as code
 * and can only produce a false positive, never a skipped line.
 *
 * @param {string} line
 * @param {number} index
 * @returns {boolean}
 */
function quotesClosedBefore(line, index) {
	let dq = 0;
	let sq = 0;
	let bt = 0;
	for (let i = 0; i < index; i++) {
		const c = line[i];
		if (c === "\\") {
			i++;
			continue;
		}
		if (c === '"') dq++;
		else if (c === "'") sq++;
		else if (c === "`") bt++;
	}
	return dq % 2 === 0 && sq % 2 === 0 && bt % 2 === 0;
}

/**
 * Blank every comment, line by line, keeping one output line per input line so a finding's line
 * number is still true. See the header for why trailing comments are left alone.
 *
 * @param {string} source
 * @returns {{lines: string[], unterminated: boolean}} `unterminated` when a block comment was still
 *   open at EOF — the one state in which this function has blanked live code, so the caller must
 *   refuse the file rather than report it clean.
 */
export function stripComments(source) {
	/** @type {string[]} */
	const out = [];
	let inBlock = false;
	for (const line of source.split("\n")) {
		if (inBlock) {
			const end = line.indexOf("*/");
			if (end === -1) {
				out.push("");
				continue;
			}
			inBlock = false;
			out.push(line.slice(end + 2));
			continue;
		}
		const trimmed = line.trimStart();
		if (trimmed.startsWith("//")) {
			out.push("");
			continue;
		}
		// `{/*` is taken anywhere on the line PROVIDED the quotes ahead of it are closed: a brace
		// followed by a block-comment open, outside a string, is a JSX comment and can be nothing
		// else. A bare `/*` is only taken when it OPENS the line, because mid-line it is
		// indistinguishable from a glob inside a string ("apps/*\/**") and blanking from there
		// would swallow live code — the direction that reports green.
		const jsx = line.indexOf("{/*");
		const jsxOpen = jsx !== -1 && quotesClosedBefore(line, jsx) ? jsx + 1 : -1;
		const open = jsxOpen !== -1 ? jsxOpen : trimmed.startsWith("/*") ? line.indexOf("/*") : -1;
		if (open === -1) {
			out.push(line);
			continue;
		}
		const end = line.indexOf("*/", open + 2);
		if (end === -1) {
			inBlock = true;
			out.push(line.slice(0, open));
			continue;
		}
		out.push(line.slice(0, open) + line.slice(end + 2));
	}
	return { lines: out, unterminated: inBlock };
}

/**
 * Every guarded file in a scope, repo-relative and posix-separated, plus the per-(root, extension)
 * census the vacuity check reads.
 *
 * @param {{roots: string[], exts: string[]}} scope
 * @param {(dir: string) => string[]} listDir directory lister, injected for the self-test
 * @returns {{files: string[], census: Map<string, number>}} census keys are `root SEP ext`
 */
export function filesFor(scope, listDir) {
	/** @type {string[]} */
	const found = [];
	/** @type {Map<string, number>} */
	const census = new Map();
	for (const root of scope.roots) for (const ext of scope.exts) census.set(`${root}${SEP}${ext}`, 0);

	/** @param {string} dir @param {string} root */
	const walk = (dir, root) => {
		for (const entry of listDir(dir)) {
			if (entry === "node_modules" || entry === ".next" || entry === "dist") continue;
			const child = `${dir}/${entry}`;
			const kids = listDir(child);
			if (kids.length > 0) {
				walk(child, root);
				continue;
			}
			const ext = scope.exts.find((e) => child.endsWith(e));
			if (ext === undefined) continue;
			found.push(child);
			const key = `${root}${SEP}${ext}`;
			census.set(key, (census.get(key) ?? 0) + 1);
		}
	};
	for (const root of scope.roots) walk(root, root);
	// A directory can appear under two roots (components/** is a root of several scopes, and
	// app/(private) sits under app/); one file must not be reported twice. The census counts
	// before the de-duplication on purpose — it is measuring whether each ROOT still resolves.
	return { files: [...new Set(found)].sort(), census };
}

/**
 * @typedef {{rule: string, file: string, line: number, say: string, text: string}} Finding
 */

/**
 * Every rule match in the tree, allowlisted or not.
 *
 * @param {(p: string) => string} readFile
 * @param {(dir: string) => string[]} listDir
 * @returns {{findings: Finding[], census: Map<string, number>, perRule: Map<string, number>, unterminated: Set<string>}}
 *   census keys are `scopeId SEP root SEP ext`; only scopes a matcher actually uses appear.
 */
export function scan(readFile, listDir) {
	/** @type {Finding[]} */
	const findings = [];
	/** @type {Map<string, {files: string[], census: Map<string, number>}>} */
	const scopeCache = new Map();
	/** @type {Map<string, string[]>} */
	const strippedCache = new Map();
	/** @type {Map<string, number>} */
	const census = new Map();
	/** @type {Map<string, number>} */
	const perRule = new Map();
	/** @type {Set<string>} */
	const unterminated = new Set();

	/** @param {string} id */
	const scopeFiles = (id) => {
		let hit = scopeCache.get(id);
		if (hit === undefined) {
			hit = filesFor(SCOPES[id], listDir);
			scopeCache.set(id, hit);
			for (const [pair, n] of hit.census) census.set(`${id}${SEP}${pair}`, n);
		}
		return hit.files;
	};

	for (const rule of RULES) {
		/** @type {Set<string>} */
		const seen = new Set();
		for (const matcher of rule.matchers) {
			for (const file of scopeFiles(matcher.scope)) {
				seen.add(file);
				let lines = strippedCache.get(file);
				if (lines === undefined) {
					const stripped = stripComments(readFile(file));
					// NOT a Finding: an allowlist entry for this file would swallow it, and this is
					// a statement about what the check READ, which no exception can grant.
					if (stripped.unterminated) unterminated.add(file);
					lines = stripped.lines;
					strippedCache.set(file, lines);
				}
				for (let i = 0; i < lines.length; i++) {
					const head = lines[i];
					// The two-line window. A match counts only when it STARTS in `head`, so one
					// wholly inside the next line is attributed to that line on the next turn
					// instead of being reported twice.
					const window = i + 1 < lines.length ? `${head}\n${lines[i + 1]}` : head;
					matcher.re.lastIndex = 0;
					let m;
					while ((m = matcher.re.exec(window)) !== null) {
						if (m.index < head.length) {
							findings.push({ rule: rule.id, file, line: i + 1, say: matcher.say, text: m[0] });
						}
						// A zero-width lookahead match (`<h1`) would loop forever without this.
						if (m.index === matcher.re.lastIndex) matcher.re.lastIndex++;
					}
				}
			}
		}
		perRule.set(rule.id, seen.size);
	}
	return { findings, census, perRule, unterminated };
}

// ── the allowlist ─────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {{section: string, path: string, hits: number, kind: "decision" | "debt" | null, note: string, line: number}} Entry
 * @typedef {{scope: string, floor: number, line: number}} Floor
 */

/**
 * A deliberately small reader for the allowlist. There is no js-yaml here — a worktree is
 * de-hydrated and this must run with plain `node` — so the grammar is fixed and narrow, and
 * ANYTHING it does not recognise is an error naming the line. A permissive reader that skipped
 * what it could not parse would turn a typo into a silently dropped exception, which is the one
 * failure mode an allowlist must not have.
 *
 * @param {string} text
 * @returns {{baseline: number, debt: number, entries: Entry[], floors: Floor[]}}
 */
export function parseAllowlist(text) {
	const known = new Set(RULES.map((r) => r.id));
	/** @type {Entry[]} */
	const entries = [];
	/** @type {Floor[]} */
	const floors = [];
	/** @type {Floor | null} */
	let floor = null;
	/** Section+path already claimed, so two entries cannot both count against a ledger. */
	const claimed = new Map();
	let baseline = null;
	let debt = null;
	let section = null;
	/** @type {Entry | null} */
	let current = null;
	/** @param {number} n @param {string} why */
	const bad = (n, why) => {
		throw new Error(`${ALLOWLIST}:${n}: ${why}`);
	};
	/** @param {number} n */
	const closeFloor = (n) => {
		if (floor === null) return;
		if (floor.floor === -1) bad(n, `the \`scanned\` entry for \`${floor.scope}\` has no \`floor:\``);
		floors.push(floor);
		floor = null;
	};
	/** @param {number} n */
	const closeEntry = (n) => {
		closeFloor(n);
		if (current === null) return;
		if (current.hits === -1) bad(n, `entry for \`${current.path}\` has no \`hits:\``);
		// An entry is one kind or the other, never both and never neither. "Neither" is the shape
		// that matters: it used to be caught as "no `reason:`", and a debt row is not a decision, so
		// the check has to be about the PAIR rather than about one field being present.
		if (current.kind === null) {
			bad(
				n,
				`entry for \`${current.path}\` has neither \`reason:\` nor \`lifts:\` — it must be one or the ` +
					"other: a `reason:` says this surface is genuinely a different thing (a DECISION, counted " +
					"against `baseline`), a `lifts:` records measured drift and names the board issue that " +
					"removes it (DEBT, counted against `debt`).",
			);
		}
		const key = `${current.section}${SEP}${current.path}`;
		const first = claimed.get(key);
		if (first !== undefined) {
			// Both would match the same findings, so the second is a free entry against `baseline`
			// and only one of the two reasons is the recorded decision.
			bad(current.line, `a second \`${current.section}\` entry for ${current.path} — the first is on line ${first}. One entry per file per section.`);
		}
		claimed.set(key, current.line);
		entries.push(current);
		current = null;
	};

	const lines = text.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const raw = lines[i];
		const n = i + 1;
		if (raw.trim() === "" || raw.trimStart().startsWith("#")) continue;

		let m = raw.match(/^baseline: (\d+)$/);
		if (m !== null) {
			closeEntry(n);
			if (baseline !== null) bad(n, "`baseline:` appears twice");
			baseline = Number(m[1]);
			continue;
		}
		m = raw.match(/^debt: (\d+)$/);
		if (m !== null) {
			closeEntry(n);
			if (debt !== null) bad(n, "`debt:` appears twice");
			debt = Number(m[1]);
			continue;
		}
		m = raw.match(/^([a-z_]+):$/);
		if (m !== null) {
			closeEntry(n);
			if (m[1] === "scanned") {
				section = "scanned";
				continue;
			}
			if (!known.has(m[1])) bad(n, `unknown section \`${m[1]}\` — the sections are scanned, ${[...known].join(", ")}`);
			section = m[1];
			continue;
		}
		m = raw.match(/^ {2}- scope: (\S+)$/);
		if (m !== null) {
			closeEntry(n);
			if (section !== "scanned") bad(n, "`- scope:` belongs to the `scanned:` section");
			floor = { scope: m[1], floor: -1, line: n };
			continue;
		}
		m = raw.match(/^ {4}floor: (\d+)$/);
		if (m !== null) {
			if (floor === null) bad(n, "`floor:` outside a `- scope:` entry");
			floor.floor = Number(m[1]);
			continue;
		}
		m = raw.match(/^ {2}- path: (\S+)$/);
		if (m !== null) {
			closeEntry(n);
			if (section === null) bad(n, "an entry before any section header");
			current = { section, path: m[1], hits: -1, kind: null, note: "", line: n };
			continue;
		}
		m = raw.match(/^ {4}hits: (\d+)$/);
		if (m !== null) {
			if (current === null) bad(n, "`hits:` outside an entry");
			current.hits = Number(m[1]);
			continue;
		}
		m = raw.match(/^ {4}reason: (.+)$/);
		if (m !== null) {
			if (current === null) bad(n, "`reason:` outside an entry");
			if (current.kind !== null) bad(n, `entry for \`${current.path}\` carries both \`reason:\` and \`lifts:\` — it is a decision or it is debt, and only one of them counts against a ledger.`);
			current.kind = "decision";
			current.note = m[1].trim();
			continue;
		}
		m = raw.match(/^ {4}lifts: (.+)$/);
		if (m !== null) {
			if (current === null) bad(n, "`lifts:` outside an entry");
			if (current.kind !== null) bad(n, `entry for \`${current.path}\` carries both \`reason:\` and \`lifts:\` — it is a decision or it is debt, and only one of them counts against a ledger.`);
			// DOUBLE-QUOTED, and the quotes are not decoration: the value has to start with `#`, and
			// a bare `#` opens a comment in every YAML reader that is not this one, so an unquoted
			// value would read as an empty `lifts:` to anything else that ever parses this file.
			const raw2 = m[1].trim();
			const note = /^".*"$/s.test(raw2) ? raw2.slice(1, -1) : null;
			// The issue number is the whole difference between debt and a mute button: it is what
			// keeps the work visible somewhere that is not this file. A `lifts:` that names no issue
			// is a decision wearing the other word.
			if (note === null || !/^#\d+\b/.test(note)) {
				bad(
					n,
					`the \`lifts:\` for \`${current.path}\` must be a quoted value naming the board issue that ` +
						'removes it — `lifts: "#1234 — what it is"`. Debt that names no issue is an exception with a ' +
						"nicer word on it, and an unquoted `#` reads as a comment to every other YAML reader.",
				);
			}
			current.kind = "debt";
			current.note = note;
			continue;
		}
		bad(n, `cannot parse \`${raw.trim().slice(0, 60)}\``);
	}
	closeEntry(lines.length);

	if (baseline === null) throw new Error(`${ALLOWLIST}: no \`baseline:\` — the list has no ratchet, so it is not shrink-only`);
	if (debt === null) throw new Error(`${ALLOWLIST}: no \`debt:\` — the measured drift has no ratchet, so it is not shrink-only`);
	return { baseline, debt, entries, floors };
}

// ── the check ─────────────────────────────────────────────────────────────────────────────────

/**
 * @param {(p: string) => string} readFile
 * @param {(dir: string) => string[]} listDir
 * @returns {{problems: string[], census: Map<string, number>, perRule: Map<string, number>, allowed: number, entries: number, decisions: number, debt: number}}
 */
export function check(readFile, listDir) {
	/** @type {string[]} */
	const problems = [];
	/** @type {Map<string, number>} */
	const empty = new Map();

	/** @type {{baseline: number, debt: number, entries: Entry[], floors: Floor[]}} */
	let list;
	try {
		list = parseAllowlist(readFile(ALLOWLIST));
	} catch (err) {
		return { problems: [String(err instanceof Error ? err.message : err)], census: empty, perRule: empty, allowed: 0, entries: 0, decisions: 0, debt: 0 };
	}

	// Structure before scanning: a matcher naming a scope that is not in SCOPES would otherwise
	// die inside `filesFor` and surface as an unreadable-tree error, pointing the reader at the
	// filesystem instead of at the typo three lines above.
	for (const rule of RULES) {
		if (rule.matchers.length === 0) problems.push(`the \`${rule.id}\` rule has no matchers, so it can never find anything.`);
		for (const matcher of rule.matchers) {
			if (!(matcher.scope in SCOPES)) {
				problems.push(
					`the \`${rule.id}\` rule has a matcher scoped to \`${matcher.scope}\`, which is not one of ` +
						`${Object.keys(SCOPES).join(", ")}. It would look at nothing.`,
				);
			}
			// The positive control below is `re.test(probe)` and `!re.test(antiProbe)`. A MISSING
			// antiProbe passes that silently — `test(undefined)` matches almost nothing — so the
			// widening half of the control would be absent and read exactly like a control that
			// held. The probe half fails loudly if it is missing; this makes both halves loud.
			for (const half of ["probe", "antiProbe"]) {
				if (typeof matcher[half] !== "string" || matcher[half] === "") {
					problems.push(
						`the \`${rule.id}\` matcher ${matcher.re} declares no \`${half}\`. Every matcher carries ` +
							"both, because they are the only control that outlives the drift: once the ledgers " +
							"reach 0 there is nothing else left to notice a matcher that has stopped matching.",
					);
				}
			}
		}
	}
	if (problems.length > 0) return { problems, census: empty, perRule: empty, allowed: 0, entries: list.entries.length, decisions: 0, debt: 0 };

	/** @type {{findings: Finding[], census: Map<string, number>, perRule: Map<string, number>, unterminated: Set<string>}} */
	let scanned;
	try {
		scanned = scan(readFile, listDir);
	} catch (err) {
		// A directory this check could not read is not a directory with nothing in it. Letting the
		// lister throw and reporting it here is the whole point — swallowing it dropped the
		// subtree from the scan and still printed a pass.
		return {
			problems: [`could not read the console tree: ${String(err instanceof Error ? err.message : err)}. This check has not seen every file, so it cannot report a pass.`],
			census: empty,
			perRule: empty,
			allowed: 0,
			entries: list.entries.length,
		};
	}
	const { findings, census, perRule } = scanned;

	// A file whose block comment never closed had everything after it blanked, so this check did
	// NOT read it. Same class as a dead root, and no allowlist entry can grant an exception to it.
	for (const file of scanned.unterminated) {
		problems.push(
			`${file}:1: opens a block comment that is never closed. Everything after it was blanked ` +
				"before matching, so this check has NOT read the rest of the file — close the comment " +
				"rather than trusting the green.",
		);
	}

	// VACUITY. "Found nothing" and "looked at nothing" must never share an exit code, and the unit
	// that can die is a ROOT or an EXTENSION, not a rule: with `app` dropped from the format rule's
	// roots the earlier per-rule check still saw 364 files from `components` and exited 0, having
	// read none of the 299 route files the drift table was written about. So both axes are
	// asserted, per scope.
	//
	// Not every (root, extension) PAIR can carry a floor — `apps/console/hooks` holds no `.tsx`
	// today and a floor there would be a check that fails for being true. Asserting each axis
	// separately is what a moved root or a one-character edit to `exts` actually trips.
	/** @type {Map<string, Map<string, number>>} */
	const byScope = new Map();
	for (const [key, n] of census) {
		const [scopeId, root, ext] = key.split(SEP);
		if (!byScope.has(scopeId)) byScope.set(scopeId, new Map());
		const m = byScope.get(scopeId);
		m.set(`root ${root}`, (m.get(`root ${root}`) ?? 0) + n);
		m.set(`ext ${ext}`, (m.get(`ext ${ext}`) ?? 0) + n);
	}
	for (const [scopeId, axes] of byScope) {
		for (const [axis, n] of axes) {
			if (n > 0) continue;
			problems.push(
				`the \`${scopeId}\` scope examined ZERO files for \`${axis}\`. That is not a pass — the ` +
					"root moved, the extension list was edited, or the walker broke. Fix this check rather " +
					"than trusting the green.",
			);
		}
	}

	// THE CENSUS FLOOR, and the reason it exists on top of the two axes above. Those axes are
	// built FROM the roots list, so a root DELETED from the declaration has no census row to be
	// zero — verified: reducing `console_code` to three roots left the check printing `✓` over 299
	// unread files in `apps/console/app`, which is the defect this guard was reviewed for. A
	// checked-in floor is the only control that sees an edit to the declaration itself, because
	// the declaration is the thing being edited.
	//
	// It ratchets the opposite way to `baseline`: files only grow, so this number may be RAISED
	// freely and a DROP is what review stops. The floors sit a few percent under the real count so
	// an ordinary refactor does not have to touch them; deleting that much of the console should
	// be looked at.
	/** @type {Map<string, number>} */
	const perScope = new Map();
	for (const [key, n] of census) {
		const [scopeId] = key.split(SEP);
		perScope.set(scopeId, (perScope.get(scopeId) ?? 0) + n);
	}
	const declared = new Set(list.floors.map((f) => f.scope));
	for (const scopeId of Object.keys(SCOPES)) {
		if (!declared.has(scopeId)) {
			problems.push(`${ALLOWLIST}: the \`scanned:\` section has no floor for the \`${scopeId}\` scope, so nothing would notice its roots being narrowed.`);
		}
	}
	for (const f of list.floors) {
		if (!(f.scope in SCOPES)) {
			problems.push(`${ALLOWLIST}:${f.line}: a floor for \`${f.scope}\`, which is not a scope. The scopes are ${Object.keys(SCOPES).join(", ")}.`);
			continue;
		}
		const seen = perScope.get(f.scope) ?? 0;
		if (seen < f.floor) {
			problems.push(
				`${ALLOWLIST}:${f.line}: the \`${f.scope}\` scope examined ${seen} file(s) against a floor of ` +
					`${f.floor}. Either a root was narrowed or renamed — fix the scope — or the console really ` +
					"did lose that many files, in which case lower the floor in the same commit and say why.",
			);
		}
	}
	// THE PERMANENT POSITIVE CONTROL. Every matcher is fired at a line it MUST hit and a line it
	// must NOT, on every run. The alternative — "the allowlist proves the matchers still match" —
	// is a control that expires: the day the last exception is fixed and `baseline` reaches 0, a
	// matcher that has quietly stopped matching would report a clean console instead.
	for (const rule of RULES) {
		for (const matcher of rule.matchers) {
			matcher.re.lastIndex = 0;
			if (!matcher.re.test(matcher.probe)) {
				problems.push(`the \`${rule.id}\` matcher ${matcher.re} no longer matches its own probe \`${matcher.probe}\` — it is dead, and a green run means nothing.`);
			}
			matcher.re.lastIndex = 0;
			if (matcher.re.test(matcher.antiProbe)) {
				problems.push(`the \`${rule.id}\` matcher ${matcher.re} has widened onto \`${matcher.antiProbe}\`, which is correct code — it will report drift that is not there.`);
			}
			matcher.re.lastIndex = 0;
		}
	}
	if (problems.length > 0) return { problems, census, perRule, allowed: 0, entries: list.entries.length, decisions: 0, debt: 0 };

	// Both ledgers are shrink-only, and each is checked in BOTH directions: growing is the drift
	// coming back, and shrinking without lowering the number leaves headroom nobody decided to
	// grant — the same reason the coverage floors are a checked-in file rather than a high-water
	// mark computed at run time. They are counted SEPARATELY so that neither can be spent as the
	// other: converting a debt row into a "decision" would otherwise be free, and that conversion
	// is exactly how a drift census turns back into a mute button.
	const ledgers = [
		{
			key: "baseline",
			want: list.baseline,
			have: list.entries.filter((e) => e.kind === "decision").length,
			noun: "recorded decision(s)",
			fix: "Fix the site to use the shared component instead of adding an exception.",
		},
		{
			key: "debt",
			want: list.debt,
			have: list.entries.filter((e) => e.kind === "debt").length,
			noun: "file(s) of measured drift",
			fix: "New drift is not debt — debt is what was measured when the rule landed. Fix the site.",
		},
	];
	for (const l of ledgers) {
		if (l.have > l.want) {
			problems.push(`${ALLOWLIST} has ${l.have} ${l.noun} against a \`${l.key}:\` of ${l.want}. This ledger only shrinks. ${l.fix}`);
		} else if (l.have < l.want) {
			problems.push(
				`${ALLOWLIST} is down to ${l.have} ${l.noun} from a \`${l.key}:\` of ${l.want} — a win. ` +
					`Lower \`${l.key}:\` to ${l.have} in the same commit, so it cannot be spent again.`,
			);
		}
	}

	// Every entry must still MATCH. This is the shrink-only half AND the positive control: the
	// allowlist guarantees a known number of live matches, so a matcher that quietly stops
	// matching reds here instead of reporting a clean tree.
	/** @type {Map<string, Finding[]>} */
	const byKey = new Map();
	for (const f of findings) {
		const key = `${f.rule}${SEP}${f.file}`;
		if (!byKey.has(key)) byKey.set(key, []);
		byKey.get(key).push(f);
	}
	let allowed = 0;
	/** @type {Set<string>} */
	const claimed = new Set();
	for (const entry of list.entries) {
		const key = `${entry.section}${SEP}${entry.path}`;
		claimed.add(key);
		const hits = byKey.get(key) ?? [];
		if (hits.length === entry.hits) {
			allowed += hits.length;
			continue;
		}
		// The recorded decision is printed with the failure, which is the only thing that makes
		// the allowlist's promise ("the guard prints it to anyone who trips over it") true — and
		// the reason is what tells the reader whether their new occurrence is the same case.
		const recorded =
			entry.kind === "debt"
				? `\n  The recorded DEBT for this file: ${entry.note}`
				: `\n  The recorded decision for this file: ${entry.note}`;
		if (hits.length === 0) {
			problems.push(
				`${ALLOWLIST}:${entry.line}: the \`${entry.section}\` entry for ${entry.path} matches nothing. ` +
					"Either the file was fixed or renamed — delete the entry and lower `baseline` — or this " +
					"rule has stopped matching, which is worse." +
					recorded,
			);
			continue;
		}
		problems.push(
			`${ALLOWLIST}:${entry.line}: the \`${entry.section}\` entry for ${entry.path} declares ${entry.hits} ` +
				`hit(s) and there are ${hits.length} (line${hits.length > 1 ? "s" : ""} ` +
				`${hits.map((h) => h.line).join(", ")}). An exception is granted per occurrence, not per file: ` +
				"a new one is new drift, and a removed one is a win to record by lowering `hits`." +
				recorded,
		);
		allowed += Math.min(hits.length, entry.hits);
	}

	for (const f of findings) {
		if (claimed.has(`${f.rule}${SEP}${f.file}`)) continue;
		const rule = RULES.find((r) => r.id === f.rule);
		problems.push(
			`${f.file}:${f.line}: \`${f.text.trim()}\` — this ${f.say}\n` +
				`  CLAUDE.md §6 requires ${rule.surface} here. If this site is genuinely different, add it to ` +
				`${ALLOWLIST} with a one-line reason in the product's voice — never to make the guard pass.`,
		);
	}

	return {
		problems,
		census,
		perRule,
		allowed,
		entries: list.entries.length,
		decisions: list.entries.filter((e) => e.kind === "decision").length,
		debt: list.entries.filter((e) => e.kind === "debt").length,
	};
}

// ── self-test ─────────────────────────────────────────────────────────────────────────────────

/**
 * A fake tree. Directories are keys ending in `/`; files map to their contents. `listDir` returns
 * [] for a file, which is how `filesFor` tells the two apart.
 *
 * @param {Record<string, string>} files
 * @returns {{readFile: (p: string) => string, listDir: (d: string) => string[]}}
 */
function fakeTree(files) {
	/** @param {string} dir */
	const listDir = (dir) => {
		/** @type {Set<string>} */
		const kids = new Set();
		for (const p of Object.keys(files)) {
			if (!p.startsWith(`${dir}/`)) continue;
			kids.add(p.slice(dir.length + 1).split("/")[0]);
		}
		return [...kids];
	};
	return { readFile: (p) => files[p] ?? "", listDir };
}

/**
 * The minimum well-formed allowlist, so a fixture can opt out of the vacuity failure. The floors
 * are GENERATED from `SCOPES` rather than typed: a hand-written list here would have to be edited
 * every time a scope is added, and the edit everyone forgets is the one that makes a fixture pass
 * for the wrong reason.
 */
const EMPTY_LIST = `baseline: 0\ndebt: 0\n\nscanned:\n${Object.keys(SCOPES)
	.map((id) => `  - scope: ${id}\n    floor: 0\n`)
	.join("")}`;

/** `EMPTY_LIST` with one scope's floor raised, for the fixtures that must trip it. */
function listWithFloor(scopeId, floor) {
	return `baseline: 0\ndebt: 0\n\nscanned:\n${Object.keys(SCOPES)
		.map((id) => `  - scope: ${id}\n    floor: ${id === scopeId ? floor : 0}\n`)
		.join("")}`;
}

/**
 * One file per (root, extension) pair every scope declares, so a fixture is testing the CLASSIFIER
 * and never accidentally tripping the vacuity check. Each is inert — no matcher can fire on it.
 *
 * @returns {Record<string, string>}
 */
function ballast() {
	/** @type {Record<string, string>} */
	const files = {};
	let i = 0;
	for (const scope of Object.values(SCOPES)) {
		for (const root of scope.roots) {
			for (const ext of scope.exts) {
				files[`${root}/ballast${i++}${ext}`] = "export const inert = 1;";
			}
		}
	}
	return files;
}

function selfTest() {
	let fails = 0;
	/** @param {string} name @param {boolean} cond @param {string} detail */
	const ok = (name, cond, detail = "") => {
		if (cond) console.log(`ok   - ${name}`);
		else {
			console.error(`FAIL - ${name} ${detail}`);
			fails++;
		}
	};
	/** Run `check` over a fake tree, with the allowlist supplied as one more file. */
	const run = (files, allowlist = EMPTY_LIST) => {
		const { readFile, listDir } = fakeTree({ ...files, [ALLOWLIST]: allowlist });
		return check(readFile, listDir);
	};
	/** @param {{problems: string[]}} r @param {RegExp} re */
	const says = (r, re) => r.problems.some((p) => re.test(p));

	// ── the classifier, proved by varying the CONTENT at ONE path ────────────────────────────
	// Same file name every time, so a green can never come from the path having escaped a scope,
	// and the ballast keeps every root and extension non-empty so vacuity never masquerades as a
	// classifier result.
	const AT = "apps/console/components/x/probe.tsx";
	const flags = (body, allowlist = EMPTY_LIST) => run({ ...ballast(), [AT]: body }, allowlist).problems.length > 0;

	ok("a live toFixed is flagged", flags("const s = `$${x.toFixed(2)}/mo`;"));
	ok("...and the SAME token in a line comment is not", !flags("// x.toFixed(2) — was the drift"));
	ok("...nor in a JSDoc block", !flags("/**\n * Renders `x.toFixed(2)` today.\n */\nexport const a = 1;"));
	ok("...nor in a JSX comment", !flags("const a = <p>{/* x.toFixed(2) */}ok</p>;"));
	ok("a block comment CLOSING mid-line does not blank the code after it", flags("/* note */ const s = x.toFixed(1);"));
	ok("a bare identifier called toFixed is not a member call", !flags("const toFixed = 1;"));

	ok("toLocaleDateString is flagged", flags("const d = new Date(v).toLocaleDateString();"));
	ok("toLocaleTimeString is flagged", flags("const t = new Date(v).toLocaleTimeString();"));
	// The one that separates the rows: a bare toLocaleString on a COUNT is correct and common.
	ok("a bare toLocaleString is NOT flagged (it is how a count gets separators)", !flags("const n = c.toLocaleString();"));

	// The fourth money spelling: a hand-written currency symbol in front of an interpolation.
	ok("a hand-written `$` before an interpolation is flagged", flags("const s = `$${n.toLocaleString()}`;"));
	ok("...and an interpolation with no symbol is not", !flags("const s = `${n} credits`;"));
	ok("...nor a dollar in prose", !flags("const s = `costs $12 a month`;"));

	// The byte rule's whole point is the OPERATOR, not the number.
	ok("dividing by 1024 is flagged", flags("const mb = bytes / 1024;"));
	ok("...including the parenthesised MiB form", flags("const mb = bytes / (1024 * 1024);"));
	// THE WRAPPED FORM. Prettier and Biome break a binary expression AFTER the operator, so this
	// is one `pnpm format` away from the line above; a per-line matcher read it as clean.
	ok("...and the form a formatter wraps onto the next line", flags("export const mb =\n\tbytes /\n\t1024;"));
	ok("MULTIPLYING by 1024 to declare a limit is not", !flags("const MAX = 10 * 1024 * 1024;"));
	ok("a plain 1024 is not", !flags("const opts = { max: 1024 };"));

	ok("a raw h1 is flagged", flags('const a = <h1 className="text-2xl">Clusters</h1>;'));
	ok("a self-closing h1 is flagged", flags("const a = <h1 />;"));
	ok("...and one whose attributes are on the NEXT line, which matching-per-line nearly missed", flags("const a = (\n\t<h1\n\t\tclassName={cn(x)}\n\t>t</h1>\n);"));
	ok("...including one that ends the file, where the window has no next line", flags("const a = <h1"));
	ok("...but h10 is a different tag", !flags("const a = <h10>x</h10>;"));
	ok("...and a component whose name merely contains h1 is not", !flags("const a = <Ch1ldTitle>x</Ch1ldTitle>;"));
	ok("PageHeader is the fix, so it is not itself a finding", !flags('const a = <PageHeader title="Clusters" />;'));

	// ── section headings: the tag, never the class name ──────────────────────────────────────
	// The old header declined this row because "a class-name match cannot tell a section heading
	// from a bold label". These fixtures are the answer: the matcher never reads the class, and the
	// same words in a <span> wearing the identical classes are NOT a finding.
	ok("a raw h2 is flagged", flags('const a = <h2 className="text-[15px] font-semibold">Usage</h2>;'));
	ok("a raw h3 is flagged", flags('const a = <h3 className="text-sm font-semibold">Members</h3>;'));
	ok("...whatever type scale it is wearing", flags('const a = <h2 className="text-2xl">Browse by topic</h2>;'));
	ok("...and a self-closing one, and one whose attributes are on the next line", flags("const a = <h2 />;") && flags("const a = (\n\t<h3\n\t\tclassName={cn(x)}\n\t>t</h3>\n);"));
	ok("...but the same words in a span with the same classes are not", !flags('const a = <span className="text-[15px] font-semibold">Usage</span>;'));
	ok("...and h20/h30 are different tags", !flags("const a = <h20>x</h20>;") && !flags("const a = <h30>x</h30>;"));

	// ── the empty state: the PADDING is the discriminator ────────────────────────────────────
	ok("a centred block with generous vertical padding is flagged", flags('const a = <div className="px-4 py-16 text-center">No runners yet</div>;'));
	ok("...at any of the six heights it is written at", flags('const a = <p className="px-3 py-6 text-center">none</p>;') && flags('const a = <div className="py-12 text-center">none</div>;'));
	ok("...but a centred TABLE CELL is not — py-2.5 is not standing in for content", !flags('const a = <td className="px-3 py-2.5 text-center">{v}</td>;'));
	ok("...nor a centred label with no vertical padding at all", !flags('const a = <div className="text-center text-xs">{label}</div>;'));
	ok("...nor generous padding without the centring", !flags('const a = <div className="px-4 py-16">{rows}</div>;'));
	// A JS string cannot hold a raw newline, so a `"` … `"` spanning one is two unrelated strings.
	ok(
		"...and the two halves may not be assembled out of two different strings on two lines",
		!flags('const a = <div className="text-center" data-x="py-16" />;\nconst b = "py-16";'),
	);

	// ── the stat strip: the container AND the primitive ──────────────────────────────────────
	ok("a container opening onto a <Stat is flagged", flags('const a = (\n<div className="grid grid-cols-4">\n<Stat label="Jobs" value={n} />\n</div>\n);'));
	ok("...including when the cell's props wrap onto the following lines", flags('const a = (\n<div className="grid grid-cols-2">\n<Stat\n\tlabel="Jobs"\n/>\n</div>\n);'));
	ok("...and the Stat primitive itself, so the fix cannot be one import away", flags("function Stat({ label, value }) {\n\treturn null;\n}"));
	ok("...but StatusBadge is a different component", !flags('const a = (\n<div className="grid grid-cols-4">\n<StatusBadge tone="ok" />\n</div>\n);'));
	ok("...and StatusDot is a different function", !flags("function StatusDot({ status }) {\n\treturn null;\n}"));

	// ── the layer scale: 40..99 is the gap, 10/20/30 are rungs ───────────────────────────────
	ok("a bare z-50 is flagged", flags('const a = <div className="absolute z-50 bg-popover" />;'));
	ok("...and a bare z-40, which is the same empty gap", flags('const a = <div className="fixed z-40" />;'));
	ok("...and an arbitrary numeric value", flags('const a = <div className="z-[95]" />;'));
	ok("...but z-10/z-20/z-30 are the scale's own in-flow rungs, unnamed rather than invented", !flags('const a = <div className="relative z-10" />;') && !flags('const a = <div className="z-30" />;'));
	ok("...and the token form is the FIX, so it is never a finding", !flags('const a = <div className="z-[var(--z-overlay)]" />;'));
	ok("...nor is the token's own name where it is declared", !flags("const css = `--z-overlay: 200;`;"));

	// ── grid-as-table: the SHAPE test the old header asked for ───────────────────────────────
	ok("an uppercase header row over a bracketed column template is flagged", flags('const a = <div className="grid grid-cols-[2fr_1fr_auto] uppercase tracking-[0.1em]" />;'));
	ok("...and a hoverable data row on the same template", flags('const a = <div className="grid grid-cols-[2fr_1fr_auto] hover:bg-muted/30" />;'));
	// THE ONE THAT SEPARATES A LAYOUT FROM A TABLE. A table's columns are the same at every width.
	ok(
		"...but the identical class list behind a BREAKPOINT is a page layout, not a table",
		!flags('const a = <div className="grid grid-cols-1 gap-4 lg:grid-cols-[280px_1fr] hover:bg-muted/30" />;'),
	);
	ok("...and a bracketed template with no row marker is a label/value pair", !flags('const a = <div className="grid grid-cols-[8rem_1fr] gap-y-1.5" />;'));
	ok("...and an N-up card grid is not a table", !flags('const a = <div className="grid grid-cols-3 gap-4 hover:bg-muted/30" />;'));
	ok("a raw <table> is flagged", flags('const a = <table className="w-full">{rows}</table>;'));
	ok("...but @repo/ui/table's <Table> is the fix", !flags("const a = <Table>{rows}</Table>;"));

	// ── money that never writes its own `$` ──────────────────────────────────────────────────
	ok("an interpolation glued directly onto a formatted number is flagged", flags('const s = `${symbol}${n.toLocaleString("en-US")}`;'));
	// THE AXIS THAT MATTERS. Adjacency alone is ~48 sites in this console — an id glued to a
	// suffix, a prefix glued to a path — so the second half having to FORMAT A NUMBER is the whole
	// matcher, and it is what a widening has to be caught on.
	ok("...but two adjacent interpolations that format nothing are an identifier, not a price", !flags("const s = `${context.resource_type}${suffix}`;"));
	ok("...and two values with words between them are a sentence", !flags("const s = `${used} / ${limit.toLocaleString()}`;"));
	ok("...and a bare toLocaleString is still how a count gets separators", !flags("const s = `${n.toLocaleString()} jobs`;"));
	ok("a currency symbol handed over as a prop is flagged", flags('const a = <Stat n={12} prefix="$" />;'));
	ok("...in any currency", flags('const a = <Stat n={12} prefix="€" />;'));
	ok("...but a prop that is not a currency symbol is not", !flags('const a = <Stat n={12} prefix="~" />;'));

	// One occurrence is reported once, not once per window it appears in.
	const twice = run({ ...ballast(), [AT]: "const a = 1;\nconst s = x.toFixed(2);\nconst b = 2;" });
	ok("a match on a middle line is reported exactly once", twice.problems.length === 1, JSON.stringify(twice.problems));

	// ── the comment stripper's two report-green shapes ───────────────────────────────────────
	// Both used to blank live code and print a pass.
	// The trailing line closes the latch, so this fixture cannot be rescued by the
	// unterminated-block refusal below — without the quote test the drift on line 2 is swallowed
	// and the run prints a pass, which is the shape that reports green on unread code.
	ok(
		"a `{/*` INSIDE a string does not latch the block state over the code after it",
		flags('export const g = "a{/*}b";\nexport const s = n.toFixed(2);\nexport const h = "c*/d";'),
	);
	const unterminated = run({ ...ballast(), [AT]: "/* oops\nexport const s = n.toFixed(2);" });
	ok(
		"an unterminated block comment REFUSES the file rather than blanking the rest of it",
		says(unterminated, /never closed/),
		JSON.stringify(unterminated.problems),
	);

	// ── scope, proved the same way: identical content, different path ────────────────────────
	const H1 = 'const a = <h1 className="x">t</h1>;';
	const at = (p) => ({ ...ballast(), [p]: H1 });
	ok("an h1 under app/(private) is in scope", run(at("apps/console/app/(private)/p/page.tsx")).problems.length > 0);
	const pub = run(at("apps/console/app/(public)/p/page.tsx"));
	ok("...and the identical file under app/(public) is not", pub.problems.length === 0, JSON.stringify(pub.problems));
	// The scope split INSIDE one rule: money reaches lib/, the byte division does not.
	const money = run({ ...ballast(), "apps/console/lib/x/a.ts": "const s = `$${n}`;" });
	ok("a hand-written money symbol under lib/ is in scope", money.problems.length > 0, JSON.stringify(money.problems));
	const bytes = run({ ...ballast(), "apps/console/lib/x/a.ts": "const gb = mb / 1024;" });
	ok("...but a byte division under lib/ is NOT — that scope is the rendering layer", bytes.problems.length === 0, JSON.stringify(bytes.problems));
	const bytesView = run({ ...ballast(), "apps/console/components/x/a.tsx": "const gb = mb / 1024;" });
	ok("...and the identical division under components/ IS", bytesView.problems.length > 0);

	// ── vacuity: every way this guard can read nothing and look clean ────────────────────────
	const nothing = run({});
	ok("an empty tree FAILS rather than passing", says(nothing, /examined ZERO files/), JSON.stringify(nothing.problems));
	// THE ONE A PER-RULE COUNT MISSED. Every root but one still resolves, so the rule's total is
	// healthy and the old check exited 0 having never opened `apps/console/app`.
	const oneRootGone = { ...ballast() };
	for (const k of Object.keys(oneRootGone)) if (k.startsWith("apps/console/app/")) delete oneRootGone[k];
	const rootGone = run(oneRootGone);
	ok(
		"a single dead ROOT fails even when the rule's other roots are full",
		says(rootGone, /root apps\/console\/app/),
		JSON.stringify(rootGone.problems),
	);
	// The same for an extension: drop every .ts and the .tsx files keep the totals healthy.
	const noTs = { ...ballast() };
	for (const k of Object.keys(noTs)) if (k.endsWith(".ts")) delete noTs[k];
	const tsGone = run(noTs);
	ok("...and a dead EXTENSION does too", says(tsGone, /ext \.ts\b/), JSON.stringify(tsGone.problems));
	// An unreadable directory is not an empty one.
	const unreadable = (() => {
		const { readFile, listDir } = fakeTree({ ...ballast(), [ALLOWLIST]: EMPTY_LIST });
		return check(readFile, (d) => {
			if (d === "apps/console/components") throw new Error("EACCES: permission denied");
			return listDir(d);
		});
	})();
	ok("a directory the walker cannot read FAILS", says(unreadable, /could not read the console tree/), JSON.stringify(unreadable.problems));
	// A matcher pointed at a scope that does not exist looks at nothing. Mutating the live rule
	// is the only way to reach it, and it must NOT surface as an unreadable-tree error.
	const strayScope = (() => {
		const m = RULES[0].matchers[0];
		const real = m.scope;
		m.scope = "console_cod"; // one character short of the real name
		const r = run(ballast());
		m.scope = real;
		return r;
	})();
	ok("a matcher scoped to a name that does not exist FAILS, and says so", says(strayScope, /scoped to `console_cod`/), JSON.stringify(strayScope.problems));

	// THE ONE THE PER-ROOT AXIS CANNOT SEE. The axes are built from the roots list, so deleting a
	// root leaves no row to be zero; only a checked-in census floor notices the declaration itself
	// changing. Mutating SCOPES is the only way to reach it.
	const rootDeleted = (() => {
		const scope = SCOPES.console_code;
		const real = scope.roots;
		// ONE tree, measured before the mutation: a floor guessed from the roots list would be
		// satisfied by the ballast the other scopes leave under the surviving roots, and the
		// fixture would pass without proving anything.
		const tree = ballast();
		let census = 0;
		for (const [key, n] of run(tree, EMPTY_LIST).census) if (key.split(SEP)[0] === "console_code") census += n;
		const list = listWithFloor("console_code", census);
		const atFloor = run(tree, list);
		scope.roots = real.slice(1);
		const narrowed = run(tree, list);
		scope.roots = real;
		return { atFloor, narrowed };
	})();
	ok("a scope exactly at its census floor passes", rootDeleted.atFloor.problems.length === 0, JSON.stringify(rootDeleted.atFloor.problems));
	ok(
		"...and a root DELETED from the scope declaration fails, which no per-root count can see",
		says(rootDeleted.narrowed, /against a floor of/),
		JSON.stringify(rootDeleted.narrowed.problems),
	);
	const noFloor = run(ballast(), "baseline: 0\ndebt: 0\n");
	ok("an allowlist with no census floors fails", says(noFloor, /has no floor for the/), JSON.stringify(noFloor.problems));
	const strayFloor = run(ballast(), EMPTY_LIST + "  - scope: console_nope\n    floor: 0\n");
	ok("...and a floor for a scope that does not exist fails", says(strayFloor, /which is not a scope/), JSON.stringify(strayFloor.problems));

	const noList = run(ballast(), "");
	ok("an allowlist with no baseline fails", says(noList, /no `baseline:`/), JSON.stringify(noList.problems));

	// ── the allowlist reader fails LOUDLY, in both directions ────────────────────────────────
	const parses = (t) => {
		try {
			return parseAllowlist(t);
		} catch (err) {
			return String(err instanceof Error ? err.message : err);
		}
	};
	const good = "baseline: 1\ndebt: 0\n\nformat:\n  - path: apps/console/components/a.tsx\n    hits: 2\n    reason: because.\n";
	/** A rule-section allowlist plus the floors every run requires, so a fixture tests one thing. */
	const withFloors = (t) => t + EMPTY_LIST.slice(EMPTY_LIST.indexOf("scanned:"));
	ok("a well-formed entry parses", typeof parses(good) === "object" && parses(good).entries.length === 1);
	ok("...and carries its hits and its recorded note", parses(good).entries[0].hits === 2 && parses(good).entries[0].note === "because.");
	ok("an unknown section is rejected", /unknown section/.test(String(parses("baseline: 0\nnope:\n"))));
	// An entry with NEITHER field is the shape that used to be caught as "no `reason:`". It has to
	// stay caught now that there are two kinds, because an entry with no kind counts against
	// neither ledger — a free exception, which is the one failure an allowlist must not have.
	ok("an entry with neither reason nor lifts is rejected", /has neither `reason:` nor `lifts:`/.test(String(parses("baseline: 1\ndebt: 0\nformat:\n  - path: a.tsx\n    hits: 1\n"))));
	ok(
		"...and one carrying BOTH is too, because only one of them can count",
		/carries both `reason:` and `lifts:`/.test(String(parses("baseline: 1\ndebt: 0\nformat:\n  - path: a.tsx\n    hits: 1\n    reason: x\n    lifts: \"#1 y\"\n"))),
	);
	// The issue number is what keeps debt visible somewhere that is not this file.
	ok(
		"a `lifts:` that names no board issue is rejected",
		/must be a quoted value naming the board issue/.test(String(parses("baseline: 0\ndebt: 1\nformat:\n  - path: a.tsx\n    hits: 1\n    lifts: \"we will get to it\"\n"))),
	);
	// The quotes carry meaning of their own: unquoted, the `#` reads as a comment everywhere else.
	ok(
		"...and so is an UNQUOTED one, however well it names its issue",
		/must be a quoted value naming the board issue/.test(String(parses("baseline: 0\ndebt: 1\nformat:\n  - path: a.tsx\n    hits: 1\n    lifts: #3613 — the wave lifts this.\n"))),
	);
	ok(
		"...and one that does parses as DEBT, not as a decision",
		(() => {
			const r = parses("baseline: 0\ndebt: 1\nformat:\n  - path: a.tsx\n    hits: 1\n    lifts: \"#3613 — the console-UI conformance wave lifts this.\"\n");
			return typeof r === "object" && r.entries[0].kind === "debt" && r.debt === 1;
		})(),
	);
	ok("an allowlist with no debt ledger fails", /no `debt:`/.test(String(parses("baseline: 0\n"))));
	ok("a missing hits is rejected", /has no `hits:`/.test(String(parses("baseline: 1\nformat:\n  - path: a.tsx\n    reason: x\n"))));
	// A `- scope:` with no `floor:` would otherwise carry the sentinel -1, i.e. a floor nothing
	// can fall below — a census control that reads as configured and is not one.
	ok("a scope with no floor is rejected", /has no `floor:`/.test(String(parses("baseline: 0\nscanned:\n  - scope: console_code\n"))));
	ok("a `floor:` outside a scope entry is rejected", /outside a `- scope:` entry/.test(String(parses("baseline: 0\nscanned:\n    floor: 3\n"))));
	ok("a `- scope:` outside the scanned section is rejected", /belongs to the `scanned:` section/.test(String(parses("baseline: 0\nformat:\n  - scope: console_code\n"))));
	ok("a line it cannot parse is rejected, not skipped", /cannot parse/.test(String(parses("baseline: 0\nformat:\n  - patth: a.tsx\n"))));
	ok("an entry before any section is rejected", /before any section/.test(String(parses("baseline: 0\n  - path: a.tsx\n"))));
	ok("a comment and a blank line are fine", typeof parses("# note\n\nbaseline: 0\ndebt: 0\n") === "object");
	// A duplicate is a second free entry against `baseline`, and only one of its two reasons is
	// the decision anyone recorded.
	ok(
		"the same file twice in one section is rejected",
		/a second `format` entry/.test(String(parses("baseline: 2\ndebt: 0\nformat:\n  - path: a.tsx\n    hits: 1\n    reason: x\n  - path: a.tsx\n    hits: 1\n    reason: y\n"))),
	);

	// ── the ratchet and the positive control ─────────────────────────────────────────────────
	const tree = { ...ballast(), "apps/console/components/a.tsx": "const a = n.toFixed(2);" };
	const entry = (hits, p = "apps/console/components/a.tsx") =>
		withFloors(`baseline: 1\ndebt: 0\n\nformat:\n  - path: ${p}\n    hits: ${hits}\n    reason: THE RECORDED DECISION.\n`);
	ok("an allowlisted site passes", run(tree, entry(1)).problems.length === 0, JSON.stringify(run(tree, entry(1)).problems));
	ok("an unallowlisted site fails with file:line", says(run(tree, EMPTY_LIST), /components\/a\.tsx:1:/));
	ok("an entry that over-declares fails", says(run(tree, entry(2)), /declares 2 hit\(s\) and there are 1/));
	ok("an entry matching NOTHING fails — the positive control", says(run(tree, entry(1, "apps/console/components/gone.tsx")), /matches nothing/));
	// The allowlist's header promises the guard prints the reason to whoever trips over it.
	ok("...and both entry failures print the recorded reason", says(run(tree, entry(2)), /THE RECORDED DECISION/) && says(run(tree, entry(1, "apps/console/components/gone.tsx")), /THE RECORDED DECISION/));
	const grew = withFloors(`baseline: 0\ndebt: 0\n\nformat:\n  - path: apps/console/components/a.tsx\n    hits: 1\n    reason: because.\n`);
	ok("the list may never grow past its baseline", says(run(tree, grew), /only shrinks/));
	const shrank = withFloors(`baseline: 2\ndebt: 0\n\nformat:\n  - path: apps/console/components/a.tsx\n    hits: 1\n    reason: because.\n`);
	ok("...and a shrink must be recorded, not left as headroom", says(run(tree, shrank), /Lower `baseline:` to 1/));

	// THE SECOND LEDGER, both directions, and the one that matters most: the two must not be
	// interchangeable. A debt row counted against `baseline` would let a fake decision be paid for
	// out of the drift census, which is the conversion the split exists to make visible.
	const debtEntry = (bl, db, kind) =>
		withFloors(`baseline: ${bl}\ndebt: ${db}\n\nformat:\n  - path: apps/console/components/a.tsx\n    hits: 1\n    ${kind}\n`);
	const LIFTS = 'lifts: "#3620 — THE RECORDED DEBT."';
	const asDebt = run(tree, debtEntry(0, 1, LIFTS));
	ok("a debt row passes, and pays out of `debt` rather than `baseline`", asDebt.problems.length === 0 && asDebt.debt === 1 && asDebt.decisions === 0, JSON.stringify(asDebt.problems));
	ok("...and its recorded note is printed when its hits stop agreeing", says(run({ ...tree, "apps/console/components/a.tsx": "const a = n.toFixed(2);\nconst b = n.toFixed(1);" }, debtEntry(0, 1, LIFTS)), /THE RECORDED DEBT/));
	ok("a debt ledger may never grow past its number", says(run(tree, debtEntry(0, 0, LIFTS)), /against a `debt:` of 0/));
	ok("...and a debt shrink must be recorded too", says(run(tree, debtEntry(0, 2, LIFTS)), /Lower `debt:` to 1/));
	// The conversion, in both directions, proved by moving ONE row between the two kinds and
	// leaving both numbers alone. Each direction reds against a DIFFERENT ledger.
	ok("a decision row does not pay out of `debt`", says(run(tree, debtEntry(0, 1, "reason: because.")), /against a `baseline:` of 0/));
	ok("...and a debt row does not pay out of `baseline`", says(run(tree, debtEntry(1, 0, LIFTS)), /against a `debt:` of 0/));

	// ── the permanent positive control, exercised in both directions ────────────────────────
	// Both halves are exercised THROUGH `check`, not against `RULES` directly: the earlier version
	// asserted the matchers here and left the control inside `check` uncovered, so deleting the
	// anti-probe branch kept the whole self-test green.
	const dead = RULES[0].matchers[0];
	const realRe = dead.re;
	dead.re = /THIS_WILL_NEVER_APPEAR/g;
	const blind = run(tree, entry(1));
	dead.re = realRe;
	ok("a matcher that stopped matching FAILS rather than reporting a clean tree", says(blind, /no longer matches its own probe/), JSON.stringify(blind.problems));

	dead.re = /toFixed|toFixed/g; // matches the bare identifier its anti-probe is built from
	const widened = run(tree, entry(1));
	dead.re = realRe;
	ok("a matcher that WIDENED onto correct code fails too", says(widened, /has widened onto/), JSON.stringify(widened.problems));

	// A matcher with NO anti-probe passes the widening half silently, because `re.test(undefined)`
	// is false for every matcher here — a control that is absent and reads as a control that held.
	const noAnti = (() => {
		const m = RULES[0].matchers[0];
		const real = m.antiProbe;
		delete m.antiProbe;
		const r = run(tree, entry(1));
		m.antiProbe = real;
		return r;
	})();
	ok("a matcher that declares no anti-probe FAILS rather than skipping the widening control", says(noAnti, /declares no `antiProbe`/), JSON.stringify(noAnti.problems));
	// Every matcher in the live rules carries both halves — asserted here as well as in `check`,
	// because this is the assertion that survives someone deleting the structural check above.
	ok(
		"every live matcher carries a probe and an anti-probe",
		RULES.every((r) => r.matchers.every((m) => typeof m.probe === "string" && m.probe !== "" && typeof m.antiProbe === "string" && m.antiProbe !== "")),
	);

	// ── the guard must not be able to match itself or its own fixtures ───────────────────────
	const mixed = fakeTree({ "scripts/check-shared-surface.mjs": "const a = n.toFixed(2);", "apps/console/components/a.tsx": "" });
	const scannedPaths = Object.values(SCOPES).flatMap((s) => filesFor(s, mixed.listDir).files);
	ok("the console file IS reached", scannedPaths.includes("apps/console/components/a.tsx"));
	ok("...and this guard, sitting in scripts/, is never scanned", !scannedPaths.includes("scripts/check-shared-surface.mjs"));
	ok("the fixtures above live in this file, not on disk", !fs.existsSync(path.join(ROOT, "apps/console/components/x/probe.tsx")));
	// A raw NUL in this file's own source made `rg` and `grep -r` report "binary file matches" and
	// print nothing, for a guard whose value is that the next reader can read its stated scope.
	// `import.meta.filename`, not a hardcoded path: the assertion has to read the file that is
	// actually running, or a copy of this guard would check the pristine original and pass.
	ok("this file holds no NUL byte, so ripgrep will still print it", !fs.readFileSync(import.meta.filename, "utf8").includes("\u0000"));

	if (fails > 0) {
		console.error(`\ncheck-shared-surface self-test: ${fails} failure(s)`);
		process.exit(1);
	}
	console.log("\nself-test: all passed");
}

// ── entry ─────────────────────────────────────────────────────────────────────────────────────

if (process.argv.includes("--self-test")) {
	selfTest();
} else {
	const readFile = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
	/** @param {string} dir */
	const listDir = (dir) => {
		let entries;
		try {
			entries = fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true });
		} catch (err) {
			// ENOTDIR is how `filesFor` asks "is this path a file?", and it is the expected answer
			// for every file in the tree. Everything else — EACCES on an unreadable directory, a
			// dangling symlink — is rethrown: swallowing it dropped that whole subtree from the
			// scan and still printed `✓ … examined N file(s)`.
			if (err instanceof Error && "code" in err && err.code === "ENOTDIR") return [];
			throw err;
		}
		return entries.filter((e) => e.isDirectory() || e.isFile()).map((e) => e.name);
	};
	const { problems, census, perRule, allowed, decisions, debt } = check(readFile, listDir);
	for (const p of problems) console.error(`::error::shared-surface: ${p}`);
	// The per-root breakdown is printed on EVERY run, pass or fail. A collapse that the floors
	// above cannot see — one root emptying while another grows — is then visible in the diff of
	// two CI logs rather than invisible behind a single total.
	// Keyed by SCOPE and root, not by root alone: `apps/console/components` is a root of three
	// scopes, and summing them prints 1040 for a directory holding 364 files, which is the kind of
	// number a reader stops trusting.
	const perRoot = new Map();
	for (const [key, n] of census) {
		const [scopeId, root] = key.split(SEP);
		const label = `${scopeId}:${root}`;
		perRoot.set(label, (perRoot.get(label) ?? 0) + n);
	}
	const breakdown = [...perRoot].map(([label, n]) => `${label} ${n}`).join(", ");
	const rules = [...perRule].map(([id, n]) => `${id} ${n}`).join(", ");
	if (problems.length > 0) {
		console.error(`\n${problems.length} problem(s) (files per rule — ${rules}; per root — ${breakdown}).`);
		process.exit(1);
	}
	console.log(
		`✓ check-shared-surface: files per rule — ${rules}; per root — ${breakdown}. ` +
			`Every hand-rolled ${RULES.map((r) => r.surface).join(" / ")} site is one of the ${allowed} ` +
			`occurrence(s) that ${ALLOWLIST} accounts for — across ${decisions} recorded decision(s) and ` +
			`${debt} file(s) of measured drift still owed to the board.`,
	);
}
