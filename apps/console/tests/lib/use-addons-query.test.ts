// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// useAddonsQuery (#6119: the `canvas.addons` GET procedure) gates on projectId: in the create flow
// (no project/environment yet) it must NOT fetch. Once a projectId is supplied it fetches the
// catalog + install state — with no poll: an ArgoCD health flip is an `addons` hint on the org's
// change stream (lib/query/topics.ts), not a 15 s refetch. And an enable/disable invalidates every
// key that shows an add-on: the catalog AND the environment status (an installed add-on is a node).
// The writes are on the mutation contract (#6119): each action answers an `ActionResult`.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeCall, FakeHandler } from "@/tests/helpers/fake-orpc";

const h = vi.hoisted(() => {
	const handlers: Record<string, FakeHandler> = {};
	const calls: FakeCall[] = [];
	return {
		handlers,
		calls,
		enableAddon: vi.fn(async () => ({ ok: true as const, data: { addonId: "grafana" } })),
	};
});
vi.mock("@/lib/rpc/client", async () => {
	const { fakeOrpc } = await import("@/tests/helpers/fake-orpc");
	return { orpc: fakeOrpc(h.handlers, h.calls).orpc };
});
vi.mock("@/app/server/actions/addons", () => ({
	enableAddonAction: h.enableAddon,
	disableAddonAction: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

import { useAddonsQuery, useEnableAddon } from "@/lib/query/use-addons-query";

let qc: QueryClient;

/** A QueryClientProvider over the test's client (retries off so failures surface immediately). */
function wrapper({ children }: { children: ReactNode }) {
	return createElement(QueryClientProvider, { client: qc }, children);
}

const VIEW = { environmentId: "env-1", items: [], hasAppsRepo: false };

beforeEach(() => {
	qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	h.calls.length = 0;
	h.handlers["canvas.addons"] = async () => VIEW;
});

describe("useAddonsQuery", () => {
	it("is disabled (never fetches) without a projectId — the create flow", () => {
		const { result } = renderHook(() => useAddonsQuery(undefined), { wrapper });
		expect(result.current.fetchStatus).toBe("idle");
		expect(result.current.data).toBeUndefined();
		expect(h.calls).toEqual([]);
	});

	it("fetches the catalog once a projectId is supplied", async () => {
		const { result } = renderHook(() => useAddonsQuery("proj-1", "env-1"), { wrapper });
		await waitFor(() => expect(result.current.isSuccess).toBe(true));
		expect(h.calls).toEqual([
			{ path: "canvas.addons", input: { projectId: "proj-1", environmentId: "env-1" } },
		]);
		expect(result.current.data?.environmentId).toBe("env-1");
	});

	it("declares no poll: the query carries no refetchInterval", async () => {
		renderHook(() => useAddonsQuery("proj-1", "env-1"), { wrapper });
		await waitFor(() => expect(h.calls).toHaveLength(1));
		const [query] = qc.getQueryCache().getAll();
		expect(query?.observers[0]?.options.refetchInterval).toBeUndefined();
	});
});

describe("useEnableAddon", () => {
	it("invalidates the catalog and the environment status when it succeeds", async () => {
		const addons = [["canvas", "addons"], { input: { projectId: "p", environmentId: null }, type: "query" }];
		const status = [["canvas", "environmentStatus"], { input: { projectId: "p", environmentId: null }, type: "query" }];
		const other = [["canvas", "capabilities"], { input: {}, type: "query" }];
		for (const key of [addons, status, other]) qc.setQueryData(key, {});
		const { result } = renderHook(() => useEnableAddon(), { wrapper });
		await act(() => result.current.mutateAsync({ projectId: "p", addonId: "grafana" }));
		expect(qc.getQueryState(addons)?.isInvalidated).toBe(true);
		expect(qc.getQueryState(status)?.isInvalidated).toBe(true);
		expect(qc.getQueryState(other)?.isInvalidated).toBe(false);
	});
});

describe("useEnableAddon — a refusal", () => {
	it("is handed to the caller's onRefusal and still invalidates (the write may have landed)", async () => {
		h.enableAddon.mockResolvedValueOnce({
			ok: false,
			error: { kind: "not-found", message: "Unknown add-on: nope" },
		} as never);
		const addons = [["canvas", "addons"], { input: { projectId: "p", environmentId: null }, type: "query" }];
		qc.setQueryData(addons, {});
		const onRefusal = vi.fn();
		const { result } = renderHook(() => useEnableAddon({ onRefusal }), { wrapper });
		await act(async () => {
			await result.current.mutateAsync({ projectId: "p", addonId: "nope" }).catch(() => undefined);
		});
		expect(onRefusal).toHaveBeenCalledWith({ kind: "not-found", message: "Unknown add-on: nope" });
		expect(qc.getQueryState(addons)?.isInvalidated).toBe(true);
	});
});
