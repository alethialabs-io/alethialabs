# CLA status and activation

The agreements in this directory are pre-registration drafts. They are not
active and must not be signed while Alethia Labs DPK lacks an EIK.

## Formation-period rule

- Issues, discussions, and external pull requests may be opened.
- Only founder and explicitly allowlisted maintenance-bot contributions may merge.
- External code must not be copied manually around the legal gate.
- The founder's historic CLA record is archived for evidence but is not relied
  on for founder ownership; the founder assignment controls.

## Activation checklist

1. Confirm exact registered name, form, EIK, address, and registration date.
2. Obtain Bulgarian counsel approval of ICLA v1.1 and CCLA v1.1.
3. Replace every pending field and remove the draft banner.
4. Calculate SHA-256 hashes of both final documents.
5. Add `cla/ACTIVE` with the version, hashes, effective date, and entity details.
6. Enable the pinned CLA Assistant signing job and signature storage branch.
7. Add the resulting `cla` context to every protected branch ruleset.
8. Test unsigned, signed, corporate, founder, and bot pull requests.

Signature records belong on the dedicated `cla-signatures` branch and must never
be silently edited. A material agreement change creates a new version.
