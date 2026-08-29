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
import { useCanvasStore } from "@/lib/stores/use-canvas-store";

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
	useCanvasStore.setState({ nodes: [] });
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

// W5 — after a service is added the palette stays open and swaps to an inline config step (breadcrumb
// + essentials + "Full settings →"), so adding and configuring are one flow.
describe("NodePalette — W5 inline config step", () => {
	/** The bucket node just added by the flow under test. */
	function addedBucketId(): string | undefined {
		return useCanvasStore
			.getState()
			.nodes.find((n) => n.data.kind === "bucket")?.id;
	}

	it("adds the node and swaps to its config step without closing", async () => {
		seedCanvas("aws");
		const onOpenChange = vi.fn();
		render(<NodePalette open onOpenChange={onOpenChange} identities={[]} />);

		await userEvent.click(screen.getByText("Bucket"));

		// The node was added to the store...
		expect(addedBucketId()).toBeDefined();
		// ...the palette stayed open (never asked to close)...
		expect(onOpenChange).not.toHaveBeenCalledWith(false);
		// ...and it now shows the config step: breadcrumb, name field, and the two footer actions.
		expect(screen.getByText("Full settings")).toBeInTheDocument();
		expect(screen.getByText("Done")).toBeInTheDocument();
		// The name field for an array kind (targeted by its unique placeholder).
		expect(screen.getByPlaceholderText("name")).toBeInTheDocument();
	});

	it("reaches the config step through the variant picker", async () => {
		seedCanvas("aws");
		render(<NodePalette open onOpenChange={vi.fn()} identities={[]} />);

		await userEvent.click(screen.getByText("Database"));
		await userEvent.click(screen.getByText("PostgreSQL"));

		expect(screen.getByText("Full settings")).toBeInTheDocument();
		expect(
			useCanvasStore.getState().nodes.some((n) => n.data.kind === "database"),
		).toBe(true);
	});

	it("'Full settings' opens the inspector on the new node and closes the palette", async () => {
		seedCanvas("aws");
		const onOpenChange = vi.fn();
		render(<NodePalette open onOpenChange={onOpenChange} identities={[]} />);

		await userEvent.click(screen.getByText("Bucket"));
		const id = addedBucketId();
		await userEvent.click(screen.getByText("Full settings"));

		expect(useCanvasStore.getState().inspectorNodeId).toBe(id);
		expect(onOpenChange).toHaveBeenCalledWith(false);
	});

	it("'Done' closes the palette and keeps the node", async () => {
		seedCanvas("aws");
		const onOpenChange = vi.fn();
		render(<NodePalette open onOpenChange={onOpenChange} identities={[]} />);

		await userEvent.click(screen.getByText("Bucket"));
		await userEvent.click(screen.getByText("Done"));

		expect(onOpenChange).toHaveBeenCalledWith(false);
		expect(addedBucketId()).toBeDefined();
	});

	it("the breadcrumb returns to the catalog with the node kept", async () => {
		seedCanvas("aws");
		render(<NodePalette open onOpenChange={vi.fn()} identities={[]} />);

		await userEvent.click(screen.getByText("Bucket"));
		// Back via the breadcrumb.
		await userEvent.click(screen.getByText("Add a service"));

		// The catalog is shown again (a sibling service is back), and the added node persists.
		expect(screen.getByText("Database")).toBeInTheDocument();
		expect(addedBucketId()).toBeDefined();
	});
});
