// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// CON-PB2 (R6 E-09, E-21, E-23, E-24) on Settings · SSO: a viewer who may not change providers sees
// every write control disabled WITH the reason; the rail marks the provider the pane shows and that
// selection is URL state; and the remove confirmation names the provider it removes.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SsoBootstrap, SsoProviderRow } from "@/app/server/actions/sso";
import type { FakeCall, FakeHandler } from "@/tests/helpers/fake-orpc";

vi.mock("next/navigation", () => ({
	useParams: () => ({ org: "acme" }),
	useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }),
	usePathname: () => "/acme/~/settings/sso",
	// jsdom keeps `window.location` in step with `history.replaceState`, which Next's hook reads.
	useSearchParams: () => new URLSearchParams(window.location.search),
}));
const rpc = vi.hoisted(() => ({ handlers: {} as Record<string, FakeHandler>, calls: [] as FakeCall[] }));
vi.mock("@/lib/rpc/client", async () => {
	const { fakeOrpc } = await import("@/tests/helpers/fake-orpc");
	rpc.handlers["sso.bootstrap"] = () => new Promise(() => {});
	return { orpc: fakeOrpc(rpc.handlers, rpc.calls).orpc };
});
const providers = vi.hoisted((): { rows: SsoProviderRow[] } => ({ rows: [] }));
vi.mock("@/lib/query/use-sso-query", () => ({
	useSsoProvidersQuery: () => ({
		data: providers.rows,
		isFetching: false,
		isPlaceholderData: false,
		isPending: false,
		isError: false,
		error: null,
	}),
	ssoReadKeys: () => [],
}));
vi.mock("@/app/server/actions/sso", () => ({
	deleteSsoProvider: vi.fn(async () => ({ ok: true, data: { id: "" } })),
	requestSsoDomainVerification: vi.fn(),
	testSsoProvider: vi.fn(),
	verifySsoDomain: vi.fn(),
}));
vi.mock("@/components/settings/sso/provider-sheet", () => ({ ProviderSheet: () => null }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { MANAGE_DENIED_REASON } from "@/components/errors/manage-gate";
import { SsoManager } from "@/components/settings/sso/sso-manager";

/** One SAML provider. */
function provider(id: string, providerId: string): SsoProviderRow {
	return {
		id,
		providerId,
		domain: `${providerId}.example`,
		issuer: `https://${providerId}.example`,
		type: "saml",
		domainVerified: true,
		ssoUrl: null,
		certFingerprint: null,
		clientId: null,
	};
}

/** The bootstrap the route hands the page. */
function bootstrap(canManage: boolean): SsoBootstrap {
	return { sso: true, canManage, orgId: "org-acme", slug: "acme", origin: "https://console.example" };
}

/** The page under a fresh query client. */
function renderPage(canManage: boolean) {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={qc}>{children}</QueryClientProvider>
	);
	return render(<SsoManager bootstrap={bootstrap(canManage)} />, { wrapper });
}

beforeEach(() => {
	window.history.replaceState(null, "", "/acme/~/settings/sso");
	providers.rows = [provider("p1", "okta"), provider("p2", "entra")];
});

describe("SsoManager (CON-PB2)", () => {
	it("a viewer who may not manage sees the write controls disabled with the reason (E-09)", () => {
		renderPage(false);
		for (const name of [/connect provider/i, /test connection/i, "Edit provider", "Remove provider"]) {
			const control = screen.getByRole("button", { name });
			expect(control).toBeDisabled();
			expect(control).toHaveAccessibleDescription(MANAGE_DENIED_REASON);
		}
	});

	it("the rail marks the shown provider current, and a pick is written to the URL (E-23, E-24)", async () => {
		const { rerender } = renderPage(true);
		const okta = screen.getByRole("button", { name: /okta/ });
		expect(okta).toHaveAttribute("aria-current", "true");
		await userEvent.setup().click(screen.getByRole("button", { name: /entra/ }));
		expect(window.location.search).toBe("?selected=p2");
		rerender(<SsoManager bootstrap={bootstrap(true)} />);
		expect(screen.getByRole("button", { name: /entra/ })).toHaveAttribute("aria-current", "true");
		expect(screen.getByRole("button", { name: /okta/ })).not.toHaveAttribute("aria-current");
	});

	it("the remove confirmation names the provider (E-21)", async () => {
		renderPage(true);
		await userEvent.setup().click(screen.getByRole("button", { name: "Remove provider" }));
		const dialog = await screen.findByRole("alertdialog");
		expect(within(dialog).getByText("Remove identity provider “okta”?")).toBeInTheDocument();
	});
});
