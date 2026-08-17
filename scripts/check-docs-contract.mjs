// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Docs contract guard — the operating docs must describe a repo that EXISTS and commands
// that WORK.
//
// Why this exists: an audit of the doc set found ~25 factually wrong statements, including
// five references to `apps/console/microfrontends.json` (renamed to `marketing-zones.json`
// long before), a `packages/@repo/*` path that never existed, two claims that
// `@/components/ui/*` was deleted while four files still lived there, and — worst —
// CONTRIBUTING.md instructing `gh pr merge --auto --squash`, the exact command CLAUDE.md
// forbids. None of it was catchable by review, because nothing tied prose to reality.
//
// Docs are the harness: an instance reads CLAUDE.md before it does anything, so a wrong
// path there costs a wrong action, not just confusion. This makes that drift un-mergeable.
//
// FIVE RULES:
//   1. every backticked repo-ish path exists (nearest existing path suggested when not)
//   2. every `pnpm <script>` referenced is a real script in the relevant package.json
//   3. no doc RECOMMENDS a command that .claude/hooks/guard-runtime.sh blocks — decided by
//      ASKING THE GUARD, so docs and guard cannot drift apart again
//   4. no doc recommends a forbidden command (gh pr merge --admin, pushes to main/staging)
//   5. every .claude/hooks/*.sh is documented somewhere, and every hook a doc names exists
//
// Usage:  node scripts/check-docs-contract.mjs [--self-test]
// Wired into CI's `Authz / open-core guards` job.

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Docs that make operational promises. Anything here is held to the five rules. */
const DOCS = [
	"CLAUDE.md",
	"PROGRAMME.md",
	"ARCHITECTURE.md",
	"CONTRIBUTING.md",
	"README.md",
	".claude/COORDINATION.md",
	...safeReaddir(".claude/skills")
		.map((d) => `.claude/skills/${d}/SKILL.md`)
		.filter((p) => existsSync(join(ROOT, p))),
];

/** @returns {string[]} directory entries, or [] when the directory is absent. */
function safeReaddir(rel) {
	try {
		return readdirSync(join(ROOT, rel));
	} catch {
		return [];
	}
}

const failures = [];
/** Record one violation against a doc line. */
function fail(file, line, msg, hint) {
	failures.push({ file, line, msg, hint });
}

// ── Corpus ────────────────────────────────────────────────────────────────────────────
/** Every git-tracked path, for existence checks and nearest-match suggestions. */
const tracked = new Set(
	execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
		.split("\n")
		.filter(Boolean),
);
/** Directories are not in `git ls-files`; derive them so `apps/console/lib/` resolves. */
const trackedDirs = new Set();
for (const f of tracked) {
	const parts = f.split("/");
	for (let i = 1; i < parts.length; i++) trackedDirs.add(parts.slice(0, i).join("/"));
}

const pathExists = (p) =>
	tracked.has(p) || trackedDirs.has(p) || existsSync(join(ROOT, p));

/** Cheap nearest-match: same basename elsewhere, else longest shared prefix. */
function suggest(p) {
	const base = p.split("/").pop();
	const sameName = [...tracked].filter((t) => t.endsWith(`/${base}`));
	if (sameName.length && sameName.length <= 3) return sameName.join(" · ");
	const stem = base.replace(/\.[a-z]+$/i, "");
	const similar = [...tracked].filter((t) => t.split("/").pop()?.startsWith(stem.slice(0, 6)));
	if (similar.length && similar.length <= 3) return similar.join(" · ");
	return null;
}

// ── Rule 3 input: ask the guard itself what it blocks ──────────────────────────────────
const GUARD = join(ROOT, ".claude/hooks/guard-runtime.sh");
/**
 * Does guard-runtime.sh block this command? Runs the real hook with a real payload, so
 * the answer can never disagree with what an instance actually experiences.
 * @returns {boolean|null} null when the guard is unavailable (skip the rule).
 */
function guardBlocks(cmd) {
	if (!existsSync(GUARD)) return null;
	const payload = JSON.stringify({ tool_name: "Bash", tool_input: { command: cmd } });
	try {
		execFileSync("bash", [GUARD], {
			input: payload,
			env: { ...process.env, ALETHIA_LOCAL_DEV: "" },
			stdio: ["pipe", "ignore", "ignore"],
		});
		return false;
	} catch (e) {
		return e.status === 2;
	}
}

// ── Extraction ────────────────────────────────────────────────────────────────────────
// Only inline code spans are inspected. Prose is not a contract, and fenced blocks are
// often illustrative or deliberately show a WRONG command being refused.
const INLINE = /`([^`\n]+)`/g;

/** Strip fenced code blocks, keeping line numbering intact. */
function withoutFences(text) {
	let inFence = false;
	return text.split("\n").map((l) => {
		if (/^\s*```/.test(l)) {
			inFence = !inFence;
			return "";
		}
		return inFence ? "" : l;
	});
}

// A doc that says a command "is blocked" must not be reported for naming it — documenting
// a prohibition is the correct behaviour, and flagging it would make the only available
// fix "stop writing down the rule".
//
// TWO different suppressions, deliberately scoped differently. One broad rule got this
// wrong in BOTH directions: per-line it flagged wrapped continuation lines, and
// paragraph-wide with a loose vocabulary ("was", "not") it silently SWALLOWED real
// findings — the renamed marketing-zones.json stopped being reported at all. A false
// negative is the worse failure for a guard, so each rule gets the narrowest scope that
// still works.

// A path named only to say it is GONE. Tight vocabulary, SENTENCE scope: "was" and "not"
// are far too common in prose to suppress a path check across a whole paragraph.
const PATH_GONE =
	/\b(retired|removed|renamed|deleted|dropped|no longer exists?|superseded|used to (be|live)|was replaced)\b/i;

// A command named only to say it is PROHIBITED. `deny`/`denies` are in the vocabulary
// because a permission DENY LIST is prohibition prose by definition — documenting one is
// exactly what we want, and the first draft flagged the repo's own deny list.
// PARAGRAPH scope, because the verb and its
// objects routinely wrap: a sentence like "guard-runtime.sh blocks `pnpm dev:up`, dev:stack,
// a bare next dev" puts the verb and its objects on different lines.
const CMD_PROHIBITED =
	/\b(block\w*|forbidden|never|don'?t|do NOT|refus\w*|instead of|rather than|is dead|are dead|deny|denies|denied|prohibit\w*|may not|cannot be undone)\b/i;

/** The sentence around a token, for PATH_GONE. */
function sentenceAround(line, token) {
	const i = line.indexOf(token);
	if (i < 0) return line;
	const start = Math.max(0, line.lastIndexOf(".", i - 1) + 1);
	const endDot = line.indexOf(".", i + token.length);
	return line.slice(start, endDot < 0 ? line.length : endDot + 1);
}

/** Map line index → the paragraph (contiguous non-blank lines) containing it. */
function paragraphContext(lines) {
	const ctx = new Array(lines.length).fill("");
	let start = 0;
	for (let i = 0; i <= lines.length; i++) {
		const blank = i === lines.length || lines[i].trim() === "";
		if (blank) {
			if (i > start) {
				const para = lines.slice(start, i).join(" ");
				for (let j = start; j < i; j++) ctx[j] = para;
			}
			start = i + 1;
		}
	}
	return ctx;
}

/** A token that looks like it names a file or directory in this repo. */
function looksLikePath(s) {
	if (!s.includes("/")) return false;
	if (/^(https?:|mailto:|\/\/|~)/.test(s)) return false;
	if (/[ <>|$*()?"'\\]/.test(s)) return false; // globs, placeholders, shell
	if (/^[A-Z][a-z]+ /.test(s)) return false;
	if (!/^[\w.@-]+(\/[\w.@-]+)+\/?$/.test(s)) return false;
	// Bare npm scopes (@repo/ui) are package names, not paths.
	if (s.startsWith("@")) return false;
	// Only claim paths that start at a real top-level entry.
	const top = s.split("/")[0];
	return tracked.has(top) || trackedDirs.has(top);
}

const pkgScripts = new Map(); // package dir → Set(script names)
/** Script names declared by a package.json, memoized. */
function scriptsOf(pkgDir) {
	if (pkgScripts.has(pkgDir)) return pkgScripts.get(pkgDir);
	let s = new Set();
	try {
		s = new Set(Object.keys(JSON.parse(readFileSync(join(ROOT, pkgDir, "package.json"), "utf8")).scripts ?? {}));
	} catch {
		/* no package.json here */
	}
	pkgScripts.set(pkgDir, s);
	return s;
}
const rootScripts = () => scriptsOf(".");

/** Workspace package dirs, so `pnpm -F console <script>` resolves to the right manifest. */
const workspaceDirs = [...trackedDirs].filter((d) => tracked.has(`${d}/package.json`));
function dirForFilter(filter) {
	const clean = filter.replace(/^@[\w-]+\//, "");
	return workspaceDirs.find((d) => d.endsWith(`/${clean}`) || d === clean) ?? null;
}

// ── Main ──────────────────────────────────────────────────────────────────────────────
const hooksOnDisk = safeReaddir(".claude/hooks").filter((f) => f.endsWith(".sh"));
const hooksMentioned = new Set();

for (const rel of DOCS) {
	const abs = join(ROOT, rel);
	if (!existsSync(abs)) continue;
	// A symlinked doc (AGENTS.md → CLAUDE.md) is the same bytes; check it once.
	try {
		if (statSync(abs).isSymbolicLink?.()) continue;
	} catch {
		/* fall through */
	}

	// Skills synced from alethialabs-io/skills are edited THERE, not here
	// (.claude/skills/README.md). Holding them to this repo's paths would report a
	// violation whose only fix is in another repo — so check the ones we own.
	const raw = readFileSync(abs, "utf8");
	if (rel.startsWith(".claude/skills/") && /^\s*source:\s*\S+\/\S+/m.test(raw)) continue;

	const lines = withoutFences(raw);
	const paras = paragraphContext(lines);
	lines.forEach((line, i) => {
		const n = i + 1;
		const text = line;
		const context = paras[i] || line;
		for (const m of text.matchAll(INLINE)) {
			const tok = m[1].trim();

			// Rule 5 bookkeeping
			for (const h of tok.matchAll(/\.claude\/hooks\/([\w-]+\.sh)/g)) {
				hooksMentioned.add(h[1]);
				if (!hooksOnDisk.includes(h[1])) fail(rel, n, `references a hook that does not exist: ${h[1]}`);
			}

			// Rule 1 — paths. A path named only to say it is GONE ("`infra/fleet-aws` was
			// retired") is accurate prose, not drift.
			if (looksLikePath(tok) && !PATH_GONE.test(sentenceAround(text, tok))) {
				const p = tok.replace(/\/$/, "");
				if (!pathExists(p)) fail(rel, n, `path does not exist: ${tok}`, suggest(p));
			}

			// Rule 2 — pnpm scripts
			const pnpm = tok.includes("*") ? null : tok.match(/^pnpm\s+(?:(?:-F|--filter)\s+(\S+)\s+)?([\w:.-]+)/);
			if (pnpm && !/^(install|add|remove|dlx|exec|run|store|why|ls|-)/.test(pnpm[2])) {
				const [, filter, script] = pnpm;
				if (filter) {
					const dir = dirForFilter(filter);
					if (dir && scriptsOf(dir).size && !scriptsOf(dir).has(script))
						fail(rel, n, `pnpm -F ${filter} ${script}: no such script in ${dir}/package.json`);
				} else if (rootScripts().size && !rootScripts().has(script) && !script.includes(".")) {
					fail(rel, n, `pnpm ${script}: no such script in root package.json`);
				}
			}

			// Rule 3 — never recommend something the runtime guard blocks.
			// `-` marks a bullet; a line that NEGATES the command (blocked/never/don't) is
			// documenting the prohibition, which is exactly what we want it to do.
			const negated = CMD_PROHIBITED.test(context);
			if (!negated && /^(pnpm|npx|next|turbo|docker)\s/.test(tok) && guardBlocks(tok) === true)
				fail(rel, n, `recommends a command guard-runtime.sh BLOCKS: ${tok}`, "use `pnpm env:up` (see .claude/skills/dev/SKILL.md)");

			// Rule 4 — forbidden commands
			if (!negated) {
				if (/gh\s+pr\s+merge[^`]*--admin/.test(tok))
					fail(rel, n, `recommends \`gh pr merge --admin\` (bypasses the Mergify queue): ${tok}`);
				if (/git\s+push[^`]*\s(main|staging)\b/.test(tok))
					fail(rel, n, `recommends pushing directly to a protected branch: ${tok}`, "promotions are the maintainer's; feature work targets dev");
			}
		}
	});
}

// Rule 5 — every hook is documented somewhere. A gate on every Bash call that no doc
// mentions is a trap: guard-compose.sh gated every session while appearing in no doc.
for (const h of hooksOnDisk) {
	if (!hooksMentioned.has(h))
		fail(".claude/hooks", 0, `${h} gates tool calls but is documented in no doc`, `mention \`.claude/hooks/${h}\` in CLAUDE.md`);
}

// ── Report ────────────────────────────────────────────────────────────────────────────
if (process.argv.includes("--self-test")) {
	// Prove the guard can FAIL, not merely pass — an always-green check is not a check.
	const cases = [
		["nonexistent path", () => !pathExists("apps/console/microfrontends.json")],
		["real path resolves", () => pathExists("apps/console/marketing-zones.json")],
		["directory resolves", () => pathExists("apps/console/lib/db")],
		["blocked command detected", () => guardBlocks("pnpm dev:up") === true],
		["allowed command not flagged", () => guardBlocks("pnpm build") === false],
		["scope is not a path", () => !looksLikePath("@repo/ui")],
		["url is not a path", () => !looksLikePath("https://x.dev/a")],
		["repo path recognised", () => looksLikePath("apps/console/package.json")],

		// The suppression rules are where this guard nearly broke, in both directions.
		// These pin the behaviour so neither regression can return silently.
		[
			"prohibition prose is suppressed",
			() => CMD_PROHIBITED.test("guard-runtime.sh blocks this and a bare next dev"),
		],
		[
			"ordinary prose does NOT suppress a command",
			() => !CMD_PROHIBITED.test("Dev: turbo dev --filter=docs runs the docs site"),
		],
		[
			"a path said to be gone is suppressed",
			() => PATH_GONE.test(sentenceAround("The legacy scaler (`infra/fleet-aws`) was retired.", "infra/fleet-aws")),
		],
		[
			// The false-negative that a paragraph-wide vocabulary introduced: this sentence
			// contains "not", and a loose rule swallowed the renamed-file finding entirely.
			"a live path reference is NOT suppressed by nearby prose",
			() =>
				!PATH_GONE.test(
					sentenceAround("Source of truth is `apps/console/microfrontends.json`, not the Caddy mirror.", "apps/console/microfrontends.json"),
				),
		],
	];
	let bad = 0;
	for (const [name, fn] of cases) {
		let ok = false;
		try {
			ok = fn() === true;
		} catch {
			ok = false;
		}
		if (!ok) {
			console.error(`  ✗ ${name}`);
			bad++;
		}
	}
	console.log(`  ${cases.length - bad}/${cases.length} self-test cases passed`);
	process.exit(bad ? 1 : 0);
}

if (failures.length) {
	console.error(`✗ check-docs-contract: ${failures.length} violation(s) — the docs describe a repo that does not exist.\n`);
	let last = "";
	for (const f of failures) {
		if (f.file !== last) {
			console.error(`  ${f.file}`);
			last = f.file;
		}
		console.error(`    ${f.line ? `:${f.line}` : ""}  ${f.msg}`);
		if (f.hint) console.error(`         → ${f.hint}`);
	}
	console.error("\nDocs are the harness: an instance acts on them before it reads any code.");
	process.exit(1);
}
console.log(`✓ check-docs-contract: ${DOCS.length} docs describe a repo that exists.`);
