// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6828 — Settings · Classification, the P3 findings:
//   F-27  a viewer who cannot edit sees a read-only blank slate and a create button disabled WITH
//         its reason, never an invitation to templates they are not shown;
//   F-28  the search and the selected dimension are URL state, and the count is the count pill;
//   F-14  a refused quick-add keeps what was typed;
//   F-29  a dimension can be reordered from the keyboard (move up / move down).

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeCall, FakeHandler } from "@/tests/helpers/fake-orpc";

const h = vi.hoisted(() => ({
	handlers: {} as Record<string, FakeHandler>,
	calls: [] as FakeCall[],
	search: "",
	createValue: vi.fn<(input: unknown) => Promise<unknown>>(async () => undefined),
	reorderDimensions: vi.fn<(input: unknown) => Promise<unknown>>(async () => ({ ok: true, data: null })),
}));
vi.mock("@/lib/rpc/client", async () => {
	const { fakeOrpc } = await import("@/tests/helpers/fake-orpc");
	return { orpc: fakeOrpc(h.handlers, h.calls).orpc };
});
vi.mock("@/app/server/actions/classification/dimensions", () => ({
	createDimension: vi.fn(),
	createDimensionWithValues: vi.fn(),
	updateDimension: vi.fn(),
	deleteDimension: vi.fn(),
	reorderDimensions: (input: unknown) => h.reorderDimensions(input),
	createValue: (input: unknown) => h.createValue(input),
	updateValue: vi.fn(),
	deleteValue: vi.fn(),
	reorderValues: vi.fn(async () => ({ ok: true, data: null })),
}));
vi.mock("next/navigation", () => ({
	useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }),
	usePathname: () => "/acme/~/settings/classification",
	useSearchParams: () => new URLSearchParams(h.search),
	useParams: () => ({ org: "acme" }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { ClassificationManager } from "@/components/classification/classification-manager";

/** A dimension with the given values. */
function dimension(id: string, label: string, values: string[] = []) {
	return {
		id,
		key: id,
		label,
		description: null,
		multi: false,
		position: 0,
		appliesTo: [],
		resourceCount: 0,
		values: values.map((v, i) => ({
			id: `${id}-${v}`,
			dimension_id: id,
			value: v,
			label: v,
			color: null,
			enforcement: null,
			position: i,
			assignmentCount: 0,
		})),
	};
}

/** Renders the manager over a fresh client. */
function renderManager(ui: ReactElement = <ClassificationManager />) {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
	vi.clearAllMocks();
	h.calls.length = 0;
	h.search = "";
	h.handlers["classification.dimensions"] = async () => [];
	h.handlers["classification.canEdit"] = async () => true;
	h.handlers["classification.dimensionBreakdown"] = async () => [];
});

describe("a viewer who cannot edit (F-27)", () => {
	beforeEach(() => {
		h.handlers["classification.canEdit"] = async () => false;
	});

	it("sees the read-only blank slate: no templates, and told who sets it up", async () => {
		renderManager();
		expect(await screen.findByText("No classification yet")).toBeInTheDocument();
		expect(screen.getByText(/An owner or admin of this organization sets them up/)).toBeInTheDocument();
		expect(screen.queryByText("Start your taxonomy")).toBeNull();
		expect(screen.queryByRole("button", { name: "Use template" })).toBeNull();
	});

	it("sees the create button disabled, with its reason", async () => {
		renderManager();
		await screen.findByText("No classification yet");
		await waitFor(() =>
			expect(screen.getByRole("button", { name: /New dimension/ })).toHaveAccessibleDescription(
				/doesn't allow this/,
			),
		);
		expect(screen.getByRole("button", { name: /New dimension/ })).toBeDisabled();
	});
});

describe("an editor's blank slate", () => {
	it("invites starting from a template, with the create button live", async () => {
		renderManager();
		expect(await screen.findByText("Start your taxonomy")).toBeInTheDocument();
		expect(screen.getAllByRole("button", { name: "Use template" }).length).toBeGreaterThan(0);
		await waitFor(() => expect(screen.getByRole("button", { name: /New dimension/ })).toBeEnabled());
	});
});

describe("URL state (F-28)", () => {
	it("a link's ?search= is in the box and asked for at once", async () => {
		h.search = "search=env";
		h.handlers["classification.dimensions"] = async () => [dimension("env", "Environment")];
		renderManager();
		expect(screen.getByRole("textbox", { name: "Search dimensions & values" })).toHaveValue("env");
		await screen.findByRole("heading", { name: "Environment" });
		const reads = h.calls.filter((c) => c.path === "classification.dimensions").map((c) => c.input);
		expect(reads).toEqual([{ search: "env" }]);
	});

	it("a link's ?selected= opens that dimension", async () => {
		h.search = "selected=team";
		h.handlers["classification.dimensions"] = async () => [
			dimension("env", "Environment"),
			dimension("team", "Team"),
		];
		renderManager();
		expect(await screen.findByRole("heading", { name: "Team" })).toBeInTheDocument();
		expect(screen.queryByRole("heading", { name: "Environment" })).toBeNull();
	});

	it("draws no list-size count (the list standard, #7481)", async () => {
		h.handlers["classification.dimensions"] = async () => [
			dimension("env", "Environment"),
			dimension("team", "Team"),
		];
		const { container } = renderManager();
		await screen.findByRole("heading", { name: "Environment" });
		expect(container.querySelector('[data-slot="count-pill"]')).toBeNull();
		expect(screen.queryByText("2 dimensions")).toBeNull();
	});
});

describe("quick-add (F-14)", () => {
	it("a refused add keeps what was typed; a successful one clears it", async () => {
		const user = userEvent.setup();
		h.handlers["classification.dimensions"] = async () => [dimension("env", "Environment", ["dev"])];
		h.createValue.mockResolvedValueOnce({
			ok: false,
			error: { kind: "conflict", message: "That value already exists." },
		});
		renderManager();
		await screen.findByRole("heading", { name: "Environment" });
		const box = await screen.findByRole("textbox", { name: "New value label" });

		await user.type(box, "Dev{Enter}");
		await waitFor(() => expect(h.createValue).toHaveBeenCalledTimes(1));
		await waitFor(() => expect(box).toBeEnabled());
		expect(box).toHaveValue("Dev");

		h.createValue.mockResolvedValueOnce({ ok: true, data: null });
		await user.clear(box);
		await user.type(box, "Prod{Enter}");
		await waitFor(() => expect(box).toHaveValue(""));
	});
});

describe("keyboard reorder (F-29)", () => {
	it("moves a dimension down with its arrow, and the first one has no way up", async () => {
		const user = userEvent.setup();
		h.handlers["classification.dimensions"] = async () => [
			dimension("env", "Environment"),
			dimension("team", "Team"),
		];
		renderManager();
		await screen.findByRole("heading", { name: "Environment" });
		expect(await screen.findByRole("button", { name: "Move Environment up" })).toBeDisabled();

		await user.click(screen.getByRole("button", { name: "Move Environment down" }));
		await waitFor(() => expect(h.reorderDimensions).toHaveBeenCalledWith({ ids: ["team", "env"] }));
	});

	it("each value row has its own pair", async () => {
		h.handlers["classification.dimensions"] = async () => [dimension("env", "Environment", ["dev", "prod"])];
		renderManager();
		const heading = await screen.findByRole("heading", { name: "Environment" });
		const pane = heading.closest<HTMLElement>(".rounded-lg");
		if (!(pane instanceof HTMLElement)) throw new Error("the detail pane did not render");
		expect(await within(pane).findByRole("button", { name: "Move dev down" })).toBeEnabled();
		expect(within(pane).getByRole("button", { name: "Move prod down" })).toBeDisabled();
	});
});
