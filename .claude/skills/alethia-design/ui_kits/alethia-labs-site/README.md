# Alethia Labs — UI kit (company site)

A recreation of the **alethialabs.io** company landing page, marketing the **Alethia** platform. Monochrome, editorial, terminal-forward. *(Structure mirrors the source `apps/trellis/components/landing`.)*

## Run
Open `index.html`. Loads `../../styles.css` + `../../_ds_bundle.js`, then `sections.jsx`.

## Sections
- **Header** — `[·]` mark + **Alethia · LABS** lockup, nav, GitHub, Get started.
- **Hero** — eyebrow badge (Alethia · multi-cloud Kubernetes), display headline, install command `brew install alethia` (click to "copy"), and an **interactive terminal** (switch provider AWS/GCP/Azure, switch tab Plan/Deploy/Cost), stat strip, blueprint-grid backdrop.
- **Features** — three pillars (visual config, zero-credential security, GitOps).
- **Ecosystem** — module cards (Alethia Console · alethia CLI).
- **Footer** — link columns + Alethia Labs attribution.

## Files
- `sections.jsx` — all sections + `Site` root → `window.VxSite`.
- `index.html` — mounts `Site`.

## Fidelity notes
Copy and structure mirror the source landing page; the platform is branded **Alethia**, the company **Alethia Labs**, and the CLI binary is `alethia` (the source CLI is `grape`).
