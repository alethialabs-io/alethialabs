// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { CSSProperties } from "react";

/**
 * Grayscale palette mapped from the Alethia design system's dark theme
 * (OKLCH zero-chroma ramp → email-safe hex, since clients don't support
 * `oklch()` or CSS variables).
 */
export const colors = {
	canvas: "#121214", // --gray-1050 (page background)
	surface: "#18181a", // --gray-1000 (email card)
	surfaceRaised: "#1f1f21", // --gray-950
	surfaceSunken: "#0e0e10", // --gray-1100 (code block, terminal)
	surfaceMuted: "#1f1f21", // --gray-950 (avatar fill)
	textPrimary: "#fafafa", // --gray-50
	textSecondary: "#8b8b8e", // --gray-500
	textTertiary: "#6e6e72", // --gray-600
	textDisabled: "#525255", // --gray-700
	border: "#2a2a2d", // ~ white / 0.10 on dark
	borderStrong: "#3a3a3e", // ~ white / 0.17 on dark
	ink: "#fafafa", // dark-theme solid action = light
	inkForeground: "#18181a", // text on the light action
} as const;

/** Light-mode Alethia grayscale (mirrors the dark ramp). */
export const lightColors = {
	canvas: "#f4f4f5",
	surface: "#ffffff",
	surfaceRaised: "#fafafa",
	surfaceSunken: "#f4f4f5",
	surfaceMuted: "#f0f0f1",
	textPrimary: "#18181a",
	textSecondary: "#52525b",
	textTertiary: "#71717a",
	textDisabled: "#a1a1aa",
	border: "#e4e4e7",
	borderStrong: "#d4d4d8",
	ink: "#18181a",
	inkForeground: "#fafafa",
} as const;

/** prefers-color-scheme:light overrides, keyed on the class hooks below. */
export const lightModeCss = `
@media (prefers-color-scheme: light) {
  .a-canvas { background-color: ${lightColors.canvas} !important; }
  .a-surface { background-color: ${lightColors.surface} !important; }
  .a-sunken { background-color: ${lightColors.surfaceSunken} !important; }
  .a-muted { background-color: ${lightColors.surfaceMuted} !important; }
  .a-text { color: ${lightColors.textPrimary} !important; }
  .a-text-2 { color: ${lightColors.textSecondary} !important; }
  .a-text-3 { color: ${lightColors.textTertiary} !important; }
  .a-border { border-color: ${lightColors.border} !important; }
  .a-border-strong { border-color: ${lightColors.borderStrong} !important; }
  .a-btn { background-color: ${lightColors.ink} !important; color: ${lightColors.inkForeground} !important; border-color: ${lightColors.ink} !important; }
  .a-mark { color: ${lightColors.ink} !important; }
  .a-mark path { stroke: ${lightColors.ink} !important; }
  .a-mark circle { fill: ${lightColors.ink} !important; }
}`;

/** Type voices. Geist first, system fallback (web fonts are unreliable in email). */
export const fonts = {
	sans: "Geist, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
	mono: "'Geist Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
} as const;

/** Squared controls, surfaces only a whisper of a corner. */
export const radii = {
	none: "0",
	sm: "2px",
	md: "3px",
	lg: "4px",
	full: "9999px",
} as const;

/** Shared text styles used across the templates. */
export const text = {
	eyebrow: {
		fontFamily: fonts.mono,
		fontSize: "11px",
		letterSpacing: "0.16em",
		textTransform: "uppercase",
		color: colors.textTertiary,
		margin: "0 0 16px",
	},
	heading: {
		fontFamily: fonts.sans,
		fontWeight: 700,
		fontSize: "25px",
		lineHeight: "1.18",
		letterSpacing: "-0.02em",
		color: colors.textPrimary,
		margin: "0 0 16px",
	},
	body: {
		fontFamily: fonts.sans,
		fontSize: "14.5px",
		lineHeight: "1.65",
		color: colors.textSecondary,
		margin: "0 0 16px",
	},
} satisfies Record<string, CSSProperties>;

/** Squared primary button (ink fill, inverted text). */
export const primaryButton: CSSProperties = {
	display: "inline-block",
	backgroundColor: colors.ink,
	color: colors.inkForeground,
	fontFamily: fonts.sans,
	fontSize: "14px",
	fontWeight: 500,
	padding: "12px 20px",
	border: `1px solid ${colors.ink}`,
	borderRadius: radii.none,
	textDecoration: "none",
};
