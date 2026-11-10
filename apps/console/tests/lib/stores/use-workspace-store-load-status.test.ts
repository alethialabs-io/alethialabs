// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// A failed workspace load is not a workspace load that never happened (#5895).
//
// `fetchWorkspace()` used to swallow a failure of the workspace read and put the store back in
// exactly the never-fetched shape: `entitlements` `null`, nothing loading. Since #5883 `null` means
// "unknown" and every gated surface waits it out, so a failed load left Runners on its skeleton for
// good with no error and no retry. The store now says `failed`, distinct from `idle` and `loading`,
// a second call is the retry, and the entitlement gates still fail closed. Real store, real hook;
// only the workspace read (`rpcClient.workspace.context`) is mocked.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceContext } from "@/lib/rpc/procedures/workspace";

const { readContext } = vi.hoisted(() => ({
	readContext: vi.fn<() => Promise<WorkspaceContext>>(),
}));

// The store reads the workspace over the read router's GET procedure (#6114); only that call is
// stubbed — the query helpers and the tenant partition stay real.
vi.mock("@/lib/rpc/client", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/rpc/client")>()),
	rpcClient: { workspace: { context: readContext } },
}));
vi.mock("@/app/server/actions/workspace", () => ({ setActiveOrganization: vi.fn() }));

import { useEntitlement } from "@/components/settings/enterprise-gate";
import { COMMUNITY_ENTITLEMENTS } from "@/lib/billing/plan";
import { orpc } from "@/lib/rpc/client";
import {
	useWorkspaceContextQuery,
	useWorkspaceStore,
	useWorkspaceStoreSync,
} from "@/lib/stores/use-workspace-store";

/** A workspace context as the read router answers it, with the BYO-runners entitlement held. */
function context(): WorkspaceContext {
	return {
		activeOrgId: "org-1",
		organizations: [],
		entitlements: { ...COMMUNITY_ENTITLEMENTS, byoRunners: true },
		isHosted: true,
	};
}

/** A promise plus the handles that settle it, so a test can order two in-flight loads. */
function deferred(): {
	promise: Promise<WorkspaceContext>;
	resolve: (v: WorkspaceContext) => void;
	reject: (e: Error) => void;
} {
	let resolve: (v: WorkspaceContext) => void = () => {};
	let reject: (e: Error) => void = () => {};
	const promise = new Promise<WorkspaceContext>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

beforeEach(() => {
	readContext.mockReset();
	useWorkspaceStore.setState({
		activeOrgId: null,
		organizations: [],
		entitlements: null,
		isHosted: false,
		loadStatus: "idle",
	});
});

describe("useWorkspaceStore load status (#5895)", () => {
	it("starts idle — the state the server render and the first client paint share", () => {
		expect(useWorkspaceStore.getState().loadStatus).toBe("idle");
	});

	it("is loading while readContext is in flight, then loaded", async () => {
		const pending = deferred();
		readContext.mockReturnValue(pending.promise);
		const load = useWorkspaceStore.getState().fetchWorkspace();
		expect(useWorkspaceStore.getState().loadStatus).toBe("loading");
		pending.resolve(context());
		await load;
		expect(useWorkspaceStore.getState().loadStatus).toBe("loaded");
		expect(useWorkspaceStore.getState().entitlements?.byoRunners).toBe(true);
	});

	it("says failed — not idle — when readContext throws", async () => {
		readContext.mockRejectedValue(new Error("network down"));
		await useWorkspaceStore.getState().fetchWorkspace();
		expect(useWorkspaceStore.getState().loadStatus).toBe("failed");
	});

	it("keeps every entitlement gate closed on a failed load: unknown, never false or true", async () => {
		readContext.mockRejectedValue(new Error("network down"));
		await useWorkspaceStore.getState().fetchWorkspace();
		const { result } = renderHook(() => useEntitlement("byoRunners"));
		expect(result.current).toBeNull();
	});

	it("recovers on a retry: a second fetchWorkspace after a failure loads the workspace", async () => {
		readContext.mockRejectedValueOnce(new Error("network down"));
		await useWorkspaceStore.getState().fetchWorkspace();
		expect(useWorkspaceStore.getState().loadStatus).toBe("failed");

		readContext.mockResolvedValueOnce(context());
		await useWorkspaceStore.getState().fetchWorkspace();
		expect(useWorkspaceStore.getState().loadStatus).toBe("loaded");
		expect(useWorkspaceStore.getState().entitlements?.byoRunners).toBe(true);
	});

	it("keeps an earlier successful answer when a later refresh fails", async () => {
		readContext.mockResolvedValueOnce(context());
		await useWorkspaceStore.getState().fetchWorkspace();
		readContext.mockRejectedValueOnce(new Error("network down"));
		await useWorkspaceStore.getState().fetchWorkspace();
		expect(useWorkspaceStore.getState().loadStatus).toBe("failed");
		expect(useWorkspaceStore.getState().entitlements?.byoRunners).toBe(true);
	});

	it("lets only the latest call settle the store: an earlier load failing late does not undo a retry", async () => {
		const first = deferred();
		const second = deferred();
		readContext.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
		const a = useWorkspaceStore.getState().fetchWorkspace();
		const b = useWorkspaceStore.getState().fetchWorkspace();
		second.resolve(context());
		await b;
		first.reject(new Error("timed out"));
		await a;
		expect(useWorkspaceStore.getState().loadStatus).toBe("loaded");
	});
});

describe("useWorkspaceStoreSync — the shell's store sync (#6114)", () => {
	/** Mounts the sync hook under `client`; `result` is the query the hook reads, as it renders. */
	function mountSync(client: QueryClient) {
		const wrapper = ({ children }: { children: ReactNode }) =>
			createElement(QueryClientProvider, { client }, children);
		return renderHook(
			() => {
				useWorkspaceStoreSync();
				return useWorkspaceContextQuery();
			},
			{ wrapper },
		);
	}

	it("a background refetch that fails keeps a loaded store loaded, and a later success keeps it so", async () => {
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
		});
		const key = orpc.workspace.context.queryKey();
		client.setQueryData(key, context()); // what the layout hydrated
		const { result } = mountSync(client);
		await waitFor(() => expect(useWorkspaceStore.getState().loadStatus).toBe("loaded"));

		readContext.mockRejectedValueOnce(new Error("network down"));
		await act(() => client.refetchQueries({ queryKey: key }));
		// The hook has RENDERED the failed refetch (with its last good data) — and the store held.
		await waitFor(() => expect(result.current.isError).toBe(true));
		expect(result.current.data).toBeDefined();
		expect(useWorkspaceStore.getState().loadStatus).toBe("loaded");

		readContext.mockResolvedValueOnce(context());
		await act(() => client.refetchQueries({ queryKey: key }));
		await waitFor(() => expect(result.current.isSuccess).toBe(true));
		expect(useWorkspaceStore.getState().loadStatus).toBe("loaded");
	});

	it("a query with nothing to show that fails is a failed load", async () => {
		const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		readContext.mockRejectedValueOnce(new Error("network down"));
		mountSync(client);
		await waitFor(() => expect(useWorkspaceStore.getState().loadStatus).toBe("failed"));
	});
});
