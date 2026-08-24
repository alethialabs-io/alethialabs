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
