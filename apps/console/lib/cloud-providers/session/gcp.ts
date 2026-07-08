// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { ExternalAccountClient } from "google-auth-library";
import type { WifCredentialConfig } from "@/types/jsonb.types";

/**
 * Builds a google-auth `ExternalAccountClient` from a connection's stored WIF config. The
 * config is validated at connect time (`parseWifConfig`) but persisted as an all-optional
 * JSONB shape, so handing it to google-auth's `fromJSON` is a single library-boundary
 * assertion — centralized here rather than duplicated across the health + inventory probes.
 * Returns `null` if google-auth rejects the config as a valid external account.
 */
export function externalAccountClientFromWif(wif: WifCredentialConfig) {
	return ExternalAccountClient.fromJSON(
		wif as Parameters<typeof ExternalAccountClient.fromJSON>[0],
	);
}
