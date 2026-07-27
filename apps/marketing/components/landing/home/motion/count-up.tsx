// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

"use client";

import { type CSSProperties, useEffect, useRef } from "react";
import { animate, motion, useInView, useMotionValue, useTransform } from "motion/react";
import { usePrefersReducedMotion } from "./use-reduced-motion";

/** Format a number with fixed decimals and thousands separators (grayscale data voice). */
function format(v: number, decimals: number): string {
	return v.toLocaleString("en-US", {
		minimumFractionDigits: decimals,
		maximumFractionDigits: decimals,
	});
}

/**
 * CountUp — animates 0 → `value` once the number scrolls into view, then holds.
 * Renders the final formatted value immediately under `prefers-reduced-motion`.
 * `prefix`/`suffix` frame the number; `decimals` controls precision.
 */
export function CountUp({
	value,
	prefix = "",
	suffix = "",
	decimals = 0,
	duration = 1.4,
	className,
	style,
}: {
	value: number;
	prefix?: string;
	suffix?: string;
	decimals?: number;
	duration?: number;
	className?: string;
	style?: CSSProperties;
}) {
	const ref = useRef<HTMLSpanElement>(null);
	const inView = useInView(ref, { once: true, amount: 0.6 });
	const reduced = usePrefersReducedMotion();
	const count = useMotionValue(0);
	const text = useTransform(count, (v) => `${prefix}${format(v, decimals)}${suffix}`);

	useEffect(() => {
		if (reduced || !inView) return;
		const controls = animate(count, value, {
			duration,
			ease: [0.16, 1, 0.3, 1],
		});
		return () => controls.stop();
	}, [inView, reduced, value, duration, count]);

	if (reduced) {
		return (
			<span ref={ref} className={className} style={style}>
				{`${prefix}${format(value, decimals)}${suffix}`}
			</span>
		);
	}

	return (
		<motion.span ref={ref} className={className} style={style}>
			{text}
		</motion.span>
	);
}
