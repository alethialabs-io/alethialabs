#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
//
// THE CLI SURFACE CENSUS — REPORT MODE ONLY (#4373).
//
// #3664 is written as though this script and `apps/cli/cli-surface-allowlist.yaml` already run in
// report mode and need promoting to enforcing. Measured 2026-09-08 on `dev`, neither existed and
// `package.json` had no `cli-surface` entry, so there was no report mode to flip and #3664's four
// target figures had no source. This is that source. It REPORTS. It is not wired into any required
// check, and it does not ratchet: #3664 flips it, on numbers this has produced on real PRs first.
// A ratchet armed on its own first census enforces whatever that census happened to measure —
// including its bugs.
//
//   node scripts/check-cli-surface.mjs              # the census (pnpm check:cli-surface)
//   node scripts/check-cli-surface.mjs --json       # the same census as a machine-readable record
//   node scripts/check-cli-surface.mjs --self-test  # the fixture suite; exit 1 on any failure
//   node scripts/check-cli-surface.mjs --help
//
// Do NOT pipe it. `node scripts/check-cli-surface.mjs | tail` reports TAIL's exit code, which is
// always 0, and every refusal below becomes invisible.
//
// ── THE REQUIREMENT THAT OUTRANKS THE NUMBERS ────────────────────────────────────────────────
//
// A COUNTER THAT FINDS NOTHING MUST BE DISTINGUISHABLE FROM A COUNTER THAT FINDS NOTHING WRONG.
// `cli_gap = 0` was once green while the product was unusable. All four counters here therefore
// carry an explicit vacuity refusal, and each refusal exits 1 with a message naming the census
// that came back empty:
//
//   handoffs          refuses when it parses ZERO docs pages, or collects zero examples from them
//   form coverage     refuses when it discovers ZERO commands, or zero runnable ones
//   allowlist rows    refuses when the allowlist FILE IS MISSING, or carries no ledger keys
//   unlocked mirrors  refuses when it finds ZERO `Mirrors the Go X` claims to check
//
// Bare zero is the floor, not the whole control. A counter that reads 3 of 35 docs pages is also
// broken, and a bare-zero refusal cannot see that — so the allowlist additionally carries
// `scanned:` FLOORS, the same census-floor mechanism `apps/console/shared-surface-allowlist.yaml`
// uses, and a scope that reads fewer files than its floor is refused as well. The floors sit under
// the live counts so an ordinary edit need not touch them; a DROP is the thing review stops.
//
// `--self-test` drives BOTH directions of every counter, the vacuity refusals included: for each
// one there is a fixture that produces a finding and a fixture that produces a clean zero, and a
// third that produces the refusal. A self-test that only proves the happy path is worth very
// little in a repository whose dominant defect class is a guard reporting green.
//
// ── WHY EACH NUMBER SAYS ITS METHOD ──────────────────────────────────────────────────────────
//
// #4373 records three greps at one question — "how much of the CLI is on the field-spec kit" —
// giving 2 of 85, 0 of 6 and 70 on the SAME tree, each measuring something other than what it
// looked like. (The middle one is the sharpest: the six `*_fields.go` tables ARE on `pkg/spec`,
// but their entries are written `authField{…}` where `type authField = spec.Field` is an ALIAS, so
// a search for `spec.Field{` finds nothing in files built entirely on it.) A number published
// without its method is the same defect one step later, so every counter prints how it was
// derived, and where a second, independent derivation exists it prints that too and names the
// delta. A disagreement between two methods is a finding about the method, not a number to pick
// between — so a corroborating figure is REPORTED beside the primary one and never silently
// replaces it.
//
// ── WHAT IS DELIBERATELY NOT COUNTED, AND WHY ────────────────────────────────────────────────
//
// Stated rather than left to be inferred, because "the census is enforced" is the sentence a
// reader turns into "nothing else can drift":
//
//   * The AUTH GATE is not an interactive path. `getAuthToken` reaches `ui.AuthRequiredPrompt`,
//     which asks "would you like to log in now?" — a session repair, not a way to supply a value
//     the command takes. Counting it would mark almost every command in the CLI interactive and
//     the form-coverage ratio would read ~100% while the product still could not be scripted.
//     The names are in NOT_AN_INPUT_PATH below and the self-test proves the exclusion both ways.
//
//   * A CONFIRMATION is not an interactive path FOR AN INPUT. `huh.NewConfirm` is the destructive
//     verb's "are you sure", and a command whose only reach into the form kit is a confirm has no
//     way to ASK for the values it takes. It is counted and printed separately (`confirmOnly`)
//     rather than folded into the numerator, because #3663 holds the `--yes` contract as its own
//     item and conflating the two would let a `--yes` prompt pay for a missing form.
//
//   * The GO CALL GRAPH IS PACKAGE-LOCAL. Reachability is computed over top-level `func` bodies in
//     package `cmd` only. It follows FUNCTIONS, never package-level `var`s, which is also why the
//     auth gate does not leak in through `authRequiredPrompt` (a var holding `ui.AuthRequiredPrompt`).
//     A form reached only through a var indirection is therefore INVISIBLE to this counter and the
//     numerator is a floor, not an exact count. That is the honest direction to be wrong in for a
//     report-mode census whose job is to be flipped into a ratchet later.
//
//   * The MIRROR counter reads BACKTICKED claims only — `Mirrors the Go ` + "`Type`". Prose that
//     says "Mirrors the Go pattern in packages/core/cloud/aws/s3.go" names no type, so there is
//     nothing a fixture pair could lock; it is reported as `prose` and is NOT a finding. This is
//     the absent/unenforced distinction #4373 asks for, made mechanical: an ABSENT claim (a file
//     with no claim, or a phrase with no type in it) is not a finding, and an UNENFORCED claim (a
//     backticked type no mechanism answers) is.
//
// ── THE FOUR COUNTERS ────────────────────────────────────────────────────────────────────────
//
// 1 · HANDOFFS. `<placeholder>` tokens a reader must copy from one command's output into the next,
//     in the golden-path docs (`apps/docs/content/docs/cli/**/*.mdx`). An example carrying
//     `<job-id>` is not an example — it is an instruction to go and find a value somewhere else,
//     which is the ergonomic failure the CLI programme exists to remove.
//
//     The collection rule and the placeholder rule are DELIBERATELY THE SAME ONES the Go guard in
//     `apps/cli/cmd/hyg_cli_docs_test.go` already uses (docsFencedExamples / docsPlaceholderToken),
//     restated here rather than invented: two mechanisms answering one question with two rules is
//     how a number stops meaning what its name says. The difference is SCOPE, and it is the reason
//     this counter exists at all — the Go ratchet holds only the groups ENROLLED in
//     `docsPlaceholderRatchetGroups`, deliberately, so that a sibling lane's merge cannot red a
//     branch that never touched the page. This censuses EVERY page, enrolled or not, which is the
//     programme's number.
//
// 2 · FORM COVERAGE. Runnable commands with an interactive path ÷ runnable commands that take
//     input. "Runnable" matches the Go guard's docsLeaves: every command with a Run or RunE,
//     INCLUDING a runnable group (`alethia activity` and `alethia config` are top-level commands
//     with a Run and no subcommands, and a subcommands-only walk cannot see them), minus cobra's
//     generated `help`/`completion` and anything Hidden.
//
// 3 · ALLOWLIST ROWS. Entries in `apps/cli/cli-surface-allowlist.yaml`, split into the same two
//     ledgers the console's allowlist carries: `reason:` is a DECISION and counts against
//     `baseline`, `lifts:` is measured drift a named board issue removes and counts against
//     `debt`. The file is present and its ledgers are empty TODAY, and that is not a bug: a row is
//     a recorded decision, and pre-seeding ~110 fake ones to make the number look like #3664's
//     "whole CLI" would empty the word "decision" before the ratchet ever ran. The CLI's
//     unconverted surface is what counter 2 measures.
//
// 4 · UNLOCKED MIRRORS. `Mirrors the Go X` claims with no mechanism behind them. The mechanism is
//     `packages/core/jsonbmirror/jsonb_mirror_test.go`: it enrols exactly one file (its
//     `tsMirrorFile` const) and answers a claim with a fixture pair (`GoName:`), a value
//     vocabulary (`GoType:`) or a named entry in `unlockableClaims`. Both halves are read out of
//     that file rather than restated here, so the census cannot claim a lock the test does not
//     have. A claim in any OTHER file is unlocked by construction — nothing is watching it.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ── injectable IO ─────────────────────────────────────────────────────────────────────────────
//
// Every census below takes an `io` rather than touching `node:fs`, so the self-test can hand it a
// tree held as strings in this file — including the trees that DO NOT EXIST, which is the only way
// to drive a "the allowlist file is missing" refusal without deleting a committed file.

/**
 * @typedef {object} Io
 * @property {(rel: string) => string} read           repo-relative read; throws when absent
 * @property {(rel: string) => boolean} exists        repo-relative existence test
 * @property {(rel: string, ext: string) => string[]} list  repo-relative recursive file list
 */

/** The real repository, rooted at the monorepo root. @returns {Io} */
function realIo() {
	return {
		read: (rel) => readFileSync(join(ROOT, rel), "utf8"),
		exists: (rel) => {
			try {
				statSync(join(ROOT, rel));
				return true;
			} catch {
				return false;
			}
		},
		list: (rel, ext) => listRecursive(join(ROOT, rel), ext).map((p) => relative(ROOT, p).split(sep).join("/")).sort(),
	};
}

/**
 * An in-memory tree, for the self-test. Keys are repo-relative paths.
 * @param {Record<string, string>} files
 * @returns {Io}
 */
function memoryIo(files) {
	return {
		read: (rel) => {
			if (!(rel in files)) throw new Error(`ENOENT: ${rel}`);
			return files[rel];
		},
		exists: (rel) => rel in files || Object.keys(files).some((f) => f.startsWith(`${rel}/`)),
		list: (rel, ext) =>
			Object.keys(files)
				.filter((f) => (rel === "" || f.startsWith(`${rel}/`)) && f.endsWith(ext))
				.sort(),
	};
}

/**
 * Every file under `dir` whose name ends in `ext`, recursively. Returns [] for a missing directory
 * — the CALLER decides whether an empty census is a refusal, because "the directory is gone" and
 * "the directory is empty" must reach the same loud branch rather than one of them throwing here.
 * @param {string} dir absolute directory
 * @param {string} ext file suffix, e.g. ".go"
 * @returns {string[]} absolute paths
 */
function listRecursive(dir, ext) {
	/** @type {string[]} */
	const out = [];
	/** @type {import("node:fs").Dirent[]} */
	let entries;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const e of entries) {
		const p = join(dir, e.name);
		if (e.isDirectory()) out.push(...listRecursive(p, ext));
		else if (e.isFile() && e.name.endsWith(ext)) out.push(p);
	}
	return out;
}

// ── shared shapes ─────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {object} Census
 * @property {string} name        the counter's name, as #3664's table writes it
 * @property {string} method      how the number below was derived; printed beside it, always
 * @property {string|null} refusal  non-null when the census came back empty; makes the run exit 1
 * @property {number} value       the counter
 * @property {string} rendered    the counter as a human reads it (a ratio is not one number)
 * @property {string[]} notes     corroborating derivations, deltas, and stated blind spots
 * @property {string[]} findings  the individual items behind `value`, for a reader to audit
 * @property {string[]} [witnesses]  the evidence behind each POSITIVE verdict, where a counter has
 *                                   one. A number whose individual verdicts cannot be inspected is
 *                                   a number nobody can defend, and the form-coverage numerator is
 *                                   a transitive reachability result — the least inspectable kind.
 */

/**
 * Build a Census whose numbers are refused. Used by every vacuity branch, so an empty census can
 * never be rendered through the same path as a clean one.
 * @param {string} name
 * @param {string} method
 * @param {string} refusal why the census is empty, and what a reader should look at
 * @returns {Census}
 */
function refused(name, method, refusal) {
	return { name, method, refusal, value: Number.NaN, rendered: "REFUSED", notes: [], findings: [] };
}

// ── counter 1 · handoffs ──────────────────────────────────────────────────────────────────────

/** Fence info strings that mark a block as commands a reader RUNS. Mirrors docsShellFences. */
const SHELL_FENCES = new Set(["bash", "sh", "shell", "console"]);

/**
 * Every `alethia …` invocation inside a SHELL-fenced block of one markdown page.
 *
 * A restatement of `docsFencedExamples` in apps/cli/cmd/hyg_cli_docs_test.go, and it must stay
 * one: an untagged fence on these pages is rendered OUTPUT, which can perfectly well start with
 * the word alethia (`verify receipt` prints a card headed `alethia · verify receipt`), and a
 * trailing backslash JOINS the next line — without which a wrapped example is cut at the backslash
 * and the half most likely to have rotted is never read. Anything after a pipe belongs to the next
 * process, and a trailing comment is not part of the command.
 * @param {string} page the raw .mdx source
 * @returns {string[]} one entry per invocation, whitespace-normalised
 */
function fencedExamples(page) {
	/** @type {string[]} */
	const out = [];
	let fenced = false;
	let shell = false;
	let pending = "";
	for (const line of page.split("\n")) {
		const trimmed = line.trim();
		if (trimmed.startsWith("```")) {
			// A continuation that never terminated does not escape its block; carrying the
			// fragment across a fence would splice two unrelated commands into one.
			pending = "";
			if (fenced) {
				fenced = false;
				shell = false;
				continue;
			}
			fenced = true;
			shell = SHELL_FENCES.has(trimmed.slice(3).trim().toLowerCase());
			continue;
		}
		if (!fenced || !shell) continue;
		let cmd = trimmed;
		if (pending === "" && !cmd.startsWith("alethia ")) continue;
		if (cmd.endsWith("\\")) {
			pending = `${pending} ${cmd.slice(0, -1).trim()}`.trim();
			continue;
		}
		if (pending !== "") {
			cmd = `${pending} ${cmd}`.trim();
			pending = "";
		}
		const pipe = cmd.indexOf("|");
		if (pipe >= 0) cmd = cmd.slice(0, pipe);
		const comment = cmd.indexOf(" #");
		if (comment >= 0) cmd = cmd.slice(0, comment);
		out.push(cmd.trim());
	}
	return out;
}

/**
 * Whether one token of an example is a placeholder a reader must SUBSTITUTE rather than a literal
 * they can paste. A restatement of `docsPlaceholderToken`, deliberately.
 *
 * Three shapes, and the third is the one it exists for. `<job-id>` and `[selector]` announce
 * themselves; `…` and `...` are how a truncated id is written, and `8f3c2a1e-...` is exactly the
 * token a reader would copy, paste, and get a 404 from. A token is judged WHOLE — `--repo=<url>`
 * is a placeholder because its value is one, and `oci://x/y` is not, because nothing in it is a
 * substitution.
 * @param {string} token
 * @returns {boolean}
 */
function placeholderToken(token) {
	if (token.includes("<") || token.includes(">")) return true;
	if (token.includes("…") || token.includes("...")) return true;
	return token.startsWith("[") && token.endsWith("]") && token.length > 2;
}

/** Where the golden-path docs live. Every `.mdx` under it is in the census. */
const CLI_DOCS_DIR = "apps/docs/content/docs/cli";

/**
 * Counter 1. `<placeholder>` tokens across every golden-path docs page.
 * @param {Io} io
 * @param {number} pagesFloor the fewest pages this census may read before it is refused
 * @returns {Census}
 */
function censusHandoffs(io, pagesFloor) {
	const name = "handoffs";
	const method =
		`placeholder tokens (\`<x>\`, \`[x]\`, \`…\`/\`...\`) in shell-fenced \`alethia …\` examples across ` +
		`every .mdx under ${CLI_DOCS_DIR}; collection and token rules restated from ` +
		`apps/cli/cmd/hyg_cli_docs_test.go so the two mechanisms answer the same question`;

	const pages = io.list(CLI_DOCS_DIR, ".mdx");
	if (pages.length === 0) {
		return refused(
			name,
			method,
			`parsed ZERO docs pages under ${CLI_DOCS_DIR}. The directory is gone, was renamed, or the ` +
				`.mdx suffix changed — a handoff count of 0 from an unread corpus is the failure this ` +
				`counter exists to not report.`,
		);
	}
	if (pages.length < pagesFloor) {
		return refused(
			name,
			method,
			`read ${pages.length} docs pages, below the census floor of ${pagesFloor} in ` +
				`${ALLOWLIST_PATH}. Either the corpus shrank (raise nothing — find out why) or this ` +
				`counter stopped seeing most of it. Bare zero would not have caught this.`,
		);
	}

	let examples = 0;
	/** @type {string[]} */
	const findings = [];
	let tokens = 0;
	const shapes = { substitution: 0, optionalNotation: 0, truncation: 0 };
	for (const page of pages) {
		for (const example of fencedExamples(io.read(page))) {
			examples++;
			for (const token of example.split(/\s+/).filter(Boolean)) {
				if (!placeholderToken(token)) continue;
				tokens++;
				// The three shapes are counted apart because they are not equally bad and a reader
				// deciding what to fix needs to know which is which. `<id>` is a value copied out of
				// another command's output — the handoff itself. `...` is a TRUNCATED id, which is
				// the same handoff written so that it looks pasteable and 404s. `[--flag]` is usage
				// NOTATION that leaked into a runnable example: still not runnable as written, which
				// is why the shared rule catches it, but the fix is to delete the brackets rather
				// than to remove a dependency between two commands.
				if (token.includes("<") || token.includes(">")) shapes.substitution++;
				else if (token.includes("…") || token.includes("...")) shapes.truncation++;
				else shapes.optionalNotation++;
				findings.push(`${page}: \`${example}\` carries ${token}`);
			}
		}
	}
	if (examples === 0) {
		return refused(
			name,
			method,
			`read ${pages.length} docs pages and collected ZERO \`alethia …\` examples from them. The ` +
				`shell-fence rule stopped matching, or the pages stopped carrying commands; either way ` +
				`every token below was inspected in a corpus of nothing.`,
		);
	}

	// The corroborating derivation. A whole-line regex over the same examples, which cannot see a
	// token boundary and therefore counts EXAMPLES-with-a-placeholder rather than TOKENS. It is
	// here to catch a tokeniser that has stopped splitting, not to replace the number: it is a
	// lower bound on it by construction, so `lines > tokens` is the disagreement worth reporting.
	let lines = 0;
	for (const page of pages) {
		for (const example of fencedExamples(io.read(page))) {
			if (/<[^>\s]*>|\.\.\.|…|(?:^|\s)\[[^\]\s]+\](?:$|\s)/.test(example)) lines++;
		}
	}
	const notes = [
		`corroborating: ${lines} of ${examples} examples carry at least one placeholder (whole-line ` +
			`regex, independent of the tokeniser). It is a lower bound on the token count by ` +
			`construction; ${lines} <= ${tokens} holds${lines <= tokens ? "" : " — IT DOES NOT, and that is a finding about the method, not a number to pick between"}.`,
		`scope: ${pages.length} pages, ${examples} examples.`,
		`by shape: ${shapes.substitution} substitutions (\`<id>\` — the handoff itself), ` +
			`${shapes.truncation} truncated ids (\`8f3c…\` — the same handoff written so it looks ` +
			`pasteable), ${shapes.optionalNotation} bracketed usage notation (\`[--flag]\` — not a ` +
			`handoff, but not runnable as written either, and the shared rule catches it for that).`,
		`the Go ratchet in hyg_cli_docs_test.go holds only its ENROLLED groups; this censuses all pages.`,
	];
	return { name, method, refusal: null, value: tokens, rendered: String(tokens), notes, findings };
}

// ── counter 2 · form coverage ─────────────────────────────────────────────────────────────────

/** Where the cobra command tree is declared. One Go package, so name resolution is package-wide. */
const CLI_CMD_DIR = "apps/cli/cmd";

/**
 * Form widgets that ASK FOR A VALUE. `huh.NewConfirm` is deliberately absent — see the header:
 * a confirmation is the destructive verb's "are you sure", not a way to supply an input, and
 * letting one pay for a missing form is exactly how a coverage ratio stops meaning anything.
 */
const VALUE_WIDGETS = ["huh.NewInput", "huh.NewSelect", "huh.NewMultiSelect", "huh.NewText", "spec.Resolve("];

/** The confirmation widget, counted and reported separately rather than folded into the ratio. */
const CONFIRM_WIDGET = "huh.NewConfirm";

/**
 * Reaching the field-spec kit at all, however a command reaches it.
 *
 * This is the exact question #4373 records three greps disagreeing about — 2 of 85, 0 of 6 and 70
 * on one tree. The three failed for three reasons and only the middle one is subtle: entries in the
 * six `*_fields.go` tables are written `authField{…}` where `type authField = spec.Field` is an
 * ALIAS, so `spec.Field{` finds nothing in files built entirely on it. So the markers below are the
 * shapes a COMMAND uses to reach the kit — the group Must-helpers (`mustAuthField` and its five
 * siblings, matched by shape so a seventh group joins without an edit here) and the two binder
 * registrars — never the struct literal, which is the spelling that misled the grep.
 */
const FIELD_SPEC_MARKERS = ["spec.RegisterFlags(", "spec.RegisterPersistentFlags(", "spec.Resolve("];

/** The `must<Group>Field` helper shape, matched rather than listed. See FIELD_SPEC_MARKERS. */
const MUST_FIELD_SHAPE = /\bmust[A-Z][A-Za-z0-9]*Field\s*\(/;

/**
 * Functions that reach a form but are NOT an input path, excluded by name with the reason.
 *
 * `getAuthToken`/`getAuthTokenInternal` reach `ui.AuthRequiredPrompt` — "you are not logged in,
 * would you like to log in now?" — which is a session repair every command in the CLI performs.
 * Following it marks essentially the whole tree interactive and the ratio reads ~100% against a
 * product that still cannot be scripted. The self-test drives this in both directions.
 */
const NOT_AN_INPUT_PATH = new Set(["getAuthToken", "getAuthTokenInternal", "authRequiredPrompt", "runSpinner"]);

/**
 * @typedef {object} GoCommand
 * @property {string} varName    the package-level identifier, e.g. "teamsCreateCmd"
 * @property {string} use        the Use string, e.g. "create [name]"
 * @property {string} nameToken  the first word of Use, e.g. "create"
 * @property {boolean} hidden
 * @property {boolean} runnable  has a Run or RunE
 * @property {string[]} positionals  placeholders in Use beyond the name
 * @property {string} body       the composite-literal source, for reachability seeding
 * @property {string} file
 */

/**
 * Find the matching close brace for the `{` at `open`, respecting Go string, rune and comment
 * syntax. A brace counter that does not know about `"}"` inside a Long string closes the literal
 * early and every field after it disappears — which reads as a command with no Run.
 * @param {string} src
 * @param {number} open index of the opening brace
 * @returns {number} index of the matching close brace, or -1
 */
function matchBrace(src, open) {
	let depth = 0;
	for (let i = open; i < src.length; i++) {
		const c = src[i];
		if (c === "/" && src[i + 1] === "/") {
			const nl = src.indexOf("\n", i);
			i = nl === -1 ? src.length : nl;
			continue;
		}
		if (c === "/" && src[i + 1] === "*") {
			const end = src.indexOf("*/", i + 2);
			i = end === -1 ? src.length : end + 1;
			continue;
		}
		if (c === "`") {
			const end = src.indexOf("`", i + 1);
			i = end === -1 ? src.length : end;
			continue;
		}
		if (c === '"' || c === "'") {
			for (let j = i + 1; j < src.length; j++) {
				if (src[j] === "\\") {
					j++;
					continue;
				}
				if (src[j] === c || src[j] === "\n") {
					i = j;
					break;
				}
				if (j === src.length - 1) i = j;
			}
			continue;
		}
		if (c === "{") depth++;
		else if (c === "}") {
			depth--;
			if (depth === 0) return i;
		}
	}
	return -1;
}

/**
 * Every `var xCmd = &cobra.Command{…}` in package `cmd`.
 *
 * Measured 2026-09-08: all 156 command literals in apps/cli/cmd are written in exactly this shape,
 * with none built inline inside an AddCommand call — so this parse sees the whole tree rather than
 * a convenient subset of it. `parseCommands` reports what it found; the CALLER refuses a zero.
 * @param {Io} io
 * @param {string[]} files repo-relative .go paths
 * @returns {Map<string, GoCommand>} keyed on the variable name
 */
function parseCommands(io, files) {
	/** @type {Map<string, GoCommand>} */
	const cmds = new Map();
	const decl = /^var\s+([A-Za-z0-9_]+)\s*=\s*&cobra\.Command\{/gm;
	for (const file of files) {
		const src = io.read(file);
		for (const m of src.matchAll(decl)) {
			const open = src.indexOf("{", m.index + m[0].length - 1);
			const close = matchBrace(src, open);
			if (close === -1) continue;
			const body = src.slice(open, close + 1);
			const use = /(?:^|[\n{,])\s*Use:\s*(?:"((?:[^"\\]|\\.)*)"|`([^`]*)`)/.exec(body);
			const useText = use ? (use[1] ?? use[2] ?? "") : "";
			const parts = useText.trim().split(/\s+/).filter(Boolean);
			cmds.set(m[1], {
				varName: m[1],
				use: useText,
				nameToken: parts[0] ?? "",
				hidden: /(?:^|[\n{,])\s*Hidden:\s*true/.test(body),
				runnable: /(?:^|[\n{,])\s*RunE?:/.test(body),
				positionals: parts.slice(1).filter((p) => /^[[<]/.test(p)),
				body,
				file,
			});
		}
	}
	return cmds;
}

/**
 * Parent → children edges, from every `parent.AddCommand(a, b, c)` in the package AND from every
 * REGISTRATION HELPER that hides one.
 *
 * The second half is not a refinement, it is the difference between seeing the break-glass group
 * and not seeing it. Measured 2026-09-08: a direct-`AddCommand`-only parse left THIRTEEN command
 * literals with no parent — the whole `ops` group — because `ops_approve.go` registers its verbs
 * through `registerOpsVerb(opsApproveCmd)`, a one-argument helper whose body does the AddCommand.
 * The parse was not wrong about the code it read; it was silently reading less of the tree than it
 * appeared to, and a form-coverage ratio that quietly omits a noun group is exactly the number
 * #4373 says not to publish. It was found by cross-checking the literal count against the edge
 * count, which is why the caller reports any REMAINING orphans rather than dropping them.
 *
 * A helper qualifies when its body registers one of its OWN PARAMETERS onto a package-level
 * command — `func f(cmd *cobra.Command) { opsCmd.AddCommand(cmd) }`. That is a shape, not a name,
 * so a second group inventing its own registrar joins without an edit here.
 * @param {Io} io
 * @param {string[]} files
 * @param {Map<string, string>} funcs top-level function bodies, for the helper pass
 * @returns {{edges: Map<string, string[]>, registrars: Map<string, string>}}
 */
function parseEdges(io, files, funcs) {
	/** @type {Map<string, string[]>} */
	const edges = new Map();
	/** @param {string} parent @param {string[]} kids */
	const add = (parent, kids) => {
		if (kids.length > 0) edges.set(parent, [...(edges.get(parent) ?? []), ...kids]);
	};

	// Pass 1 — registration helpers: name → the package-level command they register onto.
	/** @type {Map<string, string>} */
	const registrars = new Map();
	for (const file of files) {
		const src = io.read(file);
		for (const m of src.matchAll(/^func\s+([A-Za-z0-9_]+)\s*\(([^)]*)\)/gm)) {
			const body = funcs.get(m[1]);
			if (body === undefined) continue;
			const params = m[2]
				.split(",")
				.map((p) => p.trim().split(/\s+/)[0])
				.filter((p) => /^[A-Za-z0-9_]+$/.test(p));
			for (const reg of body.matchAll(/([A-Za-z0-9_]+)\.AddCommand\(\s*([A-Za-z0-9_]+)\s*\)/g)) {
				if (params.includes(reg[2])) registrars.set(m[1], reg[1]);
			}
		}
	}

	// Pass 2 — direct edges, and calls to the helpers found above.
	for (const file of files) {
		const src = io.read(file);
		for (const m of src.matchAll(/([A-Za-z0-9_]+)\.AddCommand\(([^)]*)\)/g)) {
			add(
				m[1],
				m[2]
					.split(",")
					.map((s) => s.trim())
					.filter((s) => /^[A-Za-z0-9_]+$/.test(s)),
			);
		}
		for (const [helper, parent] of registrars) {
			for (const call of src.matchAll(new RegExp(`\\b${helper}\\(\\s*([A-Za-z0-9_]+)\\s*\\)`, "g"))) {
				if (call[1] !== undefined) add(parent, [call[1]]);
			}
		}
	}
	return { edges, registrars };
}

/**
 * Every top-level `func name(…)` body in package `cmd`, for the reachability closure.
 *
 * Methods (`func (r recv) name(…)`) are skipped: a receiver makes the call site `x.name(…)`, which
 * this name-based closure cannot resolve to one declaration anyway, and pretending otherwise would
 * add edges that are not there.
 * @param {Io} io
 * @param {string[]} files
 * @returns {Map<string, string>} function name → body source
 */
function parseFuncs(io, files) {
	/** @type {Map<string, string>} */
	const funcs = new Map();
	const decl = /^func\s+([A-Za-z0-9_]+)\s*\(/gm;
	for (const file of files) {
		const src = io.read(file);
		for (const m of src.matchAll(decl)) {
			const open = src.indexOf("{", m.index);
			if (open === -1) continue;
			const close = matchBrace(src, open);
			if (close === -1) continue;
			funcs.set(m[1], src.slice(open, close + 1));
		}
	}
	return funcs;
}

/**
 * Whether a body reaches any of `markers`, following package-`cmd` function calls transitively.
 *
 * FUNCTIONS ONLY, never package-level vars — see the header. The witness chain is returned so the
 * number is auditable: a counter whose individual verdicts cannot be inspected is a number nobody
 * can defend, which is precisely what #4373 asks this script not to produce.
 * @param {string} seedBody
 * @param {Map<string, string>} funcs
 * @param {Array<string|RegExp>} markers a literal token, or a SHAPE — the `must<Group>Field`
 *        helpers are matched by shape so that a seventh noun group joins without an edit here
 * @returns {string[]|null} the chain of function names that reached a marker, or null
 */
function reaches(seedBody, funcs, markers) {
	/** @type {Array<{body: string, chain: string[]}>} */
	const queue = [{ body: seedBody, chain: [] }];
	const seen = new Set();
	while (queue.length > 0) {
		const item = queue.shift();
		if (item === undefined) break;
		for (const marker of markers) {
			const hit = typeof marker === "string" ? item.body.includes(marker) : marker.test(item.body);
			if (hit) return [...item.chain, typeof marker === "string" ? marker : String(marker)];
		}
		for (const call of item.body.matchAll(/\b([A-Za-z0-9_]+)\s*\(/g)) {
			const fn = call[1];
			if (seen.has(fn) || NOT_AN_INPUT_PATH.has(fn) || !funcs.has(fn)) continue;
			seen.add(fn);
			const body = funcs.get(fn);
			if (body !== undefined) queue.push({ body, chain: [...item.chain, fn] });
		}
	}
	return null;
}

/**
 * Command paths in the docs command tree — the CORROBORATING derivation for counter 2.
 *
 * `apps/docs/content/docs/cli/commands/index.mdx` draws the tree with box-drawing characters, and
 * it is written by hand: it is independent of the Go source in exactly the way a second method has
 * to be. It will not agree exactly (it omits hidden commands and lags a new one), so its number is
 * REPORTED beside the parse's and never substituted for it.
 * @param {string} page
 * @returns {number} distinct command paths drawn
 */
function docsTreeCommandCount(page) {
	const fence = /```\n(alethia\n[\s\S]*?)```/.exec(page);
	if (fence === null) return 0;
	let count = 0;
	for (const line of fence[1].split("\n")) {
		if (!/[├└]──/.test(line)) continue;
		const after = line.slice(line.indexOf("──") + 2).trim();
		const token = after.split(/\s+/)[0];
		if (token && /^[a-z][a-z0-9-]*$/.test(token)) count++;
	}
	return count;
}

/**
 * Counter 2. Runnable commands with an interactive path ÷ runnable commands that take input.
 * @param {Io} io
 * @param {number} filesFloor the fewest .go files this census may read before it is refused
 * @returns {Census}
 */
function censusFormCoverage(io, filesFloor) {
	const name = "form coverage";
	const method =
		`cobra tree parsed from \`var x = &cobra.Command{…}\` + \`AddCommand\` across ${CLI_CMD_DIR}/*.go ` +
		`(tests excluded). Runnable = has Run/RunE, matching docsLeaves in hyg_cli_docs_test.go — a ` +
		`runnable GROUP counts, cobra's help/completion and Hidden do not. Takes input = a positional ` +
		`in Use, an own flag, an inherited group persistent flag, or a spec.RegisterFlags binder. ` +
		`Interactive = reaches ${VALUE_WIDGETS.join("/")} through package-cmd function calls`;

	const files = io.list(CLI_CMD_DIR, ".go").filter((f) => !f.endsWith("_test.go"));
	if (files.length === 0) {
		return refused(
			name,
			method,
			`read ZERO non-test .go files under ${CLI_CMD_DIR}. A form-coverage ratio derived from an ` +
				`empty package is the "cli_gap = 0 while the product was unusable" failure exactly.`,
		);
	}
	if (files.length < filesFloor) {
		return refused(
			name,
			method,
			`read ${files.length} command files, below the census floor of ${filesFloor} in ` +
				`${ALLOWLIST_PATH}. The package moved, or this counter stopped seeing most of it.`,
		);
	}

	const cmds = parseCommands(io, files);
	if (cmds.size === 0) {
		return refused(
			name,
			method,
			`discovered ZERO commands in ${files.length} files. The \`var x = &cobra.Command{…}\` shape ` +
				`changed and this parser now matches nothing — every ratio it could print would be 0/0.`,
		);
	}
	const funcs = parseFuncs(io, files);
	const { edges, registrars } = parseEdges(io, files, funcs);

	// Flag registrations, resolved per command variable across the whole package: a command's
	// flags are declared in an init() that may live in any file, so this is a package-wide scan
	// keyed on the variable name rather than a walk of the literal.
	/** @type {Map<string, number>} */
	const ownFlags = new Map();
	/** @type {Map<string, number>} */
	const persistentFlags = new Map();
	for (const file of files) {
		const src = io.read(file);
		for (const m of src.matchAll(/\b([A-Za-z0-9_]+)\.(Flags|PersistentFlags)\(\)\s*\.\s*[A-Za-z0-9_]+\(/g)) {
			const target = m[2] === "Flags" ? ownFlags : persistentFlags;
			target.set(m[1], (target.get(m[1]) ?? 0) + 1);
		}
		for (const m of src.matchAll(/spec\.Register(Persistent)?Flags\(\s*([A-Za-z0-9_]+)\s*,/g)) {
			const target = m[1] === undefined ? ownFlags : persistentFlags;
			target.set(m[2], (target.get(m[2]) ?? 0) + 1);
		}
	}

	// Walk from the root. A command NOT reachable from rootCmd is not part of the user's surface —
	// but it is also the shape a broken AddCommand parse takes, so the count is reported.
	/** @type {Array<{varName: string, path: string[], ancestors: string[]}>} */
	const stack = [{ varName: "rootCmd", path: [], ancestors: [] }];
	/** @type {Array<{cmd: GoCommand, path: string, ancestors: string[]}>} */
	const reachable = [];
	const visited = new Set();
	while (stack.length > 0) {
		const item = stack.pop();
		if (item === undefined) break;
		if (visited.has(item.varName)) continue;
		visited.add(item.varName);
		const cmd = cmds.get(item.varName);
		if (cmd === undefined) continue;
		const isRoot = item.varName === "rootCmd";
		if (!isRoot) {
			if (cmd.hidden || cmd.nameToken === "help" || cmd.nameToken === "completion") continue;
			reachable.push({ cmd, path: ["alethia", ...item.path, cmd.nameToken].join(" "), ancestors: item.ancestors });
		}
		for (const child of edges.get(item.varName) ?? []) {
			stack.push({
				varName: child,
				path: isRoot ? [] : [...item.path, cmd.nameToken],
				ancestors: isRoot ? [] : [...item.ancestors, item.varName],
			});
		}
	}

	const runnable = reachable.filter((r) => r.cmd.runnable);
	if (runnable.length === 0) {
		return refused(
			name,
			method,
			`discovered ${cmds.size} command literals but ZERO RUNNABLE ones reachable from rootCmd. ` +
				`Either the Run/RunE detection or the AddCommand edge parse stopped matching — a ratio ` +
				`over an empty leaf set is vacuous in both directions.`,
		);
	}

	/** @type {string[]} */
	const findings = [];
	/** @type {string[]} */
	const witnesses = [];
	/** @type {Map<string, number>} */
	const viaHelper = new Map();
	let takingInput = 0;
	let interactive = 0;
	let confirmOnly = 0;
	let onTheKit = 0;
	for (const r of runnable) {
		const own = ownFlags.get(r.cmd.varName) ?? 0;
		// Root's persistent flags (-o/--output, --no-input, --org) are on EVERY command and say
		// nothing about whether this one takes input; only a GROUP's persistent flags do.
		const inherited = r.ancestors.reduce((n, a) => n + (persistentFlags.get(a) ?? 0), 0);
		const takes = r.cmd.positionals.length > 0 || own > 0 || inherited > 0;
		if (!takes) continue;
		takingInput++;
		if (reaches(r.cmd.body, funcs, [...FIELD_SPEC_MARKERS, MUST_FIELD_SHAPE]) !== null) onTheKit++;
		const chain = reaches(r.cmd.body, funcs, VALUE_WIDGETS);
		if (chain !== null) {
			interactive++;
			witnesses.push(`${r.path} → ${chain.join(" → ")}`);
			const hop = chain.length === 1 ? "(in the command literal)" : chain[0];
			viaHelper.set(hop, (viaHelper.get(hop) ?? 0) + 1);
			continue;
		}
		const confirm = reaches(r.cmd.body, funcs, [CONFIRM_WIDGET]);
		if (confirm !== null) confirmOnly++;
		findings.push(
			`${r.path} (${r.cmd.file}) takes input [${[
				r.cmd.positionals.length > 0 ? `${r.cmd.positionals.length} positional` : "",
				own > 0 ? `${own} flag` : "",
				inherited > 0 ? `${inherited} inherited` : "",
			]
				.filter(Boolean)
				.join(", ")}] with no form${confirm === null ? "" : " (reaches a CONFIRM only)"}`,
		);
	}

	if (takingInput === 0) {
		return refused(
			name,
			method,
			`found ${runnable.length} runnable commands and ZERO that take input. Every command in this ` +
				`CLI takes something; the flag/positional detection has stopped matching, and a ratio ` +
				`with a zero denominator is the vacuous all-clear this counter exists to refuse.`,
		);
	}

	const pct = ((interactive / takingInput) * 100).toFixed(1);
	const treePage = `${CLI_DOCS_DIR}/commands/index.mdx`;
	const docsCount = io.exists(treePage) ? docsTreeCommandCount(io.read(treePage)) : 0;
	// The control that found the ops group. A literal with no parent is either a deliberately
	// unregistered command or an edge this parser cannot see, and the two are indistinguishable
	// from here — so the count is PRINTED rather than absorbed. It is how the next helper shape
	// announces itself instead of quietly shrinking the denominator.
	const orphans = [...cmds.keys()].filter((v) => v !== "rootCmd" && !visited.has(v));
	const notes = [
		`primary: ${cmds.size} command literals parsed, ${reachable.length} reachable from rootCmd, ` +
			`${runnable.length} of them runnable, ${takingInput} taking input.`,
		`${registrars.size} registration helper(s) resolved (${[...registrars.entries()].map(([h, p]) => `${h}→${p}`).join(", ") || "none"}); ` +
			`${orphans.length} literal(s) still have no parent${orphans.length === 0 ? "." : `: ${orphans.join(", ")}. Each is outside every number above — check whether it is deliberately unregistered or registered by a shape this parse cannot see.`}`,
		`corroborating: the hand-drawn command tree in ${treePage} draws ${docsCount} commands ` +
			`(independent of the Go parse; it omits hidden commands and lags a new one, so exact ` +
			`agreement is NOT expected). Delta vs reachable: ${reachable.length - docsCount}.` +
			`${docsCount === 0 ? " IT DREW ZERO — the tree fence moved and this corroboration is inert." : ""}`,
		`${confirmOnly} of the ${takingInput - interactive} uncovered commands reach a ${CONFIRM_WIDGET} ` +
			`and nothing else. A confirmation is not a way to supply an input and is not counted; see the header.`,
		`blind spot, stated: the closure follows package-cmd FUNCTIONS only, so a form reached through ` +
			`a package-level var indirection is invisible and ${interactive} is a FLOOR on the numerator.`,
		`CAVEAT, and it is the one that decides what this percentage means: the unit is #3664's — a ` +
			`LEAF — so a command counts as covered when ANY of its inputs can be asked for, not when ` +
			`all of them can. A command that picks its project interactively and still cannot ask for ` +
			`its own required argument is in the numerator. A per-FIELD ratio needs a per-command field ` +
			`spec, which exists for the six groups on pkg/spec and nowhere else, so it is not derivable ` +
			`from this tree today and is not reported rather than being estimated.`,
		`${onTheKit} of the ${takingInput} reach the FIELD-SPEC KIT (a \`must<Group>Field\` helper or a ` +
			`spec.RegisterFlags/Resolve binder). This is the question #4373 records three greps ` +
			`disagreeing about — 2 of 85, 0 of 6, 70 — and the method is stated in FIELD_SPEC_MARKERS: ` +
			`the shapes a COMMAND reaches the kit by, never \`spec.Field{\`, which is the spelling the ` +
			`alias \`type authField = spec.Field\` makes invisible.`,
		`the numerator's evidence, by FIRST HOP — a transitive reachability result is the least ` +
			`inspectable kind of number, so the chain that reached a widget is recorded for every one ` +
			`of the ${interactive}: ${[...viaHelper.entries()]
				.sort((a, b) => b[1] - a[1])
				.map(([hop, n]) => `${hop}×${n}`)
				.join(", ")}. --json prints each chain.`,
	];
	return {
		name,
		method,
		refusal: null,
		value: interactive,
		rendered: `${interactive} / ${takingInput} (${pct}%)`,
		notes,
		findings,
		witnesses,
	};
}

// ── counter 3 · allowlist rows ────────────────────────────────────────────────────────────────

/** The CLI's shared-surface allowlist. Its ABSENCE is a refusal, not a zero. */
const ALLOWLIST_PATH = "apps/cli/cli-surface-allowlist.yaml";

/** The ledger keys the file must declare. A file with none of them is a parse failure, not a zero. */
const LEDGER_KEYS = ["baseline", "debt"];

/**
 * Counter 3, and the census floors the other counters read.
 *
 * A line parser, not a YAML library: `yaml` is a dependency of apps/console, not of the root, and
 * this runs under plain `node` — the same constraint check-pnpm-script-refs.mjs and
 * check-workflow-shape.mjs work under. The shape it reads is fixed by this file's own header.
 * @param {Io} io
 * @returns {{census: Census, floors: Record<string, number>}}
 */
function censusAllowlist(io) {
	const name = "allowlist entries";
	const method =
		`rows in ${ALLOWLIST_PATH}, counted as \`reason:\` (a DECISION → baseline) and \`lifts:\` ` +
		`(measured drift a board issue removes → debt), cross-checked against the file's own ` +
		`\`baseline:\`/\`debt:\` counters`;

	if (!io.exists(ALLOWLIST_PATH)) {
		return {
			census: refused(
				name,
				method,
				`${ALLOWLIST_PATH} IS MISSING. An absent allowlist is not an allowlist with no entries: ` +
					`nothing is recording what the CLI is excused from, so a count of 0 would read as ` +
					`"the whole CLI conforms". Create it — the header of this script says what it holds.`,
			),
			floors: {},
		};
	}
	/** @type {string} */
	let raw;
	try {
		raw = io.read(ALLOWLIST_PATH);
	} catch (err) {
		return {
			census: refused(name, method, `${ALLOWLIST_PATH} exists but could not be read: ${String(err)}`),
			floors: {},
		};
	}

	const lines = raw.split("\n");
	/** @type {Record<string, number>} */
	const declared = {};
	for (const key of LEDGER_KEYS) {
		const m = new RegExp(`^${key}:\\s*(\\d+)\\s*$`, "m").exec(raw);
		if (m !== null) declared[key] = Number(m[1]);
	}
	const missingKeys = LEDGER_KEYS.filter((k) => !(k in declared));
	if (missingKeys.length > 0) {
		return {
			census: refused(
				name,
				method,
				`${ALLOWLIST_PATH} declares no ${missingKeys.join(" and no ")} counter. The file is ` +
					`present but this parser understood none of it, which is a broken read reported as a ` +
					`clean zero unless it is refused here.`,
			),
			floors: {},
		};
	}

	let baseline = 0;
	let debt = 0;
	/** @type {string[]} */
	const findings = [];
	/** @type {Record<string, number>} */
	const floors = {};
	let scope = "";
	for (const line of lines) {
		if (/^\s*#/.test(line)) continue;
		const reason = /^\s*(?:-\s*)?reason:\s*\S/.exec(line);
		if (reason !== null) {
			baseline++;
			findings.push(`baseline row: ${line.trim().slice(0, 120)}`);
			continue;
		}
		if (/^\s*(?:-\s*)?lifts:\s*\S/.test(line)) {
			debt++;
			findings.push(`debt row: ${line.trim().slice(0, 120)}`);
			continue;
		}
		const scopeM = /^\s*-\s*scope:\s*([A-Za-z0-9_]+)\s*$/.exec(line);
		if (scopeM !== null) {
			scope = scopeM[1];
			continue;
		}
		const floorM = /^\s*floor:\s*(\d+)\s*$/.exec(line);
		if (floorM !== null && scope !== "") {
			floors[scope] = Number(floorM[1]);
			scope = "";
		}
	}

	const notes = [
		`baseline (decisions) ${baseline}, debt (measured drift) ${debt}.`,
		`the file's own counters say baseline ${declared.baseline}, debt ${declared.debt}` +
			`${declared.baseline === baseline && declared.debt === debt ? " — they agree with the rows." : " — THEY DISAGREE WITH THE ROWS above; one of the two is wrong and neither may be believed."}`,
		`census floors declared: ${Object.keys(floors).length === 0 ? "NONE" : Object.entries(floors).map(([k, v]) => `${k}=${v}`).join(", ")}.`,
		`zero rows is a legitimate reading and a missing FILE is not: report mode has recorded no ` +
			`decisions yet, and pre-seeding the CLI's unconverted surface as ~110 fake "decisions" ` +
			`would empty the word before the ratchet ran. Counter 2 measures that surface.`,
	];
	return {
		census: {
			name,
			method,
			refusal:
				declared.baseline === baseline && declared.debt === debt
					? null
					: `${ALLOWLIST_PATH}'s counters disagree with its rows (declared baseline ` +
						`${declared.baseline}/debt ${declared.debt}, counted ${baseline}/${debt}). ` +
						`Fix the counters; do not fix the rows to suit them.`,
			value: baseline + debt,
			rendered: `${baseline + debt} (baseline ${baseline} + debt ${debt})`,
			notes,
			findings,
		},
		floors,
	};
}

// ── counter 4 · unlocked mirrors ──────────────────────────────────────────────────────────────

/** The Go test that IS the mirror-locking mechanism; both halves of "locked" are read out of it. */
const MIRROR_MECHANISM = "packages/core/jsonbmirror/jsonb_mirror_test.go";

/** Roots scanned for claims. The mechanism's own file is excluded — it QUOTES the phrase. */
const MIRROR_ROOTS = [
	{ dir: "apps/console", ext: ".ts" },
	{ dir: "apps/console", ext: ".tsx" },
	{ dir: "apps/cli", ext: ".go" },
	{ dir: "packages", ext: ".ts" },
];

/**
 * The Go types a source file CLAIMS to mirror.
 *
 * The regex is the mechanism's own (`mirrorClaimRe`), including its comment-continuation join, so
 * a claim wrapped across two comment lines is one claim here too. Reduced to the last dotted
 * segment, because a claim writes `verify.Report` or bare `RepoDigest` depending on who wrote it.
 *
 * A `Mirrors the Go` phrase with NO backticked type — "Mirrors the Go pattern in …/s3.go" — names
 * nothing a fixture could lock and is NOT returned here. It comes back through `prose` instead:
 * an absent claim and an unenforced claim are different states, and only the second is a finding.
 * @param {string} raw
 * @returns {{claims: string[], prose: number}}
 */
function mirrorClaims(raw) {
	const flat = raw.replace(/\n[ \t]*(?:\*\/?|\/\/)[ \t]*/g, " ");
	/** @type {string[]} */
	const claims = [];
	for (const m of flat.matchAll(/mirrors the go `([^`]+)`/gi)) {
		const name = m[1];
		const i = name.lastIndexOf(".");
		claims.push(i >= 0 ? name.slice(i + 1) : name);
	}
	const all = [...flat.matchAll(/mirrors the go\b/gi)].length;
	return { claims, prose: all - claims.length };
}

/**
 * What the mechanism answers: every Go type named by a fixture pair (`GoName:`), a value
 * vocabulary (`GoType:`) or a named `unlockableClaims` entry, reduced to its last segment.
 *
 * Read out of the mechanism rather than restated, so this census cannot claim a lock the test does
 * not have. An unreadable mechanism is a REFUSAL at the caller, never an empty covered-set — an
 * empty one would mark every claim in the repo unlocked and print a large, confident, wrong number.
 * @param {string} raw the mechanism's source
 * @returns {{covered: Set<string>, enrolled: string|null}}
 */
function mirrorMechanism(raw) {
	/** @type {Set<string>} */
	const covered = new Set();
	for (const m of raw.matchAll(/\b(?:GoName|GoType):\s*"([^"]+)"/g)) {
		const i = m[1].lastIndexOf(".");
		covered.add(i >= 0 ? m[1].slice(i + 1) : m[1]);
	}
	const unlockable = /unlockableClaims\s*=\s*map\[string\]string\{([\s\S]*?)\n\}/.exec(raw);
	if (unlockable !== null) {
		for (const m of unlockable[1].matchAll(/"([^"]+)"\s*:/g)) covered.add(m[1]);
	}
	const enrolled = /tsMirrorFile\s*=\s*"([^"]+)"/.exec(raw);
	return { covered, enrolled: enrolled === null ? null : enrolled[1] };
}

/**
 * Counter 4. `Mirrors the Go X` claims with no mechanism behind them.
 * @param {Io} io
 * @returns {Census}
 */
function censusMirrors(io) {
	const name = "unlocked mirrors";
	const method =
		`backticked \`Mirrors the Go \\\`Type\\\`\` claims across apps/console, apps/cli and packages, ` +
		`matched with ${MIRROR_MECHANISM}'s own regex; a claim is LOCKED when it sits in that ` +
		`mechanism's enrolled file AND its type is answered by a fixture pair, a value vocabulary or ` +
		`a named unlockableClaims entry`;

	if (!io.exists(MIRROR_MECHANISM)) {
		return refused(
			name,
			method,
			`${MIRROR_MECHANISM} is missing. That file is the ONLY thing that locks a mirror claim; ` +
				`without it this counter cannot tell a locked claim from an unlocked one, and reporting ` +
				`every claim as unlocked would be a large confident wrong number.`,
		);
	}
	const { covered, enrolled } = mirrorMechanism(io.read(MIRROR_MECHANISM));
	if (enrolled === null || covered.size === 0) {
		return refused(
			name,
			method,
			`read ${MIRROR_MECHANISM} but found ${enrolled === null ? "no enrolled file (tsMirrorFile)" : "no covered types"}. ` +
				`Its shape changed; a census that believes the mechanism covers nothing marks every claim ` +
				`in the repository unlocked.`,
		);
	}

	/** @type {string[]} */
	const files = [];
	for (const root of MIRROR_ROOTS) {
		for (const f of io.list(root.dir, root.ext)) {
			if (f === MIRROR_MECHANISM || files.includes(f)) continue;
			files.push(f);
		}
	}

	let claimCount = 0;
	let proseCount = 0;
	let unexportedCount = 0;
	let locked = 0;
	/** @type {string[]} */
	const findings = [];
	/** @type {string[]} */
	const unexportedFindings = [];
	for (const file of files) {
		const raw = io.read(file);
		if (!/mirrors the go/i.test(raw)) continue; // an ABSENT claim is not a finding.
		const { claims, prose } = mirrorClaims(raw);
		proseCount += prose;
		for (const claim of claims) {
			claimCount++;
			if (file === enrolled && covered.has(claim)) {
				locked++;
				continue;
			}
			// A THIRD state, and it is neither absent nor unenforced: a claim naming an UNEXPORTED
			// Go identifier. The mechanism locks a claim by constructing the Go type from another
			// package (`new(verify.Report)`), which an unexported name makes impossible — so
			// "mirrors the Go `valid` table" is a claim no fixture pair could ever answer, however
			// much anyone wanted to. Reported, never counted: putting it in the finding list would
			// give #3664 a ratchet with a floor it can never reach.
			if (!/^[A-Z]/.test(claim)) {
				unexportedCount++;
				unexportedFindings.push(`${file}: \`${claim}\` names an unexported Go identifier`);
				continue;
			}
			findings.push(
				`${file}: \`${claim}\` is ${
					file === enrolled
						? `in the enrolled file but no fixture pair, vocabulary or unlockableClaims entry answers it`
						: `outside ${MIRROR_MECHANISM}'s enrolled file (${enrolled}) — nothing is watching it`
				}`,
			);
		}
	}

	if (claimCount === 0) {
		return refused(
			name,
			method,
			`found ZERO \`Mirrors the Go X\` claims across ${files.length} files. The phrase changed, or ` +
				`the roots moved — this counter would then police an empty set and print a clean 0, which ` +
				`is the same sentence as "every claim is locked".`,
		);
	}

	const unlocked = claimCount - locked - unexportedCount;
	const notes = [
		`${claimCount} backticked claims: ${locked} locked by ${MIRROR_MECHANISM}, ${unexportedCount} ` +
			`naming an unexported identifier no fixture pair can construct, ${unlocked} UNLOCKED.`,
		`enrolled file: ${enrolled}; the mechanism answers ${covered.size} distinct Go types.`,
		`three states, and only ONE is a finding — this is #4373's requirement for this counter made ` +
			`mechanical. ABSENT: ${proseCount} further "Mirrors the Go …" phrases name no backticked ` +
			`type ("Mirrors the Go pattern in …/s3.go"), and a file with no phrase at all is not read ` +
			`— there is nothing for a fixture pair to lock, so neither is a finding. UNLOCKABLE: the ` +
			`${unexportedCount} above. UNENFORCED: the ${unlocked} below, each a real exported Go type ` +
			`claimed as a mirror with nothing watching it.`,
		`corroborating: ${files.length} files scanned, of which ${
			files.filter((f) => /mirrors the go/i.test(io.read(f))).length
		} carry the phrase at all; ${claimCount + proseCount} phrase occurrences in total.`,
		...(unexportedFindings.length > 0 ? [`unlockable, reported not counted: ${unexportedFindings.join("; ")}`] : []),
	];
	return { name, method, refusal: null, value: unlocked, rendered: String(unlocked), notes, findings };
}

// ── the run ───────────────────────────────────────────────────────────────────────────────────

/**
 * Run all four counters. The allowlist is censused FIRST because it carries the census floors the
 * other two read — and a missing allowlist therefore leaves them with no floor, which is why an
 * absent floor means "bare zero only" rather than "pass".
 * @param {Io} io
 * @returns {Census[]}
 */
function runCensus(io) {
	const { census: allowlist, floors } = censusAllowlist(io);
	return [
		censusHandoffs(io, floors.cli_docs ?? 0),
		censusFormCoverage(io, floors.cli_cmd ?? 0),
		allowlist,
		censusMirrors(io),
	];
}

/**
 * Print the census and return the process exit code. A REFUSAL is printed in place of the number
 * it would otherwise have replaced, never beside one.
 * @param {Census[]} censuses
 * @param {boolean} asJson
 * @returns {number}
 */
function report(censuses, asJson) {
	if (asJson) {
		console.log(JSON.stringify({ generated: "check-cli-surface.mjs", censuses }, null, 2));
		return censuses.some((c) => c.refusal !== null) ? 1 : 0;
	}
	console.log("CLI surface census — REPORT MODE (#4373). Nothing here fails a required check.\n");
	for (const c of censuses) {
		if (c.refusal !== null) {
			console.log(`✗ ${c.name}: REFUSED`);
			console.log(`    ${c.refusal}`);
			console.log(`    method: ${c.method}\n`);
			continue;
		}
		console.log(`· ${c.name}: ${c.rendered}`);
		console.log(`    method: ${c.method}`);
		for (const n of c.notes) console.log(`    note: ${n}`);
		if (c.findings.length > 0) {
			const shown = c.findings.slice(0, 12);
			for (const f of shown) console.log(`      - ${f}`);
			if (c.findings.length > shown.length) {
				console.log(`      … and ${c.findings.length - shown.length} more (--json prints all)`);
			}
		}
		console.log("");
	}
	const refusals = censuses.filter((c) => c.refusal !== null);
	if (refusals.length > 0) {
		console.error(
			`check-cli-surface: ${refusals.length} of ${censuses.length} counters REFUSED to report a ` +
				`number. An empty census is not a clean one.`,
		);
		return 1;
	}
	console.log("All four counters reported a number over a non-empty census.");
	return 0;
}

// ── self-test ─────────────────────────────────────────────────────────────────────────────────
//
// Both directions of every counter, on fixtures held as strings here rather than as files on disk:
// a fixture that produces a FINDING, a fixture that produces a clean ZERO, and a fixture that
// produces the counter's VACUITY REFUSAL. The third is the one this repository keeps needing —
// "nothing found" and "nothing wrong" have to arrive by different branches, and the only way to
// prove that is to drive the empty tree.

let failures = 0;
/**
 * One assertion.
 * @param {string} label
 * @param {boolean} pass
 */
function ok(label, pass) {
	if (pass) {
		console.log(`  ok   ${label}`);
		return;
	}
	failures++;
	console.log(`  FAIL ${label}`);
}

/** A minimal allowlist fixture with both ledgers at zero and no census floors. @returns {string} */
function fixtureAllowlist(baseline = 0, debt = 0, rows = "") {
	return `# fixture\nbaseline: ${baseline}\ndebt: ${debt}\n\nscanned:\n  - scope: cli_docs\n    floor: 1\n  - scope: cli_cmd\n    floor: 1\n\nformat:\n${rows}`;
}

/** A minimal mirror mechanism fixture. @returns {string} */
function fixtureMechanism() {
	return [
		"const tsMirrorFile = \"apps/console/types/jsonb.types.ts\"",
		"func mirrorPairs() []mirrorPair {",
		'\treturn []mirrorPair{{TSName: "A", GoName: "verify.Report", Fixture: "a.json"}}',
		"}",
		"var unlockableClaims = map[string]string{",
		'\t"Legacy": "no fixture exists",',
		"}",
	].join("\n");
}

/** Drive every counter in all three directions. Exits 1 on any failure. */
function selfTest() {
	console.log("check-cli-surface self-test\n");

	// ── counter 1 · handoffs ──────────────────────────────────────────────────────────────────
	console.log("counter 1 · handoffs");
	{
		const dirty = memoryIo({
			[`${CLI_DOCS_DIR}/a.mdx`]: "```bash\nalethia jobs logs <job-id>\n```\n",
			[ALLOWLIST_PATH]: fixtureAllowlist(),
		});
		const c = censusHandoffs(dirty, 1);
		ok("a `<job-id>` example is a finding", c.refusal === null && c.value === 1 && c.findings.length === 1);

		const clean = memoryIo({ [`${CLI_DOCS_DIR}/a.mdx`]: "```bash\nalethia jobs logs --latest\n```\n" });
		const cc = censusHandoffs(clean, 1);
		ok("a runnable example is a clean zero", cc.refusal === null && cc.value === 0);

		// The zero-census refusals, which are the point of the counter.
		ok("ZERO DOCS PAGES is a refusal, not a zero", censusHandoffs(memoryIo({}), 0).refusal !== null);
		ok(
			"a page with no shell fences is a refusal, not a zero",
			censusHandoffs(memoryIo({ [`${CLI_DOCS_DIR}/a.mdx`]: "# just prose\n" }), 1).refusal !== null,
		);
		ok(
			"reading fewer pages than the floor is a refusal",
			censusHandoffs(memoryIo({ [`${CLI_DOCS_DIR}/a.mdx`]: "```bash\nalethia x <y>\n```\n" }), 9).refusal !== null,
		);
		// A refusal must not also carry a number a reader could quote.
		ok("a refused census renders REFUSED, never a digit", censusHandoffs(memoryIo({}), 0).rendered === "REFUSED");

		// The collection rule, both directions — the same two arms the Go guard pins, because a
		// tokeniser that silently stopped splitting would make every count above a clean zero.
		ok("an UNTAGGED fence yields no example", fencedExamples("```\nalethia x\n```\n").length === 0);
		ok("a shell fence yields one", fencedExamples("```bash\nalethia x\n```\n").length === 1);
		ok(
			"a trailing backslash joins the continuation",
			fencedExamples("```bash\nalethia chart attach api \\\n  -p <shop>\n```\n")[0] ===
				"alethia chart attach api -p <shop>",
		);
		ok("a token after a pipe is not ours", fencedExamples("```bash\nalethia x | jq <sel>\n```\n")[0] === "alethia x");
		ok("`oci://x/y` is not a placeholder", !placeholderToken("oci://x/y"));
		ok("`--repo=<url>` is", placeholderToken("--repo=<url>"));
		ok("`8f3c2a1e-...` is", placeholderToken("8f3c2a1e-..."));
		ok("`[sel]` is", placeholderToken("[sel]"));
		ok("`[]` is not — nothing to substitute", !placeholderToken("[]"));

		// The shape breakdown, which is what makes the total defensible: a reader deciding what to
		// fix has to be able to tell a copied id from usage notation that leaked into an example.
		const shaped = censusHandoffs(
			memoryIo({
				[`${CLI_DOCS_DIR}/a.mdx`]: "```bash\nalethia jobs logs <id>\nalethia jobs get 8f3c...\nalethia jobs list [--all]\n```\n",
			}),
			1,
		);
		ok(
			"the three placeholder shapes are counted apart",
			shaped.value === 3 &&
				(shaped.notes.find((n) => n.startsWith("by shape:")) ?? "").includes("1 substitutions") &&
				(shaped.notes.find((n) => n.startsWith("by shape:")) ?? "").includes("1 truncated") &&
				(shaped.notes.find((n) => n.startsWith("by shape:")) ?? "").includes("1 bracketed"),
		);
	}

	// ── counter 2 · form coverage ─────────────────────────────────────────────────────────────
	console.log("\ncounter 2 · form coverage");
	{
		const root = 'var rootCmd = &cobra.Command{Use: "alethia"}\n';
		const goFile = (body) => `package cmd\n${root}${body}`;

		const uncovered = memoryIo({
			[`${CLI_CMD_DIR}/a.go`]: goFile(
				'var aCmd = &cobra.Command{Use: "create [name]", Run: func() { doThing() }}\n' +
					"func init() { rootCmd.AddCommand(aCmd) }\n" +
					"func doThing() { fmt.Println(1) }\n",
			),
		});
		const u = censusFormCoverage(uncovered, 1);
		ok("a command with a positional and no form is uncovered", u.refusal === null && u.value === 0 && u.rendered.startsWith("0 / 1"));

		const covered = memoryIo({
			[`${CLI_CMD_DIR}/a.go`]: goFile(
				'var aCmd = &cobra.Command{Use: "create [name]", Run: func() { promptName() }}\n' +
					"func init() { rootCmd.AddCommand(aCmd) }\n" +
					"func promptName() { huh.NewInput().Value(&v) }\n",
			),
		});
		const cv = censusFormCoverage(covered, 1);
		ok("a form reached through a helper IS covered", cv.refusal === null && cv.value === 1);

		// The auth gate, both directions. This is the exclusion that decides whether the ratio
		// means anything, so it is driven rather than asserted in a comment.
		const authOnly = memoryIo({
			[`${CLI_CMD_DIR}/a.go`]: goFile(
				'var aCmd = &cobra.Command{Use: "create [name]", Run: func() { getAuthToken() }}\n' +
					"func init() { rootCmd.AddCommand(aCmd) }\n" +
					"func getAuthToken() { huh.NewInput().Value(&v) }\n",
			),
		});
		ok("the AUTH GATE does not make a command interactive", censusFormCoverage(authOnly, 1).value === 0);
		const authRenamed = memoryIo({
			[`${CLI_CMD_DIR}/a.go`]: goFile(
				'var aCmd = &cobra.Command{Use: "create [name]", Run: func() { notTheAuthGate() }}\n' +
					"func init() { rootCmd.AddCommand(aCmd) }\n" +
					"func notTheAuthGate() { huh.NewInput().Value(&v) }\n",
			),
		});
		ok("...and the exclusion is BY NAME, not a blanket refusal to follow calls", censusFormCoverage(authRenamed, 1).value === 1);

		// A confirmation is not an input path — the other direction of the same decision.
		const confirmOnly = memoryIo({
			[`${CLI_CMD_DIR}/a.go`]: goFile(
				'var aCmd = &cobra.Command{Use: "delete [id]", Run: func() { huh.NewConfirm().Title("sure?") }}\n' +
					"func init() { rootCmd.AddCommand(aCmd) }\n",
			),
		});
		const co = censusFormCoverage(confirmOnly, 1);
		ok("a CONFIRM alone is not an interactive path", co.value === 0);
		ok("...and it is reported as such rather than dropped", co.notes.some((n) => n.includes("reach a huh.NewConfirm")));

		// Hidden, help and completion are outside the census, matching docsLeaves.
		const hidden = memoryIo({
			[`${CLI_CMD_DIR}/a.go`]: goFile(
				'var aCmd = &cobra.Command{Use: "secret [x]", Hidden: true, Run: func() {}}\n' +
					'var bCmd = &cobra.Command{Use: "real [x]", Run: func() {}}\n' +
					"func init() { rootCmd.AddCommand(aCmd, bCmd) }\n",
			),
		});
		ok("a Hidden command is not in the denominator", censusFormCoverage(hidden, 1).rendered.startsWith("0 / 1"));

		// A runnable GROUP counts, which a subcommands-only walk cannot see.
		const runnableGroup = memoryIo({
			[`${CLI_CMD_DIR}/a.go`]: goFile(
				'var aCmd = &cobra.Command{Use: "activity", Run: func() {}}\n' +
					"func init() { rootCmd.AddCommand(aCmd); aCmd.Flags().String(\"since\", \"\", \"\") }\n",
			),
		});
		ok("a RUNNABLE GROUP is a leaf", censusFormCoverage(runnableGroup, 1).rendered.endsWith("(0.0%)"));

		// A group's persistent flag reaches its children; the root's does not reach anything.
		const inherited = memoryIo({
			[`${CLI_CMD_DIR}/a.go`]: goFile(
				'var gCmd = &cobra.Command{Use: "cost"}\n' +
					'var sCmd = &cobra.Command{Use: "show", Run: func() {}}\n' +
					'func init() { rootCmd.AddCommand(gCmd); gCmd.AddCommand(sCmd); gCmd.PersistentFlags().String("project", "", "") }\n',
			),
		});
		ok("a GROUP persistent flag puts its child in the denominator", censusFormCoverage(inherited, 1).rendered.includes("/ 1"));
		const rootOnly = memoryIo({
			[`${CLI_CMD_DIR}/a.go`]:
				`package cmd\nvar rootCmd = &cobra.Command{Use: "alethia"}\n` +
				'var sCmd = &cobra.Command{Use: "show", Run: func() {}}\n' +
				'func init() { rootCmd.AddCommand(sCmd); rootCmd.PersistentFlags().String("output", "", "") }\n',
		});
		ok(
			"a ROOT persistent flag does NOT — it is on every command and says nothing",
			censusFormCoverage(rootOnly, 1).refusal !== null,
		);

		// The zero-census refusals.
		ok("ZERO command files is a refusal", censusFormCoverage(memoryIo({}), 0).refusal !== null);
		ok(
			"files but ZERO commands is a refusal",
			censusFormCoverage(memoryIo({ [`${CLI_CMD_DIR}/a.go`]: "package cmd\nfunc x() {}\n" }), 1).refusal !== null,
		);
		ok(
			"commands but ZERO runnable is a refusal",
			censusFormCoverage(
				memoryIo({
					[`${CLI_CMD_DIR}/a.go`]: goFile('var aCmd = &cobra.Command{Use: "g"}\nfunc init() { rootCmd.AddCommand(aCmd) }\n'),
				}),
				1,
			).refusal !== null,
		);
		ok(
			"runnable but ZERO taking input is a refusal (a 0-denominator ratio is vacuous)",
			censusFormCoverage(
				memoryIo({
					[`${CLI_CMD_DIR}/a.go`]: goFile('var aCmd = &cobra.Command{Use: "ping", Run: func() {}}\nfunc init() { rootCmd.AddCommand(aCmd) }\n'),
				}),
				1,
			).refusal !== null,
		);
		ok(
			"reading fewer command files than the floor is a refusal",
			censusFormCoverage(memoryIo({ [`${CLI_CMD_DIR}/a.go`]: goFile("") }), 9).refusal !== null,
		);

		// A REGISTRATION HELPER, both directions. This is the arm that found the break-glass group:
		// a direct-AddCommand-only parse left the whole `ops` noun group parentless and out of the
		// ratio, and said nothing.
		const viaRegistrar = memoryIo({
			[`${CLI_CMD_DIR}/a.go`]: goFile(
				'var gCmd = &cobra.Command{Use: "ops"}\n' +
					'var vCmd = &cobra.Command{Use: "approve [id]", Run: func() {}}\n' +
					"func registerOpsVerb(c *cobra.Command) { gCmd.AddCommand(c) }\n" +
					"func init() { rootCmd.AddCommand(gCmd); registerOpsVerb(vCmd) }\n",
			),
		});
		const vr = censusFormCoverage(viaRegistrar, 1);
		ok("a command registered through a HELPER is reachable", vr.rendered.startsWith("0 / 1"));
		ok(
			"...and a literal with no parent at all is REPORTED, not absorbed",
			(censusFormCoverage(
				memoryIo({
					[`${CLI_CMD_DIR}/a.go`]: goFile(
						'var aCmd = &cobra.Command{Use: "real [x]", Run: func() {}}\n' +
							'var zCmd = &cobra.Command{Use: "orphan [x]", Run: func() {}}\n' +
							"func init() { rootCmd.AddCommand(aCmd) }\n",
					),
				}),
				1,
			).notes.find((n) => n.includes("still have no parent")) ?? "").includes("zCmd"),
		);
		ok(
			"...and a helper that registers something OTHER than its parameter is not a registrar",
			(censusFormCoverage(
				memoryIo({
					[`${CLI_CMD_DIR}/a.go`]: goFile(
						'var gCmd = &cobra.Command{Use: "g"}\n' +
							'var vCmd = &cobra.Command{Use: "v [x]", Run: func() {}}\n' +
							'var wCmd = &cobra.Command{Use: "w [x]", Run: func() {}}\n' +
							"func notARegistrar(c *cobra.Command) { gCmd.AddCommand(vCmd) }\n" +
							"func init() { rootCmd.AddCommand(gCmd); notARegistrar(wCmd) }\n",
					),
				}),
				1,
			).notes.find((n) => n.includes("still have no parent")) ?? "").includes("wCmd"),
		);

		// The brace matcher: a `}` inside a Long string must not close the literal early, or a
		// perfectly good command silently loses its Run and drops out of the census.
		const braceInString = memoryIo({
			[`${CLI_CMD_DIR}/a.go`]: goFile(
				'var aCmd = &cobra.Command{Use: "create [name]", Long: "use ${x} here", Run: func() { huh.NewInput() }}\n' +
					"func init() { rootCmd.AddCommand(aCmd) }\n",
			),
		});
		ok("a brace inside a string does not truncate the literal", censusFormCoverage(braceInString, 1).value === 1);

		// _test.go is excluded: a guard that counted its own fixtures would report a surface that
		// no user can reach.
		const withTest = memoryIo({
			[`${CLI_CMD_DIR}/a.go`]: goFile('var aCmd = &cobra.Command{Use: "create [n]", Run: func() {}}\nfunc init() { rootCmd.AddCommand(aCmd) }\n'),
			[`${CLI_CMD_DIR}/a_test.go`]: 'package cmd\nvar zCmd = &cobra.Command{Use: "fixture [n]", Run: func() {}}\nfunc init() { rootCmd.AddCommand(zCmd) }\n',
		});
		ok("a _test.go command is not part of the surface", censusFormCoverage(withTest, 1).rendered.startsWith("0 / 1"));

		// The witness chain. A transitive reachability number nobody can inspect is a number nobody
		// can defend, so the evidence is required to be there and to name the real path.
		ok(
			"every positive verdict carries its witness chain",
			(censusFormCoverage(covered, 1).witnesses ?? [])[0] === "alethia create → promptName → huh.NewInput",
		);

		// The field-spec-kit figure, both directions — and specifically the ALIAS trap #4373
		// documents: a table built entirely on `spec.Field` through an alias contains no
		// `spec.Field{`, so a marker that looked for one would report the exact 0-of-6 that misled
		// a session into rewriting finished work.
		const viaAlias = memoryIo({
			[`${CLI_CMD_DIR}/a.go`]: goFile(
				'var aCmd = &cobra.Command{\n\tUse: "create [name]",\n\tRun: func() { mustOrgField("alethia create", "name") },\n}\n' +
					"func init() { rootCmd.AddCommand(aCmd) }\n",
			),
			[`${CLI_CMD_DIR}/org_fields.go`]: "package cmd\ntype orgField = spec.Field\nvar orgFields = []orgField{{Key: \"name\"}}\n",
		});
		const alias = censusFormCoverage(viaAlias, 1);
		ok(
			"a command on the kit THROUGH AN ALIAS is seen (the 0-of-6 grep trap)",
			(alias.notes.find((n) => n.includes("reach the FIELD-SPEC KIT")) ?? "").startsWith("1 of the 1"),
		);
		const offKit = memoryIo({
			[`${CLI_CMD_DIR}/a.go`]: goFile(
				'var aCmd = &cobra.Command{\n\tUse: "create [name]",\n\tRun: func() { fmt.Println(1) },\n}\n' +
					"func init() { rootCmd.AddCommand(aCmd) }\n",
			),
		});
		ok(
			"...and a command off the kit is not",
			(censusFormCoverage(offKit, 1).notes.find((n) => n.includes("reach the FIELD-SPEC KIT")) ?? "").startsWith("0 of the 1"),
		);
	}

	// ── counter 3 · allowlist rows ────────────────────────────────────────────────────────────
	console.log("\ncounter 3 · allowlist rows");
	{
		const empty = censusAllowlist(memoryIo({ [ALLOWLIST_PATH]: fixtureAllowlist(0, 0) }));
		ok("an empty ledger is a legitimate zero", empty.census.refusal === null && empty.census.value === 0);
		ok("...and its census floors are read", empty.floors.cli_docs === 1 && empty.floors.cli_cmd === 1);

		const rows = fixtureAllowlist(1, 1, "  - path: x\n    reason: A decision.\n  - path: y\n    lifts: \"#1 removes it\"\n");
		const two = censusAllowlist(memoryIo({ [ALLOWLIST_PATH]: rows }));
		ok("a reason row counts against baseline and a lifts row against debt", two.census.value === 2 && two.census.rendered.includes("baseline 1 + debt 1"));

		const skewed = censusAllowlist(memoryIo({ [ALLOWLIST_PATH]: fixtureAllowlist(7, 0) }));
		ok("counters that disagree with the rows are a refusal", skewed.census.refusal !== null);

		// The refusal this counter exists for.
		ok("a MISSING allowlist file is a refusal, not a zero", censusAllowlist(memoryIo({})).census.refusal !== null);
		ok(
			"...and the refusal says the file is missing rather than reporting 0 rows",
			(censusAllowlist(memoryIo({})).census.refusal ?? "").includes("IS MISSING"),
		);
		ok(
			"a present file this parser understands NONE of is a refusal",
			censusAllowlist(memoryIo({ [ALLOWLIST_PATH]: "# just a comment\n" })).census.refusal !== null,
		);
		ok(
			"a commented-out row is not a row",
			censusAllowlist(memoryIo({ [ALLOWLIST_PATH]: `${fixtureAllowlist(0, 0)}  # - path: x\n  #   reason: nope\n` })).census.value === 0,
		);
		ok(
			"a missing allowlist leaves the other counters with NO floor rather than a passing one",
			censusAllowlist(memoryIo({})).floors.cli_docs === undefined,
		);
	}

	// ── counter 4 · unlocked mirrors ──────────────────────────────────────────────────────────
	console.log("\ncounter 4 · unlocked mirrors");
	{
		const enrolled = "apps/console/types/jsonb.types.ts";
		const lockedIo = memoryIo({
			[MIRROR_MECHANISM]: fixtureMechanism(),
			[enrolled]: "// Mirrors the Go `verify.Report`.\nexport interface A {}\n",
		});
		const lc = censusMirrors(lockedIo);
		ok("a claim the mechanism answers is LOCKED (a clean zero)", lc.refusal === null && lc.value === 0);

		const unlockedIo = memoryIo({
			[MIRROR_MECHANISM]: fixtureMechanism(),
			[enrolled]: "// Mirrors the Go `verify.Report`.\n",
			"apps/console/lib/addons/types.ts": "// Mirrors the Go `AddOnInstall.Source`.\n",
		});
		const uc = censusMirrors(unlockedIo);
		ok("a claim OUTSIDE the enrolled file is unlocked", uc.value === 1 && uc.findings[0].includes("nothing is watching"));

		const strayIo = memoryIo({
			[MIRROR_MECHANISM]: fixtureMechanism(),
			[enrolled]: "// Mirrors the Go `verify.Report`.\n// Mirrors the Go `drift.Posture`.\n",
		});
		ok("a claim IN the enrolled file the mechanism does not answer is unlocked", censusMirrors(strayIo).value === 1);

		// The absent/unenforced distinction, which is the counter's one subtle requirement.
		const proseIo = memoryIo({
			[MIRROR_MECHANISM]: fixtureMechanism(),
			[enrolled]: "// Mirrors the Go `verify.Report`.\n",
			"apps/console/lib/storage/index.ts": "// Mirrors the Go pattern in packages/core/cloud/aws/s3.go.\n",
		});
		const pc = censusMirrors(proseIo);
		ok("a phrase naming NO type is not a finding", pc.value === 0);
		ok("...and it is reported as prose rather than silently dropped", pc.notes.some((n) => n.includes("name no backticked type")));
		ok(
			"a file with NO claim at all is not a finding",
			censusMirrors(
				memoryIo({
					[MIRROR_MECHANISM]: fixtureMechanism(),
					[enrolled]: "// Mirrors the Go `verify.Report`.\n",
					"apps/console/lib/plain.ts": "export const x = 1;\n",
				}),
			).value === 0,
		);

		// The THIRD state: a claim naming an unexported identifier, which no fixture pair can
		// construct from another package. Reported, never counted — or #3664 inherits a ratchet
		// with a floor it can never reach.
		const unexportedIo = memoryIo({
			[MIRROR_MECHANISM]: fixtureMechanism(),
			[enrolled]: "// Mirrors the Go `verify.Report`.\n",
			"apps/console/tests/validations/apps-path.test.ts": 'describe("mirrors the Go `valid` table", () => {});\n',
		});
		const un = censusMirrors(unexportedIo);
		ok("a claim naming an UNEXPORTED identifier is not a finding", un.value === 0);
		ok("...and it is reported as unlockable rather than dropped", un.notes.some((n) => n.startsWith("unlockable, reported not counted")));
		ok(
			"...while an EXPORTED claim in the same position still is",
			censusMirrors(
				memoryIo({
					[MIRROR_MECHANISM]: fixtureMechanism(),
					[enrolled]: "// Mirrors the Go `verify.Report`.\n",
					"apps/console/lib/x.ts": "// Mirrors the Go `types.Valid`.\n",
				}),
			).value === 1,
		);

		// A claim wrapped across two comment lines is ONE claim, matching the mechanism.
		ok(
			"a wrapped claim is joined, not lost",
			mirrorClaims("/**\n * Mirrors the Go\n * `verify.Receipt`.\n */").claims.length === 1,
		);
		ok("a claim is reduced to its last dotted segment", mirrorClaims("// Mirrors the Go `verify.Report`").claims[0] === "Report");

		// The zero-census refusals.
		ok("ZERO claims anywhere is a refusal", censusMirrors(memoryIo({ [MIRROR_MECHANISM]: fixtureMechanism() })).refusal !== null);
		ok("a MISSING mechanism is a refusal", censusMirrors(memoryIo({ [enrolled]: "// Mirrors the Go `X`\n" })).refusal !== null);
		ok(
			"a mechanism that covers NOTHING is a refusal, not 'everything is unlocked'",
			censusMirrors(memoryIo({ [MIRROR_MECHANISM]: 'const tsMirrorFile = "x.ts"\n', [enrolled]: "// Mirrors the Go `X`\n" }))
				.refusal !== null,
		);
		ok(
			"a mechanism with no enrolled file is a refusal",
			censusMirrors(memoryIo({ [MIRROR_MECHANISM]: 'GoName: "verify.Report"\n', [enrolled]: "// Mirrors the Go `X`\n" }))
				.refusal !== null,
		);
	}

	// ── the run, and the parser ───────────────────────────────────────────────────────────────
	console.log("\nthe run");
	{
		const anyRefusal = runCensus(memoryIo({}));
		ok("an empty repository refuses ALL FOUR counters", anyRefusal.every((c) => c.refusal !== null));
		ok("...and none of them renders a number", anyRefusal.every((c) => c.rendered === "REFUSED"));
		ok("a refused run reports a non-zero exit code", report(anyRefusal, true) === 1);

		// The mode parser. `process.argv.includes("--self-test")` is how a typo silently becomes a
		// full scan reported as green — check-shared-surface.mjs records that one, so this parser
		// refuses an unknown flag rather than ignoring it.
		ok("--self-test resolves", parseCliArgs(["--self-test"]).mode === "self-test");
		ok("--json resolves", parseCliArgs(["--json"]).mode === "json");
		ok("a bare invocation is the census", parseCliArgs([]).mode === "check");
		ok("a typo is an ERROR, never a silent full scan", parseCliArgs(["--slef-test"]).error !== null);
		ok("two modes at once is an error", parseCliArgs(["--json", "--self-test"]).error !== null);
	}

	if (failures > 0) {
		console.error(`\ncheck-cli-surface self-test: ${failures} failure(s)`);
		process.exit(1);
	}
	console.log("\nself-test: all passed");
}

// ── entry ─────────────────────────────────────────────────────────────────────────────────────

const USAGE = [
	"Usage: node scripts/check-cli-surface.mjs [--json|--self-test|--help]",
	"",
	"  (no flag)      run the census and print the four counters with their methods",
	"  --json         the same census as a machine-readable record, findings included",
	"  --self-test    run the fixture suite; exit 1 on any failure",
	"  --help         this text",
	"",
	"Report mode (#4373). #3664 flips it to enforcing; do not add it to a required check here.",
].join("\n");

/**
 * Resolve the mode from argv, refusing anything unrecognised.
 *
 * A guard whose mode is decided by `argv.includes("--self-test")` treats `--slef-test` as a bare
 * invocation, scans the tree and reports green — measured in this repository, in this script's
 * sibling. An unknown flag is an ERROR here.
 * @param {string[]} argv
 * @returns {{mode: "check"|"json"|"self-test"|"help"|null, error: string|null}}
 */
function parseCliArgs(argv) {
	/** @type {Record<string, "json"|"self-test"|"help">} */
	const known = { "--json": "json", "--self-test": "self-test", "--help": "help", "-h": "help" };
	/** @type {"check"|"json"|"self-test"|"help"} */
	let mode = "check";
	let chosen = false;
	for (const arg of argv) {
		const m = known[arg];
		if (m === undefined) return { mode: null, error: `unknown argument: ${arg}` };
		if (chosen) return { mode: null, error: `only one mode at a time (saw ${mode} and ${m})` };
		mode = m;
		chosen = true;
	}
	return { mode, error: null };
}

const parsed = parseCliArgs(process.argv.slice(2));
if (parsed.error !== null) {
	console.error(`check-cli-surface: ${parsed.error}\n\n${USAGE}`);
	process.exit(2);
} else if (parsed.mode === "help") {
	console.log(USAGE);
} else if (parsed.mode === "self-test") {
	selfTest();
} else {
	process.exit(report(runCensus(realIo()), parsed.mode === "json"));
}
