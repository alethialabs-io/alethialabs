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
	splitDeployWarnings,
	type GitopsAssemblyInputs,
	type GitopsJobFacts,
} from "@/lib/gitops/deploy-status";
import { byoAdmissionReportComplete } from "@/lib/gitops/byo-admission-report";
import type { GitopsBumpRecord } from "@/types/jsonb.types";

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

	it("surfaces the latest deploy's manifest_warnings (defaults to none)", () => {
		// #717: manifest-generation warnings (unresolved binding, skipped service, unsatisfiable
		// credential) ride the deploy snapshot so the Deploy tab can explain a misconfigured service.
		expect(assembleGitopsDeployStatus(BASE).warnings).toEqual([]);
		const s = assembleGitopsDeployStatus({
			...BASE,
			deployJob: successDeploy({
				gitops: {
					mode: "gitops",
					manifest_warnings: [
						'binding facet "endpoint" (env DB_HOST) for api→database/orders-db could not be resolved — env omitted',
					],
				},
			}),
		});
		expect(s.warnings).toHaveLength(1);
		expect(s.warnings[0]).toContain("DB_HOST");
	});

	// #6549: a runner that reports `addon_drift` also sends each entry's sentence in
	// `manifest_warnings`, for a console that predates the structured form.
	const DRIFT_SENTENCE =
		"GitOps add-on ingress-nginx: addons/ingress-nginx.yaml in your apps repo installs chart ingress-nginx 4.11.2";
	const drift = {
		addon_id: "ingress-nginx",
		file: "addons/ingress-nginx.yaml",
		chart: "ingress-nginx",
		seeded_version: "4.11.2",
		desired_version: "4.15.1",
		warning: DRIFT_SENTENCE,
	};
	const OTHER = 'binding facet "endpoint" (env DB_HOST) could not be resolved — env omitted';

	it("renders structured add-on drift and drops exactly its paired sentence (#6549)", () => {
		const s = assembleGitopsDeployStatus({
			...BASE,
			deployJob: successDeploy({
				gitops: { mode: "gitops", manifest_warnings: [OTHER, DRIFT_SENTENCE], addon_drift: [drift] },
			}),
		});
		expect(s.addonDrift).toEqual([
			{
				addonId: "ingress-nginx",
				file: "addons/ingress-nginx.yaml",
				chart: "ingress-nginx",
				seededVersion: "4.11.2",
				desiredVersion: "4.15.1",
				pull: null,
			},
		]);
		expect(s.warnings).toEqual([OTHER]);
	});

	it("keeps every warning from a runner that predates addon_drift, the drift sentence included (#6549)", () => {
		const s = assembleGitopsDeployStatus({
			...BASE,
			deployJob: successDeploy({ gitops: { mode: "gitops", manifest_warnings: [OTHER, DRIFT_SENTENCE] } }),
		});
		expect(s.addonDrift).toEqual([]);
		expect(s.warnings).toEqual([OTHER, DRIFT_SENTENCE]);
	});

	it("pairs by the exact string, not by wording: a warning that only MENTIONS the add-on is kept (#6549)", () => {
		const mention = `${DRIFT_SENTENCE} (and something else)`;
		const { warnings } = splitDeployWarnings({
			mode: "gitops",
			manifest_warnings: [mention, DRIFT_SENTENCE],
			addon_drift: [drift],
		});
		expect(warnings).toEqual([mention]);
	});

	it("links a drift row to the stored pull request for ITS version only (#6549)", () => {
		const record = (version: string): GitopsBumpRecord => ({
			version,
			provider: "github",
			number: 42,
			url: "https://github.com/acme/apps/pull/42",
			branch: `alethia/addon-bump-ingress-nginx-${version}`,
			state: "open",
			opened_by: "u1",
			updated_at: "2026-11-12T00:00:00.000Z",
		});
		const deployJob = successDeploy({
			gitops: { mode: "gitops", manifest_warnings: [DRIFT_SENTENCE], addon_drift: [drift] },
		});
		const row = { addonId: "ingress-nginx", health: null, sync: null, message: null };
		const linked = assembleGitopsDeployStatus({ ...BASE, deployJob, addonRows: [{ ...row, gitopsBump: record("4.15.1") }] });
		expect(linked.addonDrift[0]?.pull).toEqual({ number: 42, url: "https://github.com/acme/apps/pull/42", state: "open" });
		// A pull request for an older catalog version is not this row's.
		const stale = assembleGitopsDeployStatus({ ...BASE, deployJob, addonRows: [{ ...row, gitopsBump: record("4.12.0") }] });
		expect(stale.addonDrift[0]?.pull).toBeNull();
		const none = assembleGitopsDeployStatus({ ...BASE, deployJob, addonRows: [row] });
		expect(none.addonDrift[0]?.pull).toBeNull();
	});

	it("defaults to no drift for an environment that has never deployed (#6549)", () => {
		expect(assembleGitopsDeployStatus(BASE).addonDrift).toEqual([]);
		expect(splitDeployWarnings(null)).toEqual({ warnings: [], addonDrift: [] });
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

	it("parses addon_drift, and rejects an entry missing a field (#6549)", () => {
		const entry = {
			addon_id: "ingress-nginx",
			file: "addons/ingress-nginx.yaml",
			chart: "ingress-nginx",
			seeded_version: "4.11.2",
			desired_version: "4.15.1",
			warning: "w",
		};
		expect(gitopsStatusReportSchema.safeParse({ mode: "gitops", addon_drift: [entry] }).success).toBe(true);
		const { warning: _dropped, ...partial } = entry;
		expect(gitopsStatusReportSchema.safeParse({ mode: "gitops", addon_drift: [partial] }).success).toBe(false);
	});

	it("parses manifest_warnings (#717)", () => {
		const parsed = gitopsStatusReportSchema.safeParse({
			mode: "gitops",
			manifest_warnings: ["api: repo-sourced service not built yet (resolved_image empty)"],
		});
		expect(parsed.success).toBe(true);
	});
});

describe("byoAdmissionReportComplete (#6541)", () => {
	const all = [
		{ kind: "Service", state: "checked" as const },
		{ kind: "Ingress", state: "checked" as const },
		{ kind: "Secret", state: "checked" as const },
		{ kind: "PodSecurity", state: "enforced" as const },
	];
	const ns = { namespace: "byo-a", charts: ["a"], mode: "enforce" as const, reason: "kept" };

	it("is complete only when every deployed namespace checked every kind", () => {
		expect(byoAdmissionReportComplete([{ ...ns, checks: all }])).toBe(true);
		expect(byoAdmissionReportComplete([{ ...ns, checks: all.map((c, i) => (i === 2 ? { ...c, state: "failed" as const } : c)) }])).toBe(false);
		expect(byoAdmissionReportComplete([{ ...ns, checks: all.slice(0, 3) }])).toBe(false);
	});

	it("reads no checks (an older runner) and no report as incomplete; a refused namespace needs none", () => {
		expect(byoAdmissionReportComplete([ns])).toBe(false);
		expect(byoAdmissionReportComplete([])).toBe(false);
		expect(byoAdmissionReportComplete([{ ...ns, checks: all }, { namespace: "x", charts: ["x"], mode: "refused", reason: "not-this-environments-namespace" }])).toBe(true);
	});
});

describe("assembleGitopsDeployStatus — BYO admission (#6541)", () => {
	it("dates the report by the deploy that produced it, and has no date without one", () => {
		expect(assembleGitopsDeployStatus(BASE).byoAdmissionReportAt).toBeNull();
		const s = assembleGitopsDeployStatus({
			...BASE,
			deployJob: successDeploy({
				gitops: {
					mode: "gitops",
					byo_admission: [{ namespace: "byo-a", charts: ["a"], mode: "warn", reason: "chart-history" }],
				},
			}),
		});
		expect(s.byoAdmission).toHaveLength(1);
		expect(s.byoAdmissionReportAt).toBe("2026-07-16T10:00:00.000Z");
	});
});
