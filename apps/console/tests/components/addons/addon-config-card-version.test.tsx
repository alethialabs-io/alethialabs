// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #5525: the add-on subject's Chart version field. It is prefilled with the stored pin, shows the
// catalog default as its placeholder, stages the pin when the field is left, stages null when
// cleared (the reset), and refuses a range in the form with the same sentence the server would
// return. Staged, not sent: the operation runs when the changeset is applied (#6834).

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
	AddonInstallState,
	AddonMarketItem,
} from "@/app/server/actions/addons";
import { CHART_VERSION_REFUSAL } from "@/lib/addons/chart-version";

const { disableMut } = vi.hoisted(() => ({
	disableMut: { mutateAsync: vi.fn(), isPending: false },
}));
vi.mock("@/lib/query/use-addons-query", () => ({
	useDisableAddon: () => disableMut,
	useRequestGitopsBump: () => ({ mutate: () => {}, isPending: false }),
	useAddonsQuery: vi.fn(),
}));

import { AddonConfigForm } from "@/components/addons/addon-config-card";
import { board } from "@/lib/canvas/store/board";
import { useCanvasStore } from "@/lib/stores/use-canvas-store";

const ITEM: AddonMarketItem = {
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
	requires: [],
	fields: [],
	install: null,
};

const PINNED: AddonInstallState = {
	enabled: true,
	mode: "managed",
	values: {},
	valuesYaml: null,
	version: "58.2.1",
	status: "ACTIVE",
	health: null,
	sync: null,
	lastSyncedAt: null,
	gitopsBump: null,
};

/** Renders the form for `item`. */
function renderForm(item: AddonMarketItem) {
	render(
		<AddonConfigForm
			item={item}
			projectId="p1"
			environmentId="e1"
			hasAppsRepo
			provider={null}
			onDone={vi.fn()}
		/>,
	);
	return screen.getByLabelText("Chart version");
}

/** The operations staged in the document. */
const staged = () => board.document.getState().operations;

/** The `version` the staged operation carries. */
function stagedVersion(): unknown {
	const input = staged().at(-1)?.input;
	return input && typeof input === "object" && "version" in input ? input.version : "<absent>";
}

beforeEach(() => {
	useCanvasStore.getState().reset();
});

describe("AddonConfigForm — chart version", () => {
	it("prefills the stored pin and shows the catalog default as the placeholder", () => {
		const field = renderForm({ ...ITEM, install: PINNED });
		expect(field).toHaveValue("58.2.1");
		expect(field).toHaveAttribute("placeholder", "61.9.0");
	});

	it("is empty for an unpinned add-on", () => {
		const field = renderForm({ ...ITEM, install: { ...PINNED, version: null } });
		expect(field).toHaveValue("");
	});

	it("stages a pin when the field is left", async () => {
		const user = userEvent.setup();
		const field = renderForm(ITEM);
		await user.type(field, "58.2.1");
		expect(staged()).toEqual([]);
		await user.tab();
		expect(staged()).toHaveLength(1);
		expect(stagedVersion()).toBe("58.2.1");
		expect(staged()[0]?.summary).toBe("Install add-on Prometheus + Grafana at 58.2.1");
	});

	it("clearing the field stages null — the reset to the catalog default", async () => {
		const user = userEvent.setup();
		const field = renderForm({ ...ITEM, install: PINNED });
		await user.clear(field);
		await user.tab();
		expect(staged()).toHaveLength(1);
		expect(stagedVersion()).toBeNull();
	});

	it("an untouched pin stages nothing", async () => {
		const user = userEvent.setup();
		const field = renderForm({ ...ITEM, install: PINNED });
		await user.click(field);
		await user.tab();
		expect(staged()).toEqual([]);
	});

	it("refuses a range in the form and stages nothing", async () => {
		const user = userEvent.setup();
		const field = renderForm(ITEM);
		await user.type(field, "^58");
		await user.tab();
		expect(await screen.findByRole("alert")).toHaveTextContent(CHART_VERSION_REFUSAL);
		expect(field).toHaveAttribute("aria-invalid", "true");
		expect(staged()).toEqual([]);
	});
});
