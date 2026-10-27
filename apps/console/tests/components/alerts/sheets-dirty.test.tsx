// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6125 — the create sheets track whether they are DIRTY.
//
//   · A pick in the policy sheet's event matrix counts as an edit, not only typing: the matrix writes
//     through `setValue`, which react-hook-form does not mark dirty unless told to, so a sheet with
//     three events chosen used to read pristine.
//   · Create stays pressable on a pristine sheet, and pressing it names what is missing inline.
//   · Closing a dirty sheet asks before discarding it; closing a pristine one just closes.
//   · Server validation lands on the field it names, and the sheet stays open.
//   · A destination that does not verify is said inline beside the form, and nothing closes.
//   · "Add channel" that cannot be pressed names its reason on the control (F056).

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AlertsHub } from "@/components/alerts/alerts-hub";
import { CATEGORIES } from "@/lib/alerts/catalog";
import { queryWrapper } from "@/tests/helpers/query-wrapper";

const createPolicy = vi.fn();
const addChannel = vi.fn();
vi.mock("@/app/server/actions/alerts", () => ({
	createPolicy: (input: unknown) => createPolicy(input),
	addChannel: (input: unknown) => addChannel(input),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
// The routing picker is a popover the tests do not need to drive: a stand-in that binds one channel.
vi.mock("@/components/alerts/channel-routing", () => ({
	ChannelRouting: ({ onChange }: { onChange: (next: { id: string }[]) => void }) => (
		<button type="button" onClick={() => onChange([{ id: "22222222-2222-4222-8222-222222222222" }])}>
			bind a channel
		</button>
	),
}));
vi.mock("@/lib/rpc/client", async () => {
	const { fakeOrpc } = await import("@/tests/helpers/fake-orpc");
	return { orpc: fakeOrpc({}).orpc };
});

import { ChannelSheet } from "@/components/alerts/channel-sheet";
import { PolicySheet } from "@/components/alerts/policy-sheet";

const hub: AlertsHub = {
	channels: [],
	policies: [],
	categories: CATEGORIES,
	conditionOptions: { projects: [], jobTypes: [], resourceTypes: [], actions: [] },
	alerting: true,
	advancedAlerting: false,
	canManage: true,
	encryptionConfigured: true,
	policiesKnown: true,
};

/** The first live, non-security event in the real catalog, as the matrix labels it. */
const EVENT = CATEGORIES[0].events[0];

/** Opens the event's category in the matrix and switches the event on. */
async function pickEvent(user: ReturnType<typeof userEvent.setup>) {
	await user.click(screen.getByRole("button", { name: new RegExp(CATEGORIES[0].label) }));
	await user.click(await screen.findByRole("switch", { name: `${EVENT.label} (${EVENT.key})` }));
}

function renderPolicySheet() {
	const onOpenChange = vi.fn();
	render(<PolicySheet open onOpenChange={onOpenChange} hub={hub} onGoChannels={() => {}} />, {
		wrapper: queryWrapper(),
	});
	return { onOpenChange };
}

describe("the policy sheet tracks dirty state", () => {
	beforeEach(() => createPolicy.mockReset());

	it("submitting a pristine sheet names what is missing, inline, and sends nothing", async () => {
		const user = userEvent.setup();
		renderPolicySheet();
		await user.click(screen.getByRole("button", { name: "Create policy" }));
		expect(await screen.findByText("Name your policy")).toBeInTheDocument();
		expect(screen.getByText("Pick at least one event.")).toBeInTheDocument();
		expect(createPolicy).not.toHaveBeenCalled();
	});

	it("choosing an event alone makes it dirty — a matrix pick is an edit, so closing asks first", async () => {
		const user = userEvent.setup();
		const { onOpenChange } = renderPolicySheet();
		await pickEvent(user);
		await user.click(screen.getByRole("button", { name: "Cancel" }));
		expect(await screen.findByText("Discard this policy?")).toBeInTheDocument();
		expect(onOpenChange).not.toHaveBeenCalled();
	});

	it("closing a pristine sheet just closes it", async () => {
		const user = userEvent.setup();
		const { onOpenChange } = renderPolicySheet();
		await user.click(screen.getByRole("button", { name: "Cancel" }));
		expect(onOpenChange).toHaveBeenCalledWith(false);
		expect(screen.queryByText("Discard this policy?")).toBeNull();
	});

	it("closing a dirty sheet asks first; keeping it keeps the sheet; discarding closes it", async () => {
		const user = userEvent.setup();
		const { onOpenChange } = renderPolicySheet();
		await user.type(screen.getByLabelText("Name"), "Prod failures");
		await user.click(screen.getByRole("button", { name: "Cancel" }));

		expect(await screen.findByText("Discard this policy?")).toBeInTheDocument();
		expect(onOpenChange).not.toHaveBeenCalled();

		await user.click(screen.getByRole("button", { name: "Discard" }));
		expect(onOpenChange).toHaveBeenCalledWith(false);
	});

	it("a dirty sheet that misses a required binding says so inline and stays open", async () => {
		const user = userEvent.setup();
		const { onOpenChange } = renderPolicySheet();
		await user.type(screen.getByLabelText("Name"), "Prod failures");
		await pickEvent(user);
		await user.click(screen.getByRole("button", { name: "Create policy" }));
		expect(await screen.findByText("Bind at least one channel.")).toBeInTheDocument();
		expect(createPolicy).not.toHaveBeenCalled();
		expect(onOpenChange).not.toHaveBeenCalled();
	});
});

describe("the policy sheet never loses a server validation message", () => {
	it("a message naming no field on the sheet is shown under the form, and the sheet stays open", async () => {
		createPolicy.mockResolvedValue({
			ok: false,
			error: { kind: "validation", message: "Invalid", fields: { recipient: ["Recipient is too long."] } },
		});
		const user = userEvent.setup();
		const { onOpenChange } = renderPolicySheet();
		await user.type(screen.getByLabelText("Name"), "Prod failures");
		await pickEvent(user);
		await user.click(screen.getByRole("button", { name: "bind a channel" }));
		await user.click(screen.getByRole("button", { name: "Create policy" }));
		expect(await screen.findByText("Recipient is too long.")).toBeInTheDocument();
		expect(createPolicy).toHaveBeenCalledTimes(1);
		expect(onOpenChange).not.toHaveBeenCalled();
	});
});

describe("the channel sheet", () => {
	it("closing it with something typed asks before discarding", async () => {
		const user = userEvent.setup();
		const onOpenChange = vi.fn();
		render(<ChannelSheet open onOpenChange={onOpenChange} encryptionConfigured />, { wrapper: queryWrapper() });
		await user.type(screen.getByLabelText(/webhook url/i), "https://hooks.example.test/x");
		await user.click(screen.getByRole("button", { name: "Cancel" }));
		expect(await screen.findByText("Discard this channel?")).toBeInTheDocument();
		expect(onOpenChange).not.toHaveBeenCalled();
	});

	it("server validation lands on the field it names, and the sheet stays open", async () => {
		addChannel.mockResolvedValue({
			ok: false,
			error: { kind: "validation", message: "Invalid URL", fields: { "secret.url": ["Use an https:// URL."] } },
		});
		const user = userEvent.setup();
		const onOpenChange = vi.fn();
		render(<ChannelSheet open onOpenChange={onOpenChange} encryptionConfigured />, { wrapper: queryWrapper() });
		await user.type(screen.getByLabelText(/webhook url/i), "https://hooks.example.test/x");
		await user.click(screen.getByRole("button", { name: "Add channel" }));
		expect(await screen.findByText("Use an https:// URL.")).toBeInTheDocument();
		expect(onOpenChange).not.toHaveBeenCalled();
	});

	it("a destination that does not verify is said inline, and nothing closes", async () => {
		addChannel.mockResolvedValue({ ok: true, data: { added: false, error: "The endpoint timed out." } });
		const user = userEvent.setup();
		const onOpenChange = vi.fn();
		render(<ChannelSheet open onOpenChange={onOpenChange} encryptionConfigured />, { wrapper: queryWrapper() });
		await user.type(screen.getByLabelText(/webhook url/i), "https://hooks.example.test/x");
		await user.click(screen.getByRole("button", { name: "Add channel" }));
		expect(await screen.findByText("The endpoint timed out.")).toBeInTheDocument();
		expect(onOpenChange).not.toHaveBeenCalled();
	});

	it("a disabled Add channel names why, on the control itself (F056)", () => {
		render(<ChannelSheet open onOpenChange={() => {}} encryptionConfigured={false} />, { wrapper: queryWrapper() });
		const add = screen.getByRole("button", { name: "Add channel" });
		expect(add).toBeDisabled();
		expect(add).toHaveAccessibleDescription(/encryption key/i);
	});
});
