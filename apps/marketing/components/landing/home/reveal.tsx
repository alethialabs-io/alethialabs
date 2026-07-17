"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { type ReactNode, useEffect, useRef } from "react";

/**
 * Wraps the page and reveals each section on scroll. All direct `<section>`
 * children except the first (hero) fade/slide in as they enter the viewport.
 *
 * On browsers with scroll-driven timelines it attaches `.ah-reveal-v` and lets
 * CSS `animation-timeline: view()` drive the reveal on the compositor — no
 * observer, no layout thrash. Where that's unsupported it falls back to an
 * IntersectionObserver toggling `.ah-reveal`/`.in`. Reduced motion adds
 * nothing, so every section is simply visible. Because the classes are only
 * attached by JS, content is never hidden when JS is off.
 */
export function Reveal({ children }: { children: ReactNode }) {
	const ref = useRef<HTMLDivElement>(null);

	useEffect(() => {
		const root = ref.current;
		if (!root) return;
		const sections = Array.from(root.querySelectorAll(":scope > section")).slice(1);

		if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;

		if (typeof CSS !== "undefined" && CSS.supports("animation-timeline: view()")) {
			sections.forEach((s) => s.classList.add("ah-reveal-v"));
			return;
		}

		sections.forEach((s) => s.classList.add("ah-reveal"));
		const io = new IntersectionObserver(
			(entries) =>
				entries.forEach((e) => {
					if (e.isIntersecting) {
						e.target.classList.add("in");
						io.unobserve(e.target);
					}
				}),
			{ threshold: 0.12 },
		);
		sections.forEach((s) => io.observe(s));
		return () => io.disconnect();
	}, []);

	return <div ref={ref}>{children}</div>;
}
