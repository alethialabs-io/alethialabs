// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The Billing page's Transaction history on the list standard (LST-11 #7493). It used to read the
// newest 24 Stripe charges and page them ten at a time in the browser, so charge 25 onwards was
// unreachable. Now `billing.transactions` answers keyset pages over Stripe's own cursor and the
// table walks them with the shared footer. Drives the real component and `useKeysetList` over the
// real oRPC TanStack utils; only the read is faked.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { KeysetListPage } from "@/lib/queries/keyset";
import type { TransactionInfo } from "@/lib/rpc/procedures/billing";

vi.mock("@/lib/rpc/client", async () => ({ orpc: (await import("../billing-rpc-fake")).fakeOrpc }));

import { TransactionsTable } from "@/components/settings/billing/transactions-table";
import { failed, reads, refused, resetReads } from "../billing-rpc-fake";

/** One paid charge described as `Charge <n>`. */
function charge(n: number): TransactionInfo {
	return {
		id: `ch_${n}`,
		description: `Charge ${n}`,
		status: "paid",
		amount: 2000,
		currency: "usd",
		created: new Date(Date.UTC(2026, 0, n)).toISOString(),
		method: "visa ···· 4242",
	};
}

/** A first page (with `universeEmpty`) or a later one. */
function page(rows: TransactionInfo[], nextCursor: string | null, first = true): KeysetListPage<TransactionInfo, null> {
	return { rows, nextCursor, facets: null, universeEmpty: first ? rows.length === 0 : null };
}

/** The cursor a read was asked for, if any. */
function cursorOf(input: unknown): unknown {
	return typeof input === "object" && input !== null && "cursor" in input ? input.cursor : undefined;
}

/** Renders the section under a fresh client (no retry delay: a real failure retries once). */
function renderTable() {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0 } } });
	return render(
		<QueryClientProvider client={qc}>
			<TransactionsTable />
		</QueryClientProvider>,
	);
}

beforeEach(() => {
	resetReads();
});

describe("TransactionsTable reaches every charge (#7493)", () => {
	it("walks past the first page with Load more, and stops at the last", async () => {
		// Fifty newest charges on page one — more than the 24 the old read could ever show.
		const first = Array.from({ length: 50 }, (_, i) => charge(60 - i));
		reads.transactions.mockImplementation(async (input) => {
			const cursor = cursorOf(input);
			if (cursor === undefined) return page(first, "after-ch_11");
			if (cursor === "after-ch_11") return page([charge(10), charge(9)], null, false);
			throw new Error(`unexpected cursor ${String(cursor)}`);
		});
		renderTable();
		await screen.findByText("Charge 60");
		expect(screen.getByText("Charge 11")).toBeInTheDocument();
		// No client pages: all fifty rows are on screen at once.
		expect(screen.queryByRole("button", { name: /next page/i })).toBeNull();

		fireEvent.click(screen.getByRole("button", { name: "Load more" }));
		await screen.findByText("Charge 9");
		expect(cursorOf(reads.transactions.mock.calls[1]?.[0])).toBe("after-ch_11");
		expect(screen.getByText("Charge 60")).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
	});

	it("a failed later page keeps the charges and offers a retry", async () => {
		reads.transactions.mockImplementation(async (input) => {
			if (cursorOf(input) === undefined) return page([charge(2)], "c-1");
			throw failed();
		});
		renderTable();
		await screen.findByText("Charge 2");
		fireEvent.click(screen.getByRole("button", { name: "Load more" }));
		expect(await screen.findByText("Couldn't load more", undefined, { timeout: 4000 })).toBeInTheDocument();
		expect(screen.getByText("Charge 2")).toBeInTheDocument();
	});

	it("an org with no charges says so", async () => {
		reads.transactions.mockResolvedValue(page([], null));
		renderTable();
		expect(await screen.findByText("No transactions yet.")).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
	});

	it("a failed first page is an error with a retry, never 'No transactions yet'", async () => {
		reads.transactions.mockRejectedValue(failed());
		renderTable();
		expect(await screen.findByRole("button", { name: "Try again" }, { timeout: 4000 })).toBeInTheDocument();
		expect(screen.queryByText("No transactions yet.")).toBeNull();
	});

	it("a refused read is the refusal, not an error", async () => {
		reads.transactions.mockRejectedValue(refused("FORBIDDEN"));
		renderTable();
		expect(await screen.findByText("Billing admins only")).toBeInTheDocument();
	});
});
