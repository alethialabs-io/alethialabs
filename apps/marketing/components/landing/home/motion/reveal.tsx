// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

"use client";

import { type CSSProperties, type ReactNode, useRef } from "react";
import { type Transition, motion, useInView } from "motion/react";
import { usePrefersReducedMotion } from "./use-reduced-motion";

/** Cohesive settle for the whole motion language: a slightly stiff spring. */
const SETTLE: Transition = { type: "spring", stiffness: 220, damping: 30, mass: 0.9 };

/** Compute a stagger delay (seconds) for the i-th item in a revealed group. */
export function stagger(i: number, step = 0.07, base = 0): number {
	return base + i * step;
}

/**
 * Reveal — fades/rises its children in once they scroll into view (fires once).
 * The lift is `y` px. Under `prefers-reduced-motion` it renders in its final,
 * fully-legible state with no transform and no transition.
 */
export function Reveal({
	children,
	delay = 0,
	y = 16,
	amount = 0.3,
	className,
	style,
}: {
	children: ReactNode;
	delay?: number;
	y?: number;
	amount?: number;
	className?: string;
	style?: CSSProperties;
}) {
	const ref = useRef<HTMLDivElement>(null);
	const inView = useInView(ref, { once: true, amount });
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
			initial={{ opacity: 0, y }}
			animate={inView ? { opacity: 1, y: 0 } : { opacity: 0, y }}
			transition={{ ...SETTLE, delay }}
		>
			{children}
		</motion.div>
	);
}
