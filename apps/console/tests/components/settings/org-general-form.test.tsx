// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6128 — Settings · General (org), asserted on what the user sees and on what reaches the server.
// Each block names the console-hunt finding it closes:
//   F012/F024  Save enabled on a pristine form; inputs with no `name`; no inline validation.
//   F013       An empty name leaked "[body.data.name] Too small: …" into a toast.
//   F014       No max length; a long name overflowed the danger zone.
//   F015       Three rapid clicks were three saves.
//   F040       After a rename the switcher still showed the old name (its key was not invalidated).
//   F050       A `null` read rendered as "still loading" forever.

import { ORPCError } from "@orpc/client";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const saveOrgGeneral = vi.fn();
const deleteOrganization = vi.fn();
const toastError = vi.fn();
const toastSuccess = vi.fn();
const push = vi.fn();
const replace = vi.fn();

vi.mock("next/navigation", () => ({
	useRouter: () => ({ push, replace, refresh: vi.fn() }),
}));
vi.mock("sonner", () => ({
	toast: {
		error: (...a: unknown[]) => toastError(...a),
		success: (...a: unknown[]) => toastSuccess(...a),
	},
}));
vi.mock("@/app/server/actions/org-settings", () => ({
	saveOrgGeneral: (...a: unknown[]) => saveOrgGeneral(...a),
	deleteOrganization: (...a: unknown[]) => deleteOrganization(...a),
}));
vi.mock("@/components/org/org-logo-upload", () => ({ OrgLogoUpload: () => null }));
vi.mock("@/lib/org-url", () => ({ orgHost: () => "alethialabs.io" }));

import { COMMUNITY_ENTITLEMENTS } from "@/lib/billing/plan";
import { orpc } from "@/lib/rpc/client";
import type { OrgGeneralRead } from "@/lib/rpc/procedures/settings";
import type { WorkspaceContext } from "@/lib/rpc/procedures/workspace";
import { ORG_NAME_MAX_LENGTH } from "@/lib/validations/org-general";
import {
	ACME,
	failRead,
	mountOrgGeneral,
	renderOrgGeneral,
	seededClient,
} from "../../support/general-settings";

/** The hydrated workspace context, with the caller holding `role` in the addressed org. */
function CONTEXT(role: string): WorkspaceContext {
	return {
		activeOrgId: "org-1",
		organizations: [
			{ id: "org-1", name: "Acme", slug: "acme", logo: null, role, plan: "team", status: "active" },
		],
		entitlements: COMMUNITY_ENTITLEMENTS,
		isHosted: true,
	};
}

/** Both Save buttons (Organization profile, Defaults). */
function saveButtons() {
	return screen.getAllByRole("button", { name: /^(Save changes|Saving…)$/ });
}

beforeEach(() => {
	vi.clearAllMocks();
	saveOrgGeneral.mockImplementation(async (values: { name: string; slug: string }) => ({
		ok: true,
		data: { name: values.name, slug: values.slug },
	}));
	deleteOrganization.mockResolvedValue({ ok: true, data: { deleted: true } });
});

describe("F012/F024 — one form standard: pristine is not saveable", () => {
	it("paints the loaded values on first render, with both Saves disabled", () => {
		renderOrgGeneral();
		// First paint IS the form: the read was hydrated, nothing is fetched (B1).
		expect(screen.getByRole("textbox", { name: "Organization name" })).toHaveValue("Acme");
		for (const button of saveButtons()) expect(button).toBeDisabled();
	});

	it("enables Save once a field changes, and disables it again when the edit is undone", async () => {
		const user = userEvent.setup();
		renderOrgGeneral();
		const name = screen.getByRole("textbox", { name: "Organization name" });
		await user.type(name, " Corp");
		for (const button of saveButtons()) expect(button).toBeEnabled();
		await user.clear(name);
		await user.type(name, "Acme");
		for (const button of saveButtons()) expect(button).toBeDisabled();
	});

	it("binds every text input to the form by name", () => {
		const { container } = renderOrgGeneral();
		const names = [...container.querySelectorAll("input[name], textarea[name]")].map((el) =>
			el.getAttribute("name"),
		);
		expect(names).toEqual(["name", "slug", "description", "terraformVersion"]);
	});
});

describe("F013 — validation is inline, never raw validator text in a toast", () => {
	it("refuses an empty name under the field, without a request", async () => {
		const user = userEvent.setup();
		renderOrgGeneral();
		const name = screen.getByRole("textbox", { name: "Organization name" });
		await user.clear(name);
		await user.click(saveButtons()[0]);

		const alert = await screen.findByRole("alert");
		expect(alert).toHaveTextContent("An organization name is required.");
		expect(name).toHaveAttribute("aria-invalid", "true");
		expect(name).toHaveAttribute("aria-describedby", alert.id);
		expect(saveOrgGeneral).not.toHaveBeenCalled();
		expect(toastError).not.toHaveBeenCalled();
	});

	it("puts a server validation result under its field, not in a toast", async () => {
		saveOrgGeneral.mockResolvedValue({
			ok: false,
			error: {
				kind: "validation",
				message: "Use a release number such as 1.9.5.",
				fields: { terraformVersion: ["Use a release number such as 1.9.5."] },
			},
		});
		const user = userEvent.setup();
		renderOrgGeneral();
		await user.type(screen.getByRole("textbox", { name: "Description" }), "x");
		await user.click(saveButtons()[0]);

		expect(await screen.findByRole("alert")).toHaveTextContent("Use a release number such as 1.9.5.");
		expect(toastError).not.toHaveBeenCalled();
	});

	it("says something human for an unexpected failure — a reference, never the server's text", async () => {
		saveOrgGeneral.mockResolvedValue({ ok: false, error: { kind: "unexpected", ref: "ab12cd34" } });
		const user = userEvent.setup();
		renderOrgGeneral();
		await user.type(screen.getByRole("textbox", { name: "Description" }), "x");
		await user.click(saveButtons()[0]);

		await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1));
		expect(String(toastError.mock.calls[0][0])).toMatch(/Reference: ab12cd34/);
		expect(toastSuccess).not.toHaveBeenCalled();
	});
});

describe("F014 — lengths are bounded, and a long name cannot break the page", () => {
	it("caps the name field at the schema's length", () => {
		renderOrgGeneral();
		expect(screen.getByRole("textbox", { name: "Organization name" })).toHaveAttribute(
			"maxLength",
			String(ORG_NAME_MAX_LENGTH),
		);
	});

	it("lets an unbroken name wrap inside the danger zone instead of widening the page", () => {
		const long = "A".repeat(ORG_NAME_MAX_LENGTH);
		renderOrgGeneral({ scope: "organization", settings: { ...ACME, name: long } });
		const row = screen.getByRole("group", { name: "Delete organization" });
		const name = within(row).getByText(long);
		expect(name.className).toContain("[overflow-wrap:anywhere]");
	});
});

describe("F015 — a save is one save, however many clicks", () => {
	it("sends ONE request for three rapid clicks, with the buttons disabled while it runs", async () => {
		let finish: (value: unknown) => void = () => {};
		saveOrgGeneral.mockImplementation(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		const user = userEvent.setup();
		renderOrgGeneral();
		await user.type(screen.getByRole("textbox", { name: "Description" }), "x");
		const [first] = saveButtons();
		await user.click(first);
		await user.click(first);
		await user.click(first);

		await waitFor(() => expect(saveOrgGeneral).toHaveBeenCalledTimes(1));
		for (const button of saveButtons()) {
			expect(button).toBeDisabled();
			expect(button).toHaveTextContent("Saving…");
		}
		await act(async () => finish({ ok: true, data: { name: "Acme", slug: "acme" } }));
		await waitFor(() => expect(toastSuccess).toHaveBeenCalledTimes(1));
		expect(saveOrgGeneral).toHaveBeenCalledTimes(1);
	});
});

describe("F040 — a save refreshes every place that shows the org", () => {
	it("invalidates this read AND the workspace context the switcher and breadcrumb render", async () => {
		const client = seededClient();
		client.setQueryData(orpc.workspace.context.queryKey(), {
			activeOrgId: "org-1",
			organizations: [],
			entitlements: COMMUNITY_ENTITLEMENTS,
			isHosted: true,
		});
		const user = userEvent.setup();
		renderOrgGeneral(undefined, client);
		const name = screen.getByRole("textbox", { name: "Organization name" });
		await user.clear(name);
		await user.type(name, "Acme Corp");
		await user.click(saveButtons()[0]);

		await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith("Organization updated."));
		expect(saveOrgGeneral).toHaveBeenCalledWith(expect.objectContaining({ name: "Acme Corp" }));
		expect(client.getQueryState(orpc.settings.org.queryKey())?.isInvalidated).toBe(true);
		expect(client.getQueryState(orpc.workspace.context.queryKey())?.isInvalidated).toBe(true);
		// The saved value is the new baseline: Save is disabled again.
		for (const button of saveButtons()) expect(button).toBeDisabled();
	});

	it("goes to the org's new address after a slug rename — without refetching under the OLD one", async () => {
		// Review on #6216: the invalidation used to refetch through the old address, which names no
		// org any more, so the page painted a refusal before the navigation landed. The new address
		// is a new tenant cache filled by its own server render; the old one is left alone.
		const client = seededClient();
		client.setQueryData(orpc.workspace.context.queryKey(), CONTEXT("owner"));
		const user = userEvent.setup();
		renderOrgGeneral(undefined, client);
		const slug = screen.getByDisplayValue("acme");
		await user.clear(slug);
		await user.type(slug, "acme-corp");
		await user.click(saveButtons()[0]);
		await waitFor(() => expect(replace).toHaveBeenCalledWith("/acme-corp/~/settings/general"));
		expect(client.getQueryState(orpc.settings.org.queryKey())?.isInvalidated).toBe(false);
		expect(client.getQueryState(orpc.workspace.context.queryKey())?.isInvalidated).toBe(false);
	});

	it("does not navigate when the slug did not change", async () => {
		const user = userEvent.setup();
		renderOrgGeneral();
		await user.type(screen.getByRole("textbox", { name: "Description" }), "x");
		await user.click(saveButtons()[0]);
		await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
		expect(replace).not.toHaveBeenCalled();
	});
});

describe("live — another admin's save", () => {
	it("is shown on a pristine form when the read refetches", async () => {
		const { client } = renderOrgGeneral();
		const theirs: OrgGeneralRead = { scope: "organization", settings: { ...ACME, name: "Acme Holdings" } };
		act(() => {
			client.setQueryData(orpc.settings.org.queryKey(), theirs);
		});
		await waitFor(() =>
			expect(screen.getByRole("textbox", { name: "Organization name" })).toHaveValue("Acme Holdings"),
		);
	});

	it("does not overwrite what the user is typing", async () => {
		const user = userEvent.setup();
		const { client } = renderOrgGeneral();
		const description = screen.getByRole("textbox", { name: "Description" });
		await user.type(description, "Mine");
		const theirs: OrgGeneralRead = { scope: "organization", settings: { ...ACME, description: "Theirs" } };
		act(() => {
			client.setQueryData(orpc.settings.org.queryKey(), theirs);
		});
		expect(description).toHaveValue("Mine");
	});
});

describe("F050 — four renders, never confused", () => {
	it("answers the personal workspace with a note, not a skeleton and not an empty form", () => {
		const { container } = renderOrgGeneral({ scope: "personal" });
		expect(screen.getByText("No organization settings here")).toBeInTheDocument();
		expect(container.querySelector('[data-slot="org-general-skeleton"]')).toBeNull();
		expect(screen.queryByRole("textbox")).toBeNull();
	});

	it("renders a refusal as a refusal — no retry, no skeleton", () => {
		const client = seededClient();
		failRead(
			client,
			orpc.settings.org.queryKey(),
			new ORPCError("FORBIDDEN", { defined: true, message: "You don't have permission to see this." }),
		);
		const { container } = mountOrgGeneral(client);
		expect(container.querySelector('[data-state="refused"]')).not.toBeNull();
		expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
		expect(container.querySelector('[data-slot="org-general-skeleton"]')).toBeNull();
	});

	it("renders a failure as an error with a retry — not as the refusal and not as a skeleton", () => {
		const client = seededClient();
		failRead(client, orpc.settings.org.queryKey(), new Error("network"));
		const { container } = mountOrgGeneral(client);
		expect(screen.getByRole("alert")).toHaveTextContent("Couldn't load organization settings");
		expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
		expect(container.querySelector('[data-state="refused"]')).toBeNull();
		expect(container.querySelector('[data-slot="org-general-skeleton"]')).toBeNull();
	});

	it("shows the skeleton only while nothing has answered", () => {
		const { container } = mountOrgGeneral(seededClient());
		expect(container.querySelector('[data-slot="org-general-skeleton"]')).not.toBeNull();
	});
});

describe("delete organization", () => {
	it("deletes once and leaves for the dashboard", async () => {
		const user = userEvent.setup();
		renderOrgGeneral();
		await user.click(screen.getByRole("button", { name: "Delete organization" }));
		const dialog = await screen.findByRole("alertdialog");
		await user.click(within(dialog).getByRole("button", { name: "Delete organization" }));

		await waitFor(() => expect(push).toHaveBeenCalledWith("/dashboard"));
		expect(deleteOrganization).toHaveBeenCalledTimes(1);
		expect(deleteOrganization).toHaveBeenCalledWith({});
	});

	it("does not refetch anything under the deleted org's address on its way out", async () => {
		const client = seededClient();
		client.setQueryData(orpc.workspace.context.queryKey(), CONTEXT("owner"));
		const user = userEvent.setup();
		renderOrgGeneral(undefined, client);
		await user.click(screen.getByRole("button", { name: "Delete organization" }));
		const dialog = await screen.findByRole("alertdialog");
		await user.click(within(dialog).getByRole("button", { name: "Delete organization" }));
		await waitFor(() => expect(push).toHaveBeenCalledWith("/dashboard"));
		expect(client.getQueryState(orpc.workspace.context.queryKey())?.isInvalidated).toBe(false);
		expect(client.getQueryState(orpc.settings.org.queryKey())?.isInvalidated).toBe(false);
	});

	it("stays on the page and says why when the server refuses", async () => {
		deleteOrganization.mockResolvedValue({
			ok: false,
			error: { kind: "forbidden", message: "You don't have permission to do that." },
		});
		const user = userEvent.setup();
		renderOrgGeneral();
		await user.click(screen.getByRole("button", { name: "Delete organization" }));
		const dialog = await screen.findByRole("alertdialog");
		await user.click(within(dialog).getByRole("button", { name: "Delete organization" }));

		await waitFor(() => expect(toastError).toHaveBeenCalledWith("You don't have permission to do that."));
		expect(push).not.toHaveBeenCalled();
	});
});

describe("controls a role cannot use are disabled, with the reason (review advisory on #6216)", () => {
	it("a viewer sees every field read-only and Save disabled, saying why", () => {
		const client = seededClient();
		client.setQueryData(orpc.workspace.context.queryKey(), CONTEXT("viewer"));
		renderOrgGeneral(undefined, client);
		expect(screen.getByRole("textbox", { name: "Organization name" })).toBeDisabled();
		for (const button of screen.getAllByRole("button", { name: "Save changes" })) {
			expect(button).toBeDisabled();
			expect(button).toHaveAccessibleDescription("Only the organization's owner can change these settings");
		}
	});

	it("an admin may neither edit nor delete — the plugin grants organization:update to the owner only", () => {
		const client = seededClient();
		client.setQueryData(orpc.workspace.context.queryKey(), CONTEXT("admin"));
		renderOrgGeneral(undefined, client);
		expect(screen.getByRole("textbox", { name: "Organization name" })).toBeDisabled();
		for (const button of screen.getAllByRole("button", { name: "Save changes" })) {
			expect(button).toBeDisabled();
			expect(button).toHaveAccessibleDescription("Only the organization's owner can change these settings");
		}
		const del = screen.getByRole("button", { name: "Delete organization" });
		expect(del).toBeDisabled();
		expect(del).toHaveAccessibleDescription("Only the organization's owner can delete it");
	});

	it("the owner may do both", () => {
		const client = seededClient();
		client.setQueryData(orpc.workspace.context.queryKey(), CONTEXT("owner"));
		renderOrgGeneral(undefined, client);
		expect(screen.getByRole("textbox", { name: "Organization name" })).toBeEnabled();
		expect(screen.getByRole("button", { name: "Delete organization" })).toBeEnabled();
	});
});
