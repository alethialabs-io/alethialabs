---
name: alethia-design
description: Use this skill to generate well-branded interfaces and assets for Alethia (the multi-cloud Kubernetes control plane by Alethia), either for production or throwaway prototypes/mocks/etc. Contains essential design guidelines, colors, type, fonts, assets, and UI kit components for prototyping. The system is fully grayscale (no color), dark-first, with Space Grotesk / Geist / Geist Mono.
user-invocable: true
---

# Alethia Design System

Read `readme.md` in this skill first — it is the full design guide and manifest (content fundamentals, visual foundations, iconography, component & UI-kit index). Then explore the other files.

## What's here
- `styles.css` — the single CSS entry point (link this). Pulls in all tokens, fonts, and component classes.
- `tokens/` — colors (grayscale ink ramp + dark/light themes), typography, spacing, effects, motion.
- `components/` — React primitives (Button, Badge, Input, Select, Checkbox, Radio, Switch, Card, Avatar, Separator, Tabs, StatusBadge, Alert, Spinner, Kbd). They are bundled into `_ds_bundle.js` and exposed on `window.AlethiaDesignSystem_8c015f`.
- `ui_kits/` — full interactive recreations: `alethia-app` (control-plane dashboard) and `alethia-web` (marketing landing).
- `guidelines/` — foundation specimen cards.
- `assets/` — Alethia logo/mark, Alethia lockup, and original cloud-provider + integration brand marks.

## How to work
- **Visual artifacts** (slides, mocks, throwaway prototypes): copy the assets you need out, link `styles.css` + `_ds_bundle.js`, and build static HTML for the user to view. Use `class="dark"` on `<html>` (dark is the signature theme).
- **Production code:** copy assets and read the rules here to design as an expert in the brand.

## Non-negotiables
- **Grayscale only.** No color anywhere except third-party brand logos (provider/integration marks). Status is shown via dot fill/shape + a mono label (`StatusBadge`), never hue.
- **Type:** Space Grotesk (display/headlines), Geist (UI/body, 14px base), Geist Mono (terminal, data, and uppercase eyebrow labels). Fonts load from Google Fonts via `tokens/fonts.css`.
- **Voice:** terse, declarative, sentence case; UPPERCASE mono only for eyebrow labels. No emoji.
- **Structure over decoration:** hairline borders define surfaces; shadows are a whisper; the only background motif is a faint blueprint grid. No gradients.

If the user invokes this skill without other guidance, ask what they want to build, ask a few focused questions, then act as an expert designer who outputs HTML artifacts *or* production code as needed.
