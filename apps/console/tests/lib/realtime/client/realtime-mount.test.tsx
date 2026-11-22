// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6115 PR B: the shell's mount. It starts one runtime per org segment with THAT org's QueryClient
// (captured at start), restarts on an org switch, and its indicator stays quiet for a blip under
// 3 s, then speaks through a polite live region. (Kept under tests/lib/realtime/ — the unit's scope.)
// #6756: a stream that reports `signed-out` ends the session state, and the mount shows the one
// session-ended dialog instead of a line of text.

import { onlineManager } from "@tanstack/react-query";
import { act, render, screen, within } from "@testing-library/react";
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
import { endSession, useSessionState } from "@/lib/stores/use-session-state";

describe("RealtimeMount", () => {
	beforeEach(() => {
		h.starts.length = 0;
		h.stops.mockClear();
		h.refresh.mockClear();
		h.pathname = "/acme/~/jobs";
		h.viewerId = "u1";
		connectionStore.reset();
		connectionStore.set("live");
		useSessionState.setState({ status: "active", dismissed: false });
		window.history.replaceState(null, "", "/acme/~/jobs?status=failed");
	});
	afterEach(() => {
		vi.useRealTimers();
		// An ended session tells TanStack the browser is offline (lib/query/client.ts); undo it here.
		useSessionState.setState({ status: "active", dismissed: false });
		onlineManager.setOnline(true);
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

	it("a signed-out stream ends the session and shows the dialog at once, not a line of text", async () => {
		render(<RealtimeMount />);
		expect(screen.queryByRole("alertdialog")).toBeNull();
		act(() => connectionStore.set("signed-out"));
		expect(useSessionState.getState().status).toBe("ended");
		const dialog = await screen.findByRole("alertdialog");
		expect(dialog).toHaveTextContent("Your session has ended");
		expect(within(dialog).getByText("Sign in").closest("a")?.getAttribute("href")).toBe(
			"/login?next=%2Facme%2F~%2Fjobs%3Fstatus%3Dfailed",
		);
		expect(screen.getByRole("status")).toHaveTextContent("");
	});

	// S-10: toasts are bottom-centre, and the notice used to be fixed bottom-centre on the same rung,
	// so the two drew over each other. It now hangs under the shell header instead.
	it("the notice sits under the shell header, clear of the bottom-centre toasts", () => {
		render(<RealtimeMount />);
		const region = screen.getByRole("status");
		expect(region.className).toContain("top-[calc(var(--shell-header-h)+0.5rem)]");
		expect(region.className).not.toMatch(/\bbottom-/);
	});

	it("a session ended by another source silences the paused notice behind the dialog", async () => {
		vi.useFakeTimers();
		render(<RealtimeMount />);
		act(() => connectionStore.set("reconnecting"));
		act(() => vi.advanceTimersByTime(3000));
		expect(screen.getByRole("status")).toHaveTextContent("Live updates paused — retrying");
		act(() => endSession());
		expect(screen.getByRole("status")).toHaveTextContent("");
		expect(useSessionState.getState().status).toBe("ended");
	});
});
