# Alethia Labs Design System

> **Alethia Labs** — the company (alethialabs.io).
> **Alethia** — the product/platform: a multi-cloud Kubernetes control plane.
> Configure infrastructure visually. Deploy from the terminal. Zero credentials stored.

A sophisticated, **fully grayscale** design language. No color, ever — structure, type, and a disciplined neutral ink ramp carry the whole system. The mood is editorial-technical: instrument-panel density, mono eyebrow labels, and a dark-first surface. The brand mark is the **bracketed point** `[ · ]` — a focal point held inside brackets (*aletheia*, Greek for **truth / unconcealment** — the moment scattered things come into focus).

---

## 1 · Company & product context

**Alethia Labs** is the company; it holds the IP and ships **Alethia**, an internal developer platform for provisioning and managing multi-cloud Kubernetes infrastructure through a web control plane and a CLI, backed by GitOps reconciliation. The platform currently lives at `beta.adp.itgix.com` (formerly branded ADP) and is being rebranded onto this language and onto the new company domain **alethialabs.io**.

Two surfaces, both recreated here as UI kits:

| Surface | What it is |
| --- | --- |
| **Alethia Console** (control plane) | Dashboard — visual configuration, job orchestration, clusters, integrations, real-time logs, cost estimation. *(Source app: Trellis.)* |
| **alethia CLI** | Interactive terminal wizard — `alethia login`, `whoami`, plan, deploy, destroy, worker management. *(Source app: Grape.)* |

**Product domain vocabulary** (kept verbatim — it appears throughout real screens):
*Vineyard* = a workspace · *Vine* = one infrastructure configuration · *Tendril* = a provisioning worker that runs Terraform · *Plant a Vine* = create & provision. Clouds: **AWS, GCP, Azure** (Alibaba scaffolded).

### Sources (for the reader)
Reverse-engineered from a real codebase. If you have access, explore it for higher-fidelity work:

- **GitHub — `bobikenobi12/bb-thesis-2026`** → https://github.com/bobikenobi12/bb-thesis-2026
  - Control plane: `apps/trellis` (Next.js, React 19, Tailwind v4, shadcn/ui "new-york", Lucide, default-dark, Geist + Geist Mono).
  - CLI: `apps/grape` (Go, Cobra, Charmbracelet). Worker: `apps/tendril`. Docs: `apps/vintner`.
  - Marketing landing: `apps/trellis/components/landing/*`. Primitives: `apps/trellis/components/ui/*`.
- Aesthetic reference supplied by the user: **tovr.eu** (and `/apex`, `/fos`) — sophisticated monochrome.

> The source product ships stock shadcn defaults. **Alethia Labs elevates that** into an owned, monochrome brand language with a distinct type voice and the `[·]` mark. Where this system and the source differ (color removed, fonts changed, product renamed Vertex/ADP→Alethia, peak mark→bracketed point), **this system is the intended direction.**

---

## 2 · Content fundamentals

How Alethia Labs writes. Channels the tovr.eu voice: terse, declarative, confident.

- **Voice:** Direct and technical. Short declarative sentences, often fragments. *"Deploy from the terminal. Zero credentials stored."* Confidence without hype.
- **Person:** Second person for the reader (*"Your infrastructure at a glance"*), imperative for actions (*"Plant a Vine", "Continue", "Destroy"*). Never "we" in product UI; "we" only in transactional notices (*"We sent a magic link…"*).
- **Casing:** **Sentence case** for headings, buttons, body. **UPPERCASE mono** reserved for eyebrow labels, section markers, and the **LABS** tag (tracked `0.16`–`0.26em`). Never Title Case Everything.
- **Numbers & data:** Lead with the figure. Money is precise (`$847.23/mo`), counts are bare (`47 resources to add`, `3 nodes`). Mono for any technical value (regions `eu-west-1`, versions `v1.31`, CIDRs `10.0.0.0/16`).
- **Errors:** Plain, non-blaming. State what happened and the consequence (*"This destroys 47 resources. This action cannot be undone."*).
- **Emoji:** Never. **Punctuation:** the middot `·` separates inline metadata (`EKS · eu-west-1 · v1.31`); `→` and `✓` appear in terminal output only.
- **Vibe:** A senior platform engineer's tool — quiet, exact, trustworthy. No marketing fluff, no exclamation points.

**Examples**
> *The infrastructure layer for cloud-native teams.*
> *Configure multi-cloud Kubernetes visually. Deploy from the terminal. Zero credentials stored.*
> *Eleven guided sections compile into a single Terraform plan.*

---

## 3 · Visual foundations

- **Color:** **None.** A 16-step neutral ink ramp (`--gray-0` → `--black`, OKLCH, zero chroma) drives everything. Two themes: **dark is the signature**, light is for docs and dense data. Tokens: `tokens/colors.css`.
- **Status without color:** the defining rule. State reads through **dot fill + shape + a mono label**, never hue — solid (active), haloed (processing), ring (idle), hollow-center (failed), faint (disabled), blinking (live). See `StatusBadge`.
- **Type:** three voices. **Space Grotesk** (display / headlines / wordmark, tracking −0.02 to −0.04em), **Geist** (UI + body, 14px base), **Geist Mono** (terminal, data readouts, the uppercase eyebrow label, the LABS tag). Tokens: `tokens/typography.css`.
- **Logo:** the **bracketed point** `[ · ]` — a focal dot inside square brackets, drawn in `currentColor` so it inherits the ink. Lockup: mark + **Alethia** (Space Grotesk) + **LABS** (tracked mono). The platform lockup uses **Alethia · PLATFORM**.
- **Backgrounds:** flat ink surfaces. The one decorative motif is a faint **blueprint grid** (44px) radially masked behind the hero — no gradients, no photos, no illustration. Never bluish-purple gradients.
- **Borders carry structure.** Hairline `1px` borders (`--border`) define every surface; `--border-strong` for inputs/emphasis; dashed borders mark "not yet connected" affordances.
- **Shadows are a whisper.** Five low-opacity neutral steps; elevation reads from borders, not drop-shadow drama. Resting cards use `--shadow-sm`. Tokens: `tokens/effects.css`.
- **Corner radii:** `xs 4 · sm 6 · md 8 · lg 10 · xl 14 · 2xl 18 · full`. Buttons/inputs `sm`, cards `lg`, hero containers `xl`. Base `0.625rem`.
- **Spacing:** 4px grid (`--space-*`). Dense, instrument-panel rhythm; generous only around hero/marketing.
- **Cards:** surface fill, hairline border, `--shadow-sm`, `radius-lg`. `interactive` cards shift border + background on hover; no lift/scale.
- **Motion:** restrained, mechanical. Durations 80–480ms, easing `cubic-bezier(0.2,0,0,1)`. Hover = background/border/color shift; press = `translateY(0.5px)`. The only loops are the terminal caret and the partner marquee. Respects `prefers-reduced-motion`.
- **Focus:** 3px translucent ring (`--ring-color`). **Transparency & blur:** sticky headers use `color-mix` canvas + `blur(8–10px)`; scrims 55–70% black.
- **Imagery:** none by default; provider/integration brand marks keep their original color (the single sanctioned exception to grayscale, because they're third-party logos).

---

## 4 · Iconography

- **Primary set: Lucide** — 1.5–1.75px stroke, round caps/joins, 24px grid, drawn in `currentColor`. Matches the source product (`iconLibrary: "lucide"`). In consuming projects, link Lucide from CDN; in these kits a compact hand-matched subset lives in `ui_kits/adp-platform/icons.jsx`.
- **No emoji. No unicode-glyph icons** (except `·`, `→`, `✓`, `▸` inside terminal output, which are type, not icons).
- **Brand marks** (cloud providers, integrations) are **real raster logos** in original color — the only color in the system. `assets/providers/*.png` (AWS, GCP, Azure, Alibaba) and `assets/integrations/*.png` (GitHub, GitLab, Bitbucket, Cloudflare, Datadog, Dockerhub, Grafana, Prometheus). Copied from the source repo's `public/`.
- **The Alethia Labs mark** is the `[ · ]` bracketed point — `assets/alethia-mark.svg`, `currentColor`. Lockups: `assets/alethia-labs-wordmark.svg`, `assets/alethia-platform-wordmark.svg`. Favicon/app-icon: `assets/favicon.svg`, `assets/app-icon.svg`.

---

## 5 · Index / manifest

**Root**
- `styles.css` — the single entry point consumers link (`@import` manifest only).
- `tokens/` — `fonts · colors · typography · spacing · effects · motion · base`.
- `components/components.css` — class layer for the bundled primitives.
- `assets/` — `alethia-mark.svg`, `alethia-labs-wordmark.svg`, `alethia-platform-wordmark.svg`, `favicon.svg`, `app-icon.svg`, `providers/`, `integrations/`.
- `SKILL.md` — Agent-Skills-compatible entry point.

**Components** (`window.VertexDesignSystem_8c015f.*` — internal namespace id; stable)
- `components/buttons/` — **Button**, **Badge**, **Kbd**
- `components/forms/` — **Input**, **Textarea**, **Field**, **Label**, **Hint**, **Select**, **Checkbox**, **Radio**, **Switch**
- `components/surfaces/` — **Card** (+ Header/Title/Description/Body/Footer), **Avatar**, **Separator**
- `components/feedback/` — **StatusBadge**, **Alert**, **Spinner**
- `components/navigation/` — **Tabs**

**UI kits**
- `ui_kits/alethia-platform/` — interactive Alethia control-plane dashboard (6 screens + sign-in).
- `ui_kits/alethia-labs-site/` — alethialabs.io company landing with interactive terminal.

**Foundation cards** (Design System tab) — `guidelines/*.html`: ink ramp, surfaces, text/borders, light theme, display/text/mono/scale type, spacing/radii/elevation, logo/lockups/iconography.

---

## 6 · Using this system

```html
<link rel="stylesheet" href="styles.css" />
<script src="_ds_bundle.js"></script>
<script>
  const { Button, Card, StatusBadge } = window.VertexDesignSystem_8c015f;
</script>
```

Default to the **dark** theme: put `class="dark"` on `<html>`. Use exactly one `primary` button per view. Reach for the mono eyebrow label (`.vx-eyebrow`) to mark sections. Communicate status with `StatusBadge`, never a colored dot. The mark is `[·]`; the company is **Alethia Labs**, the platform is **Alethia**, the CLI binary is `alethia`.

> Note: the component namespace string and the internal `.vx-*` class prefix retain a legacy identifier from the project's first iteration. They are not user-visible and are kept stable so existing references don't break.
