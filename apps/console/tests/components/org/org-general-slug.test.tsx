// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #5445 — Settings · General: renaming the org's URL onto a reserved or taken slug is refused
// UNDER THE SLUG FIELD, before and after the request.
//
// The form saved through `authClient.organization.update` and checked neither rule first. On the old
// form a reserved slug went straight to the server (where nothing refused it until ee/'s hook), and
// a taken one came back as better-auth's own sentence in a toast — nowhere near the field, with the
// field not marked invalid. Each case below fails against that form.

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const update = vi.fn();
const isOrgSlugAvailable = vi.fn();
const toastError = vi.fn();
const toastSuccess = vi.fn();

vi.mock("next/navigation", () => ({
	useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("sonner", () => ({
	toast: {
		error: (...a: unknown[]) => toastError(...a),
		success: (...a: unknown[]) => toastSuccess(...a),
	},
}));
vi.mock("@/lib/auth/client", () => ({
	authClient: {
		organization: {
			update: (...a: unknown[]) => update(...a),
			delete: vi.fn(),
		},
	},
}));
vi.mock("@/lib/stores/use-workspace-store", () => ({
	useWorkspaceStore: (
		pick: (s: { activeOrgId: string; fetchWorkspace: () => Promise<void> }) => unknown,
	) => pick({ activeOrgId: "org-1", fetchWorkspace: vi.fn().mockResolvedValue(undefined) }),
}));
vi.mock("@/app/server/actions/org-settings", () => ({
	getOrgSettings: vi.fn().mockResolvedValue({
		name: "Acme",
		slug: "acme",
		logo: null,
		description: "",
		primaryAddress: null,
		region: "eu-west-1",
		defaultEnv: "staging",
		terraformVersion: "1.9.0",
	}),
}));
vi.mock("@/app/server/actions/billing", () => ({
	isOrgSlugAvailable: (...a: unknown[]) => isOrgSlugAvailable(...a),
}));
vi.mock("@/components/org/org-logo-upload", () => ({ OrgLogoUpload: () => null }));
vi.mock("@/lib/org-url", () => ({ orgHost: () => "alethialabs.io" }));

import { OrgGeneral } from "@/components/settings/general/org-general";

const RESERVED = "That slug is reserved — try another.";
const TAKEN = "That slug is taken — try another.";

/** Renders the panel, waits for the loaded slug, and replaces it with `next`. */
async function renameTo(user: ReturnType<typeof userEvent.setup>, next: string) {
	render(<OrgGeneral />);
	const slug = await screen.findByDisplayValue("acme");
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
	isOrgSlugAvailable.mockResolvedValue(true);
	update.mockResolvedValue({ data: {}, error: null });
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
		expect(update).not.toHaveBeenCalled();
		expect(toastError).not.toHaveBeenCalled();
	});

	it("refuses a TAKEN slug under the field, before the save", async () => {
		isOrgSlugAvailable.mockResolvedValue(false);
		const user = userEvent.setup();
		await renameTo(user, "globex");
		await save(user);

		expect(await screen.findByRole("alert")).toHaveTextContent(TAKEN);
		expect(isOrgSlugAvailable).toHaveBeenCalledWith("globex");
		expect(update).not.toHaveBeenCalled();
	});

	it("puts the SERVER's refusal under the field too (the client check skipped or raced)", async () => {
		update.mockResolvedValue({
			data: null,
			error: { code: "ORGANIZATION_SLUG_RESERVED", message: RESERVED },
		});
		const user = userEvent.setup();
		await renameTo(user, "acme-two");
		await save(user);

		expect(await screen.findByRole("alert")).toHaveTextContent(RESERVED);
		expect(toastError).not.toHaveBeenCalled();
		expect(toastSuccess).not.toHaveBeenCalled();
	});

	it("names better-auth's own taken refusal as taken, under the field", async () => {
		update.mockResolvedValue({
			data: null,
			error: { code: "ORGANIZATION_SLUG_ALREADY_TAKEN", message: "Organization slug already taken" },
		});
		const user = userEvent.setup();
		await renameTo(user, "acme-two");
		await save(user);

		expect(await screen.findByRole("alert")).toHaveTextContent(TAKEN);
	});

	it("does not count the org's OWN slug as taken, and saves", async () => {
		isOrgSlugAvailable.mockResolvedValue(false);
		const user = userEvent.setup();
		render(<OrgGeneral />);
		await screen.findByDisplayValue("acme");
		await save(user);

		await vi.waitFor(() => expect(update).toHaveBeenCalled());
		expect(isOrgSlugAvailable).not.toHaveBeenCalled();
		expect(toastSuccess).toHaveBeenCalledWith("Organization updated.");
		expect(screen.queryByRole("alert")).toBeNull();
	});
});
