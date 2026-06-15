# Alethia Design System

> **Alethia** — a multi-cloud Kubernetes control plane by **Alethia**.
> Configure infrastructure visually. Deploy from the terminal. Zero credentials stored.

A sophisticated, **fully grayscale** design language for an infrastructure-engineering platform. No color, ever — structure, type, and a disciplined neutral ink ramp carry the whole system. The mood is editorial-technical: instrument-panel density, mono eyebrow labels, and a dark-first surface.

---

## 1 · Company & product context

**Alethia** is the parent company that holds the IP and knowledge. **Alethia** is the platform it ships: an internal developer platform for provisioning and managing multi-cloud Kubernetes infrastructure through a web control plane and a CLI, backed by GitOps reconciliation.

The platform has two surfaces, both recreated here as UI kits:

| Surface | What it is |
| --- | --- |
| **Alethia (web control plane)** | Next.js dashboard — visual configuration, job orchestration, clusters, integrations, real-time logs, cost estimation. *(Source name: Trellis.)* |
| **Alethia CLI** | Interactive terminal wizard — auth, plan, deploy (`harvest`), destroy, worker management. *(Source name: Grape.)* |

**Product domain vocabulary** (kept verbatim because it appears throughout real screens):
*Vineyard* = a workspace · *Vine* = one infrastructure configuration · *Tendril* = a provisioning worker that runs Terraform · *Plant a Vine* = create & provision. Clouds supported: **AWS, GCP, Azure** (Alibaba scaffolded).

### Sources (for the reader)
This system was reverse-engineered from a real codebase. If you have access, explore it to build higher-fidelity designs:

- **GitHub — `alethialabs-io/alethialabs`** → https://github.com/alethialabs-io/alethialabs
  - Web control plane: `apps/trellis` (Next.js 16, React 19, Tailwind v4, shadcn/ui "new-york", Lucide, default-dark, Geist + Geist Mono).
  - CLI: `apps/grape` (Go, Cobra, Charmbracelet). Worker: `apps/tendril`. Docs: `apps/vintner`.
  - Marketing landing: `apps/trellis/components/landing/*`. Primitives: `apps/trellis/components/ui/*`.
- Aesthetic reference supplied by the user: **tovr.eu** (and `/apex`, `/fos`) — sophisticated monochrome.

> The source product ships stock shadcn defaults. **Alethia elevates that** into an owned, monochrome brand language with a distinct type voice. Where this system and the source differ (color removed, fonts changed, CLI renamed), this system is the intended direction.

---

## 2 · Content fundamentals

How Alethia writes. Channels the tovr.eu voice: terse, declarative, confident.

- **Voice:** Direct and technical. Short declarative sentences, often fragments. *"Deploy from the terminal. Zero credentials stored."* Confidence without hype.
- **Person:** Second person for the reader (*"Your infrastructure at a glance"*), imperative for actions (*"Plant a Vine", "Continue", "Destroy"*). Never "we" in product UI; "we" only appears in transactional notices (*"We sent a magic link…"*).
- **Casing:** **Sentence case** for headings, buttons, and body. **UPPERCASE mono** reserved for eyebrow labels and section markers (tracked `0.16em`). Never Title Case Everything.
- **Numbers & data:** Lead with the figure. Money is precise (`$847.23/mo`), counts are bare (`47 resources to add`, `3 nodes`). Mono for any technical value (regions `eu-west-1`, versions `v1.31`, CIDRs `10.0.0.0/16`).
- **Tone in errors:** Plain and non-blaming. State what happened and the consequence (*"This destroys 47 resources. This action cannot be undone."*).
- **Emoji:** Never. **Punctuation:** the middot `·` separates inline metadata (`EKS · eu-west-1 · v1.31`); arrows `→` and check `✓` appear in terminal output only.
- **Vibe:** A senior platform engineer's tool — quiet, exact, trustworthy. No marketing fluff, no exclamation points.

**Examples**
> *The infrastructure layer for cloud-native teams.*
> *Configure multi-cloud Kubernetes visually. Deploy from the terminal. Zero credentials stored.*
> *Eleven guided sections compile into a single Terraform plan.*

---

## 3 · Visual foundations

- **Color:** **None.** A 16-step neutral ink ramp (`--gray-0` → `--black`, OKLCH, zero chroma) drives everything. Two themes: **dark is the signature** (product + marketing), light is for docs and dense data. Tokens: `tokens/colors.css`.
- **Status without color:** the system's defining rule. State is read through **dot fill + shape + a mono label**, never hue — solid (active), haloed (processing), ring (idle), hollow-center (failed), faint (disabled), blinking (live). See `StatusBadge`.
- **Type:** three voices. **Space Grotesk** (display / headlines / wordmark, tracking −0.02 to −0.04em), **Geist** (UI + body, 14px base), **Geist Mono** (terminal, data readouts, and the signature uppercase eyebrow label). Tokens: `tokens/typography.css`.
- **Backgrounds:** flat ink surfaces. The one decorative motif is a faint **blueprint grid** (44px) radially masked behind the hero — no gradients, no photos, no illustration. Never bluish-purple gradients.
- **Borders carry structure.** Hairline `1px` borders (`--border`) define every surface; `--border-strong` for inputs and emphasis; dashed borders mark "not yet connected" affordances.
- **Shadows are a whisper.** Five steps, low-opacity neutral; elevation reads from borders, not drop-shadow drama. Resting cards use `--shadow-sm`. Tokens: `tokens/effects.css`.
- **Corner radii:** `xs 4 · sm 6 · md 8 · lg 10 · xl 14 · 2xl 18 · full`. Buttons/inputs `sm`, cards `lg`, hero containers `xl`. Base unit `0.625rem` (matches the source product).
- **Spacing:** 4px grid (`--space-*`). Dense, instrument-panel rhythm; generous only around hero/marketing.
- **Cards:** surface fill, hairline border, `--shadow-sm`, `radius-lg`. `interactive` cards shift border + background on hover; no lift/scale.
- **Motion:** restrained and mechanical. Durations 80–480ms, easing `cubic-bezier(0.2,0,0,1)`. Hover = background/border/color shift; press = `translateY(0.5px)`. The only loops are the terminal caret and the partner marquee. Respects `prefers-reduced-motion`.
- **Hover / press states:** ghost & secondary fill with `--surface-muted`; outline darkens its border; primary darkens ink. Focus = 3px translucent ring (`--ring-color`).
- **Transparency & blur:** sticky headers use `color-mix` canvas + `blur(8–10px)`. Scrims for overlays at 55–70% black.
- **Imagery vibe:** none by default; provider/integration brand marks keep their original color (the single sanctioned exception to grayscale, because they're third-party logos).

---

## 4 · Iconography

- **Primary set: Lucide** — 1.5–1.75px stroke, round caps/joins, 24px grid, drawn in `currentColor` (so they inherit the ink). This matches the source product (`iconLibrary: "lucide"`). In consuming projects, link Lucide from CDN; in these kits a compact hand-matched subset lives in `ui_kits/vertex-app/icons.jsx`.
- **No emoji. No unicode-glyph icons** (except `·`, `→`, `✓`, `▸` inside terminal output, which are type, not icons).
- **Brand marks** (cloud providers, integrations) are **real raster logos** kept in original color — the only color in the system. Stored in `assets/providers/*.png` (AWS, GCP, Azure, Alibaba) and `assets/integrations/*.png` (GitHub, GitLab, Bitbucket, Cloudflare, Datadog, Dockerhub, Grafana, Prometheus). These were copied from the source repo's `public/` folder.
- **The Alethia mark** is a monochrome geometric glyph (two stacked apex strokes converging on a node) — `assets/vertex-mark.svg`, drawn in `currentColor`. Wordmark uses Space Grotesk; the Alethia parent lockup uses tracked Geist Mono.

---

## 5 · Index / manifest

**Root**
- `styles.css` — the single entry point consumers link (`@import` manifest only).
- `tokens/` — `fonts · colors · typography · spacing · effects · motion · base`.
- `components/components.css` — class layer for the bundled primitives.
- `assets/` — `vertex-mark.svg`, `vertex-wordmark.svg`, `alethia-wordmark.svg`, `providers/`, `integrations/`.
- `SKILL.md` — Agent-Skills-compatible entry point.

**Components** (`window.VertexDesignSystem_8c015f.*`)
- `components/buttons/` — **Button**, **Badge**, **Kbd**
- `components/forms/` — **Input**, **Textarea**, **Field**, **Label**, **Hint**, **Select**, **Checkbox**, **Radio**, **Switch**
- `components/surfaces/` — **Card** (+ Header/Title/Description/Body/Footer), **Avatar**, **Separator**
- `components/feedback/` — **StatusBadge**, **Alert**, **Spinner**
- `components/navigation/` — **Tabs**

**UI kits**
- `ui_kits/vertex-app/` — interactive control-plane dashboard (6 screens + sign-in).
- `ui_kits/vertex-web/` — marketing landing with interactive terminal.

**Foundation cards** (Design System tab) — `guidelines/*.html`: ink ramp, surfaces, text/borders, light theme, display/text/mono/scale type, spacing/radii/elevation, logo/lockups/iconography.

---

## 6 · Using this system

Link the stylesheet and read components off the namespace:

```html
<link rel="stylesheet" href="styles.css" />
<script src="_ds_bundle.js"></script>
<script>
  const { Button, Card, StatusBadge } = window.VertexDesignSystem_8c015f;
</script>
```

Default to the **dark** theme: put `class="dark"` on `<html>`. Use exactly one `primary` button per view. Reach for the mono eyebrow label (`.vx-eyebrow`) to mark sections. Communicate status with `StatusBadge`, never a colored dot.
