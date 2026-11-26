// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// AGT-L2-U1 (#7501) — the approvals list, every state in spec §1.3: loading, a failed first page, a
// refusal, an org with no requests, nothing waiting (the default view, empty), no match, rows of every
// status, and the keyset footer's three states. No count anywhere. A row opens the decision sheet by
// writing `?selected=<id>`, and a deep link to a request the loaded pages do not hold opens the sheet
// without paging the list.
//
// `useKeysetList` is mocked at its seam so each state is set directly (the hook's own paging is
// tests/lib/query/use-keyset-list.test.tsx); the sheet's read is the oRPC client's, mocked below.

import { ORPCError } from "@orpc/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const page = vi.hoisted((): { current: Record<string, unknown>; input: Record<string, unknown> } => ({
	current: {},
	input: {},
}));
const nav = vi.hoisted(() => ({ search: "", replace: vi.fn() }));
const reads = vi.hoisted(() => ({ get: vi.fn() }));

vi.mock("@/lib/query/use-keyset-list", () => ({
	useKeysetList: (_procedure: unknown, input: Record<string, unknown>) => {
		page.input = input;
		return page.current;
	},
}));
vi.mock("next/navigation", () => ({
	useParams: () => ({ org: "acme" }),
	useRouter: () => ({ push: vi.fn(), replace: nav.replace }),
	usePathname: () => "/acme/~/approvals",
	useSearchParams: () => new URLSearchParams(nav.search),
}));
vi.mock("@/lib/rpc/client", () => ({
	orpc: {
		approvals: {
			key: () => ["approvals"],
			list: {},
			get: {
				queryOptions: ({ input }: { input: { id: string } }) => ({
					queryKey: ["approvals", "get", input.id],
					queryFn: () => reads.get(input.id),
				}),
			},
		},
		jobs: {
			planResult: {
				queryOptions: ({ input }: { input: { id: string } }) => ({
					queryKey: ["jobs", "planResult", input.id],
					queryFn: () => new Promise(() => undefined),
				}),
			},
		},
	},
}));
vi.mock("@/app/server/actions/approvals", () => ({ decideApplyApproval: vi.fn() }));
vi.mock("@/components/providers/viewer-provider", () => ({ useViewer: () => ({ viewer: { id: "me" }, isPending: false }) }));

import { ApprovalsList } from "@/components/approvals/approvals-list";
import { DEFAULT_APPROVALS_FILTERS } from "@/components/approvals/approvals-query";
import { useApprovalsFilters } from "@/lib/stores/use-approvals-filters";

const FACETS = {
	status: [
		{ value: "pending", label: null, count: 2 },
		{ value: "approved", label: null, count: 1 },
	],
	operation: [{ value: "deploy", label: null, count: 3 }],
	credential: [{ value: "agent_oauth", label: null, count: 3 }],
	environment: [],
};

/** A list row; `over` replaces fields. */
function row(over: Record<string, unknown> = {}) {
	return {
		id: "11111111-1111-4111-8111-111111111111",
		status: "pending",
		operation: "deploy",
		project_id: "p1",
		project_name: "payments-api",
		environment_id: "e1",
		environment_name: "staging",
		environment_stage: "staging",
		plan_job_id: "22222222-2222-4222-8222-222222222222",
		digest_prefix: "9f3c1a7e",
		requester_user_id: "u-dana",
		requester_name: "Dana Petrova",
		requester_credential: "agent_oauth",
		requester_credential_name: "Claude Code",
		requester_credential_ref: "https://claude.ai/code/oauth",
		requester_credential_icon: null,
		created_at: new Date(Date.now() - 8 * 60_000).toISOString(),
		expires_at: new Date(Date.now() + 52 * 60_000).toISOString(),
		decided_at: null,
		approver_user_id: null,
		approver_name: null,
		consumed_job_id: null,
		...over,
	};
}

/** A `useKeysetList` result: settled, nothing loaded, no further page, unless told otherwise. */
function list(state: Record<string, unknown> = {}, first: Record<string, unknown> = {}) {
	return {
		rows: [],
		facets: null,
		universeEmpty: null,
		isPending: false,
		isPlaceholderData: false,
		hasMore: false,
		loadingMore: false,
		loadMoreFailed: false,
		loadMore: vi.fn(),
		...state,
		query: { isLoading: false, isError: false, data: undefined, error: null, refetch: vi.fn(), ...first },
	};
}

/** A landed first page of `rows`; `universeEmpty` says whether the org holds any request at all. */
function answered(rows: unknown[], extra: Record<string, unknown> = {}) {
	return list({ rows, facets: FACETS, universeEmpty: false, ...extra }, { data: { pages: [{ rows }] } });
}

/** Renders the list under a fresh query client. */
function renderList(): ReturnType<typeof render> {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0 } } });
	const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
	return render(<ApprovalsList />, { wrapper });
}

beforeEach(() => {
	page.current = list({ isPending: true }, { isLoading: true });
	page.input = {};
	nav.search = "";
	nav.replace.mockReset();
	reads.get.mockReset();
	useApprovalsFilters.setState({ filters: DEFAULT_APPROVALS_FILTERS });
});

describe("the approvals list's states", () => {
	it("opens on Waiting: the default query asks for pending requests only", () => {
		page.current = answered([row()]);
		renderList();
		expect(page.input).toEqual({ status: ["pending"] });
	});

	it("loading: busy, and neither an empty state nor 'No results.'", () => {
		const { container } = renderList();
		expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
		expect(screen.queryByText("No approval requests yet")).toBeNull();
		expect(screen.queryByText("No results.")).toBeNull();
	});

	it("error: a failed first page is a region error with a retry, never an empty org", () => {
		const refetch = vi.fn();
		page.current = list({}, { isError: true, error: new Error("network"), refetch });
		renderList();
		expect(screen.getByRole("alert")).toHaveTextContent("Couldn't load approvals");
		expect(screen.getByText(/nothing was decided/i)).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Try again" }));
		expect(refetch).toHaveBeenCalled();
		expect(screen.queryByText("No approval requests yet")).toBeNull();
	});

	it("a refusal renders as a refusal, with no retry", () => {
		page.current = list({}, { isError: true, error: new ORPCError("FORBIDDEN", { defined: true }) });
		const { container } = renderList();
		expect(container.querySelector('[data-state="refused"]')).not.toBeNull();
		expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
	});

	it("empty org: the first-run state names who asks and how to connect an agent", () => {
		page.current = list({ rows: [], facets: FACETS, universeEmpty: true }, { data: { pages: [{ rows: [] }] } });
		renderList();
		expect(screen.getByText("No approval requests yet")).toBeInTheDocument();
		expect(
			screen.getByText(
				"When an agent, the Alethia CLI or a service token asks to deploy or destroy, the request waits here for a person.",
			),
		).toBeInTheDocument();
		expect(screen.getByRole("link", { name: "Connect an agent" })).toHaveAttribute("href", "/acme/~/settings/connected");
		expect(screen.getByText("alethia agent setup")).toBeInTheDocument();
	});

	it("nothing waiting: the default view, empty, offers every request instead of a dead 'Clear filters'", () => {
		page.current = answered([]);
		renderList();
		expect(screen.getByText("Nothing is waiting for a decision")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Show all requests" }));
		expect(useApprovalsFilters.getState().filters.status).toEqual([]);
	});

	it("no match: filters that exclude everything say so, and Clear filters clears the status too", () => {
		// The link is the store's only memory: the filter arrives in the URL, as a shared link would.
		nav.search = "operation=destroy";
		page.current = answered([]);
		renderList();
		expect(screen.getByText("No requests match these filters")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
		const { filters } = useApprovalsFilters.getState();
		expect(filters.status).toEqual([]);
		expect(filters.operation).toEqual([]);
	});
});

describe("rows", () => {
	const ROWS = [
		row({ id: "a0000000-0000-4000-8000-000000000001" }),
		row({
			id: "a0000000-0000-4000-8000-000000000002",
			status: "approved",
			approver_user_id: "u-ivan",
			approver_name: "Ivan Georgiev",
			requester_credential: "service_token",
			requester_credential_name: "ci-deploy",
		}),
		row({ id: "a0000000-0000-4000-8000-000000000003", status: "rejected", approver_name: "Dana Petrova", approver_user_id: "u-dana" }),
		row({ id: "a0000000-0000-4000-8000-000000000004", status: "expired" }),
		row({ id: "a0000000-0000-4000-8000-000000000005", status: "superseded" }),
		row({
			id: "a0000000-0000-4000-8000-000000000006",
			status: "consumed",
			approver_name: "Dana Petrova",
			consumed_job_id: "5c7d2e81-0000-4000-8000-000000000000",
		}),
		row({
			id: "a0000000-0000-4000-8000-000000000007",
			operation: "destroy",
			environment_name: "production",
			environment_stage: "production",
			requester_credential: "cli_session",
			requester_credential_name: null,
		}),
	];

	it("every status reads in the sheet's words, with how a decided request ended", () => {
		page.current = answered(ROWS);
		renderList();
		const table = screen.getByRole("table");
		for (const label of ["Waiting", "Approved", "Denied", "Expired", "Replaced", "Used"]) {
			expect(within(table).getAllByText(label).length).toBeGreaterThan(0);
		}
		expect(within(table).getByText("Ivan Georgiev")).toBeInTheDocument();
		expect(within(table).getByText("Denied by")).toBeInTheDocument();
		expect(within(table).getByText("without a decision")).toBeInTheDocument();
		expect(within(table).getByText("a newer plan")).toBeInTheDocument();
		expect(within(table).getByText("5c7d2e81")).toBeInTheDocument();
		expect(within(table).getAllByText(/^Expires in/).length).toBeGreaterThan(0);
	});

	it("names what asked — never the credential enum — and marks Destroy and Production", () => {
		page.current = answered(ROWS);
		renderList();
		const table = screen.getByRole("table");
		expect(within(table).getAllByText("Claude Code").length).toBeGreaterThan(0);
		expect(within(table).getByText("ci-deploy")).toBeInTheDocument();
		expect(within(table).getByText("Alethia CLI")).toBeInTheDocument();
		expect(within(table).queryByText("agent_oauth")).toBeNull();
		// The connected agent wears its brand mark; the token and the CLI a neutral glyph.
		expect(table.querySelectorAll('[data-mark="claudecode"]').length).toBeGreaterThan(0);
		expect(table.querySelectorAll('[data-mark="credential"]')).toHaveLength(2);
		expect(within(table).getByText("Production")).toBeInTheDocument();
		expect(table.querySelector('[data-operation="destroy"]')).not.toBeNull();
	});

	it("carries no count: no pill, no 'N of M', no 'Showing'", () => {
		page.current = answered(ROWS, { hasMore: true });
		const { container } = renderList();
		expect(container.querySelector('[data-slot="count-pill"]')).toBeNull();
		expect(container.textContent).not.toMatch(/\d+\s+of\s+\d+/);
		expect(container.textContent).not.toMatch(/showing/i);
	});

	it("a row click opens the decision sheet by writing ?selected=<id>", () => {
		page.current = answered(ROWS);
		renderList();
		fireEvent.click(within(screen.getByRole("table")).getByText("ci-deploy"));
		expect(nav.replace).toHaveBeenCalledWith(
			"/acme/~/approvals?selected=a0000000-0000-4000-8000-000000000002",
			{ scroll: false },
		);
	});

	it("the phone list opens the same sheet from a labelled button per request", () => {
		page.current = answered(ROWS);
		renderList();
		const phone = screen.getByRole("list", { name: "Approval requests" });
		fireEvent.click(within(phone).getByRole("button", { name: "Open Destroy · payments-api / production" }));
		expect(nav.replace).toHaveBeenCalledWith(
			"/acme/~/approvals?selected=a0000000-0000-4000-8000-000000000007",
			{ scroll: false },
		);
	});
});

describe("paging", () => {
	it("more to load: a visible Load more asks for the next page", () => {
		const loadMore = vi.fn();
		page.current = answered([row()], { hasMore: true, loadMore });
		renderList();
		fireEvent.click(screen.getAllByRole("button", { name: "Load more" })[0]!);
		expect(loadMore).toHaveBeenCalled();
	});

	it("loading more: the button stays, disabled and busy", () => {
		page.current = answered([row()], { hasMore: true, loadingMore: true });
		renderList();
		const button = screen.getAllByRole("button", { name: "Load more" })[0]!;
		expect(button).toBeDisabled();
		expect(button).toHaveAttribute("aria-busy", "true");
	});

	it("a failed later page is told under the rows, which stay", () => {
		page.current = answered([row()], { hasMore: true, loadMoreFailed: true });
		renderList();
		expect(screen.getAllByText("Couldn't load more").length).toBeGreaterThan(0);
		expect(screen.getAllByRole("button", { name: "Try again" }).length).toBeGreaterThan(0);
		expect(within(screen.getByRole("table")).getByText("payments-api", { exact: false })).toBeInTheDocument();
	});

	it("all loaded: no footer at all", () => {
		page.current = answered([row()], { hasMore: false });
		renderList();
		expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
	});
});

describe("the deep link", () => {
	it("opens a request the loaded pages do not hold — read by id, without paging the list", async () => {
		const id = "c0000000-0000-4000-8000-000000000099";
		nav.search = `selected=${id}`;
		const loadMore = vi.fn();
		page.current = answered([row()], { hasMore: true, loadMore });
		reads.get.mockResolvedValue({
			approval: { ...row({ id, project_name: "data-lake", environment_name: "dev" }), note: null, decision_reason: null },
			canDecide: true,
			approveBlock: null,
		});
		renderList();
		expect(await screen.findByRole("dialog", { name: "Deploy · data-lake / dev" })).toBeInTheDocument();
		expect(reads.get).toHaveBeenCalledWith(id);
		expect(loadMore).not.toHaveBeenCalled();
	});
});
