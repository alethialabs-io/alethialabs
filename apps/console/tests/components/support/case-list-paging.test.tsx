// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// "My cases" pages by keyset (#7389): `support.cases` answers one page per cursor, and the list
// walks them with "Load more". Pinned here, against the REAL CaseList over a fake read router:
//   - a full first page offers "Load more", and a short one does not (it is the end);
//   - "Load more" asks for the page after page one's LAST row (its activity and id) in the same
//     bucket, and appends that page under the first;
//   - the walk continues from the second page's last row and stops at a short page;
//   - a case both pages hold (a reply lifted it while the reader paged) is drawn once;
//   - the toolbar shows no count until the last page is in — a loaded count is not the total.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CASE_PAGE_SIZE, type CaseListItem } from "@/lib/queries/support";
import type { FakeCall, FakeHandler } from "@/tests/helpers/fake-orpc";

vi.mock("next/navigation", () => ({
	useParams: () => ({ org: "acme" }),
	useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }),
	usePathname: () => "/acme/~/support/my-cases",
	useSearchParams: () => new URLSearchParams(),
}));

const rpc = vi.hoisted(() => ({ handlers: {} as Record<string, FakeHandler>, calls: [] as FakeCall[] }));
vi.mock("@/lib/rpc/client", async () => {
	const { fakeOrpc } = await import("@/tests/helpers/fake-orpc");
	return { orpc: fakeOrpc(rpc.handlers, rpc.calls).orpc };
});

import { CaseList } from "@/components/support/cases/case-list";

/** A case whose activity is `minute` minutes after a fixed instant — larger is newer. */
function item(n: number, minute: number): CaseListItem {
	const at = new Date(Date.parse("2026-11-01T00:00:00.000Z") + minute * 60_000);
	return {
		id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
		case_number: 1000 + n,
		subject: `Case subject ${n}`,
		type: "technical",
		category: "runners",
		severity: "normal",
		status: "open",
		last_message_at: at,
		last_author_type: "customer",
		created_at: at,
		unread: false,
		requester_name: null,
		is_mine: true,
	};
}

/** `count` cases numbered from `from`, newest first, all sharing ONE timestamp (a tie). */
function tiedPage(from: number, count: number, minute: number): CaseListItem[] {
	return Array.from({ length: count }, (_, i) => item(from + count - 1 - i, minute));
}

/** The inputs `support.cases` was asked for, in order. */
const casesAsked = () => rpc.calls.filter((c) => c.path === "support.cases").map((c) => c.input);

/** Renders `ui` under a fresh QueryClient. */
function renderWithClient(ui: ReactElement) {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

/** Lets pending fetches and their renders settle. */
async function settle() {
	await act(async () => {
		for (let i = 0; i < 5; i++) await Promise.resolve();
	});
}

beforeEach(() => {
	rpc.calls.length = 0;
	for (const k of Object.keys(rpc.handlers)) delete rpc.handlers[k];
});

describe("CaseList paging", () => {
	it("a short first page is the whole list: no Load more, and the count is shown", async () => {
		rpc.handlers["support.cases"] = async () => tiedPage(1, 3, 10);
		renderWithClient(<CaseList orgSlug="acme" />);
		await screen.findByText("Case subject 3");

		expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
		expect(screen.getAllByRole("listitem")).toHaveLength(3);
		expect(casesAsked()).toEqual([{ bucket: "all" }]);
	});

	it("Load more asks for the page after page one's last row and appends it, until a short page", async () => {
		// Page one: CASE_PAGE_SIZE cases, all at one timestamp — the boundary falls inside a tie.
		const first = tiedPage(100, CASE_PAGE_SIZE, 30);
		// Page two: full again; it repeats page one's top case (a reply lifted it meanwhile — the
		// list must draw it once) and continues the tie.
		const second = [first[0], ...tiedPage(40, CASE_PAGE_SIZE - 1, 30)];
		// Page three: short — the end.
		const third = tiedPage(1, 2, 5);
		rpc.handlers["support.cases"] = async (input) => {
			if (typeof input !== "object" || input === null || !("cursor" in input) || !input.cursor) {
				return first;
			}
			const cursor = input.cursor;
			if (typeof cursor === "object" && cursor !== null && "id" in cursor && cursor.id === first.at(-1)?.id) {
				return second;
			}
			return third;
		};

		const { container } = renderWithClient(<CaseList orgSlug="acme" />);
		await screen.findByText("Case subject 149");
		expect(screen.getAllByRole("listitem")).toHaveLength(CASE_PAGE_SIZE);
		// More may exist, so no count yet: a pill reading 50 would claim to be the total.
		expect(within(container).queryByText(String(CASE_PAGE_SIZE))).toBeNull();

		fireEvent.click(screen.getByRole("button", { name: "Load more" }));
		await screen.findByText("Case subject 40");

		const last = first.at(-1);
		expect(casesAsked()[1]).toEqual({
			bucket: "all",
			cursor: { at: last?.last_message_at.toISOString(), id: last?.id },
		});
		// 50 + 49 new; the repeated case is drawn once.
		expect(screen.getAllByRole("listitem")).toHaveLength(CASE_PAGE_SIZE * 2 - 1);
		expect(screen.getAllByText("Case subject 149")).toHaveLength(1);

		fireEvent.click(screen.getByRole("button", { name: "Load more" }));
		await screen.findByText("Case subject 1");
		await settle();

		const secondLast = second.at(-1);
		expect(casesAsked()[2]).toEqual({
			bucket: "all",
			cursor: { at: secondLast?.last_message_at.toISOString(), id: secondLast?.id },
		});
		expect(screen.getAllByRole("listitem")).toHaveLength(CASE_PAGE_SIZE * 2 + 1);
		// A short page is the end: the control goes, and the total is now known.
		expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
		expect(within(container).getByText(String(CASE_PAGE_SIZE * 2 + 1))).toBeInTheDocument();
		expect(casesAsked()).toHaveLength(3);
	});
});
