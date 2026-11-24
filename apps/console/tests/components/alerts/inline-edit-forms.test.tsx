// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The two inline alert editors are the create sheets' forms (#6821, R6 C-26 / C-27):
//
//   · the policy editor refuses an emptied name INLINE, under the field, and never saves it as a
//     placeholder name — it used to toast and then save "Untitled policy";
//   · the channel editor states its rules inline the same way (an email channel needs a recipient,
//     a URL that is given must parse) and asks before a rail click throws away unsaved edits — it
//     used to drop them silently, because the draft lived in a detail keyed by channel;
//   · a viewer who may not manage alerts sees every mutation control DISABLED with its reason,
//     not missing.
//
// The selection store is the REAL one: what is under test is the selection moving while a draft
// is open, which a stub with a fixed selection cannot express.

import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelDTO, PolicyDTO } from "@/app/server/actions/alerts";
import type { AlertsHub } from "@/components/alerts/alerts-hub";
import type { ChannelsView, PoliciesView } from "@/components/alerts/alerts-filters";
import { MANAGE_DENIED_REASON } from "@/components/errors/manage-gate";
import { useAlertsSection } from "@/lib/stores/use-alerts-section";
import { queryWrapper } from "@/tests/helpers/query-wrapper";

const updatePolicy = vi.fn(async (input: { id: string }) => ({ ok: true as const, data: { id: input.id } }));
const updateChannel = vi.fn(async (input: { id: string }) => ({ ok: true as const, data: { id: input.id } }));
const toastError = vi.hoisted(() => vi.fn());

vi.mock("sonner", () => ({ toast: { error: toastError, success: vi.fn() } }));
vi.mock("@/app/server/actions/alerts", () => ({
	updatePolicy: (input: { id: string }) => updatePolicy(input),
	updateChannel: (input: { id: string }) => updateChannel(input),
	togglePolicy: vi.fn(),
	deletePolicy: vi.fn(),
	createPolicy: vi.fn(),
	addChannel: vi.fn(),
	deleteChannel: vi.fn(),
	setChannelEnabled: vi.fn(),
	verifyChannel: vi.fn(),
}));
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

import { ChannelsPanel } from "@/components/alerts/channels-panel";
import { PoliciesPanel } from "@/components/alerts/policies-panel";

const policy: PolicyDTO = {
	id: "11111111-1111-4111-8111-111111111111",
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
	channels: [{ id: "22222222-2222-4222-8222-222222222222", minSeverity: null }],
	channelIds: ["22222222-2222-4222-8222-222222222222"],
};

/** A channel of `type` named `name`. */
function channel(id: string, name: string, type: ChannelDTO["type"]): ChannelDTO {
	return {
		id,
		type,
		name,
		enabled: true,
		is_verified: true,
		recipients: type === "email" ? ["ops@e2e.test"] : [],
		has_secret: type !== "email",
		last_verified_at: null,
	};
}

const mail = channel("22222222-2222-4222-8222-222222222222", "Ops mail", "email");
const hook = channel("33333333-3333-4333-8333-333333333333", "Ops hook", "webhook");

const hub: AlertsHub = {
	channels: [mail, hook],
	policies: [policy],
	categories: [],
	conditionOptions: { projects: [], jobTypes: [], resourceTypes: [], actions: [] },
	alerting: true,
	advancedAlerting: false,
	canManage: true,
	encryptionConfigured: true,
	policiesKnown: true,
};

const base = { stale: false, busy: false, state: "ready" as const, refreshFailed: false, retry: () => {} };
const policiesView: PoliciesView = {
	...base,
	rows: [policy],
	universeEmpty: false,
	facets: { status: [], kinds: [], channels: [] },
};
const channelsView: ChannelsView = {
	...base,
	rows: [mail, hook],
	universeEmpty: false,
	facets: { types: [], status: [] },
};

beforeEach(() => {
	updatePolicy.mockClear();
	updateChannel.mockClear();
	toastError.mockClear();
	useAlertsSection.setState({ selectedPolicyId: null, selectedChannelId: null });
});

describe("the inline policy editor is the create form", () => {
	it("an emptied name is refused inline, not saved as a placeholder and not toasted", async () => {
		const user = userEvent.setup();
		render(<PoliciesPanel hub={hub} view={policiesView} onOpenChannel={() => {}} />, {
			wrapper: queryWrapper(),
		});
		await user.click(screen.getByRole("button", { name: "Edit policy" }));
		await user.clear(screen.getByLabelText("Policy name"));
		await user.click(screen.getByRole("button", { name: "Save" }));

		expect(await screen.findByText("Name your policy")).toBeInTheDocument();
		expect(screen.getByLabelText("Policy name")).toHaveAttribute("aria-invalid", "true");
		expect(updatePolicy).not.toHaveBeenCalled();
		expect(toastError).not.toHaveBeenCalled();
	});

	it("a valid edit saves onto the policy, with the policy's current enabled state", async () => {
		const user = userEvent.setup();
		render(<PoliciesPanel hub={hub} view={policiesView} onOpenChannel={() => {}} />, {
			wrapper: queryWrapper(),
		});
		await user.click(screen.getByRole("button", { name: "Edit policy" }));
		await user.type(screen.getByLabelText("Policy name"), " v2");
		await user.click(screen.getByRole("button", { name: "Save" }));

		await waitFor(() => expect(updatePolicy).toHaveBeenCalledTimes(1));
		expect(updatePolicy.mock.calls[0][0]).toMatchObject({
			id: policy.id,
			name: "Deploy failures v2",
			enabled: true,
			event_patterns: ["system.job.failed"],
		});
	});
});

describe("the inline channel editor is the add form", () => {
	it("removing every recipient is refused inline under the recipients", async () => {
		const user = userEvent.setup();
		render(<ChannelsPanel hub={hub} view={channelsView} onOpenPolicy={() => {}} />, {
			wrapper: queryWrapper(),
		});
		await user.click(screen.getByRole("button", { name: "Remove recipient ops@e2e.test" }));
		await user.click(await screen.findByRole("button", { name: "Save changes" }));

		expect(await screen.findByText("Add at least one recipient.")).toBeInTheDocument();
		expect(updateChannel).not.toHaveBeenCalled();
		expect(toastError).not.toHaveBeenCalled();
	});

	it("a URL that does not parse is refused inline; a blank one keeps the stored secret", async () => {
		useAlertsSection.setState({ selectedChannelId: hook.id });
		const user = userEvent.setup();
		render(<ChannelsPanel hub={hub} view={channelsView} onOpenPolicy={() => {}} />, {
			wrapper: queryWrapper(),
		});
		const url = await screen.findByLabelText("Payload URL");
		await user.type(url, "not a url");
		await user.click(screen.getByRole("button", { name: "Save changes" }));
		expect(await screen.findByText("Enter a valid URL.")).toBeInTheDocument();
		expect(updateChannel).not.toHaveBeenCalled();

		// Blank again, and only the name changed: the save carries no URL, so the stored one stays.
		await user.clear(url);
		await user.type(screen.getByLabelText("Channel name"), "!");
		await user.click(screen.getByRole("button", { name: "Save changes" }));
		await waitFor(() => expect(updateChannel).toHaveBeenCalledTimes(1));
		expect(updateChannel.mock.calls[0][0]).toMatchObject({
			id: hook.id,
			name: "Ops hook!",
			secret: { url: undefined },
		});
	});

	it("a rail click with unsaved edits asks first; Cancel keeps the edits on their channel", async () => {
		const user = userEvent.setup();
		render(<ChannelsPanel hub={hub} view={channelsView} onOpenPolicy={() => {}} />, {
			wrapper: queryWrapper(),
		});
		const name = screen.getByLabelText("Channel name");
		await user.type(name, " edited");

		await user.click(screen.getByRole("option", { name: /ops hook/i }));
		expect(await screen.findByText("Discard unsaved changes?")).toBeInTheDocument();
		// The detail holds on the edited channel behind the question.
		expect(screen.getByRole("option", { name: /ops mail/i, hidden: true })).toHaveAttribute(
			"aria-selected",
			"true",
		);

		await user.click(screen.getByRole("button", { name: /^cancel$/i }));
		await waitFor(() => expect(screen.queryByText("Discard unsaved changes?")).toBeNull());
		expect(useAlertsSection.getState().selectedChannelId).toBe(mail.id);
		expect(screen.getByLabelText("Channel name")).toHaveValue("Ops mail edited");
	});

	it("a selection moved from outside with unsaved edits asks first; Discard opens the other channel clean", async () => {
		const user = userEvent.setup();
		render(<ChannelsPanel hub={hub} view={channelsView} onOpenPolicy={() => {}} />, {
			wrapper: queryWrapper(),
		});
		await user.type(screen.getByLabelText("Channel name"), " edited");

		act(() => useAlertsSection.getState().setSelectedChannelId(hook.id));
		expect(await screen.findByText("Discard unsaved changes?")).toBeInTheDocument();

		await user.click(screen.getByRole("button", { name: "Discard changes" }));
		await waitFor(() => expect(screen.queryByText("Discard unsaved changes?")).toBeNull());
		expect(screen.getByRole("option", { name: /ops hook/i })).toHaveAttribute("aria-selected", "true");
		expect(screen.getByLabelText("Channel name")).toHaveValue("Ops hook");
		expect(screen.queryByText("Unsaved changes")).toBeNull();
		expect(updateChannel).not.toHaveBeenCalled();
	});

	it("a rail click with nothing unsaved just moves", async () => {
		const user = userEvent.setup();
		render(<ChannelsPanel hub={hub} view={channelsView} onOpenPolicy={() => {}} />, {
			wrapper: queryWrapper(),
		});
		await user.click(screen.getByRole("option", { name: /ops hook/i }));
		expect(screen.queryByText("Discard unsaved changes?")).toBeNull();
		await waitFor(() => expect(screen.getByLabelText("Channel name")).toHaveValue("Ops hook"));
	});
});

describe("a viewer who may not manage alerts", () => {
	const viewer: AlertsHub = { ...hub, canManage: false };

	it("sees the policy controls disabled, each with the reason", () => {
		render(<PoliciesPanel hub={viewer} view={policiesView} onOpenChannel={() => {}} />, {
			wrapper: queryWrapper(),
		});
		const controls = [
			screen.getByRole("button", { name: /new policy/i }),
			screen.getByRole("button", { name: "Edit policy" }),
			screen.getByRole("button", { name: /delete policy/i }),
			screen.getByRole("switch", { name: "Enabled" }),
		];
		const live = controls.filter((c) => !c.hasAttribute("disabled") && c.getAttribute("aria-disabled") !== "true");
		expect(live).toEqual([]);
		for (const control of controls) {
			expect(control).toHaveAccessibleDescription(MANAGE_DENIED_REASON);
		}
	});

	it("sees the channel controls disabled with the reason, and a read-only detail", () => {
		render(<ChannelsPanel hub={viewer} view={channelsView} onOpenPolicy={() => {}} />, {
			wrapper: queryWrapper(),
		});
		const controls = [
			screen.getByRole("button", { name: /add channel/i }),
			screen.getByRole("button", { name: /delete channel/i }),
			screen.getByRole("button", { name: /verify/i }),
			screen.getByRole("switch", { name: "Enabled" }),
		];
		const live = controls.filter((c) => !c.hasAttribute("disabled") && c.getAttribute("aria-disabled") !== "true");
		expect(live).toEqual([]);
		for (const control of controls) {
			expect(control).toHaveAccessibleDescription(MANAGE_DENIED_REASON);
		}
		expect(screen.queryByLabelText("Channel name")).toBeNull();
	});
});
