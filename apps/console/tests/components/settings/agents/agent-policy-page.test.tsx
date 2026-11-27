// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The agent policy page's states (AGT-L2 SPEC §3): can manage (editable), agent access off (the
// banner, Turn back on, the no-production switch disabled), no `org:manage_agents` (read-only with
// the inline alert), Community/Pro (Enterprise rows locked), loading, error and a refused read —
// plus the interactions (each control saves on change, optimistic, rolled back on a refusal; turning
// access off asks first, turning it on does not) and the accessibility notes (switches named by
// their title and described by their consequence line; the TTL presets a labelled group with
// `aria-pressed`).

import { ORPCError } from "@orpc/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentPolicySettings } from "@/lib/agents/policy";
import type { AgentPolicyRead } from "@/lib/rpc/procedures/agents";

const h = vi.hoisted(() => {
	const state: { policy: () => Promise<unknown>; entitled: boolean | null } = {
		policy: async () => ({}),
		entitled: false,
	};
	return state;
});
const updateAgentPolicy = vi.hoisted(() => vi.fn());

vi.mock("@/lib/rpc/client", async () => {
	const { fakeOrpc } = await import("@/tests/helpers/fake-orpc");
	return { orpc: fakeOrpc({ "agents.policy": () => h.policy() }).orpc };
});
vi.mock("@/app/server/actions/agents/policy", () => ({ updateAgentPolicy }));
vi.mock("@/components/settings/enterprise-gate", () => ({ useEntitlement: () => h.entitled }));
vi.mock("@/lib/stores/use-workspace-store", () => {
	const state = { activeOrgId: "org-1", organizations: [{ id: "org-1", name: "acme", slug: "acme" }] };
	return { useWorkspaceStore: (select: (s: typeof state) => unknown) => select(state) };
});
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }));

import { AgentPolicyPage, withPolicyPatch } from "@/components/settings/agents/agent-policy-page";

/** The settings, at every default unless `extra` says otherwise. */
function settings(extra: Partial<AgentPolicySettings> = {}): AgentPolicySettings {
	return {
		agentAccessEnabled: true,
		agentsMayNotApplyToProduction: false,
		approvalTtlMinutes: 60,
		requireDifferentApprover: false,
		allowedOauthClientIds: null,
		updatedBy: { id: "u-1", name: "Maria Petrova" },
		updatedAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
		...extra,
	};
}

/** The read's answer. */
function policyRead(extra: Partial<AgentPolicySettings> = {}, canManage = true): AgentPolicyRead {
	return { settings: settings(extra), canManage, ttlPresets: [15, 30, 60, 240, 1440] };
}

/** Renders the page under a fresh client. */
function renderPage() {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
	return render(<AgentPolicyPage />, { wrapper });
}

/** The switch named `name`. */
function switchNamed(name: string): HTMLElement {
	return screen.getByRole("switch", { name });
}

beforeEach(() => {
	vi.clearAllMocks();
	h.entitled = false;
	h.policy = async () => policyRead();
});

describe("AgentPolicyPage — the read's states", () => {
	it("loading: the page-shaped skeleton", () => {
		h.policy = () => new Promise(() => {});
		const { container } = renderPage();
		expect(container.querySelector('[data-skeleton="agent-policy"]')).not.toBeNull();
		// No toolbar row on the page, so none in its skeleton either (#7876).
		expect(container.querySelector('[data-slot="page-toolbar-skeleton"]')).toBeNull();
	});

	it("error: a region error saying the current settings still apply", async () => {
		h.policy = async () => {
			throw new Error("boom");
		};
		renderPage();
		expect(await screen.findByText("Couldn't load agent settings", undefined, { timeout: 4000 })).toBeTruthy();
		expect(screen.getByText("Your current settings still apply. Try again in a moment.")).toBeTruthy();
	});

	it("refused: a calm state, not an error", async () => {
		h.policy = async () => {
			throw new ORPCError("FORBIDDEN", { defined: true });
		};
		renderPage();
		expect(await screen.findByText("Agent settings aren't available")).toBeTruthy();
		expect(screen.queryByText("Couldn't load agent settings")).toBeNull();
	});
});

describe("AgentPolicyPage — can manage agents", () => {
	it("shows every control editable, with the spec's copy, no page heading and no description line", async () => {
		renderPage();
		const access = await screen.findByRole("switch", { name: "Let agents work in acme" });
		expect(access.getAttribute("aria-checked")).toBe("true");
		expect(access.hasAttribute("aria-disabled") && access.getAttribute("aria-disabled") === "true").toBe(false);
		expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
		// The maintainer dropped the PageToolbar description (#7876), and with it the toolbar row.
		expect(screen.queryByText(/^Decide what agents may do/)).toBeNull();
		expect(document.querySelector('[data-slot="page-toolbar"]')).toBeNull();
		expect(screen.queryByText("You can't change agent settings")).toBeNull();
		expect(screen.queryByText("Agent access is off.")).toBeNull();
		expect(screen.getByText(/^Last changed by Maria Petrova · .+\. Every change is recorded in Activity\.$/)).toBeTruthy();
	});

	it("ties each switch to its consequence line, which rewrites for the current value", async () => {
		renderPage();
		const access = await screen.findByRole("switch", { name: "Let agents work in acme" });
		const describedBy = access.getAttribute("aria-describedby") ?? "";
		const line = describedBy.split(" ").map((id) => document.getElementById(id)?.textContent ?? "").join(" ");
		expect(line).toContain("On. Agents can read and plan. Every deploy and destroy still waits for a person's approval.");
		const noProd = switchNamed("Keep agents off production");
		expect(noProd.getAttribute("aria-checked")).toBe("false");
		expect(screen.getByText("Agents may ask to deploy or destroy production. A person approves each request.")).toBeTruthy();
	});

	it("the TTL presets are a labelled group with aria-pressed on the current one", async () => {
		renderPage();
		const group = await screen.findByRole("group", { name: "Request lifetime" });
		const buttons = within(group).getAllByRole("button");
		expect(buttons.map((b) => b.textContent)).toEqual(["15 min", "30 min", "1 hour · default", "4 hours", "24 hours"]);
		expect(within(group).getByRole("button", { name: "1 hour · default" }).getAttribute("aria-pressed")).toBe("true");
		expect(within(group).getByRole("button", { name: "4 hours" }).getAttribute("aria-pressed")).toBe("false");
	});

	it("a preset saves on click, optimistically", async () => {
		let resolve: (v: unknown) => void = () => {};
		updateAgentPolicy.mockReturnValue(new Promise((r) => (resolve = r)));
		renderPage();
		const group = await screen.findByRole("group", { name: "Request lifetime" });
		fireEvent.click(within(group).getByRole("button", { name: "4 hours" }));
		await waitFor(() => expect(updateAgentPolicy).toHaveBeenCalledWith({ approvalTtlMinutes: 240 }));
		await waitFor(() =>
			expect(within(group).getByRole("button", { name: "4 hours" }).getAttribute("aria-pressed")).toBe("true"),
		);
		resolve({ ok: true, data: settings({ approvalTtlMinutes: 240 }) });
	});

	it("a refused save rolls the switch back", async () => {
		let refuse: (v: unknown) => void = () => {};
		updateAgentPolicy.mockReturnValue(new Promise((r) => (refuse = r)));
		renderPage();
		const noProd = await screen.findByRole("switch", { name: "Keep agents off production" });
		fireEvent.click(noProd);
		await waitFor(() => expect(updateAgentPolicy).toHaveBeenCalledWith({ agentsMayNotApplyToProduction: true }));
		// Moved at once, before the server answers…
		expect(switchNamed("Keep agents off production").getAttribute("aria-checked")).toBe("true");
		refuse({ ok: false, error: { kind: "forbidden", message: "No." } });
		// …and back when it refuses.
		await waitFor(() => expect(switchNamed("Keep agents off production").getAttribute("aria-checked")).toBe("false"));
	});

	it("turning access off asks first, and saves only on confirm", async () => {
		updateAgentPolicy.mockResolvedValue({ ok: true, data: settings({ agentAccessEnabled: false }) });
		renderPage();
		fireEvent.click(await screen.findByRole("switch", { name: "Let agents work in acme" }));
		const dialog = await screen.findByRole("alertdialog", { name: "Turn off agent access for acme?" });
		expect(within(dialog).getByText(/Takes effect immediately for everyone in the organization\./)).toBeTruthy();
		expect(updateAgentPolicy).not.toHaveBeenCalled();
		fireEvent.click(within(dialog).getByRole("button", { name: "Turn off agent access" }));
		await waitFor(() => expect(updateAgentPolicy).toHaveBeenCalledWith({ agentAccessEnabled: false }));
	});

	it("cancelling the confirmation changes nothing", async () => {
		renderPage();
		fireEvent.click(await screen.findByRole("switch", { name: "Let agents work in acme" }));
		const dialog = await screen.findByRole("alertdialog", { name: "Turn off agent access for acme?" });
		fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
		await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
		expect(updateAgentPolicy).not.toHaveBeenCalled();
		expect(switchNamed("Let agents work in acme").getAttribute("aria-checked")).toBe("true");
	});
});

describe("AgentPolicyPage — agent access off", () => {
	it("shows the banner with Turn back on, which saves with no dialog", async () => {
		h.policy = async () => policyRead({ agentAccessEnabled: false });
		updateAgentPolicy.mockResolvedValue({ ok: true, data: settings() });
		renderPage();
		const banner = await screen.findByText("Agent access is off.");
		const region = banner.closest('[role="status"]');
		expect(region?.textContent).toContain(
			"Connected agents and the Alethia assistant can't read, plan, deploy or destroy anything in acme.",
		);
		expect(
			screen.getByText(
				"Every agent request is refused, including reads. Requests already waiting can't be used. The Alethia CLI and service tokens keep working.",
			),
		).toBeTruthy();
		expect(switchNamed("Keep agents off production").getAttribute("aria-disabled")).toBe("true");
		fireEvent.click(screen.getByRole("button", { name: "Turn back on" }));
		expect(screen.queryByRole("alertdialog")).toBeNull();
		await waitFor(() => expect(updateAgentPolicy).toHaveBeenCalledWith({ agentAccessEnabled: true }));
	});
});

describe("AgentPolicyPage — without org:manage_agents", () => {
	it("is read-only: every control disabled, the inline alert, no Turn back on", async () => {
		h.policy = async () => policyRead({ agentAccessEnabled: false }, false);
		renderPage();
		expect(await screen.findByText("You can't change agent settings")).toBeTruthy();
		expect(
			screen.getByText(
				"Changing them needs the Manage agents permission, which your role in acme doesn't include. You can see how acme is set up; ask someone who manages roles if you need it.",
			),
		).toBeTruthy();
		for (const s of screen.getAllByRole("switch")) expect(s.getAttribute("aria-disabled")).toBe("true");
		for (const b of within(screen.getByRole("group", { name: "Request lifetime" })).getAllByRole("button")) {
			expect(b.hasAttribute("disabled")).toBe(true);
		}
		expect(screen.queryByRole("button", { name: "Turn back on" })).toBeNull();
	});
});

describe("AgentPolicyPage — the Enterprise rows", () => {
	it("outside Enterprise: locked with Available on Enterprise", async () => {
		renderPage();
		const diff = await screen.findByRole("switch", { name: "Require a different person to approve" });
		expect(diff.getAttribute("aria-disabled")).toBe("true");
		expect(
			screen.getByText("On Community and Pro, the person a request was made for can approve it themselves."),
		).toBeTruthy();
		expect(screen.getByText("Any app")).toBeTruthy();
		expect(screen.getByRole("button", { name: "Limit to chosen apps" }).hasAttribute("disabled")).toBe(true);
	});

	it("on Enterprise: the stored value and its consequence, with the allow-list by app name", async () => {
		h.entitled = true;
		h.policy = async () =>
			policyRead({
				requireDifferentApprover: true,
				allowedOauthClientIds: ["https://claude.ai/code/oauth/client.json"],
			});
		renderPage();
		const diff = await screen.findByRole("switch", { name: "Require a different person to approve" });
		expect(diff.getAttribute("aria-checked")).toBe("true");
		expect(
			screen.getByText(
				"Make sure at least two people have deploy access to each project, or requests there can only be denied.",
			),
		).toBeTruthy();
		expect(within(screen.getByRole("list", { name: "Allowed agent apps" })).getByText("Claude Code")).toBeTruthy();
		expect(screen.queryByText("Available on Enterprise.")).toBeNull();
	});

	it("while the entitlement is unknown: neither the consequence nor the upsell", async () => {
		h.entitled = null;
		renderPage();
		await screen.findByRole("switch", { name: "Require a different person to approve" });
		expect(screen.queryByText("Available on Enterprise.")).toBeNull();
		expect(screen.queryByText("You can approve requests made by your own agents and CLI.")).toBeNull();
	});
});

describe("withPolicyPatch", () => {
	it("moves only the toggles the patch names", () => {
		const before = policyRead();
		expect(withPolicyPatch(before, { approvalTtlMinutes: 15 })).toEqual({
			...before,
			settings: { ...before.settings, approvalTtlMinutes: 15 },
		});
	});

	it("returns a value that is not the read as it is", () => {
		expect(withPolicyPatch(undefined, { agentAccessEnabled: false })).toBeUndefined();
	});
});
