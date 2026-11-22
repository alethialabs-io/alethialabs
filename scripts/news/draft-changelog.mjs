#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
//
// Drafts the next News changelog entry from what merged since the last one.
//
//   node scripts/news/draft-changelog.mjs              write the draft (or say there is nothing new)
//   node scripts/news/draft-changelog.mjs --dry-run    print it instead of writing
//   node scripts/news/draft-changelog.mjs --self-test  exercise the parsing; the EXIT CODE is the test
//
// Options: --ref <git ref> (default origin/main), --since YYYY-MM-DD (default: the day after the
// newest changelog entry), --until YYYY-MM-DD (default today, UTC).
//
// WHAT IT READS. Squash-merge subjects on `--ref` (`feat(console): … (#123)`), so it needs the git
// history and nothing else — no GitHub API, no token. Only `feat` and `fix` with a user-facing scope
// (console, cli, runner, docs) are kept; ci / test / chore / refactor and every other scope are
// dropped, and so is a subject that names an internal instrument (coverage, ratchet, e2e, …).
//
// WHAT IT WRITES. `apps/blog/content/posts/changelog-<until>.mdx` with `draft: true`: a placeholder
// headline, then New (feat) and Fixed (fix) bullets in the commit's words, each linking its PR, and
// an empty Improved section. That is RAW MATERIAL. A person rewrites it into plain user language —
// what changed for the person using it, not what the code does — moves items into Improved, deletes
// what no user would notice, and flips `draft` before it ships (news-pipeline proposal §3.1).
// Release notes are written for engineers; publishing them as-is is exactly what this replaces.
//
// Run weekly by .github/workflows/news-changelog-draft.yml, which opens the result as a DRAFT PR.

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const POSTS = join(ROOT, "apps/blog/content/posts");
const PR_URL = "https://github.com/alethialabs-io/alethialabs/pull/";

/** The scopes a user of the product can see. */
export const USER_SCOPES = ["console", "cli", "runner", "docs"];

/** Subjects naming an internal instrument rather than a product change. */
const INTERNAL = /\b(coverage|ratchet|e2e|flake|lint|ci|harness|allowlist|guard|scoreboard|baseline|snapshot|telemetry|test(s|ing)?)\b/i;

/**
 * Parses one squash subject: `type(scope[,scope]): text (#n)` — trailing `(#n)` groups are PR
 * references, the LAST one being the merged PR. Returns null for anything else.
 */
export function parseSubject(subject) {
	const match = /^(\w+)\(([^)]+)\)(!)?:\s*(.+)$/.exec(subject.trim());
	if (!match) return null;
	const [, type, scopeList, , rest] = match;
	const refs = [...rest.matchAll(/\s*\(#(\d+)\)/g)].map((m) => Number(m[1]));
	const text = rest.replace(/(\s*\((?:Closes |Part of )?#\d+\))+\s*$/i, "").trim();
	const scopes = scopeList.split(",").map((s) => s.trim().split("/")[0]);
	return { type, scopes, text, pr: refs.length ? refs[refs.length - 1] : null };
}

/**
 * Which section a parsed subject belongs to — "new" or "fixed" — or null when it is not for users:
 * not feat/fix, no user-facing scope, or an internal instrument named in the text.
 */
export function classify(parsed) {
	if (!parsed) return null;
	if (parsed.type !== "feat" && parsed.type !== "fix") return null;
	if (!parsed.scopes.some((s) => USER_SCOPES.includes(s))) return null;
	if (INTERNAL.test(parsed.text)) return null;
	return parsed.type === "feat" ? "new" : "fixed";
}

/** Escapes the two characters MDX would read as syntax in a bullet. */
export function mdxEscape(text) {
	return text.replace(/[{}]/g, (c) => `\\${c}`).replace(/</g, "&lt;");
}

/** One bullet: the scope, the subject with its first letter capitalised, and the PR link. */
function bullet(item) {
	const scope = item.scopes.filter((s) => USER_SCOPES.includes(s)).join(", ");
	const text = mdxEscape(item.text.charAt(0).toUpperCase() + item.text.slice(1));
	const link = item.pr ? ` ([#${item.pr}](${PR_URL}${item.pr}))` : "";
	return `- **${scope}:** ${text}${link}`;
}

/**
 * Renders the draft entry. `items` are parsed subjects with a `section`; `versions` the CLI and
 * runner versions to chip, from the release-please manifest on the same ref.
 */
export function renderEntry({ date, items, versions }) {
	const news = items.filter((i) => i.section === "new").map(bullet);
	const fixed = items.filter((i) => i.section === "fixed").map(bullet);
	const versionLines = Object.entries(versions)
		.filter(([, v]) => v)
		.map(([k, v]) => `  ${k}: ${v}`);
	return [
		"---",
		`title: "Changelog draft: ${date}"`,
		"description: TODO one sentence on what changed for users.",
		`date: ${date}`,
		"author: Alethia Labs",
		"tags: [changelog]",
		"kind: changelog",
		"summary: TODO the same sentence, at most 280 characters; it is the card and RSS text.",
		...(versionLines.length ? ["versions:", ...versionLines] : []),
		"draft: true",
		"---",
		"",
		"{/* DRAFT generated by scripts/news/draft-changelog.mjs from merged PRs. Rewrite every line in",
		"    plain user language, lead with the one change that matters most, move refinements to",
		"    Improved, delete anything a user would not notice, then remove `draft: true`. */}",
		"",
		"**TODO the headline change, in one or two sentences.**",
		"",
		"## New",
		"",
		...(news.length ? news : ["- TODO"]),
		"",
		"## Improved",
		"",
		"- TODO",
		"",
		"## Fixed",
		"",
		...(fixed.length ? fixed : ["- TODO"]),
		"",
	].join("\n");
}

/** The date of the newest `kind: changelog` entry (drafts included), or null when there is none. */
export function lastEntryDate(files) {
	let last = null;
	for (const text of files) {
		const front = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? "";
		if (!/^kind:\s*changelog\s*$/m.test(front)) continue;
		const date = /^date:\s*(\d{4}-\d{2}-\d{2})/m.exec(front)?.[1];
		if (date && (!last || date > last)) last = date;
	}
	return last;
}

/** The day after an ISO date. */
function nextDay(iso) {
	const d = new Date(`${iso}T00:00:00Z`);
	d.setUTCDate(d.getUTCDate() + 1);
	return d.toISOString().slice(0, 10);
}

/** Reads `--name value` from argv. */
function arg(argv, name) {
	const i = argv.indexOf(name);
	return i >= 0 ? argv[i + 1] : undefined;
}

/** The parsing checks. Each failure is printed; any failure exits 1. */
function selfTest() {
	const failures = [];
	const check = (name, ok) => {
		if (!ok) failures.push(name);
		console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
	};
	const p = parseSubject("feat(console): download a 1h read-only kubeconfig from the cluster card (#5318)");
	check("parses type, scope, text and PR", p?.type === "feat" && p.scopes[0] === "console" && p.text === "download a 1h read-only kubeconfig from the cluster card" && p.pr === 5318);
	const two = parseSubject("feat(console): the board paints with its data (#6119) (#6213)");
	check("the last PR reference is the merged PR", two?.pr === 6213 && two.text === "the board paints with its data");
	check("a comma scope list is split", parseSubject("fix(cli,console): apply refuses (#5573)")?.scopes.join() === "cli,console");
	check("a non-conventional subject is null", parseSubject("Staging") === null);
	check("feat → new", classify(p) === "new");
	check("fix → fixed", classify(parseSubject("fix(cli): logout deletes the cache (#5348)")) === "fixed");
	check("chore is dropped", classify(parseSubject("chore(console): bump deps (#1)")) === null);
	check("ci scope is dropped", classify(parseSubject("feat(ci): add a job (#1)")) === null);
	check("a non-user scope is dropped", classify(parseSubject("feat(e2e): a new leg (#1)")) === null);
	check("an internal instrument is dropped", classify(parseSubject("feat(console): arm the coverage ratchet (#1)")) === null);
	check("MDX braces and tags are escaped", mdxEscape("a {b} <c>") === "a \\{b\\} &lt;c>");
	const files = ["---\nkind: changelog\ndate: 2026-10-31\n---", "---\nkind: changelog\ndate: 2026-11-18\ndraft: true\n---", "---\nkind: engineering\ndate: 2026-12-01\n---"];
	check("the last entry date ignores other kinds and counts drafts", lastEntryDate(files) === "2026-11-18");
	check("no entry → null", lastEntryDate(["---\nkind: announcement\ndate: 2026-01-01\n---"]) === null);
	const out = renderEntry({ date: "2026-11-25", items: [{ ...p, section: "new" }], versions: { cli: "0.10.0", runner: "" } });
	check("the draft is a draft changelog entry", /^kind: changelog$/m.test(out) && /^draft: true$/m.test(out));
	check("the draft links the PR and chips only known versions", out.includes(`(${PR_URL}5318)`) && out.includes("  cli: 0.10.0") && !out.includes("runner:"));
	if (failures.length) {
		console.error(`\n${failures.length} self-test check(s) failed.`);
		process.exit(1);
	}
	console.log("\nall self-test checks passed");
}

/** Reads the history, writes (or prints) the draft. */
function main(argv) {
	if (argv.includes("--self-test")) return selfTest();
	const ref = arg(argv, "--ref") ?? "origin/main";
	const files = readdirSync(POSTS)
		.filter((f) => f.endsWith(".mdx"))
		.map((f) => readFileSync(join(POSTS, f), "utf8"));
	const last = lastEntryDate(files);
	const since = arg(argv, "--since") ?? (last ? nextDay(last) : undefined);
	const until = arg(argv, "--until") ?? new Date().toISOString().slice(0, 10);
	if (!since) throw new Error("no changelog entry found; pass --since YYYY-MM-DD");

	const log = execFileSync(
		"git",
		["log", ref, "--no-merges", `--since=${since}T00:00:00Z`, `--until=${until}T23:59:59Z`, "--format=%s"],
		{ cwd: ROOT, encoding: "utf8" },
	);
	const seen = new Set();
	const items = [];
	for (const subject of log.split("\n").filter(Boolean)) {
		const parsed = parseSubject(subject);
		const section = classify(parsed);
		if (!section || !parsed) continue;
		const key = parsed.pr ?? parsed.text;
		if (seen.has(key)) continue;
		seen.add(key);
		items.push({ ...parsed, section });
	}
	if (items.length === 0) {
		console.log(`nothing user-facing merged on ${ref} between ${since} and ${until}; no draft written`);
		return;
	}

	let versions = {};
	try {
		const manifest = JSON.parse(execFileSync("git", ["show", `${ref}:.release-please-manifest.json`], { cwd: ROOT, encoding: "utf8" }));
		versions = { cli: manifest["apps/cli"] ?? "", runner: manifest["apps/runner"] ?? "" };
	} catch {
		// No manifest on that ref: the draft simply has no version chips.
	}

	const entry = renderEntry({ date: until, items, versions });
	if (argv.includes("--dry-run")) {
		process.stdout.write(entry);
		return;
	}
	const out = join(POSTS, `changelog-${until}.mdx`);
	if (existsSync(out)) throw new Error(`${out} already exists; refusing to overwrite an entry`);
	writeFileSync(out, entry);
	console.log(`wrote ${out} (${items.length} item(s) since ${since})`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main(process.argv.slice(2));
