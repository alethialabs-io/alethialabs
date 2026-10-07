#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
//
// The issue `Deploy Console` opens when it goes red on `main` — and what that issue says production
// is running.
//
// WHY THIS IS A SCRIPT AND NOT INLINE SHELL (#5643). The inline version wrote ONE body for every red
// run: "The `deploy` job is gated `!cancelled() && !failure()`, so production did NOT receive this
// commit." But `report-failure` also needs `smoke`, which runs AFTER `deploy`. Run 37618768056 had
// `deploy: success` and only the post-deploy smoke red, and the alert it opened (#5620) told the
// reader production did not receive a commit it was in fact running. An alert that misstates what
// production runs invites a rollback or a redeploy of a healthy release. The wording now comes from
// `needs.deploy.result`, and this file's `--self-test` pins every case.
//
// THE CASES (`needs.deploy.result` × `needs.smoke.result`). `report-failure` only runs on
// `failure() || cancelled()`, so at least one job in its `needs` failed or was cancelled.
//
//   deploy skipped              → NOT_DEPLOYED. `deploy` never ran: its `if:` is
//                                 `!cancelled() && !failure()` and something upstream failed or was
//                                 cancelled. Production did NOT receive this commit (today's text).
//   deploy failure | cancelled  → NOT_DEPLOYED title, but the body does NOT claim production is
//                                 untouched: `deploy` can fail AFTER `docker compose up -d` (the
//                                 provenance check, the Caddy reload, the served-URL poll), so what
//                                 the box runs depends on where it stopped. The body says so.
//   deploy success, smoke failure
//                               → SMOKE. The body names the smoke's failing assertions.
//   deploy success, smoke cancelled | skipped | success
//                               → DEPLOYED_UNFINISHED: the run was cancelled after the deploy (or the
//                                 smoke job did not finish). The smoke never went red; for `success`
//                                 it passed. Neither is a finding about the release.
//
// In both deploy-success kinds, WHICH console is live is read from the run, never assumed:
//   APPS_BUILD == "true"         the console was rebuilt and `deploy`'s provenance check compared the
//                                 running container's ALETHIA_SOURCE_COMMIT to this SHA → "production
//                                 IS running this commit".
//   otherwise, CONSOLE_EQUIVALENCE (retag-unchanged's output):
//     checked:<built>            retagged from <built>; the console's source paths were diffed and
//                                 unchanged between <built> and this commit.
//     skipped:<reason>           retagged on a `::warning::… retagging anyway` path — equivalence NOT
//                                 asserted, a stale image is possible.
//     anything else              unknown which path ran — said as unknown.
//
// The three kinds carry DIFFERENT titles and dedupe separately: a smoke-only red never comments on an
// open "not receiving new code" issue, nor the reverse. NOT_DEPLOYED keeps the exact title the inline
// script used, so an issue already open under it keeps being updated rather than duplicated.
//
//   node scripts/deploy-failure-report.mjs               # live: reads the env the workflow sets
//   node scripts/deploy-failure-report.mjs --self-test   # hermetic: fake `gh`, every case
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOW = ".github/workflows/deploy-console.yml";

/** The title of a red run where production did not (or may not) have received the commit. */
export const TITLE_NOT_DEPLOYED =
	"prod: Deploy Console is red on main — production is not receiving new code";

/** The title of a red run whose deploy succeeded and whose post-deploy smoke did not pass. */
export const TITLE_SMOKE =
	"prod: the post-deploy smoke is red on main — the deploy itself succeeded";

/** The title of a run whose deploy succeeded and that was then cancelled or did not finish its smoke. */
export const TITLE_DEPLOYED_UNFINISHED =
	"prod: Deploy Console deployed main, then the run did not finish cleanly";

/** The `needs.<job>.result` values GitHub Actions can produce. */
const RESULTS = ["success", "failure", "cancelled", "skipped"];

/** How many error annotations to quote per failing job — a diagnosis, not a log dump. */
const ANNOTATIONS_PER_JOB = 5;

/**
 * Is this annotation the runner's generic exit-code line rather than something a step said?
 * Every failed step produces one, and it names nothing.
 * @param {string} message
 * @returns {boolean}
 */
function isExitCodeNoise(message) {
	return /^Process completed with exit code \d+\.?$/.test(message.trim());
}

/**
 * Render the failing-jobs list, each with the error annotations its steps emitted.
 * @param {{name: string, conclusion: string, errors: string[]}[]} jobs
 * @returns {string}
 */
function renderJobs(jobs) {
	if (jobs.length === 0) return "- (could not enumerate jobs — see the run)";
	const out = [];
	for (const j of jobs) {
		out.push(`- \`${j.name}\` — ${j.conclusion}`);
		for (const e of j.errors) out.push(`  - ${e.replace(/\s+/g, " ").slice(0, 300)}`);
	}
	return out.join("\n");
}

/**
 * The sentence saying which console production is running after a SUCCESSFUL deploy, from what the
 * run actually checked. Only a rebuild proves "this commit": then `deploy`'s provenance check compared
 * the running container's ALETHIA_SOURCE_COMMIT to the SHA and fails on a mismatch. On a retag `deploy`
 * checks the provenance is non-empty only, and the smoke's build-id assertion is off, so what is known
 * is whatever `retag-unchanged`'s stale_check recorded. Anything but the literal values below is read
 * as the weaker case — the claim that needs proof is the one never made by default.
 * @param {string} sha
 * @param {string} appsBuild `needs.changes.outputs.apps_build`
 * @param {string} consoleEquivalence `needs.retag-unchanged.outputs.console_equivalence`
 * @returns {string}
 */
export function liveConsole(sha, appsBuild, consoleEquivalence) {
	if (appsBuild === "true") {
		return "**The `deploy` job succeeded and the console was rebuilt in this run, so production IS running this commit** — " +
			"`deploy` read `ALETHIA_SOURCE_COMMIT` off the running console container and it matched this SHA. " +
			"Do not roll back or redeploy on the strength of this issue alone.";
	}
	const lead = "**The `deploy` job succeeded; the console was NOT rebuilt in this run — production is running a RETAGGED console image.**";
	const checked = /^checked:([0-9a-f]{7,40})$/.exec(consoleEquivalence);
	if (checked) {
		return `${lead} It was retagged from the build of \`${checked[1]}\`, and \`retag-unchanged\` checked that the console's source paths ` +
			`were unchanged between \`${checked[1]}\` and this commit. Do not roll back or redeploy on the strength of this issue alone.`;
	}
	const stale =
		"`retag-unchanged` can report success while shipping a stale image, so confirm the deployed `ALETHIA_SOURCE_COMMIT` " +
		"(`deploy`'s `running console carries ALETHIA_SOURCE_COMMIT=` line) before trusting what is live.";
	const skipped = /^skipped:(.+)$/.exec(consoleEquivalence);
	if (skipped) {
		return `${lead} \`retag-unchanged\` retagged it WITHOUT checking equivalence to this commit (\`${skipped[1]}\` — a ` +
			`\`::warning::… retagging anyway\` path), so a stale image is possible. ${stale}`;
	}
	return `${lead} Whether \`retag-unchanged\` checked its equivalence to this commit is unknown — its \`console_equivalence\` output ` +
		`was ${JSON.stringify(consoleEquivalence)}. Read that job's log. ${stale}`;
}

/**
 * THE WHOLE DECISION: the issue title and body for one red run. Pure, so every case is testable.
 *
 * @param {object} input
 * @param {string} input.deployResult `needs.deploy.result`
 * @param {string} input.smokeResult `needs.smoke.result`
 * @param {string} input.appsBuild `needs.changes.outputs.apps_build` — "true" only when the apps
 *   group (console included) was rebuilt in this run
 * @param {string} input.consoleEquivalence `needs.retag-unchanged.outputs.console_equivalence`
 * @param {string} input.sha the commit the run deployed (`github.sha`)
 * @param {string} input.runUrl
 * @param {{name: string, conclusion: string, errors: string[]}[]} input.failingJobs
 * @returns {{kind: "not-deployed" | "smoke" | "deployed-unfinished", title: string, body: string}}
 * @throws on a result value Actions cannot produce — an unread input is not a case to guess at.
 */
export function composeReport({ deployResult, smokeResult, appsBuild, consoleEquivalence = "", sha, runUrl, failingJobs }) {
	for (const [k, v] of [
		["deploy", deployResult],
		["smoke", smokeResult],
	]) {
		if (!RESULTS.includes(v)) {
			throw new Error(
				`needs.${k}.result is ${JSON.stringify(v)}, not one of ${RESULTS.join("/")}. If it is empty, ` +
					`\`${k}\` is not a DIRECT need of report-failure — the needs context carries direct needs only.`,
			);
		}
	}
	const jobs = renderJobs(failingJobs);

	if (deployResult === "success") {
		const live = liveConsole(sha, appsBuild, consoleEquivalence);

		if (smokeResult !== "failure") {
			const what =
				smokeResult === "success"
					? "The post-deploy smoke PASSED (`smoke: success`); the run was cancelled after it. There is nothing here about the release to act on."
					: `The post-deploy smoke did not finish (\`smoke: ${smokeResult}\`) — the run was cancelled, or the smoke job did not complete. ` +
						"That is NOT a red smoke: this run says nothing either way about whether the live release is healthy.";
			const close =
				smokeResult === "success"
					? "Close this once you have confirmed the cancellation was deliberate."
					: "Close this when a `Deploy Console` run on main reaches `smoke: success`, or re-run this run's smoke job and close on its result.";
			const body = [
				"`Deploy Console` was deployed from `main` at commit:",
				sha,
				"",
				live,
				"",
				what,
				"",
				"Failing or cancelled jobs:",
				jobs,
				"",
				`Run: ${runUrl}`,
				"",
				close,
				"",
			].join("\n");
			return { kind: "deployed-unfinished", title: TITLE_DEPLOYED_UNFINISHED, body };
		}

		const smokeJob = failingJobs.find((j) => j.name.startsWith("Post-deploy smoke"));
		const assertions = smokeJob && smokeJob.errors.length > 0
			? smokeJob.errors.map((e) => `- ${e.replace(/\s+/g, " ").slice(0, 300)}`).join("\n")
			: "- (the smoke job emitted no error annotations — read its log, and the `post-deploy-smoke` artifact if it uploaded one)";
		const body = [
			"`Deploy Console` was deployed from `main` at commit:",
			sha,
			"",
			live,
			"",
			"What failed is the post-deploy smoke (`smoke: failure`), which runs after the deploy and checks the public URL from the outside. " +
				"`deploy` had already seen the public URL answer 2xx/3xx; the smoke asks more than that, so a red smoke means something about what " +
				"the public URL serves now is wrong.",
			"",
			"Failing smoke assertions:",
			assertions,
			"",
			"Failing jobs:",
			jobs,
			"",
			`Run: ${runUrl}`,
			"",
			"Close this when a `Deploy Console` run on main reaches `smoke: success`. If the failing assertion turns out to be a defect in the smoke " +
				"rather than in the release, fix the smoke and link the fix here before closing.",
			"",
		].join("\n");
		return { kind: "smoke", title: TITLE_SMOKE, body };
	}

	const verdict =
		deployResult === "skipped"
			? "**The `deploy` job did not run — it is gated `!cancelled() && !failure()` and a job before it failed or was cancelled — so production did NOT receive this commit.**"
			: `**The \`deploy\` job ran and ended \`${deployResult}\`, so this commit did not finish deploying.** ` +
				"Whether production is running it depends on where `deploy` stopped: it can fail AFTER `docker compose up -d` " +
				"(the provenance check, the Caddy reload, or the served-URL poll). Read the `deploy` log before assuming either way.";
	const body = [
		"`Deploy Console` failed on `main` at commit:",
		sha,
		"",
		verdict,
		"",
		"Failing jobs:",
		jobs,
		"",
		`Run: ${runUrl}`,
		"",
		"Do not close this until a `Deploy Console` run on main reaches `deploy: success`. A green run is",
		"not sufficient on its own — `retag-unchanged` can report success while shipping a stale image, so",
		"confirm the deployed `ALETHIA_SOURCE_COMMIT` matches the promoted SHA.",
		"",
	].join("\n");
	return { kind: "not-deployed", title: TITLE_NOT_DEPLOYED, body };
}

/**
 * The failed and cancelled jobs of a run, each with its steps' error annotations. Best-effort, as the
 * inline script was: a listing that cannot be read yields an empty list, which the body names.
 * @param {(args: string[]) => string} gh
 * @param {string} repo
 * @param {string} runId
 * @returns {{name: string, conclusion: string, errors: string[]}[]}
 */
export function failingJobs(gh, repo, runId) {
	let lines;
	try {
		lines = gh([
			"api",
			`repos/${repo}/actions/runs/${runId}/jobs?per_page=100`,
			"--paginate",
			"--jq",
			'.jobs[] | select(.conclusion=="failure" or .conclusion=="cancelled") | {id, name, conclusion}',
		]);
	} catch {
		return [];
	}
	const jobs = [];
	for (const line of lines.split("\n").filter((l) => l.trim() !== "").slice(0, 40)) {
		let job;
		try {
			job = JSON.parse(line);
		} catch {
			continue;
		}
		let errors = [];
		try {
			const ann = JSON.parse(gh(["api", `repos/${repo}/check-runs/${job.id}/annotations`]));
			errors = (Array.isArray(ann) ? ann : [])
				.filter((a) => a?.annotation_level === "failure" && typeof a.message === "string" && !isExitCodeNoise(a.message))
				.map((a) => String(a.message))
				.slice(0, ANNOTATIONS_PER_JOB);
		} catch {
			errors = [];
		}
		jobs.push({ name: String(job.name), conclusion: String(job.conclusion), errors });
	}
	return jobs;
}

/**
 * Open the issue for this report, or comment on the open one with the SAME title. The search narrows;
 * the exact-title filter decides, so the two kinds cannot match each other's issues.
 * @param {(args: string[]) => string} gh
 * @param {string} repo
 * @param {{title: string, body: string}} report
 * @param {string} bodyFile where to write the body for `--body-file`
 * @returns {{action: "comment" | "create", issue?: number}}
 */
export function fileReport(gh, repo, report, bodyFile) {
	writeFileSync(bodyFile, report.body);
	const listed = JSON.parse(
		gh(["issue", "list", "--repo", repo, "--state", "open", "--search", `in:title "${report.title}"`, "--limit", "100", "--json", "number,title"]) || "[]",
	);
	const existing = listed.find((i) => i.title === report.title);
	if (existing) {
		console.log(`Updating existing issue #${existing.number}`);
		gh(["issue", "comment", String(existing.number), "--repo", repo, "--body-file", bodyFile]);
		return { action: "comment", issue: existing.number };
	}
	console.log("Opening a new issue");
	gh(["issue", "create", "--repo", repo, "--title", report.title, "--body-file", bodyFile]);
	return { action: "create" };
}

/**
 * Read one required environment variable, refusing when it is unset.
 * @param {string} name
 * @returns {string}
 */
function need(name) {
	const v = process.env[name];
	if (v === undefined || v === "") throw new Error(`${name} is not set; the report-failure step must pass it.`);
	return v;
}

/** The live entry point: compose the report from the workflow's env and file it. */
function live() {
	const gh = (args) => execFileSync("gh", args, { encoding: "utf8" });
	const repo = need("REPO");
	const report = composeReport({
		deployResult: need("DEPLOY_RESULT"),
		smokeResult: need("SMOKE_RESULT"),
		// Not `need()`: empty is possible when `changes` did not succeed, and composeReport reads
		// anything but "true" as the unproven (retag) case.
		appsBuild: process.env.APPS_BUILD ?? "",
		// Empty when retag-unchanged was skipped; liveConsole says "unknown" rather than guessing.
		consoleEquivalence: process.env.CONSOLE_EQUIVALENCE ?? "",
		sha: need("SHA"),
		runUrl: need("RUN_URL"),
		failingJobs: failingJobs(gh, repo, need("RUN_ID")),
	});
	console.log(`report kind: ${report.kind}`);
	fileReport(gh, repo, report, join(mkdtempSync(join(tmpdir(), "deploy-failure-")), "body.md"));
}

/**
 * The `report-failure` job's lines in deploy-console.yml, read line-wise (no YAML dependency at the
 * root). Empty when the job is not found, which the caller treats as a failure, not a pass.
 * @param {string} text
 * @returns {string[]}
 */
export function reportFailureJob(text) {
	return jobLines(text, "report-failure");
}

/**
 * One job's lines from a workflow, read line-wise: from `  <name>:` to the next top-level job key.
 * @param {string} text
 * @param {string} name
 * @returns {string[]} empty when the job is not found
 */
export function jobLines(text, name) {
	const lines = text.split("\n");
	const start = lines.indexOf(`  ${name}:`);
	if (start === -1) return [];
	let end = lines.length;
	for (let i = start + 1; i < lines.length; i++) {
		if (/^  \S/.test(lines[i]) || /^\S/.test(lines[i])) {
			end = i;
			break;
		}
	}
	return lines.slice(start, end);
}

/**
 * What the workflow must wire for this script's cases to be reachable. Each entry is a finding.
 * @param {string} text deploy-console.yml
 * @returns {string[]}
 */
export function wiringProblems(text) {
	const job = reportFailureJob(text);
	if (job.length === 0) return ["no `report-failure:` job found in " + WORKFLOW];
	const src = job.join("\n");
	const problems = [];
	// `needs:` may wrap over several lines; read until the next key at the job's key indent.
	const needsStart = job.findIndex((l) => /^    needs:/.test(l));
	let needsText = "";
	if (needsStart !== -1) {
		for (let i = needsStart; i < job.length; i++) {
			if (i > needsStart && /^    \S/.test(job[i])) break;
			needsText += job[i];
		}
	}
	const needs = (needsText.match(/\[([^\]]*)\]/)?.[1] ?? "").split(",").map((s) => s.trim());
	for (const j of ["changes", "retag-unchanged", "deploy", "smoke"]) {
		if (!needs.includes(j)) problems.push(`report-failure does not directly need \`${j}\`, so needs.${j}.result is empty`);
	}
	if (!/^    if: \$\{\{ \(failure\(\) \|\| cancelled\(\)\) && github\.ref == 'refs\/heads\/main' \}\}$/m.test(src)) {
		problems.push("report-failure's `if:` is no longer `(failure() || cancelled()) && github.ref == 'refs/heads/main'`");
	}
	for (const want of [
		"DEPLOY_RESULT: ${{ needs.deploy.result }}",
		"SMOKE_RESULT: ${{ needs.smoke.result }}",
		"APPS_BUILD: ${{ needs.changes.outputs.apps_build }}",
		"CONSOLE_EQUIVALENCE: ${{ needs.retag-unchanged.outputs.console_equivalence }}",
		"run: node scripts/deploy-failure-report.mjs",
	]) {
		if (!src.includes(want)) problems.push(`report-failure is missing \`${want}\``);
	}
	// The other halves of what the alert claims. "IS running this commit" rests on `deploy` reading
	// the SAME apps_build verdict (its provenance check compares to the SHA only when it is true), and
	// the retag wording rests on retag-unchanged exporting which stale_check path ran. These are
	// YAML keys, read as such; the shell comparison inside `deploy` is NOT checked here.
	if (!jobLines(text, "deploy").includes("      APPS_BUILT: ${{ needs.changes.outputs.apps_build }}")) {
		problems.push("`deploy`'s env no longer has `APPS_BUILT: ${{ needs.changes.outputs.apps_build }}` — the alert's \"IS running this commit\" reads that same output");
	}
	if (!jobLines(text, "retag-unchanged").includes("      console_equivalence: ${{ steps.retag.outputs.console_equivalence }}")) {
		problems.push("`retag-unchanged` no longer exports `console_equivalence` from step `retag` — the alert's retag wording reads it");
	}
	// composeReport finds the smoke's assertions by this job-name prefix.
	if (!/^  smoke:\n    name: Post-deploy smoke/m.test(text)) {
		problems.push("the `smoke` job's `name:` no longer starts with `Post-deploy smoke`, which is how composeReport finds its assertions");
	}
	if (/did NOT receive/.test(src)) {
		problems.push("report-failure carries its own 'did NOT receive' text — the wording belongs to this script, which decides it per case");
	}
	return problems;
}

/** Hermetic self-test: every case, the dedupe, and the workflow wiring. Exits non-zero on any miss. */
function selfTest() {
	let failed = 0;
	const ok = (name, cond, detail = "") => {
		if (cond) console.log(`  ok   ${name}`);
		else {
			failed++;
			console.log(`  FAIL ${name}${detail ? `\n       ${detail}` : ""}`);
		}
	};
	const SHA = "ca2ee7d01968bd52c1e81c5d3cf13928e941ffe3";
	const base = { sha: SHA, runUrl: "https://example.test/run/1" };
	const smokeJob = {
		name: "Post-deploy smoke (the public URL, and the build it serves)",
		conclusion: "failure",
		errors: ["build-id: the browser is running build unset, but ca2ee7d was promoted — stale bytes are being served"],
	};

	// ── the case table ────────────────────────────────────────────────────────────────────────────
	// #5620 / run 37618768056: deploy green, only the smoke red, console rebuilt (the smoke compared a
	// build id, so SMOKE_EXPECTED_SHA was set). The inline script said production did NOT receive it.
	const smoke = composeReport({ ...base, deployResult: "success", smokeResult: "failure", appsBuild: "true", failingJobs: [smokeJob] });
	ok("deploy success + smoke failure is the SMOKE kind", smoke.kind === "smoke" && smoke.title === TITLE_SMOKE);
	ok("...and never says production did not receive the commit", !/did NOT receive|not receiving/i.test(smoke.title + smoke.body), smoke.body);
	ok("...and, on a REBUILD, says production IS running it, with the SHA", /production IS running this commit/.test(smoke.body) && smoke.body.includes(SHA));
	ok("...and names the smoke's failing assertion", smoke.body.includes("build-id: the browser is running build unset"));
	ok("...and closes on `smoke: success`, not on `deploy: success`", /reaches `smoke: success`/.test(smoke.body) && !/reaches `deploy: success`/.test(smoke.body));

	ok("...and, on a rebuild, carries no stale-image caveat that would contradict it", !/stale image/.test(smoke.body), smoke.body);

	// The RETAG paths. The claim is asserted, not a keyword near it.
	const NO_THIS_COMMIT = /IS running this commit|IS running the deployed commit/i;
	const BUILT = "0123456789abcdef0123456789abcdef01234567";
	const ck = composeReport({ ...base, deployResult: "success", smokeResult: "failure", appsBuild: "false", consoleEquivalence: `checked:${BUILT}`, failingJobs: [smokeJob] });
	ok("retag, equivalence CHECKED: names the built commit and says the source paths were checked unchanged", ck.body.includes(BUILT) && /checked that the console's source paths were unchanged/.test(ck.body), ck.body);
	ok("...and does not say equivalence was not asserted, nor claim \"IS running this commit\"", !/WITHOUT checking|unknown|Nothing in this run asserted/.test(ck.body) && !NO_THIS_COMMIT.test(ck.title + ck.body), ck.body);
	for (const eq of ["skipped:no-source-commit", "skipped:unknown-commit"]) {
		const sk = composeReport({ ...base, deployResult: "success", smokeResult: "failure", appsBuild: "false", consoleEquivalence: eq, failingJobs: [smokeJob] });
		ok(`retag, equivalence ${eq}: says NOT checked, stale image possible, with the caveat`, /WITHOUT checking equivalence/.test(sk.body) && /stale image is possible/.test(sk.body) && /can report success while shipping a stale image/.test(sk.body), sk.body);
		ok("...and claims neither \"this commit\" nor a checked equivalence", !NO_THIS_COMMIT.test(sk.title + sk.body) && !/checked that the console's source paths/.test(sk.body));
	}
	for (const eq of ["", "not-retagged", "garbage", "checked:", "checked:not-a-sha"]) {
		for (const appsBuild of ["false", ""]) {
			const un = composeReport({ ...base, deployResult: "success", smokeResult: "failure", appsBuild, consoleEquivalence: eq, failingJobs: [smokeJob] });
			ok(`retag, equivalence ${JSON.stringify(eq)} / apps_build ${JSON.stringify(appsBuild)}: says UNKNOWN, no claim either way`, /is unknown/.test(un.body) && !NO_THIS_COMMIT.test(un.title + un.body) && !/checked that the console's source paths/.test(un.body) && /can report success while shipping a stale image/.test(un.body), un.body);
		}
	}

	// A run cancelled after a green deploy: the smoke never went red.
	for (const smokeResult of ["cancelled", "skipped"]) {
		const inc = composeReport({ ...base, deployResult: "success", smokeResult, appsBuild: "true", failingJobs: [] });
		ok(`deploy success + smoke ${smokeResult} is DEPLOYED_UNFINISHED, not "the smoke is red"`, inc.kind === "deployed-unfinished" && inc.title === TITLE_DEPLOYED_UNFINISHED && !/red|smoke/.test(inc.title), inc.title);
		ok("...and names the result and says it tells nothing about the release", inc.body.includes(`\`smoke: ${smokeResult}\``) && /NOT a red smoke/.test(inc.body) && !/is wrong/.test(inc.body), inc.body);
	}
	const passed = composeReport({ ...base, deployResult: "success", smokeResult: "success", appsBuild: "true", failingJobs: [] });
	ok("deploy success + smoke SUCCESS (cancelled afterwards) says the smoke PASSED", passed.kind === "deployed-unfinished" && /smoke PASSED/.test(passed.body) && !/did not finish|NOT a red smoke/.test(passed.body), passed.body);
	const incRetag = composeReport({ ...base, deployResult: "success", smokeResult: "cancelled", appsBuild: "false", consoleEquivalence: "", failingJobs: [] });
	ok("DEPLOYED_UNFINISHED on a retag makes no \"IS running this commit\" claim either", !NO_THIS_COMMIT.test(incRetag.body) && /RETAGGED/.test(incRetag.body));
	const noAnn = composeReport({ ...base, deployResult: "success", smokeResult: "failure", appsBuild: "true", failingJobs: [] });
	ok("a red smoke with no annotations says so", /emitted no error annotations/.test(noAnn.body));

	const skipped = composeReport({ ...base, deployResult: "skipped", smokeResult: "skipped", failingJobs: [{ name: "build-amd64", conclusion: "failure", errors: [] }] });
	ok("deploy skipped is NOT_DEPLOYED with today's title", skipped.kind === "not-deployed" && skipped.title === TITLE_NOT_DEPLOYED);
	ok("...and says production did NOT receive the commit", /production did NOT receive this commit/.test(skipped.body));
	ok("...and closes on `deploy: success` with the stale-image caveat", /reaches `deploy: success`/.test(skipped.body) && /retag-unchanged/.test(skipped.body));

	for (const r of ["failure", "cancelled"]) {
		const ran = composeReport({ ...base, deployResult: r, smokeResult: "skipped", failingJobs: [] });
		ok(`deploy ${r} is NOT_DEPLOYED`, ran.kind === "not-deployed" && ran.title === TITLE_NOT_DEPLOYED);
		ok(`...and does not claim production is untouched (deploy can fail after compose up)`, !/did NOT receive/.test(ran.body) && ran.body.includes(`ended \`${r}\``), ran.body);
	}
	const titles = [TITLE_NOT_DEPLOYED, TITLE_SMOKE, TITLE_DEPLOYED_UNFINISHED];
	ok("the three kinds have different titles", new Set(titles).size === 3);
	ok("no title contains another (the search is a phrase match)", titles.every((t) => titles.every((u) => t === u || !t.includes(u))));

	let threw = false;
	try {
		composeReport({ ...base, deployResult: "", smokeResult: "failure", failingJobs: [] });
	} catch {
		threw = true;
	}
	ok("an empty needs.deploy.result is refused, not guessed at", threw);

	// ── the dedupe, per title ─────────────────────────────────────────────────────────────────────
	const dir = mkdtempSync(join(tmpdir(), "deploy-failure-selftest-"));
	/** A fake `gh` whose open issues are `open`; records every call. */
	const fakeGh = (open) => {
		const calls = [];
		const gh = (args) => {
			calls.push(args);
			if (args[0] === "issue" && args[1] === "list") return JSON.stringify(open);
			return "";
		};
		return { gh, calls };
	};
	const notDeployedIssue = { number: 11, title: TITLE_NOT_DEPLOYED };
	const smokeIssue = { number: 22, title: TITLE_SMOKE };

	// A loose search can return the other kind's issue; the exact-title filter must reject it.
	let f = fakeGh([notDeployedIssue]);
	let r = fileReport(f.gh, "o/r", smoke, join(dir, "a.md"));
	ok("a smoke report does NOT comment on an open not-deployed issue", r.action === "create", JSON.stringify(f.calls));
	ok("...it creates its own, under the smoke title", f.calls.some((c) => c[1] === "create" && c.includes(TITLE_SMOKE)));

	f = fakeGh([smokeIssue]);
	r = fileReport(f.gh, "o/r", skipped, join(dir, "b.md"));
	ok("a not-deployed report does NOT comment on an open smoke issue", r.action === "create", JSON.stringify(f.calls));

	f = fakeGh([notDeployedIssue, smokeIssue]);
	r = fileReport(f.gh, "o/r", smoke, join(dir, "c.md"));
	ok("a smoke report comments on the open smoke issue", r.action === "comment" && r.issue === 22);
	r = fileReport(f.gh, "o/r", skipped, join(dir, "d.md"));
	ok("a not-deployed report comments on the open not-deployed issue", r.action === "comment" && r.issue === 11);
	ok("the body written for --body-file is the report body", readFileSync(join(dir, "d.md"), "utf8") === skipped.body);

	// ── job enumeration ───────────────────────────────────────────────────────────────────────────
	const jobsGh = (args) => {
		if (args[0] === "api" && args[1].includes("/jobs")) return `${JSON.stringify({ id: 7, name: smokeJob.name, conclusion: "failure" })}\n`;
		if (args[0] === "api" && args[1].endsWith("/7/annotations")) {
			return JSON.stringify([
				{ annotation_level: "failure", message: "Process completed with exit code 1." },
				{ annotation_level: "failure", message: smokeJob.errors[0] },
				{ annotation_level: "notice", message: "runner image migrating" },
			]);
		}
		throw new Error("unexpected");
	};
	const jobs = failingJobs(jobsGh, "o/r", "1");
	ok("failing jobs carry their error annotations, minus the exit-code line and notices", jobs.length === 1 && jobs[0].errors.length === 1 && jobs[0].errors[0] === smokeJob.errors[0], JSON.stringify(jobs));
	ok("an unreadable job listing is an empty list, which the body names", failingJobs(() => { throw new Error("x"); }, "o/r", "1").length === 0 && /could not enumerate/.test(composeReport({ ...base, deployResult: "skipped", smokeResult: "skipped", failingJobs: [] }).body));

	// ── the workflow wiring ───────────────────────────────────────────────────────────────────────
	const live = readFileSync(join(ROOT, WORKFLOW), "utf8");
	const problems = wiringProblems(live);
	ok(`${WORKFLOW} wires report-failure to this script with both results`, problems.length === 0, problems.join("\n       "));
	// Mutation controls: the wiring check must go red on each way the wiring can break.
	ok("control: dropping `smoke` from needs is caught", wiringProblems(live.replace(/retag-unchanged, deploy, smoke\]/, "retag-unchanged, deploy]")).some((p) => /directly need `smoke`/.test(p)));
	ok("control: dropping CONSOLE_EQUIVALENCE is caught", wiringProblems(live.replace("CONSOLE_EQUIVALENCE: ${{ needs.retag-unchanged.outputs.console_equivalence }}", "")).some((p) => /CONSOLE_EQUIVALENCE/.test(p)));
	ok("control: pointing deploy's APPS_BUILT at another output is caught", wiringProblems(live.replace("      APPS_BUILT: ${{ needs.changes.outputs.apps_build }}", "      APPS_BUILT: ${{ needs.changes.outputs.apps }}")).some((p) => /APPS_BUILT/.test(p)));
	ok("control: dropping retag-unchanged's console_equivalence output is caught", wiringProblems(live.replace("      console_equivalence: ${{ steps.retag.outputs.console_equivalence }}", "")).some((p) => /console_equivalence/.test(p)));
	ok("control: dropping APPS_BUILD is caught", wiringProblems(live.replace("APPS_BUILD: ${{ needs.changes.outputs.apps_build }}", "")).some((p) => /APPS_BUILD/.test(p)));
	ok("control: dropping DEPLOY_RESULT is caught", wiringProblems(live.replace("DEPLOY_RESULT: ${{ needs.deploy.result }}", "")).some((p) => /DEPLOY_RESULT/.test(p)));
	ok("control: an `always()` condition is caught", wiringProblems(live.replace("(failure() || cancelled()) && github.ref == 'refs/heads/main'", "always() && github.ref == 'refs/heads/main'")).some((p) => /`if:`/.test(p)));
	ok("control: a missing job is caught", wiringProblems("jobs:\n  deploy:\n").length === 1);

	if (failed > 0) {
		console.error(`\nself-test: ${failed} check(s) failed`);
		process.exit(1);
	}
	console.log("\nself-test: all checks passed");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	if (process.argv.includes("--self-test")) selfTest();
	else live();
}
