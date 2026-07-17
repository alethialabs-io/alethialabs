// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The #574 scenario matrix, locked: healthy / mixed / failed-wiring / direct / pre-#574.
// assembleGitopsDeployStatus is the ONE assembly both surfaces (Deploy tab + canvas
// badges) read — these tests are the fail-loud contract ("wiring failed ⇒ Unknown,
// never a stale pass") in executable form.

import { describe, expect, it } from "vitest";
import {
	assembleGitopsDeployStatus,
	gitopsStatusReportSchema,
	type GitopsAssemblyInputs,
	type GitopsJobFacts,
} from "@/lib/gitops/deploy-status";

/** A successful gitops-mode DEPLOY job carrying a full snapshot. */
function successDeploy(overrides: Partial<GitopsJobFacts> = {}): GitopsJobFacts {
	return {
		status: "SUCCESS",
		errorMessage: null,
		createdAt: new Date("2026-07-16T10:00:00Z"),
		gitops: {
			mode: "gitops",
			apps_repo: "https://github.com/acme/apps",
			argocd_app: "apps",
			revision: "9f8e7d6c5b4a",
			app_health: { health: "Healthy", sync: "Synced" },
			services: {
				"api-gateway": { health: "Healthy", sync: "Synced" },
				"checkout-web": {
					health: "Degraded",
					sync: "Synced",
					message: "Deployment exceeded its progress deadline",
				},
				"orders-worker": { health: "Healthy", sync: "OutOfSync" },
			},
		},
		addonStatus: {
			"addon-kube-prometheus-stack": { health: "Healthy", sync: "Synced" },
			"addon-db-primary": { health: "Healthy", sync: "Synced" },
			"addon-cache-main": { health: "Unknown", sync: "Unknown" },
		},
		...overrides,
	};
}

const BASE: GitopsAssemblyInputs = {
	appsRepo: "https://github.com/acme/apps",
	argocdUrl: "https://argocd.acme.example.com",
	lastDeployedAt: new Date("2026-07-16T10:00:00Z"),
	deployJob: successDeploy(),
	driftJob: null,
	designedServices: ["api-gateway", "checkout-web", "orders-worker"],
	addonRows: [
		{ addonId: "kube-prometheus-stack", health: "Healthy", sync: "Synced", message: null },
		{ addonId: "loki", health: "Progressing", sync: "Synced", message: "Rollout in progress" },
	],
};

describe("assembleGitopsDeployStatus", () => {
	it("mixed: real per-service health, revision, and data-service rows", () => {
		const s = assembleGitopsDeployStatus(BASE);
		expect(s.mode).toBe("gitops");
		expect(s.statusAvailable).toBe(true);
		expect(s.revision).toBe("9f8e7d6c5b4a");
		expect(s.failedStep).toBeNull();
		expect(s.services).toHaveLength(3);
		const checkout = s.services.find((r) => r.name === "checkout-web");
		expect(checkout).toMatchObject({
			health: "Degraded",
			sync: "Synced",
			message: "Deployment exceeded its progress deadline",
		});
		expect(s.addons.map((r) => r.name)).toEqual(["kube-prometheus-stack", "loki"]);
		// Data services come from the addon-db-/cache-/queue- metadata keys, prefix-stripped.
		expect(s.dataServices.map((r) => r.name)).toEqual(["cache-main", "db-primary"]);
	});

	it("failed wiring: banner facts set, services Unknown — never a stale pass", () => {
		const s = assembleGitopsDeployStatus({
			...BASE,
			deployJob: {
				status: "FAILED",
				errorMessage: "GitOps requested (apps repo …) but no git access token is available",
				createdAt: new Date("2026-07-16T11:00:00Z"),
				gitops: {
					mode: "gitops",
					apps_repo: "https://github.com/acme/apps",
					argocd_app: "apps",
					failed_step: "git_token",
					error:
						"GitOps requested (apps repo https://github.com/acme/apps) but no git access token is available — reconnect the git provider for this project",
				},
				addonStatus: null,
			},
		});
		expect(s.lastDeployFailed).toBe(true);
		expect(s.failedStep).toBe("git_token");
		expect(s.failureMessage).toContain("reconnect the git provider");
		expect(s.statusAvailable).toBe(false);
		// Every designed service still gets a row — all Unknown, no fabricated health.
		expect(s.services).toHaveLength(3);
		for (const row of s.services) {
			expect(row.health).toBe("Unknown");
			expect(row.sync).toBe("Unknown");
		}
		expect(s.revision).toBeNull();
	});

	it("direct mode: no services group, wiring facts say direct, add-ons stay real", () => {
		const s = assembleGitopsDeployStatus({
			...BASE,
			appsRepo: null,
			deployJob: successDeploy({
				gitops: { mode: "direct" },
			}),
		});
		expect(s.mode).toBe("direct");
		expect(s.appsRepo).toBeNull();
		expect(s.argocdApp).toBeNull();
		expect(s.services).toEqual([]);
		expect(s.addons).toHaveLength(2);
		expect(s.dataServices.length).toBeGreaterThan(0);
	});

	it("pre-#574 job (no gitops_status): mode inferred from the repo row, services Unknown, no banner", () => {
		const s = assembleGitopsDeployStatus({
			...BASE,
			deployJob: successDeploy({ gitops: null }),
		});
		expect(s.mode).toBe("gitops"); // inferred from project_repositories
		expect(s.statusAvailable).toBe(false);
		expect(s.failedStep).toBeNull(); // no banner without a recorded wiring failure
		expect(s.services.every((r) => r.health === "Unknown")).toBe(true);
	});

	it("never deployed: empty-ish model, direct unless a repo is designed", () => {
		const s = assembleGitopsDeployStatus({
			appsRepo: null,
			argocdUrl: null,
			lastDeployedAt: null,
			deployJob: null,
			driftJob: null,
			designedServices: ["api-gateway"],
			addonRows: [],
		});
		expect(s.mode).toBe("direct");
		expect(s.lastDeployAt).toBeNull();
		expect(s.statusAvailable).toBe(false);
		expect(s.services).toEqual([]);
	});

	it("day-2: a fresher successful DETECT_DRIFT snapshot supersedes the deploy's", () => {
		const s = assembleGitopsDeployStatus({
			...BASE,
			driftJob: {
				status: "SUCCESS",
				errorMessage: null,
				createdAt: new Date("2026-07-16T12:00:00Z"), // newer than the deploy
				gitops: {
					mode: "gitops",
					apps_repo: "https://github.com/acme/apps",
					argocd_app: "apps",
					revision: "aabbccddeeff",
					services: {
						"checkout-web": { health: "Healthy", sync: "Synced" }, // recovered
					},
				},
				addonStatus: {
					"addon-db-primary": { health: "Degraded", sync: "Synced" },
				},
			},
		});
		expect(s.revision).toBe("aabbccddeeff");
		expect(s.services.find((r) => r.name === "checkout-web")?.health).toBe("Healthy");
		// The union keeps designed services the drift read didn't see — honestly Unknown.
		expect(s.services.find((r) => r.name === "api-gateway")?.health).toBe("Unknown");
		expect(s.dataServices).toEqual([
			{ name: "db-primary", health: "Degraded", sync: "Synced", message: null },
		]);
	});

	it("an OLDER drift snapshot never overrides a newer deploy's", () => {
		const s = assembleGitopsDeployStatus({
			...BASE,
			driftJob: {
				status: "SUCCESS",
				errorMessage: null,
				createdAt: new Date("2026-07-16T09:00:00Z"), // older than the deploy
				gitops: {
					mode: "gitops",
					revision: "stale000",
					services: { "checkout-web": { health: "Healthy", sync: "Synced" } },
				},
				addonStatus: null,
			},
		});
		expect(s.revision).toBe("9f8e7d6c5b4a");
		expect(s.services.find((r) => r.name === "checkout-web")?.health).toBe("Degraded");
	});
});

describe("gitopsStatusReportSchema", () => {
	it("parses a minimal direct-mode payload (every other field optional)", () => {
		expect(gitopsStatusReportSchema.safeParse({ mode: "direct" }).success).toBe(true);
	});

	it("rejects a payload without mode (pre-#574 metadata simply lacks the key)", () => {
		expect(gitopsStatusReportSchema.safeParse({}).success).toBe(false);
		expect(gitopsStatusReportSchema.safeParse(undefined).success).toBe(false);
	});

	it("parses the full failure shape the Go side emits", () => {
		const parsed = gitopsStatusReportSchema.safeParse({
			mode: "gitops",
			apps_repo: "https://github.com/acme/apps",
			argocd_app: "apps",
			failed_step: "repo_credentials",
			error: "failed to apply repo credentials: exit 1",
		});
		expect(parsed.success).toBe(true);
	});
});
