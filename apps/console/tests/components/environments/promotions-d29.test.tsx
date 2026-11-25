// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// R6 D-29, the promotions table and the stopped-promotion banner.
//
//   · "View" took a row's id and ignored it: the overlay only ever shows the page's active promotion.
//     Only that promotion's row offers View now.
//   · A promotion somebody CANCELLED said "A reviewer rejected this promotion". Reject and cancel
//     both end as CANCELLED; only a rejection leaves a rejected approval slot, which is what the
//     banner now reads.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeHandler } from "@/tests/helpers/fake-orpc";

const h = vi.hoisted(() => ({ handlers: {} as Record<string, FakeHandler>, inputs: [] as unknown[] }));
vi.mock("@/lib/rpc/client", async () => {
	const { fakeOrpc } = await import("@/tests/helpers/fake-orpc");
	return { orpc: fakeOrpc(h.handlers).orpc };
});

import { promotionBanner } from "@/components/environments/active-promotion-panel";
import { PromotionsHistory } from "@/components/environments/promotions-history";
import type { PromotionDetail, PromotionRowView } from "@/lib/rpc/procedures/environments";

/** A promotion row in `status`. */
function row(id: string, status: string): PromotionRowView {
	return {
		id,
		source_environment_id: "env-dev",
		target_environment_id: "env-prod",
		status,
		error_message: null,
		created_at: "2026-11-20T10:00:00.000Z",
	};
}

/** A stopped promotion's detail, with the given approval slots. */
function detail(approvals: PromotionDetail["approvals"]): PromotionDetail {
	return {
		id: "p1",
		status: "CANCELLED",
		sourceName: "dev",
		targetName: "prod",
		gates: [],
		overall: null,
		approvals,
		approved: 0,
		required: 1,
		diff: null,
		initiator: null,
		createdAt: "2026-11-20T10:00:00.000Z",
	};
}

/** Answers `environments.promotions` with one page of `rows` (and `nextCursor`), recording inputs. */
function serve(rows: PromotionRowView[], nextCursor: string | null = null) {
	h.handlers["environments.promotions"] = async (input) => {
		h.inputs.push(input);
		return { rows, nextCursor, facets: null, universeEmpty: rows.length === 0 };
	};
}

/** Renders `ui` under a fresh query client. */
function renderWithClient(ui: ReactNode) {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0 } } });
	return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
	h.inputs.length = 0;
	for (const key of Object.keys(h.handlers)) delete h.handlers[key];
});

describe("PromotionsHistory — View", () => {
	it("is offered only on the active promotion's row, and opens the overlay", async () => {
		const onView = vi.fn();
		serve([row("p-active", "PENDING_APPROVAL"), row("p-old", "SUCCEEDED"), row("p-other", "DEPLOYING")]);
		renderWithClient(
			<PromotionsHistory
				project="payments"
				envName={(id) => (id === "env-dev" ? "dev" : "prod")}
				activeId="p-active"
				onView={onView}
			/>,
		);
		const views = await screen.findAllByRole("button", { name: "View" });
		expect(views).toHaveLength(1);
		const view = screen.getByRole("button", { name: "View" });
		const activeRow = view.closest("tr");
		expect(activeRow ? within(activeRow).getAllByText("Pending approval", { exact: false }).length : 0).toBeGreaterThan(0);
		await userEvent.click(view);
		expect(onView).toHaveBeenCalledTimes(1);
	});

	it("offers no View at all while nothing is in flight", async () => {
		serve([row("p-old", "SUCCEEDED")]);
		renderWithClient(<PromotionsHistory project="payments" envName={() => "dev"} activeId={null} onView={vi.fn()} />);
		await screen.findByRole("table");
		expect(screen.queryByRole("button", { name: "View" })).toBeNull();
	});
});

describe("PromotionsHistory — the list standard (LST-3 #7485)", () => {
	it("is its own read, for the project, and its heading carries no count", async () => {
		serve([row("p1", "SUCCEEDED"), row("p2", "CANCELLED")]);
		renderWithClient(<PromotionsHistory project="payments" envName={() => "dev"} activeId={null} onView={vi.fn()} />);
		const heading = await screen.findByRole("heading", { name: "Promotions" });
		expect(heading.closest("section")?.textContent).not.toMatch(/Promotions\s*2/);
		expect(h.inputs[0]).toEqual({ project: "payments" });
	});

	it("a project that has never promoted renders no section at all", async () => {
		serve([]);
		const { container } = renderWithClient(
			<PromotionsHistory project="payments" envName={() => "dev"} activeId={null} onView={vi.fn()} />,
		);
		await waitFor(() => expect(h.inputs).toHaveLength(1));
		await waitFor(() => expect(container.querySelector("section")).toBeNull());
		expect(screen.queryByRole("heading", { name: "Promotions" })).toBeNull();
	});

	it("pages by keyset: Load more asks for the next cursor and appends, then the footer goes", async () => {
		serve([row("p1", "SUCCEEDED")], "cur-1");
		renderWithClient(<PromotionsHistory project="payments" envName={() => "dev"} activeId={null} onView={vi.fn()} />);
		await screen.findByRole("table");
		serve([row("p2", "CANCELLED")]);
		await userEvent.click(screen.getByRole("button", { name: "Load more" }));
		await waitFor(() => expect(screen.getAllByRole("row")).toHaveLength(3)); // header + 2
		expect(h.inputs.at(-1)).toEqual({ project: "payments", cursor: "cur-1" });
		expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
	});

	it("a failed first page is an error with a retry — never an absent section", async () => {
		h.handlers["environments.promotions"] = async () => {
			throw new Error("network");
		};
		renderWithClient(<PromotionsHistory project="payments" envName={() => "dev"} activeId={null} onView={vi.fn()} />);
		expect(await screen.findByText("Couldn't load promotions")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /try again/i })).toBeInTheDocument();
	});
});

describe("promotionBanner — a stopped promotion", () => {
	it("a rejected promotion names who rejected it", () => {
		const banner = promotionBanner(
			detail([
				{
					id: "s1",
					status: "rejected",
					name: "Grace Hopper",
					initials: "GH",
					requiredRole: null,
					comment: null,
					decidedAt: "2026-11-20T11:00:00.000Z",
				},
			]),
		);
		expect(banner).toEqual({
			title: "Promotion rejected",
			body: "Grace Hopper rejected this promotion. Nothing was deployed.",
		});
	});

	it("a cancelled promotion does not claim a reviewer rejected it", () => {
		const banner = promotionBanner(
			detail([
				{
					id: "s1",
					status: "pending",
					name: null,
					initials: null,
					requiredRole: null,
					comment: null,
					decidedAt: null,
				},
			]),
		);
		expect(banner?.title).toBe("Promotion cancelled");
		expect(banner?.body).not.toMatch(/reject/i);
	});
});
