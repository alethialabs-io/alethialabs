// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { CSSProperties, SVGProps } from "react";

/**
 * The one Alethia lockup. Every browser surface renders this — marketing and
 * blog chrome, the console auth shell, the docs nav, the admin bar.
 *
 * It is DOM text, not SVG `<text>`, and that is the point. The SVG lockup this
 * replaced pinned `LABS` at an absolute `x="112"` while "Alethia" was laid out
 * by the font engine from `x=40`; the two are unrelated at runtime, so during
 * the `next/font` swap the fallback metrics slid the wordmark's right edge
 * under a tag that could not move. A flex gap cannot have that failure mode.
 * DOM text also takes `currentColor` for free and scales with the type ramp.
 *
 * Geometry is derived from the canonical asset
 * (`packages/assets/static/brand/alethia-lockup.svg`, `viewBox="0 0 188 32"`),
 * expressed as ratios of `size` so every surface is the same lockup at a
 * different scale:
 *
 * | quantity              | canonical units | ratio  |
 * |-----------------------|-----------------|--------|
 * | wordmark font-size    | 20              | 0.625  |
 * | mark box → wordmark   | 40 − 32 =  8    | 0.25   |
 * | tag font-size         | 10              | 0.3125 |
 * | wordmark → tag        | 139 − 112 = 27  | 0.84   |
 *
 * Note the mark→wordmark gap is measured from the mark's **box** edge (32), not
 * its visible bracket (25.5): `AlethiaMark` renders the full 32-unit box, so
 * the box edge is what a CSS margin starts from. Using the optical 14.5 would
 * double-count the bracket's right padding.
 *
 * Total width lands at roughly `5.5 × size`. `packages/assets/static/brand/README.md`
 * sets a 110px floor on the lockup and 80px on the wordmark, so **`size` must be
 * ≥ 20 with a tag and ≥ 22 without one**. Below that, reach for `AlethiaMark`
 * (floor 16px) instead. This is documented rather than thrown: a runtime throw
 * in a header component fails the whole page over a cosmetic floor.
 */

/** Ratios of `size`, from the canonical asset. See the table above. */
const WORD_SIZE = 0.625;
const WORD_GAP = 0.25;
const TAG_SIZE = 0.3125;
const TAG_GAP = 0.84;

/**
 * Which sub-brand the lockup names. A typed union rather than a free-form
 * string because the tracking is per-word — the canonical assets set 0.26em for
 * the short tags and 0.22em for the longer PLATFORM, so a caller-supplied
 * string could not carry the right value.
 */
export type LockupTag = "labs" | "platform" | "docs" | "staff" | "none";

type NamedTag = Exclude<LockupTag, "none">;

/**
 * Literal uppercase, not `text-transform`. The lockup this replaced wrote
 * "Labs" and uppercased it in CSS, so selection, copy/paste and the accessible
 * name all yielded "Labs" while the brand is "LABS".
 */
const TAG_LABEL: Record<NamedTag, string> = {
	labs: "LABS",
	platform: "PLATFORM",
	docs: "DOCS",
	staff: "STAFF",
};

const TAG_TRACKING: Record<NamedTag, string> = {
	labs: "0.26em",
	platform: "0.22em",
	docs: "0.26em",
	staff: "0.24em",
};

const GROTESK = "var(--font-grotesk), var(--font-geist-sans), system-ui, sans-serif";
const MONO = "var(--font-mono), ui-monospace, monospace";

interface AlethiaMarkProps extends SVGProps<SVGSVGElement> {
	/**
	 * Rendered width/height in px. Optional on purpose — several call sites size
	 * the mark entirely through `className` (`size-5`, `h-6 w-6`, `h-20 w-auto`),
	 * and emitting `width`/`height` unasked would fight them. When it is absent
	 * no dimension attributes are written at all.
	 */
	size?: number;
}

/**
 * The bracketed-point `[·]` mark, drawn in `currentColor`.
 *
 * Two brackets framing a focal point — aletheia, truth brought into focus. The
 * geometry (stroke 2.4, dot r 2.9) is canonical and is duplicated in the
 * `next/og` image routes and in `packages/email`, both of which cannot import
 * this module. Change it here and change it there.
 */
export function AlethiaMark({ size, style, ...props }: AlethiaMarkProps) {
	const dims = size === undefined ? {} : { width: size, height: size };
	return (
		<svg
			xmlns="http://www.w3.org/2000/svg"
			viewBox="0 0 32 32"
			fill="none"
			// `block`, not the inline default: an inline <svg> sits on the text
			// baseline and picks up the line box's descender gap, which knocked the
			// mark a couple of px out of true in every flex row it appeared in.
			style={{ display: "block", ...style }}
			{...dims}
			{...props}
		>
			<path
				d="M11 6 H6.5 V26 H11"
				stroke="currentColor"
				strokeWidth="2.4"
				strokeLinecap="round"
				strokeLinejoin="round"
			/>
			<path
				d="M21 6 H25.5 V26 H21"
				stroke="currentColor"
				strokeWidth="2.4"
				strokeLinecap="round"
				strokeLinejoin="round"
			/>
			<circle cx="16" cy="16" r="2.9" fill="currentColor" />
		</svg>
	);
}

interface AlethiaLockupProps {
	/** Sub-brand tag after the wordmark. `"none"` renders the wordmark alone. */
	tag?: LockupTag;
	/** Mark height in px; the wordmark and tag derive from it. Floor: 20 (22 untagged). */
	size?: number;
	className?: string;
	style?: CSSProperties;
}

/**
 * `[·] Alethia LABS` — the full lockup, in `currentColor`.
 *
 * The wordmark reaches Space Grotesk through `--font-grotesk`, deliberately not
 * through `--font-display`. `--font-display` resolves to Geist and is consumed
 * by ~95 other sites (the `disp` inline helper across marketing, and the
 * Tailwind `font-display` utility across ~41 console files), so repointing it
 * to fix one component would restyle the console. That repoint is its own
 * decision; this component just names the variable it actually wants.
 */
export function AlethiaLockup({ tag = "labs", size = 24, className, style }: AlethiaLockupProps) {
	return (
		<span
			className={className}
			style={{
				display: "inline-flex",
				alignItems: "center",
				color: "currentColor",
				whiteSpace: "nowrap",
				...style,
			}}
		>
			<AlethiaMark size={size} style={{ flexShrink: 0 }} />
			<span
				style={{
					marginLeft: size * WORD_GAP,
					fontFamily: GROTESK,
					fontSize: size * WORD_SIZE,
					fontWeight: 600,
					letterSpacing: "-0.02em",
					// Without this the span's default line box is taller than the mark
					// and the row height stops being `size`.
					lineHeight: 1,
				}}
			>
				Alethia
			</span>
			{tag !== "none" && (
				<span
					style={{
						marginLeft: size * TAG_GAP,
						fontFamily: MONO,
						fontSize: size * TAG_SIZE,
						fontWeight: 500,
						letterSpacing: TAG_TRACKING[tag],
						lineHeight: 1,
						// currentColor at the canonical asset's own fill-opacity, rather
						// than a fixed ramp step: the lockup has to sit on inverted and
						// image surfaces (OG cards, the auth shell) where a hardcoded
						// --text-tertiary would ignore the colour it was handed.
						opacity: 0.55,
					}}
				>
					{TAG_LABEL[tag]}
				</span>
			)}
		</span>
	);
}
