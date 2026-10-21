// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Resolving a case refreshes the bell as well as the case lists (#6114).
//
// The notifications bell reads the shell's case feed under its own key (`workspace.supportCases`),
// no longer under the lists' `["support","cases"]` prefix, so a lifecycle action that invalidated
// only the prefix left the bell showing the old state until its next poll. The dropdown is replaced
// by plain buttons (its menu renders through a portal jsdom cannot lay out); the mutation, the
// QueryClient and the keys are real.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@repo/ui/dropdown-menu", () => ({
	DropdownMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
	DropdownMenuTrigger: () => null,
	DropdownMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
	DropdownMenuItem: ({ children, onSelect }: { children: ReactNode; onSelect: () => void }) => (
		<button type="button" onClick={onSelect}>
			{children}
		</button>
	),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/app/server/actions/support", () => ({
	resolveCase: vi.fn(async ({ id }: { id: string }) => ({ ok: true, data: { id } })),
	reopenCase: vi.fn(async ({ id }: { id: string }) => ({ ok: true, data: { id } })),
	closeCase: vi.fn(async ({ id }: { id: string }) => ({ ok: true, data: { id } })),
}));

import { CaseActions } from "@/components/support/cases/case-actions";
import { orpc } from "@/lib/rpc/client";

const CASE = "11111111-1111-4111-8111-111111111111";

describe("case actions refresh the bell (#6114)", () => {
	it("invalidates the bell's case feed, every case list and the case itself (#6130)", async () => {
		const client = new QueryClient();
		const bell = orpc.workspace.supportCases.queryOptions().queryKey;
		const list = orpc.support.cases.queryOptions({ input: { bucket: "active" } }).queryKey;
		const detail = orpc.support.case.queryOptions({ input: { id: CASE } }).queryKey;
		client.setQueryData(bell, []);
		client.setQueryData(list, []);
		client.getQueryCache().build(client, { queryKey: detail });
		render(
			<QueryClientProvider client={client}>
				<CaseActions caseId={CASE} status="open" />
			</QueryClientProvider>,
		);
		fireEvent.click(screen.getByRole("button", { name: /mark resolved/i }));
		await waitFor(() => expect(client.getQueryState(bell)?.isInvalidated).toBe(true));
		expect(client.getQueryState(list)?.isInvalidated).toBe(true);
		expect(client.getQueryState(detail)?.isInvalidated).toBe(true);
	});
});
