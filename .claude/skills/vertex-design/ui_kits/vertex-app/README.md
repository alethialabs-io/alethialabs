# Vertex App — UI kit (control plane)

An interactive recreation of the **Vertex** web control plane (the product is *Trellis* in the source repo). Composes the Vertex design-system primitives — it does **not** re-implement them.

## Run
Open `index.html`. It loads `../../styles.css` + `../../_ds_bundle.js`, then the kit files.

## Flow
- Starts on the authenticated **dashboard** (so the preview shows the real product).
- Click the user card (bottom-left) → **sign out** → the OAuth sign-in screen.
- Sign in with any provider / magic link → back to the dashboard.
- Left rail switches screens: **Overview · Plant a Vine · Clusters · Jobs · Integrations · Tendrils**.

## Files
- `icons.jsx` — compact Lucide-style icon set → `window.VxIcons`.
- `shell.jsx` — `SignIn`, `Sidebar`, `TopBar`, brand `Mark`, `Provider` → `window.VxApp`.
- `screens.jsx` — the six screens → `window.VxScreens`.
- `index.html` — mounts the `Root` state machine.

## Vocabulary (product domain nouns, intentional)
*Vineyard* = workspace · *Vine* = an infrastructure config · *Tendril* = a provisioning worker · *Plant a Vine* = create + provision. These are the product's real feature names; the umbrella brand is Vertex.

## Fidelity notes
Cosmetic recreation, not production code — data is static. Layout, nav, status conventions, and copy follow `apps/trellis` in the source repo.
