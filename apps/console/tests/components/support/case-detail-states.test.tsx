// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The case view's renders (#6130): a CLOSED case shows a closed notice with the way to reopen it,
// never a dead composer (F045); an open case shows the composer; pending, not-found and a failed
// read are three different renders and none of them is an empty thread (RUBRIC B3/B4); and the read
// watermark is advanced by its own action once the case is on screen (a GET may not write).
//
// The read is the real `support.case` key in a real QueryClient. The classification control and the
// thread renderer are stubbed — they have their own suites, and the thread's markdown stack is not
// what is under test.

import { ORPCError } from "@orpc/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionResult } from "@/lib/actions/result";
import type { CaseWithThread } from "@/lib/queries/support";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));
const { toast } = vi.hoisted(() => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("sonner", () => ({ toast }));
const { markCaseRead } = vi.hoisted(() => ({
	markCaseRead: vi.fn(
		async ({ id }: { id: string }): Promise<ActionResult<{ id: string }>> => ({ ok: true, data: { id } }),
	),
}));
vi.mock("@/app/server/actions/support", () => ({
	markCaseRead,
	postCaseMessage: vi.fn(),
	resolveCase: vi.fn(),
	reopenCase: vi.fn(),
	closeCase: vi.fn(),
}));
const { classified } = vi.hoisted(() => ({ classified: vi.fn() }));
vi.mock("@/components/classification/classification-control", () => ({
	ClassificationControl: (props: { kind: string; id: string }) => {
		classified(props);
		return null;
	},
}));
vi.mock("@/components/support/cases/case-thread", () => ({
	CaseThread: ({ messages }: { messages: unknown[] }) => <div data-testid="thread">{messages.length} messages</div>,
}));

import { CaseDetail } from "@/components/support/cases/case-detail";
import { orpc } from "@/lib/rpc/client";

const CASE = "11111111-1111-4111-8111-111111111111";
const key = orpc.support.case.queryOptions({ input: { id: CASE } }).queryKey;

/** A case read in `status`, with one customer message. */
function caseRead(status: CaseWithThread["case"]["status"]): CaseWithThread {
	const at = new Date("2026-10-19T08:00:00.000Z");
	return {
		case: {
			id: CASE,
			case_number: 2,
			user_id: "user-1",
			org_id: "org-1",
			type: "technical",
			category: "other",
			severity: "normal",
			status,
			subject: "Runner cannot reach the registry",
			context: {},
			contact: { notifyEmail: "a@example.test", channel: "email" },
			abuse: null,
			assigned_staff_id: null,
			last_message_at: at,
			last_author_type: "customer",
			resolved_at: null,
			closed_at: status === "closed" ? at : null,
			created_at: at,
			updated_at: at,
		},
		messages: [
			{ id: "m1", case_id: CASE, author_type: "customer", author_id: null, author_name: null, body: "hi", created_at: at },
		],
		attachments: [],
	};
}

/** Renders the view over a client `seed` prepared; fetches never settle unless seeded. */
function renderView(seed: (qc: QueryClient) => void) {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false, staleTime: Infinity } } });
	seed(qc);
	render(
		<QueryClientProvider client={qc}>
			<CaseDetail caseId={CASE} orgSlug="acme" />
		</QueryClientProvider>,
	);
	return qc;
}

beforeEach(() => {
	vi.clearAllMocks();
	// Any read that is not seeded stays in flight.
	vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("CaseDetail — closed vs open (F045)", () => {
	it("a closed case shows the closed notice and its reopen button, and NO composer", () => {
		renderView((qc) => qc.setQueryData(key, caseRead("closed")));
		expect(screen.getByTestId("case-closed-notice")).toHaveTextContent("This case is closed");
		expect(screen.getByRole("button", { name: /reopen case/i })).toBeInTheDocument();
		expect(screen.queryByRole("textbox", { name: "Reply" })).toBeNull();
		expect(screen.queryByRole("button", { name: /^send$/i })).toBeNull();
	});

	it("an open case shows the composer and no closed notice", () => {
		renderView((qc) => qc.setQueryData(key, caseRead("open")));
		expect(screen.getByRole("textbox", { name: "Reply" })).toBeInTheDocument();
		expect(screen.queryByTestId("case-closed-notice")).toBeNull();
	});
});

describe("CaseDetail — pending, not-found and error are distinct (B3/B4)", () => {
	it("pending is the skeleton, never an empty thread", () => {
		renderView(() => {});
		expect(document.body.querySelector('[aria-busy="true"]')).not.toBeNull();
		expect(screen.queryByTestId("thread")).toBeNull();
	});

	it("a NOT_FOUND refusal reads as a missing case", () => {
		renderView((qc) =>
			qc.getQueryCache().build(qc, { queryKey: key }).setState({
				status: "error",
				error: new ORPCError("NOT_FOUND", { defined: true }),
				fetchStatus: "idle",
			}),
		);
		expect(screen.getByText("Case not found")).toBeInTheDocument();
		expect(screen.queryByText("Couldn't load this case")).toBeNull();
	});

	it("any other failure is an error with a retry, not a missing case", () => {
		renderView((qc) =>
			qc.getQueryCache().build(qc, { queryKey: key }).setState({
				status: "error",
				error: new Error("network"),
				fetchStatus: "idle",
			}),
		);
		expect(screen.getByText("Couldn't load this case")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /try again|retry/i })).toBeInTheDocument();
		expect(screen.queryByText("Case not found")).toBeNull();
	});
});

describe("CaseDetail — a failed REFRESH keeps the case (B4, #6336)", () => {
	it("a refetch that fails over data already on screen keeps the thread — no skeleton, no error page", () => {
		renderView((qc) => {
			qc.setQueryData(key, caseRead("open"));
			qc.getQueryCache().find({ queryKey: key })?.setState({ error: new Error("network"), status: "error", fetchStatus: "idle" });
		});
		expect(screen.getByTestId("thread")).toHaveTextContent("1 messages");
		expect(document.body.querySelector('[aria-busy="true"]')).toBeNull();
		expect(screen.queryByText("Couldn't load this case")).toBeNull();
	});
});

describe("CaseDetail — the classification row (#6336)", () => {
	it("classifies the case under the kind the route prefetches its chips for", () => {
		renderView((qc) => qc.setQueryData(key, caseRead("open")));
		// The route keys `classification.assignments` with `support_case` (tests/app/support-case-route).
		expect(classified).toHaveBeenCalledWith(expect.objectContaining({ kind: "support_case", id: CASE }));
	});
});

describe("CaseDetail — the read watermark", () => {
	it("is advanced by markCaseRead once the case is on screen", async () => {
		renderView((qc) => qc.setQueryData(key, caseRead("open")));
		await waitFor(() => expect(markCaseRead).toHaveBeenCalledWith({ id: CASE }));
	});

	it("fails SILENTLY: a refused watermark write shows no toast and leaves the case on screen", async () => {
		markCaseRead.mockResolvedValueOnce({ ok: false, error: { kind: "not-found", message: "gone" } });
		renderView((qc) => qc.setQueryData(key, caseRead("open")));
		await waitFor(() => expect(markCaseRead).toHaveBeenCalled());
		await new Promise((r) => setTimeout(r, 0));
		expect(toast.error).not.toHaveBeenCalled();
		expect(screen.getByRole("textbox", { name: "Reply" })).toBeInTheDocument();
	});
});
