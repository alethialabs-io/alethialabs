// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #7204 — Leave organization, in Settings · General's danger zone. Drives the REAL `OrgGeneral`;
// only the network edges are mocked (better-auth's `organization.leave`, the router, the toasts).
//
//   · the org's last ACTIVE owner sees Leave disabled WITH the reason, never a dead button — the
//     rule the auth route applies to `/organization/leave`;
//   · an owner beside another active owner, and any non-owner, may leave: a confirmation first,
//     then ONE call, then the next organization (or `/dashboard` when there is none);
//   · a refused or failed leave stays on the page and says why.

import type { QueryClient } from "@tanstack/react-query";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	leave: vi.fn(async (_input: unknown) => ({ data: {}, error: null as { status: number; message?: string } | null })),
	push: vi.fn(),
	toastError: vi.fn(),
	toastSuccess: vi.fn(),
}));

vi.mock("next/navigation", () => ({
	useRouter: () => ({ push: h.push, replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("sonner", () => ({
	toast: {
		error: (...a: unknown[]) => h.toastError(...a),
		success: (...a: unknown[]) => h.toastSuccess(...a),
	},
}));
vi.mock("@/app/server/actions/org-settings", () => ({
	saveOrgGeneral: vi.fn(),
	deleteOrganization: vi.fn(),
}));
vi.mock("@/lib/auth/client", () => ({
	authClient: { organization: { leave: (input: unknown) => h.leave(input) } },
}));
vi.mock("@/components/org/org-logo-upload", () => ({ OrgLogoUpload: () => null }));
vi.mock("@/lib/org-url", () => ({ orgHost: () => "alethialabs.io" }));

import type { MemberRow } from "@/app/server/actions/members";
import { COMMUNITY_ENTITLEMENTS } from "@/lib/billing/plan";
import { orpc } from "@/lib/rpc/client";
import type { WorkspaceContext, WorkspaceOrg } from "@/lib/rpc/procedures/workspace";
import { renderOrgGeneral, seededClient } from "../../support/general-settings";

/** Why Leave is disabled for the last active owner (org-general.tsx). */
const SOLE_OWNER =
	"You are this organization's only active owner. Make another active member an owner before you leave.";

/** One org row in the switcher's list. */
function org(id: string, slug: string | null, role: string): WorkspaceOrg {
	return { id, name: id, slug, logo: null, role, plan: "team", status: "active" };
}

/** The hydrated workspace context: the caller is on `org-1` holding `role`, plus `others`. */
function context(role: string, others: WorkspaceOrg[] = []): WorkspaceContext {
	return {
		activeOrgId: "org-1",
		organizations: [org("org-1", "acme", role), ...others],
		entitlements: COMMUNITY_ENTITLEMENTS,
		isHosted: true,
	};
}

/** One `members.list` row. */
function member(id: string, role: string, status = "active"): MemberRow {
	return {
		id,
		userId: `u-${id}`,
		name: id,
		username: null,
		email: `${id}@acme.test`,
		image: null,
		role,
		joinedAt: "2026-01-01T00:00:00.000Z",
		teams: [],
		status,
		lastActiveAt: null,
	};
}

/** A client holding the workspace context and, when given, the org's member list. */
function client(ctx: WorkspaceContext, members?: MemberRow[]): QueryClient {
	const c = seededClient();
	c.setQueryData(orpc.workspace.context.queryKey(), ctx);
	if (members) c.setQueryData(orpc.members.list.queryKey({ input: undefined }), members);
	return c;
}

/** The danger zone's Leave trigger. */
function leaveTrigger(): HTMLElement {
	return screen.getByRole("button", { name: "Leave organization" });
}

beforeEach(() => {
	vi.clearAllMocks();
	h.leave.mockResolvedValue({ data: {}, error: null });
});

describe("leave organization — the last active owner", () => {
	it("is disabled with the reason when the caller is the only owner", async () => {
		renderOrgGeneral(undefined, client(context("owner"), [member("me", "owner"), member("b", "viewer")]));
		const trigger = await screen.findByRole("button", { name: "Leave organization" });
		expect(trigger).toBeDisabled();
		expect(trigger).toHaveAccessibleDescription(SOLE_OWNER);
		expect(trigger.closest('[data-slot="disabled-reason"]')).not.toBeNull();
	});

	it("counts a suspended second owner as no owner at all, as the server does", async () => {
		renderOrgGeneral(
			undefined,
			client(context("owner"), [member("me", "owner"), member("b", "owner", "suspended")]),
		);
		expect(await screen.findByRole("button", { name: "Leave organization" })).toHaveAccessibleDescription(SOLE_OWNER);
	});

	it("reads a combined stored role (`owner,admin`) as an owner", async () => {
		renderOrgGeneral(undefined, client(context("owner,admin"), [member("me", "owner,admin")]));
		expect(await screen.findByRole("button", { name: "Leave organization" })).toBeDisabled();
		expect(h.leave).not.toHaveBeenCalled();
	});
});

describe("leave organization — a member who may leave", () => {
	it("an owner beside another active owner confirms, leaves once and lands in their next organization", async () => {
		const user = userEvent.setup();
		renderOrgGeneral(
			undefined,
			client(context("owner", [org("org-2", "globex", "viewer")]), [member("me", "owner"), member("b", "owner")]),
		);
		await user.click(leaveTrigger());
		const dialog = await screen.findByRole("alertdialog");
		expect(dialog).toHaveTextContent("Leave Acme?");
		expect(h.leave).not.toHaveBeenCalled();

		await user.click(within(dialog).getByRole("button", { name: "Leave organization" }));
		await waitFor(() => expect(h.push).toHaveBeenCalledWith("/globex"));
		expect(h.leave).toHaveBeenCalledTimes(1);
		expect(h.leave).toHaveBeenCalledWith({ organizationId: "org-1" });
		expect(h.toastSuccess).toHaveBeenCalledWith("You left Acme.");
	});

	it("a viewer may leave without the member list being read, and lands on /dashboard with no other org", async () => {
		const user = userEvent.setup();
		const c = client(context("viewer"));
		renderOrgGeneral(undefined, c);
		expect(leaveTrigger()).toBeEnabled();
		expect(c.getQueryState(orpc.members.list.queryKey({ input: undefined }))?.fetchStatus ?? "idle").toBe("idle");

		await user.click(leaveTrigger());
		const dialog = await screen.findByRole("alertdialog");
		await user.click(within(dialog).getByRole("button", { name: "Leave organization" }));
		await waitFor(() => expect(h.push).toHaveBeenCalledWith("/dashboard"));
	});

	it("skips an organization with no address when choosing where to land", async () => {
		const user = userEvent.setup();
		renderOrgGeneral(
			undefined,
			client(context("admin", [org("org-2", null, "viewer"), org("org-3", "initech", "viewer")])),
		);
		await user.click(leaveTrigger());
		const dialog = await screen.findByRole("alertdialog");
		await user.click(within(dialog).getByRole("button", { name: "Leave organization" }));
		await waitFor(() => expect(h.push).toHaveBeenCalledWith("/initech"));
	});

	it("Cancel sends nothing", async () => {
		const user = userEvent.setup();
		renderOrgGeneral(undefined, client(context("viewer")));
		await user.click(leaveTrigger());
		const dialog = await screen.findByRole("alertdialog");
		await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
		await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
		expect(h.leave).not.toHaveBeenCalled();
	});
});

describe("leave organization — failure", () => {
	it("stays on the page with the dialog up and toasts the server's sentence when the leave is refused", async () => {
		const refusal = "This is the team's only active owner. Make another active member an owner first.";
		h.leave.mockResolvedValue({ data: {}, error: { status: 400, message: refusal } });
		const user = userEvent.setup();
		renderOrgGeneral(undefined, client(context("viewer")));
		await user.click(leaveTrigger());
		const dialog = await screen.findByRole("alertdialog");
		await user.click(within(dialog).getByRole("button", { name: "Leave organization" }));

		await waitFor(() => expect(h.toastError).toHaveBeenCalledWith(refusal));
		expect(h.push).not.toHaveBeenCalled();
		expect(h.toastSuccess).not.toHaveBeenCalled();
		expect(screen.getByRole("alertdialog")).toBeInTheDocument();
	});

	it("a call that gets no answer is never a success", async () => {
		h.leave.mockRejectedValue(new TypeError("Failed to fetch"));
		const user = userEvent.setup();
		renderOrgGeneral(undefined, client(context("viewer")));
		await user.click(leaveTrigger());
		const dialog = await screen.findByRole("alertdialog");
		await user.click(within(dialog).getByRole("button", { name: "Leave organization" }));

		await waitFor(() => expect(h.toastError).toHaveBeenCalled());
		expect(h.push).not.toHaveBeenCalled();
		expect(h.toastSuccess).not.toHaveBeenCalled();
	});

	it("is disabled with a reason when the page does not know which organization it is on", () => {
		renderOrgGeneral();
		expect(leaveTrigger()).toBeDisabled();
		expect(leaveTrigger()).toHaveAccessibleDescription("Reload the page to leave this organization");
	});
});
