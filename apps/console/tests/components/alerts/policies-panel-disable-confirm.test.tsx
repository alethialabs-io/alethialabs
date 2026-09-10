// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Disabling an alert POLICY asks first; enabling stays a bare click.
//
// Both halves matter and the second is the one a naive fix breaks: `channels-panel.tsx` had already
// settled the shape — confirm only on the disabling branch — and putting a dialog in front of
// *enabling* would be a new question nobody asked for, on a non-destructive action.
//
// Why this file exists at all: `apps/console/destructive-actions.yaml` now records
// `alerts.policy.disable` as `status: confirmed`, and `check-destructive-actions.mjs` does NOT
// verify that claim against the surface — it checks that every destructive call site is accounted
// for, not that a control declaring `confirm: confirm-dialog` actually has one. So without these
// assertions the registry could go on asserting `confirmed` after a refactor removed the dialog,
// and nothing would ever catch it. A recorded state that satisfies the checker while being false
// about the tree is worse than the `missing` it replaced.

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AlertsBootstrap, PolicyDTO } from "@/app/server/actions/alerts";

const togglePolicy = vi.fn(async () => {});

vi.mock("@/app/server/actions/alerts", () => ({
	togglePolicy: (...a: unknown[]) => togglePolicy(...(a as [])),
	deletePolicy: vi.fn(async () => {}),
	updatePolicy: vi.fn(async () => {}),
}));
vi.mock("@/lib/stores/use-alerts-section", () => ({
	useAlertsSection: (sel: (s: unknown) => unknown) =>
		sel({ selectedPolicyId: "p-1", setSelectedPolicyId: vi.fn() }),
}));
// The rail rows render classification chips; none of that is under test here, so the whole
// module is stubbed rather than one export at a time.
vi.mock("@/lib/query/use-classification-query", () => ({
	useAssignmentsForKind: () => ({ data: {} }),
	useAssignmentsQuery: () => ({ data: [], isLoading: false }),
	useDimensionsQuery: () => ({ data: [], isLoading: false }),
	useCanEditClassification: () => ({ data: false }),
	useAssignmentMutations: () => ({ assign: vi.fn(), unassign: vi.fn() }),
}));

import { PoliciesPanel } from "@/components/alerts/policies-panel";

function policy(over: Partial<PolicyDTO> & { id: string }): PolicyDTO {
	return {
		name: "Deploy failures",
		description: null,
		event_patterns: [],
		is_security: false,
		severity: "warning",
		match: {},
		throttle_seconds: 0,
		escalate: false,
		recipient: null,
		enabled: true,
		channels: [],
		channelIds: [],
		...over,
	} as PolicyDTO;
}

const p1 = policy({ id: "p-1" });

const bootstrap = {
	channels: [],
	policies: [p1],
	deliveries: [],
	categories: [],
	stats: {},
	alerting: true,
	advancedAlerting: false,
	canManage: true,
} as unknown as AlertsBootstrap;

const view = {
	rows: [p1],
	facets: { status: [], kinds: [], channels: [] },
	activeCount: 0,
} as unknown as Parameters<typeof PoliciesPanel>[0]["view"];

function renderPanel() {
	return render(
		<PoliciesPanel
			bootstrap={bootstrap}
			view={view}
			onChanged={() => {}}
			onOpenChannel={() => {}}
		/>,
	);
}

describe("alerts policy: disabling asks first", () => {
	beforeEach(() => {
		togglePolicy.mockClear();
	});

	it("turning a policy OFF opens a confirmation and does not mutate until confirmed", async () => {
		const user = userEvent.setup();
		renderPanel();

		await user.click(screen.getByRole("switch", { name: /enabled/i }));

		// The ask, before anything is written.
		expect(
			await screen.findByText(/disable this policy\?/i),
		).toBeInTheDocument();
		expect(togglePolicy).not.toHaveBeenCalled();

		await user.click(screen.getByRole("button", { name: /^disable$/i }));
		await waitFor(() => expect(togglePolicy).toHaveBeenCalledWith("p-1", false));
	});

	it("cancelling the confirmation leaves the policy alone", async () => {
		const user = userEvent.setup();
		renderPanel();

		await user.click(screen.getByRole("switch", { name: /enabled/i }));
		expect(
			await screen.findByText(/disable this policy\?/i),
		).toBeInTheDocument();

		await user.click(screen.getByRole("button", { name: /cancel/i }));
		await waitFor(() =>
			expect(screen.queryByText(/disable this policy\?/i)).not.toBeInTheDocument(),
		);
		expect(togglePolicy).not.toHaveBeenCalled();
	});

	// The control. Enabling is not destructive and must stay a bare click — a fix that guarded
	// BOTH directions would pass the first test and put a dialog in front of a harmless action.
	it("turning a policy back ON stays a bare click, with no confirmation", async () => {
		const user = userEvent.setup();
		render(
			<PoliciesPanel
				bootstrap={
					{ ...bootstrap, policies: [policy({ id: "p-1", enabled: false })] } as AlertsBootstrap
				}
				view={
					{
						rows: [policy({ id: "p-1", enabled: false })],
						facets: { status: [], kinds: [], channels: [] },
						activeCount: 0,
					} as unknown as Parameters<
						typeof PoliciesPanel
					>[0]["view"]
				}
				onChanged={() => {}}
				onOpenChannel={() => {}}
			/>,
		);

		await user.click(screen.getByRole("switch", { name: /enabled/i }));

		await waitFor(() => expect(togglePolicy).toHaveBeenCalledWith("p-1", true));
		expect(screen.queryByText(/disable this policy\?/i)).not.toBeInTheDocument();
	});
});
