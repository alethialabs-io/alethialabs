#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
//
// IS EACH STARTER TEMPLATE'S LIVE HEAD THE COMMIT IT WAS LAST GREEN-PROVEN ON? (#5418, epic #2766,
// unit 2)
//
// The console hands a user each starter template at its repo's HEAD. The `templates` e2e dimension
// that proves a template deploys is dispatch-only (`scripts/e2e/resolve-dimension.sh`: `floor` is
// the only scheduled dimension), so the first push to a starter repo after its last proof makes the
// product offer an unproven template — and before this, nothing said so.
//
// This compares two facts and nothing else:
//
//   · the commit each template was last green-proven on — read through `readTemplateProofs()` in
//     `scripts/lib/template-proofs.mjs` (#5411), the ONE reader for that answer. It is imported, not
//     re-implemented: a second reader is how "last proven" comes to mean two different things;
//   · the repo's live `HEAD` sha, from the GitHub API (`gh api repos/<owner>/<repo>/commits/HEAD`,
//     which resolves the repo's DEFAULT branch — the ref the console hands out).
//
//   exit 0  every template's HEAD is the proven commit.
//   exit 1  DRIFT: at least one HEAD has moved. Each is named — template, repo, proven sha, HEAD sha,
//           and the proof bundle the proven sha came from.
//   exit 2  the instrument could not answer: the proofs could not be read, a repo URL is not a
//           GitHub repo it can ask about, or a HEAD could not be read (gh missing, no token, rate
//           limit, a renamed repo, a reply that is not a 40-hex sha). NEVER 0 — an unread HEAD is
//           not a current one, and "assume current" is exactly how drift survives the check written
//           to catch it. When drift AND blindness coexist, the drift is still printed and the exit
//           is 2, because a partial answer must not read as a complete one.
//
// ── WHAT THIS DOES NOT DO ─────────────────────────────────────────────────────────────────────────
//
// It REPORTS. It dispatches nothing, re-proves nothing and spends nothing, BY RULING: on 2026-10-08
// the maintainer decided epic #2766 unit 3 (#5686) — drift opens an issue only and never re-proves
// automatically (https://github.com/alethialabs-io/alethialabs/issues/2766#issuecomment-6055301759).
// The reason is spend: a re-prove buys a hetzner cluster for the `templates` dimension, and a person
// decides when that is worth paying for. So the only consumer of a red run is
// `.github/workflows/template-proof-currency.yml`, which upserts ONE issue whose body is this
// report — and the drift report carries `REPROVE_COMMAND`, so the human step is one copy. Wiring a
// dispatch in here is not a gap to fill; it reverses that ruling. "Moved" is plain sha inequality —
// not "behind", not "ahead": a force-push that rewinds HEAD is just as unproven.
//
//   node scripts/check-template-proof-currency.mjs                       # live: asks GitHub (gh + token)
//   node scripts/check-template-proof-currency.mjs --self-test           # hermetic: fixtures + the mutation control
//   node scripts/check-template-proof-currency.mjs --root=<dir>          # read proofs from another repo root
//   node scripts/check-template-proof-currency.mjs --heads-from=<json>   # HEADs from a fixture, not GitHub
//
// `--heads-from` takes `{ "<owner>/<repo>": "<sha>" }`. It exists so `--self-test` can drive the
// REAL exit path in a child process; the workflow never passes it, and every run that uses it says so
// on stderr. The report goes to stdout as Markdown (the workflow files it as the issue body);
// annotations go to stderr.
//
// Do NOT pipe this into `tail`/`head`: a pipe reports the exit code of the LAST command in it.

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PROOFS_DIR, SUMMARY_FILE, TEMPLATES, readTemplateProofs } from "./lib/template-proofs.mjs";

const SELF = fileURLToPath(import.meta.url);

export const EXIT_CURRENT = 0;
export const EXIT_DRIFT = 1;
export const EXIT_BLIND = 2;

/**
 * The one command a person runs to re-prove the starter templates after drift — printed in the drift
 * report, which the workflow files as the tracker issue body. `templates` is hetzner-only (refused
 * on any other provider by `e2e-nightly.yml`), and `--ref dev` because a dispatch declares the
 * `e2e-dev` environment, whose deployment-branch policy admits `dev` only — `--ref main` is refused.
 * The self-test checks both input values against `e2e-nightly.yml`'s own `workflow_dispatch` choices,
 * so a renamed dimension or provider reds here rather than in front of the person who copies it.
 */
export const REPROVE_COMMAND = "gh workflow run e2e-nightly.yml --ref dev -f provider=hetzner -f dimension=templates";

/** The workflow `REPROVE_COMMAND` dispatches, relative to the repo root. */
const REPROVE_WORKFLOW = path.join(".github", "workflows", "e2e-nightly.yml");

const SHA = /^[0-9a-f]{40}$/;
const GITHUB_REPO_URL = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/;

/**
 * @typedef {{repo: string, provenCommit: string, bundle: string, verdict: "PASS"}} Proof
 * @typedef {{sha: string, error: string}} HeadRead
 * @typedef {{template: string, repo: string, slug: string, provenCommit: string, head: string, bundle: string, error: string}} Row
 */

/**
 * The `<owner>/<repo>` slug of a GitHub https URL, or null when the URL is not one this can ask
 * the GitHub API about.
 *
 * @param {string} url
 * @returns {string | null}
 */
export function repoSlug(url) {
	const m = GITHUB_REPO_URL.exec(url);
	return m ? `${m[1]}/${m[2]}` : null;
}

/**
 * The verdict, given each template's proof and what reading its HEAD produced. Pure — the deciding
 * half is separated from the asking half because only the deciding half can be wrong in a way a
 * fixture can catch.
 *
 * A HEAD read counts as an answer only when it is a 40-hex sha with no error. Anything else — an
 * empty string, a short sha, an error, a template with no read at all — is blind, never current.
 *
 * @param {Record<string, Proof>} proofs  template → its last green proof
 * @param {Map<string, HeadRead>} heads   `<owner>/<repo>` → what reading its HEAD produced
 * @returns {{code: number, current: Row[], drifted: Row[], blind: Row[]}}
 */
export function decide(proofs, heads) {
	/** @type {Row[]} */ const current = [];
	/** @type {Row[]} */ const drifted = [];
	/** @type {Row[]} */ const blind = [];
	for (const template of TEMPLATES) {
		const proof = proofs[template];
		if (proof === undefined) {
			blind.push({ template, repo: "", slug: "", provenCommit: "", head: "", bundle: "", error: "the proofs reader returned no entry for this template" });
			continue;
		}
		const slug = repoSlug(proof.repo);
		const base = { template, repo: proof.repo, slug: slug ?? "", provenCommit: proof.provenCommit, bundle: proof.bundle };
		if (slug === null) {
			blind.push({ ...base, head: "", error: `${proof.repo} is not a https://github.com/<owner>/<repo> URL` });
			continue;
		}
		const read = heads.get(slug);
		const head = read?.sha ?? "";
		if (read === undefined || read.error !== "" || !SHA.test(head)) {
			const why = read === undefined ? "HEAD was never read" : read.error || `HEAD read returned ${JSON.stringify(head)}, not a 40-hex sha`;
			blind.push({ ...base, head, error: why });
			continue;
		}
		(head === proof.provenCommit ? current : drifted).push({ ...base, head, error: "" });
	}
	const code = blind.length > 0 ? EXIT_BLIND : drifted.length > 0 ? EXIT_DRIFT : EXIT_CURRENT;
	return { code, current, drifted, blind };
}

/**
 * Ask GitHub for one repo's HEAD sha. gh's own diagnostic is KEPT on failure: a missing `gh`, a
 * missing token, a rate limit, a renamed repo and a dead network all land here and send an operator
 * to five different places.
 *
 * @param {string} slug  `<owner>/<repo>`
 * @returns {HeadRead}
 */
function readHeadFromGitHub(slug) {
	try {
		const out = execFileSync("gh", ["api", `repos/${slug}/commits/HEAD`, "--jq", ".sha"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
		return { sha: out.trim(), error: "" };
	} catch (err) {
		const e = /** @type {{stderr?: Buffer|string, message?: string}} */ (err);
		const stderr = typeof e.stderr === "string" ? e.stderr : e.stderr?.toString("utf8");
		const reason = (stderr || e.message || String(err)).trim().split("\n")[0];
		return { sha: "", error: reason || "gh failed with no diagnostic" };
	}
}

/**
 * A HEAD reader backed by a fixture map, for `--heads-from`. A slug the map does not name reads as
 * unreadable — never as current.
 *
 * @param {Record<string, unknown>} map
 * @returns {(slug: string) => HeadRead}
 */
function readHeadFromMap(map) {
	return (slug) => {
		const v = map[slug];
		return typeof v === "string" ? { sha: v, error: "" } : { sha: "", error: `${slug} is not in the --heads-from fixture` };
	};
}

/**
 * Narrow an unknown to a plain object.
 *
 * @param {unknown} v
 * @returns {v is Record<string, unknown>}
 */
function isObject(v) {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * The first seven characters of a sha, or a placeholder for an empty one.
 *
 * @param {string} sha
 * @returns {string}
 */
function short(sha) {
	return sha ? `\`${sha.slice(0, 7)}\`` : "(none)";
}

/**
 * Render the verdict as the Markdown report the workflow files as the issue body. Full shas are
 * printed for drift and blindness, because a seven-character prefix is not something a re-prove can
 * be dispatched against.
 *
 * @param {{code: number, current: Row[], drifted: Row[], blind: Row[]}} v
 * @returns {string}
 */
export function report(v) {
	const lines = [];
	const headline =
		v.code === EXIT_CURRENT
			? `Every starter template's HEAD is the commit it was last green-proven on (${v.current.length} of ${TEMPLATES.length}).`
			: v.code === EXIT_DRIFT
				? `**${v.drifted.length} of ${TEMPLATES.length} starter template(s) have moved past their last green proof.** The console is offering a template nobody has proven.`
				: `**The currency check could not answer for ${v.blind.length} of ${TEMPLATES.length} template(s).** This is NOT a pass: an unread HEAD is not a current one.`;
	lines.push(headline, "");
	if (v.drifted.length > 0) {
		lines.push("### Drifted", "", "| Template | Repo | Last proven | HEAD now | Proof bundle |", "|---|---|---|---|---|");
		for (const r of v.drifted) lines.push(`| ${r.template} | ${r.repo} | \`${r.provenCommit}\` | \`${r.head}\` | \`${r.bundle}\` |`);
		lines.push(
			"",
			"Re-prove the templates at their HEADs — this buys a hetzner cluster, so it is a person's call:",
			"",
			"```sh",
			REPROVE_COMMAND,
			"```",
			"",
			`Then commit the proof with \`scripts/e2e/commit-proof.sh <run_id> hetzner\` — CI never pushes, and that script splits the run's bundle into one \`${PROOFS_DIR.split(path.sep).join("/")}/<template>/\` directory per template; this check reads the newest PASS bundle's \`${SUMMARY_FILE}\`.`,
			"Nothing re-proves automatically, by ruling: drift opens this issue only, because a re-prove costs real spend and a person decides (epic #2766 unit 3, #5686).",
			"",
		);
	}
	if (v.blind.length > 0) {
		lines.push("### Unanswered", "", "| Template | Repo | Last proven | Why |", "|---|---|---|---|");
		for (const r of v.blind) lines.push(`| ${r.template} | ${r.repo || "(unknown)"} | ${r.provenCommit ? `\`${r.provenCommit}\`` : "(unknown)"} | ${r.error.replaceAll("|", "\\|")} |`);
		lines.push("");
	}
	if (v.current.length > 0) {
		lines.push("### Current", "", "| Template | Repo | Proven = HEAD | Proof bundle |", "|---|---|---|---|");
		for (const r of v.current) lines.push(`| ${r.template} | ${r.repo} | ${short(r.head)} | \`${r.bundle}\` |`);
		lines.push("");
	}
	return lines.join("\n");
}

/**
 * Parse argv. Unknown flags are collected, not ignored, so a typo cannot silently run the live check.
 *
 * @param {string[]} argv
 * @returns {{selfTest: boolean, help: boolean, root: string, headsFrom: string, unknown: string[]}}
 */
export function parseArgs(argv) {
	const out = { selfTest: false, help: false, root: "", headsFrom: "", unknown: /** @type {string[]} */ ([]) };
	for (const a of argv) {
		if (a === "--self-test") out.selfTest = true;
		else if (a === "--help" || a === "-h") out.help = true;
		else if (a.startsWith("--root=") && a.length > "--root=".length) out.root = path.resolve(a.slice("--root=".length));
		else if (a.startsWith("--heads-from=") && a.length > "--heads-from=".length) out.headsFrom = path.resolve(a.slice("--heads-from=".length));
		else out.unknown.push(a);
	}
	return out;
}

/**
 * The live check (or a fixture-driven one under `--heads-from`). Returns the exit code.
 *
 * @param {string[]} argv
 * @returns {number}
 */
export function main(argv) {
	const args = parseArgs(argv);
	if (args.help) {
		console.log("usage: node scripts/check-template-proof-currency.mjs [--root=<dir>] [--heads-from=<file.json>] [--self-test]");
		return EXIT_CURRENT;
	}
	if (args.unknown.length > 0) {
		console.error(`::error::check-template-proof-currency: unknown argument(s): ${args.unknown.join(" ")}`);
		return EXIT_BLIND;
	}
	if (args.selfTest) return selfTest();

	/** @type {Record<string, Proof>} */
	let proofs;
	try {
		proofs = readTemplateProofs(args.root ? { root: args.root } : {});
	} catch (err) {
		console.error(`::error::check-template-proof-currency: the proven commits could not be read: ${err instanceof Error ? err.message : String(err)}`);
		console.log("**The currency check could not read the proof bundles.** This is NOT a pass: without a proven commit there is nothing to compare HEAD with.");
		return EXIT_BLIND;
	}

	let read = readHeadFromGitHub;
	if (args.headsFrom) {
		console.error(`note: HEAD shas come from the fixture ${args.headsFrom}, NOT from GitHub.`);
		let map;
		try {
			map = JSON.parse(fs.readFileSync(args.headsFrom, "utf8"));
		} catch (err) {
			console.error(`::error::check-template-proof-currency: cannot read --heads-from: ${err instanceof Error ? err.message : String(err)}`);
			return EXIT_BLIND;
		}
		read = readHeadFromMap(isObject(map) ? map : {});
	}

	// One read per DISTINCT repo; a slug that cannot be derived is left unread and decide() names it.
	const slugs = [...new Set(Object.values(proofs).map((p) => repoSlug(p.repo)).filter((s) => s !== null))];
	const heads = new Map(slugs.map((s) => [s, read(s)]));
	const v = decide(proofs, heads);

	console.log(report(v));
	for (const r of v.drifted) {
		console.error(`::error::check-template-proof-currency: ${r.template}: ${r.repo} HEAD is ${r.head}, last green-proven at ${r.provenCommit} (${r.bundle})`);
	}
	for (const r of v.blind) {
		console.error(`::error::check-template-proof-currency: ${r.template}: could not compare ${r.repo || "(unknown repo)"} — ${r.error}`);
	}
	if (v.blind.length > 0) console.error("  If the diagnostics mention authentication, the job needs a token (`GH_TOKEN`); the starter repos are public.");
	return v.code;
}

// ── --self-test ───────────────────────────────────────────────────────────────────────────────────

/**
 * Whether a tracker body tells its reader how to re-prove: it must carry `REPROVE_COMMAND` verbatim,
 * because the point is that the human step is one copy, not a reconstruction.
 *
 * @param {string} body
 * @returns {boolean}
 */
export function carriesReproveCommand(body) {
	return body.includes(REPROVE_COMMAND);
}

/**
 * The `-f <name>=<value>` inputs a `gh workflow run` command passes, as a map.
 *
 * @param {string} command
 * @returns {Map<string, string>}
 */
export function dispatchInputs(command) {
	return new Map([...command.matchAll(/(?:^|\s)-f\s+([A-Za-z0-9_-]+)=(\S+)/g)].map((m) => [m[1], m[2]]));
}

/**
 * The `options:` of one `workflow_dispatch` choice input, read from a workflow's YAML by
 * indentation. Returns null when the workflow has no `workflow_dispatch.inputs.<name>` with options
 * — absence is reported as absence, never as an empty list a caller might read as "anything goes".
 *
 * @param {string} yaml
 * @param {string} name
 * @returns {string[] | null}
 */
export function dispatchChoices(yaml, name) {
	const lines = yaml.split("\n");
	const indentOf = (/** @type {string} */ l) => l.length - l.trimStart().length;
	const dispatch = lines.findIndex((l) => /^\s*workflow_dispatch:\s*$/.test(l));
	if (dispatch < 0) return null;
	const inputs = lines.findIndex((l, i) => i > dispatch && /^\s*inputs:\s*$/.test(l));
	if (inputs < 0) return null;
	const inputsIndent = indentOf(lines[inputs]);
	let start = -1;
	for (let i = inputs + 1; i < lines.length; i++) {
		const l = lines[i];
		if (l.trim() === "" || l.trim().startsWith("#")) continue;
		if (indentOf(l) <= inputsIndent) break;
		if (l.trim() === `${name}:`) {
			start = i;
			break;
		}
	}
	if (start < 0) return null;
	const inputIndent = indentOf(lines[start]);
	/** @type {string[] | null} */ let options = null;
	let optionsIndent = -1;
	for (let i = start + 1; i < lines.length; i++) {
		const l = lines[i];
		if (l.trim() === "" || l.trim().startsWith("#")) continue;
		if (indentOf(l) <= inputIndent) break;
		if (options === null) {
			if (l.trim() === "options:") {
				options = [];
				optionsIndent = indentOf(l);
			}
			continue;
		}
		if (indentOf(l) <= optionsIndent && !l.trimStart().startsWith("- ")) break;
		const m = /^\s*-\s+(.*?)\s*$/.exec(l);
		if (m) options.push(m[1].replace(/^(["'])(.*)\1$/, "$2"));
	}
	return options;
}

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const SHA_C = "c".repeat(40);
const SHA_MOVED = "d".repeat(40);

/**
 * Write a fixture proofs tree the REAL reader accepts: one PASS bundle per template, proven on the
 * given shas. The bundle shape is the reader's, written here only as fixture DATA — reading it is
 * left entirely to `readTemplateProofs()`.
 *
 * @param {string} root
 * @param {Record<string, string>} commits  template → proven sha
 */
function writeProofs(root, commits) {
	for (const template of TEMPLATES) {
		const dir = path.join(root, PROOFS_DIR, template, "20261001T200301Z");
		fs.mkdirSync(dir, { recursive: true });
		const body = { template, repo: `https://github.com/alethialabs-io/alethia-starter-${template}`, ref: "HEAD", commit: commits[template], verdict: "PASS" };
		fs.writeFileSync(path.join(dir, SUMMARY_FILE), JSON.stringify(body));
	}
}

/**
 * Run this script as a child process and return its exit code — the self-test asserts on what the
 * process EXITS with, never on what it prints. What keeps a fixture run offline is `--heads-from`,
 * which every self-test child passes: blanking GH_TOKEN/GITHUB_TOKEN below does NOT, because `gh`
 * falls back to its keyring login and the starter repos are public.
 *
 * @param {string[]} args
 * @returns {{code: number, stdout: string}}
 */
function runChild(args) {
	const r = spawnSync(process.execPath, [SELF, ...args], { encoding: "utf8", env: { ...process.env, GH_TOKEN: "", GITHUB_TOKEN: "" } });
	return { code: typeof r.status === "number" ? r.status : -1, stdout: r.stdout ?? "" };
}

/**
 * Hermetic self-test: the pure halves in both directions, then the real CLI's exit codes against a
 * fixture proofs tree and fixture HEADs — including the mutation control, one HEAD moved off its
 * proven sha, which must turn the run red. Returns non-zero on any failed assertion.
 *
 * @returns {number}
 */
function selfTest() {
	let failures = 0;
	/** @param {string} label @param {boolean} cond */
	const ok = (label, cond) => {
		console.log(`${cond ? "ok  " : "FAIL"} - ${label}`);
		if (!cond) failures++;
	};

	// repoSlug
	ok("a GitHub https URL yields its slug", repoSlug("https://github.com/alethialabs-io/alethia-starter-apps") === "alethialabs-io/alethia-starter-apps");
	ok("a trailing .git is dropped", repoSlug("https://github.com/o/r.git") === "o/r");
	ok("a non-GitHub host is refused", repoSlug("https://gitlab.com/o/r") === null);
	ok("a deeper path is refused", repoSlug("https://github.com/o/r/tree/main") === null);

	// decide — every bucket, and the precedence between them.
	/** @type {Record<string, Proof>} */
	const proofs = Object.fromEntries(
		TEMPLATES.map((t, i) => [t, { repo: `https://github.com/o/starter-${t}`, provenCommit: [SHA_A, SHA_B, SHA_C][i], bundle: `demos/proofs/templates/${t}/x`, verdict: /** @type {"PASS"} */ ("PASS") }]),
	);
	const hd = (/** @type {Record<string, string>} */ m) => new Map(Object.entries(m).map(([s, sha]) => [s, { sha, error: "" }]));
	const allCurrent = { "o/starter-apps": SHA_A, "o/starter-chart": SHA_B, "o/starter-ai": SHA_C };
	ok("every HEAD = proven → 0", decide(proofs, hd(allCurrent)).code === EXIT_CURRENT);
	const moved = decide(proofs, hd({ ...allCurrent, "o/starter-chart": SHA_MOVED }));
	ok("one HEAD moved → 1", moved.code === EXIT_DRIFT);
	ok("…and the drifted row names the template, both shas and the bundle", moved.drifted.length === 1 && moved.drifted[0].template === "chart" && moved.drifted[0].head === SHA_MOVED && moved.drifted[0].provenCommit === SHA_B && moved.drifted[0].bundle === "demos/proofs/templates/chart/x");
	ok("an empty HEAD → 2, never 0", decide(proofs, hd({ ...allCurrent, "o/starter-ai": "" })).code === EXIT_BLIND);
	ok("a short sha → 2 (a prefix is not an answer)", decide(proofs, hd({ ...allCurrent, "o/starter-ai": SHA_C.slice(0, 7) })).code === EXIT_BLIND);
	ok("a missing read → 2", decide(proofs, hd({ "o/starter-apps": SHA_A, "o/starter-chart": SHA_B })).code === EXIT_BLIND);
	ok("a read that errored → 2 even if a sha came back", decide(proofs, new Map([...hd(allCurrent), ["o/starter-ai", { sha: SHA_C, error: "HTTP 502" }]])).code === EXIT_BLIND);
	ok("drift plus blindness → 2 (a partial answer is not a complete one)", decide(proofs, hd({ "o/starter-apps": SHA_MOVED, "o/starter-chart": SHA_B })).code === EXIT_BLIND);
	ok("a template the reader did not answer for → 2", decide({ apps: proofs.apps, chart: proofs.chart }, hd(allCurrent)).code === EXIT_BLIND);
	ok("a non-GitHub repo URL → 2", decide({ ...proofs, ai: { ...proofs.ai, repo: "https://gitlab.com/o/starter-ai" } }, hd(allCurrent)).code === EXIT_BLIND);

	// report — what a drift issue says.
	const rep = report(moved);
	ok("the drift report names the repo, both full shas and the bundle", [proofs.chart.repo, SHA_B, SHA_MOVED, "demos/proofs/templates/chart/x"].every((s) => rep.includes(s)));

	// The tracker body carries the re-prove command (#5686), so the human step is one copy.
	ok("the drift report (the tracker body) carries the re-prove command", carriesReproveCommand(rep));
	// MUTATION CONTROL: the same report with the command removed must fail the same predicate. Prove
	// the mutation applied first — a strip that matched nothing would pass for the wrong reason.
	const stripped = rep.replaceAll(REPROVE_COMMAND, "");
	ok("mutation applied: stripping the command changed the report", stripped !== rep);
	ok("MUTATION: a drift report without the re-prove command fails the check", !carriesReproveCommand(stripped));
	ok("a current report does not tell anyone to re-prove", !carriesReproveCommand(report(decide(proofs, hd(allCurrent)))));
	// An unanswered-only report (exit 2, nothing drifted) must not send its reader to paid spend: the
	// fix there is the instrument, and a re-prove does not repair an unread HEAD.
	const blindOnly = decide(proofs, hd({ ...allCurrent, "o/starter-ai": "" }));
	ok("an unanswered-only report does not tell anyone to re-prove", blindOnly.code === EXIT_BLIND && blindOnly.drifted.length === 0 && !carriesReproveCommand(report(blindOnly)));

	// The command must be one e2e-nightly.yml accepts: both inputs are choice inputs there, so a
	// renamed value would make the copied command fail. Read the REAL workflow; no network.
	const sample = ["on:", "  workflow_dispatch:", "    inputs:", "      provider:", "        type: choice", "        options:", "          - hetzner", "          - aws", "      dimension:", "        options:", '          - ""', "          - floor", "        default: \"\"", "jobs: {}"].join("\n");
	ok("dispatchChoices reads one input's options and stops at its end", JSON.stringify(dispatchChoices(sample, "provider")) === JSON.stringify(["hetzner", "aws"]));
	ok("dispatchChoices unquotes an option", JSON.stringify(dispatchChoices(sample, "dimension")) === JSON.stringify(["", "floor"]));
	ok("dispatchChoices: an absent input is null, not an empty list", dispatchChoices(sample, "region") === null);
	const inputs = dispatchInputs(REPROVE_COMMAND);
	ok("the re-prove command names e2e-nightly.yml and passes provider and dimension", REPROVE_COMMAND.includes(` ${path.basename(REPROVE_WORKFLOW)} `) && inputs.has("provider") && inputs.has("dimension"));
	try {
		const wf = fs.readFileSync(path.join(path.dirname(SELF), "..", REPROVE_WORKFLOW), "utf8");
		for (const name of ["provider", "dimension"]) {
			const choices = dispatchChoices(wf, name);
			const value = inputs.get(name) ?? "";
			ok(`${REPROVE_WORKFLOW} accepts ${name}=${value} (choices: ${choices === null ? "none found" : choices.join(", ")})`, choices !== null && choices.includes(value));
		}
	} catch (err) {
		ok(`${REPROVE_WORKFLOW} is readable: ${err instanceof Error ? err.message : String(err)}`, false);
	}

	// parseArgs
	ok("an unknown flag is collected, not ignored", parseArgs(["--heads=x"]).unknown.length === 1);
	ok("an empty --root= is refused", parseArgs(["--root="]).unknown.length === 1);

	// The real CLI, by exit code, against a fixture tree read by the REAL reader.
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "template-proof-currency-"));
	const write = (/** @type {string} */ name, /** @type {unknown} */ value) => {
		const p = path.join(dir, name);
		fs.writeFileSync(p, JSON.stringify(value));
		return p;
	};
	try {
		const root = path.join(dir, "repo");
		writeProofs(root, { apps: SHA_A, chart: SHA_B, ai: SHA_C });
		const slug = (/** @type {string} */ t) => `alethialabs-io/alethia-starter-${t}`;
		const currentHeads = { [slug("apps")]: SHA_A, [slug("chart")]: SHA_B, [slug("ai")]: SHA_C };
		const currentFile = write("current.json", currentHeads);
		ok("CLI: every HEAD is the proven commit → exit 0", runChild([`--root=${root}`, `--heads-from=${currentFile}`]).code === EXIT_CURRENT);

		// THE MUTATION CONTROL: the same fixture, one HEAD moved off its proven sha. Prove the mutation
		// applied before trusting its result — a mutation that silently did not apply passes.
		const mutated = { ...currentHeads, [slug("apps")]: SHA_MOVED };
		ok("mutation applied: the fixture differs from the current one in exactly one repo", Object.keys(mutated).filter((k) => mutated[k] !== currentHeads[k]).length === 1);
		const drift = runChild([`--root=${root}`, `--heads-from=${write("moved.json", mutated)}`]);
		ok(`CLI MUTATION: one HEAD moved off its proven sha turns the run red → exit 1 (got ${drift.code})`, drift.code === EXIT_DRIFT);
		ok("…and its report names the repo, both shas and the bundle", [slug("apps"), SHA_A, SHA_MOVED, "demos/proofs/templates/apps/20261001T200301Z"].every((s) => drift.stdout.includes(s)));
		ok("…and the report the workflow files as the tracker body carries the re-prove command", carriesReproveCommand(drift.stdout));

		ok("CLI: a repo the fixture does not name → exit 2", runChild([`--root=${root}`, `--heads-from=${write("partial.json", { [slug("apps")]: SHA_A })}`]).code === EXIT_BLIND);
		ok("CLI: a HEAD that is not a sha → exit 2", runChild([`--root=${root}`, `--heads-from=${write("garbage.json", { ...currentHeads, [slug("ai")]: "Not Found" })}`]).code === EXIT_BLIND);
		ok("CLI: an unreadable --heads-from → exit 2", runChild([`--root=${root}`, `--heads-from=${path.join(dir, "absent.json")}`]).code === EXIT_BLIND);
		ok("CLI: a root with no proofs → exit 2 (nothing proven is not current)", runChild([`--root=${path.join(dir, "empty")}`, `--heads-from=${currentFile}`]).code === EXIT_BLIND);
		ok("CLI: an unknown flag → exit 2, not a live run", runChild(["--heads=typo"]).code === EXIT_BLIND);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}

	// The REAL proofs tree, read without the network: every template must yield a slug this can ask
	// GitHub about, or the live run would go blind on it. The shas are NOT pinned — a pin would be a
	// fixture derived from today's value and would red on the next legitimate proof.
	try {
		const real = readTemplateProofs();
		ok("the real proofs tree answers for every template with a GitHub repo", TEMPLATES.every((t) => real[t] !== undefined && repoSlug(real[t].repo) !== null));
	} catch (err) {
		ok(`the real proofs tree is readable: ${err instanceof Error ? err.message : String(err)}`, false);
	}

	console.log(failures === 0 ? "\nself-test: all passed" : `\nself-test: ${failures} FAILED`);
	return failures === 0 ? EXIT_CURRENT : EXIT_DRIFT;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === SELF;
if (invokedDirectly) {
	try {
		process.exit(main(process.argv.slice(2)));
	} catch (err) {
		console.error(`::error::check-template-proof-currency: ${err instanceof Error ? err.message : String(err)}`);
		process.exit(EXIT_BLIND);
	}
}
