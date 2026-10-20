// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The environment-status query (#6119: now the `canvas.environmentStatus` GET procedure).
//
// It must run on the DEFAULT environment. It was once gated on `!!projectId && !!environmentId`, and
// the caller passed `searchParams.get("environment_id")` — null on every visit to a project that has
// not explicitly switched environments — so on the default environment it never ran, and everything
// it feeds was dead there. The server has always resolved an absent id to the project's default.
//
// And it must NOT poll: a change to the environment is a hint on the org's change stream
// (lib/query/topics.ts). It used to refetch every 4 s while a job ran and every 30 s otherwise.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeCall, FakeHandler } from "@/tests/helpers/fake-orpc";

const h = vi.hoisted(() => ({
	handlers: {} as Record<string, FakeHandler>,
	calls: [] as FakeCall[],
}));
vi.mock("@/lib/rpc/client", async () => {
	const { fakeOrpc } = await import("@/tests/helpers/fake-orpc");
	return { orpc: fakeOrpc(h.handlers, h.calls).orpc };
});

const { useEnvironmentStatusQuery } = await import(
	"@/lib/query/use-environment-status-query"
);
const { EMPTY_ENVIRONMENT_STATUS } = await import("@/lib/canvas/component-status");

let client: QueryClient;

function wrapper({ children }: { children: ReactNode }) {
	return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

/** The inputs `canvas.environmentStatus` was read with, in order. */
function reads(): unknown[] {
	return h.calls.filter((c) => c.path === "canvas.environmentStatus").map((c) => c.input);
}

beforeEach(() => {
	client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	h.calls.length = 0;
	h.handlers["canvas.environmentStatus"] = async () => EMPTY_ENVIRONMENT_STATUS;
});

describe("useEnvironmentStatusQuery", () => {
	it("RUNS when the environment id is null — that means 'the default environment'", async () => {
		renderHook(() => useEnvironmentStatusQuery("proj-1", null), { wrapper });
		// null is forwarded verbatim — the SERVER resolves it to the project's default env.
		await waitFor(() => expect(reads()).toEqual([{ projectId: "proj-1", environmentId: null }]));
	});

	it("runs with an explicit environment id too", async () => {
		renderHook(() => useEnvironmentStatusQuery("proj-1", "env-9"), { wrapper });
		await waitFor(() => expect(reads()).toEqual([{ projectId: "proj-1", environmentId: "env-9" }]));
	});

	it("reads undefined as null, so the key equals the one the page prefetched", async () => {
		renderHook(() => useEnvironmentStatusQuery("proj-1", undefined), { wrapper });
		await waitFor(() => expect(reads()).toEqual([{ projectId: "proj-1", environmentId: null }]));
	});

	it("does NOT run without a project — the create flow has nothing to fetch", async () => {
		renderHook(() => useEnvironmentStatusQuery(undefined, null), { wrapper });
		await new Promise((r) => setTimeout(r, 50));
		expect(reads()).toEqual([]);
	});

	it("keys null and an explicit id separately, so switching envs refetches", async () => {
		const { rerender } = renderHook(
			({ env }: { env: string | null }) => useEnvironmentStatusQuery("proj-1", env),
			{ wrapper, initialProps: { env: null as string | null } },
		);
		await waitFor(() => expect(reads()).toHaveLength(1));
		rerender({ env: "env-9" });
		await waitFor(() => expect(reads()).toHaveLength(2));
		expect(reads()[1]).toEqual({ projectId: "proj-1", environmentId: "env-9" });
	});

	it("declares no poll: the query carries no refetchInterval", async () => {
		renderHook(() => useEnvironmentStatusQuery("proj-1", null), { wrapper });
		await waitFor(() => expect(reads()).toHaveLength(1));
		const [query] = client.getQueryCache().getAll();
		expect(query?.observers[0]?.options.refetchInterval).toBeUndefined();
	});
});
