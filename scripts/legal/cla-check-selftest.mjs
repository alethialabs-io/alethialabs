#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
//
// Fixtures for the CLA gate. Hermetic: no network, no gh, no repository state — every input is
// inline, so this runs in the `guards` job alongside the other self-tests.
//
// Each case is a way the gate could be wrong in a way nobody would notice: it goes GREEN. A CLA gate
// that wrongly blocks is reported within the hour by the contributor it blocked; one that wrongly
// passes is discovered in a dispute, years later.
//
// Run: node scripts/legal/cla-check-selftest.mjs   (CI: ci.yml → guards)

import { Decision, SIGN_PHRASE, TRUSTED_ACTORS, evaluate, hasSigned, isTrusted, records } from "./cla-check.mjs";

const ACTIVE = { cla_version: "1.1", icla_sha256: "a".repeat(64) };
const STAMP = "2026-08-24T10:00:00Z";

/**
 * A corporate agreement covering `ids`.
 *
 * Minimal ON PURPOSE (#2374): the organization, the version and hash of what was signed, when it
 * took effect, the covered ids, and an OPAQUE reference to the authorization held offline. Who
 * signed for the company and in what role is not here and must not be — this file is world-readable,
 * and the gate only ever needs to answer "is this id covered?".
 */
const ccla = (organization, ids) => ({
	organization,
	ccla_version: "1.1",
	document_sha256: "c".repeat(64),
	effective_at: STAMP,
	covered_ids: ids,
	authorization_reference: "CCLA-2026-0001",
});

/**
 * A pull_request_target payload from `login`/`id`.
 *
 * `authors` defaults to the opener alone — the common case — but is a SEPARATE input because the
 * gate checks every commit author, not the opener (#2374). Pass it explicitly for a branch carrying
 * somebody else's commits, and omit it entirely to exercise the fail-closed path.
 */
const pr = (login, id, authors) => ({
	eventName: "pull_request_target",
	event: { pull_request: { user: { login, id }, head: { sha: "deadbeef" } }, number: 7 },
	authors: authors === undefined ? [{ login, id, sha: "deadbeef" }] : authors,
});

/** An issue_comment payload. `authorId` defaults to the commenter — i.e. the PR's own author. */
const comment = (login, id, body, opts = {}) => ({
	eventName: "issue_comment",
	event: {
		comment: {
			id: 99,
			body,
			user: { login, id },
			created_at: STAMP,
			updated_at: opts.editedAt ?? STAMP,
		},
		issue: {
			number: 7,
			user: { id: opts.authorId ?? id },
			...(opts.notAPullRequest ? {} : { pull_request: { url: "…" } }),
		},
		repository: { id: 1037321962 },
	},
});

/** One signature record for `id` at `version`. */
const signed = (id, version = "1.1") => [{ name: "outsider", id, cla_version: version, comment_id: 1 }];

const cases = [
	// ── pre-activation: the live state today, and it must not be unlockable by comment ──────────
	{
		name: "no cla/ACTIVE blocks an external contributor",
		input: { ...pr("outsider", 4242), active: null, signatures: [] },
		want: Decision.Blocked,
	},
	{
		name: "no cla/ACTIVE still lets the founder merge",
		input: { ...pr("bobikenobi12", 58654673), active: null, signatures: [] },
		want: Decision.Pass,
	},
	{
		name: "no cla/ACTIVE cannot be talked past with a signature comment",
		input: { ...comment("outsider", 4242, SIGN_PHRASE), active: null, signatures: [] },
		want: Decision.Blocked,
	},

	// ── the allowlist, in BOTH directions ────────────────────────────────────────────────────────
	// The shell `case` this replaces failed both ways at once: `[bot]` unquoted is a character class,
	// so the real bot logins never matched while a set of registrable near-misses did.
	{
		name: "a real bot login is trusted",
		input: { ...pr("dependabot[bot]", 49699333), active: ACTIVE, signatures: [] },
		want: Decision.Pass,
	},
	{
		name: "dependabott — a registrable near-miss — is NOT trusted",
		input: { ...pr("dependabott", 1), active: ACTIVE, signatures: [] },
		want: Decision.Blocked,
	},
	{
		name: "mergifyt is NOT trusted",
		input: { ...pr("mergifyt", 2), active: ACTIVE, signatures: [] },
		want: Decision.Blocked,
	},
	{
		name: "github-actionsb is NOT trusted",
		input: { ...pr("github-actionsb", 3), active: ACTIVE, signatures: [] },
		want: Decision.Blocked,
	},
	{
		name: "botsy — the archived action's `bot*` glob would have trusted this — is NOT trusted",
		input: { ...pr("botsy", 4), active: ACTIVE, signatures: [] },
		want: Decision.Blocked,
	},
	{
		name: "a case-variant of a trusted login is NOT trusted",
		input: { ...pr("Dependabot[bot]", 5), active: ACTIVE, signatures: [] },
		want: Decision.Blocked,
	},

	// ── signature lookup is by NUMERIC ID ────────────────────────────────────────────────────────
	{
		name: "a signed contributor passes",
		input: { ...pr("outsider", 4242), active: ACTIVE, signatures: signed(4242) },
		want: Decision.Pass,
	},
	{
		name: "a RENAMED signed contributor still passes — the id is the key",
		input: { ...pr("outsider-renamed", 4242), active: ACTIVE, signatures: signed(4242) },
		want: Decision.Pass,
	},
	{
		name: "somebody who took over the old LOGIN does not inherit the signature",
		input: { ...pr("outsider", 9999), active: ACTIVE, signatures: signed(4242) },
		want: Decision.Blocked,
	},
	{
		name: "an id recorded as a string does not match a real id",
		input: { ...pr("outsider", 4242), active: ACTIVE, signatures: [{ id: "4242", cla_version: "1.1" }] },
		want: Decision.Blocked,
	},

	// ── versioning: a material change makes a new version, and old records do not carry over ────
	{
		name: "a v1.0 signature does not satisfy a v1.1 gate",
		input: { ...pr("outsider", 4242), active: ACTIVE, signatures: signed(4242, "1.0") },
		want: Decision.Blocked,
	},
	{
		name: "a record with no version does not satisfy any gate",
		input: { ...pr("outsider", 4242), active: ACTIVE, signatures: [{ id: 4242 }] },
		want: Decision.Blocked,
	},

	// ── signing by comment ───────────────────────────────────────────────────────────────────────
	{
		name: "the exact phrase from the PR author signs",
		input: { ...comment("outsider", 4242, SIGN_PHRASE), active: ACTIVE, signatures: [] },
		want: Decision.Sign,
	},
	{
		name: "surrounding whitespace is tolerated",
		input: { ...comment("outsider", 4242, `\n  ${SIGN_PHRASE}  \n`), active: ACTIVE, signatures: [] },
		want: Decision.Sign,
	},
	{
		name: "the phrase EMBEDDED in other prose does not sign",
		input: { ...comment("outsider", 4242, `As discussed, ${SIGN_PHRASE} — but see my note below.`), active: ACTIVE, signatures: [] },
		want: Decision.Ignore,
	},
	{
		name: "an EDITED comment cannot serve as a signature",
		input: { ...comment("outsider", 4242, SIGN_PHRASE, { editedAt: "2026-08-24T11:00:00Z" }), active: ACTIVE, signatures: [] },
		want: Decision.Blocked,
	},
	{
		name: "a THIRD PARTY cannot sign on the author's behalf",
		input: { ...comment("bystander", 777, SIGN_PHRASE, { authorId: 4242 }), active: ACTIVE, signatures: [] },
		want: Decision.Blocked,
	},
	{
		name: "the phrase on an ISSUE is not a signature",
		input: { ...comment("outsider", 4242, SIGN_PHRASE, { notAPullRequest: true }), active: ACTIVE, signatures: [] },
		want: Decision.Ignore,
	},
	{
		name: "an unrelated comment is ignored, not blocked",
		input: { ...comment("outsider", 4242, "lgtm"), active: ACTIVE, signatures: [] },
		want: Decision.Ignore,
	},
	{
		name: "recheck re-reports a signed contributor without re-recording",
		input: { ...comment("outsider", 4242, "recheck"), active: ACTIVE, signatures: signed(4242) },
		want: Decision.Pass,
	},
	{
		name: "recheck on an unsigned contributor blocks",
		input: { ...comment("outsider", 4242, "recheck"), active: ACTIVE, signatures: [] },
		want: Decision.Blocked,
	},
	{
		name: "signing twice does not duplicate the record",
		input: { ...comment("outsider", 4242, SIGN_PHRASE), active: ACTIVE, signatures: signed(4242) },
		want: Decision.Pass,
	},

	// ── malformed / hostile shapes fail closed ───────────────────────────────────────────────────
	{
		name: "a payload with no identifiable actor is ignored, never passed",
		input: { eventName: "pull_request_target", event: {}, active: ACTIVE, signatures: [] },
		want: Decision.Ignore,
	},
	{
		name: "an unhandled event is ignored, never passed",
		input: { eventName: "push", event: {}, active: ACTIVE, signatures: [] },
		want: Decision.Ignore,
	},

	// ── EVERY COMMIT AUTHOR, not just the opener (#2374) ─────────────────────────────────────────
	// A branch can carry commits by somebody else — a rebase of another person's work, a co-author,
	// a fork a second person pushed to. Checking only `pull_request.user` licenses all of it on one
	// signature from someone who did not write it.
	{
		name: "an UNSIGNED co-author blocks a PR opened by a signed contributor",
		input: {
			...pr("outsider", 4242, [
				{ login: "outsider", id: 4242, sha: "aaaaaaaa" },
				{ login: "ghost", id: 5555, sha: "bbbbbbbb" },
			]),
			active: ACTIVE,
			signatures: signed(4242),
		},
		want: Decision.Blocked,
	},
	{
		name: "every commit author signed → pass",
		input: {
			...pr("outsider", 4242, [
				{ login: "outsider", id: 4242, sha: "aaaaaaaa" },
				{ login: "second", id: 5555, sha: "bbbbbbbb" },
			]),
			active: ACTIVE,
			signatures: [...signed(4242), ...signed(5555)],
		},
		want: Decision.Pass,
	},
	{
		name: "a TRUSTED bot among the commit authors does not need a signature",
		input: {
			...pr("outsider", 4242, [
				{ login: "outsider", id: 4242, sha: "aaaaaaaa" },
				{ login: "dependabot[bot]", id: 49699333, sha: "bbbbbbbb" },
			]),
			active: ACTIVE,
			signatures: signed(4242),
		},
		want: Decision.Pass,
	},
	{
		name: "a commit whose author GitHub cannot resolve to an account is BLOCKED, never skipped",
		input: {
			...pr("outsider", 4242, [
				{ login: "outsider", id: 4242, sha: "aaaaaaaa" },
				{ login: undefined, id: undefined, sha: "cccccccc" },
			]),
			active: ACTIVE,
			signatures: signed(4242),
		},
		want: Decision.Blocked,
	},
	{
		name: "commit authors that could not be enumerated FAIL CLOSED",
		// `authors: undefined` — the commits API errored or paged short. Falling back to the opener
		// would silently narrow the check to the case this widened, while still reporting a pass.
		input: { ...pr("outsider", 4242, undefined), authors: undefined, active: ACTIVE, signatures: signed(4242) },
		want: Decision.Blocked,
	},

	// ── CORPORATE, REVOCATION, SUPERSESSION ──────────────────────────────────────────────────────
	{
		name: "a contributor covered by their employer's CCLA passes with no individual signature",
		input: {
			...pr("employee", 6001),
			active: ACTIVE,
			signatures: [],
			corporate: [ccla("Acme GmbH", [6001])],
		},
		want: Decision.Pass,
	},
	{
		name: "a CCLA does not cover an id it does not list",
		input: {
			...pr("stranger", 6002),
			active: ACTIVE,
			signatures: [],
			corporate: [ccla("Acme GmbH", [6001])],
		},
		want: Decision.Blocked,
	},
	{
		name: "a CCLA for a DIFFERENT version does not cover this one",
		input: {
			...pr("employee", 6001),
			active: ACTIVE,
			signatures: [],
			corporate: [{ ...ccla("Acme GmbH", [6001]), ccla_version: "1.0" }],
		},
		want: Decision.Blocked,
	},
	{
		name: "a REVOKED signature no longer covers, even though the record remains",
		input: {
			...pr("outsider", 4242),
			active: ACTIVE,
			signatures: signed(4242),
			revoked: [{ id: 4242, cla_version: "1.1", revoked_at: STAMP, revocation_reference: "REV-1" }],
		},
		want: Decision.Blocked,
	},
	{
		name: "revocation beats a corporate agreement too — otherwise revoking is advisory",
		input: {
			...pr("employee", 6001),
			active: ACTIVE,
			signatures: [],
			corporate: [ccla("Acme GmbH", [6001])],
			revoked: [{ id: 6001, cla_version: "1.1", revoked_at: STAMP, revocation_reference: "REV-2" }],
		},
		want: Decision.Blocked,
	},
	{
		name: "a revoked contributor cannot re-sign by commenting — reinstatement is administrative",
		input: {
			...comment("outsider", 4242, SIGN_PHRASE),
			active: ACTIVE,
			signatures: signed(4242),
			revoked: [{ id: 4242, cla_version: "1.1", revoked_at: STAMP, revocation_reference: "REV-3" }],
		},
		want: Decision.Blocked,
	},
	{
		name: "a revocation for another VERSION does not affect this one",
		input: {
			...pr("outsider", 4242),
			active: ACTIVE,
			signatures: signed(4242),
			revoked: [{ id: 4242, cla_version: "1.0", revoked_at: STAMP, revocation_reference: "REV-4" }],
		},
		want: Decision.Pass,
	},

];

let failed = 0;

for (const c of cases) {
	const got = evaluate(c.input);
	if (got.decision !== c.want) {
		console.error(`  ✗ ${c.name}\n      got ${got.decision} (${got.reason}), want ${c.want}`);
		failed++;
	}
}

// ── the recorded shape, which is the durable legal artefact ────────────────────────────────────
{
	const got = evaluate({ ...comment("outsider", 4242, SIGN_PHRASE), active: ACTIVE, signatures: [] });
	const want = {
		name: "outsider",
		id: 4242,
		comment_id: 99,
		created_at: STAMP,
		repoId: 1037321962,
		pullRequestNo: 7,
		cla_version: "1.1",
		document_sha256: ACTIVE.icla_sha256,
	};
	for (const [k, v] of Object.entries(want)) {
		if (got.record?.[k] !== v) {
			console.error(`  ✗ signature record.${k} = ${JSON.stringify(got.record?.[k])}, want ${JSON.stringify(v)}`);
			failed++;
		}
	}
	// The archived action's fields must all survive, or cla/archive/v1.0-preincorporation.json
	// cannot be migrated by copy and the pre-incorporation evidence is stranded.
	for (const k of ["name", "id", "comment_id", "created_at", "repoId", "pullRequestNo"]) {
		if (!(k in (got.record ?? {}))) {
			console.error(`  ✗ signature record is missing the archived-format field ${k}`);
			failed++;
		}
	}
}

// ── the archived record migrates by copy ───────────────────────────────────────────────────────
{
	const archived = {
		status: "archived-preincorporation-not-relied-upon",
		signedContributors: [{ name: "bobikenobi12", id: 58654673, comment_id: 4758898121, created_at: STAMP, repoId: 1, pullRequestNo: 49 }],
	};
	const recs = records(archived);
	if (recs.length !== 1) {
		console.error(`  ✗ records() read ${recs.length} archived records, want 1`);
		failed++;
	}
	// It carries no cla_version, so it satisfies NOTHING — which is the point: that record is
	// explicitly "not relied upon", and the format being readable must not make it authoritative.
	if (hasSigned(recs, 58654673, "1.1")) {
		console.error("  ✗ the archived pre-incorporation record satisfied the v1.1 gate");
		failed++;
	}
}

// ── cla/ACTIVE parsing: a version that could escape the signatures directory is not a version ──
{
	const { writeFileSync, mkdtempSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const { readActive } = await import("./cla-check.mjs");
	const dir = mkdtempSync(join(tmpdir(), "cla-active-"));
	const cases = [
		["1.1", "1.1"],
		["1", "1"],
		["../../etc/passwd", null],
		["1.1/../..", null],
		["", null],
		["v1.1", null],
	];
	for (const [written, want] of cases) {
		const f = join(dir, `ACTIVE-${Buffer.from(written).toString("hex")}`);
		writeFileSync(f, `entity: "ALETHIA LABS"\ncla_version: "${written}"\n`);
		const got = readActive(f)?.cla_version ?? null;
		if (got !== want) {
			console.error(`  ✗ readActive(cla_version=${JSON.stringify(written)}) = ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
			failed++;
		}
	}
	if (readActive(join(dir, "does-not-exist")) !== null) {
		console.error("  ✗ readActive on an absent cla/ACTIVE did not return null — pre-activation must fail closed");
		failed++;
	}
}

// ── the helpers, directly ──────────────────────────────────────────────────────────────────────
for (const login of TRUSTED_ACTORS) {
	if (!isTrusted(login)) {
		console.error(`  ✗ isTrusted(${login}) = false for a listed actor`);
		failed++;
	}
}
for (const bad of [null, undefined, 42, "", "bot*", ["dependabot[bot]"]]) {
	if (isTrusted(bad)) {
		console.error(`  ✗ isTrusted(${JSON.stringify(bad)}) = true`);
		failed++;
	}
}
for (const bad of [null, undefined, [], "x", { signedContributors: "no" }, { signedContributors: [null, 1] }]) {
	if (records(bad).length !== 0) {
		console.error(`  ✗ records(${JSON.stringify(bad)}) did not degrade to an empty list`);
		failed++;
	}
}

if (failed > 0) {
	console.error(`\ncla self-test: ${failed} check(s) FAILED`);
	process.exit(1);
}
console.log(`cla self-test: all passed (${cases.length} decision cases + record, migration and helper checks)`);
