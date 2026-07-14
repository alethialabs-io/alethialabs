// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The environment-status query must run on the DEFAULT environment.
//
// It was gated on `!!projectId && !!environmentId`, and the caller passes
// `searchParams.get("environment_id")` — which is null on every visit to a project that hasn't
// explicitly switched environments. So on the default environment the query never ran, and
// everything it feeds was dead there: component status (a FAILED database read "Ready"), the drift
// chips, the cost chip, and the BYO-IaC architecture. It only came alive if the URL happened to
// carry an explicit `?environment_id=`.
//
// The server has always resolved an absent id to the project's default. Only the guard was wrong.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getEnvironmentComponentStatus = vi.fn();
vi.mock("@/app/server/actions/component-status", () => ({
	getEnvironmentComponentStatus: (...args: unknown[]) =>
		getEnvironmentComponentStatus(...args),
}));

const { useEnvironmentStatusQuery } = await import(
	"@/lib/query/use-environment-status-query"
);
const { EMPTY_ENVIRONMENT_STATUS } = await import("@/lib/canvas/component-status");

function wrapper({ children }: { children: ReactNode }) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false, refetchInterval: false } },
	});
	return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => {
	getEnvironmentComponentStatus.mockReset();
	getEnvironmentComponentStatus.mockResolvedValue(EMPTY_ENVIRONMENT_STATUS);
});

describe("useEnvironmentStatusQuery", () => {
	it("RUNS when the environment id is null — that means 'the default environment'", async () => {
		// The regression. `searchParams.get("environment_id")` is null in the common case, and the
		// query used to be disabled on it, silently killing status, cost, drift and the BYO-IaC board.
		renderHook(() => useEnvironmentStatusQuery("proj-1", null), { wrapper });

		await waitFor(() => expect(getEnvironmentComponentStatus).toHaveBeenCalled());
		// null is forwarded verbatim — the SERVER resolves it to the project's default env.
		expect(getEnvironmentComponentStatus).toHaveBeenCalledWith("proj-1", null);
	});

	it("runs with an explicit environment id too", async () => {
		renderHook(() => useEnvironmentStatusQuery("proj-1", "env-9"), { wrapper });
		await waitFor(() =>
			expect(getEnvironmentComponentStatus).toHaveBeenCalledWith("proj-1", "env-9"),
		);
	});

	it("does NOT run without a project — the create flow has nothing to fetch", async () => {
		renderHook(() => useEnvironmentStatusQuery(undefined, null), { wrapper });
		await new Promise((r) => setTimeout(r, 50));
		expect(getEnvironmentComponentStatus).not.toHaveBeenCalled();
	});

	it("keys null and an explicit id separately, so switching envs refetches", async () => {
		const { rerender } = renderHook(
			({ env }: { env: string | null }) => useEnvironmentStatusQuery("proj-1", env),
			{ wrapper, initialProps: { env: null as string | null } },
		);
		await waitFor(() =>
			expect(getEnvironmentComponentStatus).toHaveBeenCalledWith("proj-1", null),
		);
		rerender({ env: "env-9" });
		await waitFor(() =>
			expect(getEnvironmentComponentStatus).toHaveBeenCalledWith("proj-1", "env-9"),
		);
		expect(getEnvironmentComponentStatus).toHaveBeenCalledTimes(2);
	});
});
