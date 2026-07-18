"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { motion } from "motion/react";
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
 * streams). Renders a static `motion.span` — the upstream AI Elements version created
 * a motion component per element type during render, which this repo's lint forbids;
 * the inline span covers every in-app use.
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

	// CSS custom properties (`--spread`) aren't part of React's CSSProperties, so the style is
	// typed as CSSProperties plus a `--*` index rather than asserted.
	const style: CSSProperties & Record<`--${string}`, string> = {
		"--spread": `${dynamicSpread}px`,
		backgroundImage:
			"var(--bg), linear-gradient(var(--color-muted-foreground), var(--color-muted-foreground))",
	};

	return (
		<motion.span
			animate={{ backgroundPosition: "0% center" }}
			className={cn(
				"relative inline-block bg-[length:250%_100%,auto] bg-clip-text text-transparent",
				"[--bg:linear-gradient(90deg,#0000_calc(50%-var(--spread)),var(--color-background),#0000_calc(50%+var(--spread)))] [background-repeat:no-repeat,padding-box]",
				className,
			)}
			initial={{ backgroundPosition: "100% center" }}
			style={style}
			transition={{
				duration,
				ease: "linear",
				repeat: Number.POSITIVE_INFINITY,
			}}
		>
			{children}
		</motion.span>
	);
};

export const Shimmer = memo(ShimmerComponent);
