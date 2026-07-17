// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Render-level guard for the W1 service config sheet: the real `service` KindConfig, driven through
// the generic ConfigFields renderer, must mount every section without a get/set closure throwing —
// including the bespoke Bindings editor — and the source discriminated union must gate the
// repo-only Build section (it drops away for a prebuilt image) and swap the repo/image fields.

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ConfigFields } from "@/components/design-project/canvas/inspector/config-fields";
import { getKindConfig } from "@/components/design-project/canvas/inspector/config-schema";

const SERVICE = getKindConfig("service");

const repoConfig = {
	name: "api",
	type: "deployment",
	replicas: 2,
	source: { kind: "repo", repo_url: "https://github.com/acme/api", path: "." },
	env: [],
	ports: [],
	bindings: [],
};
const imageConfig = {
	name: "api",
	type: "deployment",
	replicas: 2,
	source: { kind: "image", image: "ghcr.io/org/api:1.4.0" },
	env: [],
	ports: [],
	bindings: [],
};

/** Mount the real service sheet against the given config. */
function renderSheet(config: Record<string, unknown>) {
	render(
		<ConfigFields
			schema={SERVICE!}
			config={config}
			provider={null}
			onChange={vi.fn()}
		/>,
	);
}

describe("service config sheet (render)", () => {
	it("mounts every section of the real service schema", () => {
		renderSheet(repoConfig);
		// getAllByText: "Source" is both a section title and the source radio-card's label.
		for (const title of [
			"Identity",
			"Source",
			"Build",
			"Networking",
			"Environment",
			"Bindings",
			"Runtime",
			"Health",
		]) {
			expect(screen.getAllByText(title).length).toBeGreaterThan(0);
		}
	});

	it("renders the bespoke Bindings editor (its add affordance)", () => {
		renderSheet(repoConfig);
		expect(screen.getByText("Bind a resource")).toBeInTheDocument();
	});

	it("shows the repo URL for a repo source and keeps the Build section", () => {
		renderSheet(repoConfig);
		expect(screen.getByText("Repository URL")).toBeInTheDocument();
		expect(screen.getByText("Build")).toBeInTheDocument();
		expect(screen.queryByText("Image")).not.toBeInTheDocument();
	});

	it("drops the Build section and shows the Image field for a prebuilt image", () => {
		renderSheet(imageConfig);
		// Every Build field is repo-only, so the whole section renders nothing.
		expect(screen.queryByText("Build")).not.toBeInTheDocument();
		expect(screen.getByText("Image")).toBeInTheDocument();
		expect(screen.queryByText("Repository URL")).not.toBeInTheDocument();
	});
});
