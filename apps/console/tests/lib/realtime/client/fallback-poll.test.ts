// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// #6115 PR B, R7: the ONE sanctioned poll runs only while the stream is down, only in a visible tab,
// and never after a terminal state.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createConnectionStore } from "@/lib/realtime/client/connection-state";
import { startFallbackPoll } from "@/lib/realtime/client/fallback-poll";

describe("startFallbackPoll", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("never polls while live", () => {
		const store = createConnectionStore();
		store.set("live");
		const refresh = vi.fn();
		const stop = startFallbackPoll({ store, isVisible: () => true, refresh });
		vi.advanceTimersByTime(5 * 60_000);
		expect(refresh).not.toHaveBeenCalled();
		stop();
	});

	it("down for 15 s → refresh, then every 30 s; live again → stops", () => {
		const store = createConnectionStore();
		store.set("live");
		const refresh = vi.fn();
		const stop = startFallbackPoll({ store, isVisible: () => true, refresh });
		store.set("reconnecting");
		vi.advanceTimersByTime(14_999);
		expect(refresh).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(refresh).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(30_000);
		expect(refresh).toHaveBeenCalledTimes(2);
		store.set("degraded"); // still down: the same poll keeps going, no second one
		vi.advanceTimersByTime(30_000);
		expect(refresh).toHaveBeenCalledTimes(3);
		store.set("live");
		vi.advanceTimersByTime(5 * 60_000);
		expect(refresh).toHaveBeenCalledTimes(3);
		stop();
	});

	it("a blip shorter than the grace never polls", () => {
		const store = createConnectionStore();
		store.set("live");
		const refresh = vi.fn();
		const stop = startFallbackPoll({ store, isVisible: () => true, refresh });
		store.set("reconnecting");
		vi.advanceTimersByTime(10_000);
		store.set("live");
		vi.advanceTimersByTime(60_000);
		expect(refresh).not.toHaveBeenCalled();
		stop();
	});

	it("a hidden tab does not poll", () => {
		const store = createConnectionStore();
		const refresh = vi.fn();
		const stop = startFallbackPoll({ store, isVisible: () => false, refresh });
		vi.advanceTimersByTime(5 * 60_000);
		expect(refresh).not.toHaveBeenCalled();
		stop();
	});

	it.each(["signed-out", "removed"] as const)("%s stops the poll for good", (state) => {
		const store = createConnectionStore();
		const refresh = vi.fn();
		const stop = startFallbackPoll({ store, isVisible: () => true, refresh });
		vi.advanceTimersByTime(15_000);
		expect(refresh).toHaveBeenCalledTimes(1);
		store.set(state);
		vi.advanceTimersByTime(5 * 60_000);
		expect(refresh).toHaveBeenCalledTimes(1);
		stop();
	});

	it("stop() ends it", () => {
		const store = createConnectionStore();
		const refresh = vi.fn();
		const stop = startFallbackPoll({ store, isVisible: () => true, refresh });
		stop();
		vi.advanceTimersByTime(5 * 60_000);
		expect(refresh).not.toHaveBeenCalled();
	});
});
