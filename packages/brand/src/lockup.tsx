// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { CSSProperties, Ref, SVGProps } from "react";

/**
 * The brand's two React primitives: `AlethiaMark`, the `[·]` mark, and
 * `AlethiaLockup`, the bracketed wordmark every surface draws. Both are server-safe;
 * the scroll-folding header logo (`site/animated-mark.tsx`) is a client wrapper
 * around `AlethiaLockup`, not a second drawing of it.
 */

/**
 * Which brand the lockup names. A typed union rather than a free-form string
 * because the tracking is per-word, so a caller-supplied string could not carry
 * the right value. There is no product tag: the product is Alethia, so its lockup
 * is the wordmark alone (`"none"`); LABS names the company.
 */
export type LockupTag = "labs" | "docs" | "staff" | "none";

type NamedTag = Exclude<LockupTag, "none">;

/**
 * Literal uppercase, not `text-transform`. The lockup this replaced wrote
 * "Labs" and uppercased it in CSS, so selection, copy/paste and the accessible
 * name all yielded "Labs" while the brand is "LABS".
 */
const TAG_LABEL: Record<NamedTag, string> = {
	labs: "LABS",
	docs: "DOCS",
	staff: "STAFF",
};

const TAG_TRACKING: Record<NamedTag, string> = {
	labs: "0.26em",
	docs: "0.26em",
	staff: "0.24em",
};

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
	/**
	 * Which brand the lockup names. `"labs"` is the company (alethialabs.io); `"none"` is
	 * the product, Alethia, on its own — the console, sign-in, invites, the CLI hand-off.
	 * `"docs"` and `"staff"` tag the docs site and the admin app.
	 */
	tag?: LockupTag;
	/**
	 * Height in px; every part derives from it. Omit it to take `.ah-mark`'s responsive
	 * default (24px, 20px below 900px) — the site header does.
	 */
	size?: number;
	className?: string;
	style?: CSSProperties;
	/** Lets the animated header logo toggle `data-compact` on this element directly. */
	ref?: Ref<HTMLSpanElement>;
	/**
	 * True only for the animated header logo: the words then fold from their measured
	 * `--w`. Static lockups skip the max-width clamp so no width is ever guessed.
	 */
	animated?: boolean;
}

/**
 * The one Alethia lockup — `[ Alethia · LABS ]` — drawn in `currentColor` by every
 * surface: the site header (animated, `site/animated-mark.tsx`) and footer, the blog,
 * the console's auth shell, the docs nav, the admin bar. One component, so the logo
 * can no longer differ between the website and the product.
 *
 * The brackets are the `[·]` mark's two paths, each cropped to its own box, and the
 * dot between the words IS the mark's dot — so the header can fold the lockup into
 * the mark. The product (`tag="none"`) reads `[ Alethia ]`: no tag, so no dot.
 *
 * All geometry is CSS (`.ah-mark` in `tokens.css`), scaled by `--mark-s`. DOM text,
 * not SVG `<text>`: it takes the real fonts, `currentColor`, and a flex gap cannot
 * slide under a tag the way an absolutely positioned SVG word did.
 */
export function AlethiaLockup({ tag = "labs", size, className, style, ref, animated = false }: AlethiaLockupProps) {
	const lockupStyle: CSSProperties & Record<`--${string}`, string> =
		size === undefined ? { ...style } : { "--mark-s": `${size}px`, ...style };
	return (
		<span
			ref={ref}
			className={["ah-mark", animated ? "" : "ah-mark--static", className].filter(Boolean).join(" ")}
			style={lockupStyle}
			// Static lockups keep their text as the accessible name (the docs nav and the
			// footer link rely on it); the animated header one sits inside a labelled link.
			aria-hidden={animated ? true : undefined}
		>
			<svg className="ah-mark__br" viewBox="5 4.5 7.5 23" fill="none" aria-hidden="true">
				<path d="M11 6 H6.5 V26 H11" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
			</svg>
			<span className="ah-mark__word ah-mark__alethia">
				<span>Alethia</span>
			</span>
			{tag !== "none" && (
				<>
					<span className="ah-mark__dot" aria-hidden="true" />
					<span className="ah-mark__word ah-mark__labs" style={{ letterSpacing: TAG_TRACKING[tag] }}>
						<span>{TAG_LABEL[tag]}</span>
					</span>
				</>
			)}
			<svg className={tag === "none" ? "ah-mark__br ah-mark__br--solo" : "ah-mark__br"} viewBox="19.5 4.5 7.5 23" fill="none" aria-hidden="true">
				<path d="M21 6 H25.5 V26 H21" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
			</svg>
		</span>
	);
}
