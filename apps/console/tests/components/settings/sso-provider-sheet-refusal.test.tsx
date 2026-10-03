// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #5445 — the SSO provider form shows the identity-provider plugin's refusal IN THE FORM.
//
// An edit used to call `updateSsoProvider`, which THREW the plugin's sentence out of a server action
// (a digest in a production build), and the sheet toasted whatever arrived. The action now returns
// `{ ok: false, error }`. Against the old sheet this fails twice over: it ignored the returned value,
// toasted "Provider updated" and CLOSED the form over a save that had been refused.

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const updateSsoProvider = vi.fn();
const toastError = vi.fn();
const toastSuccess = vi.fn();

vi.mock("@/app/server/actions/sso", () => ({
	updateSsoProvider: (...a: unknown[]) => updateSsoProvider(...a),
}));
vi.mock("@/lib/query/use-sso-query", () => ({ useInvalidateSso: () => vi.fn() }));
vi.mock("@/lib/stores/use-workspace-store", () => ({
	useWorkspaceStore: (pick: (s: { activeOrgId: string }) => unknown) =>
		pick({ activeOrgId: "org-1" }),
}));
vi.mock("sonner", () => ({
	toast: {
		error: (...a: unknown[]) => toastError(...a),
		success: (...a: unknown[]) => toastSuccess(...a),
	},
}));

import { ProviderSheet } from "@/components/settings/sso/provider-sheet";

const PROVIDER = {
	id: "sp-1",
	providerId: "okta",
	domain: "acme.com",
	issuer: "https://acme.okta.com",
	type: "oidc" as const,
	domainVerified: false,
	ssoUrl: null,
	certFingerprint: null,
	clientId: "abc",
};

beforeEach(() => {
	vi.clearAllMocks();
});

describe("ProviderSheet — a refused save", () => {
	it("renders the plugin's sentence in the form and keeps the form open", async () => {
		updateSsoProvider.mockResolvedValue({ ok: false, error: "issuer must be a valid URL" });
		const onOpenChange = vi.fn();
		const onSaved = vi.fn();
		const user = userEvent.setup();
		render(
			<ProviderSheet
				open
				onOpenChange={onOpenChange}
				provider={PROVIDER}
				canManage
				onSaved={onSaved}
			/>,
		);

		await user.click(screen.getByRole("button", { name: "Save changes" }));

		expect(await screen.findByRole("alert")).toHaveTextContent("issuer must be a valid URL");
		expect(updateSsoProvider).toHaveBeenCalledWith("sp-1", expect.any(Object));
		expect(toastSuccess).not.toHaveBeenCalled();
		expect(toastError).not.toHaveBeenCalled();
		expect(onSaved).not.toHaveBeenCalled();
		expect(onOpenChange).not.toHaveBeenCalledWith(false);
	});

	it("closes and confirms when the save goes through", async () => {
		updateSsoProvider.mockResolvedValue({ ok: true });
		const onOpenChange = vi.fn();
		const user = userEvent.setup();
		render(
			<ProviderSheet
				open
				onOpenChange={onOpenChange}
				provider={PROVIDER}
				canManage
				onSaved={vi.fn()}
			/>,
		);

		await user.click(screen.getByRole("button", { name: "Save changes" }));

		await vi.waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
		expect(toastSuccess).toHaveBeenCalledWith("Provider updated");
		expect(screen.queryByRole("alert")).toBeNull();
	});
});
