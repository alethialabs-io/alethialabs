// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The delivery ledger returns the newest 50 (R6 C-28, #6821). When more deliveries match than the
// window holds, the panel says so under the table — the count pill carries the true count — and
// says nothing when the window is the whole answer.

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { DeliveryDTO } from "@/app/server/actions/alerts";
import type { ActivityView } from "@/components/alerts/alerts-filters";
import { queryWrapper } from "@/tests/helpers/query-wrapper";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/rpc/client", async () => {
	const { fakeOrpc } = await import("@/tests/helpers/fake-orpc");
	return { orpc: fakeOrpc({}).orpc };
});
vi.mock("@/lib/query/use-classification-query", () => ({
	useAssignmentsForKind: () => ({ data: {} }),
	useAssignmentsQuery: () => ({ data: [], isLoading: false }),
	useDimensionsQuery: () => ({ data: [], isLoading: false }),
	useCanEditClassification: () => ({ data: false }),
	useAssignmentMutations: () => ({ assign: vi.fn(), unassign: vi.fn() }),
}));

import { ActivityPanel } from "@/components/alerts/activity-panel";

/** `n` sent deliveries. */
function deliveries(n: number): DeliveryDTO[] {
	return Array.from({ length: n }, (_, i): DeliveryDTO => ({
		id: `d${i}`,
		event_key: "system.job.failed",
		title: `Job ${i} failed`,
		status: "sent",
		attempts: 1,
		last_error: null,
		created_at: "2026-11-01T12:00:00.000Z",
		sent_at: null,
	}));
}

/** A ready view showing `shown` rows of `count` matches. */
function view(shown: number, count: number): ActivityView {
	return {
		rows: deliveries(shown),
		count,
		total: count,
		facets: { status: [] },
		stale: false,
		busy: false,
		state: "ready",
		refreshFailed: false,
		retry: () => {},
	};
}

describe("the delivery ledger says when it is showing only the newest", () => {
	it("names the window and the true count when more match than are shown", () => {
		render(<ActivityPanel view={view(50, 240)} />, { wrapper: queryWrapper() });
		expect(
			screen.getByText(/^Showing the newest 50 of 240 deliveries\. Narrow the filters/),
		).toBeInTheDocument();
	});

	it("says nothing when the window is the whole answer", () => {
		const { container } = render(<ActivityPanel view={view(3, 3)} />, { wrapper: queryWrapper() });
		expect(container.querySelector('[data-slot="activity-window"]')).toBeNull();
	});
});
