// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The per-cloud reclaim adapters, keyed by provider.
//
// A provider with NO adapter simply never gets swept — `adapterFor` returns undefined and the sweep
// skips the job. That is the correct default: an absent adapter must mean "we do not touch this
// cloud", never "fall back to something generic".

import { alibabaReclaim } from "./alibaba";
import { awsReclaim } from "./aws";
import { azureReclaim } from "./azure";
import { gcpReclaim } from "./gcp";
import { hetznerReclaim } from "./hetzner";
import type { ReclaimAdapter } from "../types";

const ADAPTERS: ReclaimAdapter[] = [
	hetznerReclaim,
	awsReclaim,
	gcpReclaim,
	azureReclaim,
	alibabaReclaim,
];

/** The reclaim adapter for a provider, or undefined when we have none (⇒ that cloud is never swept). */
export function adapterFor(provider: string): ReclaimAdapter | undefined {
	return ADAPTERS.find((a) => a.provider === provider);
}
