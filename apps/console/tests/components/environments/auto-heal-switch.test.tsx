// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6819: an environment's auto-heal switch. It used to be one mutation for the whole page, neither
// optimistic nor disabled: the switch stayed where it was until the read came back, and a toggle on
// a second environment while the first was in flight was dropped. Each row now owns its write — it
// moves at once, is disabled until ITS write settles, rolls back if the write fails, and a viewer
// who may not change it gets it disabled with the reason.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeHandler } from "@/tests/helpers/fake-orpc";

const h = vi.hoisted(() => ({
	handlers: {} as Record<string, FakeHandler>,
	setAutoHeal: vi.fn(),
	toast: { success: vi.fn(), error: vi.fn() },
}));
vi.mock("@/lib/rpc/client", async () => {
	const { fakeOrpc } = await import("@/tests/helpers/fake-orpc");
	return { orpc: fakeOrpc(h.handlers).orpc };
});
vi.mock("sonner", () => ({ toast: h.toast }));
vi.mock("@/app/server/actions/projects", () => ({ setAutoHeal: h.setAutoHeal }));

import { AutoHealSwitch, withAutoHeal } from "@/components/environments/auto-heal-switch";
import { MANAGE_DENIED_REASON } from "@/components/errors/manage-gate";
import type { EnvironmentsOverview } from "@/lib/rpc/procedures/environments";
import { PROJECT_ID, overviewOf } from "./fixtures";

const KEY = ["environments", "overview", "test"];

/** The reconcile state of one environment with auto-heal `autoHeal`. */
function reconcile(environmentId: string, autoHeal: boolean): EnvironmentsOverview["reconcile"][number] {
	return {
		environmentId,
		autoHeal,
		driftInSync: true,
		deliveryInSync: null,
		deployPending: false,
		clusterMissing: null,
		lastDeployedAt: null,
		probe: { reachable: null, message: null, probedAt: null },
	};
}

/** Narrows the cached value back to the read, for assertions. */
function cached(client: QueryClient): EnvironmentsOverview["reconcile"] {
	const value: unknown = client.getQueryData(KEY);
	if (typeof value !== "object" || value === null || !("reconcile" in value) || !Array.isArray(value.reconcile)) {
		throw new Error("the read is not in the cache");
	}
	return value.reconcile;
}

/** Two rows' switches over one cached read, as the Environments table mounts them. */
function Switches({ client, denied = null }: { client: QueryClient; denied?: string | null }) {
	const reconcileNow = cached(client);
	return (
		<QueryClientProvider client={client}>
			{["env-dev", "env-prod"].map((id) => (
				<AutoHealSwitch
					key={id}
					projectId={PROJECT_ID}
					environmentId={id}
					environmentName={id === "env-dev" ? "development" : "production"}
					enabled={reconcileNow.find((r) => r.environmentId === id)?.autoHeal ?? false}
					overviewKey={KEY}
					deniedReason={denied}
				/>
			))}
		</QueryClientProvider>
	);
}

let client: QueryClient;
beforeEach(() => {
	vi.clearAllMocks();
	client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
	client.setQueryData(KEY, overviewOf({ reconcile: [reconcile("env-dev", false), reconcile("env-prod", false)] }));
});

describe("withAutoHeal", () => {
	it("sets one environment's auto-heal and leaves every other one alone", () => {
		const before = overviewOf({ reconcile: [reconcile("env-dev", false), reconcile("env-prod", false)] });
		const after = withAutoHeal(before, "env-prod", true);
		expect(after).toMatchObject({ reconcile: [{ environmentId: "env-dev", autoHeal: false }, { environmentId: "env-prod", autoHeal: true }] });
		// The cached read itself is not mutated: a failed write restores it by reference.
		expect(before.reconcile[1].autoHeal).toBe(false);
	});

	it("returns a value that is not the read as it is", () => {
		expect(withAutoHeal(undefined, "env-prod", true)).toBeUndefined();
		expect(withAutoHeal({ other: 1 }, "env-prod", true)).toEqual({ other: 1 });
	});
});

describe("AutoHealSwitch", () => {
	it("is optimistic: the read is patched before the server answers, and the write names its environment", async () => {
		let settle: () => void = () => {};
		h.setAutoHeal.mockImplementation(() => new Promise<void>((resolve) => (settle = resolve)));
		render(<Switches client={client} />);

		await userEvent.click(screen.getByRole("switch", { name: "Toggle auto-heal for production" }));
		await waitFor(() => expect(h.setAutoHeal).toHaveBeenCalledWith(PROJECT_ID, "env-prod", true));
		expect(cached(client).find((r) => r.environmentId === "env-prod")?.autoHeal).toBe(true);
		expect(cached(client).find((r) => r.environmentId === "env-dev")?.autoHeal).toBe(false);
		settle();
		await waitFor(() => expect(h.toast.success).toHaveBeenCalledWith("Auto-heal on for production"));
	});

	it("pending is per environment: one row's write in flight disables that row only, and the other still writes", async () => {
		h.setAutoHeal.mockImplementation(() => new Promise<void>(() => {}));
		render(<Switches client={client} />);
		const production = screen.getByRole("switch", { name: "Toggle auto-heal for production" });
		const development = screen.getByRole("switch", { name: "Toggle auto-heal for development" });

		await userEvent.click(production);
		// base-ui's switch is a `<span role="switch">`: its disabled state is `aria-disabled`.
		await waitFor(() => expect(production).toHaveAttribute("aria-disabled", "true"));
		expect(development).not.toHaveAttribute("aria-disabled", "true");

		await userEvent.click(development);
		await waitFor(() => expect(h.setAutoHeal).toHaveBeenCalledWith(PROJECT_ID, "env-dev", true));
		expect(h.setAutoHeal).toHaveBeenCalledTimes(2);
	});

	it("a write that fails rolls the switch back and says so — the thrown text is never shown", async () => {
		h.setAutoHeal.mockRejectedValue(new Error("pg: connection refused at 10.0.0.4"));
		render(<Switches client={client} />);

		await userEvent.click(screen.getByRole("switch", { name: "Toggle auto-heal for production" }));
		await waitFor(() => expect(h.toast.error).toHaveBeenCalledTimes(1));
		expect(cached(client).find((r) => r.environmentId === "env-prod")?.autoHeal).toBe(false);
		expect(JSON.stringify(h.toast.error.mock.calls)).not.toContain("connection refused");
		expect(h.toast.success).not.toHaveBeenCalled();
	});

	it("a viewer who may not change it gets it disabled with the reason, and nothing is sent", async () => {
		render(<Switches client={client} denied={MANAGE_DENIED_REASON} />);
		const production = screen.getByRole("switch", { name: "Toggle auto-heal for production" });
		expect(production).toHaveAttribute("aria-disabled", "true");
		expect(production).toHaveAccessibleDescription(MANAGE_DENIED_REASON);
		await userEvent.click(production);
		expect(h.setAutoHeal).not.toHaveBeenCalled();
	});
});
