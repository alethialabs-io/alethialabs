// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

"use client";

import { type CSSProperties, type ReactNode, useRef } from "react";
import { motion, useInView } from "motion/react";
import { usePrefersReducedMotion } from "./use-reduced-motion";

/**
 * Stamp — seals its child in with an over-scaled spring press (like a rubber
 * stamp landing) the first time it scrolls into view. Appears instantly in its
 * final state under `prefers-reduced-motion`.
 */
export function Stamp({
	children,
	delay = 0,
	className,
	style,
}: {
	children: ReactNode;
	delay?: number;
	className?: string;
	style?: CSSProperties;
}) {
	const ref = useRef<HTMLDivElement>(null);
	const inView = useInView(ref, { once: true, amount: 0.5 });
	const reduced = usePrefersReducedMotion();

	if (reduced) {
		return (
			<div ref={ref} className={className} style={style}>
				{children}
			</div>
		);
	}

	return (
		<motion.div
			ref={ref}
			className={className}
			style={style}
			initial={{ opacity: 0, scale: 1.6, rotate: -3 }}
			animate={
				inView
					? { opacity: 1, scale: 1, rotate: 0 }
					: { opacity: 0, scale: 1.6, rotate: -3 }
			}
			transition={{
				type: "spring",
				stiffness: 520,
				damping: 24,
				mass: 0.8,
				delay,
			}}
		>
			{children}
		</motion.div>
	);
}
