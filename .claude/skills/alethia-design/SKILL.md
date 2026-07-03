---
name: alethia-labs-design
description: Use this skill to generate well-branded interfaces and assets for Alethia Labs and its product Alethia (a multi-cloud Kubernetes control plane), for production or throwaway prototypes/mocks. Contains design guidelines, colors, type, fonts, assets, and UI kit components. The system is fully grayscale (no color), dark-first, with Space Grotesk / Geist / Geist Mono and the [·] bracketed-point mark.
user-invocable: true
---

# Alethia Labs Design System

Read `readme.md` in this skill first — the full design guide and manifest (content fundamentals, visual foundations, iconography, component & UI-kit index). Then explore the other files.

## What's here
- `styles.css` — the single CSS entry point (link this). Pulls in all tokens, fonts, and component classes.
- `tokens/` — colors (grayscale ink ramp + dark/light themes), typography, spacing, effects, motion.
- `components/` — React primitives (Button, Badge, Input, Select, Checkbox, Radio, Switch, Card, Avatar, Separator, Tabs, StatusBadge, Alert, Spinner, Kbd). Bundled into `_ds_bundle.js`, exposed on `window.VertexDesignSystem_8c015f` (internal namespace id; stable).
- `ui_kits/` — full interactive recreations: `alethia-platform` (the platform control-plane dashboard) and `alethia-labs-site` (alethialabs.io company landing).
- `guidelines/` — foundation specimen cards.
- `assets/` — the `[·]` mark, Alethia Labs (company) + Alethia (platform) lockups, favicon/app-icon, and original cloud-provider + integration brand marks.

## How to work
- **Visual artifacts** (slides, mocks, throwaway prototypes): copy the assets you need out, link `styles.css` + `_ds_bundle.js`, build static HTML. Use `class="dark"` on `<html>` (dark is the signature theme).
- **Production code:** copy assets and read the rules here to design as an expert in the brand.

## Non-negotiables
- **Grayscale only.** No color anywhere except third-party brand logos (provider/integration marks). Status is shown via dot fill/shape + a mono label (`StatusBadge`), never hue.
- **The mark is `[ · ]`** — a focal point inside brackets (aletheia = truth, brought into focus). Lockup: mark + **Alethia** + tracked-mono **LABS**; platform lockup is **Alethia · PLATFORM**.
- **Type:** Space Grotesk (display/headlines), Geist (UI/body, 14px base), Geist Mono (terminal, data, uppercase eyebrow labels, LABS tag). Fonts load from Google Fonts via `tokens/fonts.css`.
- **Voice:** terse, declarative, sentence case; UPPERCASE mono only for eyebrow labels. No emoji.
- **Structure over decoration:** hairline borders define surfaces; shadows are a whisper; the only background motif is a faint blueprint grid. No gradients.

## Names
**Alethia Labs** = the company (alethialabs.io). **Alethia** = the product/platform (control plane + the `alethia` CLI), formerly ADP at beta.adp.itgix.com. CLI usage: `alethia login`, `alethia whoami`, `alethia deploy`.

If invoked without other guidance, ask what they want to build, ask a few focused questions, then act as an expert designer who outputs HTML artifacts *or* production code as needed.
