// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// A filter that matches nothing lands in the SHARED empty state on both alerts rails (#4939).
//
// The audit's F10 found `~/alerts` rendering no `[data-slot="empty"]` for a search token that
// matched nothing, and two hand-rolled "No … match these filters." lines instead. Both halves are
// asserted here: the shared component is what renders (by its slot, the thing F10 reads), and the
// hand-rolled line is gone. The Reset action is asserted by its EFFECT on the filter store, not by
// its presence — a button that renders and resets nothing is exactly R8's inert control.

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
	AlertsBootstrap,
	ChannelDTO,
	PolicyDTO,
} from "@/app/server/actions/alerts";
import type {
	ActivityView,
	ChannelsView,
	PoliciesView,
} from "@/components/alerts/alerts-filters";

vi.mock("@/app/server/actions/alerts", () => ({
	addChannel: vi.fn(async () => {}),
	createPolicy: vi.fn(async () => {}),
	deleteChannel: vi.fn(async () => {}),
	deletePolicy: vi.fn(async () => {}),
	setChannelEnabled: vi.fn(async () => {}),
	togglePolicy: vi.fn(async () => {}),
	updateChannel: vi.fn(async () => {}),
	updatePolicy: vi.fn(async () => {}),
	verifyChannel: vi.fn(async () => {}),
}));
vi.mock("@/lib/stores/use-alerts-section", () => ({
	useAlertsSection: (sel: (s: unknown) => unknown) =>
		sel({
			selectedPolicyId: null,
			setSelectedPolicyId: vi.fn(),
			selectedChannelId: null,
			setSelectedChannelId: vi.fn(),
		}),
}));
vi.mock("@/lib/query/use-classification-query", () => ({
	useAssignmentsForKind: () => ({ data: {} }),
	useAssignmentsQuery: () => ({ data: [], isLoading: false }),
	useDimensionsQuery: () => ({ data: [], isLoading: false }),
	useCanEditClassification: () => ({ data: false }),
	useAssignmentMutations: () => ({ assign: vi.fn(), unassign: vi.fn() }),
}));

import { ActivityPanel } from "@/components/alerts/activity-panel";
import { ChannelsPanel } from "@/components/alerts/channels-panel";
import { PoliciesPanel } from "@/components/alerts/policies-panel";
import {
	useAlertActivityFilters,
	useAlertChannelFilters,
	useAlertPolicyFilters,
} from "@/lib/stores/use-alerts-filters";

const channel: ChannelDTO = {
	id: "c-1",
	type: "email",
	name: "Ops mail",
	enabled: true,
	is_verified: true,
	recipients: ["ops@e2e.test"],
	has_secret: false,
	last_verified_at: null,
};

const policy: PolicyDTO = {
	id: "p-1",
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
};

const bootstrap: AlertsBootstrap = {
	channels: [channel],
	policies: [policy],
	deliveries: [],
	categories: [],
	stats: { policies: 1, enabled: 1, eventsCovered: 0, totalEvents: 0, routed24h: 0 },
	alerting: true,
	advancedAlerting: false,
	canManage: true,
	encryptionConfigured: true,
	conditionOptions: { projects: [], jobTypes: [], resourceTypes: [], actions: [] },
};

/** The universe is non-empty and the filtered rows are not: the zero-RESULT state, not zero-DATA. */
const noChannels: ChannelsView = {
	rows: [],
	count: 0,
	facets: { types: [], status: [] },
	stale: false,
};
const noPolicies: PoliciesView = {
	rows: [],
	count: 0,
	facets: { status: [], kinds: [], channels: [] },
	stale: false,
};

describe("alerts rails: a filter that matches nothing", () => {
	beforeEach(() => {
		useAlertChannelFilters.getState().reset();
		useAlertPolicyFilters.getState().reset();
		useAlertActivityFilters.getState().reset();
	});

	it("the channels rail renders the shared empty state, and Reset clears the filters", async () => {
		useAlertChannelFilters.getState().set("search", "zqxvjk");
		const user = userEvent.setup();
		const { container } = render(
			<ChannelsPanel
				bootstrap={bootstrap}
				view={noChannels}
				onChanged={() => {}}
				onOpenPolicy={() => {}}
			/>,
		);

		expect(container.querySelector('[data-slot="empty"]')).not.toBeNull();
		expect(screen.getByText("No channels match")).toBeInTheDocument();
		expect(screen.queryByText(/no channels match these filters\./i)).toBeNull();

		await user.click(screen.getByRole("button", { name: "Reset filters" }));
		expect(useAlertChannelFilters.getState().filters.search).toBe("");
	});

	it("the policies rail renders the shared empty state, and Reset clears the filters", async () => {
		useAlertPolicyFilters.getState().set("search", "zqxvjk");
		const user = userEvent.setup();
		const { container } = render(
			<PoliciesPanel
				bootstrap={bootstrap}
				view={noPolicies}
				onChanged={() => {}}
				onOpenChannel={() => {}}
			/>,
		);

		expect(container.querySelector('[data-slot="empty"]')).not.toBeNull();
		expect(screen.getByText("No policies match")).toBeInTheDocument();
		expect(screen.queryByText(/no policies match these filters\./i)).toBeNull();

		await user.click(screen.getByRole("button", { name: "Reset filters" }));
		expect(useAlertPolicyFilters.getState().filters.search).toBe("");
	});

	it("the activity ledger renders the shared empty state, and Reset clears the filters", async () => {
		useAlertActivityFilters.getState().set("search", "zqxvjk");
		const user = userEvent.setup();
		const { container } = render(<ActivityPanel view={noActivity} />);

		expect(container.querySelector('[data-slot="empty"]')).not.toBeNull();
		expect(screen.getByText("No activity matches")).toBeInTheDocument();
		// Run 35848311879's F10 FAIL on ~/alerts was this table's empty ROW — the one hand-rolled
		// message left once both rails used the shared state. Read the way F10 reads it.
		expect(handRolledNoResults(container)).toEqual([]);

		await user.click(screen.getByRole("button", { name: "Reset filters" }));
		expect(useAlertActivityFilters.getState().filters.search).toBe("");
	});

	it("an unfiltered empty ledger says 'nothing yet', and offers no Reset", () => {
		const { container } = render(<ActivityPanel view={noActivity} />);
		expect(container.querySelector('[data-slot="empty"]')).not.toBeNull();
		expect(screen.getByText("No activity yet")).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Reset filters" })).toBeNull();
		expect(handRolledNoResults(container)).toEqual([]);
	});
});

/** The empty activity view: no deliveries on this page of the ledger. */
const noActivity: ActivityView = {
	rows: [],
	count: 0,
	facets: { status: [] },
	stale: false,
};

/**
 * Every element OUTSIDE the shared empty state whose own text reads as a "no results" message —
 * the rule `e2e/audit/filters.ts` `readEmptyState()` applies in the browser, minus its visibility
 * test (jsdom has no layout).
 */
function handRolledNoResults(root: HTMLElement): string[] {
	const found: string[] = [];
	for (const el of root.querySelectorAll("*")) {
		if (el.closest('[data-slot="empty"]') !== null) continue;
		const own = [...el.childNodes]
			.filter((n) => n.nodeType === Node.TEXT_NODE)
			.map((n) => n.textContent ?? "")
			.join(" ")
			.trim();
		if (/^no\b.{0,60}\b(results?|match(es)?|found)\b/i.test(own)) found.push(own);
	}
	return found;
}
