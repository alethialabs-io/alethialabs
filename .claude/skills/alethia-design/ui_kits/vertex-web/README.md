# Alethia Web — UI kit (marketing landing)

A recreation of the **Alethia** marketing landing page (the source repo's `apps/trellis/components/landing`). Monochrome, editorial, terminal-forward.

## Run
Open `index.html`. Loads `../../styles.css` + `../../_ds_bundle.js`, then `sections.jsx`.

## Sections
- **Header** — brand lockup, nav, GitHub, Get started.
- **Hero** — eyebrow badge, display headline, install command (click to "copy"), and an **interactive terminal** (switch provider AWS/GCP/Azure, switch tab Plan/Deploy/Cost), stat strip, blueprint grid backdrop.
- **Features** — three pillars (visual config, zero-credential security, GitOps).
- **Ecosystem** — module cards (Alethia web · vertex CLI).
- **Footer** — link columns + Alethia attribution.

## Files
- `sections.jsx` — all sections + `Site` root → `window.VxSite`.
- `index.html` — mounts `Site`.

## Fidelity notes
Copy and structure mirror the source landing page; the install command and CLI verbs are rebranded to `vertex` (the source CLI is `grape`).
