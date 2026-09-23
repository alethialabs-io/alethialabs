<!-- SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io> -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# Activating company ownership — the exact steps

**Status:** not activated as of 2026-09-22 (`cla/ACTIVE` does not exist)
**Covers:** [#4923](https://github.com/alethialabs-io/alethialabs/issues/4923) §1 and §2

This file exists so the ownership switch is one command whenever the assignment is signed, rather
than a re-derivation. It does not decide anything; `scripts/legal/activate-company-ip.mjs` does.

## Read this first

**Do not hand-edit the ownership notices.** The eight files carrying them —
`LICENSE`, `NOTICE`, `COPYRIGHT.md`, `LICENSING.md`, `CONTRIBUTING.md`, `ee/LICENSE`,
`ee/README.md`, `cla/README.md` — hold **11 prose markers**, and the activation script requires each
to appear **exactly once**. It refuses to run otherwise, because *"zero means the wording drifted and
this script no longer knows what it is rewriting."*

So a well-meant manual reconciliation does not merely jump the gun — it **permanently disables the
mechanism built to do the job properly.** Verify at any time with:

```bash
node scripts/legal/activate-company-ip.mjs --check-markers
# expect: activation markers: ok (11 markers across 8 files)
```

Until activation, every notice saying the founder still owns the pre-incorporation works is
**accurate**, and must stay.

## What the script refuses on

Five independent fail-closed checks. Each one alone stops an activation:

1. `cla/ACTIVE` must not already exist — activation is once, not idempotent.
2. Every evidence field must match `packages/legal/src/entity.ts`, read from source, not copied.
3. The sealed file must exist, must actually begin `%PDF-`, and its SHA-256 must match the manifest.
4. Every prose marker must appear exactly once.
5. Nothing is written without `--apply`; the default is a dry run.

## Step 1 — sign the assignment

A founder-to-company assignment of the **exclusive economic rights** in the pre-incorporation works,
executed and sealed as a PDF.

⚠️ **Economic rights, not "ownership".** Moral rights are inalienable under Bulgarian copyright law
and remain with the author however the agreement is worded. Every marker the script writes therefore
says *"owns the exclusive economic rights in"*, never *"owns"* — a flat ownership claim asserts more
than the instrument grants, and it is exactly the claim a commercial licensee would rely on. Do not
soften this into the shorter phrase anywhere.

The schedule of assigned assets is anchored to a **commit SHA** (below), so decide the anchor before
signing — the signed schedule and the manifest must name the same one.

## Step 2 — write the evidence manifest

A JSON file beside the sealed PDF. Every field is validated:

```json
{
  "entity": "ALETHIA LABS",
  "eik": "208913663",
  "effective_date": "YYYY-MM-DD",
  "repository_anchor": "<full 40-character commit SHA, must exist in this repo>",
  "signed_file": "SIGNED_ASSIGNMENT.pdf",
  "signed_file_sha256": "<sha256 of that PDF>"
}
```

| field | must be |
|---|---|
| `entity` | exactly `LEGAL_ENTITY.legalName` — currently **ALETHIA LABS** |
| `eik` | exactly `LEGAL_ENTITY.registrationNumber` — currently **208913663** |
| `effective_date` | `YYYY-MM-DD`. The date the assignment takes effect, not the date you run this |
| `repository_anchor` | a **full 40-char** SHA that `git cat-file` resolves here. Deliberately not a baked-in constant: *"a constant baked in before signature is a value nobody has agreed to yet."* Read the printed anchor back against the signed schedule |
| `signed_file` | path **relative to the manifest** |
| `signed_file_sha256` | `shasum -a 256 <pdf>` |

`entity` and `eik` are read live from `packages/legal/src/entity.ts`. If the legal form changes,
update that file first — it is the single source, and a second copy is a second thing to forget.

## Step 3 — dry run, then apply

```bash
# dry run — reports every rewrite, writes nothing
node scripts/legal/activate-company-ip.mjs --evidence /path/to/SIGNED_EVIDENCE.json

# once the diff reads correctly
node scripts/legal/activate-company-ip.mjs --evidence /path/to/SIGNED_EVIDENCE.json --apply
```

Read the dry-run output in full. It is the only review this change gets, and it is rewriting the
repository's legal notices.

## Step 4 — after it runs

- `cla/ACTIVE` now exists and records the document hashes and the sealed evidence.
- The CLA becomes active; `cla/cla-active-workflow.yml` is installed.
- **The company must retain the sealed evidence.** The repository stores hashes, not the instrument.
- Point `ee/README.md` and `LICENSING.md` at
  [`OPEN_CORE_BOUNDARY_DECISION.md`](./OPEN_CORE_BOUNDARY_DECISION.md) — that indirection exists only
  because those files were marker-bearing, and after activation they are safe to edit.
- Re-run `--check-markers`: it will now fail on `cla/ACTIVE already exists`, which is the correct
  post-activation state and not a regression.

## What is NOT covered here

- **§4, the public template repositories** — already done on 2026-09-22. `alethia-starter-apps`,
  `-chart`, `-ai` and `alethia-examples` were public and `is_template` with **no licence at all**
  (all rights reserved). They now carry Apache-2.0 plus a `NOTICE`.
- **§3, the `ee/` boundary** — decided and recorded in
  [`OPEN_CORE_BOUNDARY_DECISION.md`](./OPEN_CORE_BOUNDARY_DECISION.md).
- **Counsel review.** This file describes the mechanism, not the instrument. Whether the assignment
  says the right things is a question for a lawyer, and §1 of #4923 tracks it.
