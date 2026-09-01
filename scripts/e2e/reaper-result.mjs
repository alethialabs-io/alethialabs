#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
//
// The durable, secret-free interface between e2e-orphan-reaper.yml and PROGRAMME.md.
// The workflow may hold five clouds' credentials and its raw log may contain resource names, so
// only this allowlisted summary is publishable. Callers and tests cross the same seam:
//
//   node scripts/e2e/reaper-result.mjs capture --log <path> --out <path>
//   node scripts/e2e/reaper-result.mjs validate --file <path>
//   node scripts/e2e/reaper-result.mjs --self-test

import fs from "node:fs";
import { pathToFileURL } from "node:url";

export const REAPER_RESULT_SCHEMA_VERSION = 1;
export const REAPER_PROVIDERS = ["aws", "gcp", "azure", "alibaba", "hetzner"];

const DEFAULT_REGIONS = {
  aws: "us-east-1",
  gcp: "europe-west3",
  azure: "germanywestcentral",
  alibaba: "eu-central-1",
  hetzner: "nbg1",
};

const RESULT_KEYS = [
  "schema_version",
  "provider",
  "region",
  "run_id",
  "run_attempt",
  "event_name",
  "mode",
  "gate_ran",
  "sweep_exit_code",
  "log_present",
  "orphan_runs_found",
  "resources_reclaimed",
  "residual_detected",
  "unverified_count",
  "unattributable_count",
];

/** Count lines matching one expression without retaining any source text. */
function countLines(text, expression) {
  return text.split("\n").filter((line) => expression.test(line)).length;
}

/** Parse a sweep log into the allowlisted counts and booleans safe to publish. */
export function summarizeReaperLog(text) {
  return {
    orphan_runs_found: countLines(text, /^── preflight sweep: prior run /),
    resources_reclaimed: countLines(text, /^\s*(?:deleted|would delete) /),
    residual_detected:
      /preflight could not fully sweep prior-run orphan|preflight left orphan\(s\) UNSWEPT and BILLING|preflight finished with residual orphans/.test(
        text,
      ),
    unverified_count: countLines(text, /preflight for .* could not check /),
    unattributable_count: countLines(
      text,
      /sweep for .* found UNATTRIBUTABLE resource/,
    ),
  };
}

/** Parse an optional integer without turning absence into a successful zero. */
function optionalInteger(value) {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : null;
}

/** Build one schema-v1 result from a log and the workflow's explicit metadata. */
export function buildReaperResult(logText, metadata) {
  const provider = metadata.provider ?? "";
  const facts = summarizeReaperLog(logText ?? "");
  return {
    schema_version: REAPER_RESULT_SCHEMA_VERSION,
    provider,
    region: metadata.region || DEFAULT_REGIONS[provider] || "unknown",
    run_id: metadata.runId ?? "",
    run_attempt: optionalInteger(metadata.runAttempt),
    event_name: metadata.eventName ?? "",
    mode: metadata.dryRun === "1" ? "dry_run" : "reclaim",
    gate_ran: metadata.gateRun === "true",
    sweep_exit_code: optionalInteger(metadata.sweepStatus),
    log_present: metadata.logPresent === true,
    ...facts,
  };
}

/** Report every schema error; callers decide whether to reject or render indeterminate. */
export function validateReaperResult(value, allowCompletedAt = false) {
  const errors = [];
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, errors: ["result must be a JSON object"] };
  }
  const allowed = new Set(
    allowCompletedAt ? [...RESULT_KEYS, "completed_at"] : RESULT_KEYS,
  );
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) errors.push(`unexpected field ${key}`);
  }
  for (const key of RESULT_KEYS) {
    if (!(key in value)) errors.push(`missing field ${key}`);
  }
  if (value.schema_version !== REAPER_RESULT_SCHEMA_VERSION)
    errors.push(`schema_version must be ${REAPER_RESULT_SCHEMA_VERSION}`);
  if (!REAPER_PROVIDERS.includes(value.provider))
    errors.push("provider is not supported");
  if (typeof value.region !== "string" || value.region.length === 0)
    errors.push("region must be a non-empty string");
  if (typeof value.run_id !== "string" || !/^\d+$/.test(value.run_id))
    errors.push("run_id must contain decimal digits only");
  if (!Number.isInteger(value.run_attempt) || value.run_attempt < 1)
    errors.push("run_attempt must be a positive integer");
  if (!new Set(["schedule", "workflow_dispatch"]).has(value.event_name))
    errors.push("event_name must be schedule or workflow_dispatch");
  if (!new Set(["reclaim", "dry_run"]).has(value.mode))
    errors.push("mode must be reclaim or dry_run");
  for (const key of ["gate_ran", "log_present", "residual_detected"]) {
    if (typeof value[key] !== "boolean") errors.push(`${key} must be boolean`);
  }
  if (
    value.sweep_exit_code !== null &&
    !Number.isInteger(value.sweep_exit_code)
  )
    errors.push("sweep_exit_code must be an integer or null");
  for (const key of [
    "orphan_runs_found",
    "resources_reclaimed",
    "unverified_count",
    "unattributable_count",
  ]) {
    if (!Number.isInteger(value[key]) || value[key] < 0)
      errors.push(`${key} must be a non-negative integer`);
  }
  if (
    allowCompletedAt &&
    (typeof value.completed_at !== "string" ||
      Number.isNaN(Date.parse(value.completed_at)))
  ) {
    errors.push("completed_at must be an ISO timestamp");
  }
  return { ok: errors.length === 0, errors };
}

/** Return the value following a named CLI flag. */
function flagValue(args, name) {
  const at = args.indexOf(name);
  return at === -1 ? null : (args[at + 1] ?? null);
}

/** Capture one workflow result without ever copying the raw log into the artifact. */
function capture(args, env) {
  const logPath = flagValue(args, "--log");
  const outPath = flagValue(args, "--out");
  if (logPath === null || outPath === null)
    throw new Error("capture requires --log <path> and --out <path>");
  const logPresent = fs.existsSync(logPath);
  const result = buildReaperResult(
    logPresent ? fs.readFileSync(logPath, "utf8") : "",
    {
      provider: env.PROVIDER,
      region: env.REGION,
      runId: env.GITHUB_RUN_ID,
      runAttempt: env.GITHUB_RUN_ATTEMPT,
      eventName: env.GITHUB_EVENT_NAME,
      dryRun: env.DRY_RUN,
      gateRun: env.GATE_RUN,
      sweepStatus: env.SWEEP_STATUS,
      logPresent,
    },
  );
  const validation = validateReaperResult(result);
  if (!validation.ok) throw new Error(validation.errors.join("; "));
  fs.writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`);
}

/** Validate and normalize one artifact result to stdout for the transport adapter. */
function validateFile(args) {
  const file = flagValue(args, "--file");
  if (file === null) throw new Error("validate requires --file <path>");
  // `--allow-completed-at` validates the shape that actually reaches the snapshot. The artifact a
  // reaper run uploads carries no `completed_at`; programme-fetch.sh adds it from the runs API
  // AFTER this validator has already passed, so the composed object — the only version anything
  // downstream reads — was never checked by anything. This flag lets the fetcher re-run the same
  // validation over the object it is about to persist.
  const allowCompletedAt = args.includes("--allow-completed-at");
  const result = JSON.parse(fs.readFileSync(file, "utf8"));
  const validation = validateReaperResult(result, allowCompletedAt);
  if (!validation.ok) throw new Error(validation.errors.join("; "));
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

/** Exercise both result directions and every state-bearing log fact offline. */
function runSelfTest() {
  let failures = 0;
  const ok = (name, condition) => {
    if (condition) console.log(`ok   - ${name}`);
    else {
      console.error(`FAIL - ${name}`);
      failures += 1;
    }
  };
  const base = {
    provider: "aws",
    region: "us-east-1",
    runId: "123",
    runAttempt: "2",
    eventName: "schedule",
    dryRun: "0",
    gateRun: "true",
    sweepStatus: "0",
    logPresent: true,
  };
  let result = buildReaperResult(
    "✓ preflight complete — all prior-run e2e orphans swept\n",
    base,
  );
  ok(
    "a clean log emits zero findings",
    validateReaperResult(result).ok &&
      result.orphan_runs_found === 0 &&
      !result.residual_detected,
  );
  result = buildReaperResult(
    "── preflight sweep: prior run e2e-old\n  deleted cluster x\n",
    base,
  );
  ok(
    "a reclaimed orphan is counted without becoming residual",
    result.orphan_runs_found === 1 &&
      result.resources_reclaimed === 1 &&
      !result.residual_detected,
  );
  result = buildReaperResult(
    "::warning::preflight could not fully sweep prior-run orphan e2e-old\n",
    base,
  );
  ok("a residual orphan is explicit", result.residual_detected);
  result = buildReaperResult(
    "preflight for cluster could not check API\nsweep for image found UNATTRIBUTABLE resource\n",
    base,
  );
  ok(
    "unverified and unattributable are separate facts",
    result.unverified_count === 1 && result.unattributable_count === 1,
  );
  result = buildReaperResult("", {
    ...base,
    dryRun: "1",
    gateRun: "false",
    sweepStatus: "",
  });
  ok(
    "dry-run, skipped gate and absent status cannot collapse",
    result.mode === "dry_run" &&
      !result.gate_ran &&
      result.sweep_exit_code === null,
  );
  ok(
    "an unexpected field is rejected",
    !validateReaperResult({ ...result, raw_log: "secret" }).ok,
  );
  ok(
    "a malformed provider is rejected",
    !validateReaperResult({ ...result, provider: "digitalocean" }).ok,
  );
  ok(
    "a snapshot observation may add one server timestamp",
    validateReaperResult(
      { ...result, completed_at: "2026-09-01T08:32:00Z" },
      true,
    ).ok,
  );
  ok(
    "an invalid server timestamp is rejected",
    !validateReaperResult({ ...result, completed_at: "yesterday" }, true).ok,
  );
  if (failures > 0) throw new Error(`${failures} self-test check(s) failed`);
  console.log("self-test: all passed");
}

/** Dispatch the intentionally small command-line interface. */
function main(args = process.argv.slice(2), env = process.env) {
  if (args.includes("--self-test")) return runSelfTest();
  if (args[0] === "capture") return capture(args.slice(1), env);
  if (args[0] === "validate") return validateFile(args.slice(1));
  throw new Error(
    "usage: reaper-result.mjs capture --log <path> --out <path> | validate --file <path> [--allow-completed-at] | --self-test",
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    main();
  } catch (error) {
    console.error(
      `reaper-result: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}
