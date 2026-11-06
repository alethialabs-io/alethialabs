"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { CSSProperties } from "react";
import { memo, useMemo } from "react";
import { cn } from "@repo/ui/utils";

export interface TextShimmerProps {
	children: string;
	className?: string;
	duration?: number;
	spread?: number;
}

/**
 * Animated text shimmer (used by the Reasoning "Thinking…" trigger while a model
 * streams). A plain span running the `shimmer-sweep` keyframe from app/globals.css, which
 * loops for `duration` seconds a pass and stands still under reduced motion. The upstream
 * AI Elements version animated it with `motion`, which the console no longer ships (#6147).
 */
const ShimmerComponent = ({
	children,
	className,
	duration = 2,
	spread = 2,
}: TextShimmerProps) => {
	const dynamicSpread = useMemo(
		() => (children?.length ?? 0) * spread,
		[children, spread],
	);

	// CSS custom properties (`--spread`, `--shimmer-duration`) aren't part of React's
	// CSSProperties, so the style is typed as CSSProperties plus a `--*` index rather than asserted.
	const style: CSSProperties & Record<`--${string}`, string> = {
		"--spread": `${dynamicSpread}px`,
		"--shimmer-duration": `${duration}s`,
		backgroundImage:
			"var(--bg), linear-gradient(var(--color-muted-foreground), var(--color-muted-foreground))",
	};

	return (
		<span
			className={cn(
				"shimmer-sweep relative inline-block bg-[length:250%_100%,auto] bg-clip-text text-transparent",
				"[--bg:linear-gradient(90deg,#0000_calc(50%-var(--spread)),var(--color-background),#0000_calc(50%+var(--spread)))] [background-repeat:no-repeat,padding-box]",
				className,
			)}
			style={style}
		>
			{children}
		</span>
	);
};

export const Shimmer = memo(ShimmerComponent);
