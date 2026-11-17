// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6751 — a change to a role's PERMISSIONS ALONE is a change.
//
// The role sheet tracks dirty state (#6129): an edit with nothing changed cannot be saved, and
// closing with unsaved changes asks first. `permissionKeys` has no registered input, though — the
// matrix and the "start from" templates write it with `form.setValue`, and react-hook-form marks a
// field dirty on that path only when the call asks it to. So the commonest edit there is, granting
// or revoking one permission and touching nothing else, has to be pinned from the outside: Save
// enables, the save carries the new keys, and Cancel asks before dropping them.
//
// The pristine cases are here too, on purpose. Without them every assertion below would also pass
// against a sheet that was simply always dirty.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render as rtlRender, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RoleRow } from "@/app/server/actions/roles";

const updateRole = vi.fn();
const createRole = vi.fn();

vi.mock("@/app/server/actions/roles", () => ({
	updateRole: (...a: unknown[]) => updateRole(...a),
	createRole: (...a: unknown[]) => createRole(...a),
}));
vi.mock("@/lib/rpc/client", () => ({ orpc: { members: { key: () => [["members"]] } } }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
// Classification assignments are their own read; nothing here is about them.
vi.mock("@/components/classification/classification-control", () => ({
	ClassificationControl: () => null,
}));

import { RoleSheet } from "@/components/settings/roles/role-sheet";

/** A custom role holding one `project` permission, so the project group renders open. */
const ROLE: RoleRow = {
	id: "role-deployer",
	name: "project-deployer",
	description: "Deploys projects.",
	builtin: false,
	permissionKeys: ["project:view"],
	grantCount: 0,
};

/** A built-in offered as a "start from" template when creating. */
const TEMPLATE: RoleRow = {
	id: "role-viewer",
	name: "viewer",
	description: "Read-only.",
	builtin: true,
	permissionKeys: ["project:view", "job:view"],
	grantCount: 0,
};

/** Renders under a fresh QueryClient, which the mutation contract reads. */
function render(ui: ReactElement) {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return rtlRender(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

/** Opens the Permissions section and grants `project:create` — and touches nothing else. */
async function grantProjectCreate(user: ReturnType<typeof userEvent.setup>) {
	await user.click(screen.getByRole("button", { name: /Permissions/i }));
	await user.click(await screen.findByRole("switch", { name: /create\s+project:create/i }));
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("RoleSheet — editing a role's permissions only", () => {
	it("cannot save an edit that changes nothing", () => {
		render(<RoleSheet open onOpenChange={vi.fn()} role={ROLE} templates={[]} canManage />);
		expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
	});

	it("enables Save once a permission is granted", async () => {
		const user = userEvent.setup();
		render(<RoleSheet open onOpenChange={vi.fn()} role={ROLE} templates={[]} canManage />);

		await grantProjectCreate(user);

		expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled();
	});

	it("saves the new permission set", async () => {
		updateRole.mockResolvedValue({ ok: true, data: { id: ROLE.id } });
		const onOpenChange = vi.fn();
		const user = userEvent.setup();
		render(<RoleSheet open onOpenChange={onOpenChange} role={ROLE} templates={[]} canManage />);

		await grantProjectCreate(user);
		await user.click(screen.getByRole("button", { name: "Save changes" }));

		await vi.waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
		expect(updateRole).toHaveBeenCalledWith({
			id: ROLE.id,
			name: ROLE.name,
			description: ROLE.description,
			permissionKeys: ["project:view", "project:create"],
		});
	});

	it("asks before closing over an unsaved permission change", async () => {
		const onOpenChange = vi.fn();
		const user = userEvent.setup();
		render(<RoleSheet open onOpenChange={onOpenChange} role={ROLE} templates={[]} canManage />);

		await grantProjectCreate(user);
		await user.click(screen.getByRole("button", { name: "Cancel" }));

		expect(await screen.findByText("Discard your changes?")).toBeInTheDocument();
		expect(onOpenChange).not.toHaveBeenCalledWith(false);
	});

	it("closes a pristine sheet without asking", async () => {
		const onOpenChange = vi.fn();
		const user = userEvent.setup();
		render(<RoleSheet open onOpenChange={onOpenChange} role={ROLE} templates={[]} canManage />);

		await user.click(screen.getByRole("button", { name: "Cancel" }));

		expect(onOpenChange).toHaveBeenCalledWith(false);
		expect(screen.queryByText("Discard your changes?")).toBeNull();
	});
});

describe("RoleSheet — starting a new role from a template", () => {
	it("asks before closing once a template has filled the permissions", async () => {
		const onOpenChange = vi.fn();
		const user = userEvent.setup();
		render(
			<RoleSheet open onOpenChange={onOpenChange} role={null} templates={[TEMPLATE]} canManage />,
		);

		await user.click(screen.getByRole("button", { name: /^viewer$/i }));
		await user.click(screen.getByRole("button", { name: "Cancel" }));

		expect(await screen.findByText("Discard your changes?")).toBeInTheDocument();
		expect(onOpenChange).not.toHaveBeenCalledWith(false);
	});
});
