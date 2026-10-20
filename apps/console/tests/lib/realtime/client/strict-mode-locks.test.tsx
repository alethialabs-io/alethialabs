// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6115 PR B, found live: in React StrictMode (and on any remount) the mount starts, stops and starts
// again. Each document must then hold at most ONE Web Locks request for its election, or a stale
// request that is granted later holds the lock with no stream behind it and live updates stop.
// The REAL mount and runtime run here over a faithful in-memory Web Locks manager.

import { render } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeWebLocks } from "./fake-web-locks";

const h = vi.hoisted(() => ({ pathname: "/acme/~/jobs", viewerId: "u1" }));

vi.mock("next/navigation", () => {
	const router = { refresh: () => {} };
	return { usePathname: () => h.pathname, useRouter: () => router };
});
vi.mock("@/components/providers/viewer-provider", () => ({
	useViewer: () => ({ viewer: { id: h.viewerId }, isPending: false }),
}));
vi.mock("@/lib/rpc/client", () => ({
	tenantSegment: (p: string) => p.split("/")[1] || "~",
	orpc: { jobs: { key: () => ["jobs-orpc"] } },
}));

import { RealtimeMount } from "@/components/shell/realtime-mount";
import { electLeader, newElectionRegistry } from "@/lib/realtime/client/leader";
import { electionName } from "@/lib/realtime/client/runtime";

const NAME = electionName("u1", "acme");

describe("RealtimeMount under StrictMode — one lock request per document", () => {
	let locks: FakeWebLocks;
	const realLocks = Object.getOwnPropertyDescriptor(navigator, "locks");

	beforeEach(() => {
		locks = new FakeWebLocks();
		h.pathname = "/acme/~/jobs";
		h.viewerId = "u1";
		Object.defineProperty(window, "isSecureContext", { value: true, configurable: true });
		Object.defineProperty(navigator, "locks", { value: locks.client("doc-1"), configurable: true });
		// A stream that opens and stays open.
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(new ReadableStream(), { headers: { "Content-Type": "text/event-stream" } })),
		);
	});
	afterEach(() => {
		vi.unstubAllGlobals();
		if (realLocks) Object.defineProperty(navigator, "locks", realLocks);
		else Reflect.deleteProperty(navigator, "locks");
	});

	it("mount → StrictMode unmount → mount leaves exactly one request", async () => {
		const view = render(
			<StrictMode>
				<RealtimeMount />
			</StrictMode>,
		);
		await vi.waitFor(() => expect(locks.query().held).toHaveLength(1));
		await new Promise((r) => setTimeout(r, 10));
		expect(locks.requestsOf("doc-1", NAME)).toBe(1);
		view.unmount();
		await vi.waitFor(() => expect(locks.requestsOf("doc-1")).toBe(0));
	});

	it("a FOLLOWER (another document holds the lock): mount → unmount → mount leaves exactly one PENDING request", async () => {
		// Another tab leads: this document's requests queue, so only aborting them removes them.
		const other = electLeader({
			registry: newElectionRegistry(),
			name: NAME,
			locks: locks.client("doc-0"),
			openChannel: () => null,
			onLead: () => {},
		});
		await vi.waitFor(() => expect(locks.query().held).toEqual([{ name: NAME, clientId: "doc-0" }]));
		const view = render(
			<StrictMode>
				<RealtimeMount />
			</StrictMode>,
		);
		await new Promise((r) => setTimeout(r, 10));
		expect(locks.requestsOf("doc-1", NAME)).toBe(1);
		// The leader closes: this document's ONE request is granted, and leads.
		other.stop();
		await vi.waitFor(() => expect(locks.query().held).toEqual([{ name: NAME, clientId: "doc-1" }]));
		expect(locks.query().pending).toEqual([]);
		view.unmount();
		await vi.waitFor(() => expect(locks.requestsOf("doc-1")).toBe(0));
	});

	it("a remount (an org switch and back) never leaves a stale request behind", async () => {
		const view = render(
			<StrictMode>
				<RealtimeMount />
			</StrictMode>,
		);
		for (const path of ["/globex/~/jobs", "/acme/~/jobs", "/globex/~/jobs", "/acme/~/jobs"]) {
			h.pathname = path;
			view.rerender(
				<StrictMode>
					<RealtimeMount />
				</StrictMode>,
			);
		}
		await new Promise((r) => setTimeout(r, 20));
		expect(locks.requestsOf("doc-1")).toBe(1);
		expect(locks.requestsOf("doc-1", NAME)).toBe(1);
		view.unmount();
		await vi.waitFor(() => expect(locks.requestsOf("doc-1")).toBe(0));
	});
});
