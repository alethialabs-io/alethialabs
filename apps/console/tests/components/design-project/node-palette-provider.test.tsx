// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The Add palette derives its service groups from the node registry and filters them by the
// project root's effective provider (addableKindsFor) — the same gate the ⌘K menu and canvas
// controls use. Hetzner now refuses NO kind (nosql, the last one, left with #3228), so the filter's
// current job is to be a no-op — and that is asserted by rendering both providers and comparing the
// kind rows, rather than by re-listing labels a reader would have to trust.

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NodePalette } from "@/components/design-project/canvas/node-palette";
import type { CanvasNode } from "@/components/design-project/canvas/graph/types";
import type { CloudProviderSlug } from "@/lib/cloud-providers";
import { selectInspectorNodeId, useCanvasStore } from "@/lib/stores/use-canvas-store";
import { useInspectorPrefsStore } from "@/lib/stores/use-inspector-prefs-store";

/** Builds a minimal project-root node whose `provider` drives the palette's kind filter. */
function projectRoot(provider: CloudProviderSlug | null): CanvasNode<"project"> {
	return {
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
	};
}

/** Seeds the canvas store with a lone project root on the given provider. */
function seedCanvas(provider: CloudProviderSlug | null) {
	const nodes: CanvasNode[] = [projectRoot(provider)];
	useCanvasStore.setState({ nodes });
}

/** Renders the palette open, with no identities/add-ons (the create flow). */
function renderPalette() {
	return render(<NodePalette open onOpenChange={vi.fn()} identities={[]} />);
}

beforeEach(() => {
	useCanvasStore.setState({ nodes: [], card: null });
	// The remembered tab is a persisted, per-kind preference, so a test that asserts the add RECORDED
	// it has to start from a state where it was not already recorded — otherwise it passes on the
	// previous test's write.
	useInspectorPrefsStore.setState({ tab: {} });
});

describe("NodePalette — per-provider kind filtering", () => {
	it("offers every kind on a Hetzner project, nosql included", () => {
		seedCanvas("hetzner");
		renderPalette();

		// nosql was the LAST kind Hetzner refused, and it is offered now (#3228). ScyllaDB always
		// fitted the kind — what blocked it was cert-manager's install gate, which now answers
		// "does the CONTROLLER install" separately from "can it ISSUE".
		//
		// Asserted POSITIVELY. The previous version of this test asserted an ABSENCE, which is why
		// it survived the change that made the absence wrong: `queryByText(...).not.toBeInTheDocument()`
		// passes just as happily when the label is renamed, the palette fails to render, or the
		// component throws — three states that have nothing to do with the claim.
		expect(screen.getByText("NoSQL table")).toBeInTheDocument();
		// Topic IS offered: it maps to an in-cluster NATS release with JetStream.
		expect(screen.getByText("Topic")).toBeInTheDocument();

		// Registry is addable since #2431: an in-cluster Harbor with a minted pull robot and a
		// Talos containerd mirror, so the kind is delivered rather than hidden.
		expect(screen.getByText("Container registry")).toBeInTheDocument();

		// Bucket is NATIVE on Hetzner now (Object Storage via the minio provider) — addable.
		expect(screen.getByText("Bucket")).toBeInTheDocument();

		// The supported catalog still renders.
		expect(screen.getByText("Database")).toBeInTheDocument();
		expect(screen.getByText("Cache")).toBeInTheDocument();
		expect(screen.getByText("Queue")).toBeInTheDocument();
		// W2 — cluster (+ network) are env settings now, not addable board cards.
		expect(screen.queryByText("Cluster")).not.toBeInTheDocument();
	});

	it("shows the full catalog (groups + roadmap rows) on an AWS project", () => {
		seedCanvas("aws");
		renderPalette();

		expect(screen.getByText("Topic")).toBeInTheDocument();
		expect(screen.getByText("NoSQL table")).toBeInTheDocument();

		// Every group heading renders in the registry-declared order. W2 dropped "Compute" — its only
		// kind was the cluster, now an env setting; "Networking" survives on `dns`.
		for (const heading of [
			"Data",
			"Storage",
			"Messaging",
			"Security",
			"Networking",
			"DevOps",
		]) {
			expect(screen.getByText(heading)).toBeInTheDocument();
		}
		expect(screen.queryByText("Compute")).not.toBeInTheDocument();

		// Bucket + Container registry are now real addable kinds (not roadmap rows).
		expect(screen.getByText("Bucket")).toBeInTheDocument();
		expect(screen.getByText("Container registry")).toBeInTheDocument();
		// Volume is the only remaining roadmap ("Soon") row.
		expect(screen.getByText("Volume")).toBeInTheDocument();
		expect(screen.getAllByText("Soon")).toHaveLength(1);
	});

	it("shows the full catalog when no provider is picked yet (null → unfiltered)", () => {
		seedCanvas(null);
		renderPalette();

		expect(screen.getByText("Topic")).toBeInTheDocument();
		expect(screen.getByText("NoSQL table")).toBeInTheDocument();
	});
});

describe("NodePalette — per-provider variant filtering", () => {
	it("offers only the PostgreSQL database variant on a Hetzner project", async () => {
		seedCanvas("hetzner");
		renderPalette();

		await userEvent.click(screen.getByText("Database"));

		// The variant step is provider-filtered: CloudNativePG is PostgreSQL-only, so
		// MySQL must not be offered (picking it would silently deploy no database).
		expect(screen.getByText("PostgreSQL")).toBeInTheDocument();
		expect(screen.queryByText("MySQL")).not.toBeInTheDocument();
	});

	it("offers only the Valkey cache variant on a Hetzner project", async () => {
		seedCanvas("hetzner");
		renderPalette();

		await userEvent.click(screen.getByText("Cache"));

		// The in-cluster chart is Valkey; offering "Redis" would deploy Valkey anyway.
		expect(screen.getByText("Valkey")).toBeInTheDocument();
		expect(screen.queryByText("Redis")).not.toBeInTheDocument();
	});

	it("keeps the full variant lists on an AWS project", async () => {
		seedCanvas("aws");
		renderPalette();

		await userEvent.click(screen.getByText("Database"));
		expect(screen.getByText("PostgreSQL")).toBeInTheDocument();
		expect(screen.getByText("MySQL")).toBeInTheDocument();
	});
});

// #4589 — picking a service CLOSES the palette and hands off to that node's card on the workspace
// rail. It used to stay open on an inline "Configure service" step (W5) with `Done` / `Full settings
// →`, which is the modal this describe block used to pin: a `CommandDialog` parked over the board,
// a second editor for a config the rail's Settings tab already owns, and — because that step has no
// search box — a `toBeHidden()` in the gate spec that passed on the STEP CHANGE while the dialog
// went on intercepting every click. What replaced it is not a new mechanism: `addNode` already put
// the node's card on the rail, so the palette's whole remaining job after a pick is to get out of
// the way and say which tab that card opens on.
describe("NodePalette — handing off to the rail", () => {
	/** The bucket node just added by the flow under test. */
	function addedBucketId(): string | undefined {
		return useCanvasStore
			.getState()
			.nodes.find((n) => n.data.kind === "bucket")?.id;
	}

	it("adds the node, opens its card on the rail, and closes", async () => {
		seedCanvas("aws");
		const onOpenChange = vi.fn();
		render(<NodePalette open onOpenChange={onOpenChange} identities={[]} />);

		await userEvent.click(screen.getByText("Bucket"));

		// The node was added to the store...
		const id = addedBucketId();
		expect(id).toBeDefined();
		// ...its card is what the rail is showing...
		expect(selectInspectorNodeId(useCanvasStore.getState())).toBe(id);
		// ...and the palette asked to close rather than swapping to a step of its own.
		expect(onOpenChange).toHaveBeenCalledWith(false);
	});

	it("leaves no inline config step behind — no Done, no Full settings", async () => {
		seedCanvas("aws");
		render(<NodePalette open onOpenChange={vi.fn()} identities={[]} />);

		await userEvent.click(screen.getByText("Bucket"));

		// The negative form of the claim, and the one worth asserting: these two buttons ARE the
		// second step. `open` is still true here (the parent owns it), so if the step were still
		// rendered this would find it.
		expect(screen.queryByText("Done")).not.toBeInTheDocument();
		expect(screen.queryByText("Full settings")).not.toBeInTheDocument();
	});

	it("lands the card on Settings, where the inline step's fields already live", async () => {
		seedCanvas("aws");
		render(<NodePalette open onOpenChange={vi.fn()} identities={[]} />);

		await userEvent.click(screen.getByText("Bucket"));

		// The inline step showed the kind's essentials. Those are the rail card's Settings tab, so
		// the add records that tab for the kind rather than reproducing the form.
		expect(useInspectorPrefsStore.getState().tab.bucket).toBe("settings");
	});

	it("hands off through the variant picker too", async () => {
		seedCanvas("aws");
		const onOpenChange = vi.fn();
		render(<NodePalette open onOpenChange={onOpenChange} identities={[]} />);

		// The variant step is the one nested step left: it names WHICH service is being added, so it
		// still precedes the add. Everything after the add happens on the rail.
		await userEvent.click(screen.getByText("Database"));
		await userEvent.click(screen.getByText("PostgreSQL"));

		const db = useCanvasStore.getState().nodes.find((n) => n.data.kind === "database");
		expect(db).toBeDefined();
		expect(selectInspectorNodeId(useCanvasStore.getState())).toBe(db?.id);
		expect(onOpenChange).toHaveBeenCalledWith(false);
		expect(useInspectorPrefsStore.getState().tab.database).toBe("settings");
	});
});
