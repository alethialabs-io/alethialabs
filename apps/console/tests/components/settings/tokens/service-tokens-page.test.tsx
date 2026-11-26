// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Settings › Service tokens (AGT-L2-U3): the list's distinct answers — loading, failed, refused,
// empty org, no match, populated — none standing in for another; no count anywhere; the filters as
// the read's normalized key; and Revoke behind a confirmation. The list is mocked at its seam
// (`useKeysetList`) so each state is set directly; the hook's paging is its own test.

import { ORPCError } from "@orpc/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { answered, CI_DEPLOY, keysetList, OLD_JENKINS } from "./token-test-kit";

const page = vi.hoisted((): { current: unknown; input: unknown } => ({ current: undefined, input: undefined }));
const actions = vi.hoisted(() => ({
	createConsoleServiceToken: vi.fn(),
	updateServiceTokenAutoApprove: vi.fn(),
	revokeConsoleServiceToken: vi.fn(),
}));

vi.mock("@/lib/query/use-keyset-list", () => ({
	useKeysetList: (_procedure: unknown, input: unknown) => {
		page.input = input;
		return page.current;
	},
}));
vi.mock("next/navigation", () => ({
	useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
	usePathname: () => "/acme/~/settings/tokens",
	useSearchParams: () => new URLSearchParams(),
	useParams: () => ({ org: "acme" }),
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("@/app/server/actions/agents/service-tokens", () => actions);
vi.mock("@/lib/rpc/client", async () => {
	const { fakeOrpc } = await import("@/tests/helpers/fake-orpc");
	const kit = await import("./token-test-kit");
	return { orpc: fakeOrpc({ "agents.tokenEnvironments": async () => kit.ENVIRONMENTS }).orpc };
});

import { ServiceTokensPage } from "@/components/settings/tokens/service-tokens-page";
import { DEFAULT_SERVICE_TOKEN_FILTERS } from "@/components/settings/tokens/tokens-filters";
import { useServiceTokenFilters } from "@/lib/stores/use-service-token-filters";

/** The page inside a query client, as the route mounts it. */
function renderPage(canManageAgents = true) {
	return render(
		<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
			<ServiceTokensPage canManageAgents={canManageAgents} />
		</QueryClientProvider>,
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	page.current = keysetList({ isPending: true }, { isLoading: true });
	useServiceTokenFilters.setState({ filters: DEFAULT_SERVICE_TOKEN_FILTERS });
});

describe("the service tokens list's answers", () => {
	it("loading: busy, with neither the empty state nor an error", () => {
		const { container } = renderPage();
		expect(container.firstElementChild).toHaveAttribute("aria-busy", "true");
		expect(screen.queryByText("No service tokens")).toBeNull();
		expect(screen.queryByRole("alert")).toBeNull();
		expect(screen.queryByText("No results.")).toBeNull();
	});

	it("error: a failed first page is a region error with a retry, never an empty org", async () => {
		page.current = keysetList({}, { isError: true, error: new Error("network") });
		renderPage();
		expect(screen.getByRole("alert")).toHaveTextContent("Couldn't load service tokens");
		await userEvent.setup().click(screen.getByRole("button", { name: "Try again" }));
		const list = page.current as { query: { refetch: ReturnType<typeof vi.fn> } };
		expect(list.query.refetch).toHaveBeenCalledOnce();
		expect(screen.queryByText("No service tokens")).toBeNull();
	});

	it("denied: a refusal while live renders the no-access state, naming the permission", () => {
		page.current = keysetList({}, { isError: true, error: new ORPCError("FORBIDDEN", { defined: true }) });
		renderPage();
		expect(screen.getByText("You can't manage service tokens")).toBeInTheDocument();
		expect(screen.getByText(/needs the Manage tokens permission/)).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Create token" })).toBeNull();
	});

	it("empty: an org with no token gets the first-run state with Create token, and no filter bar", () => {
		page.current = answered([]);
		renderPage();
		expect(screen.getByText("No service tokens")).toBeInTheDocument();
		expect(screen.getByText("ALETHIA_TOKEN")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Create token" })).toBeInTheDocument();
		expect(screen.queryByRole("searchbox")).toBeNull();
	});

	it("no match: filters that exclude every token offer Clear filters, which resets them", async () => {
		useServiceTokenFilters.setState({ filters: { search: "", status: ["expired"] } });
		page.current = answered([], { universeEmpty: false });
		renderPage();
		expect(screen.getByText("No tokens match these filters")).toBeInTheDocument();
		await userEvent.setup().click(screen.getByRole("button", { name: "Clear filters" }));
		expect(useServiceTokenFilters.getState().filters).toEqual(DEFAULT_SERVICE_TOKEN_FILTERS);
	});

	it("populated: each token's fields, its status with an explicit tier, and no count", () => {
		page.current = answered([CI_DEPLOY, OLD_JENKINS]);
		const { container } = renderPage();
		const table = screen.getByRole("table");
		const ci = within(table).getByText("ci-deploy").closest("tr");
		expect(ci).not.toBeNull();
		if (!ci) return;
		expect(ci).toHaveTextContent("alethia_sat_3f9aK2xQ…");
		expect(ci).toHaveTextContent("Read, Plan, Deploy");
		expect(ci).toHaveTextContent("web / staging");
		expect(ci).toHaveTextContent("Never");
		expect(ci).toHaveTextContent("Active");
		const old = within(table).getByText("old-jenkins").closest("tr");
		if (!old) throw new Error("old-jenkins row missing");
		expect(old).toHaveTextContent("All projects");
		expect(old).toHaveTextContent("None");
		expect(old).toHaveTextContent("Revoked");
		// Only an active token can be edited or revoked.
		expect(within(ci).getByRole("button", { name: "Edit ci-deploy" })).toBeInTheDocument();
		expect(within(old).queryByRole("button", { name: /Edit|Revoke/ })).toBeNull();
		// The phone's stacked list carries the same tokens.
		expect(screen.getByRole("list", { name: "Service tokens" })).toHaveTextContent("ci-deploy");
		// No count pill, no "N of M", no "Showing …".
		expect(container.querySelector('[data-slot="count-pill"]')).toBeNull();
		expect(container.textContent).not.toMatch(/\bof \d|Showing \d|\d+ tokens?\b/);
	});

	it("dims the previous rows while a new filter's first page loads", () => {
		page.current = answered([CI_DEPLOY], { isPlaceholderData: true });
		const { container } = renderPage();
		expect(container.querySelector(".opacity-60")).not.toBeNull();
		expect(container.firstElementChild).toHaveAttribute("aria-busy", "true");
	});
});

describe("the list's filters", () => {
	it("hands the read the normalized query: statuses sorted, empties dropped", () => {
		page.current = answered([CI_DEPLOY]);
		renderPage();
		expect(page.input).toEqual({});
		act(() => useServiceTokenFilters.getState().set("status", ["revoked", "active"]));
		expect(page.input).toEqual({ status: ["active", "revoked"] });
	});

	it("labels the Status facet in words, with the facet's own counts", async () => {
		page.current = answered([CI_DEPLOY]);
		renderPage();
		await userEvent.setup().click(screen.getByRole("button", { name: /Status/ }));
		// "Expired" appears nowhere else on the page: no listed token is expired.
		expect(await screen.findByText("Expired")).toBeInTheDocument();
		expect(screen.queryByText("expired")).toBeNull();
	});
});

describe("revoking a token", () => {
	it("asks first, then revokes exactly that token", async () => {
		actions.revokeConsoleServiceToken.mockResolvedValue({ ok: true, data: { tokenId: CI_DEPLOY.id } });
		page.current = answered([CI_DEPLOY]);
		renderPage();
		const user = userEvent.setup();
		await user.click(within(screen.getByRole("table")).getByRole("button", { name: "Revoke ci-deploy" }));
		const dialog = await screen.findByRole("alertdialog");
		expect(dialog).toHaveTextContent("Revoke ci-deploy?");
		expect(dialog).toHaveTextContent("Anything using this token stops working at once.");
		expect(actions.revokeConsoleServiceToken).not.toHaveBeenCalled();
		await user.click(within(dialog).getByRole("button", { name: "Revoke token" }));
		await waitFor(() => expect(actions.revokeConsoleServiceToken).toHaveBeenCalledWith({ tokenId: CI_DEPLOY.id }));
	});
});

// #7713: the release gate's audit could not click a row's Revoke at 1280px — Playwright reported the
// app shell's page-content wrapper intercepting the click. Nothing covered the row: the table's
// wrapper clips its x-axis by default (`@repo/ui/table`), eight unwrapped columns ran past the frame,
// and the last column — Edit and Revoke — was cut off while still reading as visible and enabled, so
// the click landed on the wrapper's padding behind it. jsdom has no layout, so this cannot measure
// the overflow; it pins the two structural answers that make the column reachable at any width, and
// rules out the other candidate (a closed sheet or dialog leaving a layer mounted). The geometry is
// measured by the audit legs (`destructive.spec.ts`, `inert.spec.ts`).
describe("the row actions stay reachable (#7713)", () => {
	it("a table wider than its frame scrolls to the actions column instead of clipping it", () => {
		page.current = answered([CI_DEPLOY]);
		renderPage();
		const table = screen.getByRole("table");
		expect(table.closest('[data-slot="table-container"]')).toHaveAttribute("data-scroll", "true");
		// The actions are the row's LAST cell — the one an overflow cuts off first.
		const row = within(table).getByText("ci-deploy").closest("tr");
		if (!row) throw new Error("ci-deploy row missing");
		const cells = within(row).getAllByRole("cell");
		const last = cells[cells.length - 1];
		if (!last) throw new Error("ci-deploy row has no cells");
		expect(within(last).getByRole("button", { name: "Revoke ci-deploy" })).toBeInTheDocument();
	});

	it("the unbounded name lists wrap rather than widening the table", () => {
		page.current = answered([CI_DEPLOY]);
		renderPage();
		const table = screen.getByRole("table");
		expect(within(table).getByText("Deploys without approval")).toHaveClass("whitespace-normal");
		expect(within(table).getByText("web / staging").closest("ul")).toHaveClass("whitespace-normal");
		expect(within(table).getByText("Read, Plan, Deploy")).toHaveClass("whitespace-normal");
	});

	it("with every sheet and dialog closed, no overlay is mounted over the page, and Revoke opens its confirmation", async () => {
		page.current = answered([CI_DEPLOY]);
		renderPage();
		expect(document.querySelector('[data-slot$="overlay"], [role="dialog"], [role="alertdialog"]')).toBeNull();
		// user-event (by default) refuses a click on an element with `pointer-events: none` in its ancestry.
		await userEvent.setup().click(within(screen.getByRole("table")).getByRole("button", { name: "Revoke ci-deploy" }));
		expect(await screen.findByRole("alertdialog")).toHaveTextContent("Revoke ci-deploy?");
	});
});
