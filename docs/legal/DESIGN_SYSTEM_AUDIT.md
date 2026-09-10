# Design-system provenance and similarity audit

Status: internal control record, 29 July 2026

## Outcome

The component system can continue to ship, subject to ordinary third-party
licence compliance. The current bracket-and-dot logo is on a **clearance hold**:
it is not approved for trade mark filing or major new brand investment until
counsel reviews materially similar public marks, especially Respan.

This is an engineering and provenance audit, not a legal clearance opinion.

## Repository lineage checked

| Evidence | Finding |
|---|---|
| `packages/assets/static/brand/` history | Current logo kit first appears in founder-authored commits on 16 June 2026 and was moved into shared packages on 26 June 2026. Preserve those commits and editable vectors. |
| `.claude/skills/alethia-design/` history | Design skill entered as the Vertex predecessor on 15 June 2026, was renamed on 16 June, and synchronized from the founder's Claude design workflow on 17 June. |
| `packages/brand/src/tokens.css` history | Token ancestry includes Trellis/Vertex/Alethia stages in the same founder-controlled repository. |
| Current source search | Stale `VertexDesignSystem_8c015f`, `vertex-scroll`, `vertex-blink`, and misleading “TOVR-inspired” implementation labels were removed or replaced with Alethia/provenance terminology. |
| Founder statement | The founder identifies `bb-thesis-2026` / Vertex and the current Alethia work as independently created predecessor works. This remains subject to the university-policy check and signed founder assignment. |

## Third-party implementation inputs

| Input | Role | Control |
|---|---|---|
| Base UI and formerly Radix | Accessible interaction primitives | Preserve upstream package licences and local migration history. |
| shadcn-derived component patterns | Component scaffolding and conventions | Preserve applicable MIT attribution and do not represent generic scaffolding as exclusive visual IP. |
| Lucide | Interface icons | Preserve ISC notice. |
| Space Grotesk | Display/wordmark text | Preserve OFL; convert wordmark text to outlines before a figurative filing. |
| Geist / Geist Mono | Interface type | Preserve OFL. |
| Noto Sans | Localization/fallback | Preserve OFL. |

No stock logo, traced logo, commissioned design, or AI-generated raster is
approved as a source for the canonical mark. If that statement becomes
inaccurate, release and filing must pause until the ledger is corrected.

## Reference-use boundary

TOVR was an aesthetic reference only. Approved reusable ideas are generic:
monochrome palettes, technical typography, hairline borders, dense dashboards,
spacing scales, and conventional controls. TOVR source code, text, custom
illustration, animation, branded iconography, and distinctive screen
compositions are not approved inputs.

For every externally named reference, reviewers must compare rendered screens,
not merely source comments. A literal similarity finding requires replacement
of the expression and a record of the new author/source.

## Logo similarity record

The canonical Alethia device uses two inward-facing angular brackets with a
center dot. Public image searching on 29 July 2026 identified:

- Respan's official software/AI app icon, using two inward-facing brackets and
  a center dot: https://www.respan.ai/brand
- Seven Dot Limited's related corner-bracket/center-dot device:
  https://www.trustpilot.com/review/sevendot.io
- brace/bracket-and-dot stock-vector motifs:
  https://www.vectorstock.com/royalty-free-vectors/pair-programming-vectors

The devices are not necessarily identical, and public similarity alone does
not establish infringement or registrability. The commercial proximity and
common geometry mean the current symbol may be weak and difficult to own
broadly. Required action: keep the wordmark usable, prepare a non-bracket
replacement concept, and obtain a professional figurative search before filing.

## Connector marks record

Added 2 September 2026 (issue #3802). The connector catalog
(`packages/core/categories/catalog.json`) named 18 icon slugs while
`packages/assets/static/icons/` held 9, so 19 catalog rows asserted a path with
no file behind it. Eighteen of them now declare `icon_url: null`, which the
console renders as a monogram tile; one (`docr`) was repointed to
`/digitalocean/favicon_64x64.png`. `apps/console/scripts/gen-connectors.mjs`
refuses a path that does not resolve. No third-party mark was added, because an
engineering review on 2 September 2026 could not establish permissive terms for
any of them:

| Slug(s) | Owner | Finding |
|---|---|---|
| `ecr-xacct`, `oci-ecr`, `oci-public-ecr`, `aws-sm-xacct` / `gar-xacct`, `gcp-sm-xacct` / `acr-xacct`, `azure-kv-xacct` | AWS · Google · Microsoft | Hyperscaler marks carry materially stricter terms than the OSS ones. Held for a maintainer/counsel decision, not a lane's. Note that `/aws`, `/gcp` and `/azure/favicon_64x64.png` already ship and already render for the built-in cloud rows, and `alibaba-kms-xacct` already reuses `/alibaba/favicon_64x64.png` — so a decision to reuse those files would add no new asset. |
| `harbor` | CNCF / Linux Foundation | `cncf/artwork` carries no LICENSE file. The Linux Foundation trademark usage policy forbids using a Foundation logo "on posters, brochures, signs, websites, or other marketing materials to promote your events, products or services without written permission", and forbids displaying a logo "with colour variations" — the console renders connector marks grayscale by default. Not established as permissive. |
| `quay` | Red Hat, Inc. | Red Hat logo use requires written permission. |
| `infisical` | Infisical Inc. | Repository is MIT, which grants no trademark rights; no separate brand grant found. |
| `doppler`, `onepassword`, `scaleway-cr` | Doppler · 1Password · Scaleway | No public grant found permitting a third party to embed the mark in a commercial product UI. |
| `generic-cr`, `oci-generic-cr`, `helm-https` | none | Not a brand at all — a neutral in-house glyph would carry no trademark question. Not authored here. |
| `docr` | DigitalOcean, LLC | Repointed to the already-committed `/digitalocean/favicon_64x64.png` that the built-in `digitalocean` cloud row already renders. No new asset. |

Two open items for the maintainer. First, the nine marks that already ship
(`bitbucket`, `cloudflare`, `datadog`, `dockerhub`, `github`, `gitlab`,
`grafana`, `prometheus`, `vault`) predate this record and were not cleared
against the same test; `prometheus` and `vault` in particular sit under the
Linux Foundation policy quoted above, and the grayscale rendering applies to all
nine. Second, whether reusing an already-committed hyperscaler favicon for the
cross-account rows is acceptable is the decision held above. The published terms
for those nine marks were gathered on 8 September 2026 and are recorded in the
next section; the decision on them remains open.

## The nine shipping connector marks — terms as published

Added 8 September 2026 (issue #3907), which was raised by the open item recorded
in the preceding section. This section **gathers each mark's published terms so
that a person can rule on them**. It states findings only. It decides nothing,
recommends nothing, and no catalog row, `icon_url` or rendering was changed by
the change that added it.

### Scope and method

The nine marks are `bitbucket`, `cloudflare`, `datadog`, `dockerhub`, `github`,
`gitlab`, `grafana`, `prometheus` and `vault`. Each was read against its own
owner's published policy on **8 September 2026** — mark by mark, not grouped by
category, because grouping by category is the assumption #3876 started from and
disproved. Every quotation below is from the page named beside it, read on that
date. Nothing here is recalled from memory or inferred from a sibling project's
policy.

Two facts about how these marks are rendered bear on every row, and are stated
once here rather than nine times:

- `ConnectorIcon` (`apps/console/components/connectors/connector-icon.tsx`)
  applies `grayscale opacity-90` unless `mono={false}` is passed, and `mono`
  defaults to `true`. **But the default is not what the console does.** Every
  call site passes `mono={!isConnected}` — `connector-card.tsx:114,121`,
  `connector-row.tsx:78,85` and `connector-detail-sheet.tsx:149,155` — so a
  **connected** connector's mark renders in FULL COLOUR and UNMODIFIED, and only
  a **disconnected** one is desaturated. The component's own doc comment says as
  much: "pass `mono={false}` to show it in full color — e.g. for a connected
  connector."

  **So there are two questions per mark, not one**, and they can have different
  answers. A colour-alteration clause reaches the disconnected state and does not
  reach the connected one. Where an owner grants use conditioned on the logo
  being unmodified, the connected state is what satisfies that condition and the
  desaturated state is what fails it — `vault` and `bitbucket` are the rows where
  this decides the answer rather than merely refining it.

  An earlier draft of this section said a mark is desaturated "wherever the
  console renders it". That was false, and it was the sentence the nine rows
  below would have been read through.
- The console is the UI of a commercial product, and the connector surfaces the
  marks appear on identify third-party services the product integrates with.

### `bitbucket` — Atlassian

- **Owner / policy.** Atlassian. *Trademark*, <https://www.atlassian.com/legal/trademark>, read 8 September 2026.
- **Colour.** Not addressed as colour. The only modification clause is the
  condition attached to the permitted use: logos must be "depicted exactly as
  shown in the preceding link, without any modification (aside from re-sizing)"
  (Atlassian, *Trademark*).
- **Commercial use.** Addressed, and partly permitted: the same clause allows
  use of "the Atlassian logo or product logos … to identify that your own
  products are designed for and compatible with Atlassian's products", on that
  no-modification condition. "All other usages of the Atlassian logos require
  the written approval of Atlassian."
- **Silent?** No.

### `cloudflare` — Cloudflare, Inc.

- **Owner / policy.** Cloudflare, Inc. *Trademark and Brand Policy*, <https://www.cloudflare.com/trademark/>, read 8 September 2026.
- **Colour.** Addressed for web badges only: "Please do not alter Cloudflare web
  badges in any way (e.g., stretched out, different colors, etc)" (Cloudflare,
  *Trademark and Brand Policy*). The page carries no separate colour clause for
  the logo itself.
- **Commercial use.** Addressed: "Use of the Cloudflare logos (other than the
  use of Web Badges described below) requires our written permission."
- **Written permission.** Required for logo use outside the web-badge programme.
- **Silent?** No.

### `datadog` — Datadog, Inc.

- **Owner / policy.** Datadog, Inc. No dedicated trademark policy page was
  found; `https://www.datadoghq.com/legal/trademark-policy/` returned HTTP 404
  on 8 September 2026. Two pages carry the terms: the brand and press page,
  <https://www.datadoghq.com/about/resources/>, and the *Website Terms of Use*,
  <https://www.datadoghq.com/legal/terms/> (the page states an effective date of
  25 October 2024). Both read 8 September 2026.
- **Colour.** Addressed on the brand page, as a list of logo "don'ts": "Don't
  modify color of logo", alongside "Don't invert white logo" and "Don't invert
  purple logo" (Datadog, brand and press page).
- **Commercial use.** Addressed in the *Website Terms of Use*: "You are not
  permitted to use these Marks without the prior written consent of Datadog or
  such third party."
- **Written permission.** Required, on the face of the terms of use.
- **Silent?** No — but note that the governing statement sits in a website terms
  of use rather than in a trademark policy, and that the brand page states
  aesthetic rules without stating who may rely on them.

### `dockerhub` — Docker, Inc.

- **Owner / policy.** Docker, Inc. *Trademark Guidelines*,
  <https://www.docker.com/legal/trademark-guidelines/>, and the brand assets
  page, <https://www.docker.com/company/newsroom/media-resources/>. Both read
  8 September 2026.
- **Scope.** The guidelines name the mark expressly: their list of Marks
  includes "DOCKER HUB" and the "Docker 'Moby Dock' whale logo".
- **Colour.** The trademark guidelines do not address colour. The brand assets
  page does: "The Docker logos must always appear as one of Docker's primary
  brand colors. This includes our Ocean Blue, Light Blue, Deep Blue, and White"
  (Docker, brand assets page). Grey is not among the four named colours.
- **Commercial use.** Addressed: "All other uses are prohibited except by
  express written permission, requested in advance, which we may grant or deny
  in our sole discretion" (Docker, *Trademark Guidelines*). The guidelines'
  website section addresses use of the word marks to "name or accurately
  describe Docker's products, services or technology"; it does not state a
  corresponding grant for the logo.
- **Written permission.** Required for uses outside those the guidelines
  enumerate.
- **Silent?** No.

### `github` — GitHub, Inc.

- **Owner / policy.** GitHub, Inc. `https://github.com/logos` redirects (HTTP
  301) to the brand site, <https://brand.github.com/foundations/logo>, read
  8 September 2026.
- **Colour.** Addressed, and in two directions. The page states which colours
  are permitted — "The Invertocat and our wordmark should only appear in white,
  black, or in few cases grey or green" — and separately states "Do not modify
  the permitted GitHub logos, including changing the color, dimensions, or
  combining with other words or design elements" (GitHub, brand site). Both
  sentences are recorded because they are not obviously consistent with each
  other for the case at hand: grey appears in the permitted list, while
  desaturating a supplied colour asset is a change of colour. Which of the two
  governs a CSS `grayscale` filter applied to GitHub's own colour PNG is a
  question for the maintainer, not a finding.
- **Commercial use.** Addressed: "Do not use GitHub trademarks, logos, or
  artwork without GitHub's prior written permission", and "Do not use any GitHub
  logo as the icon or logo for your business/organization, offering, project,
  domain name, social media account, or website."
- **Written permission.** Required on the face of the page.
- **Silent?** No.

### `gitlab` — GitLab Inc.

- **Owner / policy.** GitLab Inc. *Trademark Guidelines*,
  <https://handbook.gitlab.com/handbook/marketing/brand-experience/trademark-guidelines/>,
  and *Trademarks at GitLab*,
  <https://handbook.gitlab.com/handbook/legal/trademarks-at-gitlab/>. Both read
  8 September 2026, from the handbook's committed Markdown source, because the
  rendered pages did not return their body text to an automated fetch.
- **Colour.** Not addressed as colour. Section 2.1.3 prohibits "Alter, animate,
  distort, or misappropriate the Trademarks" (GitLab, *Trademark Guidelines*).
- **Commercial use.** Addressed, and the position is stated as a default
  refusal: "Use of the Logos is not permitted under these Guidelines, except for
  the limited purpose set out in Section 3.1. below." Section 3.1 is the
  distribution of an unmodified copy of the Community Edition software, which is
  not the use here. *Trademarks at GitLab* states the third-party route: "An
  Authorization to use GitLab Materials must be signed by any third party
  wanting to include GitLab's name or logo on their website or other marketing
  materials, if use of GitLab's name or logo for the requested purposes is not
  already covered in an existing agreement."
- **Written permission.** Required — a signed authorization, per the handbook.
- **Silent?** No.

### `grafana` — Raintank, Inc. dba Grafana Labs

- **Owner / policy.** Raintank, Inc. dba Grafana Labs. *Trademark Policy*,
  <https://grafana.com/trademark-policy/>, read 8 September 2026.
  (`https://grafana.com/legal/trademark-policy/` returned HTTP 404 on the same
  date; the policy lives at the path above.) The page shows no effective or
  last-updated date.
- **Colour.** Addressed expressly: "Do not alter the Grafana Labs Marks,
  including modifying any logo or design, adding or deleting any words, or
  changing any color or proportions" (Grafana Labs, *Trademark Policy*).
- **Commercial use.** Addressed: "Do not use the Grafana Labs Marks in or on any
  website, promotion or marketing materials, merchandise items or publications
  without express written permission from Grafana Labs."
- **Written permission.** Required on the face of the policy.
- **Silent?** No.

### `prometheus` — The Linux Foundation (CNCF graduated project)

- **Owner / policy.** prometheus.io states that Prometheus is a Cloud Native
  Computing Foundation graduated project and carries the footer "© 2026 The
  Linux Foundation. All rights reserved." with a link to the Foundation's
  trademark usage page. "Prometheus®" appears on the Linux Foundation trademark
  list, <https://www.linuxfoundation.org/trademarks>. The governing policy is
  the *Trademark Usage Policy*,
  <https://www.linuxfoundation.org/legal/trademark-usage>. The CNCF brand
  guidelines, <https://www.cncf.io/brand-guidelines/>, point to the same policy.
  All read 8 September 2026.
- **Colour.** Addressed expressly: "A logo should not be displayed with color
  variations, or with other elements superimposed on top of the logo" (The Linux
  Foundation, *Trademark Usage Policy*).
- **Commercial use.** Addressed expressly: "Do not use a logo of The Linux
  Foundation on posters, brochures, signs, websites, or other marketing
  materials to promote your events, products or services without written
  permission from The Linux Foundation."
- **Written permission.** Required on the face of the policy. The CNCF brand
  guidelines put the same point less formally: "Please check in with us before
  using our logo on websites, products, packaging, manuals, or for other
  commercial or product use."
- **Silent?** No.
- **Scope caveat, recorded because it bounds the quotation above.** The Linux
  Foundation policy states that "Projects operating as separately incorporated
  entities managed by The Linux Foundation have their own trademarks, policies
  and usage guidelines." Prometheus is not such an entity, and Prometheus®
  appears on the Foundation's own trademark list, so the policy quoted here
  applies on its face. Whether a separate Prometheus-specific brand policy
  exists elsewhere was not established; none was found.

### `vault` — HashiCorp

- **Owner / policy.** HashiCorp. *Trademark Policy*,
  <https://www.hashicorp.com/en/trademark-policy>, read 8 September 2026.
- **Colour.** Addressed expressly: "Do not modify the color, background,
  rotation, angle, aspect ratio, or other attribute of any logo" (HashiCorp,
  *Trademark Policy*).
- **Commercial use.** This is the one mark of the nine whose owner publishes an
  affirmative grant that does not require asking first: "We currently allow
  (without separate permission required) the use of the current versions of the
  graphic logos for our source-available projects on your own website, so long
  as they are used only to identify and hyperlink to main page of the specific
  HashiCorp project website (or to www.hashicorp.com)." The grant is conditioned
  — it reaches the *current* version of the logo, for a *source-available*
  project, used *only* to identify and hyperlink to the project's page. Outside
  it, "All other uses of our logos must be approved in writing by HashiCorp's
  marketing division." The policy separately lists "Claiming HashiCorp approval
  or endorsement of products and/or services" as a prohibited use.
- **Written permission.** Not required within the stated grant; required outside
  it.
- **Silent?** No.

### Summary

| Mark | Owner | Grayscale / colour addressed? | Commercial-use addressed? | Written permission required? | Silent? |
|---|---|---|---|---|---|
| `bitbucket` | Atlassian | Only via "without any modification (aside from re-sizing)" | Yes — a compatibility grant, plus "all other usages … require the written approval" | Outside the compatibility grant | No |
| `cloudflare` | Cloudflare, Inc. | For web badges only ("different colors") | Yes | Yes, for logos outside the badge programme | No |
| `datadog` | Datadog, Inc. | Yes — "Don't modify color of logo" | Yes, in the *Website Terms of Use* | Yes — "prior written consent" | No (but no dedicated trademark policy page) |
| `dockerhub` | Docker, Inc. | Yes, on the brand page — four named colours, grey not among them | Yes | Yes — "express written permission, requested in advance" | No |
| `github` | GitHub, Inc. | Yes, in two directions — grey is permitted; "changing the color" is prohibited | Yes | Yes — "prior written permission" | No |
| `gitlab` | GitLab Inc. | Only via "Alter … the Trademarks" | Yes — logo use not permitted outside CE redistribution | Yes — a signed Authorization | No |
| `grafana` | Grafana Labs | Yes — "changing any color or proportions" | Yes | Yes — "express written permission" | No |
| `prometheus` | The Linux Foundation | Yes — "should not be displayed with color variations" | Yes — names "websites … to promote your … products or services" | Yes | No |
| `vault` | HashiCorp | Yes — "Do not modify the color … of any logo" | Yes — an affirmative, conditioned grant for website use | No, inside the stated grant; yes outside it | No |

None of the nine is silent. Every owner publishes terms that reach both
questions, though `bitbucket` and `gitlab` reach the colour question only
through a general prohibition on altering the mark rather than a colour clause,
and `cloudflare`'s colour clause is written for its web badges.

### Two corrections to the record above, found while gathering these terms

Both concern statements in the preceding section, and both are recorded here
rather than by editing a dated record.

1. **`cncf/artwork` does carry a licence file.** The Connector marks record
   states that it "carries no LICENSE file". On 8 September 2026 the repository
   root contains `LICENSE.md`, and its history shows the file present since at
   least 26 November 2018 (as a rename of `LICENSE`). Its text reads: "All
   artwork in this repo is made available under the Linux Foundation trademark
   usage guidelines", and links to the same policy quoted above. The premise was
   inaccurate; the conclusion it supported — that the Linux Foundation policy is
   what governs, and that the repository grants nothing beyond it — is
   unchanged by the correction.
2. **No catalog row references the `prometheus` asset.**
   `packages/assets/static/icons/prometheus/prometheus-32x32.png` is committed
   and, like every file under `packages/assets/static`, is copied into each
   app's `public/` by `scripts/sync-public-assets.mjs` — so it is served. But
   `packages/core/categories/catalog.json` contains no `prometheus` row, and no
   source file references `/icons/prometheus/`. The mark ships as a public file
   that nothing renders. The other eight are each referenced by at least one
   catalog row.

### What the maintainer is being asked to decide

Per mark: whether the terms quoted above permit the console's present use — a
desaturated third-party mark on the connector surfaces of a commercial product —
and, where they do not on their face, whether to seek the written permission
each owner names or to withdraw the mark.

The issue bounds the outcomes to three, and they are not exclusive across the
nine:

1. **The use is within the terms** — the reason is recorded per mark here, and
   the question is closed with an auditable answer rather than an absence.
2. **Some marks are not** — those rows go `icon_url: null` and render the
   monogram fallback that already exists, exactly as the eleven from #3876 do.
   No code change beyond the catalog.
3. **The grayscale rendering is the problem rather than the marks** — then the
   change is at the six call sites rather than in `connector-icon.tsx`: they pass
   `mono={!isConnected}`, so third-party marks would pass `mono={false}`
   unconditionally and the marks stay. Note this only affects the DISCONNECTED
   state; the connected one already renders unmodified.

One finding narrows the decision and is worth stating separately: `vault` is the
only one of the nine whose owner publishes an affirmative grant for website use
without separate permission, and that grant is conditioned on the logo being
unmodified and used to identify and hyperlink to the project page. Whether the
console's use meets those conditions is a determination, not a finding, and is
left here for the maintainer.

## Release and change controls

1. Every new asset records creator, date, source, tools, licence, and assignment.
2. New named references receive rendered-screen comparison and a written result.
3. Brand vectors, wordmarks, and tokens require brand CODEOWNER review.
4. Third-party fonts, icons, and primitives remain in the licence inventory.
5. The logo clearance hold can be removed only by a dated counsel decision or
   an approved replacement with a fresh search record.
