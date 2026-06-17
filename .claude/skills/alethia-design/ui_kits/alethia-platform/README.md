# Alethia — UI kit (platform / control plane)

An interactive recreation of the **Alethia** platform — the multi-cloud Kubernetes control plane (formerly ADP at `beta.adp.itgix.com`), in the Alethia Labs grayscale language. *(Source app: `apps/trellis`.)* Composes the design-system primitives — it does **not** re-implement them.

## Run
Open `index.html`. It loads `../../styles.css` + `../../_ds_bundle.js`, then the kit files.

## Flow
- Starts on the authenticated **dashboard** (so the preview shows the real product).
- Click the user card (bottom-left) → **sign out** → the OAuth sign-in screen ("Sign in to Alethia").
- Sign in with any provider / magic link → back to the dashboard.
- Left rail switches screens: **Overview · Plant a Vine · Clusters · Jobs · Integrations · Tendrils**.

## Files
- `icons.jsx` — compact Lucide-style icon set → `window.VxIcons`.
- `shell.jsx` — `SignIn`, `Sidebar`, `TopBar`, brand `Mark` (the `[·]` glyph), `Provider` → `window.VxApp`.
- `screens.jsx` — the six screens → `window.VxScreens`.
- `index.html` — mounts the `Root` state machine.

## Vocabulary (product domain nouns, intentional)
*Vineyard* = workspace · *Vine* = an infrastructure config · *Tendril* = a provisioning worker · *Plant a Vine* = create + provision. These are the source product's real feature names, kept verbatim. The platform is **Alethia**, the company **Alethia Labs**, the CLI binary `alethia`.

## Fidelity notes
Cosmetic recreation, not production code — data is static. Layout, nav, status conventions, and copy follow `apps/trellis`; the top-level identity is rebranded (Vertex/Trellis/ADP → Alethia, peak mark → `[·]`).
