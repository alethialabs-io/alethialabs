#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
//
// The durable interface between the post-deploy smoke and PROGRAMME.md (#7392; beta predicate B7,
// "public hosts").
//
// The `smoke` job in .github/workflows/deploy-console.yml runs apps/console/scripts/e2e/post-deploy-smoke.ts
// against production and uploads `apps/console/smoke-results/` as the artifact `post-deploy-smoke`:
// `smoke-report.json`, plus one screenshot per failed check. scripts/programme-fetch.sh takes the
// newest such report from a run on `main`, passes it through `summarize` here, and copies the
// SUMMARY — never the raw report — into docs/testing/programme-snapshot.json, where
// scripts/programme-rollup.mjs judges it against the snapshot instant.
//
//   node scripts/post-deploy-smoke-result.mjs summarize --file <smoke-report.json>   (prints the summary)
//   node scripts/post-deploy-smoke-result.mjs validate --file <summary.json>         (prints it normalised)
//   node scripts/post-deploy-smoke-result.mjs --self-test
//
// WHY A SUMMARY, NOT THE REPORT. The raw report carries each check's failure and note text, which
// quotes response bodies from the public hosts. None of that is a verdict, and a snapshot that is
// committed nightly is not the place for it. The summary keeps the identity of the run (sha, ref,
// runId), when it ran, how many checks the manifest held and how many ran, and the IDS of the checks
// that failed. Unknown keys are refused on both sides, so a field cannot start riding into the
// snapshot without changing this file — and a smoke report whose shape drifted is refused rather
// than half-read.
//
// WHAT "pass" MEANS HERE. Every check in the manifest ran (an aborted run — the positive controls
// failing — writes a report with fewer results than checks, and that is not a pass), none failed, and
// the two public-host checks docs/beta/README.md names (the installer host and the status host) are
// among them. A report that ran but does not meet that is `fail`; one that cannot be read is refused.

import fs from "node:fs";
import { pathToFileURL } from "node:url";

export const SMOKE_SUMMARY_SCHEMA_VERSION = 1;
export const SMOKE_CHECK = "post-deploy-smoke";
export const SMOKE_ARTIFACT = "post-deploy-smoke";
export const SMOKE_REPORT_FILE = "smoke-report.json";
/** The check ids (post-deploy-smoke.ts CHECKS) that ARE B7's "public hosts" part. */
export const SMOKE_HOST_CHECKS = ["installer", "status-page"];

const REPORT_KEYS = ["baseUrl", "at", "sha", "ref", "runId", "checks", "results"];
const RESULT_ENTRY_KEYS = ["id", "name", "failures", "notes"];
const SUMMARY_KEYS = ["schemaVersion", "check", "verdict", "baseUrl", "at", "sha", "ref", "runId", "checks", "ran", "failed", "missingHostChecks"];

const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SHA_RE = /^[0-9a-f]{40}$/;
const RUN_ID_RE = /^[0-9]{1,20}$/;
// Date#toISOString's shape, which is what the smoke writes; the seconds-only form is accepted too.
const INSTANT_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{3})?Z$/;
const REF_MAX = 200;
const URL_MAX = 200;
const MAX_CHECKS = 200;

/** Is this an RFC 3339 UTC instant that Date can actually read? */
function isInstant(value) {
	return typeof value === "string" && INSTANT_RE.test(value) && !Number.isNaN(Date.parse(value));
}

/** Is this a short https URL? The smoke refuses any other scheme (requireHttps). */
function isHttpsUrl(value) {
	if (typeof value !== "string" || value.length > URL_MAX) return false;
	try {
		return new URL(value).protocol === "https:";
	} catch {
		return false;
	}
}

/** Is this a list of strings? */
function isStringList(value) {
	return Array.isArray(value) && value.every((v) => typeof v === "string");
}

/**
 * Reduces a raw smoke-report.json to the published summary. Strict about the report's shape: a key
 * it does not know, or a field of the wrong type, refuses the whole report.
 *
 * @returns {{ok: true, value: object} | {ok: false, errors: string[]}}
 */
export function summarizeSmokeReport(report) {
	const errors = [];
	if (report === null || typeof report !== "object" || Array.isArray(report)) return { ok: false, errors: ["the report is not an object"] };
	for (const k of Object.keys(report)) if (!REPORT_KEYS.includes(k)) errors.push(`the report has an unknown key ${k}`);
	for (const k of REPORT_KEYS) if (!(k in report)) errors.push(`the report has no ${k}`);
	if (!isHttpsUrl(report.baseUrl)) errors.push("baseUrl is not an https URL");
	if (!isInstant(report.at)) errors.push("at is not an RFC 3339 UTC instant");
	// sha, ref and runId are null outside Actions. A report that cannot be tied to a run is not
	// evidence about a deploy, so the summary requires all three.
	if (typeof report.sha !== "string" || !SHA_RE.test(report.sha)) errors.push("sha is not a commit sha (a report written outside Actions is not about a deploy)");
	if (typeof report.ref !== "string" || report.ref === "" || report.ref.length > REF_MAX) errors.push("ref is not a git ref");
	if (typeof report.runId !== "string" || !RUN_ID_RE.test(report.runId)) errors.push("runId is not a run id");
	if (!Number.isInteger(report.checks) || report.checks <= 0 || report.checks > MAX_CHECKS) errors.push(`checks is not an integer from 1 to ${MAX_CHECKS}`);
	if (!Array.isArray(report.results)) errors.push("results is not a list");
	else {
		if (Number.isInteger(report.checks) && report.results.length > report.checks) errors.push("more results than checks");
		report.results.forEach((r, i) => {
			if (r === null || typeof r !== "object" || Array.isArray(r)) return errors.push(`results[${i}] is not an object`);
			for (const k of Object.keys(r)) if (!RESULT_ENTRY_KEYS.includes(k)) errors.push(`results[${i}] has an unknown key ${k}`);
			if (typeof r.id !== "string" || !ID_RE.test(r.id)) errors.push(`results[${i}].id is not a check id`);
			if (typeof r.name !== "string") errors.push(`results[${i}].name is not a string`);
			if (!isStringList(r.failures)) errors.push(`results[${i}].failures is not a list of strings`);
			if (!isStringList(r.notes)) errors.push(`results[${i}].notes is not a list of strings`);
		});
		const ids = report.results.map((r) => r?.id);
		if (new Set(ids).size !== ids.length) errors.push("results name one check twice");
	}
	if (errors.length > 0) return { ok: false, errors };

	const failed = report.results.filter((r) => r.failures.length > 0).map((r) => r.id);
	const passedIds = new Set(report.results.filter((r) => r.failures.length === 0).map((r) => r.id));
	// A host check that failed is already in `failed`; this lists the ones that did not RUN, which is
	// what an aborted run or a manifest that lost them looks like.
	const ranIds = new Set(report.results.map((r) => r.id));
	const missingHostChecks = SMOKE_HOST_CHECKS.filter((id) => !ranIds.has(id));
	const ran = report.results.length;
	const pass = ran === report.checks && failed.length === 0 && SMOKE_HOST_CHECKS.every((id) => passedIds.has(id));
	return {
		ok: true,
		value: {
			schemaVersion: SMOKE_SUMMARY_SCHEMA_VERSION,
			check: SMOKE_CHECK,
			verdict: pass ? "pass" : "fail",
			baseUrl: report.baseUrl,
			at: report.at,
			sha: report.sha,
			ref: report.ref,
			runId: report.runId,
			checks: report.checks,
			ran,
			failed,
			missingHostChecks,
		},
	};
}

/**
 * Validates a published summary — what the snapshot holds. Strict, and it re-derives the verdict
 * from the counts, so a summary edited to say `pass` over a failed check is refused.
 *
 * @returns {{ok: true, value: object} | {ok: false, errors: string[]}}
 */
export function validateSmokeSummary(value) {
	const errors = [];
	if (value === null || typeof value !== "object" || Array.isArray(value)) return { ok: false, errors: ["not an object"] };
	for (const k of Object.keys(value)) if (!SUMMARY_KEYS.includes(k)) errors.push(`unknown key ${k}`);
	for (const k of SUMMARY_KEYS) if (!(k in value)) errors.push(`missing key ${k}`);
	if (value.schemaVersion !== SMOKE_SUMMARY_SCHEMA_VERSION) errors.push(`schemaVersion is not ${SMOKE_SUMMARY_SCHEMA_VERSION}`);
	if (value.check !== SMOKE_CHECK) errors.push(`check is not ${SMOKE_CHECK}`);
	if (value.verdict !== "pass" && value.verdict !== "fail") errors.push("verdict is neither pass nor fail");
	if (!isHttpsUrl(value.baseUrl)) errors.push("baseUrl is not an https URL");
	if (!isInstant(value.at)) errors.push("at is not an RFC 3339 UTC instant");
	if (typeof value.sha !== "string" || !SHA_RE.test(value.sha)) errors.push("sha is not a commit sha");
	if (typeof value.ref !== "string" || value.ref === "" || value.ref.length > REF_MAX) errors.push("ref is not a git ref");
	if (typeof value.runId !== "string" || !RUN_ID_RE.test(value.runId)) errors.push("runId is not a run id");
	if (!Number.isInteger(value.checks) || value.checks <= 0 || value.checks > MAX_CHECKS) errors.push(`checks is not an integer from 1 to ${MAX_CHECKS}`);
	if (!Number.isInteger(value.ran) || value.ran < 0 || (Number.isInteger(value.checks) && value.ran > value.checks)) errors.push("ran is not an integer from 0 to checks");
	const idList = (v) => Array.isArray(v) && v.every((id) => typeof id === "string" && ID_RE.test(id)) && new Set(v).size === v.length;
	if (!idList(value.failed) || (Number.isInteger(value.ran) && value.failed.length > value.ran)) errors.push("failed is not a list of distinct check ids no longer than ran");
	if (!idList(value.missingHostChecks) || !value.missingHostChecks.every((id) => SMOKE_HOST_CHECKS.includes(id))) errors.push(`missingHostChecks is not a subset of ${SMOKE_HOST_CHECKS.join(", ")}`);
	if (errors.length === 0) {
		const pass = value.ran === value.checks && value.failed.length === 0 && value.missingHostChecks.length === 0;
		if ((value.verdict === "pass") !== pass) errors.push(`verdict ${value.verdict} disagrees with ran ${value.ran}/${value.checks}, ${value.failed.length} failed, ${value.missingHostChecks.length} host check(s) missing`);
	}
	return errors.length === 0 ? { ok: true, value } : { ok: false, errors };
}

/** Reads `--name value` from an argument list. */
function flag(args, name) {
	const i = args.indexOf(name);
	return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
}

/** Reads a JSON file, or throws naming it. */
function readJson(file) {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		throw new Error(`${file} is not readable JSON`);
	}
}

/** `summarize` / `validate`: prints the summary, or fails naming every problem. */
function fileCommand(args, fn) {
	const file = flag(args, "--file");
	if (!file) throw new Error("needs --file <path>");
	const r = fn(readJson(file));
	if (!r.ok) throw new Error(r.errors.join("; "));
	process.stdout.write(`${JSON.stringify(r.value)}\n`);
}

/** Hermetic checks of summarize and validate. Throws when any assertion fails. */
export function runSelfTest({ quiet = false } = {}) {
	let failures = 0;
	const ok = (name, cond, detail = "") => {
		if (!cond) {
			failures += 1;
			console.error(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
		} else if (!quiet) console.log(`ok   ${name}`);
	};
	const ids = ["controls", "root", "nav-context", "login", "signup", "docs", "health", "build-id", "marketing-build-id", "signed-out", "installer", "status-page", "self-guard"];
	const entry = (id, failures = []) => ({ id, name: `check ${id}`, failures, notes: ["a note quoting a body"] });
	const report = (over = {}) => ({
		baseUrl: "https://alethialabs.io",
		at: "2026-12-19T10:00:00.123Z",
		sha: "a".repeat(40),
		ref: "refs/heads/main",
		runId: "4242",
		checks: ids.length,
		results: ids.map((id) => entry(id)),
		...over,
	});

	const green = summarizeSmokeReport(report());
	ok("every check passing is a pass", green.ok && green.value.verdict === "pass" && green.value.ran === 13 && green.value.failed.length === 0, JSON.stringify(green));
	ok("...and the summary validates", green.ok && validateSmokeSummary(green.value).ok);
	ok("...and carries no failure or note text", green.ok && !JSON.stringify(green.value).includes("quoting a body"));
	const red = summarizeSmokeReport(report({ results: ids.map((id) => entry(id, id === "installer" ? ["body differs from the tree"] : [])) }));
	ok("a failed host check is a fail naming it", red.ok && red.value.verdict === "fail" && red.value.failed.join() === "installer" && validateSmokeSummary(red.value).ok, JSON.stringify(red));
	ok("...and the failure text is not carried", red.ok && !JSON.stringify(red.value).includes("differs"));
	const aborted = summarizeSmokeReport(report({ results: [entry("controls", ["positive control did not fire"])] }));
	ok("an aborted run (controls failed, one result of 13) is a fail with the host checks missing", aborted.ok && aborted.value.verdict === "fail" && aborted.value.ran === 1 && aborted.value.missingHostChecks.join() === "installer,status-page" && validateSmokeSummary(aborted.value).ok, JSON.stringify(aborted));
	const shrunk = summarizeSmokeReport(report({ checks: 11, results: ids.filter((id) => !SMOKE_HOST_CHECKS.includes(id)).map((id) => entry(id)) }));
	ok("a manifest without the host checks never passes, even with every check green", shrunk.ok && shrunk.value.verdict === "fail" && shrunk.value.missingHostChecks.length === 2, JSON.stringify(shrunk));

	ok("a report written outside Actions (sha null) is refused", !summarizeSmokeReport(report({ sha: null })).ok);
	ok("a report with no runId is refused", !summarizeSmokeReport(report({ runId: null })).ok);
	ok("a report with an unknown top-level key is refused", !summarizeSmokeReport(report({ extra: 1 })).ok);
	ok("a report with an unknown result key is refused", !summarizeSmokeReport(report({ results: [{ ...entry("root"), body: "x" }] })).ok);
	ok("a report with more results than checks is refused", !summarizeSmokeReport(report({ checks: 2 })).ok);
	ok("a report naming one check twice is refused", !summarizeSmokeReport(report({ results: [entry("root"), entry("root")] })).ok);
	ok("an http baseUrl is refused", !summarizeSmokeReport(report({ baseUrl: "http://alethialabs.io" })).ok);
	ok("an unreadable instant is refused", !summarizeSmokeReport(report({ at: "yesterday" })).ok);
	ok("a non-object is refused", !summarizeSmokeReport([]).ok && !summarizeSmokeReport(null).ok);

	const g = green.value;
	ok("validate refuses a pass over a failed check", !validateSmokeSummary({ ...g, failed: ["root"] }).ok);
	ok("validate refuses a pass with checks that did not run", !validateSmokeSummary({ ...g, ran: 12 }).ok);
	ok("validate refuses a pass with a host check missing", !validateSmokeSummary({ ...g, missingHostChecks: ["installer"] }).ok);
	ok("validate refuses a fail over a clean full run", !validateSmokeSummary({ ...g, verdict: "fail" }).ok);
	ok("validate refuses an unknown key (nothing rides along)", !validateSmokeSummary({ ...g, results: [] }).ok);
	ok("validate refuses a missing key", !validateSmokeSummary(Object.fromEntries(Object.entries(g).filter(([k]) => k !== "sha"))).ok);
	ok("validate refuses a host-check id it does not know", !validateSmokeSummary({ ...g, verdict: "fail", missingHostChecks: ["root"] }).ok);
	ok("validate refuses ran above checks", !validateSmokeSummary({ ...g, ran: 14 }).ok);
	ok("validate refuses an unknown verdict", !validateSmokeSummary({ ...g, verdict: "ok" }).ok);

	if (failures > 0) throw new Error(`${failures} self-test check(s) failed`);
	if (!quiet) console.log("self-test: all passed");
}

/** Dispatches the small command-line interface. */
function main(args = process.argv.slice(2)) {
	if (args.includes("--self-test")) return runSelfTest();
	if (args[0] === "summarize") return fileCommand(args.slice(1), summarizeSmokeReport);
	if (args[0] === "validate") return fileCommand(args.slice(1), validateSmokeSummary);
	throw new Error("usage: post-deploy-smoke-result.mjs summarize --file <smoke-report.json> | validate --file <summary.json> | --self-test");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	try {
		main();
	} catch (error) {
		console.error(`post-deploy-smoke-result: ${error instanceof Error ? error.message : String(error)}`);
		process.exit(1);
	}
}
