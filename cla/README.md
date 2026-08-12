# CLA status and activation

The agreements in this directory contain the final post-registration entity
details for ALETHIA LABS EDPK, EIK 208913663. They are not active until
`cla/ACTIVE` records their exact hashes and the signing workflow is enabled.

## Pre-activation rule

- Issues, discussions, and external pull requests may be opened.
- Only founder and explicitly allowlisted maintenance-bot contributions may merge.
- External code must not be copied manually around the legal gate.
- The founder's historic CLA record is archived for evidence but is not relied
  on for founder ownership; the founder assignment controls.

## Activation checklist

1. Execute and archive the founder-to-company IP ownership pack.
2. Calculate SHA-256 hashes of ICLA v1.1 and CCLA v1.1.
3. Copy `ACTIVE.example` to `ACTIVE`, retaining the exact hashes and effective date.
4. Enable the pinned CLA Assistant signing job and signature storage branch.
5. Add the resulting `cla` context to every protected branch ruleset.
6. Test unsigned, signed, corporate, founder, and bot pull requests.

Signature records belong on the dedicated `cla-signatures` branch and must never
be silently edited. A material agreement change creates a new version.

The activation command verifies the sealed signed PDF, writes `cla/ACTIVE`,
switches the ownership notices, and installs the prepared active workflow:

```sh
pnpm legal:activate-ip -- \
  --evidence ../management/legal-source/artifacts/Intellectual_Property_Licensing/Chain_of_Title/2026-08-12_AlethiaLabs_EDPK_IP_Ownership_Execution_Pack/signed/SIGNED_EVIDENCE.json \
  --apply
```

Before merging that activation commit, create the unprotected
`cla-signatures` branch, add the resulting `cla` status context to every branch
ruleset, and run the five scenarios above. The pinned CLA action's upstream
repository was archived in March 2026; its immutable pin is usable, but it must
be reassessed or replaced before the next CLA version.
