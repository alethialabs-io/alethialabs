// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The shared debounce hook (hooks/use-debounced-value.ts) — the standard's
// debounce step between a search input and the query key.

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDebouncedValue } from "@/hooks/use-debounced-value";

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("useDebouncedValue", () => {
	it("returns the initial value immediately", () => {
		const { result } = renderHook(() => useDebouncedValue("a", 250));
		expect(result.current).toBe("a");
	});

	it("holds the previous value until the delay elapses", () => {
		const { result, rerender } = renderHook(
			({ value }) => useDebouncedValue(value, 250),
			{ initialProps: { value: "a" } },
		);

		rerender({ value: "ab" });
		expect(result.current).toBe("a");

		act(() => vi.advanceTimersByTime(249));
		expect(result.current).toBe("a");

		act(() => vi.advanceTimersByTime(1));
		expect(result.current).toBe("ab");
	});

	it("restarts the timer on every change (only the last value lands)", () => {
		const { result, rerender } = renderHook(
			({ value }) => useDebouncedValue(value, 250),
			{ initialProps: { value: "a" } },
		);

		rerender({ value: "ab" });
		act(() => vi.advanceTimersByTime(200));
		rerender({ value: "abc" });
		act(() => vi.advanceTimersByTime(200));
		expect(result.current).toBe("a");

		act(() => vi.advanceTimersByTime(50));
		expect(result.current).toBe("abc");
	});
});
