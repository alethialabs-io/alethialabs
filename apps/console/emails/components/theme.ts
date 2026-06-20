// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { CSSProperties } from "react";

/**
 * Light grayscale palette from the Alethia design system (OKLCH zero-chroma ramp
 * → email-safe hex, since clients don't support `oklch()` or CSS variables).
 * Email is intentionally **light-only**: a dark default renders badly in
 * light-mode Gmail (which ignores `prefers-color-scheme` and partially inverts),
 * so every client gets the same clean light card.
 */
export const colors = {
	canvas: "#f4f4f5", // page background
	surface: "#ffffff", // email card
	surfaceRaised: "#fafafa",
	surfaceSunken: "#f4f4f5", // code block, terminal
	surfaceMuted: "#f0f0f1", // avatar fill
	textPrimary: "#18181a",
	textSecondary: "#52525b",
	textTertiary: "#71717a",
	textDisabled: "#a1a1aa",
	border: "#e4e4e7",
	borderStrong: "#d4d4d8",
	ink: "#18181a", // solid action = dark ink
	inkForeground: "#fafafa", // text on the ink action
} as const;

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
