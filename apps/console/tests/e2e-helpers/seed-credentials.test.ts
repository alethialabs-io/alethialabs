// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// THE FIXTURE IS HELD AGAINST THE PREDICATE THAT READS IT (#4708).
//
// `e2e/helpers/seed.ts` wrote `{role_arn: "arn:aws:iam::…"}` for EVERY provider. Nothing errored:
// the row inserted, the read succeeded, and `identityWasConfigured()` — which is provider-aware —
// simply answered `false` for gcp and azure. `getConnectorsWithStatus` then filtered the identity
// out as a never-configured placeholder, the tile rendered "Not enabled on this instance", the
// card's `isPick` predicate went false, and a Playwright click on it was a SILENT NO-OP. That cost
// the release gate `flows/projects.spec.ts`'s template-create test at a 120s timeout, and was
// diagnosed twice, independently, as a canvas bug before anyone read the predicate.
//
// A seeder that writes a structurally valid row for the wrong provider produces no error anywhere,
// so no type, lint or integration check could have caught it. The only thing that can is holding
// what the seeder WRITES against the function that READS it — which is what this file does, for
// every member of the `cloud_provider` enum, driving the REAL predicate rather than a copy of it.
//
// Three directions, and all three are load-bearing:
//
//   1. WHAT THE SEEDER WRITES IS CONFIGURED. The defect itself.
//   2. AN EMPTY CREDENTIAL IS NOT. Without this, (1) would still pass against a predicate that had
//      been broadened to `return true` — a guard that cannot say "no" measures nothing.
//   3. THE CREDENTIAL IS PROVIDER-SHAPED, NOT MERELY SUFFICIENT. A `seedCredentials` that returned
//      the UNION of every provider's fields would satisfy (1) and (2) while writing a row that is
//      nonsense for six of the seven clouds — and would re-admit exactly this bug's shape, a
//      fixture whose AWS-ness is load-bearing somewhere else. So each provider's credential is
//      asserted to fail every OTHER provider's requirement.
//
// Adding a cloud to the `cloud_provider` enum without a shape in `seedCredentials` fails at tsc
// (its switch carries a `never` exhaustiveness guard); adding one there without teaching
// `identityWasConfigured` about it fails (1) here, because that function's `default` branch is
// `false`.

import { describe, expect, it } from "vitest";
import { identityWasConfigured } from "../../lib/cloud-providers/identity-configured";
import {
	SEED_PROVIDERS,
	seedAccountId,
	seedCredentials,
	type SeedProvider,
} from "../../e2e/helpers/seed";

describe("e2e seed credentials vs. identityWasConfigured", () => {
	it("enumerates every provider the cloud_provider enum admits", () => {
		// Not a retyped list — `SEED_PROVIDERS` IS `cloudProvider.enumValues`. This asserts the
		// table below is not silently empty, which is the one way a table-driven test reports
		// green having measured nothing.
		expect(SEED_PROVIDERS.length).toBeGreaterThanOrEqual(7);
		expect(new Set(SEED_PROVIDERS).size).toBe(SEED_PROVIDERS.length);
	});

	it.each(SEED_PROVIDERS)(
		"what the seeder writes for %s counts as a configured identity",
		(provider: SeedProvider) => {
			expect(identityWasConfigured(provider, seedCredentials(provider))).toBe(true);
		},
	);

	it.each(SEED_PROVIDERS)(
		"an empty credential for %s does NOT count as configured",
		(provider: SeedProvider) => {
			// Direction 2: proves the predicate can answer `false`, so the assertion above is a
			// measurement rather than a tautology over a predicate that always says yes.
			expect(identityWasConfigured(provider, {})).toBe(false);
			expect(identityWasConfigured(provider, null)).toBe(false);
		},
	);

	it("each provider's credential is shaped for THAT provider, not a superset", () => {
		// Direction 3. `aws`/`alibaba` share a requirement (a role arn) and the three token clouds
		// share theirs, so the comparison is by REQUIREMENT CLASS, not by provider name: a
		// credential must satisfy its own class and no other.
		const classOf = (p: SeedProvider): string => {
			switch (p) {
				case "aws":
				case "alibaba":
					return "role";
				case "digitalocean":
				case "hetzner":
				case "civo":
					return "token";
				default:
					return p;
			}
		};
		for (const provider of SEED_PROVIDERS) {
			const credential = seedCredentials(provider);
			for (const other of SEED_PROVIDERS) {
				const sameClass = classOf(provider) === classOf(other);
				expect(
					identityWasConfigured(other, credential),
					`${provider}'s credential vs. ${other}'s requirement`,
				).toBe(sameClass);
			}
		}
	});

	it("gives each provider its own verified account id", () => {
		// `cloud_identities.verified_account_id` is how `app/api/cloud-events/[provider]` resolves an
		// inbound event back to an identity, and `lib/cloud-providers/events/ingest.ts` names a
		// cross-provider collision on it as a hazard. One AWS account number seeded under all seven
		// providers IS that collision, standing in the fixtures.
		const ids = SEED_PROVIDERS.map(seedAccountId).filter((id): id is string => id !== null);
		expect(ids.length).toBeGreaterThan(0);
		expect(new Set(ids).size).toBe(ids.length);
	});
});
