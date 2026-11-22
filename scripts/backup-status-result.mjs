#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
//
// The durable interface between .github/workflows/backup-status.yml and PROGRAMME.md (BKP-L2,
// #7244; beta predicate B7, "off-box backup").
//
// The workflow assumes the read-only `backup-reader` role in the backup account and runs
// `deploy/prod/backup/backup.sh status`, which prints ONE JSON line and exits 0 (fresh), 1 (older
// than its threshold) or 2 (the store could not be read). This file turns that line, plus what the
// workflow knows about its own run, into one allowlisted result. The result is the only thing the
// run publishes: an artifact `backup-status-result-<run id>` holding exactly `backup-status.json`,
// which scripts/programme-fetch.sh copies into docs/testing/programme-snapshot.json, where
// scripts/programme-rollup.mjs judges it against the snapshot instant.
//
//   node scripts/backup-status-result.mjs compose --out <path>     (inputs from the environment)
//   node scripts/backup-status-result.mjs validate --file <path>   (prints the normalised result)
//   node scripts/backup-status-result.mjs --self-test
//
// FOUR VERDICTS, AND WHY "not-configured" IS ITS OWN. `pass` and `fail` are measurements.
// `not-measured` is a run that should have measured and could not (the role did not assume, the
// store did not answer, the script printed nothing readable). `not-configured` is a run that was
// never able to try, because the repository variables naming the role and the bucket are unset.
// Folding that into `not-measured` would keep a red alarm up for as long as the stack is unapplied,
// and folding it into `pass` would be a monitor that reports health about nothing. It is reported
// as what it is, and PROGRAMME.md renders it `? not measured` with that reason.
//
// WHAT NEVER ENTERS A RESULT. The bucket name (it carries the backup account's id), the role ARN,
// any credential, and backup.sh's stderr (an S3 error can quote the caller's ARN). Unknown keys are
// refused on validation, so nothing can be added to the artifact without changing this file.

import fs from "node:fs";
import { pathToFileURL } from "node:url";

export const BACKUP_STATUS_SCHEMA_VERSION = 1;
export const BACKUP_STATUS_CHECK = "off-box-backup";
export const BACKUP_STATUS_ARTIFACT_PREFIX = "backup-status-result-";
export const BACKUP_STATUS_FILE = "backup-status.json";
export const BACKUP_STATUS_VERDICTS = ["pass", "fail", "not-measured", "not-configured"];

/** backup.sh status's exit code for each verdict it can print (backup.sh cmd_status). */
const EXIT_FOR_VERDICT = { pass: 0, fail: 1, "not-measured": 2 };

const RESULT_KEYS = [
	"schemaVersion",
	"check",
	"verdict",
	"reason",
	"newest",
	"finishedAt",
	"ageSeconds",
	"maxAgeHours",
	"tombstonesExportedAt",
	"checkedAt",
	"runId",
	"event",
];

const STAMP_RE = /^[0-9]{8}T[0-9]{6}Z$/; // lib.sh BACKUP_STAMP_RE
const INSTANT_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/;
const RUN_ID_RE = /^[0-9]{1,20}$/;
const EVENTS = ["schedule", "workflow_dispatch"];
const REASON_MAX = 300;

/** Is this an RFC 3339 UTC instant that Date can actually read? */
function isInstant(value) {
	return typeof value === "string" && INSTANT_RE.test(value) && !Number.isNaN(Date.parse(value));
}

/**
 * Reads backup.sh status's stdout. Returns the parsed line, or a reason it is not one: exactly one
 * non-empty line, a JSON object, `check: off-box-backup`, and a verdict backup.sh can print.
 */
export function parseStatusLine(text) {
	const lines = String(text ?? "").split("\n").map((l) => l.trim()).filter((l) => l !== "");
	if (lines.length !== 1) return { ok: false, reason: `backup.sh status printed ${lines.length} lines, not one` };
	let value;
	try {
		value = JSON.parse(lines[0]);
	} catch {
		return { ok: false, reason: "backup.sh status printed a line that is not JSON" };
	}
	if (value === null || typeof value !== "object" || Array.isArray(value)) return { ok: false, reason: "backup.sh status printed JSON that is not an object" };
	if (value.check !== BACKUP_STATUS_CHECK) return { ok: false, reason: `backup.sh status printed check ${JSON.stringify(value.check)}, not ${BACKUP_STATUS_CHECK}` };
	if (typeof value.verdict !== "string" || !Object.hasOwn(EXIT_FOR_VERDICT, value.verdict)) return { ok: false, reason: `backup.sh status printed verdict ${JSON.stringify(value.verdict)}` };
	return { ok: true, value };
}

/** Clamps a free-text reason to one short line, so the artifact cannot carry a log. */
function reasonText(text) {
	const one = String(text).replace(/\s+/g, " ").trim();
	return one.length > REASON_MAX ? `${one.slice(0, REASON_MAX - 1)}…` : one;
}

/**
 * Builds the published result from what the workflow observed. Pure: the clock and the run's
 * identity are inputs.
 *
 * @param {{
 *   missing: string[],          repository variables that are unset (empty = configured)
 *   ref: string,                github.ref
 *   assumed: string,            the configure-aws-credentials step's outcome ('' when skipped)
 *   statusText: string|null,    backup.sh status stdout (null when it did not run)
 *   exitCode: number|null,      backup.sh status exit code (null when it did not run)
 *   checkedAt: string,          when the check ran, RFC 3339 UTC
 *   runId: string,
 *   event: string,
 * }} input
 */
export function composeBackupStatus({ missing, ref, assumed, statusText, exitCode, checkedAt, runId, event }) {
	const base = {
		schemaVersion: BACKUP_STATUS_SCHEMA_VERSION,
		check: BACKUP_STATUS_CHECK,
		verdict: "not-measured",
		reason: null,
		newest: null,
		finishedAt: null,
		ageSeconds: null,
		maxAgeHours: null,
		tombstonesExportedAt: null,
		checkedAt,
		runId: String(runId),
		event,
	};
	const nothing = (verdict, reason) => ({ ...base, verdict, reason: reasonText(reason) });

	if (missing.length > 0) {
		return nothing("not-configured", `repository variable(s) ${missing.join(", ")} not set; the monitor has nothing to read (infra/backup-account outputs reader_role_arn and bucket_name)`);
	}
	if (ref !== "refs/heads/main") return nothing("not-measured", `ran from ${ref}; backup-reader trusts runs from main only`);
	if (assumed !== "success") return nothing("not-measured", "could not assume backup-reader over GitHub OIDC");
	if (statusText === null || exitCode === null) return nothing("not-measured", "backup.sh status did not run");

	const parsed = parseStatusLine(statusText);
	if (!parsed.ok) return nothing("not-measured", `${parsed.reason} (exit ${exitCode})`);
	const s = parsed.value;
	// The exit code and the printed verdict are two reports of one decision. When they disagree the
	// script died somewhere neither describes — `die` exits 1, the same code as "stale" — so neither
	// is believed.
	if (EXIT_FOR_VERDICT[s.verdict] !== exitCode) {
		return nothing("not-measured", `backup.sh status exited ${exitCode} but printed verdict ${s.verdict}`);
	}
	if (s.verdict === "not-measured") {
		return { ...nothing("not-measured", typeof s.reason === "string" ? s.reason : "backup.sh status could not read the store"), newest: STAMP_RE.test(String(s.newest ?? "")) ? s.newest : null };
	}

	// pass or fail: every field the rollup will judge must be well-formed, or nothing was measured.
	if (!STAMP_RE.test(String(s.newest ?? ""))) return nothing("not-measured", "backup.sh status named no valid stamp");
	if (!isInstant(s.finishedAt)) return nothing("not-measured", "backup.sh status printed an unreadable finishedAt");
	if (!Number.isInteger(s.ageSeconds) || s.ageSeconds < 0) return nothing("not-measured", "backup.sh status printed an age that is not a non-negative number of seconds (a copy finished in the future?)");
	if (!Number.isInteger(s.maxAgeHours) || s.maxAgeHours <= 0) return nothing("not-measured", "backup.sh status printed no threshold");
	return {
		...base,
		verdict: s.verdict,
		newest: s.newest,
		finishedAt: s.finishedAt,
		ageSeconds: s.ageSeconds,
		maxAgeHours: s.maxAgeHours,
		tombstonesExportedAt: isInstant(s.tombstonesExportedAt) ? s.tombstonesExportedAt : null,
	};
}

/**
 * Validates a published result. Strict: unknown keys are refused, so nothing reaches the snapshot
 * that this file did not decide to publish.
 *
 * @returns {{ok: true, value: object} | {ok: false, errors: string[]}}
 */
export function validateBackupStatus(value) {
	const errors = [];
	if (value === null || typeof value !== "object" || Array.isArray(value)) return { ok: false, errors: ["not an object"] };
	for (const k of Object.keys(value)) if (!RESULT_KEYS.includes(k)) errors.push(`unknown key ${k}`);
	for (const k of RESULT_KEYS) if (!(k in value)) errors.push(`missing key ${k}`);
	if (value.schemaVersion !== BACKUP_STATUS_SCHEMA_VERSION) errors.push(`schemaVersion is not ${BACKUP_STATUS_SCHEMA_VERSION}`);
	if (value.check !== BACKUP_STATUS_CHECK) errors.push(`check is not ${BACKUP_STATUS_CHECK}`);
	if (!BACKUP_STATUS_VERDICTS.includes(value.verdict)) errors.push("verdict is not one of " + BACKUP_STATUS_VERDICTS.join(", "));
	if (!isInstant(value.checkedAt)) errors.push("checkedAt is not an RFC 3339 UTC instant");
	if (typeof value.runId !== "string" || !RUN_ID_RE.test(value.runId)) errors.push("runId is not a run id");
	if (!EVENTS.includes(value.event)) errors.push(`event is not one of ${EVENTS.join(", ")}`);
	const measured = value.verdict === "pass" || value.verdict === "fail";
	if (measured) {
		if (value.reason !== null) errors.push("a measured result carries no reason");
		if (typeof value.newest !== "string" || !STAMP_RE.test(value.newest)) errors.push("newest is not a backup stamp");
		if (!isInstant(value.finishedAt)) errors.push("finishedAt is not an RFC 3339 UTC instant");
		if (!Number.isInteger(value.ageSeconds) || value.ageSeconds < 0) errors.push("ageSeconds is not a non-negative integer");
		if (!Number.isInteger(value.maxAgeHours) || value.maxAgeHours <= 0) errors.push("maxAgeHours is not a positive integer");
		if (value.tombstonesExportedAt !== null && !isInstant(value.tombstonesExportedAt)) errors.push("tombstonesExportedAt is neither null nor an instant");
	} else {
		if (typeof value.reason !== "string" || value.reason === "" || value.reason.length > REASON_MAX) errors.push(`an unmeasured result carries a reason of 1–${REASON_MAX} characters`);
		if (value.newest !== null && (typeof value.newest !== "string" || !STAMP_RE.test(value.newest))) errors.push("newest is neither null nor a backup stamp");
		for (const k of ["finishedAt", "ageSeconds", "maxAgeHours", "tombstonesExportedAt"]) if (value[k] !== null) errors.push(`an unmeasured result has no ${k}`);
	}
	return errors.length === 0 ? { ok: true, value } : { ok: false, errors };
}

/** Reads `--name value` from an argument list. */
function flag(args, name) {
	const i = args.indexOf(name);
	return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
}

/** `compose`: reads the workflow's observations from the environment and writes the result. */
function composeFromEnv(args, env) {
	const out = flag(args, "--out");
	if (!out) throw new Error("compose needs --out <path>");
	const statusFile = env.STATUS_FILE ?? "";
	const ran = env.STATUS_RC !== undefined && env.STATUS_RC !== "" && statusFile !== "" && fs.existsSync(statusFile);
	const result = composeBackupStatus({
		missing: (env.MISSING ?? "").split(/[\s,]+/).filter((m) => m !== ""),
		ref: env.GITHUB_REF ?? "",
		assumed: env.ASSUMED ?? "",
		statusText: ran ? fs.readFileSync(statusFile, "utf8") : null,
		exitCode: ran ? Number(env.STATUS_RC) : null,
		checkedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
		runId: env.GITHUB_RUN_ID ?? "",
		event: env.GITHUB_EVENT_NAME ?? "",
	});
	const v = validateBackupStatus(result);
	if (!v.ok) throw new Error(`composed result does not validate: ${v.errors.join("; ")}`);
	fs.writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
	process.stdout.write(`${result.verdict}\n`);
}

/** `validate`: prints the normalised result, or fails naming every problem. */
function validateFile(args) {
	const file = flag(args, "--file");
	if (!file) throw new Error("validate needs --file <path>");
	let value;
	try {
		value = JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		throw new Error(`${file} is not readable JSON`);
	}
	const v = validateBackupStatus(value);
	if (!v.ok) throw new Error(v.errors.join("; "));
	process.stdout.write(`${JSON.stringify(v.value)}\n`);
}

/** Hermetic checks of compose and validate. Throws when any assertion fails. */
export function runSelfTest({ quiet = false } = {}) {
	let failures = 0;
	const ok = (name, cond, detail = "") => {
		if (!cond) {
			failures += 1;
			console.error(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
		} else if (!quiet) console.log(`ok   ${name}`);
	};
	const input = (over = {}) => ({ missing: [], ref: "refs/heads/main", assumed: "success", statusText: null, exitCode: null, checkedAt: "2026-12-02T06:23:00Z", runId: "123", event: "schedule", ...over });
	const line = (o) => JSON.stringify({ check: "off-box-backup", ...o });
	const fresh = line({ verdict: "pass", newest: "20261202T023000Z", finishedAt: "2026-12-02T02:41:07Z", ageSeconds: 13_313, maxAgeHours: 26, tombstonesExportedAt: "2026-12-02T06:00:01Z" });
	const stale = line({ verdict: "fail", newest: "20261129T023000Z", finishedAt: "2026-11-29T02:41:07Z", ageSeconds: 272_513, maxAgeHours: 26, tombstonesExportedAt: "" });

	const unset = composeBackupStatus(input({ missing: ["BACKUP_READER_ROLE_ARN", "BACKUP_S3_BUCKET"] }));
	ok("unset variables are not-configured, not a failure and not a pass", unset.verdict === "not-configured" && /BACKUP_READER_ROLE_ARN, BACKUP_S3_BUCKET/.test(unset.reason), unset.reason);
	ok("...and that result validates", validateBackupStatus(unset).ok);
	ok("a run from another branch measured nothing", composeBackupStatus(input({ ref: "refs/heads/dev" })).verdict === "not-measured");
	ok("a role that did not assume measured nothing", composeBackupStatus(input({ assumed: "failure" })).verdict === "not-measured");
	ok("a status step that never ran measured nothing", composeBackupStatus(input()).verdict === "not-measured");

	const pass = composeBackupStatus(input({ statusText: `${fresh}\n`, exitCode: 0 }));
	ok("a fresh copy with exit 0 is a pass carrying its fields", pass.verdict === "pass" && pass.newest === "20261202T023000Z" && pass.ageSeconds === 13_313 && pass.maxAgeHours === 26 && pass.reason === null, JSON.stringify(pass));
	ok("...and validates", validateBackupStatus(pass).ok, JSON.stringify(validateBackupStatus(pass)));
	const fail = composeBackupStatus(input({ statusText: stale, exitCode: 1 }));
	ok("a stale copy with exit 1 is a fail", fail.verdict === "fail" && fail.tombstonesExportedAt === null && validateBackupStatus(fail).ok);
	ok("exit 1 with a pass line (die, not stale) measured nothing", composeBackupStatus(input({ statusText: fresh, exitCode: 1 })).verdict === "not-measured");
	ok("exit 0 with a fail line measured nothing", composeBackupStatus(input({ statusText: stale, exitCode: 0 })).verdict === "not-measured");
	ok("exit 1 with no output (a die before printing) measured nothing", composeBackupStatus(input({ statusText: "", exitCode: 1 })).verdict === "not-measured");
	ok("two lines measured nothing", composeBackupStatus(input({ statusText: `${fresh}\n${fresh}`, exitCode: 0 })).verdict === "not-measured");
	ok("a non-JSON line measured nothing", composeBackupStatus(input({ statusText: "error: bucket", exitCode: 0 })).verdict === "not-measured");
	ok("another check's line measured nothing", composeBackupStatus(input({ statusText: JSON.stringify({ check: "x", verdict: "pass" }), exitCode: 0 })).verdict === "not-measured");
	const unreadable = composeBackupStatus(input({ statusText: line({ verdict: "not-measured", reason: "latest.json could not be read" }), exitCode: 2 }));
	ok("the store being unreadable is not-measured with backup.sh's reason", unreadable.verdict === "not-measured" && unreadable.reason === "latest.json could not be read" && validateBackupStatus(unreadable).ok, JSON.stringify(unreadable));
	ok("a pass with a negative age measured nothing", composeBackupStatus(input({ statusText: line({ verdict: "pass", newest: "20261202T023000Z", finishedAt: "2026-12-02T02:41:07Z", ageSeconds: -5, maxAgeHours: 26 }), exitCode: 0 })).verdict === "not-measured");
	ok("a pass with a bad stamp measured nothing", composeBackupStatus(input({ statusText: line({ verdict: "pass", newest: "../x", finishedAt: "2026-12-02T02:41:07Z", ageSeconds: 5, maxAgeHours: 26 }), exitCode: 0 })).verdict === "not-measured");
	ok("a long reason is clamped to one short line", composeBackupStatus(input({ statusText: line({ verdict: "not-measured", reason: `a\n${"b".repeat(1000)}` }), exitCode: 2 })).reason.length <= REASON_MAX);

	ok("validate refuses an unknown key (nothing rides along)", !validateBackupStatus({ ...pass, bucket: "x" }).ok);
	ok("validate refuses a missing key", !validateBackupStatus(Object.fromEntries(Object.entries(pass).filter(([k]) => k !== "newest"))).ok);
	ok("validate refuses a pass with a reason", !validateBackupStatus({ ...pass, reason: "x" }).ok);
	ok("validate refuses an unmeasured result without a reason", !validateBackupStatus({ ...unset, reason: "" }).ok);
	ok("validate refuses an unmeasured result carrying an age", !validateBackupStatus({ ...unset, ageSeconds: 5 }).ok);
	ok("validate refuses an unknown verdict", !validateBackupStatus({ ...pass, verdict: "ok" }).ok);
	ok("validate refuses a push-triggered run", !validateBackupStatus({ ...pass, event: "push" }).ok);
	ok("validate refuses a non-numeric run id", !validateBackupStatus({ ...pass, runId: "abc" }).ok);

	if (failures > 0) throw new Error(`${failures} self-test check(s) failed`);
	if (!quiet) console.log("self-test: all passed");
}

/** Dispatches the small command-line interface. */
function main(args = process.argv.slice(2), env = process.env) {
	if (args.includes("--self-test")) return runSelfTest();
	if (args[0] === "compose") return composeFromEnv(args.slice(1), env);
	if (args[0] === "validate") return validateFile(args.slice(1));
	throw new Error("usage: backup-status-result.mjs compose --out <path> | validate --file <path> | --self-test");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	try {
		main();
	} catch (error) {
		console.error(`backup-status-result: ${error instanceof Error ? error.message : String(error)}`);
		process.exit(1);
	}
}
