// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// CON-PB2, R6 C-24. The runners page's Region facet filters on `location` for every runner, but
// the card showed it for managed runners only, so a self-hosted runner the facet matched read "—".
// The default star also carries a text name, not only an icon.

import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/components/runners/runner-actions", () => ({
	RunnerActions: () => null,
	RunnerVersion: () => null,
	runnerBusyKind: () => null,
}));
vi.mock("@/components/classification/classification-control", () => ({
	ClassificationControl: () => null,
}));
vi.mock("@/lib/stores/use-workspace-store", () => ({ useActiveOrgSlug: () => "acme" }));

import type { RunnerRow } from "@/components/runners/runner-actions";
import { RunnerCard } from "@/components/runners/runner-card";

/** A registered self runner row. */
function row(overrides: Partial<RunnerRow>): RunnerRow {
	return {
		id: "r1",
		name: "build-box",
		operator: "self",
		provisioning: "registered",
		supported_providers: null,
		status: "ONLINE",
		last_heartbeat: null,
		version: null,
		location: null,
		is_default: false,
		in_place: false,
		cloud_instance_id: null,
		runner_releases: null,
		provisioned_hours: null,
		personal_elsewhere: false,
		active_job: null,
		...overrides,
	};
}

/** The Region fact's value node. */
function region(): HTMLElement {
	const label = screen.getByText("Region");
	const fact = label.parentElement;
	if (fact === null) throw new Error("the Region fact has no container");
	return fact;
}

describe("RunnerCard region (R6 C-24)", () => {
	it("a self-hosted runner shows the location the Region facet filters on", () => {
		render(<RunnerCard runner={row({ location: "eu-central-1" })} />);
		expect(within(region()).getByText("eu-central-1")).toBeInTheDocument();
	});

	it("a runner with no location says it was not reported, not a bare dash", () => {
		render(<RunnerCard runner={row({})} />);
		expect(within(region()).getByText("Not reported")).toBeInTheDocument();
		expect(within(region()).queryByText("—")).toBeNull();
	});

	it("the default star has a text name", () => {
		render(<RunnerCard runner={row({ is_default: true })} />);
		expect(screen.getByText("Default runner")).toBeInTheDocument();
	});
});
