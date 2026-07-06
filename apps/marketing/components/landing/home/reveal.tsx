"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { type ReactNode, useEffect, useRef } from "react";

/**
 * Wraps the page and reveals each section on scroll. All direct `<section>`
 * children except the first (hero) fade/slide in as they enter the viewport.
 * Honors `prefers-reduced-motion`.
 */
export function Reveal({ children }: { children: ReactNode }) {
	const ref = useRef<HTMLDivElement>(null);

	useEffect(() => {
		const root = ref.current;
		if (!root) return;
		const sections = Array.from(root.querySelectorAll(":scope > section")).slice(1);
		sections.forEach((s) => s.classList.add("ah-reveal"));

		if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
			sections.forEach((s) => s.classList.add("in"));
			return;
		}

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
