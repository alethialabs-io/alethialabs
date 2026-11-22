// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// R6 D-29, the promotions table and the stopped-promotion banner.
//
//   · "View" took a row's id and ignored it: the overlay only ever shows the page's active promotion.
//     Only that promotion's row offers View now.
//   · A promotion somebody CANCELLED said "A reviewer rejected this promotion". Reject and cancel
//     both end as CANCELLED; only a rejection leaves a rejected approval slot, which is what the
//     banner now reads.

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
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

describe("PromotionsHistory — View", () => {
	it("is offered only on the active promotion's row, and opens the overlay", async () => {
		const onView = vi.fn();
		render(
			<PromotionsHistory
				promotions={[row("p-active", "PENDING_APPROVAL"), row("p-old", "SUCCEEDED"), row("p-other", "DEPLOYING")]}
				envName={(id) => (id === "env-dev" ? "dev" : "prod")}
				activeId="p-active"
				onView={onView}
			/>,
		);
		const views = screen.getAllByRole("button", { name: "View" });
		expect(views).toHaveLength(1);
		const view = screen.getByRole("button", { name: "View" });
		const activeRow = view.closest("tr");
		expect(activeRow ? within(activeRow).getAllByText("Pending approval", { exact: false }).length : 0).toBeGreaterThan(0);
		await userEvent.click(view);
		expect(onView).toHaveBeenCalledTimes(1);
	});

	it("offers no View at all while nothing is in flight", () => {
		render(
			<PromotionsHistory
				promotions={[row("p-old", "SUCCEEDED")]}
				envName={() => "dev"}
				activeId={null}
				onView={vi.fn()}
			/>,
		);
		expect(screen.queryByRole("button", { name: "View" })).toBeNull();
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
