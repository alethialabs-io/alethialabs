<!--
SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
SPDX-License-Identifier: AGPL-3.0-only
-->

# Polish wave design spec (#7735, epic #7733)

The maintainer signed this off on 2026-11-26, against an interactive prototype canvas. It is the
spec for #7737, #7738, #7739, #7740, #7741 and #7742. Where a lane and this file disagree, this
file wins until the maintainer changes it.

Every value below uses the existing brand tokens (`packages/brand/src/tokens.css`). Nothing
here adds a colour: the system is grayscale, and state is shown by shape, fill and a mono label.

## 1. Intro splash (marketing only, once per browser session) — #7742

**Sequence** (it covers hydration and nothing more):

| t (ms) | What happens |
|---|---|
| 0–520 | The `[` and `]` slide in from ±56px, blur 6px → 0 and opacity 0 → 1, using the `.ah-mark` curve `cubic-bezier(.65,0,.35,1)`. The dot scales 0 → 1.25 → 1. |
| 380–1030 | "Alethia" (Space Grotesk 600, -0.035em) and "LABS" (Geist Mono 500, 0.22em) unfold from the dot: `max-width` 0 → measured, blur 3px → 0. This is the header logo's fold played in reverse, so the splash hands off visually to the header. |
| 760–1180 | The motto **"Truth, brought into focus."** fades up 6px (Geist Mono, 0.26em, uppercase, `--text-secondary`). |
| from hydration, floor ~420ms, cap ~1150ms | The overlay fades out over 240ms, `cubic-bezier(.22,1,.36,1)`. |

**Invariants** (ported from the TOVR global loader, each one learned from a production bug):
- Dismissal happens in a `useEffect`, which means "React hydrated". Never wait for `window` `load`.
- `pointer-events: none` goes on the overlay element itself. An invisible overlay that still
  catches clicks is worse than a visible one.
- Use `bg-background` and `text-foreground`. Never hardcode black, or light mode flashes.
- Read reduced motion with a media-query hook, not framer's hook, so server and client agree.
  With reduced motion the lockup appears complete with no motion and the splash leaves at the
  floor.
- Release the scroll lock when dismissal is decided, not at unmount.
- Mark it `aria-hidden`. It must not be the LCP element (check with Lighthouse), and CLS must be 0.
- **Once per session:** an inline `<head>` script reads `sessionStorage` before first paint and
  sets `data-intro="skip"` on `<html>`. CSS then hides the overlay, so a repeat load never
  flashes it.

## 2. The `[·]` mark loader — #7740

CSS only, like `.ah-mark`. Do not add a motion library.

- **Loop (1400ms, `cubic-bezier(.65,0,.35,1)`):** the brackets breathe ±2.2px horizontally with
  opacity .45 → 1. The dot scales .55 → 1 with blur 1.2px → 0: the mark comes into focus and
  drifts out, over and over.
- **Sizes:**
  - **inline 16px** (stroke 2.8): inside pending buttons. The button keeps its width, the label
    becomes the progressive verb ("Applying…"), and the button is disabled with
    `cursor: progress`. This replaces every ad-hoc spinner.
  - **region 40px**: for waits of unknown length (agent thinking, plan/apply running, sign-in
    callback, CLI hand-off). Pair it with a mono status line holding real facts: "Planning ·
    prod-eu · 0:12". Never show a fake percentage.
  - **full-page**: the shell's `MainPending` and the auth waits.
- **Skeletons stay** wherever the layout is known (RUBRIC skeleton rules). The mark never
  replaces a skeleton.
- With reduced motion, show the static mark at full opacity, plus the status line.

**Route hairline:** 2px of foreground ink at the top of the content area. It appears only when a
client navigation takes longer than 200ms, eases to about 86%, and completes and fades on
commit. The sidebar gets no spinner.

## 3. ListToolbar: one row, every list — #7737, #7738, #7739

```
[ Search <noun>   / ]  [Status: Failed, Provisioning ×] [Cloud ▾] [Region ▾] [range]  RESET · 2      [secondary] [Primary]
```

- **Removed:** the count pill and the `PageToolbar` description line. The row starts with the search box.
- **The page's actions join the row**, pushed to the far right. Use at most one primary.
- **Facet button:**
  - Unselected, it reads `Name ▾` in `--text-secondary`.
  - Selected, it reads `Name: A, B`, or `Name · N` once more than 2 are selected. It gets a
    raised border and background, and the chevron is replaced by a **× that clears just that
    facet**.
- **Facet popover:** 240px wide. Each option row has a checkbox, a label and a mono count, and the
  rows are 32px tall. Counts come from the **unfiltered** universe (existing `facets.ts` rule),
  so a selected option never disappears. Add a search input when there are more than 8 options.
- **Search:** 260px wide, with a `/` key hint. `/` focuses it from anywhere on the page that is
  not an input, and Esc clears it.
- **`RESET · N`:** mono, 0.14em, shown only while N > 0. N counts active facets plus search.
- **Empty filtered result:** "No <noun> match these filters." with a **Clear filters** button.
  This is distinct from the empty universe, which keeps its `EmptyState`.
- **Infinite scroll:** `ListFooter` auto-loads with an IntersectionObserver, and "Load more"
  stays as the keyboard and fallback path. At the end of the list it says
  `END OF LIST`, in mono.
- **Per-page variation** goes through `extra` only: a view toggle (overview), the grouped
  filter sheet (activity), or a quick range (usage). Nothing else may change the row's order.
- Everything stays in the URL (`useFilterUrlSync`), so a filtered view is a shareable link.

## 4. Error states — #7741

Use the promoted `@repo/ui/error-state` and `@repo/ui/region-error` (#7734).

- **Region error:** a title ("Clusters didn't load"), a sentence giving the cause and the
  consequence ("Everything else on this page is current. Your clusters are unaffected."), a
  **Try again** button that re-runs only that region's query, and a mono `ref <digest>`. There
  is one `error.tsx` per data region, so a failed panel never blanks the org page.
- **Mutation error:**
  - Field errors are mapped inline under the field (`form-errors.ts`), with a 1px foreground
    border and an icon.
  - Anything else gets one toast with **Retry**.
  - `useActionMutation` owns this, and no caller hand-writes `toast.error`.
- **404:** `[ 404 ]` set in the mark's brackets (Space Grotesk 600), then "Nothing here.", the
  likely reason, and actions (Back to projects / Switch organization).
- **Route and global error:** the mark with a hollow dot (the brand's "failed" shape), then
  "Something broke on our side.", then "Nothing in your cloud changed." This is the reassurance
  an infra product owes its users. Below that come Try again / Contact support and the mono
  `ref <digest> · <UTC time>`.
- **Copy:** plain and non-blaming. State what happened and what it means for the user. No
  exclamation marks and no emoji.
