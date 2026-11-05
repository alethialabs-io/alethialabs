// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The mention popover's debounced search (components/agent/elench/use-mentions.ts). Its loading
// flag and its list are DERIVED from the last answer and the query it answers (#6459), instead of
// being reset by an effect; these pin the behaviour that derivation must keep.

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MentionResult } from "@/lib/ai/mentions";

vi.mock("@/app/server/actions/mentions", () => ({ searchMentions: vi.fn() }));

import { searchMentions } from "@/app/server/actions/mentions";
import { type MentionAnchor, useMentionSearch } from "@/components/agent/elench/use-mentions";

/** One search result named `label`. */
function result(label: string): MentionResult {
	return { id: label, type: "project", label, sublabel: "" };
}

/** An anchor at the start of the box with `query` typed after the `@`. */
function at(query: string): MentionAnchor {
	return { start: 0, query };
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.mocked(searchMentions).mockImplementation(async (q = "") => [result(`hit:${q}`)]);
});

afterEach(() => {
	vi.useRealTimers();
	vi.clearAllMocks();
});

/** Let the 140ms debounce fire and the mocked search settle. */
async function settle(): Promise<void> {
	await act(async () => {
		await vi.advanceTimersByTimeAsync(200);
	});
}

describe("useMentionSearch", () => {
	it("is idle and empty with no anchor", () => {
		const { result: r } = renderHook(() => useMentionSearch(null));
		expect(r.current).toEqual({ results: [], loading: false });
	});

	// Fails if `loading` is not derived from the answered query: it would read false before the
	// first answer (an empty list that looks like "no matches").
	it("is loading from the first render of a query until its answer lands", async () => {
		const { result: r } = renderHook(() => useMentionSearch(at("pro")));
		expect(r.current.loading).toBe(true);
		await settle();
		expect(r.current).toEqual({ results: [result("hit:pro")], loading: false });
	});

	// Fails if the previous answer is dropped on a new query (the list would flash empty while
	// typing) or if it is treated as the new query's answer (loading would read false).
	it("keeps the previous rows up while the next query loads", async () => {
		const { result: r, rerender } = renderHook(({ a }) => useMentionSearch(a), {
			initialProps: { a: at("p") },
		});
		await settle();
		rerender({ a: at("pr") });
		expect(r.current).toEqual({ results: [result("hit:p")], loading: true });
		await settle();
		expect(r.current).toEqual({ results: [result("hit:pr")], loading: false });
	});

	// Fails if closing does not drop the answer: the next open would show the old list.
	it("closing drops the list, so the next open starts empty", async () => {
		const initialProps: { a: MentionAnchor | null } = { a: at("p") };
		const { result: r, rerender } = renderHook(({ a }) => useMentionSearch(a), { initialProps });
		await settle();
		rerender({ a: null });
		expect(r.current).toEqual({ results: [], loading: false });
		rerender({ a: at("q") });
		expect(r.current).toEqual({ results: [], loading: true });
	});

	// Fails if a failed search leaves the flag stuck on, or keeps the previous query's rows.
	it("a failed search settles to an empty, idle list", async () => {
		vi.mocked(searchMentions).mockRejectedValueOnce(new Error("down"));
		const { result: r } = renderHook(() => useMentionSearch(at("x")));
		await settle();
		expect(r.current).toEqual({ results: [], loading: false });
	});
});
