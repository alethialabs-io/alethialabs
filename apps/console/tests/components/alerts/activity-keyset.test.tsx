// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The delivery ledger as a KEYSET list (lib/query/README.md → "Paging"; epic #7481, LST-7 #7489),
// driven end to end through the real `useActivityView` → `useKeysetList` → `ActivityPanel` →
// `<DataTable keyset>` → `ListFooter`, over a fake `alerts.deliveries` that pages a 260-row ledger by
// an opaque cursor.
//
// The ledger used to answer the newest 50 (at most 200) deliveries, client-paged 20 at a time, with
// "Showing the newest N of M" in place of any way to reach an older one. What is asserted here is the
// opposite of each part of that: every delivery past the old window is reachable; the cursor is the
// page param and never part of a filter's request; a filter change and a Reset each restart the walk
// at page one; a failed later page keeps its rows and says so with a retry; the end says nothing;
// and no count of any kind renders.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DeliveryDTO } from "@/app/server/actions/alerts";
import type { FakeCall, FakeHandler } from "@/tests/helpers/fake-orpc";

const h = vi.hoisted(() => ({ handlers: {} as Record<string, FakeHandler>, calls: [] as FakeCall[] }));
vi.mock("@/lib/rpc/client", async () => {
	const { fakeOrpc } = await import("@/tests/helpers/fake-orpc");
	return { orpc: fakeOrpc(h.handlers, h.calls).orpc };
});
vi.mock("next/navigation", () => ({
	useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
	usePathname: () => "/acme/~/alerts",
	useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/query/use-classification-query", () => ({
	useAssignmentsForKind: () => ({ data: {} }),
	useAssignmentsQuery: () => ({ data: [], isLoading: false }),
	useDimensionsQuery: () => ({ data: [], isLoading: false }),
	useCanEditClassification: () => ({ data: false }),
	useAssignmentMutations: () => ({ assign: vi.fn(), unassign: vi.fn() }),
}));

import { ActivityPanel } from "@/components/alerts/activity-panel";
import { useActivityView } from "@/components/alerts/activity-view";
import { useAlertActivityFilters } from "@/lib/stores/use-alerts-filters";

/** The page size the procedure answers with when the client names none (`keysetPageInput()`). */
const PAGE = 50;

/** A ledger of `n` deliveries, newest first; every third one failed. */
function ledger(n: number): DeliveryDTO[] {
	return Array.from({ length: n }, (_, i): DeliveryDTO => ({
		id: `d${i}`,
		event_key: "system.job.failed",
		title: `Delivery ${i}`,
		status: i % 3 === 0 ? "failed" : "sent",
		attempts: 1,
		last_error: null,
		created_at: "2026-11-01T12:00:00.000Z",
		sent_at: null,
	}));
}

/** The procedure's input as the hook sends it: the filter, plus the cursor on a later page. */
interface LedgerInput {
	status?: string[];
	search?: string;
	cursor?: string;
}

/** Narrows the fake's untyped input to what `alerts.deliveries` accepts. */
function asInput(input: unknown): LedgerInput {
	return typeof input === "object" && input !== null ? input : {};
}

/**
 * Answers `alerts.deliveries` over `rows` the way the builder does: filter, then the page strictly
 * after the cursor, with the next cursor when more remain and the facets on page one only. The
 * cursor is an opaque string to the client; here it happens to be an offset.
 */
function serveLedger(rows: DeliveryDTO[]): FakeHandler {
	return async (raw) => {
		const input = asInput(raw);
		const matching = input.status ? rows.filter((r) => input.status?.includes(r.status)) : rows;
		const start = input.cursor === undefined ? 0 : Number(input.cursor.replace("after:", ""));
		const page = matching.slice(start, start + PAGE);
		const next = start + PAGE < matching.length ? `after:${start + PAGE}` : null;
		const first = input.cursor === undefined;
		return {
			rows: page,
			nextCursor: next,
			facets: first ? { status: [{ value: "sent", label: null, count: rows.length }] } : null,
			universeEmpty: first ? rows.length === 0 : null,
		};
	};
}

/** Every `alerts.deliveries` request the hub made, in order. */
function ledgerRequests(): LedgerInput[] {
	return h.calls.filter((c) => c.path === "alerts.deliveries").map((c) => asInput(c.input));
}

/** The panel as the hub mounts it: the real view hook feeding the real panel. */
function Ledger() {
	return <ActivityPanel view={useActivityView()} />;
}

/** Renders the ledger over a fresh client (no retry delay, so a failed page answers at once). */
function renderLedger() {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0 } } });
	function Wrapper({ children }: { children: ReactNode }) {
		return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
	}
	return render(<Ledger />, { wrapper: Wrapper });
}

/** Clicks "Load more" and waits for the row that page brings in. */
async function loadMoreUntil(user: ReturnType<typeof userEvent.setup>, title: string) {
	await user.click(screen.getByRole("button", { name: "Load more" }));
	expect(await screen.findByText(title)).toBeInTheDocument();
}

beforeEach(() => {
	h.calls.length = 0;
	useAlertActivityFilters.getState().reset();
	h.handlers["alerts.deliveries"] = serveLedger(ledger(260));
});

describe("the delivery ledger pages by keyset", () => {
	it("reaches every delivery far past the old 50 / 200 window, and the end says nothing", async () => {
		const user = userEvent.setup();
		const { container } = renderLedger();
		expect(await screen.findByText("Delivery 0")).toBeInTheDocument();
		expect(screen.getByText("Delivery 49")).toBeInTheDocument();
		// Page one is every row the server sent — not 20 of them with page numbers under the table.
		expect(screen.queryByText("Delivery 50")).toBeNull();
		expect(container.querySelector('[data-slot="list-footer"]')).toHaveAttribute("data-state", "more");

		for (const title of ["Delivery 99", "Delivery 149", "Delivery 199", "Delivery 249", "Delivery 259"]) {
			await loadMoreUntil(user, title);
		}
		// Every row is on screen at once, each exactly once.
		expect(screen.getAllByText(/^Delivery \d+$/)).toHaveLength(260);
		// The end: no footer, no "That's all", no count.
		await waitFor(() => expect(container.querySelector('[data-slot="list-footer"]')).toBeNull());
		expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
		expect(container.textContent).not.toMatch(/Showing|\b260\b| of \d|total/);

		// Page one carried no cursor; each later page carried the cursor the previous one returned.
		expect(ledgerRequests()).toEqual([
			{},
			{ cursor: "after:50" },
			{ cursor: "after:100" },
			{ cursor: "after:150" },
			{ cursor: "after:200" },
			{ cursor: "after:250" },
		]);
	});

	it("a failed later page keeps every loaded row and offers a retry that continues the walk", async () => {
		const user = userEvent.setup();
		const serve = serveLedger(ledger(260));
		let failNext = true;
		h.handlers["alerts.deliveries"] = async (raw) => {
			if (asInput(raw).cursor !== undefined && failNext) throw new Error("boom");
			return serve(raw);
		};
		const { container } = renderLedger();
		expect(await screen.findByText("Delivery 49")).toBeInTheDocument();

		await user.click(screen.getByRole("button", { name: "Load more" }));
		expect(await screen.findByText("Couldn't load more")).toBeInTheDocument();
		expect(container.querySelector('[data-slot="list-footer"]')).toHaveAttribute("data-state", "failed");
		// The rows stay — a failed later page is not a failed list.
		expect(screen.getByText("Delivery 0")).toBeInTheDocument();
		expect(screen.getByText("Delivery 49")).toBeInTheDocument();
		expect(screen.queryByText("Couldn't load activity")).toBeNull();

		failNext = false;
		await user.click(screen.getByRole("button", { name: "Try again" }));
		expect(await screen.findByText("Delivery 99")).toBeInTheDocument();
		expect(screen.queryByText("Couldn't load more")).toBeNull();
	});

	it("a filter change restarts the walk at page one — the old walk's cursor never rides along", async () => {
		const user = userEvent.setup();
		renderLedger();
		expect(await screen.findByText("Delivery 49")).toBeInTheDocument();
		await loadMoreUntil(user, "Delivery 99");

		act(() => useAlertActivityFilters.getState().set("status", ["failed"]));
		// Delivery 3 is failed; on the failed-only walk it is on page one.
		await waitFor(() => expect(screen.queryByText("Delivery 1")).toBeNull());
		expect(screen.getByText("Delivery 3")).toBeInTheDocument();
		expect(ledgerRequests().at(-1)).toEqual({ status: ["failed"] });

		// And the next page of the NEW walk carries the new walk's cursor and the new filter.
		await loadMoreUntil(user, "Delivery 150");
		expect(ledgerRequests().at(-1)).toEqual({ status: ["failed"], cursor: "after:50" });
	});

	it("filtered empty offers Reset, and Reset asks the whole ledger again from page one", async () => {
		const user = userEvent.setup();
		h.handlers["alerts.deliveries"] = serveLedger(ledger(260).filter((r) => r.status === "sent"));
		renderLedger();
		expect(await screen.findByText("Delivery 1")).toBeInTheDocument();
		await loadMoreUntil(user, "Delivery 74");

		act(() => useAlertActivityFilters.getState().set("status", ["failed"]));
		expect(await screen.findByText("No activity matches")).toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: "Reset filters" }));

		expect(useAlertActivityFilters.getState().filters.status).toEqual([]);
		expect(await screen.findByText("Delivery 1")).toBeInTheDocument();
		// The filtered walk began without a cursor, and nothing after Reset reused one from it.
		expect(ledgerRequests().slice(0, 3)).toEqual([{}, { cursor: "after:50" }, { status: ["failed"] }]);
		expect(ledgerRequests().slice(3).every((r) => r.status === undefined)).toBe(true);
	});

	it("an org with no deliveries at all gets the first-run empty state, and no footer", async () => {
		h.handlers["alerts.deliveries"] = serveLedger([]);
		const { container } = renderLedger();
		expect(await screen.findByText("No activity yet")).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Reset filters" })).toBeNull();
		expect(container.querySelector('[data-slot="list-footer"]')).toBeNull();
	});
});
