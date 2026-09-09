// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The add-on config card renders the catalog item's schema'd knobs + delivery mode, and switches
// its footer between Enable/Cancel (not installed) and Save/Remove (installed). The enable/disable
// mutation hooks are mocked so the test never touches the server actions.

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type {
	AddonInstallState,
	AddonMarketItem,
} from "@/app/server/actions/addons";

const { enableMut, disableMut } = vi.hoisted(() => ({
	enableMut: { mutateAsync: vi.fn(), isPending: false },
	disableMut: { mutateAsync: vi.fn(), isPending: false },
}));
vi.mock("@/lib/query/use-addons-query", () => ({
	useEnableAddon: () => enableMut,
	useDisableAddon: () => disableMut,
	useAddonsQuery: vi.fn(),
}));

import { AddonConfigCard, AddonConfigForm } from "@/components/addons/addon-config-card";
import { useAddonsQuery } from "@/lib/query/use-addons-query";

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
	status: "PENDING",
	health: null,
	sync: null,
	lastSyncedAt: null,
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
		// Not installed → Enable + Cancel, never Remove.
		expect(
			screen.getByRole("button", { name: /enable add-on/i }),
		).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /cancel/i })).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: /remove/i }),
		).not.toBeInTheDocument();
	});

	it("shows Save + Remove for an installed add-on", () => {
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
		expect(
			screen.getByRole("button", { name: /save changes/i }),
		).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /remove/i })).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: /enable add-on/i }),
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

describe("AddonConfigCard", () => {
	it("resolves the item by id from the add-ons query and renders its form", () => {
		vi.mocked(useAddonsQuery).mockReturnValue({
			data: { items: [BASE_ITEM], hasAppsRepo: true },
			isPending: false,
		} as unknown as ReturnType<typeof useAddonsQuery>);
		render(<AddonConfigCard itemId={BASE_ITEM.id} projectId="p1" environmentId="e1" />);
		expect(screen.getByText("Metric retention (days)")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /enable add-on/i })).toBeInTheDocument();
	});

	it("says so when the id names nothing in the catalog", () => {
		vi.mocked(useAddonsQuery).mockReturnValue({
			data: { items: [], hasAppsRepo: false },
			isPending: false,
		} as unknown as ReturnType<typeof useAddonsQuery>);
		render(<AddonConfigCard itemId="gone" projectId="p1" environmentId="e1" />);
		expect(screen.getByText(/not in the catalog/i)).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: /enable add-on/i })).not.toBeInTheDocument();
	});

	// The add-ons query polls every 15s and the form seeds react-hook-form through `values`, which
	// re-`reset()`s whenever that object deep-changes. Resolving the item live meant a teammate (or
	// the user's own second tab) enabling the same add-on would silently wipe whatever was being
	// typed. The Sheet this card replaced captured the item at click time and could not do that.
	it("keeps the row it opened with, so a background refetch cannot reset the open form", () => {
		vi.mocked(useAddonsQuery).mockReturnValue({
			data: { items: [BASE_ITEM], hasAppsRepo: true },
			isPending: false,
		} as unknown as ReturnType<typeof useAddonsQuery>);
		const { rerender } = render(
			<AddonConfigCard itemId={BASE_ITEM.id} projectId="p1" environmentId="e1" />,
		);
		// Not installed → the footer offers Enable.
		expect(screen.getByRole("button", { name: /enable add-on/i })).toBeInTheDocument();

		// A poll lands with the SAME add-on now installed by someone else.
		vi.mocked(useAddonsQuery).mockReturnValue({
			data: { items: [{ ...BASE_ITEM, install: INSTALL }], hasAppsRepo: true },
			isPending: false,
		} as unknown as ReturnType<typeof useAddonsQuery>);
		rerender(<AddonConfigCard itemId={BASE_ITEM.id} projectId="p1" environmentId="e1" />);

		// The form is unchanged: it still belongs to the person typing in it.
		expect(screen.getByRole("button", { name: /enable add-on/i })).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: /remove/i })).not.toBeInTheDocument();
	});
});
