// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The add picker and the command palette list what `addCatalogue` says, and nothing else (#6832).
//
// They used to build their own lists and disagreed: the picker had add-ons and roadmap rows, the
// palette had the bring-your-own sources, and a kind the project's cloud cannot back was simply
// absent from both. So two things are asserted. The two surfaces offer the SAME design kinds, for
// every cloud the catalog knows. And a row this board cannot take is still listed, disabled, with
// the reason in the row — for a cloud that cannot back the kind, and for an environment a
// bring-your-own IaC module governs.

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NodeKind } from "@/components/design-project/canvas/graph/types";
import type { CloudProvider } from "@/lib/db/schema/enums";

/** The kind the fixture cloud cannot back, and the cloud. Read by the hoisted mock below. */
const blocked = vi.hoisted((): { provider: string; kinds: string[] } => ({
	provider: "hetzner",
	kinds: ["topic"],
}));

vi.mock("@/lib/cloud-providers/unsupported-kinds", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/cloud-providers/unsupported-kinds")>();
	return {
		...actual,
		unsupportedKindsFor: (provider: CloudProvider | null): readonly NodeKind[] => [
			...actual.unsupportedKindsFor(provider),
			...(provider === blocked.provider ? blockedKinds() : []),
		],
	};
});

import { CanvasCommandPalette } from "@/components/design-project/canvas/canvas-command-palette";
import { NODE_REGISTRY } from "@/components/design-project/canvas/graph/node-registry";
import { NodePalette } from "@/components/design-project/canvas/node-palette";
import {
	GOVERNED_REASON,
	GOVERNED_ROW_REASON,
	notOnCloud,
} from "@/components/design-project/canvas/toolbar/reasons";
import { addCatalogue, catalogueKinds } from "@/lib/canvas/store/add-catalogue";
import { getProvider, type CloudProviderSlug } from "@/lib/cloud-providers";
import { CLOUD_PROVIDER_SLUGS, isCloudProviderSlug } from "@/lib/cloud-providers/provider-slug";
import { board } from "@/lib/canvas/store/board";
import { boardNodes, setBoardNodes } from "@/tests/fixtures/canvas/board";

/** The fixture's blocked kinds, as node kinds. */
function blockedKinds(): NodeKind[] {
	return blocked.kinds.filter((kind): kind is NodeKind => kind in NODE_REGISTRY);
}

/** Seeds the board with a project root on `provider` (null = no cloud chosen yet). */
function seedProject(provider: CloudProviderSlug | null) {
	setBoardNodes([
			{
				id: "project-root",
				type: "project",
				position: { x: 0, y: 0 },
				data: {
					kind: "project",
					config: {
						project_name: "demo",
						environment_stage: "development",
						region: "",
						iac_version: "1.11.4",
					},
					cloud_identity_id: null,
					provider,
				},
			},
		]);
}

/** The option row that shows `label`, in whichever surface is open. */
function option(label: string): HTMLElement {
	const row = screen.getByText(label).closest('[data-slot="command-item"]');
	if (!(row instanceof HTMLElement)) throw new Error(`no row for ${label}`);
	return row;
}

/** Every cloud a project can be designed on, from the catalog, and no cloud at all. */
const CLOUDS: (CloudProviderSlug | null)[] = [null, ...CLOUD_PROVIDER_SLUGS];

beforeEach(() => {
	board.reset();
});

describe("the add picker and the command palette read one catalogue", () => {
	it.each(CLOUDS)("offer the same design kinds on %s", (provider) => {
		seedProject(provider);
		const kinds = catalogueKinds(addCatalogue(provider, { byoHelm: false, byoIac: false }, false));
		expect(kinds.length).toBeGreaterThan(0);

		// The picker: one enabled row per kind.
		const picker = render(<NodePalette open onOpenChange={vi.fn()} identities={[]} />);
		const pickerOffered = kinds.filter(
			(kind) => option(NODE_REGISTRY[kind].label).getAttribute("aria-disabled") !== "true",
		);
		picker.unmount();

		// The palette: one "Add <kind>" row per kind, and no other "Add" row.
		render(
			<CanvasCommandPalette
				open
				onOpenChange={vi.fn()}
				onFitView={vi.fn()}
				onAskAi={vi.fn()}
				onArrange={vi.fn()}
			/>,
		);
		const paletteOffered = screen
			.getAllByText(/^Add /)
			.map((el) => el.textContent ?? "")
			.sort();

		expect(pickerOffered).toEqual(kinds);
		expect(paletteOffered).toEqual(kinds.map((kind) => `Add ${NODE_REGISTRY[kind].label}`).sort());
	});
});

describe("a row this board cannot take is listed, disabled, with the reason", () => {
	it("a kind the project's cloud cannot back says so, and cannot be added", async () => {
		const user = userEvent.setup();
		const provider = blocked.provider;
		if (!isCloudProviderSlug(provider)) throw new Error("the fixture cloud is not in the catalog");
		seedProject(provider);
		render(<NodePalette open onOpenChange={vi.fn()} identities={[]} />);

		for (const kind of blockedKinds()) {
			const row = option(NODE_REGISTRY[kind].label);
			expect(row).toHaveAttribute("aria-disabled", "true");
			expect(row).toHaveTextContent(notOnCloud(getProvider(provider).name));
			await user.click(row);
		}
		// A kind the cloud does back is live beside it.
		expect(option(NODE_REGISTRY.bucket.label)).not.toHaveAttribute("aria-disabled", "true");
		// Nothing was added by pressing the disabled rows.
		expect(boardNodes().map((n) => n.data.kind)).toEqual(["project"]);
	});

	it("lists that kind as available on a cloud that backs it", () => {
		seedProject(null);
		render(<NodePalette open onOpenChange={vi.fn()} identities={[]} />);
		for (const kind of blockedKinds()) {
			expect(option(NODE_REGISTRY[kind].label)).not.toHaveAttribute("aria-disabled", "true");
		}
	});

	it("under a governing IaC module every row is listed and none can be picked", async () => {
		const user = userEvent.setup();
		const onAttachChart = vi.fn();
		seedProject(null);
		render(
			<NodePalette
				open
				onOpenChange={vi.fn()}
				identities={[]}
				onAttachChart={onAttachChart}
				governed
			/>,
		);

		// The full sentence once, above the rows; the short form in each row.
		expect(screen.getByRole("note")).toHaveTextContent(GOVERNED_REASON);
		const bucket = option(NODE_REGISTRY.bucket.label);
		expect(bucket).toHaveAttribute("aria-disabled", "true");
		expect(bucket).toHaveTextContent(GOVERNED_ROW_REASON);
		const chart = option("Helm chart");
		expect(chart).toHaveAttribute("aria-disabled", "true");

		await user.click(bucket);
		await user.click(chart);
		expect(onAttachChart).not.toHaveBeenCalled();
		expect(boardNodes().map((n) => n.data.kind)).toEqual(["project"]);
	});
});

describe("the bring-your-own sources are rows of the add picker", () => {
	it("lists a source only when its flow is wired, and picking it opens that flow and closes the picker", async () => {
		const user = userEvent.setup();
		const onOpenChange = vi.fn();
		const onAttachIac = vi.fn();
		seedProject(null);
		render(
			<NodePalette open onOpenChange={onOpenChange} identities={[]} onAttachIac={onAttachIac} />,
		);

		const sources = screen.getByText("Sources").closest('[data-slot="command-group"]');
		if (!(sources instanceof HTMLElement)) throw new Error("no Sources group");
		expect(within(sources).getByText("Infrastructure as code")).toBeInTheDocument();
		// The chart flow was not wired, so it has no row.
		expect(screen.queryByText("Helm chart")).not.toBeInTheDocument();

		await user.click(option("Infrastructure as code"));
		expect(onAttachIac).toHaveBeenCalledTimes(1);
		expect(onOpenChange).toHaveBeenCalledWith(false);
	});

	it("has no Sources group when neither flow is wired", () => {
		seedProject(null);
		render(<NodePalette open onOpenChange={vi.fn()} identities={[]} />);
		expect(screen.queryByText("Sources")).not.toBeInTheDocument();
	});
});
