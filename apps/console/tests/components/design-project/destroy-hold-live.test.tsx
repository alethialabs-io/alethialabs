// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6119 — a held destroy re-asks what it waits on when the bus says something changed, not on a
// 15 s timer. Its tenants are OTHER environments, so the `environments` and `jobs` topics both map
// onto its key (lib/query/topics.ts); an invalidation of that key is what a hint does.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useDestroyHold } from "@/components/design-project/canvas/cards/destroy-hold";
import { DESTROY_HOLD_KEY } from "@/lib/query/topics";
import type { DestroyTreeNode } from "@/components/design-project/canvas/cards/destroy-tree-view";
import { EMPTY_ENVIRONMENT_STATUS, type EnvironmentStatus } from "@/lib/canvas/component-status";
import { EnvironmentStatusProvider } from "@/lib/canvas/environment-status-context";

/** One node of a destroy tree, shaped as `buildDestroyTree` emits it. */
function node(over: Partial<DestroyTreeNode> & Pick<DestroyTreeNode, "name">): DestroyTreeNode {
	return {
		environment_id: `env-${over.name}`,
		placement_mode: "namespace",
		status: "ACTIVE",
		owns_fabric: false,
		waiting_on: [],
		...over,
	};
}

const DEV = node({ name: "dev-1" });
const OWNER = node({
	name: "prod",
	placement_mode: "dedicated",
	owns_fabric: true,
	waiting_on: [{ name: "dev-1", status: "ACTIVE" }],
});
const HELD: EnvironmentStatus = {
	...EMPTY_ENVIRONMENT_STATUS,
	activeJob: { id: "job-9", type: "DESTROY", status: "QUEUED" },
};

afterEach(() => vi.useRealTimers());

/** Mounts the hook under a held destroy, over its own query client. */
function mount(loadTree: () => Promise<DestroyTreeNode[]>) {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>
			<EnvironmentStatusProvider value={HELD}>{children}</EnvironmentStatusProvider>
		</QueryClientProvider>
	);
	return { client, ...renderHook(() => useDestroyHold(loadTree), { wrapper }) };
}

describe("useDestroyHold — live, not polled", () => {
	it("reads the tree once, and again only when its key is invalidated", async () => {
		const loadTree = vi.fn(async () => [DEV, OWNER]);
		const { client, result } = mount(loadTree);
		await waitFor(() => expect(result.current?.waitingOn.map((w) => w.name)).toEqual(["dev-1"]));
		expect(loadTree).toHaveBeenCalledTimes(1);

		await act(() => client.invalidateQueries({ queryKey: [...DESTROY_HOLD_KEY] }));
		await waitFor(() => expect(loadTree).toHaveBeenCalledTimes(2));
	});

	it("does not re-read on a timer", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "setTimeout"], shouldAdvanceTime: true });
		const loadTree = vi.fn(async () => [DEV, OWNER]);
		const { result } = mount(loadTree);
		await waitFor(() => expect(result.current).not.toBeNull());
		await act(() => vi.advanceTimersByTimeAsync(60_000));
		expect(loadTree).toHaveBeenCalledTimes(1);
	});
});
