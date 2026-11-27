// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// ListFooter (components/list/list-footer.tsx, #7482, #7737): the foot of every keyset list.
//   - more to load: a visible "Load more" button (keyboard / screen reader / no observer) AND the
//     scroll sentinel, which pulls the next page once it is within 400px of the viewport — except
//     under prefers-reduced-data, where only the button pages;
//   - loading: the button stays, disabled and aria-busy, and the sentinel stands down;
//   - failed: "Couldn't load more · Try again", and Try again asks for the page again;
//   - the end: `END OF LIST` in mono once there are rows (nothing for an empty list) — never a count.

import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ListFooter, type ListFooterState } from "@/components/list/list-footer";

/** A footer state with a further page and nothing in flight, overridable per test. */
function state(over: Partial<ListFooterState> = {}): ListFooterState {
	return { rows: [1, 2, 3], hasMore: true, loadingMore: false, loadMoreFailed: false, loadMore: vi.fn(), ...over };
}

/** A controllable IntersectionObserver: `fire()` reports every observed element as in view. */
function installObserver() {
	const observed: Element[] = [];
	const margins: Array<string | undefined> = [];
	// Only `isIntersecting` is read by the sentinel hook, so the fake reports only that.
	type Report = (entries: { isIntersecting: boolean }[]) => void;
	let callback: Report | null = null;
	class FakeObserver {
		constructor(cb: Report, options?: { rootMargin?: string }) {
			callback = cb;
			margins.push(options?.rootMargin);
		}
		observe(el: Element) {
			observed.push(el);
		}
		disconnect() {
			observed.length = 0;
		}
		unobserve() {}
		takeRecords() {
			return [];
		}
	}
	vi.stubGlobal("IntersectionObserver", FakeObserver);
	return {
		observed,
		margins,
		fire: () => callback?.(observed.map(() => ({ isIntersecting: true }))),
	};
}

/** Stubs `matchMedia` so `prefers-reduced-data: reduce` reports `reduced`. */
function installReducedData(reduced: boolean) {
	vi.stubGlobal("matchMedia", (query: string) => ({
		matches: reduced && query === "(prefers-reduced-data: reduce)",
		media: query,
		addEventListener: () => {},
		removeEventListener: () => {},
	}));
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("ListFooter", () => {
	it("more to load: a visible Load more button that asks for the next page", () => {
		const list = state();
		render(<ListFooter list={list} />);
		const button = screen.getByRole("button", { name: "Load more" });
		expect(button).toBeEnabled();
		fireEvent.click(button);
		expect(list.loadMore).toHaveBeenCalledTimes(1);
	});

	it("the sentinel pulls the next page when it scrolls into view", () => {
		const io = installObserver();
		const list = state();
		render(<ListFooter list={list} />);
		expect(io.observed).toHaveLength(1);
		io.fire();
		expect(list.loadMore).toHaveBeenCalledTimes(1);
	});

	it("the sentinel starts the next page ~400px before the end comes into view", () => {
		const io = installObserver();
		render(<ListFooter list={state()} />);
		expect(io.margins).toEqual(["0px 0px 400px 0px"]);
	});

	it("under prefers-reduced-data the sentinel stands down and only the button pages", () => {
		const io = installObserver();
		installReducedData(true);
		const list = state();
		render(<ListFooter list={list} />);
		expect(io.observed).toHaveLength(0);
		fireEvent.click(screen.getByRole("button", { name: "Load more" }));
		expect(list.loadMore).toHaveBeenCalledTimes(1);
	});

	it("loading: the button stays where it was, disabled and busy, and the sentinel stands down", () => {
		const io = installObserver();
		render(<ListFooter list={state({ loadingMore: true })} />);
		const button = screen.getByRole("button", { name: "Load more" });
		expect(button).toBeDisabled();
		expect(button).toHaveAttribute("aria-busy", "true");
		// The product's one loader — the inline [·] mark Button pending draws — never a spun glyph.
		expect(button.querySelector('[data-slot="button-pending-mark"]')).not.toBeNull();
		expect(button.querySelector(".animate-spin")).toBeNull();
		expect(io.observed).toHaveLength(0);
	});

	it("a retry in flight says so on its own button", () => {
		render(<ListFooter list={state({ loadMoreFailed: true, loadingMore: true })} />);
		const button = screen.getByRole("button", { name: "Retrying…" });
		expect(button).toBeDisabled();
		expect(button).toHaveAttribute("aria-busy", "true");
	});

	it("failed: one status line with Try again, and no auto-retry from the sentinel", () => {
		const io = installObserver();
		const list = state({ loadMoreFailed: true });
		render(<ListFooter list={list} />);
		const line = screen.getByRole("status");
		expect(line).toHaveTextContent("Couldn't load more");
		expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
		expect(io.observed).toHaveLength(0);
		fireEvent.click(screen.getByRole("button", { name: "Try again" }));
		expect(list.loadMore).toHaveBeenCalledTimes(1);
	});

	it("the end: END OF LIST in mono — no count, no 'that's all', and no footer controls", () => {
		const { container } = render(<ListFooter list={state({ hasMore: false })} />);
		const end = container.querySelector('[data-slot="list-end"]');
		expect(end).toHaveTextContent(/^End of list$/);
		expect(end?.className).toContain("font-mono");
		expect(end?.className).toContain("uppercase");
		expect(end?.textContent).not.toMatch(/\d/);
		// The footer itself is gone: consumers read "nothing left to page" as no `list-footer`.
		expect(container.querySelector('[data-slot="list-footer"]')).toBeNull();
		expect(screen.queryByRole("button")).toBeNull();
	});

	it("the end of an empty list renders nothing — that is the empty state's job", () => {
		const { container } = render(<ListFooter list={state({ hasMore: false, rows: [] })} />);
		expect(container).toBeEmptyDOMElement();
	});
});
