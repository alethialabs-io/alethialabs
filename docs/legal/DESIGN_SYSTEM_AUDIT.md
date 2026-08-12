# Design-system provenance and similarity audit

Status: internal control record, 29 July 2026

## Outcome

The component system can continue to ship, subject to ordinary third-party
licence compliance. The current bracket-and-dot logo is on a **clearance hold**:
it is not approved for trade mark filing or major new brand investment until
counsel reviews materially similar public marks, especially Respan.

This is an engineering and provenance audit, not a legal clearance opinion.

## Repository lineage checked

| Evidence                                 | Finding                                                                                                                                                                                |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/assets/static/brand/` history  | Current logo kit first appears in founder-authored commits on 16 June 2026 and was moved into shared packages on 26 June 2026. Preserve those commits and editable vectors.            |
| `.claude/skills/alethia-design/` history | Design skill entered as the Vertex predecessor on 15 June 2026, was renamed on 16 June, and synchronized from the founder's Claude design workflow on 17 June.                         |
| `packages/brand/src/tokens.css` history  | Token ancestry includes Trellis/Vertex/Alethia stages in the same founder-controlled repository.                                                                                       |
| Current source search                    | Stale `VertexDesignSystem_8c015f`, `vertex-scroll`, `vertex-blink`, and misleading “TOVR-inspired” implementation labels were removed or replaced with Alethia/provenance terminology. |
| Founder statement                        | The founder identifies the pre-incorporation and current Alethia work as independently created predecessor works. This remains subject to the signed founder assignment.               |

## Third-party implementation inputs

| Input                             | Role                                  | Control                                                                                              |
| --------------------------------- | ------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Base UI and formerly Radix        | Accessible interaction primitives     | Preserve upstream package licences and local migration history.                                      |
| shadcn-derived component patterns | Component scaffolding and conventions | Preserve applicable MIT attribution and do not represent generic scaffolding as exclusive visual IP. |
| Lucide                            | Interface icons                       | Preserve ISC notice.                                                                                 |
| Space Grotesk                     | Display/wordmark text                 | Preserve OFL; convert wordmark text to outlines before a figurative filing.                          |
| Geist / Geist Mono                | Interface type                        | Preserve OFL.                                                                                        |
| Noto Sans                         | Localization/fallback                 | Preserve OFL.                                                                                        |

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

## Release and change controls

1. Every new asset records creator, date, source, tools, licence, and assignment.
2. New named references receive rendered-screen comparison and a written result.
3. Brand vectors, wordmarks, and tokens require brand CODEOWNER review.
4. Third-party fonts, icons, and primitives remain in the licence inventory.
5. The logo clearance hold can be removed only by a dated counsel decision or
   an approved replacement with a fresh search record.
