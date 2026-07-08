// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// useAddonsQuery gates on projectId: in the create flow (no project/environment yet) it must NOT
// fetch — the Add-ons browser only exists on a live project's canvas. Once a projectId is supplied
// it fetches the catalog + install state.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

const { getProjectAddons } = vi.hoisted(() => ({ getProjectAddons: vi.fn() }));
vi.mock("@/app/server/actions/addons", () => ({
	getProjectAddons: (...args: unknown[]) => getProjectAddons(...args),
	enableAddon: vi.fn(),
	disableAddon: vi.fn(),
}));

import { useAddonsQuery } from "@/lib/query/use-addons-query";

/** A fresh QueryClient wrapper (retries off so failures surface immediately). */
function wrapper({ children }: { children: ReactNode }) {
	const qc = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return createElement(QueryClientProvider, { client: qc }, children);
}

describe("useAddonsQuery", () => {
	it("is disabled (never fetches) without a projectId — the create flow", () => {
		const { result } = renderHook(() => useAddonsQuery(undefined), { wrapper });
		expect(result.current.fetchStatus).toBe("idle");
		expect(result.current.data).toBeUndefined();
		expect(getProjectAddons).not.toHaveBeenCalled();
	});

	it("fetches the catalog once a projectId is supplied", async () => {
		getProjectAddons.mockResolvedValue({
			environmentId: "env-1",
			items: [],
			hasAppsRepo: false,
		});
		const { result } = renderHook(() => useAddonsQuery("proj-1", "env-1"), {
			wrapper,
		});
		await waitFor(() => expect(result.current.isSuccess).toBe(true));
		expect(getProjectAddons).toHaveBeenCalledWith("proj-1", "env-1");
		expect(result.current.data?.environmentId).toBe("env-1");
	});
});
