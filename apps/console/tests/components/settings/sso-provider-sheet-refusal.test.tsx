// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #5445 — the SSO provider form shows the identity-provider plugin's refusal IN THE FORM.
//
// An edit used to call `updateSsoProvider`, which THREW the plugin's sentence out of a server action
// (a digest in a production build), and the sheet toasted whatever arrived. The action answers an
// `ActionResult` now (#6129): the plugin's sentence is a `conflict` refusal, which the sheet takes
// over from the toast (`onRefusal`) and renders beside the values it is about, keeping the form
// open. #6129 also makes the sheet track dirty state: an edit with nothing changed cannot be saved.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render as rtlRender, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const updateSsoProvider = vi.fn();
const toastError = vi.fn();
const toastSuccess = vi.fn();

vi.mock("@/app/server/actions/sso", () => ({
	updateSsoProvider: (...a: unknown[]) => updateSsoProvider(...a),
}));
vi.mock("@/lib/rpc/client", () => ({ orpc: { sso: { key: () => [["sso"]] } } }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));
vi.mock("sonner", () => ({
	toast: {
		error: (...a: unknown[]) => toastError(...a),
		success: (...a: unknown[]) => toastSuccess(...a),
	},
}));

import { ProviderSheet } from "@/components/settings/sso/provider-sheet";

const PROVIDER = {
	id: "5f0c1f3a-2b1e-4c6d-9a8b-7c6d5e4f3a2b",
	providerId: "okta",
	domain: "acme.com",
	issuer: "https://acme.okta.com",
	type: "oidc" as const,
	domainVerified: false,
	ssoUrl: null,
	certFingerprint: null,
	clientId: "abc",
};

/** Renders under a fresh QueryClient, which the mutation contract reads. */
function render(ui: ReactElement) {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return rtlRender(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

/** Opens the Identity provider section and changes the issuer, so the edit has something to save. */
async function editIssuer(user: ReturnType<typeof userEvent.setup>, value: string) {
	await user.click(screen.getByRole("button", { name: /Identity provider/i }));
	const issuer = await screen.findByLabelText("Issuer URL");
	await user.clear(issuer);
	await user.type(issuer, value);
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("ProviderSheet — a refused save", () => {
	it("cannot save an edit that changes nothing", () => {
		render(<ProviderSheet open onOpenChange={vi.fn()} provider={PROVIDER} canManage orgId="org-1" />);
		expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
	});

	it("renders the plugin's sentence in the form and keeps the form open", async () => {
		updateSsoProvider.mockResolvedValue({
			ok: false,
			error: { kind: "conflict", message: "issuer must be a valid URL" },
		});
		const onOpenChange = vi.fn();
		const user = userEvent.setup();
		render(<ProviderSheet open onOpenChange={onOpenChange} provider={PROVIDER} canManage orgId="org-1" />);

		await editIssuer(user, "https://acme.okta.com/oauth2");
		await user.click(screen.getByRole("button", { name: "Save changes" }));

		expect(await screen.findByRole("alert")).toHaveTextContent("issuer must be a valid URL");
		expect(updateSsoProvider).toHaveBeenCalledWith(
			expect.objectContaining({ id: PROVIDER.id, issuer: "https://acme.okta.com/oauth2" }),
		);
		// An untouched optional field (the secret, the SAML fields, a blank mapping) is OMITTED, never
		// sent as "" — the action refuses an empty string, and an omitted secret keeps the stored one.
		const sent: unknown = updateSsoProvider.mock.calls[0]?.[0];
		expect(Object.values(Object(sent))).not.toContain("");
		expect(sent).toMatchObject({ clientSecret: undefined, cert: undefined, entryPoint: undefined, mapping: undefined });
		expect(toastSuccess).not.toHaveBeenCalled();
		expect(toastError).not.toHaveBeenCalled();
		expect(onOpenChange).not.toHaveBeenCalledWith(false);
	});

	it("closes and confirms when the save goes through", async () => {
		updateSsoProvider.mockResolvedValue({ ok: true, data: { updated: true } });
		const onOpenChange = vi.fn();
		const user = userEvent.setup();
		render(<ProviderSheet open onOpenChange={onOpenChange} provider={PROVIDER} canManage orgId="org-1" />);

		await editIssuer(user, "https://acme.okta.com/oauth2");
		await user.click(screen.getByRole("button", { name: "Save changes" }));

		await vi.waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
		expect(toastSuccess).toHaveBeenCalledWith("Provider updated");
		expect(screen.queryByRole("alert")).toBeNull();
	});
});
