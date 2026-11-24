<!-- SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io> -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# Terms acceptance: wording, links and record

Effective: 2026-11-21

This record states what a person sees when they accept the Terms of Service in the console, which
documents that screen links, and what the console stores when they accept. It is the written half
of decision M31 (terms acceptance inline on onboarding). An agent wrote it; no lawyer reviewed it
(decisions of 2026-11-17).

The wording lives in one module, `apps/console/components/legal/terms-acceptance-copy.ts`. The
onboarding form and the `/accept-terms` page render from it. This page explains the module; the
module is what runs. The claims in `legal-set.json` tie the statements below to its lines.

## Where it is shown

- **Onboarding, inline.** The checkbox is one field of the onboarding form, under the other fields
  and above the form's own submit button. There is no separate page and no heading. WIZ-W6 builds
  this placement; until it merges, a new person accepts on the `/accept-terms` page.
- **The `/accept-terms` page.** Shown after sign-in when a document the person must accept has a
  version they have not accepted. This happens when a sealed document gets a new version.

## The wording

The checkbox label, for the current Terms:

> I have read and accept the Terms of Service (version 2026-11-24).

"Terms of Service" is a link to the Terms page. The version printed is the sealed version the
record will name. When more than one document must be accepted, each is listed with its own link
and version, as in "the A (version …) and the B (version …)".

Under the checkbox, one line links the Privacy Policy:

> How we use your personal data is explained in our Privacy Policy.

If the person submits with the box unticked:

> Tick the box to accept the Terms of Service.

On the `/accept-terms` page only, a heading and a short text sit above the box:

| Situation | Heading | Text |
|---|---|---|
| The person has never accepted any version of any document shown | Accept our Terms | Review and accept to continue. |
| The person accepted an earlier version of a document shown | Our Terms have changed (one document) or Updated agreements (several) | Read and accept to continue. Your work is untouched — nothing has been removed and nothing expires while you decide. |

The page's button reads "Accept and continue", and "Recording…" while the acceptance is saved.

### Why it is worded this way

- **"I have read and accept".** It states a positive act by the person. The e2e tests find the
  checkbox by this prefix, so it is one constant (`ACCEPTANCE_LABELS` in
  `packages/legal/src/documents.ts`) and the module reuses it.
- **The version is printed.** The stored record names a version. The person sees the same version
  they agree to.
- **The Privacy Policy is linked but not accepted.** Processing personal data does not rest on the
  person's agreement, so the checkbox does not say they accept it. A recorded acceptance of a notice
  would misstate the legal basis. The line under the box gives the link without asking for anything.
- **No first-time person is told the Terms "have changed".** That describes a history they do not
  have (#5009). Which heading shows is decided from the stored acceptances, not by the browser.
- **No beta or service-level wording.** The checkbox only names the documents. What the beta means
  is stated in the Terms themselves. When the Terms change, they get a new sealed version, and every
  person is asked again on the `/accept-terms` page.

## The rules the screen follows

1. The checkbox starts unticked. The onboarding form, and the `/accept-terms` button, cannot be
   submitted until it is ticked.
2. Each document is linked, and its version is shown.
3. Links use the instance's legal address (`legalUrl`, which reads `NEXT_PUBLIC_LEGAL_URL`), so a
   self-hosted console links its operator's pages, not the hosted site.

## What is linked

| Document | Linked as | Accepted |
|---|---|---|
| Terms of Service (`/terms`) | Part of the checkbox label | Yes |
| Privacy Policy (`/privacy`) | The line under the checkbox | No |

The accepted set is every document in `LEGAL_DOCUMENTS` with `acceptanceRequired: true`. Today that
is the Terms of Service alone. The cookie notice and the company information page are not linked
from the acceptance.

## The record

Accepting writes one row per accepted document to the `legal_acceptance` table, through the server
action `acceptLegalDocuments` in `apps/console/app/server/actions/legal.ts`.

| Field | Value | Set by |
|---|---|---|
| `documentId` | The document id, e.g. `terms` | The registry |
| `documentVersion` | The sealed version, e.g. `2026-11-24`, copied in at write time | The registry |
| `documentHash` | The sealed SHA-256 of the document's source file, copied in at write time | The registry |
| `locale` | `en` | The form |
| `context` | `signup` if the person never accepted any version of the document before, otherwise `reacceptance` | The server, from stored history |
| `userId` | The person | The session |
| `organizationId` | The organization, or empty at sign-up when none exists | The session |
| `acceptedAt` | The server's time | The database |
| `evidence` | The IP address, the user agent, the browser's own clock, and the surface `console-gate` | The request |

The version and the hash are copied in, never looked up later. The hash makes the version
reproducible: `scripts/check-legal-document-hashes.mjs` fails CI when a sealed source file changes
without its hash being updated, so the text a person accepted can be rebuilt from the repository.

Submitting twice does not add a second row for the same version. A new version always adds a new
row, and earlier rows are never changed.

The module's `acceptanceRecord` returns the first four fields for a list of document ids, from the
same registry the server action reads. The rest are known only on the server.

## For the onboarding unit (WIZ-W6)

WIZ-W6 owns `components/legal/accept-terms-form.tsx`, the onboarding form and the onboarding action.
When it moves the checkbox into onboarding it renders from this module and records the acceptance
through `acceptLegalDocuments`, as today. Two differences from the current gate form:

- The current form builds its links from `NEXT_PUBLIC_MARKETING_URL`. The module uses `legalUrl`,
  which reads `NEXT_PUBLIC_LEGAL_URL` like the console's footer.
- The current label prints the titles without versions, and lists the versions in a separate list.
  The module puts each version in the label itself.
