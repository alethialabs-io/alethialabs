#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
//
// BYOC program invariant #1 (enforced, not aspirational):
//
//   "Workflows holding cloud creds or `id-token: write` are `schedule`/`workflow_dispatch`-only;
//    no such privilege is reachable from `pull_request` / `pull_request_target`."
//
// A fork/PR that could reach an OIDC `id-token` or cloud credentials is a confused-deputy: it would
// let untrusted code assume a real cloud role. This guard scans every workflow and FAILS the build
// when privilege is reachable from a PR event. The established safe pattern (infra-cp-*,
// infra-email-ses, …) is a PR-triggered credential-FREE `plan`/`validate` job plus a privileged
// `apply` job gated `if: github.event_name == 'push' …` (or `== 'workflow_dispatch'`); this guard
// recognises those gates and passes them.
//
// ── What is a HARD FAILURE ──
//   1. `pull_request_target` combined with ANY privilege (id-token OR a cloud-cred action/secret).
//      `pull_request_target` runs with the BASE repo's secrets even for FORK PRs — the worst
//      confused-deputy; never combine it with cloud privilege.
//   2. An OIDC `id-token: write` grant reachable from a `pull_request` event (a job that mints the
//      token whose `if:` does not exclude PRs, or a workflow-level grant on an unguarded job). The
//      OIDC-assume path is the strong, un-grandfathered half of the invariant — and the half this
//      program's own AWS role (e2e-nightly.yml) introduces.
//
// ── What is a NOTE (surfaced, not failed) ──
//   A static cloud SECRET/cred-action reachable from a plain `pull_request` (not target). GitHub
//   withholds secrets from FORK `pull_request` runs, so this only exposes them to same-repo
//   (push-access) PRs — the pre-existing, accepted posture of the infra-cp-* plan jobs. It is
//   reported so the debt stays visible, but it does not block CI. (Tightening these to move creds
//   into the push-gated apply job is a separate follow-up.)
//
// Run: `node scripts/check-workflow-oidc-isolation.mjs` (wired into ci.yml → guards).

import fs from "node:fs";
import path from "node:path";

const WF_DIR = ".github/workflows";

// The OIDC token mint — the strong invariant.
const OIDC_MARKER = /^\s*id-token:\s*write\b/;

// Cloud credential markers: an OIDC/cred-exchange action, or a static cloud secret reference.
// Cred actions must be a `uses:` line, and detection runs on non-comment lines only, so a mention
// in prose never counts.
const CRED_MARKERS = [
  /uses:\s*['"]?aws-actions\/configure-aws-credentials/,
  /uses:\s*['"]?google-github-actions\/auth/,
  /uses:\s*['"]?azure\/login/,
  /\$\{\{\s*secrets\.(HCLOUD_TOKEN|AWS_ACCESS_KEY|AWS_SECRET_ACCESS_KEY|AWS_SESSION|AZURE_CREDENTIALS|AZURE_CLIENT_SECRET|GCP_SA_KEY|GOOGLE_CREDENTIALS|ALICLOUD_ACCESS_KEY|ALICLOUD_SECRET_KEY|ALIBABA_CLOUD_ACCESS_KEY)/,
];

// `if:` fragments that PROVE a job cannot run on a PR event.
const PR_EXCLUDING_GUARDS = [
  /event_name\s*==\s*['"]push['"]/,
  /event_name\s*==\s*['"]schedule['"]/,
  /event_name\s*==\s*['"]workflow_dispatch['"]/,
  /event_name\s*==\s*['"]release['"]/,
  /event_name\s*!=\s*['"]pull_request['"]/,
  /github\.ref\s*==\s*['"]refs\/heads\//, // push-to-<branch> gate; PRs carry refs/pull/*
  /startsWith\(\s*github\.ref\s*,\s*['"]refs\/tags\//,
];

// A POSITIVE mention of a PR event — if an `if:` includes this (e.g. an `||` OR-branch), the job
// still runs on PRs even if it also contains an excluding fragment, so the guard does NOT hold.
const PR_INCLUSIVE = /event_name\s*==\s*['"]pull_request(_target)?['"]/;

// GitHub workflow trigger names (used to find triggers at ANY indent under `on:`).
const KNOWN_TRIGGERS = new Set([
  "push", "pull_request", "pull_request_target", "schedule", "workflow_dispatch", "workflow_call",
  "release", "merge_group", "issue_comment", "issues", "label", "fork", "watch", "create", "delete",
  "deployment", "deployment_status", "registry_package", "repository_dispatch", "status", "check_run",
  "check_suite", "page_build", "milestone", "discussion", "discussion_comment",
]);

const indentOf = (line) => (line.match(/^( *)/)?.[1].length ?? 0);
const isNoise = (line) => {
  const t = line.trim();
  return t === "" || t.startsWith("#");
};
const hasOidc = (line) => OIDC_MARKER.test(line);
const hasCred = (line) => CRED_MARKERS.some((re) => re.test(line));

/** True if the `if:` PROVABLY excludes PR events (and doesn't also inclusively match a PR event). */
function guardsOutPRs(ifExpr) {
  if (PR_INCLUSIVE.test(ifExpr)) return false;
  return PR_EXCLUDING_GUARDS.some((re) => re.test(ifExpr));
}

/** Trigger names from a workflow's `on:` (block form at any indent, inline array, or scalar). */
function parseTriggers(lines) {
  const triggers = new Set();
  const onIdx = lines.findIndex((l) => /^(on|["']on["'])\s*:/.test(l));
  if (onIdx === -1) return triggers;

  const inline = lines[onIdx].replace(/^(on|["']on["'])\s*:/, "").trim();
  if (inline && !inline.startsWith("#")) {
    for (const t of inline.replace(/[[\]]/g, "").split(",")) if (t.trim()) triggers.add(t.trim());
    return triggers;
  }
  for (let i = onIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (isNoise(line)) continue;
    if (indentOf(line) === 0) break; // next top-level key ends the on-block
    const key = line.trim().match(/^([A-Za-z_]+)\s*:/);
    if (key && KNOWN_TRIGGERS.has(key[1])) triggers.add(key[1]);
  }
  return triggers;
}

/** Scan a top-level block (`permissions:` / `env:`, before `jobs:`) for a predicate. */
function scanTopLevelBlock(lines, blockRe, pred) {
  const jobsIdx = lines.findIndex((l) => indentOf(l) === 0 && /^jobs\s*:/.test(l));
  const end = jobsIdx === -1 ? lines.length : jobsIdx;
  const idx = lines.findIndex((l, i) => i < end && indentOf(l) === 0 && blockRe.test(l));
  if (idx === -1) return false;
  for (let i = idx + 1; i < end; i++) {
    if (isNoise(lines[i])) continue;
    if (indentOf(lines[i]) === 0) break;
    if (pred(lines[i])) return true;
  }
  return false;
}

/** Split `jobs:` into { name, if, oidc, cred } records (body runs to the next indent-2 header). */
function parseJobs(lines) {
  const jobs = [];
  const jobsIdx = lines.findIndex((l) => indentOf(l) === 0 && /^jobs\s*:/.test(l));
  if (jobsIdx === -1) return jobs;

  let cur = null;
  for (let i = jobsIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (indentOf(line) === 0 && !isNoise(line)) break;
    if (isNoise(line)) continue;
    const ind = indentOf(line);

    const header = ind === 2 && line.trim().match(/^([A-Za-z0-9_-]+)\s*:\s*$/);
    if (header) {
      if (cur) jobs.push(cur);
      cur = { name: header[1], if: "", oidc: false, cred: false };
      continue;
    }
    if (!cur) continue;

    const ifm = ind === 4 && line.match(/^\s{4}if\s*:\s*(.*)$/);
    if (ifm) {
      let expr = ifm[1].trim();
      if (["", ">", "|", ">-", "|-"].includes(expr)) {
        for (let j = i + 1; j < lines.length; j++) {
          if (isNoise(lines[j])) continue;
          if (indentOf(lines[j]) <= 4) break;
          expr += " " + lines[j].trim();
        }
      }
      cur.if = expr;
    }
    if (hasOidc(line)) cur.oidc = true;
    if (hasCred(line)) cur.cred = true;
  }
  if (cur) jobs.push(cur);
  return jobs;
}

function main() {
  const files = fs
    .readdirSync(WF_DIR)
    .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
    .sort();

  const violations = [];
  const notes = [];
  const privilegedFiles = [];

  for (const file of files) {
    const raw = fs.readFileSync(path.join(WF_DIR, file), "utf8").split("\n");
    // Strip full-line comments so privilege detection never fires on prose.
    const lines = raw.map((l) => (l.trim().startsWith("#") ? "" : l));

    const triggers = parseTriggers(lines);
    const prTriggered = triggers.has("pull_request");
    const prTargetTriggered = triggers.has("pull_request_target");

    const wfOidc = scanTopLevelBlock(lines, /^permissions\s*:/, hasOidc);
    const wfCred = scanTopLevelBlock(lines, /^env\s*:/, hasCred);
    const jobs = parseJobs(lines);

    const anyOidc = wfOidc || jobs.some((j) => j.oidc) || lines.some(hasOidc);
    const anyCred = wfCred || jobs.some((j) => j.cred) || lines.some(hasCred);
    if (anyOidc || anyCred) privilegedFiles.push(file);

    if (!prTriggered && !prTargetTriggered) continue; // not PR-reachable → safe

    // (1) pull_request_target + ANY privilege → hard fail.
    if (prTargetTriggered && (anyOidc || anyCred)) {
      violations.push(
        `${file}: \`pull_request_target\` trigger combined with cloud privilege — a fork PR would run with the base repo's secrets/OIDC. Never combine the two.`,
      );
      continue;
    }

    if (!prTriggered) continue;

    // (2) OIDC id-token reachable from a `pull_request` → hard fail (per unguarded privileged job).
    for (const job of jobs) {
      const jobOidc = job.oidc || wfOidc;
      if (jobOidc && !guardsOutPRs(job.if)) {
        violations.push(
          `${file}: job \`${job.name}\` mints/holds an OIDC \`id-token\` and is reachable from a \`pull_request\` event` +
            (job.if ? ` (its \`if:\` — \`${job.if}\` — does not exclude PRs).` : " (it has no \`if:\` guard).") +
            " Gate it with `if: github.event_name == 'push' …` / `== 'workflow_dispatch'`, or drop the PR trigger.",
        );
      }
    }

    // (NOTE) static cloud secret/cred reachable from a plain pull_request (fork-safe; accepted).
    const credOnPr =
      wfCred || jobs.some((j) => (j.cred || wfCred) && !guardsOutPRs(j.if));
    if (credOnPr) {
      notes.push(
        `${file}: a static cloud secret/cred is reachable from \`pull_request\` (exposed to same-repo PRs; forks are withheld secrets). Accepted pattern — consider moving creds into the push-gated apply job.`,
      );
    }
  }

  console.log(
    `[oidc-isolation] scanned ${files.length} workflows; ${privilegedFiles.length} hold cloud privilege: ${privilegedFiles.join(", ") || "none"}`,
  );
  if (notes.length) {
    console.log("\nℹ️  Notes (visible, non-blocking):");
    for (const n of notes) console.log("  • " + n);
  }

  if (violations.length) {
    console.error("\n❌ Program invariant #1 violated — cloud privilege reachable from a PR event:\n");
    for (const v of violations) console.error("  • " + v);
    console.error("\nPrivileged (OIDC) jobs must be schedule/dispatch/push-only; never mix pull_request_target with privilege.");
    process.exit(1);
  }
  console.log("\n✅ No OIDC id-token is reachable from pull_request, and no pull_request_target is privileged.");
}

main();
