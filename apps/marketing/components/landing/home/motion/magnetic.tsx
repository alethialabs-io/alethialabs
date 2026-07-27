// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

"use client";

import {
	type CSSProperties,
	type PointerEvent as ReactPointerEvent,
	type ReactNode,
	useRef,
} from "react";
import { motion, useMotionValue, useSpring } from "motion/react";
import { usePrefersReducedMotion } from "./use-reduced-motion";

/**
 * Magnetic — pulls its child toward the cursor while hovered, springing back on
 * leave. `strength` is the fraction of the pointer offset applied (0–1). A no-op
 * static wrapper under `prefers-reduced-motion` (no listeners, no transform).
 */
export function Magnetic({
	children,
	strength = 0.35,
	className,
	style,
}: {
	children: ReactNode;
	strength?: number;
	className?: string;
	style?: CSSProperties;
}) {
	const ref = useRef<HTMLDivElement>(null);
	const reduced = usePrefersReducedMotion();
	const x = useMotionValue(0);
	const y = useMotionValue(0);
	const sx = useSpring(x, { stiffness: 260, damping: 18, mass: 0.6 });
	const sy = useSpring(y, { stiffness: 260, damping: 18, mass: 0.6 });

	if (reduced) {
		return (
			<span className={className} style={style}>
				{children}
			</span>
		);
	}

	/** Offset the child by a fraction of the pointer's distance from center. */
	const onMove = (e: ReactPointerEvent<HTMLDivElement>) => {
		const el = ref.current;
		if (!el) return;
		const r = el.getBoundingClientRect();
		x.set((e.clientX - (r.left + r.width / 2)) * strength);
		y.set((e.clientY - (r.top + r.height / 2)) * strength);
	};

	/** Spring back to rest when the cursor leaves. */
	const onLeave = () => {
		x.set(0);
		y.set(0);
	};

	return (
		<motion.div
			ref={ref}
			className={className}
			style={{ display: "inline-flex", x: sx, y: sy, ...style }}
			onPointerMove={onMove}
			onPointerLeave={onLeave}
		>
			{children}
		</motion.div>
	);
}
