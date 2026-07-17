// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// DeployPane render checks (#574) across the scenario matrix. These assert the
// fail-loud CONTRACT of the surface, not pixel styling: what the rollup says, when
// the banner appears, and that a failed wiring never renders a stale healthy row.

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DeployPane } from "@/components/agent/deploy-pane";
import type { GitopsDeployStatus } from "@/lib/gitops/deploy-status";

/** A healthy gitops-mode status the scenarios below override. */
function base(overrides: Partial<GitopsDeployStatus> = {}): GitopsDeployStatus {
	return {
		mode: "gitops",
		appsRepo: "https://github.com/acme/apps",
		argocdApp: "apps",
		argocdUrl: "https://argocd.acme.example.com",
		revision: "9f8e7d6c5b4a39281706",
		lastDeployAt: new Date().toISOString(),
		lastDeployFailed: false,
		failedStep: null,
		failureMessage: null,
		statusAvailable: true,
		services: [
			{ name: "api-gateway", health: "Healthy", sync: "Synced", message: null },
			{
				name: "checkout-web",
				health: "Degraded",
				sync: "Synced",
				message: "Deployment exceeded its progress deadline",
			},
		],
		addons: [
			{ name: "kube-prometheus-stack", health: "Healthy", sync: "Synced", message: null },
		],
		dataServices: [
			{ name: "db-primary", health: "Healthy", sync: "Synced", message: null },
		],
		warnings: [],
		...overrides,
	};
}

describe("DeployPane", () => {
	it("mixed: rollup counts, wiring rows, per-service message, short revision", () => {
		render(<DeployPane status={base()} />);
		expect(screen.getByText("4 components · 1 degraded")).toBeDefined();
		expect(screen.getByText("GitOps-managed")).toBeDefined();
		expect(screen.getByText("9f8e7d6")).toBeDefined(); // short SHA
		expect(screen.getByText("Deployment exceeded its progress deadline")).toBeDefined();
		expect(screen.queryByText(/GitOps deploy failed/)).toBeNull();
	});

	it("manifest warnings: rendered in a Warnings section + counted in the rollup (#719)", () => {
		const warning =
			'binding facet "endpoint" (env DB_HOST) for api→database/orders-db could not be resolved — env omitted';
		render(<DeployPane status={base({ warnings: [warning] })} />);
		expect(screen.getByText(warning)).toBeDefined();
		expect(screen.getByText(/Warnings · 1/)).toBeDefined();
		// The rollup gains a warning count (base has 1 degraded component).
		expect(screen.getByText("4 components · 1 degraded · 1 warning")).toBeDefined();
	});

	it("no Warnings section when the deploy generated cleanly", () => {
		render(<DeployPane status={base({ warnings: [] })} />);
		expect(screen.queryByText(/Warnings ·/)).toBeNull();
	});

	it("failed FIRST deploy: banner with step + fix hint, all rows Unknown", () => {
		// A first deploy that died in the wiring: no add-on/data-service health exists
		// yet either, so nothing on the pane may read Healthy (the fail-loud rule).
		// (After a LATER failed re-deploy, add-ons keep their own day-2-refreshed rows.)
		render(
			<DeployPane
				status={base({
					lastDeployFailed: true,
					failedStep: "git_token",
					failureMessage:
						"GitOps requested (apps repo …) but no git access token is available",
					statusAvailable: false,
					revision: null,
					services: [
						{ name: "api-gateway", health: "Unknown", sync: "Unknown", message: null },
					],
					addons: [
						{
							name: "kube-prometheus-stack",
							health: "Unknown",
							sync: "Unknown",
							message: null,
						},
					],
					dataServices: [],
				})}
			/>,
		);
		expect(
			screen.getByText("status unavailable · deploy failed before the health read"),
		).toBeDefined();
		expect(screen.getByText(/GitOps deploy failed · git_token/)).toBeDefined();
		expect(screen.getByText(/Reconnect the git provider/)).toBeDefined();
		// The fail-loud rule: no healthy service badge may render.
		expect(screen.queryByText("Healthy")).toBeNull();
	});

	it("direct mode: direct wiring rows + the services empty-state", () => {
		render(
			<DeployPane
				status={base({
					mode: "direct",
					appsRepo: null,
					argocdApp: null,
					revision: null,
					services: [],
				})}
			/>,
		);
		expect(screen.getByText("Direct apply")).toBeDefined();
		expect(screen.getByText("— none —")).toBeDefined();
		expect(
			screen.getByText("No apps repo — services are not GitOps-managed in this environment."),
		).toBeDefined();
	});

	it("pre-#574: degradation hint, no banner", () => {
		render(
			<DeployPane
				status={base({
					statusAvailable: false,
					revision: null,
					services: [
						{ name: "api-gateway", health: "Unknown", sync: "Unknown", message: null },
					],
				})}
			/>,
		);
		expect(
			screen.getByText("status unavailable · last deploy predates the health read"),
		).toBeDefined();
		expect(screen.getByText(/re-deploy \(or wait for the next drift scan\)/)).toBeDefined();
		expect(screen.queryByText(/GitOps deploy failed/)).toBeNull();
	});
});
