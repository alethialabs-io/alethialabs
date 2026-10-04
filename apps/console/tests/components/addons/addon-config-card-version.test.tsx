// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #5525: the configure card's Chart version field. It is prefilled with the stored pin, shows the
// catalog default as its placeholder, sends the pin on submit, sends null when cleared (the reset),
// and refuses a range in the form with the same sentence the server would return.

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
	AddonInstallState,
	AddonMarketItem,
} from "@/app/server/actions/addons";
import { CHART_VERSION_REFUSAL } from "@/lib/addons/chart-version";

const { enableMut, disableMut } = vi.hoisted(() => ({
	enableMut: { mutateAsync: vi.fn(), isPending: false },
	disableMut: { mutateAsync: vi.fn(), isPending: false },
}));
vi.mock("@/lib/query/use-addons-query", () => ({
	useEnableAddon: () => enableMut,
	useDisableAddon: () => disableMut,
	useAddonsQuery: vi.fn(),
}));

import { AddonConfigForm } from "@/components/addons/addon-config-card";

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
	status: "READY",
	health: null,
	sync: null,
	lastSyncedAt: null,
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

/** The `version` the last enable mutation was called with. */
function sentVersion(): unknown {
	const call = enableMut.mutateAsync.mock.calls.at(-1)?.[0];
	return call && typeof call === "object" && "version" in call ? call.version : "<absent>";
}

beforeEach(() => {
	enableMut.mutateAsync.mockReset();
	enableMut.mutateAsync.mockResolvedValue({ ok: true });
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

	it("submits a pin", async () => {
		const user = userEvent.setup();
		const field = renderForm(ITEM);
		await user.type(field, "58.2.1");
		await user.click(screen.getByRole("button", { name: /enable add-on/i }));
		expect(enableMut.mutateAsync).toHaveBeenCalledTimes(1);
		expect(sentVersion()).toBe("58.2.1");
	});

	it("clearing the field sends null — the reset to the catalog default", async () => {
		const user = userEvent.setup();
		const field = renderForm({ ...ITEM, install: PINNED });
		await user.clear(field);
		await user.click(screen.getByRole("button", { name: /save changes/i }));
		expect(enableMut.mutateAsync).toHaveBeenCalledTimes(1);
		expect(sentVersion()).toBeNull();
	});

	it("an untouched pin is sent back unchanged", async () => {
		const user = userEvent.setup();
		renderForm({ ...ITEM, install: PINNED });
		await user.click(screen.getByRole("button", { name: /save changes/i }));
		expect(sentVersion()).toBe("58.2.1");
	});

	it("refuses a range in the form and sends nothing", async () => {
		const user = userEvent.setup();
		const field = renderForm(ITEM);
		await user.type(field, "^58");
		await user.click(screen.getByRole("button", { name: /enable add-on/i }));
		expect(await screen.findByRole("alert")).toHaveTextContent(CHART_VERSION_REFUSAL);
		expect(enableMut.mutateAsync).not.toHaveBeenCalled();
	});
});
