# Alethia brand assets

The Alethia mark is **"the bracketed point"** — two brackets `[ ]` framing a center dot. It is
monochrome by design and lives in the product's grayscale system (no color, ever, in the mark
itself). These files are served at `/brand/<file>` and are safe to drop into decks, READMEs, and
third‑party surfaces.

## Files

| Type | File (currentColor) | Black variants | White variants | viewBox |
|---|---|---|---|---|
| **Mark** (icon only) | `alethia-mark.svg` | `alethia-mark-black.svg`, `-black-pure.svg` | `alethia-mark-white.svg`, `-white-pure.svg` | `0 0 32 32` |
| **Wordmark** (icon + Alethia) | `alethia-wordmark.svg` | `alethia-wordmark-black*.svg` | `alethia-wordmark-white*.svg` | `0 0 112 32` |
| **Lockup** (icon + Alethia + LABS) | `alethia-lockup.svg` | `alethia-lockup-black*.svg` | `alethia-lockup-white*.svg` | `0 0 150 32` |
| **App icon** (dark rounded square) | `alethia-app-icon.svg` | — | — | `0 0 512 512` |

- The unsuffixed file uses `currentColor` — ideal for embedding in code/CSS where the logo should
  inherit the text color.
- `-black` / `-white` use the **brand inks** `#0A0A0A` / `#FAFAFA` (the grayscale-system tokens).
- `-black-pure` / `-white-pure` use **true** `#000000` / `#FFFFFF` for print and external surfaces.

## When to use which
- **Mark** — favicons, app tiles, avatars, tight spaces, or anywhere the wordmark won't fit.
- **Wordmark** — the default in‑product logo (the product is "Alethia").
- **Lockup** — company/legal/footer contexts (the company is "Alethia Labs").
- **App icon** — home‑screen / PWA / store tile (iOS masks the corners).

## Color & background
Use the **white** files on dark surfaces, **black** files on light surfaces. Pick `currentColor`
when the surrounding ink already matches. Never recolor the mark beyond these inks.

## Clear space & minimum size
- **Clear space:** keep at least the dot's diameter (~`r`×2) of empty space on every side.
- **Minimum size:** mark ≥ 16px; wordmark ≥ 80px wide; lockup ≥ 110px wide (below this, drop to the
  wordmark or mark).

## Fonts
The **wordmark** and **lockup** use live text — **Space Grotesk** 600 ("Alethia") and **Geist Mono**
500 ("LABS"). They render correctly in‑app and on any system with those fonts installed. For print
or third‑party use where the fonts aren't guaranteed, **outline the text** first. The **mark** and
**app icon** are pure geometry and are fully portable as‑is.

## Don'ts
- Don't recolor (beyond the ink variants above) or add gradients/shadows/effects.
- Don't stretch, rotate, or change the proportions or the wordmark↔LABS spacing.
- Don't place the mark on a busy/low‑contrast background.

> The in‑app logo is the `<AlethiaLogo>` React component
> (`apps/console/components/alethia-logo.tsx`), which renders the same geometry in `currentColor`.
> These static files mirror it for use outside the app.
