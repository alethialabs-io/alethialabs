// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// promote — open a `release/<sha>` → `main` promotion PR for ONE pinned, already-green dev commit.
//
// ── WHY ──
//
// The standing `dev → staging` promotion PR had `dev` as its head, so every queue merge into dev was
// a `synchronize` on it and restarted ~9 workflows: 220 cancelled runs in the week 2026-11-15→22, and
// promotion #7196 sat open all day with 99 commits because its ~50-minute release gate never finished
// before dev moved again. `staging` deployed nothing (CONTRIBUTING.md). The maintainer's decision:
// drop the staging hop and promote dev → main from a PINNED green dev SHA.
//
// ── WHAT THIS DOES ──
//
//   1. Picks the commit. With `--sha` (the dispatch input) it validates that one; without it, it
//      walks dev's first-parent history newest-first and takes the first commit that is GREEN.
//   2. Refuses to do anything while an older promotion PR is still in flight or green-and-unmerged
//      (unless `--force`), closes an older one that went red as superseded, and stops when the
//      commit is already on main or already carried by an open promotion.
//   3. Creates `release/<12-char sha>` pointing at EXACTLY that commit. If the branch already exists
//      at another commit it refuses: a release branch never moves, which is the whole point — its
//      checks run once.
//   4. Opens (or reuses) the PR into `main`, titled `promote: dev@<sha> → main`, listing the PRs it
//      carries.
//
// ── WHAT "GREEN" MEANS, AND WHY IT IS A TREE MATCH ──
//
// ci.yml has no `push: dev` trigger (only `pull_request` and `push: main`), so a dev commit has no
// CI run of its own. What does exist is the Mergify queue build: a `pull_request` run on a
// `mergify/merge-queue/*` draft PR whose head is dev plus the batch, which is exactly the tree dev
// has once the batch has squash-merged. So a dev commit is green when a SUCCESSFUL `CI` run on a
// `pull_request` or `push` event has the same SHA or the same git TREE — tree identity is content
// identity, and only the commit metadata differs. Measured 2026-11-22 over the last 30 green queue
// builds: every one from the last four days matched a dev commit's tree.
//
// A schedule or dispatch run is NOT evidence: ci.yml's cron and dispatch runs skip most jobs, so they
// conclude `success` without having built the tree.
//
// This is a PRE-FILTER, not the gate. The promotion PR then runs every required check and all seven
// release-gate legs on exactly that SHA, `guard-merge.sh` admits the merge only when all of them
// passed for that head, and deploy-console.yml's receipt re-checks the legs after it. The pre-filter
// only keeps a known-red commit from spending an hour of gate.
//
// ── TOKENS ──
//
// Reads use GH_TOKEN (the workflow's GITHUB_TOKEN). The branch and the PR are written with
// WRITE_TOKEN, the GitHub App token — a PR opened with GITHUB_TOKEN raises events that "will not
// create a new workflow run" (GitHub, "Triggering a workflow"), so its checks would never start and
// the promotion could never go green.
//
// Usage: node scripts/ci/promote.mjs [--sha <sha>] [--dry-run] [--force]
//        node scripts/ci/promote.mjs --self-test

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

/** How far back dev's first-parent history is searched for a green commit. */
const DEV_DEPTH = 200;
/** How many pages of 100 successful CI runs are read. */
const RUN_PAGES = 4;
/** The most PRs listed in a promotion body before it is truncated (GitHub caps a body at 65536). */
const MAX_LISTED = 300;
/** The events whose CI runs actually build the tree (see the header). */
const EVIDENCE_EVENTS = new Set(["pull_request", "push"]);
/** A promotion head branch: `release/` and a hex SHA prefix — guard-merge.sh reads the same shape. */
export const RELEASE_RE = /^release\/[0-9a-f]{7,40}$/;

/** The release branch for a commit: `release/` + the first 12 hex characters. */
export function branchFor(sha) {
	return `release/${sha.slice(0, 12)}`;
}

/** The PR title for a promotion of `sha`. */
export function titleFor(sha) {
	return `promote: dev@${sha.slice(0, 12)} → main`;
}

/**
 * The newest dev commit that is green: `commits` is newest-first `{sha, tree}`, `runs` the
 * successful CI runs as `{sha, tree, event, url}`. Returns `{commit, run}` or null.
 */
export function pickGreen(commits, runs) {
	const evidence = runs.filter((r) => EVIDENCE_EVENTS.has(r.event));
	for (const c of commits) {
		const run = evidence.find((r) => r.sha === c.sha) ?? evidence.find((r) => r.tree && r.tree === c.tree);
		if (run) return { commit: c, run };
	}
	return null;
}

/** Collapse a PR's check buckets to one state: "pending", "green" or "red". No checks reads as pending. */
export function checkState(buckets) {
	if (buckets.length === 0) return "pending";
	if (buckets.some((b) => b === "fail" || b === "cancel")) return "red";
	if (buckets.some((b) => b === "pending")) return "pending";
	return "green";
}

/**
 * What to do about the open promotion PRs before opening one for `branch`. `open` is
 * `[{number, head, state}]` where state is checkState's answer. Returns `{reuse, close, stop}`:
 * reuse an existing PR for the same branch; close the red older ones; or stop, with a reason,
 * because an older one is still in flight or green and waiting for its merge (unless `force`).
 */
export function planOlder(open, branch, force) {
	const reuse = open.find((p) => p.head === branch) ?? null;
	const older = open.filter((p) => p.head !== branch);
	const close = [];
	for (const p of older) {
		if (p.state === "red" || force) {
			close.push(p);
		} else if (p.state === "pending") {
			return { reuse, close: [], stop: `promotion #${p.number} (${p.head}) is still running its checks. Let it finish, or re-run with force to supersede it.` };
		} else {
			return { reuse, close: [], stop: `promotion #${p.number} (${p.head}) is green and waiting to be merged. Merge it first, or re-run with force to supersede it.` };
		}
	}
	return { reuse, close, stop: null };
}

/** The PR numbers named by squash-merge subjects (`… (#123)`), newest-first, deduplicated. */
export function prsFrom(subjects) {
	const seen = new Set();
	const out = [];
	for (const s of subjects) {
		const all = [...s.matchAll(/\(#(\d+)\)/g)];
		if (all.length === 0) continue;
		const n = Number(all[all.length - 1][1]);
		if (!seen.has(n)) {
			seen.add(n);
			out.push({ n, subject: s });
		}
	}
	return out;
}

/** The promotion PR body for `sha`, the run that showed it green, and the PRs it carries. */
export function bodyFor({ sha, run, prs, total }) {
	const lines = [
		`Promotes \`dev@${sha}\` to \`main\`. Opened by \`.github/workflows/promote.yml\`.`,
		"",
		`The head branch \`${branchFor(sha)}\` points at exactly that commit and is never moved, so the checks below run once.`,
		`Green before opening: ${run ? `CI run ${run.url} (${run.event}, ${run.sha === sha ? "same commit" : "same tree"})` : "not checked (forced)"}.`,
		"",
		"Merge only when every check and every `Release gate (<leg>)` passed, as `gh pr merge <n> --merge --match-head-commit " + sha + "` (`.claude/hooks/guard-merge.sh`).",
		"",
		`### Included (${total} commit${total === 1 ? "" : "s"} on dev's first-parent line, ${prs.length} PR${prs.length === 1 ? "" : "s"})`,
		"",
	];
	for (const p of prs.slice(0, MAX_LISTED)) lines.push(`- ${p.subject}`);
	if (prs.length > MAX_LISTED) lines.push(`- … and ${prs.length - MAX_LISTED} more`);
	return lines.join("\n") + "\n";
}

// ── I/O ───────────────────────────────────────────────────────────────────────────────────────

/** Run a command and return its trimmed stdout; `token` overrides GH_TOKEN for this call. */
function run(cmd, args, token) {
	const env = token ? { ...process.env, GH_TOKEN: token } : process.env;
	return execFileSync(cmd, args, { encoding: "utf8", env, maxBuffer: 64 * 1024 * 1024 }).trim();
}

/** True when `a` is an ancestor of (or equal to) `b` in the local clone. */
function isAncestor(a, b) {
	try {
		execFileSync("git", ["merge-base", "--is-ancestor", a, b]);
		return true;
	} catch {
		return false;
	}
}

/** The successful CI runs, flattened to `{sha, tree, event, url}`. */
function greenRuns(repo) {
	const out = [];
	for (let page = 1; page <= RUN_PAGES; page++) {
		const body = JSON.parse(run("gh", ["api", `repos/${repo}/actions/workflows/ci.yml/runs?status=success&per_page=100&page=${page}`]));
		for (const r of body.workflow_runs ?? []) {
			out.push({ sha: r.head_sha, tree: r.head_commit?.tree_id ?? "", event: r.event, url: r.html_url });
		}
		if ((body.workflow_runs ?? []).length < 100) break;
	}
	return out;
}

/** dev's first-parent history, newest-first, as `{sha, tree}`. */
function devCommits() {
	return run("git", ["log", "--first-parent", `-n${DEV_DEPTH}`, "--format=%H %T", "origin/dev"])
		.split("\n")
		.filter(Boolean)
		.map((l) => {
			const [sha, tree] = l.split(" ");
			return { sha, tree };
		});
}

/** The open promotion PRs into main, with their check state. */
function openPromotions(repo) {
	const prs = JSON.parse(run("gh", ["pr", "list", "-R", repo, "--base", "main", "--state", "open", "--limit", "100", "--json", "number,headRefName,headRefOid"]));
	return prs
		.filter((p) => RELEASE_RE.test(p.headRefName))
		.map((p) => {
			let buckets = [];
			try {
				buckets = JSON.parse(run("gh", ["pr", "checks", String(p.number), "-R", repo, "--json", "bucket"]) || "[]").map((c) => c.bucket);
			} catch (e) {
				// gh exits 8 while checks are pending and 1 when one failed, printing the JSON either way.
				buckets = JSON.parse(String(e.stdout || "[]")).map((c) => c.bucket);
			}
			return { number: p.number, head: p.headRefName, sha: p.headRefOid, state: checkState(buckets) };
		});
}

/** Append a line to the job summary when there is one, and print it. */
function say(line) {
	console.log(line);
	if (process.env.GITHUB_STEP_SUMMARY) writeFileSync(process.env.GITHUB_STEP_SUMMARY, line + "\n", { flag: "a" });
}

/** The promotion: pick, plan, branch, PR. See the header. */
async function main(argv) {
	const repo = process.env.REPO || process.env.GITHUB_REPOSITORY;
	const write = process.env.WRITE_TOKEN;
	const at = argv.indexOf("--sha");
	const wanted = at >= 0 ? (argv[at + 1] ?? "").trim() : "";
	const dry = argv.includes("--dry-run");
	const force = argv.includes("--force");
	if (!repo) throw new Error("REPO (or GITHUB_REPOSITORY) is not set.");
	if (!dry && !write) throw new Error("WRITE_TOKEN (the GitHub App token) is not set; a PR opened with GITHUB_TOKEN would never start its checks.");

	const commits = devCommits();
	const runs = greenRuns(repo);
	let picked;
	if (wanted) {
		const sha = run("git", ["rev-parse", "--verify", `${wanted}^{commit}`]);
		if (!isAncestor(sha, "origin/dev")) throw new Error(`${sha} is not on dev; only a dev commit can be promoted.`);
		const tree = run("git", ["rev-parse", `${sha}^{tree}`]);
		picked = pickGreen([{ sha, tree }], runs);
		if (!picked) {
			if (!force) throw new Error(`${sha} has no successful CI run on its commit or its tree (pull_request or push). Pick a green commit, or re-run with force.`);
			picked = { commit: { sha, tree }, run: null };
		}
	} else {
		picked = pickGreen(commits, runs);
		if (!picked) {
			say(`No commit in dev's last ${DEV_DEPTH} first-parent commits has a successful CI run on its commit or tree. Nothing to promote.`);
			return;
		}
	}
	const sha = picked.commit.sha;
	const branch = branchFor(sha);
	say(`Candidate: dev@${sha}${picked.run ? ` — green by ${picked.run.url}` : " (forced, not checked)"}`);

	if (isAncestor(sha, "origin/main")) {
		say(`dev@${sha.slice(0, 12)} is already on main. Nothing to promote.`);
		return;
	}
	const open = openPromotions(repo);
	const ahead = open.find((p) => p.head !== branch && p.sha && isAncestor(sha, p.sha));
	if (ahead) {
		say(`Open promotion #${ahead.number} (${ahead.head}) already carries dev@${sha.slice(0, 12)}. Nothing to do.`);
		return;
	}
	const plan = planOlder(open, branch, force);
	if (plan.stop) {
		say(`Not opening a promotion: ${plan.stop}`);
		return;
	}

	const subjects = run("git", ["log", "--first-parent", "--format=%s", `origin/main..${sha}`]).split("\n").filter(Boolean);
	const body = bodyFor({ sha, run: picked.run, prs: prsFrom(subjects), total: subjects.length });
	if (dry) {
		say(`Dry run. Would close: ${plan.close.map((p) => `#${p.number}`).join(", ") || "none"}; ${plan.reuse ? `reuse #${plan.reuse.number}` : `open ${branch} → main`}.`);
		console.log(body);
		return;
	}

	for (const p of plan.close) {
		run("gh", ["pr", "close", String(p.number), "-R", repo, "--comment", `Superseded by a promotion of dev@${sha.slice(0, 12)} (${branch}).`, "--delete-branch"], write);
		say(`Closed #${p.number} (${p.head}) as superseded.`);
	}

	// The branch: create it at exactly `sha`, or accept it only if it is already there.
	let existing = "";
	try {
		existing = JSON.parse(run("gh", ["api", `repos/${repo}/git/ref/heads/${branch}`])).object?.sha ?? "";
	} catch {
		existing = "";
	}
	if (existing && existing !== sha) throw new Error(`${branch} exists at ${existing}, not ${sha}. A release branch never moves; investigate instead of overwriting it.`);
	if (!existing) {
		run("gh", ["api", "-X", "POST", `repos/${repo}/git/refs`, "-f", `ref=refs/heads/${branch}`, "-f", `sha=${sha}`], write);
		say(`Created ${branch} at ${sha}.`);
	}

	if (plan.reuse) {
		say(`Reusing promotion #${plan.reuse.number}.`);
		return;
	}
	const file = `${process.env.RUNNER_TEMP || "/tmp"}/promote-body.md`;
	writeFileSync(file, body);
	const pr = JSON.parse(run("gh", ["api", "-X", "POST", `repos/${repo}/pulls`, "-f", `title=${titleFor(sha)}`, "-f", `head=${branch}`, "-f", "base=main", "-F", `body=@${file}`], write));
	say(`Opened promotion #${pr.number}: ${pr.html_url}`);
}

// ── self-test ─────────────────────────────────────────────────────────────────────────────────

/** The pure halves, exercised without the network. The exit code is the test. */
function selfTest() {
	let fail = 0;
	const P = (name, ok) => {
		if (!ok) {
			fail++;
			console.log(`  ✗ ${name}`);
		}
	};
	const commits = [
		{ sha: "c3".padEnd(40, "0"), tree: "t3" },
		{ sha: "c2".padEnd(40, "0"), tree: "t2" },
		{ sha: "c1".padEnd(40, "0"), tree: "t1" },
	];
	const run = (sha, tree, event) => ({ sha, tree, event, url: `u-${sha}` });
	P("a tree match on a queue build is green", pickGreen(commits, [run("q", "t2", "pull_request")])?.commit.tree === "t2");
	P("the NEWEST green commit wins", pickGreen(commits, [run("q1", "t1", "pull_request"), run("q2", "t2", "pull_request")])?.commit.tree === "t2");
	P("a sha match is green", pickGreen(commits, [run(commits[0].sha, "", "push")])?.commit.tree === "t3");
	P("a schedule run is not evidence", pickGreen(commits, [run("s", "t3", "schedule")]) === null);
	P("a dispatch run is not evidence", pickGreen(commits, [run("d", "t3", "workflow_dispatch")]) === null);
	P("an empty tree never matches an empty tree", pickGreen([{ sha: "x", tree: "" }], [run("y", "", "pull_request")]) === null);
	P("no green run, no pick", pickGreen(commits, []) === null);

	P("no checks is pending", checkState([]) === "pending");
	P("a failure is red even beside a pending one", checkState(["pass", "pending", "fail"]) === "red");
	P("a cancel is red", checkState(["pass", "cancel"]) === "red");
	P("pending beats pass", checkState(["pass", "pending"]) === "pending");
	P("pass and skipping is green", checkState(["pass", "skipping"]) === "green");

	const B = "release/aaaaaaaaaaaa";
	P("the same branch is reused", planOlder([{ number: 1, head: B, state: "pending" }], B, false).reuse?.number === 1);
	P("a red older one is closed", planOlder([{ number: 2, head: "release/bbbbbbbbbbbb", state: "red" }], B, false).close.length === 1);
	P("a pending older one stops", /still running/.test(planOlder([{ number: 3, head: "release/bbbbbbbbbbbb", state: "pending" }], B, false).stop ?? ""));
	P("a green older one stops", /waiting to be merged/.test(planOlder([{ number: 4, head: "release/bbbbbbbbbbbb", state: "green" }], B, false).stop ?? ""));
	P("force supersedes a pending one", planOlder([{ number: 5, head: "release/bbbbbbbbbbbb", state: "pending" }], B, true).close.length === 1);
	P("nothing open, nothing to do", JSON.stringify(planOlder([], B, false)) === JSON.stringify({ reuse: null, close: [], stop: null }));

	P("the branch is release/ + 12 hex", branchFor("0123456789abcdef0123") === "release/0123456789ab" && RELEASE_RE.test(branchFor("0123456789abcdef0123")));
	P("the release pattern is anchored", !RELEASE_RE.test("release/abc1234/x") && !RELEASE_RE.test("xrelease/abc1234") && !RELEASE_RE.test("release/ABC1234") && !RELEASE_RE.test("release/abc12"));
	P("the title names the commit", titleFor("0123456789abcdef") === "promote: dev@0123456789ab → main");
	const prs = prsFrom(["feat: a (#10)", "fix: b (#7) (#11)", "chore: no number", "feat: a again (#10)"]);
	P("PR numbers come from the LAST (#n), deduplicated", JSON.stringify(prs.map((p) => p.n)) === JSON.stringify([10, 11]));
	const body = bodyFor({ sha: "f".repeat(40), run: null, prs: Array.from({ length: MAX_LISTED + 2 }, (_, i) => ({ n: i })), total: 400 });
	P("a long list is truncated and says so", body.includes("… and 2 more") && body.includes(`--match-head-commit ${"f".repeat(40)}`));

	console.log(fail === 0 ? "  promote self-test: all passed" : `  promote self-test: ${fail} failed`);
	process.exit(fail === 0 ? 0 : 1);
}

if (process.argv.includes("--self-test")) {
	selfTest();
} else {
	main(process.argv.slice(2)).catch((e) => {
		console.error(`::error::${e.message}`);
		process.exit(1);
	});
}
