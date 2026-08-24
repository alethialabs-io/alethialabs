# CLA status and activation

The agreements in this directory identify the registered company but remain
inactive drafts. They must not be signed until counsel approves the text and the
versioned activation record and signing workflow are enabled.

## Pre-activation rule

- Issues, discussions, and external pull requests may be opened.
- Only founder and explicitly allowlisted maintenance-bot contributions may merge.
- External code must not be copied manually around the legal gate.
- The founder's historic CLA record is archived for evidence but is not relied
  on for founder ownership; the founder assignment controls.

## Activation checklist

1. Obtain Bulgarian counsel approval of ICLA v1.1 and CCLA v1.1.
2. Remove the inactive-draft banners only after that approval.
3. Calculate SHA-256 hashes of both final documents.
4. Add `cla/ACTIVE` with the versions, hashes, effective date, and entity details.
5. Create the unprotected `cla-signatures` branch and seed `cla/signatures/v1.1.json`
   (see "Signature records" below). Activation installs the signing workflow itself.
6. Add the resulting `cla` context to every protected branch ruleset.
7. Test unsigned, signed, corporate, founder, and bot pull requests.

Steps 3-6 are performed by one command, not by hand:

```
pnpm legal:activate-ip --evidence /path/to/SIGNED_EVIDENCE.json    # dry run, verifies only
pnpm legal:activate-ip --evidence /path/to/SIGNED_EVIDENCE.json --apply
```

It refuses unless the sealed PDF exists, really is a PDF, and hashes to the value the manifest
claims, and unless the manifest's entity and EIK match `packages/legal/src/entity.ts`. Doing those
steps by hand is how a repository ends up claiming company ownership before the assignment is
signed. `pnpm legal:check-ip-activation` runs on every PR to prove the rewrite still matches the
current legal wording.

## Signature records

Records live on the dedicated, unprotected `cla-signatures` branch at
`cla/signatures/v<version>.json`, never on a code branch — a signature must not be reachable
through a pull request that also changes code. They must never be silently edited, and a material
agreement change creates a new version rather than amending one.

The gate is first-party. `contributor-assistant/github-action` was pinned here by immutable SHA
until its upstream was archived in March 2026; the replacement is `scripts/legal/cla-check.mjs`
(the decision, a pure function) and `scripts/legal/cla-run.mjs` (the I/O), with
`pnpm legal:check-cla-gate` running the fixtures on every pull request.

The record format is a **superset** of the archived action's, so no migration script is needed —
`cla/archive/v1.0-preincorporation.json` is readable as-is:

```json
{
  "cla_version": "1.1",
  "icla_sha256": "<sha256 of the ICLA at signing time>",
  "signedContributors": [
    { "name": "<login>", "id": 58654673, "comment_id": 4758898121,
      "created_at": "2026-06-20T16:02:50Z", "repoId": 1037321962, "pullRequestNo": 49,
      "cla_version": "1.1", "document_sha256": "<sha256>" }
  ]
}
```

The two added fields are what make the record durable:

- **`cla_version`** scopes a signature to the document it was given against. The archived
  pre-incorporation record carries none, so it satisfies no gate — which is correct, since it is
  explicitly not relied upon.
- **`document_sha256`** pins *which text* was signed, so the agreement cannot be edited under a
  signature after the fact.

`id` is the numeric GitHub user id and it is the lookup key. A login can be released and
re-registered by somebody else; an id cannot. A renamed contributor keeps their signature, and
whoever takes over their old login does not inherit it.

## Corporate agreements, revocation, and supersession

The signature document carries three collections, not one. Their shapes are a superset of the
archived action's, so the migration note above still holds.

```json
{
  "cla_version": "1.1",
  "signedContributors": [ /* individual signatures, as above */ ],
  "corporateAgreements": [
    {
      "organization": "Acme GmbH",
      "ccla_version": "1.1",
      "document_sha256": "<sha256 of the CCLA that was signed>",
      "effective_at": "2026-09-01T00:00:00Z",
      "covered_ids": [6001, 6002],
      "authorization_reference": "CCLA-2026-0001"
    }
  ],
  "revocations": [
    { "id": 4242, "cla_version": "1.1", "revoked_at": "2026-09-14T00:00:00Z",
      "revocation_reference": "REV-2026-0003" }
  ]
}
```

**What is deliberately NOT here.** A corporate agreement records the organization, the document, the
covered numeric ids, and an OPAQUE reference to the authorization. Who signed for the company, in
what role, and the letter proving they could — those stay offline. This branch is world-readable, and
a named signatory with their title and employer would be personal data published for no operational
reason: the gate only ever needs to answer "is this id covered?".

**Coverage order**, and each step is a decision somebody has to be able to defend:

1. **Revocation wins**, over an individual signature and over a corporate agreement alike. Anything
   weaker makes revoking advisory.
2. **A corporate agreement supersedes an individual signature.** This is the supersession case that
   actually happens: someone signs personally, later joins a company with a CCLA, and from then on
   contributes under their employer's authority. Reporting the individual signature would name the
   wrong instrument.
3. **Otherwise the individual signature.**

A revocation does not delete the original signature. It was true when it was given, and the
contributions made under it were lawfully licensed; what changes is coverage from the revocation
forward. Reinstatement is an administrative act on this branch — a revoked contributor cannot restore
themselves by commenting the phrase again.

## Every commit author, not the pull request's author

The gate checks **each commit's author** by numeric GitHub id, not `pull_request.user`. A branch can
carry commits authored by somebody else — a rebase of another person's work, a co-author, a fork a
second person pushed to — and checking only the opener licenses all of it on one signature from
someone who did not write it.

Two consequences worth knowing before they surprise somebody:

- A commit whose author email belongs to **no GitHub account** has no stable identity, so nothing can
  cover it. It is reported, not skipped — a skipped author is an unlicensed contribution that looks
  fine. The fix is on the contributor's side: set the commit author email to one on their account.
- If the commit list cannot be read at all — an API error, or a pull request past GitHub's 250-commit
  ceiling for that endpoint — the gate **fails closed**. Falling back to the opener would silently
  narrow the check to the case this widened, while still reporting a pass.

## Document seals

`cla/DOCUMENTS.json` pins the SHA-256 of ICLA.md and CCLA.md, and
`pnpm legal:check-cla-hashes` fails the build when either moves without its version being bumped
alongside. The agreements are still drafts, and sealing them now is the point rather than a
contradiction: the window between counsel approving the text and `pnpm legal:activate-ip` switching
enforcement on is exactly when an unnoticed edit would be most damaging.

Once `cla/ACTIVE` exists the same check asserts it agrees with the seal — same version, same hash,
and every document marked `active` — because a signature recorded against one text while the gate
checks another is worth nothing.

## A note on what activation claims

The activation rewrite says the company **owns the exclusive economic rights in** the scheduled
works. It does not say the company owns the works. Economic rights transfer; moral rights are
inalienable under Bulgarian copyright law and stay with the author however the instrument is worded.
A flat ownership claim would assert something the controlling instrument does not grant — and it is
the claim a commercial licensee would rely on.
