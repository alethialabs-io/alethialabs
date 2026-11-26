// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The route hairline (#7740): it shows only for a navigation still running after 200ms, runs to
// ~86% while the route loads, then completes and fades on commit, and never parks forever.

import { act, render } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const nav = vi.hoisted(() => ({ pathname: "/acme", search: "" }));
vi.mock("next/navigation", () => ({
	usePathname: () => nav.pathname,
	useSearchParams: () => new URLSearchParams(nav.search),
}));

import {
	changesRoute,
	ROUTE_PROGRESS_DELAY_MS,
	RouteProgress,
	signalRouteTransitionStart,
} from "@/components/shell/route-progress";

/** The bar's drawn state. */
function phase(container: HTMLElement): string | null {
	return container.querySelector('[data-slot="route-progress"]')?.getAttribute("data-state") ?? null;
}

/** Moves the mocked router to `pathname` and re-renders, as a committed navigation would. */
function commit(rerender: (ui: ReactElement) => void, pathname: string) {
	nav.pathname = pathname;
	window.history.pushState({}, "", pathname);
	rerender(<RouteProgress />);
}

beforeEach(() => {
	vi.useFakeTimers();
	nav.pathname = "/acme";
	nav.search = "";
	window.history.replaceState({}, "", "/acme");
});

afterEach(() => {
	vi.useRealTimers();
});

describe("changesRoute", () => {
	const here = { href: "https://console.test/acme?tab=a", origin: "https://console.test", pathname: "/acme", search: "?tab=a" };
	/** `changesRoute` against the fixed location above. */
	const check = (url: string) => changesRoute(url, here);

	it("is true for another path or another query on this origin", () => {
		expect(check("/acme/~/jobs")).toBe(true);
		expect(check("/acme?tab=b")).toBe(true);
	});

	it("is false for the page already shown, a hash change, another origin or a bad URL", () => {
		expect(check("/acme?tab=a")).toBe(false);
		expect(check("/acme?tab=a#section")).toBe(false);
		expect(check("https://elsewhere.test/acme")).toBe(false);
		expect(check("http://[")).toBe(false);
	});
});

describe("RouteProgress", () => {
	it("stays idle for a navigation that commits within 200ms", () => {
		const { container, rerender } = render(<RouteProgress />);
		act(() => signalRouteTransitionStart("/acme/~/jobs"));
		act(() => vi.advanceTimersByTime(ROUTE_PROGRESS_DELAY_MS - 50));
		act(() => commit(rerender, "/acme/~/jobs"));
		act(() => vi.advanceTimersByTime(1000));
		expect(phase(container)).toBe("idle");
	});

	it("runs after 200ms, completes on commit, then returns to idle", () => {
		const { container, rerender } = render(<RouteProgress />);
		act(() => signalRouteTransitionStart("/acme/~/jobs"));
		expect(phase(container)).toBe("idle");
		act(() => vi.advanceTimersByTime(ROUTE_PROGRESS_DELAY_MS));
		expect(phase(container)).toBe("running");
		act(() => commit(rerender, "/acme/~/jobs"));
		expect(phase(container)).toBe("done");
		act(() => vi.advanceTimersByTime(500));
		expect(phase(container)).toBe("idle");
	});

	it("ignores a navigation to the page already shown", () => {
		const { container } = render(<RouteProgress />);
		act(() => signalRouteTransitionStart("/acme"));
		act(() => vi.advanceTimersByTime(1000));
		expect(phase(container)).toBe("idle");
	});

	it("finishes a navigation that never commits instead of parking at 86%", () => {
		const { container } = render(<RouteProgress />);
		act(() => signalRouteTransitionStart("/acme/~/jobs"));
		act(() => vi.advanceTimersByTime(ROUTE_PROGRESS_DELAY_MS));
		expect(phase(container)).toBe("running");
		act(() => vi.advanceTimersByTime(15_000));
		expect(phase(container)).toBe("done");
		act(() => vi.advanceTimersByTime(500));
		expect(phase(container)).toBe("idle");
	});

	it("is decorative", () => {
		const { container } = render(<RouteProgress />);
		expect(container.querySelector('[data-slot="route-progress"]')).toHaveAttribute("aria-hidden", "true");
	});
});
