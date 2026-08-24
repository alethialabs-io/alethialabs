#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
//
// The CLA gate — first-party, because the alternative was archived.
//
// `contributor-assistant/github-action` was pinned by immutable SHA at v2.6.1 and its upstream was
// archived in March 2026 (#2367). A maintained fork is a smaller version of the same problem and a
// GitHub App is a maintainer-owned credential outside the tree, so the mechanism lives here: a
// workflow plus this script, both auditable in-tree and both driven by fixtures.
//
// ── The threat model this file is written against ──────────────────────────────────────────────
//
// This runs from `pull_request_target`, which means a privileged token and the BASE ref's code. Every
// rule below exists because of a way that goes wrong:
//
//   · PR-head code is NEVER checked out or executed. The workflow pins the base SHA; this script
//     reads no repository content that a contributor can influence.
//   · Identity comes from the EVENT PAYLOAD (`user.id`), never from a file, a commit trailer or a
//     comment's own claim about who wrote it. GitHub signs the payload; the rest is attacker input.
//   · Signatures are keyed on the NUMERIC USER ID. A login can be released and re-registered by
//     somebody else; an id cannot. Storing only `name` is how a signature record becomes forgeable.
//   · The trusted-actor list is EXACT STRINGS. The archived action's config used `bot*`, a glob that
//     matches any login beginning with "bot" — all of them registrable. And the shell `case` this
//     replaces had the mirror-image bug (see .github/workflows/cla.yml): unquoted `[bot]` is a
//     character class, so `dependabot[bot]` never matched while `dependabott` did. Both directions
//     are pinned in the fixtures.
//   · A signing comment counts only if it is UNEDITED (`created_at === updated_at`). Otherwise a
//     contributor signs, the record is written, and the comment is then edited to say something
//     else — leaving a signature record whose evidence no longer exists.
//   · A signature is scoped to a CLA VERSION. cla/README.md: "A material agreement change creates a
//     new version." A v1.1 record must not satisfy a v1.2 gate.
//   · Every unknown FAILS CLOSED. No ACTIVE record, no signatures file, an event shape nobody
//     anticipated: the answer is "not signed", never "assume fine".
//
// The comment body is compared for EXACT equality and is otherwise never parsed, interpolated or
// echoed. It is attacker-controlled text in a privileged job.
//
// Usage:
//   node scripts/legal/cla-check.mjs --self-test    # hermetic fixtures (CI: ci.yml → guards)
//   node scripts/legal/cla-check.mjs                # in the workflow, from GITHUB_EVENT_PATH

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * The exact logins that may merge without a signature: the founder, and the maintenance bots whose
 * pull requests are machine-generated from this repository's own configuration.
 *
 * EXACT strings, compared with ===. No globs, no prefixes, no case folding — every one of those is a
 * way for a registrable login to enter the set.
 */
export const TRUSTED_ACTORS = Object.freeze([
	"bobikenobi12",
	"dependabot[bot]",
	"github-actions[bot]",
	"renovate[bot]",
	"alethia-labs-ci[bot]",
	"mergify[bot]",
]);

/** The exact text a contributor comments to sign. Compared after trimming outer whitespace only. */
export const SIGN_PHRASE = "I have read the CLA Document and I hereby sign the CLA";

/** The exact text that re-runs the check without signing anything. */
export const RECHECK_PHRASE = "recheck";

/**
 * Decisions this gate can reach. Finite and known, so a typed union rather than bare strings — a
 * caller switching on these must fail to handle a new one, not silently drop it.
 *
 * `pass`   — merge may proceed; set the `cla` status green.
 * `sign`   — a valid signature was offered; record it, then pass.
 * `blocked`— not signed (or not signable); set the `cla` status red with `reason`.
 * `ignore` — the event is not addressed to this gate at all; write nothing, set nothing.
 */
export const Decision = Object.freeze({
	Pass: "pass",
	Sign: "sign",
	Blocked: "blocked",
	Ignore: "ignore",
});

/**
 * Reads `cla/ACTIVE` into the facts the gate needs. Returns null when the file is absent, which is
 * the PRE-ACTIVATION state and means the gate fails closed for every external contributor.
 * @param {string} [path]
 */
export function readActive(path = resolve(root, "cla/ACTIVE")) {
	if (!existsSync(path)) return null;
	const out = {};
	for (const line of readFileSync(path, "utf8").split("\n")) {
		const m = /^([a-z_]+):\s*"?([^"]*)"?\s*$/.exec(line.trim());
		if (m) out[m[1]] = m[2];
	}
	// cla_version reaches an API path (cla/signatures/v<version>.json), so its shape is pinned here
	// rather than trusted. cla/ACTIVE comes from the trusted base checkout and is written by
	// activate-company-ip.mjs from verified evidence — but a version of "../../x" would still write
	// outside cla/signatures/, and a one-line regex is cheaper than relying on that never happening.
	if (!out.cla_version || !/^[0-9]+(\.[0-9]+)*$/.test(out.cla_version)) return null;
	return out;
}

/**
 * Normalises a signatures document into the record list, tolerating an absent or empty file. The
 * shape is a superset of the archived action's (`signedContributors` with name/id/comment_id/
 * created_at/repoId/pullRequestNo), so cla/archive/v1.0-preincorporation.json migrates by copy —
 * see the migration note in cla/README.md.
 * @param {unknown} doc
 * @returns {Array<Record<string, unknown>>}
 */
export function records(doc) {
	if (!doc || typeof doc !== "object") return [];
	const list = /** @type {{signedContributors?: unknown}} */ (doc).signedContributors;
	return Array.isArray(list) ? list.filter((r) => r && typeof r === "object") : [];
}

/**
 * Is this contributor on record as having signed THIS version of the CLA?
 *
 * Keyed on the numeric id. `Number.isInteger` rather than a truthy check because a record whose id
 * is a string, a float or absent must not match — a loosely-typed id is how "0" or "" starts
 * matching somebody.
 * @param {Array<Record<string, unknown>>} recs
 * @param {number} id
 * @param {string} version
 */
export function hasSigned(recs, id, version) {
	if (!Number.isInteger(id)) return false;
	return recs.some((r) => r.id === id && String(r.cla_version ?? "") === version);
}

/**
 * The whole gate, as a pure function. Every I/O decision upstream of it is a lookup; everything that
 * DECIDES is here, so the fixtures below exercise the real logic rather than a re-implementation.
 *
 * @param {object} input
 * @param {string} input.eventName            - "pull_request_target" | "issue_comment" | other
 * @param {any}    input.event                - the webhook payload, verbatim
 * @param {{cla_version: string, icla_sha256?: string}|null} input.active - parsed cla/ACTIVE
 * @param {Array<Record<string, unknown>>} input.signatures - existing records
 * @returns {{decision: string, reason: string, actor?: {login: string, id: number}, record?: object}}
 */
export function evaluate({ eventName, event, active, signatures }) {
	// ── 1. Pre-activation: fail closed, exactly as the gate this replaces did. ──────────────────
	// This is the live state today. Until counsel approves the text and `pnpm legal:activate-ip`
	// writes cla/ACTIVE, external merges are paused and no comment can unpause them.
	if (!active) {
		if (isTrusted(actorOf(eventName, event)?.login)) {
			return { decision: Decision.Pass, reason: "trusted founder or maintenance bot" };
		}
		return {
			decision: Decision.Blocked,
			reason: "External merges are paused until the ALETHIA LABS post-registration CLA is active.",
		};
	}

	const actor = actorOf(eventName, event);
	if (!actor) return { decision: Decision.Ignore, reason: "no pull request in this event" };

	// ── 2. Trusted actors, by exact login. ─────────────────────────────────────────────────────
	if (isTrusted(actor.login)) {
		return { decision: Decision.Pass, reason: "trusted founder or maintenance bot", actor };
	}

	const version = active.cla_version;

	// ── 3. A comment: the only way to sign. ────────────────────────────────────────────────────
	if (eventName === "issue_comment") {
		const c = event.comment ?? {};
		const body = typeof c.body === "string" ? c.body.trim() : "";

		// Not a PR. `issue_comment` fires on issues too, and an issue has no head SHA to status.
		if (!event.issue?.pull_request) {
			return { decision: Decision.Ignore, reason: "comment is on an issue, not a pull request" };
		}
		if (body === RECHECK_PHRASE) {
			return hasSigned(signatures, actor.id, version)
				? { decision: Decision.Pass, reason: `signed CLA v${version}`, actor }
				: { decision: Decision.Blocked, reason: notSigned(version), actor };
		}
		if (body !== SIGN_PHRASE) {
			return { decision: Decision.Ignore, reason: "comment is not a signature" };
		}
		// A signature must come from the pull request's own author. Otherwise anyone who can comment
		// can sign on somebody else's behalf, and the record names the wrong person.
		if (!Number.isInteger(event.issue?.user?.id) || event.issue.user.id !== actor.id) {
			return {
				decision: Decision.Blocked,
				reason: "only the pull request's author can sign the CLA for it",
				actor,
			};
		}
		// An edited comment is not evidence: sign, get recorded, then rewrite the comment.
		if (!c.created_at || !c.updated_at || c.created_at !== c.updated_at) {
			return {
				decision: Decision.Blocked,
				reason: "this comment has been edited, so it cannot serve as a signature — comment the phrase again, unedited",
				actor,
			};
		}
		if (hasSigned(signatures, actor.id, version)) {
			return { decision: Decision.Pass, reason: `already signed CLA v${version}`, actor };
		}
		return {
			decision: Decision.Sign,
			reason: `signature accepted for CLA v${version}`,
			actor,
			record: {
				name: actor.login,
				id: actor.id,
				comment_id: c.id,
				created_at: c.created_at,
				repoId: event.repository?.id,
				pullRequestNo: event.issue.number,
				cla_version: version,
				document_sha256: active.icla_sha256 ?? "",
			},
		};
	}

	// ── 4. A pull request: a lookup, never a write. ────────────────────────────────────────────
	if (eventName === "pull_request_target") {
		return hasSigned(signatures, actor.id, version)
			? { decision: Decision.Pass, reason: `signed CLA v${version}`, actor }
			: { decision: Decision.Blocked, reason: notSigned(version), actor };
	}

	// ── 5. Anything else. An event shape nobody anticipated is not an approval. ─────────────────
	return { decision: Decision.Ignore, reason: `unhandled event ${eventName}` };
}

/** The blocked message, which is also the instructions — a gate nobody can satisfy is just a wall. */
function notSigned(version) {
	return `Please sign the Contributor License Agreement (v${version}) by commenting exactly: ${SIGN_PHRASE}`;
}

/** Exact-string membership. No globs, no prefixes, no case folding. */
export function isTrusted(login) {
	return typeof login === "string" && TRUSTED_ACTORS.includes(login);
}

/**
 * The acting identity, taken from the signed webhook payload and nowhere else. Returns null when the
 * event carries no pull request for this gate to act on.
 */
function actorOf(eventName, event) {
	if (eventName === "issue_comment") {
		const u = event?.comment?.user;
		return u && Number.isInteger(u.id) ? { login: u.login, id: u.id } : null;
	}
	if (eventName === "pull_request_target") {
		const u = event?.pull_request?.user;
		return u && Number.isInteger(u.id) ? { login: u.login, id: u.id } : null;
	}
	return null;
}

/** SHA-256 of a file, for the document hash recorded alongside a signature. */
export function sha256(path) {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}
