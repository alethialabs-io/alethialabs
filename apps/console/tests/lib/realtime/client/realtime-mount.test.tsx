// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6115 PR B: the shell's mount. It starts one runtime per org segment with THAT org's QueryClient
// (captured at start), restarts on an org switch, and its indicator stays quiet for a blip under
// 3 s, then speaks through a polite live region. (Kept under tests/lib/realtime/ — the unit's scope.)

import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** The hoisted state the mocks read. */
interface Hoisted {
	pathname: string;
	viewerId: string | null;
	refresh: ReturnType<typeof vi.fn>;
	starts: Array<{ userId: string; tenant: string; queryClient: unknown; onRemoved: () => void }>;
	stops: ReturnType<typeof vi.fn>;
}

const h = vi.hoisted((): Hoisted => ({
	pathname: "/acme/~/jobs",
	viewerId: "u1",
	refresh: vi.fn(),
	starts: [],
	stops: vi.fn(),
}));

vi.mock("next/navigation", () => {
	const router = { refresh: h.refresh };
	return { usePathname: () => h.pathname, useRouter: () => router };
});
vi.mock("@/components/providers/viewer-provider", () => ({
	useViewer: () => ({ viewer: h.viewerId === null ? null : { id: h.viewerId }, isPending: false }),
}));
vi.mock("@/lib/rpc/client", () => ({
	tenantSegment: (p: string) => p.split("/")[1] || "~",
}));
vi.mock("@/lib/realtime/client/runtime", () => ({
	startRealtime: (o: { userId: string; tenant: string; queryClient: unknown; onRemoved: () => void }) => {
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
		h.viewerId = "u1";
		connectionStore.reset();
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

	it("is keyed on the person too: another account restarts it, nobody signed in starts nothing", () => {
		const { rerender } = render(<RealtimeMount />);
		h.viewerId = "u2";
		rerender(<RealtimeMount />);
		expect(h.starts.map((s) => `${s.userId}:${s.tenant}`)).toEqual(["u1:acme", "u2:acme"]);
		expect(h.stops).toHaveBeenCalledTimes(1);
		h.viewerId = null;
		rerender(<RealtimeMount />);
		expect(h.starts).toHaveLength(2);
		expect(h.stops).toHaveBeenCalledTimes(2);
	});

	it("a slow FIRST connect says \"Connecting…\", never \"paused\"", () => {
		vi.useFakeTimers();
		connectionStore.reset(); // a runtime that has not been live yet
		render(<RealtimeMount />);
		const region = screen.getByRole("status");
		act(() => vi.advanceTimersByTime(3000));
		expect(region).toHaveTextContent("Connecting…");
		expect(region).not.toHaveTextContent("paused");
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
