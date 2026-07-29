# Dependency and licence policy

Every shipped dependency must have an identified source, version, copyright
holder, licence, artifact scope, and required notices.

## Default policy

- MIT, ISC, BSD-2-Clause, BSD-3-Clause, Apache-2.0, and OFL-1.1 are normally
  acceptable with required notices.
- MPL-2.0 and LGPL dependencies require artifact-level review and compliance
  notes before release.
- GPL, AGPL, SSPL, Commons Clause, Business Source License, Functional Source
  License, and other reciprocal or source-available terms require explicit
  review before addition or version change.
- Unknown, missing, custom, or contradictory licence metadata fails closed.
- Build-only tools are recorded separately from runtime and distributed code.
- Enterprise artifacts may not include third-party copyleft code on the
  assumption that Alethia's proprietary licence overrides it.

## Release evidence

Clean release builds generate:

1. an SPDX or CycloneDX software bill of materials;
2. `THIRD_PARTY_NOTICES.md` for shipped components;
3. the community-source archive and checksum;
4. a review report for unknown or policy-restricted licences.

Lockfiles are discovery inputs, not proof of what a final container or binary
ships. Container and executable artifacts must be scanned directly.
