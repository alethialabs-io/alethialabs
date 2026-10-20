// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6119 (ADR 0005 D5): the capability bag a node's pickers resolve against is SERVER state, so it is
// a query over `canvas.capabilities`, not a hand-rolled Zustand cache with its own TTL and in-flight
// dedupe. What the store promised still holds: N fields share ONE read, a picker is never blocked
// (loading and error are bags that resolve to the static catalog), and no identity reads nothing.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	NO_CAPABILITIES,
	type CapabilityBag,
} from "@/components/design-project/canvas/inspector/config-schema";
import type { FakeCall, FakeHandler } from "@/tests/helpers/fake-orpc";

const h = vi.hoisted(() => {
	const handlers: Record<string, FakeHandler> = {};
	const calls: FakeCall[] = [];
	return { handlers, calls };
});
vi.mock("@/lib/rpc/client", async () => {
	const { fakeOrpc } = await import("@/tests/helpers/fake-orpc");
	return { orpc: fakeOrpc(h.handlers, h.calls).orpc };
});

const { useCapabilities } = await import(
	"@/components/design-project/canvas/inspector/use-node-capabilities"
);

const READY: CapabilityBag = {
	...NO_CAPABILITIES,
	identityId: "id-1",
	provider: "aws",
	region: "eu-west-1",
	state: "ready",
	regions: ["eu-west-1"],
};

let qc: QueryClient;

function wrapper({ children }: { children: ReactNode }) {
	return createElement(QueryClientProvider, { client: qc }, children);
}

beforeEach(() => {
	qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	h.calls.length = 0;
	h.handlers["canvas.capabilities"] = async () => READY;
});

describe("useCapabilities", () => {
	it("is a loading bag while the read is in flight, then the account's bag", async () => {
		const { result } = renderHook(() => useCapabilities("id-1", "eu-west-1"), { wrapper });
		expect(result.current).toEqual({ ...NO_CAPABILITIES, identityId: "id-1", state: "loading" });
		await waitFor(() => expect(result.current).toEqual(READY));
		expect(h.calls).toEqual([
			{ path: "canvas.capabilities", input: { identityId: "id-1", region: "eu-west-1" } },
		]);
	});

	it("shares ONE read between every field asking about the same identity and region", async () => {
		const { result } = renderHook(
			() => [useCapabilities("id-1", "eu-west-1"), useCapabilities("id-1", "eu-west-1")],
			{ wrapper },
		);
		await waitFor(() => expect(result.current[1]).toEqual(READY));
		expect(h.calls).toHaveLength(1);
	});

	it("fails OPEN: a failed read is an error bag, which still resolves the static catalog", async () => {
		h.handlers["canvas.capabilities"] = async () => {
			throw new Error("boom");
		};
		const { result } = renderHook(() => useCapabilities("id-1", null), { wrapper });
		await waitFor(() => expect(result.current.state).toBe("error"));
		expect(result.current).toEqual({ ...NO_CAPABILITIES, identityId: "id-1", state: "error" });
	});

	it("reads nothing without an identity (create flow / no core identity)", async () => {
		const { result } = renderHook(() => useCapabilities(null, "eu-west-1"), { wrapper });
		await new Promise((r) => setTimeout(r, 30));
		expect(h.calls).toEqual([]);
		expect(result.current).toBe(NO_CAPABILITIES);
	});

	it("trusts a bag for hours, not the console's 30 s default — the catalog changes on a sweep", async () => {
		renderHook(() => useCapabilities("id-1", "eu-west-1"), { wrapper });
		await waitFor(() => expect(h.calls).toHaveLength(1));
		const [query] = qc.getQueryCache().getAll();
		expect(query?.observers[0]?.options.staleTime).toBe(6 * 60 * 60 * 1000);
	});
});
