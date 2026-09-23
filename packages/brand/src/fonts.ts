// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The three brand faces, loaded from COMMITTED files (#4986). Every app used to call Next's
// Google Fonts loader, which downloads the files from fonts.gstatic.com at BUILD time — so a CDN
// blip failed `next build` on PRs that touched no app code, and once dequeued a green PR.
//
// The .woff2 files in ./fonts are the Google Fonts `latin` subsets, byte-for-byte as published in
// @fontsource-variable/{geist,geist-mono,space-grotesk}@5.3.0 (sourced from github.com/google/fonts).
// They are SIL OFL 1.1; the licence text for each family sits next to its file. Provenance and
// checksums: ./fonts/README.md.
//
// Each call reproduces the Google-loader call the six sites made, option for option:
//   - Geist and Geist Mono: `subsets: ["latin"]` and no `weight`, which for a variable family means
//     the whole weight axis (100–900), normal style only.
//   - Space Grotesk: `subsets: ["latin"]`, `weight: ["400", "500", "600", "700"]` — served from the
//     variable file, declared over the same 400–700 range so no other weight is matched.
//   - `display: "swap"` and Arial fallback metrics, both of which were the Google loader's defaults.
//     (The fallback's size-adjust numbers are now computed from the file, not read from Next's table.)
//   - The Google `latin` unicode-range, so the face claims the same code points it did.
//   - The CSS variable names every app's `className` and @repo/brand/tokens.css read.
//
// `scripts/check-no-network-fonts.mjs` fails CI if any app or package imports the Google loader again.

import localFont from "next/font/local";

// Every option below is a LITERAL, including the repeated unicode-range: next/font's compiler
// rejects a font-loader argument that is not "explicitly written", so it cannot be a shared const.
// The range is the one Google Fonts publishes for `latin`, identical for all three faces.

/** Geist — the interface face. Exposes `--font-geist-sans`. */
const geistSans = localFont({
	src: [{ path: "./fonts/geist-latin-wght-normal.woff2", weight: "100 900", style: "normal" }],
	variable: "--font-geist-sans",
	display: "swap",
	adjustFontFallback: "Arial",
	declarations: [{ prop: "unicode-range", value: "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD" }],
});

/** Geist Mono — the technical face. Exposes `--font-geist-mono`. */
const geistMono = localFont({
	src: [{ path: "./fonts/geist-mono-latin-wght-normal.woff2", weight: "100 900", style: "normal" }],
	variable: "--font-geist-mono",
	display: "swap",
	adjustFontFallback: "Arial",
	declarations: [{ prop: "unicode-range", value: "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD" }],
});

/** Space Grotesk — the display and wordmark face, weights 400–700. Exposes `--font-space-grotesk`. */
const spaceGrotesk = localFont({
	src: [{ path: "./fonts/space-grotesk-latin-wght-normal.woff2", weight: "400 700", style: "normal" }],
	variable: "--font-space-grotesk",
	display: "swap",
	adjustFontFallback: "Arial",
	declarations: [{ prop: "unicode-range", value: "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD" }],
});

/** The three font variables, joined for an `<html>`/`<body>` `className`. */
export const brandFontVariables = `${geistSans.variable} ${geistMono.variable} ${spaceGrotesk.variable}`;
