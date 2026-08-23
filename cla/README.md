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
5. Enable the pinned CLA Assistant signing job and signature storage branch.
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

Signature records belong on the dedicated `cla-signatures` branch and must never
be silently edited. A material agreement change creates a new version.
