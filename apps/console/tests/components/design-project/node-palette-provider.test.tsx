// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The Add palette derives its service groups from the node registry and filters them by the
// project root's effective provider (addableKindsFor) — the same gate the ⌘K menu and canvas
// controls use. On Hetzner, topic (SNS-like) and nosql (DynamoDB-like) have no backing service,
// so their rows must be absent; on AWS the full catalog (plus the "Soon" roadmap rows) renders.

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
	it("hides topic and nosql on a Hetzner project", () => {
		seedCanvas("hetzner");
		renderPalette();

		expect(screen.queryByText("Topic")).not.toBeInTheDocument();
		expect(screen.queryByText("NoSQL table")).not.toBeInTheDocument();

		// The supported catalog still renders.
		expect(screen.getByText("Database")).toBeInTheDocument();
		expect(screen.getByText("Cache")).toBeInTheDocument();
		expect(screen.getByText("Queue")).toBeInTheDocument();
		expect(screen.getByText("Cluster")).toBeInTheDocument();
	});

	it("shows the full catalog (groups + roadmap rows) on an AWS project", () => {
		seedCanvas("aws");
		renderPalette();

		expect(screen.getByText("Topic")).toBeInTheDocument();
		expect(screen.getByText("NoSQL table")).toBeInTheDocument();

		// Every group heading renders in the registry-declared order.
		for (const heading of [
			"Data",
			"Storage",
			"Messaging",
			"Security",
			"Networking",
			"Compute",
			"DevOps",
		]) {
			expect(screen.getByText(heading)).toBeInTheDocument();
		}

		// Roadmap ("Soon") rows are still present and disabled.
		expect(screen.getByText("Bucket")).toBeInTheDocument();
		expect(screen.getByText("Volume")).toBeInTheDocument();
		expect(screen.getByText("Container registry")).toBeInTheDocument();
		expect(screen.getAllByText("Soon")).toHaveLength(3);
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
