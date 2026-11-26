// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { ReactNode } from "react";
import { INLINE_PX, INLINE_STROKE, MarkGlyph } from "@repo/ui/spinner";

/**
 * The `[·]` mark loader (polish-wave spec §2, #7740). Server-safe: no hooks, no client boundary —
 * the motion is CSS (`.ah-loader__*` in `../tokens.css`), so a `loading.tsx` can render it.
 *
 * It is for waits whose LAYOUT is unknown. Where the layout is known, a skeleton stays (RUBRIC
 * skeleton rules); the mark never replaces one.
 */

/**
 * - `inline` — 16px, stroke 2.8: inside a control. In a button use `<Button pending>`, which
 *   draws the same glyph; this size is for an inline wait that is not a button.
 * - `region` — 40px: a wait of unknown length inside a page (agent thinking, plan/apply running,
 *   the sign-in callback, the CLI hand-off). Pair it with a `status` line of real facts.
 * - `page` — 56px, centred in a tall block: the shell's main column while a page with no
 *   skeleton of its own suspends, and the auth waits.
 */
export type MarkLoaderSize = "inline" | "region" | "page";

/** Rendered edge of the glyph per size, in px. */
export const MARK_LOADER_PX: Record<MarkLoaderSize, number> = {
	inline: INLINE_PX,
	region: 40,
	page: 56,
};

/** What `MarkLoader` accepts. */
export interface MarkLoaderProps {
	/** Which loader. Defaults to `region`. */
	size?: MarkLoaderSize;
	/**
	 * What is being waited for, for a screen reader: "Loading", "Signing you in". It is the
	 * status region's text, so it is announced; it is not drawn.
	 */
	label?: string;
	/**
	 * A mono line of real facts under the mark — "Planning · prod-eu · 0:12". Never a fake
	 * percentage. Drawn for `region` and `page`; an `inline` loader has no room for one and
	 * ignores it.
	 */
	status?: ReactNode;
	/** Extra classes on the wrapper (spacing, width). */
	className?: string;
}

/** Joins class names, dropping the empty ones. */
function classes(...names: Array<string | undefined>): string {
	return names.filter(Boolean).join(" ");
}

/**
 * The animated `[·]` mark in a `role="status"` region. The label (and the status line, when
 * there is one) is the region's text, so a change to the status line is announced politely.
 * Under reduced motion the mark stands still at full opacity and the status line stays.
 */
export function MarkLoader({ size = "region", label = "Loading", status, className }: MarkLoaderProps) {
	const px = MARK_LOADER_PX[size];
	const glyph = (
		<MarkGlyph
			width={px}
			height={px}
			bracketStroke={size === "inline" ? INLINE_STROKE : undefined}
			aria-hidden="true"
		/>
	);
	if (size === "inline") {
		return (
			<span role="status" data-slot="mark-loader" data-size={size} className={classes("ah-loader", className)}>
				{glyph}
				<span className="ah-loader__label">{label}</span>
			</span>
		);
	}
	return (
		<div
			role="status"
			data-slot="mark-loader"
			data-size={size}
			className={classes("ah-loader", `ah-loader--${size}`, className)}
		>
			{glyph}
			<span className="ah-loader__label">{label}</span>
			{status ? <p className="ah-loader__status">{status}</p> : null}
		</div>
	);
}
