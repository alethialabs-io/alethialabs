// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6120 / #6819 — the Environments page reads `environments.overview` (prefetched by the route) and
// renders its states distinctly (RUBRIC B3/B4): pending is the route's own skeleton, a refusal is a
// refusal (forbidden, or a project that is not there), a failure is an error with a retry, and only
// data renders the page. With data, the page opens with the toolbar — the count, one line of
// description, the actions — and NO page title (F010), and the environments are a TABLE on the
// filter standard: the server decides which rows match, and the bar's selection is the read's input.
//
// It also says what a person must not miss: a control they may not use is disabled WITH its reason,
// and a FAILED environment may still hold cloud resources that only Destroy removes.

import { ORPCError } from "@orpc/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeHandler } from "@/tests/helpers/fake-orpc";
import { DEV, PROD, envRow, overviewOf, pageOf } from "./fixtures";

const h = vi.hoisted(() => ({
	handlers: {} as Record<string, FakeHandler>,
	inputs: [] as unknown[],
	replace: vi.fn(),
	search: new URLSearchParams(),
}));
vi.mock("@/lib/rpc/client", async () => {
	const { fakeOrpc } = await import("@/tests/helpers/fake-orpc");
	return { orpc: fakeOrpc(h.handlers).orpc };
});
vi.mock("next/navigation", () => ({
	useRouter: () => ({ push: vi.fn(), replace: h.replace, refresh: vi.fn() }),
	usePathname: () => "/acme/payments/environments",
	useSearchParams: () => h.search,
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/app/server/actions/projects", () => ({
	addEnvironment: vi.fn(),
	deleteEnvironment: vi.fn(),
	duplicateEnvironment: vi.fn(),
	setAutoHeal: vi.fn(),
	setByoAdmissionEnforce: vi.fn(),
}));
vi.mock("@/app/server/actions/promotions", () => ({
	approvePromotion: vi.fn(),
	cancelPromotion: vi.fn(),
	promoteEnvironment: vi.fn(),
	rejectPromotion: vi.fn(),
}));
vi.mock("@/app/server/actions/protection", () => ({ setProtectionRules: vi.fn() }));
vi.mock("@/app/server/actions/missing-cluster", () => ({ markEnvironmentDestroyedAction: vi.fn() }));
// The classification chips are their own unit's read; here they are empty.
vi.mock("@/lib/query/use-classification-query", () => ({
	useAssignmentsForKind: () => ({ data: {} }),
}));
vi.mock("@/components/classification/classification-control", () => ({
	ClassificationControl: () => null,
}));

import { ENVIRONMENT_COLUMN_COUNT } from "@/components/environments/environment-status";
import { EnvironmentsView } from "@/components/environments/environments-view";
import { MANAGE_DENIED_REASON } from "@/components/errors/manage-gate";
import { orpc } from "@/lib/rpc/client";
import { useEnvironmentsFilters } from "@/lib/stores/use-environments-filters";

const KEY = orpc.environments.overview.queryKey({ input: { project: "payments" } });

/** Renders the view over a cache `seed` prepared — the state the route's prefetch handed over. */
function renderView(seed: (qc: QueryClient) => void) {
	// staleTime / retryOnMount: the cached entry IS the server's answer; the test is about rendering
	// it, not refetching. (An errored entry with no data is refetched on mount by default, and a
	// refetch of a never-successful query resets it to pending — the render under test would vanish.)
	const qc = new QueryClient({
		defaultOptions: { queries: { retry: false, staleTime: Infinity, retryOnMount: false } },
	});
	seed(qc);
	return render(
		<QueryClientProvider client={qc}>
			<EnvironmentsView org="acme" project="payments" />
		</QueryClientProvider>,
	);
}

/** Seeds the pristine read with `data`. */
function seeded(data: unknown) {
	return (qc: QueryClient) => qc.setQueryData(KEY, data);
}

/** Seeds the overview read as failed with `error` (what a refused or failed prefetch leaves). */
function failed(error: Error) {
	return (qc: QueryClient) =>
		qc.getQueryCache().build(qc, { queryKey: KEY }).setState({
			status: "error",
			error,
			fetchStatus: "idle",
		});
}

beforeEach(() => {
	vi.clearAllMocks();
	h.inputs.length = 0;
	h.search = new URLSearchParams();
	for (const key of Object.keys(h.handlers)) delete h.handlers[key];
	h.handlers["environments.overview"] = async (input) => {
		h.inputs.push(input);
		return overviewOf();
	};
	act(() => useEnvironmentsFilters.getState().reset());
});

describe("EnvironmentsView — the data (F010)", () => {
	it("opens with the toolbar — the count, the description, the actions — and no page title", () => {
		renderView(seeded(overviewOf()));
		const toolbar = document.querySelector('[data-slot="page-toolbar"]');
		expect(toolbar).not.toBeNull();
		expect(toolbar).toHaveTextContent("2");
		expect(toolbar).toHaveTextContent("Isolated instances of this project's services.");
		expect(screen.getByRole("button", { name: /new environment/i })).toBeEnabled();
		expect(screen.getByRole("button", { name: /promote/i })).toBeEnabled();
		// No heading says what the breadcrumb already says.
		expect(screen.queryByRole("heading", { name: /^environments/i })).toBeNull();
	});

	it("lists the environments as a table: one row each, linked to the board, with the declared columns", () => {
		renderView(seeded(overviewOf()));
		const table = screen.getByRole("table");
		expect(within(table).getAllByRole("columnheader")).toHaveLength(ENVIRONMENT_COLUMN_COUNT);
		expect(within(table).getByRole("link", { name: "development" })).toHaveAttribute(
			"href",
			"/acme/payments/architecture?environment_id=env-dev",
		);
		expect(within(table).getByRole("link", { name: "production" })).toBeInTheDocument();
		// The default environment carries its tag; each row has its own auto-heal switch and menu.
		expect(within(table).getByText("Default")).toBeInTheDocument();
		expect(screen.getByRole("switch", { name: "Toggle auto-heal for production" })).not.toHaveAttribute(
			"aria-disabled",
			"true",
		);
		expect(screen.getByRole("button", { name: "Environment actions for development" })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Edit rules for production" })).toBeEnabled();
	});

	it("BYO admission (#6541): shown where a BYO chart is, with 'Redeploy to apply' after a change", () => {
		renderView(
			seeded(
				overviewOf({
					envs: [
						DEV,
						{ ...PROD, byo_admission_has_charts: true, byo_admission_enforce: true, byo_admission_pending: true },
					],
				}),
			),
		);
		const shown = [...document.querySelectorAll('[data-slot="byo-admission"]')];
		expect(shown).toHaveLength(1);
		expect(shown[0]).toHaveTextContent("BYO admission: Refuse · Redeploy to apply");
	});

	it("an empty project is empty, and offers the action that makes an environment", () => {
		renderView(seeded(overviewOf({ envs: [] })));
		expect(screen.getByText("No environments")).toBeInTheDocument();
		expect(screen.getAllByRole("button", { name: /new environment/i })).toHaveLength(2);
		expect(screen.queryByRole("table")).toBeNull();
	});

	it("one environment is a list with a note — not an empty state — and Promote says why it waits", () => {
		renderView(seeded(overviewOf({ envs: [DEV] })));
		expect(screen.getByRole("table")).toBeInTheDocument();
		expect(screen.getByText(/Only one environment\./)).toBeInTheDocument();
		const promote = screen.getByRole("button", { name: /promote/i });
		expect(promote).toBeDisabled();
		expect(promote).toHaveAccessibleDescription(/needs two environments/i);
	});
});

describe("EnvironmentsView — pending, refused and failed are distinct (B3/B4)", () => {
	it("pending is the skeleton — never the empty state", () => {
		h.handlers["environments.overview"] = () => new Promise(() => {});
		renderView(() => {});
		expect(document.body.querySelector('[data-skeleton="environments"][aria-busy="true"]')).not.toBeNull();
		expect(screen.queryByText("No environments")).toBeNull();
	});

	it("a FORBIDDEN refusal reads as a permission, not as no environments", () => {
		renderView(failed(new ORPCError("FORBIDDEN", { defined: true })));
		expect(document.body.querySelector('[data-state="refused"][data-refusal="forbidden"]')).not.toBeNull();
		expect(screen.getByText("You don't have access to this project's environments")).toBeInTheDocument();
		expect(screen.queryByText("No environments")).toBeNull();
		expect(screen.queryByRole("button", { name: /try again/i })).toBeNull();
	});

	it("a NOT_FOUND refusal reads as a project that is not here", () => {
		renderView(failed(new ORPCError("NOT_FOUND", { defined: true })));
		expect(document.body.querySelector('[data-state="refused"][data-refusal="not-found"]')).not.toBeNull();
		expect(screen.queryByText("No environments")).toBeNull();
	});

	it("any other failure is an error with a retry — not empty, not an endless skeleton", () => {
		renderView(failed(new Error("network")));
		expect(screen.getByText("Couldn't load environments")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /try again/i })).toBeInTheDocument();
		expect(screen.queryByText("No environments")).toBeNull();
		expect(document.body.querySelector('[aria-busy="true"]')).toBeNull();
	});
});

describe("EnvironmentsView — a control the viewer may not use is disabled with its reason", () => {
	it("without project:edit: create, auto-heal and the row's writes are disabled and say why", async () => {
		renderView(seeded(overviewOf({ canManage: false })));
		const create = screen.getByRole("button", { name: /new environment/i });
		expect(create).toBeDisabled();
		expect(create).toHaveAccessibleDescription(MANAGE_DENIED_REASON);
		// base-ui's switch is a `<span role="switch">`: its disabled state is `aria-disabled`.
		expect(screen.getByRole("switch", { name: "Toggle auto-heal for production" })).toHaveAttribute(
			"aria-disabled",
			"true",
		);

		await userEvent.click(screen.getByRole("button", { name: "Environment actions for production" }));
		const rules = screen.getByRole("button", { name: "Edit rules for production" });
		expect(rules).toBeDisabled();
		expect(rules).toHaveAccessibleDescription(MANAGE_DENIED_REASON);
		for (const name of [/^Duplicate/, /^Delete/]) {
			const item = await screen.findByRole("menuitem", { name });
			expect(item).toHaveAttribute("aria-disabled", "true");
			expect(item).toHaveTextContent(MANAGE_DENIED_REASON);
		}
		// Reading is still theirs: the way to the board is not disabled.
		expect(screen.getByRole("menuitem", { name: /Open in Architecture/ })).not.toHaveAttribute("aria-disabled", "true");
	});

	it("without project:deploy: Promote is disabled and says why, and editing is untouched", () => {
		renderView(seeded(overviewOf({ canPromote: false })));
		const promote = screen.getByRole("button", { name: /promote/i });
		expect(promote).toBeDisabled();
		expect(promote).toHaveAccessibleDescription(MANAGE_DENIED_REASON);
		expect(screen.getByRole("button", { name: /new environment/i })).toBeEnabled();
	});

	it("the default environment has no Delete in its menu; another environment does", async () => {
		renderView(seeded(overviewOf()));
		await userEvent.click(screen.getByRole("button", { name: "Environment actions for development" }));
		await screen.findByRole("menuitem", { name: /^Duplicate/ });
		expect(screen.queryByRole("menuitem", { name: /^Delete/ })).toBeNull();
	});
});

describe("EnvironmentsView — what needs a decision", () => {
	const QA = envRow({ id: "env-qa", name: "qa", status: "FAILED" });

	it("says a FAILED environment may still have cloud resources, and points at Destroy", () => {
		renderView(seeded(overviewOf({ envs: [DEV, QA] })));
		const notices = [...document.querySelectorAll('[data-slot="failed-environment-notice"]')];
		expect(notices).toHaveLength(1);
		expect(notices[0]).toHaveTextContent("qa failed");
		expect(notices[0]).toHaveTextContent("may still have cloud resources");
		expect(notices[0]).toHaveTextContent("Deleting the environment does not remove them");
		expect(notices[0]).toHaveTextContent("run Destroy from its settings");
		expect(screen.getByRole("link", { name: "Open qa to destroy it" })).toHaveAttribute(
			"href",
			"/acme/payments/architecture?environment_id=env-qa",
		);
	});

	it("says nothing of the kind for an environment that did not fail", () => {
		renderView(seeded(overviewOf()));
		expect(document.querySelector('[data-slot="failed-environment-notice"]')).toBeNull();
	});

	it("a filter does not hide the warning: the failed environment is filtered out of the list, not out of the notice", () => {
		renderView(
			seeded(overviewOf({ envs: [DEV, QA], page: { ...pageOf([DEV, QA]), rowIds: ["env-dev"], resultCount: 1 } })),
		);
		expect(within(screen.getByRole("table")).queryByRole("link", { name: "qa" })).toBeNull();
		expect(document.querySelectorAll('[data-slot="failed-environment-notice"]')).toHaveLength(1);
	});

	/** The reconcile state of `production` with its cluster found deleted. */
	const MISSING = {
		environmentId: "env-prod",
		autoHeal: false,
		driftInSync: false,
		deliveryInSync: null,
		deployPending: false,
		clusterMissing: { observedAt: "2026-11-09T00:00:00.000Z", source: "drift" as const, deleted: ["aws_eks_cluster.main"] },
		lastDeployedAt: "2026-07-16T12:00:00.000Z",
		probe: { reachable: null, message: null, probedAt: null },
	};

	it("a cluster found deleted offers the three ways out (#6736)", () => {
		renderView(seeded(overviewOf({ reconcile: [MISSING] })));
		const notice = document.querySelector('[data-slot="missing-cluster-notice"]');
		expect(notice).toHaveTextContent("production");
		expect(screen.getByRole("link", { name: "Redeploy" })).toBeInTheDocument();
		expect(screen.getByRole("link", { name: "Tear down" })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Mark as destroyed" })).toBeInTheDocument();
	});

	it("offers none while a run is in flight on it — the run writes its own outcome", () => {
		renderView(
			seeded(overviewOf({ envs: [DEV, { ...PROD, status: "PROVISIONING" }], reconcile: [MISSING] })),
		);
		expect(document.querySelector('[data-slot="missing-cluster-notice"]')).toBeNull();
	});

	it("tells a viewer who cannot change the project who can, instead of offering buttons that would refuse", () => {
		renderView(seeded(overviewOf({ canManage: false, reconcile: [MISSING] })));
		const notice = document.querySelector('[data-slot="missing-cluster-notice"]');
		expect(notice).toHaveTextContent("Someone who can edit this project");
		expect(screen.queryByRole("button", { name: "Mark as destroyed" })).toBeNull();
	});
});

describe("EnvironmentsView — the filter standard", () => {
	it("shows the rows the SERVER matched, and counts them — not every environment it knows", () => {
		renderView(
			seeded(overviewOf({ page: { ...pageOf([DEV, PROD]), rowIds: ["env-prod"], resultCount: 1 } })),
		);
		const table = screen.getByRole("table");
		expect(within(table).getByRole("link", { name: "production" })).toBeInTheDocument();
		expect(within(table).queryByRole("link", { name: "development" })).toBeNull();
		expect(document.querySelector('[data-slot="page-toolbar"]')).toHaveTextContent("1");
	});

	it("environments the filters exclude is `no match`, with a way back — never `No environments`", () => {
		renderView(seeded(overviewOf({ page: { ...pageOf([DEV, PROD]), rowIds: [], resultCount: 0 } })));
		expect(screen.getByText("No environments match these filters")).toBeInTheDocument();
		expect(screen.queryByText("No environments")).toBeNull();
		expect(screen.getByRole("button", { name: "Clear filters" })).toBeInTheDocument();
	});

	it("the bar's selection is the read's input, beside the project", async () => {
		renderView(seeded(overviewOf()));
		act(() => useEnvironmentsFilters.getState().set("stages", ["staging", "production"]));
		await waitFor(() =>
			expect(h.inputs).toContainEqual({ project: "payments", stages: ["production", "staging"] }),
		);
	});

	it("a filter the link carries is read into the store, and asked of the server", async () => {
		h.search = new URLSearchParams("statuses=FAILED");
		renderView(seeded(overviewOf()));
		await waitFor(() => expect(h.inputs).toContainEqual({ project: "payments", statuses: ["FAILED"] }));
		expect(useEnvironmentsFilters.getState().filters.statuses).toEqual(["FAILED"]);
	});

	it("offers the three stages with their counts, from the read's facets", () => {
		renderView(seeded(overviewOf()));
		for (const label of ["Development", "Staging", "Production"]) {
			expect(screen.getByRole("button", { name: new RegExp(`^${label}`) })).toBeInTheDocument();
		}
	});
});
