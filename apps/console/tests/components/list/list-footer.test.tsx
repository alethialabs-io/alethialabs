// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// ListFooter (components/list/list-footer.tsx, #7482): the foot of every keyset list.
//   - more to load: a visible "Load more" button (keyboard / screen reader / no observer) AND the
//     scroll sentinel, which pulls the next page when it comes into view;
//   - loading: the button stays, disabled and aria-busy;
//   - failed: "Couldn't load more · Try again", and Try again asks for the page again;
//   - the end: nothing at all — no "That's all N", no count.

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
	// Only `isIntersecting` is read by the sentinel hook, so the fake reports only that.
	type Report = (entries: { isIntersecting: boolean }[]) => void;
	let callback: Report | null = null;
	class FakeObserver {
		constructor(cb: Report) {
			callback = cb;
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
		fire: () => callback?.(observed.map(() => ({ isIntersecting: true }))),
	};
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

	it("loading: the button stays where it was, disabled and busy, and the sentinel stands down", () => {
		const io = installObserver();
		render(<ListFooter list={state({ loadingMore: true })} />);
		const button = screen.getByRole("button", { name: "Load more" });
		expect(button).toBeDisabled();
		expect(button).toHaveAttribute("aria-busy", "true");
		expect(io.observed).toHaveLength(0);
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

	it("the end: renders nothing — no count, no 'that's all'", () => {
		const { container } = render(<ListFooter list={state({ hasMore: false })} />);
		expect(container).toBeEmptyDOMElement();
	});
});
