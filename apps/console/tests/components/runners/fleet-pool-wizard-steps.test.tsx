// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The warm-pool wizard on the shared wizard engine (#6840, C-25).
//
//   · An invalid advanced value is never a silent Create: emptied on Capacity, Next stays there with
//     "Advanced scaling" open and the field focused; refused by the server after Create, the wizard
//     returns to Capacity the same way.
//   · A refusal no field owns is said above the buttons, and a success clears the sheet from the URL.
//   · The clouds offered are the server's list, and a new pool starts on the first one nobody has
//     pooled, at that cloud's default region.
//   · The sheet, its step and the typed values survive a reload (the URL plus the tab draft).
//   · Editing names the pool in the URL and saves through the update action.
//
// "A reload" is an unmount and a fresh render over the same query string and tab storage — all a
// reload leaves the page (`fleet-pool-wizard-harness.ts`).

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FleetPool } from "@/lib/db/schema";

const { createPool, updatePool, offered, fleet } = vi.hoisted(() => ({
	createPool: vi.fn(),
	updatePool: vi.fn(),
	offered: { clouds: ["aws", "gcp", "azure", "hetzner"] },
	fleet: { configs: new Array<FleetPool>() },
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/app/server/actions/fleet", () => ({
	createFleetPoolAction: createPool,
	updateFleetPoolAction: updatePool,
}));
vi.mock("@/lib/stores/use-workspace-store", () => ({ useActiveOrgSlug: () => "acme" }));
vi.mock("@/lib/query/topics", () => ({ TOPIC_KEYS: { fleet: () => [["fleet"]] } }));
vi.mock("@/lib/query/use-fleet-query", () => ({
	useFleetQuery: () => ({ data: { configs: fleet.configs }, isError: false }),
}));
vi.mock("@/lib/rpc/client", () => ({
	orpc: {
		connectors: {
			board: {
				queryOptions: () => ({
					queryKey: ["connectors", "board"],
					queryFn: async () => ({ offeredClouds: offered.clouds }),
				}),
			},
		},
	},
}));
vi.mock("@/lib/wizard/location", async () => {
	const harness = await import("@/tests/components/runners/fleet-pool-wizard-harness");
	return { useWizardEnvironment: harness.useTestWizardEnvironment };
});

import { FleetPoolWizard, POOL_PARAM, toWizardFieldErrors } from "@/components/runners/fleet-pool-wizard";
import { defaultLocationsFor, fleetPoolWizard } from "@/components/runners/fleet-pool.wizard";
import { assertWizardComplete } from "@/lib/wizard/define";
import { resetTestPage, testParam } from "@/tests/components/runners/fleet-pool-wizard-harness";

/** A stored pool row, for the edit tests. */
const POOL: FleetPool = {
	id: "5a4b3c2d-1e0f-4a1b-8c2d-3e4f5a6b7c8d",
	provider: "hetzner",
	name: "EU primary",
	warm_min: 2,
	max: 8,
	slots_per_runner: 1,
	locations: ["fsn1", "nbg1"],
	min_per_location: 0,
	surge: 1,
	buffer: 1,
	scale_down_grace_ticks: 5,
	version: null,
	channel: "stable",
	enabled: true,
	deleting: false,
	created_at: new Date("2026-11-01T00:00:00Z"),
	updated_at: new Date("2026-11-01T00:00:00Z"),
};

/** Renders the wizard as the Pools column does. */
function renderWizard(
	props: { open?: boolean; pool?: FleetPool | null; usedProviders?: string[]; onOpenChange?: (open: boolean) => void } = {},
) {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={client}>
			<FleetPoolWizard
				open={props.open ?? true}
				onOpenChange={props.onOpenChange ?? (() => undefined)}
				pool={props.pool ?? null}
				usedProviders={props.usedProviders ?? []}
			/>
		</QueryClientProvider>,
	);
}

/** The primary button, once it can be pressed. */
async function enabledButton(name: string) {
	await waitFor(() => expect(screen.getByRole("button", { name })).toBeEnabled());
	return screen.getByRole("button", { name });
}

/** From a fresh sheet to the Capacity step. */
async function toCapacity() {
	fireEvent.click(await enabledButton("Next"));
	await screen.findByLabelText(/^Locations/);
	fireEvent.click(await enabledButton("Next"));
	await screen.findByRole("spinbutton", { name: /Warm minimum/ });
}

/** From Capacity to Review. */
async function capacityToReview() {
	fireEvent.click(await enabledButton("Next"));
	await screen.findByRole("radiogroup", { name: "Version source" });
	fireEvent.click(await enabledButton("Next"));
	await screen.findByRole("button", { name: "Create pool" });
}

beforeEach(() => {
	resetTestPage();
	createPool.mockReset();
	updatePool.mockReset();
	createPool.mockResolvedValue({ ok: true, data: POOL });
	updatePool.mockResolvedValue({ ok: true, data: POOL });
	offered.clouds = ["aws", "gcp", "azure", "hetzner"];
	fleet.configs = [];
});

describe("the definition", () => {
	it("is complete, and Capacity owns the two advanced knobs", () => {
		expect(() => assertWizardComplete(fleetPoolWizard)).not.toThrow();
		const capacity = fleetPoolWizard.steps.find((step) => step.id === "capacity");
		expect(capacity?.fields).toEqual(expect.arrayContaining(["surge", "scaleDownGraceTicks"]));
	});

	it("starts a pool's location at its cloud's default region", () => {
		expect(defaultLocationsFor("aws")).toBe("eu-west-1");
		expect(defaultLocationsFor("hetzner")).toBe("fsn1");
		expect(defaultLocationsFor(undefined)).toBe("");
	});

	it("names server field errors the way the form does", () => {
		expect(
			toWizardFieldErrors({ "locations.0": ["Bad code"], "input.surge": ["At least 1"], _form: ["No"] }),
		).toEqual({ locationsCsv: ["Bad code"], surge: ["At least 1"], _form: ["No"] });
	});
});

describe("an invalid advanced value is never a silent Create (C-25)", () => {
	it("an emptied surge keeps Next on Capacity, opens Advanced scaling and focuses the field", async () => {
		renderWizard();
		await toCapacity();

		const disclosure = screen.getByRole("button", { name: "Advanced scaling" });
		fireEvent.click(disclosure);
		fireEvent.change(screen.getByRole("spinbutton", { name: /Rollout surge/ }), { target: { value: "" } });
		fireEvent.click(disclosure);
		expect(disclosure).toHaveAttribute("aria-expanded", "false");

		fireEvent.click(screen.getByRole("button", { name: "Next" }));

		await waitFor(() => expect(screen.getByRole("spinbutton", { name: /Rollout surge/ })).toHaveFocus());
		expect(screen.getByRole("button", { name: "Advanced scaling" })).toHaveAttribute("aria-expanded", "true");
		expect(screen.getByText("Required")).toBeInTheDocument();
		expect(testParam("step")).toBe("capacity");
	});

	it("a surge the server refuses after Create returns to Capacity with the block open and the field focused", async () => {
		createPool.mockResolvedValue({
			ok: false,
			error: { kind: "validation", message: "Check the pool.", fields: { surge: ["Surge is too high"] } },
		});
		renderWizard();
		await toCapacity();
		await capacityToReview();

		fireEvent.click(screen.getByRole("button", { name: "Create pool" }));

		await waitFor(() => expect(testParam("step")).toBe("capacity"));
		await waitFor(() => expect(screen.getByRole("spinbutton", { name: /Rollout surge/ })).toHaveFocus());
		expect(screen.getByRole("button", { name: "Advanced scaling" })).toHaveAttribute("aria-expanded", "true");
		expect(screen.getByText("Surge is too high")).toBeInTheDocument();
	});
});

describe("Create", () => {
	it("sends the server input, then closes the sheet in the URL and tells the parent", async () => {
		const onOpenChange = vi.fn();
		renderWizard({ onOpenChange });
		await toCapacity();
		await capacityToReview();

		fireEvent.click(screen.getByRole("button", { name: "Create pool" }));

		await waitFor(() => expect(createPool).toHaveBeenCalledTimes(1));
		expect(createPool.mock.calls[0]?.[0]).toEqual(
			expect.objectContaining({ provider: "aws", locations: ["eu-west-1"], surge: 1, channel: "stable" }),
		);
		await waitFor(() => expect(testParam("wizard")).toBeNull());
		expect(onOpenChange).toHaveBeenCalledWith(false);
	});

	it("says a refusal no field owns above the buttons, and stays on Review", async () => {
		createPool.mockResolvedValue({
			ok: false,
			error: { kind: "conflict", message: "This cloud already has a pool." },
		});
		renderWizard();
		await toCapacity();
		await capacityToReview();

		fireEvent.click(screen.getByRole("button", { name: "Create pool" }));

		expect(await screen.findByText("This cloud already has a pool.")).toBeInTheDocument();
		expect(testParam("step")).toBe("review");
	});
});

describe("the clouds offered come from the server", () => {
	it("starts on the first offered cloud nobody has pooled, at its default region", async () => {
		renderWizard({ usedProviders: ["aws"] });
		fireEvent.click(await enabledButton("Next"));
		expect(await screen.findByLabelText(/^Locations/)).toHaveValue("europe-west1");
	});

	it("offers only what the server lists", async () => {
		offered.clouds = ["hetzner"];
		renderWizard();
		fireEvent.click(await enabledButton("Next"));
		expect(await screen.findByLabelText(/^Locations/)).toHaveValue("fsn1");
	});

	it("disables Next with the reason when every offered cloud already has a pool", async () => {
		offered.clouds = ["aws"];
		renderWizard({ usedProviders: ["aws"] });
		expect(await screen.findByText(/Close this and edit that pool instead/)).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
	});
});

describe("a reload restores the sheet", () => {
	it("comes back open on Capacity with the typed value, and offers to start over", async () => {
		const first = renderWizard();
		await toCapacity();
		fireEvent.change(screen.getByRole("spinbutton", { name: /Warm minimum/ }), { target: { value: "3" } });
		first.unmount();

		const onOpenChange = vi.fn();
		renderWizard({ open: false, onOpenChange });

		expect(await screen.findByRole("spinbutton", { name: /Warm minimum/ })).toHaveValue(3);
		expect(screen.getByText(/Restored your draft/)).toBeInTheDocument();
		expect(onOpenChange).toHaveBeenCalledWith(true);
		expect(testParam("step")).toBe("capacity");
	});
});

describe("editing a pool", () => {
	it("names the pool in the URL and saves through the update action", async () => {
		renderWizard({ pool: POOL });
		await waitFor(() => expect(testParam(POOL_PARAM)).toBe(POOL.id));
		await waitFor(() => expect(screen.getByText("Edit pool")).toBeInTheDocument());

		await toCapacity();
		fireEvent.click(await enabledButton("Next"));
		await screen.findByRole("radiogroup", { name: "Version source" });
		fireEvent.click(await enabledButton("Next"));
		fireEvent.click(await screen.findByRole("button", { name: "Save changes" }));

		await waitFor(() => expect(updatePool).toHaveBeenCalledTimes(1));
		expect(updatePool.mock.calls[0]?.[0]).toEqual(
			expect.objectContaining({
				id: POOL.id,
				input: expect.objectContaining({ provider: "hetzner", locations: ["fsn1", "nbg1"], warmMin: 2 }),
			}),
		);
		await waitFor(() => expect(testParam(POOL_PARAM)).toBeNull());
	});

	it("a reload finds the edited pool from the URL when the parent no longer holds it", async () => {
		fleet.configs = [POOL];
		const first = renderWizard({ pool: POOL });
		await waitFor(() => expect(testParam(POOL_PARAM)).toBe(POOL.id));
		await enabledButton("Next");
		first.unmount();

		renderWizard({ open: false, pool: null });

		// The skeleton and the answered sheet both say "Edit pool"; wait for the answered one (its
		// Next button) and re-query, so a title node replaced between the two is never asserted on.
		const next = await enabledButton("Next");
		expect(screen.getByText("Edit pool")).toBeInTheDocument();
		fireEvent.click(next);
		expect(await screen.findByLabelText(/^Locations/)).toHaveValue("fsn1, nbg1");
	});
});
