// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { CloudCredentials } from "@/types/jsonb.types";

/**
 * Whether a cloud identity was ever actually configured (a credential was submitted), vs. a bare
 * connect-sheet placeholder pre-created by initIdentity (empty credentials + an external_id at most).
 * Role clouds need a role_arn, token clouds a token, GCP a project/SA, Azure a subscription/tenant.
 * Used to keep never-configured placeholders from surfacing a phantom "Verification failed".
 *
 * LIVES HERE, NOT IN THE SERVER ACTION THAT USES IT (#4708). It was a module-private function in
 * `app/server/actions/connectors.ts`, which carries `"use server"` — a file that may export nothing
 * but async functions. So nothing could hold a FIXTURE against it, and `e2e/helpers/seed.ts` wrote
 * `{role_arn}` for every provider for as long as nobody looked: the row inserted, the read
 * succeeded, and this predicate simply answered `false` for gcp and azure. A seeded GCP identity was
 * filtered out of the connectors board as a never-configured placeholder, the tile read "Not enabled
 * on this instance", and a click on it was a silent no-op. Two independent diagnoses read that as a
 * canvas bug before anyone read this function.
 *
 * `apps/console/tests/e2e-helpers/seed-credentials.test.ts` now drives THIS function — not a copy of
 * it — with what the seeder actually writes, for every member of the `cloud_provider` enum.
 */
export function identityWasConfigured(
	provider: string,
	credentials: CloudCredentials | null | undefined,
): boolean {
	const c = credentials ?? {};
	switch (provider) {
		case "aws":
		case "alibaba":
			return !!c.role_arn;
		case "digitalocean":
		case "hetzner":
		case "civo":
			return !!c.token || !!c.self_managed;
		case "gcp":
			return !!c.project_id || !!c.service_account_email;
		case "azure":
			return !!c.subscription_id || !!c.tenant_id;
		default:
			return false;
	}
}
