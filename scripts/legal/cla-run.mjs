#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
//
// The I/O half of the CLA gate. cla-check.mjs DECIDES; this reads the event, fetches the signature
// records, writes a new one when a signature is accepted, and reports the verdict as the `cla`
// commit status. Split so the decision logic is a pure function with hermetic fixtures — the half
// that can be wrong in a way nobody notices is the decision, not the HTTP.
//
// Reads nothing from the repository working tree except cla/ACTIVE and cla/ICLA.md, both of which
// come from the workflow's TRUSTED BASE checkout. Pull-request-head content is never read.
//
// Usage (from .github/workflows/cla.yml, post-activation):
//   node scripts/legal/cla-run.mjs
//
// Environment: GITHUB_TOKEN, GITHUB_EVENT_NAME, GITHUB_EVENT_PATH, GITHUB_REPOSITORY,
//              GITHUB_SERVER_URL, CLA_SIGNATURE_BRANCH (default "cla-signatures").

import { readFileSync } from "node:fs";
import {
	corporateAgreements,
	Decision,
	evaluate,
	readActive,
	records,
	revocations,
} from "./cla-check.mjs";

const token = required("GITHUB_TOKEN");
const [owner, repo] = required("GITHUB_REPOSITORY").split("/");
const eventName = required("GITHUB_EVENT_NAME");
const event = JSON.parse(readFileSync(required("GITHUB_EVENT_PATH"), "utf8"));
const branch = process.env.CLA_SIGNATURE_BRANCH || "cla-signatures";
const api = process.env.GITHUB_API_URL || "https://api.github.com";

function required(name) {
	const v = process.env[name];
	if (!v) {
		console.error(`cla: ${name} is not set`);
		process.exit(1);
	}
	return v;
}

/** One authenticated REST call. Throws on any non-2xx except an allowed status. */
async function gh(method, path, body, allow = []) {
	const res = await fetch(`${api}${path}`, {
		method,
		headers: {
			authorization: `Bearer ${token}`,
			accept: "application/vnd.github+json",
			"x-github-api-version": "2022-11-28",
			...(body ? { "content-type": "application/json" } : {}),
		},
		...(body ? { body: JSON.stringify(body) } : {}),
	});
	if (!res.ok && !allow.includes(res.status)) {
		throw new Error(`${method} ${path} -> ${res.status} ${await res.text()}`);
	}
	return res.ok ? res.json() : { __status: res.status };
}

const active = readActive();
const version = active?.cla_version ?? "0";
const file = `cla/signatures/v${version}.json`;

// ── read the signature records from the dedicated branch ───────────────────────────────────────
// They live on `cla-signatures`, never on a code branch: a signature record must not be reachable
// through a pull request that also changes code. A 404 means "no signatures yet", which is a valid
// starting state and not an error — but it is also NOT a pass, because hasSigned() sees an empty list.
let sha;
let signatures = [];
let corporate = [];
let revoked = [];
if (active) {
	const got = await gh("GET", `/repos/${owner}/${repo}/contents/${file}?ref=${branch}`, null, [404]);
	if (!got.__status) {
		sha = got.sha;
		const doc = JSON.parse(Buffer.from(got.content, "base64").toString("utf8"));
		signatures = records(doc);
		corporate = corporateAgreements(doc);
		revoked = revocations(doc);
	}
}

/**
 * Every commit author on the pull request, from the commits API.
 *
 * Returns `undefined` — NOT an empty array — when they cannot be enumerated. The two are opposite
 * facts: an empty list means "no commits", which would pass trivially, while "could not read" must
 * fail closed. Collapsing them is how this check would quietly stop checking.
 *
 * Paged, and capped at GitHub's own 250-commit ceiling for this endpoint. A pull request larger than
 * that is reported as unreadable rather than partially checked — a partial answer here is an
 * unlicensed contribution that looks fine.
 */
async function commitAuthors() {
	if (eventName !== "pull_request_target") return [];
	const number = event?.pull_request?.number ?? event?.number;
	if (!Number.isInteger(number)) return undefined;
	const out = [];
	for (let page = 1; page <= 3; page++) {
		const got = await gh(
			"GET",
			`/repos/${owner}/${repo}/pulls/${number}/commits?per_page=100&page=${page}`,
			null,
			[404, 422],
		).catch(() => ({ __status: 599 }));
		if (got.__status || !Array.isArray(got)) return undefined;
		for (const c of got) {
			// `author` is the GitHub ACCOUNT GitHub matched to the commit, and it is null when the
			// commit's author email belongs to no account. That is exactly the case that must not be
			// skipped, so the sha is carried through for the message.
			out.push({ login: c.author?.login, id: c.author?.id, sha: c.sha });
		}
		if (got.length < 100) return out;
	}
	return undefined;
}

const authors = await commitAuthors();
const verdict = evaluate({ eventName, event, active, signatures, corporate, revoked, authors });

if (verdict.decision === Decision.Ignore) {
	console.log(`cla: ignoring — ${verdict.reason}`);
	process.exit(0);
}

// ── record an accepted signature BEFORE reporting it ───────────────────────────────────────────
// Order matters: a green status with no durable record is a contributor who believes they signed and
// a repository that does not agree. `sha` is passed so a concurrent write fails the PUT rather than
// silently overwriting somebody else's signature.
if (verdict.decision === Decision.Sign) {
	await appendSignature(verdict.record);
	console.log(`cla: recorded signature for ${verdict.record.name} (id ${verdict.record.id})`);
}

/**
 * Appends one record, re-reading and retrying on a conflict.
 *
 * The PUT carries the blob `sha` we read, so a concurrent write is REJECTED (409/422) rather than
 * silently overwriting somebody else's signature — losing a signature is the failure that matters
 * here, and last-write-wins is how it happens. The workflow's concurrency group is keyed per pull
 * request, which serialises a contributor's own double-comment but NOT two different pull requests
 * signing in the same minute, so the retry is the part that actually handles it.
 *
 * Bounded, and the last attempt is allowed to throw: an unrecorded signature must surface as a red
 * job, never as a green status over a record that was never written.
 */
async function appendSignature(record) {
	for (let attempt = 0; ; attempt++) {
		const doc = {
			cla_version: version,
			icla_sha256: active.icla_sha256 ?? "",
			signedContributors: [...signatures, record],
		};
		const res = await gh(
			"PUT",
			`/repos/${owner}/${repo}/contents/${file}`,
			{
				branch,
				message: `chore(cla): record signature for ${record.name} (v${version})`,
				content: Buffer.from(`${JSON.stringify(doc, null, 2)}\n`).toString("base64"),
				...(sha ? { sha } : {}),
			},
			attempt < 3 ? [409, 422] : [],
		);
		if (!res.__status) return;
		console.log(`cla: signature file changed under us (${res.__status}); re-reading and retrying`);
		const got = await gh("GET", `/repos/${owner}/${repo}/contents/${file}?ref=${branch}`, null, [404]);
		if (got.__status) {
			sha = undefined;
			signatures = [];
		} else {
			sha = got.sha;
			signatures = records(JSON.parse(Buffer.from(got.content, "base64").toString("utf8")));
		}
		// Somebody else may have recorded the same signature in the window we lost.
		if (signatures.some((r) => r.id === record.id && r.cla_version === version)) return;
	}
}

// ── report as the `cla` commit status ──────────────────────────────────────────────────────────
// The status context is `cla`, which is the exact string every protected branch ruleset requires.
// Renaming it silently un-gates every protected branch, so it is a constant, not configuration.
const passed = verdict.decision !== Decision.Blocked;
const headSha =
	event.pull_request?.head?.sha ??
	(await gh("GET", `/repos/${owner}/${repo}/pulls/${event.issue.number}`)).head.sha;

await gh("POST", `/repos/${owner}/${repo}/statuses/${headSha}`, {
	state: passed ? "success" : "failure",
	context: "cla",
	description: verdict.reason.slice(0, 140),
	target_url: `${process.env.GITHUB_SERVER_URL}/${owner}/${repo}/blob/HEAD/cla/ICLA.md`,
});

console.log(`cla: ${verdict.decision} — ${verdict.reason}`);
if (!passed) process.exit(1);
