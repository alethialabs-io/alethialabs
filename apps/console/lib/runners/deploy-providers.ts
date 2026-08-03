// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { CloudProviderSlug } from "@/lib/cloud-providers/generated/catalog";

/**
 * The clouds a `DEPLOY_RUNNER` job can actually build a runner in — the SINGLE source of truth
 * shared by the Add-runner form, the `deployRunner` server action and the CLI deploy route.
 *
 * The list mirrors the directories under `infra/templates/runner/`, which today holds `aws`
 * alone (ECS Fargate). The runner resolves the provider as a directory name there and fails
 * closed on a miss (`apps/runner/internal/agent/deploy_runner.go`, "no templates for provider
 * %s") — but only once the runners row, the job row and the claim already exist, so the user
 * reads the refusal in job logs instead of in the form. Gating on this list moves the refusal
 * to enqueue, where it belongs.
 *
 * `tests/lib/runners/deploy-providers.test.ts` reads `infra/templates/runner/` and reds if the
 * two drift, so ADDING A TEMPLATE DIRECTORY is what widens this list — not a second literal
 * that can quietly disagree with the first.
 *
 * This module is deliberately leaf-shaped (one type-only import): a client component, a server
 * action and a route handler all import it, so it must pull nothing into any of their graphs.
 */
export const RUNNER_DEPLOY_PROVIDERS = [
	"aws",
] as const satisfies readonly CloudProviderSlug[];

/** A cloud a runner can be deployed into. */
export type RunnerDeployProvider = (typeof RUNNER_DEPLOY_PROVIDERS)[number];

const RUNNER_DEPLOY_PROVIDER_SET: ReadonlySet<string> = new Set(
	RUNNER_DEPLOY_PROVIDERS,
);

/** Cast-free narrow: true when a runner can actually be deployed into this cloud. */
export function isRunnerDeployProvider(
	provider: string,
): provider is RunnerDeployProvider {
	return RUNNER_DEPLOY_PROVIDER_SET.has(provider);
}

/** Joins slugs into uppercased prose — "AWS", "AWS or GCP", "AWS, GCP or Azure". */
function formatProviderList(slugs: readonly string[]): string {
	const names = slugs.map((s) => s.toUpperCase());
	if (names.length < 2) return names.join("");
	return `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}`;
}

/** The deployable clouds as user-facing text — derived from the list, never hand-written. */
export const RUNNER_DEPLOY_PROVIDERS_LABEL =
	formatProviderList(RUNNER_DEPLOY_PROVIDERS);

/**
 * The refusal for a deploy asked for a cloud with no runner template. One wording, so the form,
 * the server action and the CLI all tell the user the same thing.
 */
export function runnerDeployUnsupportedMessage(provider: string): string {
	return `Deploying a runner into ${provider} is not supported — deployed runners are ${RUNNER_DEPLOY_PROVIDERS_LABEL} only. Register a self-hosted runner instead; it runs on any cloud.`;
}
