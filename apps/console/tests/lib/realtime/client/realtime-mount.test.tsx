// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6115 PR B: the shell's mount. It starts one runtime per org segment with THAT org's QueryClient
// (captured at start), restarts on an org switch, and its indicator stays quiet for a blip under
// 3 s, then speaks through a polite live region. (Kept under tests/lib/realtime/ — the unit's scope.)

import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	pathname: "/acme/~/jobs",
	refresh: vi.fn(),
	starts: new Array<{ tenant: string; queryClient: unknown; onRemoved: () => void }>(),
	stops: vi.fn(),
}));

vi.mock("next/navigation", () => {
	const router = { refresh: h.refresh };
	return { usePathname: () => h.pathname, useRouter: () => router };
});
vi.mock("@/lib/rpc/client", () => ({
	tenantSegment: (p: string) => p.split("/")[1] || "~",
}));
vi.mock("@/lib/realtime/client/runtime", () => ({
	startRealtime: (o: { tenant: string; queryClient: unknown; onRemoved: () => void }) => {
		h.starts.push(o);
		return h.stops;
	},
}));

import { RealtimeMount } from "@/components/shell/realtime-mount";
import { getQueryClient } from "@/lib/query/client";
import { connectionStore } from "@/lib/realtime/client/connection-state";

describe("RealtimeMount", () => {
	beforeEach(() => {
		h.starts.length = 0;
		h.stops.mockClear();
		h.refresh.mockClear();
		h.pathname = "/acme/~/jobs";
		connectionStore.set("live");
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("starts with the org's own QueryClient and restarts only on an org switch", () => {
		const { rerender } = render(<RealtimeMount />);
		expect(h.starts.map((s) => s.tenant)).toEqual(["acme"]);
		expect(h.starts[0]!.queryClient).toBe(getQueryClient("acme"));

		h.pathname = "/acme/~/projects"; // same org, another page: no restart
		rerender(<RealtimeMount />);
		expect(h.starts).toHaveLength(1);

		h.pathname = "/globex/~/jobs";
		rerender(<RealtimeMount />);
		expect(h.stops).toHaveBeenCalledTimes(1);
		expect(h.starts.map((s) => s.tenant)).toEqual(["acme", "globex"]);
		expect(h.starts[1]!.queryClient).toBe(getQueryClient("globex"));
		expect(h.starts[1]!.queryClient).not.toBe(h.starts[0]!.queryClient);
	});

	it("`removed` refreshes the route", () => {
		render(<RealtimeMount />);
		h.starts[0]!.onRemoved();
		expect(h.refresh).toHaveBeenCalledTimes(1);
	});

	it("says nothing for a blip under 3 s, then announces the pause politely", () => {
		vi.useFakeTimers();
		render(<RealtimeMount />);
		const region = screen.getByRole("status");
		expect(region).toHaveAttribute("aria-live", "polite");
		act(() => connectionStore.set("reconnecting"));
		act(() => vi.advanceTimersByTime(2999));
		expect(region).toHaveTextContent("");
		act(() => vi.advanceTimersByTime(1));
		expect(region).toHaveTextContent("Live updates paused — retrying");
		act(() => connectionStore.set("live"));
		expect(region).toHaveTextContent("");
	});

	it("says signed-out at once", () => {
		render(<RealtimeMount />);
		act(() => connectionStore.set("signed-out"));
		expect(screen.getByRole("status")).toHaveTextContent("Signed out");
	});
});
