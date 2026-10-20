// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The account dialog asks for the linked providers once, and only when OPENED (F003, #6114).
//
// The shell mounts this dialog up to three times (sidebar, mobile drawer, icon rail), closed, and
// each copy used to call better-auth's `listAccounts` on mount — three `/list-accounts` requests on
// every page load for badges nobody had looked at. Real dialog, real QueryClient; better-auth's
// client is the mock.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Viewer } from "@/lib/auth/viewer";

const { listAccounts } = vi.hoisted(() => ({ listAccounts: vi.fn() }));
vi.mock("@/lib/auth/client", () => ({
	authClient: { listAccounts, updateUser: vi.fn() },
	liveSession: { subscribe: () => () => {}, get: () => ({ data: null, isPending: true, error: null }), onPossibleChange: () => () => {} },
}));
vi.mock("@/app/server/actions/privacy/self-serve", () => ({ requestMyErasure: vi.fn() }));

import { ViewerProvider } from "@/components/providers/viewer-provider";
import { AccountSettingsDialog } from "@/components/shell/account-settings-dialog";

const ADA: Viewer = {
	id: "u-ada",
	name: "Ada Lovelace",
	email: "ada@acme.test",
	image: null,
	createdAt: new Date("2026-01-15T09:00:00.000Z"),
};

/** Three closed dialogs, as the shell mounts them, plus whichever one is `open`. */
function Shell({
	client,
	open,
	viewer = ADA,
}: {
	client: QueryClient;
	open: boolean;
	viewer?: Viewer;
}): ReactNode {
	return (
		<QueryClientProvider client={client}>
			<ViewerProvider viewer={viewer}>
				<AccountSettingsDialog open={open} onOpenChange={() => {}} />
				<AccountSettingsDialog open={false} onOpenChange={() => {}} />
				<AccountSettingsDialog open={false} onOpenChange={() => {}} />
			</ViewerProvider>
		</QueryClientProvider>
	);
}

beforeEach(() => {
	listAccounts.mockReset();
	listAccounts.mockResolvedValue({ data: [{ providerId: "github" }], error: null });
});

describe("the account dialog's linked providers (F003)", () => {
	it("asks for nothing while every copy is closed", async () => {
		await act(async () => {
			render(<Shell client={new QueryClient()} open={false} />);
		});
		expect(listAccounts).not.toHaveBeenCalled();
	});

	it("asks once when opened, and not again on a second open", async () => {
		const client = new QueryClient();
		const { rerender } = render(<Shell client={client} open={false} />);
		await act(async () => rerender(<Shell client={client} open />));
		expect(await screen.findByText("GitHub")).toBeInTheDocument();
		await act(async () => rerender(<Shell client={client} open={false} />));
		await act(async () => rerender(<Shell client={client} open />));
		expect(listAccounts).toHaveBeenCalledTimes(1);
	});

	it("is kept per person: someone else signed in to the tab gets their own answer", async () => {
		const client = new QueryClient();
		const { rerender } = render(<Shell client={client} open />);
		await screen.findByText("GitHub");
		await act(async () => rerender(<Shell client={client} open viewer={{ ...ADA, id: "u-grace" }} />));
		expect(listAccounts).toHaveBeenCalledTimes(2);
	});
});
