// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

"use client";

import { type CSSProperties } from "react";
import { motion } from "motion/react";
import { usePrefersReducedMotion } from "./use-reduced-motion";

/**
 * ScanLine — a single hairline of light that sweeps top→bottom over its
 * positioned parent, then repeats. Renders nothing under
 * `prefers-reduced-motion`. Purely decorative (`aria-hidden`); the parent must
 * be `position: relative` and clip overflow.
 */
export function ScanLine({
	duration = 2.6,
	className,
	style,
}: {
	duration?: number;
	className?: string;
	style?: CSSProperties;
}) {
	const reduced = usePrefersReducedMotion();
	if (reduced) return null;

	return (
		<motion.span
			aria-hidden
			className={className}
			style={{
				position: "absolute",
				left: 0,
				right: 0,
				top: 0,
				height: 1,
				pointerEvents: "none",
				background:
					"linear-gradient(90deg, transparent, var(--text-primary), transparent)",
				opacity: 0.55,
				...style,
			}}
			initial={{ top: "0%", opacity: 0 }}
			animate={{ top: ["0%", "100%"], opacity: [0, 0.55, 0.55, 0] }}
			transition={{
				duration,
				ease: "easeInOut",
				repeat: Number.POSITIVE_INFINITY,
				repeatDelay: 0.6,
			}}
		/>
	);
}
