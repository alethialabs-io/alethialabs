// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// TEMPORARY MEASUREMENT PROBE for #5849 — removed before the PR leaves draft.

import type { Page } from "@playwright/test";

/**
 * Install an init script that timestamps, from navigation start: every flight/boundary script
 * the HTML parser inserts, the first appearance of the first filter-bar popover trigger, the
 * moment that node gains a React fiber (hydrated), every React commit (through a stand-in
 * devtools hook), long tasks and long animation frames with their script attribution.
 */
export async function installHydrationProbe(page: Page): Promise<void> {
	await page.addInitScript(() => {
		type Mark = { name: string; t: number; detail?: string };
		const probe = {
			marks: [] as Mark[],
			commits: [] as { t: number; prio: unknown; rootDehydrated: boolean; trig: boolean }[],
			scripts: [] as { t: number; kind: string; bytes: number }[],
			longtasks: [] as { start: number; dur: number }[],
			loaf: [] as unknown[],
			clicks: [] as { t: number; target: string; hydrated: boolean }[],
			rects: [] as { t: number; at: string; x: number; w: number }[],
		};
		Reflect.set(window, "__probe", probe);
		const now = () => Math.round(performance.now());
		const mark = (name: string, detail?: string) => probe.marks.push({ name, t: now(), detail });
		const hasFiber = (el: Element | null) =>
			!!el && Object.keys(el).some((k) => k.startsWith("__reactFiber$"));
		const trigger = () => {
			for (const el of document.querySelectorAll('main button[data-slot="popover-trigger"]')) {
				if (!el.closest("[hidden]")) return el;
			}
			return null;
		};
		const shell = () => document.querySelector("[data-slot=sidebar], aside, nav");
		const rect = (at: string) => {
			const el = trigger();
			if (!el) return;
			const r = el.getBoundingClientRect();
			probe.rects.push({ t: now(), at, x: Math.round(r.x), w: Math.round(r.width) });
		};
		Reflect.set(window, "__probeRect", rect);
		let seen = false;
		let hydrated = false;
		let shellHydrated = false;
		const poll = () => {
			const el = trigger();
			if (el && !seen) {
				seen = true;
				mark("trigger-in-dom", el.textContent ?? "");
				rect("in-dom");
			}
			if (el && !hydrated && hasFiber(el)) {
				hydrated = true;
				mark("trigger-hydrated");
				rect("hydrated");
			}
			if (!shellHydrated && hasFiber(shell())) {
				shellHydrated = true;
				mark("shell-hydrated");
			}
		};
		const frame = () => {
			poll();
			if (!hydrated || !shellHydrated) requestAnimationFrame(frame);
		};
		requestAnimationFrame(frame);
		new MutationObserver((records) => {
			for (const r of records) {
				for (const n of r.addedNodes) {
					if (n instanceof HTMLScriptElement) {
						const text = n.textContent ?? "";
						const kind = n.src
							? `src:${n.src.split("/").pop()}`
							: text.includes("__next_f")
								? "flight"
								: text.includes("$RC")
									? "reveal"
									: "inline";
						probe.scripts.push({ t: now(), kind, bytes: text.length });
					}
				}
			}
			poll();
		}).observe(document, { childList: true, subtree: true });
		let rendererId = 0;
		Reflect.set(window, "__REACT_DEVTOOLS_GLOBAL_HOOK__", {
			isDisabled: false,
			supportsFiber: true,
			renderers: new Map(),
			inject() {
				rendererId += 1;
				mark("react-inject");
				return rendererId;
			},
			onScheduleFiberRoot() {},
			onCommitFiberRoot(_id: number, root: { current?: { memoizedState?: { isDehydrated?: boolean } } }, prio: unknown) {
				probe.commits.push({
					t: now(),
					prio,
					rootDehydrated: !!root.current?.memoizedState?.isDehydrated,
					trig: hasFiber(trigger()),
				});
				poll();
			},
			onPostCommitFiberRoot() {},
			onCommitFiberUnmount() {},
			checkDCE() {},
		});
		document.addEventListener("DOMContentLoaded", () => mark("dcl"));
		window.addEventListener("load", () => mark("load"));
		window.addEventListener(
			"click",
			(e) => {
				const t = e.target instanceof Element ? e.target : null;
				rect("click");
				probe.clicks.push({ t: now(), target: t?.textContent?.slice(0, 40) ?? "", hydrated: hasFiber(t) });
			},
			true,
		);
		try {
			new PerformanceObserver((list) => {
				for (const e of list.getEntries()) probe.longtasks.push({ start: Math.round(e.startTime), dur: Math.round(e.duration) });
			}).observe({ type: "longtask", buffered: true });
			new PerformanceObserver((list) => {
				for (const e of list.getEntries()) probe.loaf.push(e.toJSON());
			}).observe({ type: "long-animation-frame", buffered: true });
		} catch {
			mark("observer-unsupported");
		}
	});
}

/** Read what the probe recorded so far. */
export async function readHydrationProbe(page: Page): Promise<unknown> {
	return page.evaluate(() => Reflect.get(window, "__probe"));
}
