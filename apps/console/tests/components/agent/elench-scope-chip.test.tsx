// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #7895 — the Elench scope chip names its environment from the project's CANONICAL environments
// entry, the GET read `workspace.environments`, with the same options (and so the same cache entry)
// the topbar switcher reads and the `[project]` layout seeds. It used to call a server action of its
// own (`getEnvironmentsForSlug`, a POST that duplicated the switcher's read); that action is gone.
//
// Mocked: the read client (the fake `orpc`, which logs every read it serves) and the pathname. Real:
// the chip, the Elench store, TanStack Query.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeCall, FakeHandler } from "@/tests/helpers/fake-orpc";

const h = vi.hoisted(() => ({
	handlers: {} as Record<string, FakeHandler>,
	calls: [] as FakeCall[],
	pathname: "/acme/payments/clusters",
}));
vi.mock("@/lib/rpc/client", async () => {
	const { fakeOrpc } = await import("@/tests/helpers/fake-orpc");
	return { orpc: fakeOrpc(h.handlers, h.calls).orpc };
});
vi.mock("next/navigation", () => ({ usePathname: () => h.pathname }));

import { ElenchScopeChip } from "@/components/agent/elench/elench-scope-chip";
import { useElenchStore } from "@/lib/stores/use-elench-store";

const INITIAL = useElenchStore.getState();

/** The canonical list of project `payments`: a default `dev` and a `prod`. */
const ENVS = [
	{ id: "env-dev", project_id: "proj-1", name: "dev", stage: "development", is_default: true },
	{ id: "env-prod", project_id: "proj-1", name: "prod", stage: "production", is_default: false },
];

/** The cache key of `workspace.environments` for project `payments` — the switcher's entry. */
const CANONICAL_KEY = [["workspace", "environments"], { input: { project: "payments" }, type: "query" }];

/** Scopes the Elench conversation to project `payments`, on `environmentId` (null = the default). */
function scopeTo(environmentId: string | null) {
	useElenchStore.setState({
		ctx: { kind: "project", projectId: "proj-1", projectSlug: "payments", environmentId },
	});
}

/** Renders the chip over `client` (a fresh one by default). */
function renderChip(client = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
	render(
		<QueryClientProvider client={client}>
			<ElenchScopeChip />
		</QueryClientProvider>,
	);
	return client;
}

/** The chip's text. */
function chip(): string {
	return screen.getByTestId("elench-scope-chip").textContent ?? "";
}

beforeEach(() => {
	h.calls.length = 0;
	h.pathname = "/acme/payments/clusters";
	for (const key of Object.keys(h.handlers)) delete h.handlers[key];
	h.handlers["workspace.environments"] = async () => ENVS;
});

afterEach(() => {
	useElenchStore.setState(INITIAL, true);
});

describe("ElenchScopeChip — the environment, from the canonical GET read (#7895)", () => {
	it("names the scoped environment from `workspace.environments`, read by the slug in the path", async () => {
		scopeTo("env-prod");
		renderChip();
		await waitFor(() => expect(chip()).toBe("payments·prod"));
		expect(h.calls).toEqual([{ path: "workspace.environments", input: { project: "payments" } }]);
	});

	it("a conversation on the default names the default environment", async () => {
		scopeTo(null);
		renderChip();
		await waitFor(() => expect(chip()).toBe("payments·dev"));
	});

	it("shares the switcher's cache entry: a seeded entry is read with no request at all", async () => {
		const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
		client.setQueryData(CANONICAL_KEY, ENVS);
		scopeTo("env-prod");
		renderChip(client);
		expect(chip()).toBe("payments·prod");
		expect(h.calls).toEqual([]);
	});

	it("a failed read drops the environment half — never a wrong name", async () => {
		h.handlers["workspace.environments"] = async () => {
			throw new Error("network");
		};
		scopeTo("env-prod");
		renderChip();
		await waitFor(() => expect(h.calls).toHaveLength(1));
		expect(chip()).toBe("payments");
	});

	it("an org conversation renders nothing and reads nothing", () => {
		renderChip();
		expect(screen.queryByTestId("elench-scope-chip")).toBeNull();
		expect(h.calls).toEqual([]);
	});

	it("off a project route there is no slug to read by: the project half alone, no request", () => {
		h.pathname = "/acme/~/settings";
		scopeTo("env-prod");
		renderChip();
		expect(chip()).toBe("payments");
		expect(h.calls).toEqual([]);
	});
});
