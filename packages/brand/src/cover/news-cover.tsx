// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { coverScene, type CoverAspect, type CoverPaint } from "./cover-art";

export { coverScene, coverSvg, COVER_SIZES, MOTIFS, pickMotif } from "./cover-art";
export type { CoverAspect, CoverColors, CoverScene, Motif } from "./cover-art";

/** CSS variables a paint resolves to, so the cover follows the light and dark themes. */
const PAINT: Record<CoverPaint, string> = {
	ink: "var(--text-primary)",
	bg: "var(--surface-sunken)",
	none: "none",
};

/**
 * Generated grayscale cover art for a News post: inline SVG, decorative (`aria-hidden`), drawn in
 * the theme's ink on the sunken surface. It fills its box — give the parent the aspect ratio
 * (`aspect-video`, `aspect-[4/3]`) and the drawing is cropped to it, centred.
 */
export function NewsCover({
	slug,
	kind,
	aspect = "card",
	className,
}: {
	slug: string;
	kind: string;
	aspect?: CoverAspect;
	className?: string;
}) {
	const scene = coverScene(slug, kind, aspect);
	return (
		<svg
			viewBox={`0 0 ${scene.width} ${scene.height}`}
			preserveAspectRatio="xMidYMid slice"
			aria-hidden="true"
			focusable="false"
			data-motif={scene.motif}
			className={className}
			style={{ display: "block", width: "100%", height: "100%", background: PAINT.bg }}
		>
			{scene.shapes.map((s, i) =>
				s.type === "path" ? (
					<path
						key={i}
						d={s.d}
						fill={PAINT[s.fill]}
						fillOpacity={s.fillOpacity}
						stroke={PAINT.ink}
						strokeOpacity={s.opacity}
						strokeWidth={s.stroke}
						strokeLinejoin="round"
					/>
				) : (
					<circle
						key={i}
						cx={s.cx}
						cy={s.cy}
						r={s.r}
						fill={PAINT[s.fill]}
						opacity={s.opacity}
						stroke={s.stroke ? PAINT.ink : undefined}
						strokeWidth={s.stroke}
					/>
				),
			)}
		</svg>
	);
}
