// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6334 — `ClassificationControl` paints whole from what the route prefetched, and a read it depends
// on that FAILS renders the region's error (`RegionError`, with a retry) instead of nothing. Before,
// the "Classify" picker appeared only after a client read of `classification.canEdit` answered, and
// when that read failed the picker simply never appeared: a failure that read as "you may not
// classify this". An EXPECTED refusal of the chips is not a failure and keeps the chip-less render.

import { ORPCError } from "@orpc/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
vi.mock("@/app/server/actions/classification/assignments", () => ({
	assignClassification: vi.fn(),
	unassignClassification: vi.fn(),
}));
vi.mock("next/navigation", () => ({
	useParams: () => ({ org: "acme" }),
	useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

import { ClassificationControl } from "@/components/classification/classification-control";
import type { AssignedValue } from "@/lib/queries/classification";
import { orpc } from "@/lib/rpc/client";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const CAN_EDIT = orpc.classification.canEdit.queryKey({ input: undefined });
const DIMENSIONS = orpc.classification.dimensions.queryKey({ input: {} });
const CHIPS = orpc.classification.assignments.queryKey({ input: { kind: "project", resourceId: PROJECT } });

/** One pinned chip: Team · Payments. */
const CHIP: AssignedValue = {
	assignment_id: "a1",
	dimension_id: "d1",
	dimension_key: "team",
	dimension_label: "Team",
	multi: false,
	value_id: "v1",
	value: "payments",
	value_label: "Payments",
	color: null,
	enforcement: null,
};

/** Renders the control over a cache `seed` prepared — the state the route's prefetch handed over. */
function renderControl(seed: (qc: QueryClient) => void, canEdit = true) {
	const qc = new QueryClient({
		defaultOptions: { queries: { retry: false, staleTime: Infinity, retryOnMount: false } },
	});
	seed(qc);
	render(
		<QueryClientProvider client={qc}>
			<ClassificationControl kind="project" id={PROJECT} canEdit={canEdit} />
		</QueryClientProvider>,
	);
	return qc;
}

beforeEach(() => {
	h.calls.length = 0;
	for (const k of Object.keys(h.handlers)) delete h.handlers[k];
});

describe("ClassificationControl — first paint from the prefetch (B1)", () => {
	it("paints the picker and the chips from the hydrated cache, with no read of its own", () => {
		renderControl((qc) => {
			qc.setQueryData(CAN_EDIT, true);
			qc.setQueryData(DIMENSIONS, []);
			qc.setQueryData(CHIPS, [CHIP]);
		});
		// Synchronously — the first render, not after a read answered.
		expect(screen.getByRole("button", { name: "Classify" })).toBeInTheDocument();
		expect(screen.getByText("Payments")).toBeInTheDocument();
		expect(h.calls).toEqual([]);
	});
});

describe("ClassificationControl — a failed read is an error, not an absence (B4)", () => {
	it("a failed edit decision renders the region error with a retry — never a silently missing picker", async () => {
		h.handlers["classification.canEdit"] = async () => {
			throw new Error("boom");
		};
		h.handlers["classification.dimensions"] = async () => [];
		renderControl((qc) => qc.setQueryData(CHIPS, []));

		const alert = await screen.findByRole("alert");
		expect(alert).toHaveTextContent("Couldn't load classification");
		expect(screen.queryByRole("button", { name: "Classify" })).toBeNull();

		// The retry re-reads the decision, and the picker arrives once it answers.
		h.handlers["classification.canEdit"] = async () => true;
		await userEvent.click(screen.getByRole("button", { name: "Try again" }));
		expect(await screen.findByRole("button", { name: "Classify" })).toBeInTheDocument();
		expect(screen.queryByRole("alert")).toBeNull();
	});

	it("a failed edit decision is not an error where the caller could not edit anyway", async () => {
		h.handlers["classification.canEdit"] = async () => {
			throw new Error("boom");
		};
		const qc = renderControl((c) => c.setQueryData(CHIPS, [CHIP]), false);
		await waitFor(() => expect(qc.getQueryState(CAN_EDIT)?.status).toBe("error"));
		expect(screen.getByText("Payments")).toBeInTheDocument();
		expect(screen.queryByRole("alert")).toBeNull();
	});

	it("failed chips render the region error rather than reading as 'nothing classified'", async () => {
		h.handlers["classification.assignments"] = async () => {
			throw new Error("boom");
		};
		renderControl((qc) => qc.setQueryData(CAN_EDIT, false));
		expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't load classification");
	});

	it("an expected refusal of the chips is not a failure — no error surface", async () => {
		h.handlers["classification.assignments"] = async () => {
			throw new ORPCError("FORBIDDEN", { defined: true });
		};
		const qc = renderControl((c) => c.setQueryData(CAN_EDIT, false));
		// The refusal has settled into the query — so the render below is the refused one.
		await waitFor(() => expect(qc.getQueryState(CHIPS)?.status).toBe("error"));
		expect(screen.queryByRole("alert")).toBeNull();
	});
});
