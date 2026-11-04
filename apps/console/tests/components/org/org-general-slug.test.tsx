// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #5445 — Settings · General: renaming the org's URL onto a reserved or taken slug is refused
// UNDER THE SLUG FIELD, before and after the request.
//
// #6128 moved the save from the browser's `authClient.organization.update` to the `saveOrgGeneral`
// action. The rules did not move: a RESERVED slug is the shared schema's (the form refuses it
// without a request), and a TAKEN one only the server can know — it now comes back as a
// `validation` result naming the slug field, which the form puts under the field. Each case below
// still fails against the form #5445 replaced, which checked neither and toasted better-auth's text.

import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const saveOrgGeneral = vi.fn();
const toastError = vi.fn();
const toastSuccess = vi.fn();

vi.mock("next/navigation", () => ({
	useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
}));
vi.mock("sonner", () => ({
	toast: {
		error: (...a: unknown[]) => toastError(...a),
		success: (...a: unknown[]) => toastSuccess(...a),
	},
}));
vi.mock("@/app/server/actions/org-settings", () => ({
	saveOrgGeneral: (...a: unknown[]) => saveOrgGeneral(...a),
	deleteOrganization: vi.fn(),
}));
vi.mock("@/components/org/org-logo-upload", () => ({ OrgLogoUpload: () => null }));
vi.mock("@/lib/org-url", () => ({ orgHost: () => "alethialabs.io" }));

import { renderOrgGeneral } from "../../support/general-settings";

const RESERVED = "That slug is reserved — try another.";
const TAKEN = "That slug is taken — try another.";

/** Renders the panel and replaces the loaded slug with `next`. */
async function renameTo(user: ReturnType<typeof userEvent.setup>, next: string) {
	renderOrgGeneral();
	const slug = screen.getByDisplayValue("acme");
	await user.clear(slug);
	await user.type(slug, next);
	return slug;
}

/** Clicks the first of the two Save buttons (the profile panel's). */
async function save(user: ReturnType<typeof userEvent.setup>) {
	await user.click(screen.getAllByRole("button", { name: "Save changes" })[0]);
}

beforeEach(() => {
	vi.clearAllMocks();
	saveOrgGeneral.mockImplementation(async (values: { name: string; slug: string }) => ({
		ok: true,
		data: { name: values.name, slug: values.slug },
	}));
});

describe("OrgGeneral — a slug it refuses", () => {
	it("refuses a RESERVED slug under the field, without asking the server", async () => {
		const user = userEvent.setup();
		const slug = await renameTo(user, "docs");
		await save(user);

		const alert = await screen.findByRole("alert");
		expect(alert).toHaveTextContent(RESERVED);
		expect(slug).toHaveAttribute("aria-invalid", "true");
		expect(slug).toHaveAttribute("aria-describedby", alert.id);
		expect(saveOrgGeneral).not.toHaveBeenCalled();
		expect(toastError).not.toHaveBeenCalled();
	});

	it("puts the SERVER's taken refusal under the field, never in a toast", async () => {
		saveOrgGeneral.mockResolvedValue({
			ok: false,
			error: { kind: "validation", message: TAKEN, fields: { slug: [TAKEN] } },
		});
		const user = userEvent.setup();
		const slug = await renameTo(user, "globex");
		await save(user);

		const alert = await screen.findByRole("alert");
		expect(alert).toHaveTextContent(TAKEN);
		expect(slug).toHaveAttribute("aria-invalid", "true");
		expect(slug).toHaveAttribute("aria-describedby", alert.id);
		expect(saveOrgGeneral).toHaveBeenCalledWith(expect.objectContaining({ slug: "globex" }));
		expect(toastError).not.toHaveBeenCalled();
		expect(toastSuccess).not.toHaveBeenCalled();
		// The refused slug stays in the box for the user to change.
		expect(slug).toHaveValue("globex");
	});

	it("saves the org's OWN slug unchanged, with no refusal", async () => {
		const user = userEvent.setup();
		renderOrgGeneral();
		// Change something else so the form is dirty; the slug is the one the org already holds.
		await user.type(screen.getByRole("textbox", { name: "Description" }), "Platform team");
		await save(user);

		await vi.waitFor(() => expect(saveOrgGeneral).toHaveBeenCalled());
		expect(saveOrgGeneral).toHaveBeenCalledWith(expect.objectContaining({ slug: "acme" }));
		expect(toastSuccess).toHaveBeenCalledWith("Organization updated.");
		expect(screen.queryByRole("alert")).toBeNull();
	});
});

// #5453 — the URL field re-slugged its value on every keystroke with `slugifyOrEmpty`, which trims
// a trailing dash, so a hyphen could not be typed: `acme-two` arrived as `acmetwo`.
describe("OrgGeneral — typing a hyphen into the URL", () => {
	it("keeps the typed hyphen, so the next letter lands after it", async () => {
		const user = userEvent.setup();
		const slug = await renameTo(user, "my-");
		expect(slug).toHaveValue("my-");
		await user.type(slug, "t");
		expect(slug).toHaveValue("my-t");
	});

	it("trims a trailing hyphen on save, and saves the trimmed slug", async () => {
		const user = userEvent.setup();
		const slug = await renameTo(user, "acme-two-");
		expect(slug).toHaveValue("acme-two-");
		await save(user);

		await vi.waitFor(() => expect(saveOrgGeneral).toHaveBeenCalled());
		expect(saveOrgGeneral).toHaveBeenCalledWith(expect.objectContaining({ slug: "acme-two" }));
		await vi.waitFor(() => expect(slug).toHaveValue("acme-two"));
	});
});
