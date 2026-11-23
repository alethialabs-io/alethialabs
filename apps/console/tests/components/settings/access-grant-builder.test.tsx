// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Settings · Access, CON-L10. Drives the REAL `AccessManager`; only the network edges are mocked.
//
//   · E-08 — `canManage: false` from the route disables Add grant and Revoke WITH the reason;
//   · E-16 — the grant builder is a react-hook-form + zod form whose fields are labelled, which says
//     what is missing under the field instead of a button that stays disabled without a reason, and
//     a failed options read is an error with a retry inside the builder — never an "Add grant" that
//     does nothing.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GrantOptions } from "@/app/server/actions/grants";
import type { AccessGrantsPage } from "@/lib/queries/access-grants";

vi.mock("next/navigation", () => ({
	useParams: () => ({ org: "acme" }),
	useRouter: () => ({ replace: vi.fn() }),
	usePathname: () => "/acme/~/settings/access",
	useSearchParams: () => new URLSearchParams(""),
}));

const h = vi.hoisted(() => ({
	options: vi.fn<() => Promise<unknown>>(),
	assignGrant: vi.fn(async (_input: unknown) => ({ ok: true, data: { assigned: true } })),
}));

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("@/app/server/actions/grants", () => ({
	assignGrant: (input: unknown) => h.assignGrant(input),
	revokeGrant: vi.fn(),
}));
vi.mock("@/lib/rpc/client", async () => {
	const { fakeOrpc } = await import("@/tests/helpers/fake-orpc");
	return {
		orpc: fakeOrpc({
			"members.grants": async () => PAGE,
			"members.grantOptions": async () => h.options(),
		}).orpc,
	};
});
vi.mock("@/components/settings/enterprise-gate", () => ({ useEntitlement: () => true }));
vi.mock("@/components/settings/upgrade/feature-upsell", () => ({ FeatureUpsell: () => null }));

import { AccessManager } from "@/components/settings/access/access-manager";
import { MANAGE_DENIED_REASON } from "@/components/errors/manage-gate";
import { useAccessFilters } from "@/lib/stores/use-settings-filters";

const PAGE: AccessGrantsPage & { asOf: string } = {
	rows: [
		{
			id: "g1",
			principalType: "user",
			principalId: "u1",
			principalLabel: "Ada Lovelace",
			effect: "allow",
			roleName: "viewer",
			permissionKey: null,
			resourceType: "org",
			resourceId: null,
			createdAt: "2026-01-01T00:00:00.000Z",
		},
		// A grant on a Project the option lists do not name (deleted, or not visible): R6 F-19.
		{
			id: "g2",
			principalType: "user",
			principalId: "u2",
			principalLabel: "Grace Hopper",
			effect: "allow",
			roleName: "operator",
			permissionKey: null,
			resourceType: "project",
			resourceId: "9f1c2d3e-0000-4000-8000-000000000000",
			createdAt: "2026-01-01T00:00:00.000Z",
		},
	],
	resultCount: 2,
	total: 2,
	asOf: "2026-01-02T00:00:00.000Z",
	facets: { scopes: [], roles: [], effects: [] },
};

const OPTIONS: GrantOptions = {
	principals: [{ id: "u1", label: "Ada Lovelace", type: "user" }],
	roles: [{ id: "r-viewer", name: "viewer", builtin: true }],
	permissions: [{ key: "project:view", resource: "project", action: "view" }],
	resources: { project: [], runner: [], cloud_identity: [] },
};

/** The manager, entitled, inside a fresh query provider. */
function tree(canManage?: boolean): ReactNode {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return (
		<QueryClientProvider client={qc}>
			<AccessManager customRoles canManage={canManage} />
		</QueryClientProvider>
	);
}

/** The text of every element `el`'s `aria-describedby` names. */
function description(el: HTMLElement): string {
	return (el.getAttribute("aria-describedby") ?? "")
		.split(" ")
		.map((id) => document.getElementById(id)?.textContent ?? "")
		.join(" ");
}

beforeEach(() => {
	sessionStorage.clear();
	useAccessFilters.getState().reset();
	h.options.mockReset();
	h.options.mockResolvedValue(OPTIONS);
	h.assignGrant.mockClear();
});

describe("the manage gate (R6 E-08)", () => {
	it("disables Add grant with the reason when the route says the viewer may not manage", async () => {
		render(tree(false));
		const add = await screen.findByRole("button", { name: /add grant/i });
		expect(add).toBeDisabled();
		expect(description(add)).toContain(MANAGE_DENIED_REASON);
	});

	it("disables Revoke in the row menu, saying why", async () => {
		const user = userEvent.setup();
		render(tree(false));
		await user.click(await screen.findByRole("button", { name: "Manage grant for Ada Lovelace" }));
		const revoke = await screen.findByRole("menuitem", { name: /Revoke access/ });
		expect(revoke).toHaveAttribute("aria-disabled", "true");
		expect(revoke).toHaveTextContent(MANAGE_DENIED_REASON);
	});
});

describe("the grant builder (R6 E-16)", () => {
	it("says what is missing under each field when Add grant is pressed empty, and sends nothing", async () => {
		const user = userEvent.setup();
		render(tree(true));
		await user.click(await screen.findByRole("button", { name: /add grant/i }));
		const form = await screen.findByRole("form", { name: "New grant" });
		await user.click(within(form).getByRole("button", { name: "Add grant" }));
		expect(await within(form).findByText("Pick a member or team.")).toBeInTheDocument();
		expect(within(form).getByText("Pick a role.")).toBeInTheDocument();
		expect(h.assignGrant).not.toHaveBeenCalled();
	});

	it("names the member-or-team picker from its visible label", async () => {
		const user = userEvent.setup();
		render(tree(true));
		await user.click(await screen.findByRole("button", { name: /add grant/i }));
		const form = await screen.findByRole("form", { name: "New grant" });
		expect(within(form).getByRole("button", { name: /^Member or team/ })).toBeInTheDocument();
	});

	it("shows a failed options read as an error with a retry, not a builder that cannot submit", async () => {
		h.options.mockRejectedValue(new Error("network"));
		const user = userEvent.setup();
		render(tree(true));
		await user.click(await screen.findByRole("button", { name: /add grant/i }));
		await waitFor(() =>
			expect(screen.getByText("Couldn't load what can be granted")).toBeInTheDocument(),
		);
		h.options.mockResolvedValue(OPTIONS);
		await user.click(screen.getByRole("button", { name: "Try again" }));
		expect(await screen.findByRole("form", { name: "New grant" })).toBeInTheDocument();
	});
});

// CON-PB2 (R6 E-20, E-21, E-25, F-19).
describe("access grants — CON-PB2", () => {
	it("a scope the option lists do not name reads Unknown resource, not a UUID fragment (F-19)", async () => {
		render(tree(true));
		expect(await screen.findByText("Unknown resource")).toBeInTheDocument();
		expect(screen.queryByText(/^9f1c2d3e/)).toBeNull();
	});

	it("the first column is headed Member or team, not Principal (E-25)", async () => {
		render(tree(true));
		expect(await screen.findByRole("columnheader", { name: "Member or team" })).toBeInTheDocument();
		expect(screen.queryByRole("columnheader", { name: "Principal" })).toBeNull();
	});

	it("the revoke confirmation names the role and who loses it (E-21)", async () => {
		const user = userEvent.setup();
		render(tree(true));
		await user.click(await screen.findByRole("button", { name: "Manage grant for Ada Lovelace" }));
		await user.click(await screen.findByRole("menuitem", { name: "Revoke access" }));
		const dialog = await screen.findByRole("alertdialog");
		expect(dialog).toHaveTextContent("Revoke Viewer from Ada Lovelace?");
	});

	it("Add grant opens the builder in a sheet (E-20)", async () => {
		const user = userEvent.setup();
		render(tree(true));
		await user.click(await screen.findByRole("button", { name: /add grant/i }));
		const sheet = await screen.findByRole("dialog");
		expect(within(sheet).getByRole("form", { name: "New grant" })).toBeInTheDocument();
	});
});
