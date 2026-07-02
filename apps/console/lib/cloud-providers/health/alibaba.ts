// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Alibaba health probe — server-side: assume the customer RAM role (auth). A successful AssumeRole is
// the proof of access, so we report CONNECTED; a failure = DISCONNECTED. Unlike AWS there's no separate
// capability read here (a fuller least-privilege probe over ECS/VPC reads can refine to DEGRADED later),
// which is fine — the RAM role is provisioning-scoped by the connector policy. Replaces the runner's
// CONNECTION_TEST for Alibaba.

import type { CloudIdentity } from "@/lib/db/schema";
import { assumeAlibabaRole } from "../session/alibaba";
import { type HealthResult, errorMessage } from "./types";

/** Probes one Alibaba cloud identity's health server-side. Never throws — failures map to a status. */
export async function probeAlibabaHealth(
	identity: Pick<CloudIdentity, "credentials">,
): Promise<HealthResult> {
	try {
		const session = await assumeAlibabaRole(identity, { purpose: "health" });
		return {
			status: "connected",
			accountId: session.accountId,
			error: null,
			missingPermissions: [],
		};
	} catch (e) {
		return {
			status: "disconnected",
			accountId: null,
			error: errorMessage(e),
			missingPermissions: [],
		};
	}
}
