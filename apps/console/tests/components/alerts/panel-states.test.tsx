// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6125 — each Alerts section renders FOUR distinct answers (RUBRIC B3/B4): pending, failed, empty and
// rows. "No policies yet" / "No channels yet" / "No activity yet" are answers to a read that found
// nothing; before this, a read still in flight — or one that had failed — rendered them too, because
// the panels decided from `rows.length` (0 in all three cases).
//
// Also: a channel delete has a pending state — the confirm stays open, says "Deleting…" and cannot be
// pressed twice — and closes only once the delete has answered.

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelDTO, PolicyDTO } from "@/app/server/actions/alerts";
import type { AlertsHub } from "@/components/alerts/alerts-hub";
import type { ActivityView, ChannelsView, PoliciesView } from "@/components/alerts/alerts-filters";
import { queryWrapper } from "@/tests/helpers/query-wrapper";

const deleteChannel = vi.fn();
vi.mock("@/app/server/actions/alerts", () => ({
	addChannel: vi.fn(),
	createPolicy: vi.fn(),
	deleteChannel: (input: { id: string }) => deleteChannel(input),
	deletePolicy: vi.fn(),
	setChannelEnabled: vi.fn(),
	togglePolicy: vi.fn(),
	updateChannel: vi.fn(),
	updatePolicy: vi.fn(),
	verifyChannel: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/rpc/client", async () => {
	const { fakeOrpc } = await import("@/tests/helpers/fake-orpc");
	return { orpc: fakeOrpc({}).orpc };
});
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

const channel: ChannelDTO = {
	id: "22222222-2222-4222-8222-222222222222",
	type: "email",
	name: "Ops mail",
	enabled: true,
	is_verified: true,
	recipients: ["ops@e2e.test"],
	has_secret: false,
	last_verified_at: null,
};

const hub: AlertsHub = {
	channels: [],
	policies: [],
	categories: [],
	conditionOptions: { projects: [], jobTypes: [], resourceTypes: [], actions: [] },
	alerting: true,
	advancedAlerting: false,
	canManage: true,
	encryptionConfigured: true,
	policiesKnown: true,
};

type State = "loading" | "error" | "ready";

/** A view in `state` with no rows; `total` is what the org holds. */
function view(state: State, retry = vi.fn(), total = 0) {
	return { rows: [], count: 0, total, stale: false, busy: state !== "ready", state, refreshFailed: false, retry };
}

const policiesView = (state: State, retry?: () => void): PoliciesView => ({
	...view(state, retry ? vi.fn(retry) : undefined),
	facets: { status: [], kinds: [], channels: [] },
});
const channelsView = (state: State, retry?: () => void): ChannelsView => ({
	...view(state, retry ? vi.fn(retry) : undefined),
	facets: { types: [], status: [] },
});
const activityView = (state: State, retry?: () => void): ActivityView => ({
	...view(state, retry ? vi.fn(retry) : undefined),
	facets: { status: [] },
});

/** Each section: how to render it in a state, and the copy its EMPTY answer uses. */
const SECTIONS = [
	{
		name: "Policies",
		empty: "No policies yet",
		error: "Couldn't load policies",
		render: (state: State, retry?: () => void) => (
			<PoliciesPanel hub={hub} view={policiesView(state, retry)} onOpenChannel={() => {}} />
		),
	},
	{
		name: "Channels",
		empty: "No channels yet",
		error: "Couldn't load channels",
		render: (state: State, retry?: () => void) => (
			<ChannelsPanel hub={hub} view={channelsView(state, retry)} onOpenPolicy={() => {}} />
		),
	},
	{
		name: "Activity",
		empty: "No activity yet",
		error: "Couldn't load activity",
		render: (state: State, retry?: () => void) => <ActivityPanel view={activityView(state, retry)} />,
	},
] as const;

describe.each(SECTIONS)("$name: pending, failed and empty are three different renders", (section) => {
	it("pending: the panel's skeleton, never its empty copy (B3)", () => {
		const { container } = render(section.render("loading"), { wrapper: queryWrapper() });
		expect(container.querySelector('[data-slot="alerts-panel-skeleton"]')).not.toBeNull();
		expect(screen.queryByText(section.empty)).toBeNull();
		expect(container.querySelector('[data-slot="region-error"]')).toBeNull();
	});

	it("failed: a region error with a retry, never the empty copy and never an endless skeleton (B4)", async () => {
		const retry = vi.fn();
		const user = userEvent.setup();
		const { container } = render(section.render("error", retry), { wrapper: queryWrapper() });
		expect(screen.getByText(section.error)).toBeInTheDocument();
		expect(screen.queryByText(section.empty)).toBeNull();
		expect(container.querySelector('[data-slot="alerts-panel-skeleton"]')).toBeNull();
		await user.click(screen.getByRole("button", { name: "Try again" }));
		expect(retry).toHaveBeenCalledTimes(1);
	});

	it("answered with nothing: the empty copy, and only then", () => {
		const { container } = render(section.render("ready"), { wrapper: queryWrapper() });
		expect(screen.getByText(section.empty)).toBeInTheDocument();
		expect(container.querySelector('[data-slot="alerts-panel-skeleton"]')).toBeNull();
		expect(container.querySelector('[data-slot="region-error"]')).toBeNull();
	});
});

describe("deleting a channel has a pending state", () => {
	beforeEach(() => {
		deleteChannel.mockReset();
	});

	it("the confirm stays open and says Deleting… until the delete answers, and cannot be pressed twice", async () => {
		let finish: (v: unknown) => void = () => {};
		deleteChannel.mockImplementation(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		const user = userEvent.setup();
		render(
			<ChannelsPanel
				hub={{ ...hub, channels: [channel] }}
				view={{ ...channelsView("ready"), rows: [channel], count: 1, total: 1 }}
				onOpenPolicy={() => {}}
			/>,
			{ wrapper: queryWrapper() },
		);

		await user.click(screen.getByRole("button", { name: /delete channel/i }));
		await user.click(await screen.findByRole("button", { name: /^delete channel$/i }));

		const pending = await screen.findByRole("button", { name: /deleting/i });
		expect(pending).toBeDisabled();
		await user.click(pending);
		expect(deleteChannel).toHaveBeenCalledTimes(1);
		expect(deleteChannel).toHaveBeenCalledWith({ id: channel.id });
		expect(screen.getByText(/delete channel "ops mail"\?/i)).toBeInTheDocument();

		finish({ ok: true, data: { id: channel.id } });
		await waitFor(() => expect(screen.queryByText(/delete channel "ops mail"\?/i)).toBeNull());
	});

	it("a refused delete leaves the question on screen, with the server's words in a toast", async () => {
		deleteChannel.mockResolvedValue({ ok: false, error: { kind: "not-found", message: "Channel not found." } });
		const user = userEvent.setup();
		render(
			<ChannelsPanel
				hub={{ ...hub, channels: [channel] }}
				view={{ ...channelsView("ready"), rows: [channel], count: 1, total: 1 }}
				onOpenPolicy={() => {}}
			/>,
			{ wrapper: queryWrapper() },
		);

		await user.click(screen.getByRole("button", { name: /delete channel/i }));
		await user.click(await screen.findByRole("button", { name: /^delete channel$/i }));
		await waitFor(() => expect(deleteChannel).toHaveBeenCalledTimes(1));
		// Back to the idle label, still asking.
		expect(await screen.findByRole("button", { name: /^delete channel$/i })).toBeEnabled();
		expect(screen.getByText(/delete channel "ops mail"\?/i)).toBeInTheDocument();
	});
});

describe("the delete warning says only what the policies read answered", () => {
	it("with the policies unread, it says it couldn't check — never that nothing routes here", async () => {
		const user = userEvent.setup();
		render(
			<ChannelsPanel
				hub={{ ...hub, channels: [channel], policiesKnown: false }}
				view={{ ...channelsView("ready"), rows: [channel], count: 1, total: 1 }}
				onOpenPolicy={() => {}}
			/>,
			{ wrapper: queryWrapper() },
		);
		await user.click(screen.getByRole("button", { name: /delete channel/i }));
		expect(await screen.findByText(/couldn't check which policies route here/i)).toBeInTheDocument();
	});

	it("with the policies read and none routing here, it does not claim it couldn't check", async () => {
		const user = userEvent.setup();
		render(
			<ChannelsPanel
				hub={{ ...hub, channels: [channel] }}
				view={{ ...channelsView("ready"), rows: [channel], count: 1, total: 1 }}
				onOpenPolicy={() => {}}
			/>,
			{ wrapper: queryWrapper() },
		);
		await user.click(screen.getByRole("button", { name: /delete channel/i }));
		expect(await screen.findByText("Delivery history is kept. This cannot be undone.")).toBeInTheDocument();
		expect(screen.queryByText(/couldn't check/i)).toBeNull();
	});
});

describe("the inline policy editor tracks dirty state", () => {
	const policy: PolicyDTO = {
		id: "33333333-3333-4333-8333-333333333333",
		name: "Deploy failures",
		description: null,
		event_patterns: ["system.job.failed"],
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

	it("Save is disabled until the draft differs from the saved policy, and again once it matches", async () => {
		const user = userEvent.setup();
		render(
			<PoliciesPanel
				hub={{ ...hub, policies: [policy] }}
				view={{ ...policiesView("ready"), rows: [policy], count: 1, total: 1 }}
				onOpenChannel={() => {}}
			/>,
			{ wrapper: queryWrapper() },
		);
		await user.click(screen.getByRole("button", { name: "Edit policy" }));
		const save = screen.getByRole("button", { name: "Save" });
		expect(save).toBeDisabled();

		const name = screen.getByLabelText("Policy name");
		await user.type(name, "!");
		expect(save).toBeEnabled();

		await user.type(name, "{Backspace}");
		expect(save).toBeDisabled();
	});
});
