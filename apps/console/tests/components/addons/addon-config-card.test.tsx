// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The add-on subject renders the catalog item's schema'd knobs + delivery mode in the inspector's
// frame. An install or a reconfigure is STAGED in the document (#6834) — there is no Enable, Save
// or Cancel — and Remove is a confirmed, immediate action. The disable mutation hook is mocked so
// the test never touches the server actions.

import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
	AddonInstallState,
	AddonMarketItem,
} from "@/app/server/actions/addons";

const { disableMut } = vi.hoisted(() => ({
	disableMut: { mutateAsync: vi.fn(), isPending: false },
}));
vi.mock("@/lib/query/use-addons-query", () => ({
	useDisableAddon: () => disableMut,
	useRequestGitopsBump: () => ({ mutate: () => {}, isPending: false }),
	useAddonsQuery: vi.fn(),
}));

import { AddonConfigCard, AddonConfigForm } from "@/components/addons/addon-config-card";
import {
	forgetSecrets,
	recallSecrets,
} from "@/components/design-project/canvas/inspector-shell/staged-operations";
import { board } from "@/lib/canvas/store/board";
import type { StagedOperation } from "@/lib/canvas/store/types";
import { useAddonsQuery } from "@/lib/query/use-addons-query";
import { useCanvasStore } from "@/lib/stores/use-canvas-store";

/** The operations staged in the document. */
const staged = () => board.document.getState().operations;

/** The add-on knobs a staged operation carries. */
function stagedValues(operation: StagedOperation | undefined): unknown {
	const input = operation?.input;
	return input && typeof input === "object" && "values" in input ? input.values : undefined;
}

beforeEach(() => {
	useCanvasStore.getState().reset();
	forgetSecrets("addon:kube-prometheus-stack");
	forgetSecrets("addon:minio");
});

const BASE_ITEM: AddonMarketItem = {
	id: "kube-prometheus-stack",
	name: "Prometheus + Grafana",
	category: "observability",
	icon: "LineChart",
	summary: "Full metrics stack.",
	docsUrl: "https://example.com",
	license: "Apache-2.0",
	chart: "kube-prometheus-stack",
	version: "61.9.0",
	namespace: "monitoring",
	requires: ["storage"],
	fields: [
		{
			key: "retentionDays",
			label: "Metric retention (days)",
			type: "number",
			default: 15,
			min: 1,
			max: 365,
		},
		{
			key: "grafana",
			label: "Bundle Grafana dashboards",
			type: "boolean",
			default: true,
		},
	],
	install: null,
};

const INSTALL: AddonInstallState = {
	enabled: true,
	mode: "managed",
	values: { retentionDays: 30, grafana: true },
	valuesYaml: null,
	version: null,
	status: "PENDING",
	health: null,
	sync: null,
	lastSyncedAt: null,
	gitopsBump: null,
};

/** An add-on exercising the new field types: enum (Select), secret (masked), nested (group). */
const FIELD_TYPES_ITEM: AddonMarketItem = {
	...BASE_ITEM,
	id: "minio",
	name: "MinIO",
	fields: [
		{
			key: "mode",
			label: "Mode",
			type: "enum",
			default: "standalone",
			options: [
				{ value: "standalone", label: "Standalone (single node)" },
				{ value: "distributed", label: "Distributed (HA)" },
			],
		},
		{ key: "rootPassword", label: "Root password", type: "secret", secret: true },
		{
			key: "resources",
			label: "Resource requests",
			type: "nested",
			fields: [
				{ key: "cpu", label: "CPU", type: "string", default: "250m" },
				{ key: "memory", label: "Memory", type: "string", default: "512Mi" },
			],
		},
	],
	install: null,
};

describe("AddonConfigForm", () => {
	it("renders the schema'd knobs + delivery mode when opening a not-installed add-on", () => {
		render(
			<AddonConfigForm
				item={BASE_ITEM}
				projectId="p1"
				environmentId="e1"
				hasAppsRepo={false}
				provider={null}
				onDone={vi.fn()}
			/>,
		);
		expect(screen.getByText("Delivery")).toBeInTheDocument();
		expect(screen.getByText("Metric retention (days)")).toBeInTheDocument();
		expect(screen.getByText("Bundle Grafana dashboards")).toBeInTheDocument();
		// Not installed → one action that stages the install, never Remove.
		expect(screen.getByRole("button", { name: "Add to changes" })).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: /remove/i }),
		).not.toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
	});

	it("offers Remove, and nothing to add, for an installed add-on", () => {
		render(
			<AddonConfigForm
				item={{ ...BASE_ITEM, install: INSTALL }}
				projectId="p1"
				environmentId="e1"
				hasAppsRepo
				provider={null}
				onDone={vi.fn()}
			/>,
		);
		expect(screen.getByRole("button", { name: "Remove" })).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "Add to changes" }),
		).not.toBeInTheDocument();
	});

	it("renders enum as a Select showing the default option's label", () => {
		render(
			<AddonConfigForm
				item={FIELD_TYPES_ITEM}
				projectId="p1"
				environmentId="e1"
				hasAppsRepo={false}
				provider={null}
				onDone={vi.fn()}
			/>,
		);
		expect(screen.getByText("Mode")).toBeInTheDocument();
		// Renders as a Select whose trigger shows the default option's LABEL, not its value.
		expect(
			screen.getAllByText("Standalone (single node)").length,
		).toBeGreaterThan(0);
		expect(screen.queryByText("standalone")).not.toBeInTheDocument();
	});

	it("renders secret as a masked, write-only input marked Unset (never the ciphertext)", () => {
		render(
			<AddonConfigForm
				item={FIELD_TYPES_ITEM}
				projectId="p1"
				environmentId="e1"
				hasAppsRepo={false}
				provider={null}
				onDone={vi.fn()}
			/>,
		);
		const input = screen.getByLabelText("Root password");
		expect(input).toHaveAttribute("type", "password");
		expect(input).toHaveValue("");
		expect(screen.getByText("Unset")).toBeInTheDocument();
	});

	it("marks a stored secret Set without exposing its envelope", () => {
		render(
			<AddonConfigForm
				item={{
					...FIELD_TYPES_ITEM,
					install: {
						...INSTALL,
						values: {
							mode: "standalone",
							rootPassword: { v: 1, iv: "x", tag: "y", data: "z" },
						},
					},
				}}
				projectId="p1"
				environmentId="e1"
				hasAppsRepo
				provider={null}
				onDone={vi.fn()}
			/>,
		);
		const input = screen.getByLabelText("Root password");
		// Write-only: the field is Set, but empty and never rendering the ciphertext.
		expect(screen.getByText("Set")).toBeInTheDocument();
		expect(input).toHaveValue("");
		expect(screen.queryByText(/data/)).not.toBeInTheDocument();
	});

	// ── the confirmation (#4281), observed rather than claimed (#4600 review).
	//
	// `destructive-actions.yaml` records `addons.remove: confirmed`, and NOTHING else in the repo
	// can see that: the live spec needs an installed add-on it has no fixture for, `prod-qa: skip`
	// keeps it out of the production sweep, and the static census only proves `useDisableAddon`
	// OCCURS in this file — true however the click is wired. These two are what a later refactor
	// restoring `onClick={onRemove}` has to get past.

	it("does NOT remove on a bare click — Remove opens the confirmation", async () => {
		const user = userEvent.setup();
		disableMut.mutateAsync.mockClear();
		render(
			<AddonConfigForm
				item={{ ...BASE_ITEM, install: INSTALL }}
				projectId="p1"
				environmentId="e1"
				hasAppsRepo
				provider={null}
				onDone={vi.fn()}
			/>,
		);
		await user.click(screen.getByRole("button", { name: /^remove$/i }));
		expect(disableMut.mutateAsync).not.toHaveBeenCalled();
		expect(screen.getByText("Remove this add-on?")).toBeInTheDocument();
	});

	it("removes only from the dialog's confirm", async () => {
		const user = userEvent.setup();
		disableMut.mutateAsync.mockClear();
		disableMut.mutateAsync.mockResolvedValue(undefined);
		render(
			<AddonConfigForm
				item={{ ...BASE_ITEM, install: INSTALL }}
				projectId="p1"
				environmentId="e1"
				hasAppsRepo
				provider={null}
				onDone={vi.fn()}
			/>,
		);
		await user.click(screen.getByRole("button", { name: /^remove$/i }));
		await user.click(screen.getByRole("button", { name: /remove add-on/i }));
		expect(disableMut.mutateAsync).toHaveBeenCalledWith({
			projectId: "p1",
			environmentId: "e1",
			addonId: BASE_ITEM.id,
		});
	});

	it("renders a nested field as a one-level group of its children", () => {
		render(
			<AddonConfigForm
				item={FIELD_TYPES_ITEM}
				projectId="p1"
				environmentId="e1"
				hasAppsRepo={false}
				provider={null}
				onDone={vi.fn()}
			/>,
		);
		expect(screen.getByText("Resource requests")).toBeInTheDocument();
		expect(screen.getByLabelText("CPU")).toHaveValue("250m");
		expect(screen.getByLabelText("Memory")).toHaveValue("512Mi");
	});
});

describe("AddonConfigForm — an install or a reconfigure is staged, not saved (#6834)", () => {
	/** Renders the form for `item`. */
	function renderForm(item: AddonMarketItem) {
		return render(
			<AddonConfigForm
				item={item}
				projectId="p1"
				environmentId="e1"
				hasAppsRepo
				provider={null}
				onDone={vi.fn()}
			/>,
		);
	}

	it("has no commit button: nothing in it is named Save, Install, Update, Enable or Cancel", () => {
		renderForm({ ...BASE_ITEM, install: INSTALL });
		const names = screen
			.getAllByRole("button")
			.map((button) => button.getAttribute("aria-label") ?? button.textContent ?? "");
		expect(names.filter((name) => /^(save|install|update|enable|cancel)\b/i.test(name.trim()))).toEqual(
			[],
		);
	});

	it("'Add to changes' stages the install with the catalog's defaults", async () => {
		const user = userEvent.setup();
		renderForm(BASE_ITEM);
		expect(staged()).toEqual([]);
		await user.click(screen.getByRole("button", { name: "Add to changes" }));

		expect(staged()).toEqual([
			{
				id: "addon:kube-prometheus-stack",
				target: "addon",
				verb: "install",
				targetId: "kube-prometheus-stack",
				summary: "Install add-on Prometheus + Grafana",
				input: {
					projectId: "p1",
					environmentId: "e1",
					addonId: "kube-prometheus-stack",
					mode: "managed",
					values: { retentionDays: 15, grafana: true },
					valuesYaml: "",
					version: null,
					secretPaths: [],
				},
			},
		]);
		expect(screen.getByRole("status")).toHaveTextContent("Install staged.");
		// The one action is spent: the change is staged, and Discard is how it is taken back.
		expect(screen.queryByRole("button", { name: "Add to changes" })).not.toBeInTheDocument();
	});

	it("typing into a field and leaving it stages the install", async () => {
		const user = userEvent.setup();
		renderForm(BASE_ITEM);
		const retention = screen.getByLabelText("Metric retention (days)");
		await user.clear(retention);
		await user.type(retention, "30");
		expect(staged()).toEqual([]);
		await user.tab();

		expect(staged().map((o) => [o.verb, stagedValues(o)])).toEqual([
			["install", { retentionDays: 30, grafana: true }],
		]);
	});

	it("typing into a field and then closing the inspector leaves the operation in the changeset", async () => {
		const user = userEvent.setup();
		const { unmount } = renderForm(BASE_ITEM);
		const retention = screen.getByLabelText("Metric retention (days)");
		await user.clear(retention);
		await user.type(retention, "45");
		// A click on the board closes the inspector: the subject unmounts with the field still focused.
		act(() => unmount());

		expect(staged().map((o) => stagedValues(o))).toEqual([{ retentionDays: 45, grafana: true }]);
	});

	it("an installed add-on left as it is stages nothing; a change stages a reconfigure", async () => {
		const user = userEvent.setup();
		renderForm({ ...BASE_ITEM, install: INSTALL });
		const retention = screen.getByLabelText("Metric retention (days)");
		await user.click(retention);
		await user.tab();
		expect(staged()).toEqual([]);

		await user.clear(retention);
		await user.type(retention, "90");
		await user.tab();
		expect(staged().map((o) => [o.verb, o.summary, stagedValues(o)])).toEqual([
			["update", "Reconfigure add-on Prometheus + Grafana", { retentionDays: 90, grafana: true }],
		]);
		expect(screen.getByRole("status")).toHaveTextContent("New settings staged.");
	});

	it("putting an installed add-on's field back takes the change off the changeset", async () => {
		const user = userEvent.setup();
		renderForm({ ...BASE_ITEM, install: INSTALL });
		const retention = screen.getByLabelText("Metric retention (days)");
		await user.clear(retention);
		await user.type(retention, "90");
		await user.tab();
		expect(staged()).toHaveLength(1);

		await user.clear(retention);
		await user.type(retention, "30");
		await user.tab();
		expect(staged()).toEqual([]);
	});

	it("a switch stages at once", async () => {
		const user = userEvent.setup();
		renderForm({ ...BASE_ITEM, install: INSTALL });
		await user.click(screen.getByRole("switch", { name: "Bundle Grafana dashboards" }));
		expect(staged().map((o) => stagedValues(o))).toEqual([{ retentionDays: 30, grafana: false }]);
	});

	it("says why a value may not be staged, under the field, and stages nothing", async () => {
		const user = userEvent.setup();
		renderForm(BASE_ITEM);
		const retention = screen.getByLabelText("Metric retention (days)");
		await user.clear(retention);
		await user.type(retention, "0");
		await user.tab();

		expect(screen.getByRole("alert")).toHaveTextContent("Metric retention (days) is at least 1.");
		expect(retention).toHaveAttribute("aria-invalid", "true");
		expect(staged()).toEqual([]);
	});

	it("Discard takes the staged change off the changeset", async () => {
		const user = userEvent.setup();
		renderForm(BASE_ITEM);
		await user.click(screen.getByRole("button", { name: "Add to changes" }));
		await user.click(screen.getByRole("button", { name: "Discard" }));
		expect(staged()).toEqual([]);
		expect(screen.queryByRole("status")).not.toBeInTheDocument();
	});

	it("a typed secret is held in memory and never written into the operation", async () => {
		const user = userEvent.setup();
		renderForm(FIELD_TYPES_ITEM);
		await user.type(screen.getByLabelText("Root password"), "hunter2");
		await user.tab();

		const [operation] = staged();
		expect(JSON.stringify(operation)).not.toContain("hunter2");
		expect(stagedValues(operation)).toMatchObject({ rootPassword: "" });
		expect(operation?.input).toMatchObject({ secretPaths: ["rootPassword"] });
		expect(recallSecrets("addon:minio")).toEqual({ rootPassword: "hunter2" });
		// The field says a value is waiting; it does not show it again.
		expect(screen.getByText("Staged")).toBeInTheDocument();
	});

	it("reopens on what is staged, laid over what is installed", async () => {
		const user = userEvent.setup();
		const first = renderForm({ ...BASE_ITEM, install: INSTALL });
		const retention = screen.getByLabelText("Metric retention (days)");
		await user.clear(retention);
		await user.type(retention, "90");
		await user.tab();
		act(() => first.unmount());

		renderForm({ ...BASE_ITEM, install: INSTALL });
		expect(screen.getByLabelText("Metric retention (days)")).toHaveValue(90);
		expect(screen.getByRole("status")).toHaveTextContent("New settings staged.");
	});

	it("removing an add-on drops what was staged for it", async () => {
		const user = userEvent.setup();
		disableMut.mutateAsync.mockReset();
		disableMut.mutateAsync.mockResolvedValue(undefined);
		const onDone = vi.fn();
		render(
			<AddonConfigForm
				item={{ ...BASE_ITEM, install: INSTALL }}
				projectId="p1"
				environmentId="e1"
				hasAppsRepo
				provider={null}
				onDone={onDone}
			/>,
		);
		await user.click(screen.getByRole("switch", { name: "Bundle Grafana dashboards" }));
		expect(staged()).toHaveLength(1);

		await user.click(screen.getByRole("button", { name: /^remove$/i }));
		await user.click(screen.getByRole("button", { name: /remove add-on/i }));
		await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
		expect(staged()).toEqual([]);
	});
});

describe("AddonConfigCard", () => {
	/** What the add-ons query answers with. */
	function catalog(items: AddonMarketItem[]) {
		vi.mocked(useAddonsQuery).mockReturnValue({
			data: { items, hasAppsRepo: true },
			isPending: false,
		} as unknown as ReturnType<typeof useAddonsQuery>);
	}

	it("resolves the item by id from the add-ons query and renders its form", () => {
		catalog([BASE_ITEM]);
		render(<AddonConfigCard itemId={BASE_ITEM.id} projectId="p1" environmentId="e1" />);
		expect(screen.getByRole("heading", { name: "Prometheus + Grafana" })).toBeInTheDocument();
		expect(screen.getByText("Metric retention (days)")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Add to changes" })).toBeInTheDocument();
	});

	it("says so when the id names nothing in the catalog", () => {
		catalog([]);
		render(<AddonConfigCard itemId="gone" projectId="p1" environmentId="e1" />);
		expect(screen.getByText(/not in the catalog/i)).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Add to changes" })).not.toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
	});

	it("follows the query while nothing has been typed or staged", () => {
		catalog([BASE_ITEM]);
		const { rerender } = render(
			<AddonConfigCard itemId={BASE_ITEM.id} projectId="p1" environmentId="e1" />,
		);
		expect(screen.getByLabelText("Metric retention (days)")).toHaveValue(15);

		// A refetch lands with the add-on installed by someone else: nobody is typing, so the
		// subject shows what is installed now.
		catalog([{ ...BASE_ITEM, install: INSTALL }]);
		rerender(<AddonConfigCard itemId={BASE_ITEM.id} projectId="p1" environmentId="e1" />);
		expect(screen.getByRole("button", { name: "Remove" })).toBeInTheDocument();
		expect(screen.getByLabelText("Metric retention (days)")).toHaveValue(30);
	});

	// The add-ons query refetches on every `addons` hint. Following it while someone is typing
	// would mean a teammate (or the person's own second tab) reconfiguring the same add-on wiped
	// what was half-typed. Once a field has been typed into, the form keeps the row it started from.
	it("keeps the row it started from once a field has been typed into", async () => {
		const user = userEvent.setup();
		catalog([BASE_ITEM]);
		const { rerender } = render(
			<AddonConfigCard itemId={BASE_ITEM.id} projectId="p1" environmentId="e1" />,
		);
		const retention = screen.getByLabelText("Metric retention (days)");
		await user.clear(retention);
		await user.type(retention, "7");

		catalog([{ ...BASE_ITEM, install: INSTALL }]);
		rerender(<AddonConfigCard itemId={BASE_ITEM.id} projectId="p1" environmentId="e1" />);

		// The form is unchanged: it still belongs to the person typing in it.
		expect(screen.getByLabelText("Metric retention (days)")).toHaveValue(7);
		expect(screen.queryByRole("button", { name: "Remove" })).not.toBeInTheDocument();
	});

	it("starts again from the query once the staged change is gone", async () => {
		const user = userEvent.setup();
		catalog([BASE_ITEM]);
		const { rerender } = render(
			<AddonConfigCard itemId={BASE_ITEM.id} projectId="p1" environmentId="e1" />,
		);
		await user.click(screen.getByRole("button", { name: "Add to changes" }));
		expect(staged()).toHaveLength(1);

		// The change is applied elsewhere: the operation leaves the changeset and the query now
		// says the add-on is installed.
		catalog([{ ...BASE_ITEM, install: INSTALL }]);
		act(() => board.document.getState().unstageOperation("addon:kube-prometheus-stack"));
		rerender(<AddonConfigCard itemId={BASE_ITEM.id} projectId="p1" environmentId="e1" />);

		expect(screen.getByRole("button", { name: "Remove" })).toBeInTheDocument();
		expect(screen.getByLabelText("Metric retention (days)")).toHaveValue(30);
		expect(screen.queryByRole("status")).not.toBeInTheDocument();
	});
});
