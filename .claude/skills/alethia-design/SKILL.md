---
name: alethia-labs-design
description: Use this skill to generate well-branded interfaces and assets for Alethia Labs and its product Alethia (a multi-cloud Kubernetes control plane), for production or throwaway prototypes/mocks. Contains design guidelines, colors, type, fonts, assets, and UI kit components. The system is fully grayscale (no hue at all), dark-signature, with Geist / Geist Mono / Space Grotesk, square controls, the .vx-clamp corner-mark interaction primitive, and the interim [·] bracketed-point mark.
user-invocable: true
---

# Alethia Labs Design System

Read `readme.md` in this skill first — the full design guide and manifest (content fundamentals, visual foundations, iconography, component & UI-kit index). Then explore the other files.

## What's here
- `styles.css` — the single CSS entry point (link this). Pulls in all tokens, fonts, and component classes.
- `tokens/` — colors (grayscale ink ramp + dark/light themes), typography, spacing, effects, motion.
- `components/` — React primitives (Button, Badge, Input, Select, Checkbox, Radio, Switch, Card, Avatar, Separator, Tabs, StatusBadge, Alert, Spinner, Kbd). Bundled into `_ds_bundle.js`, exposed on `window.AlethiaDesignSystem` (internal namespace id; stable).
- `ui_kits/` — full interactive recreations: `alethia-platform` (the platform control-plane dashboard) and `alethia-labs-site` (alethialabs.io company landing).
- `guidelines/` — foundation specimen cards.
- `assets/` — the `[·]` mark, Alethia Labs (company) + Alethia (platform) lockups, favicon/app-icon, and original cloud-provider + integration brand marks.

## How to work
- **Visual artifacts** (slides, mocks, throwaway prototypes): copy the assets you need out, link `styles.css` + `_ds_bundle.js`, build static HTML. Use `class="dark"` on `<html>` (dark is the signature theme).
- **Production code:** copy assets and read the rules here to design as an expert in the brand.

> **The code is authoritative when this skill disagrees with it.** `packages/brand/src/tokens.css`
> is the shipped system; `docs/legal/DESIGN_SYSTEM_AUDIT.md` says so explicitly. Everything below
> was re-checked against that file, not against this one.

## Non-negotiables
- **Fully grayscale. There is no Alethia hue.** The conversion blue this skill used to reserve for one CTA **is gone** — `tokens.css` records why: it was the only thing on the site that broke the rule the rest of the system is built on, and on a dark surface it read as a foreign element rather than as emphasis. The trial button is solid ink now. Third-party provider and integration marks keep their own colours; they are logos, not our palette. Status uses dot fill/shape + a mono label (`StatusBadge`), never hue.
- **The clamp `.vx-clamp` is the interaction primitive** — four masked corner arms drawn on a `::before`, defined once in `packages/brand/src/tokens.css` and baked into the base `cva` of ten `@repo/ui` components (button; card and badge when `interactive`; tabs, accordion, segmented-control, table rows, checkbox, switch; status-badge when `live`). **You do not hand-write it** — you use the primitive and it comes for free. Modifiers: `--tight` · `--card` · `--field` · `--held` · `--live` · `-none` to opt out · `[data-clamped]` to hold it open.
  Three traps its source records, all of which have cost real time:
  - It is deliberately **unlayered**, so a Tailwind arbitrary utility (`[--cl-len:20px]`) lands in `@layer utilities` and **silently loses**. Use the modifier classes.
  - **Replaced elements render no `::before`** — an `<input>` can never clamp itself. Put the clamp on the wrapping label and add `--field` for `:focus-within`.
  - `--cl-ink` defaults to `var(--text-primary)`, **not** `currentColor` — otherwise a solid button paints four white marks on white.
- **The interim mark is `[ · ]`** — a focal point inside brackets (aletheia = truth, brought into focus). Lockup: mark + **Alethia** + tracked-mono **LABS**; platform lockup is **Alethia · PLATFORM**. It is on trademark-clearance hold: display on owned surfaces, but do not create partner kits, filings, or a major rollout. Note the mark and the clamp are different devices that look related: the mark is a logo, the clamp is a control's hover/focus state.
- **Type:** Geist is the display face **and** the UI face — `--font-display` resolves to `var(--font-geist-sans)`, and the `@layer base` h1–h4 rule sets Geist 700 / `-0.03em`. Space Grotesk reaches a page only through `--font-grotesk` (the `font-grotesk` utility), used on marketing display headlines and `.vx-prose h2`. Geist Mono for terminal, data, uppercase eyebrow labels and the LABS tag. Fonts load from Google Fonts via `tokens/fonts.css`.
- **Controls are square.** Button and Badge are `rounded-none` outright; the radius ladder (`xs 0 · sm 2 · md 3 · lg 4 · xl 6`) applies to surfaces, not controls. The blog forces `border-radius: 0` globally.
- **Voice:** terse, declarative, sentence case; UPPERCASE mono only for eyebrow labels. No emoji.
- **Structure over decoration:** hairline borders define surfaces; shadows are a whisper; the only background motif is a faint blueprint grid. No gradients.

## Names
**Alethia Labs** = the company (alethialabs.io). **Alethia** = the product/platform (control plane + the `alethia` CLI). CLI usage: `alethia login`, `alethia whoami`, `alethia deploy`.

If invoked without other guidance, ask what they want to build, ask a few focused questions, then act as an expert designer who outputs HTML artifacts *or* production code as needed.
