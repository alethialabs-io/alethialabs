// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The three GUIDs an Azure connection is made of — parsing them out of the setup script's output,
 * and rejecting the mis-pastes that are otherwise only caught by a confusing round-trip failure.
 *
 * Shared by the connect form (`components/connector/azure-connection.tsx`) and the server action
 * (`saveAzureIdentity`), which the CLI also reaches — so the form is not the only boundary.
 */

/** Anchored — validates a single field holds exactly one GUID. */
export const AZURE_GUID_REGEX =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Unanchored — for scraping GUIDs out of the setup-script output. */
const GUID =
	"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";

export interface AzureIds {
	tenantId?: string;
	clientId?: string;
	subscriptionId?: string;
}

/**
 * Extracts the tenant/client/subscription GUIDs from a pasted `alethia-azure-setup.sh` block.
 *
 * Every field is matched by its own label. Both blocks the script prints are labelled — the human
 * one (`Client ID:   <guid>`) and the machine-readable one (`client_id=<guid>`) — so there is
 * deliberately NO positional fallback: the two blocks order their GUIDs differently (human is
 * tenant/subscription/client, CONFIG is tenant/client/subscription), so guessing from position
 * silently swapped Client ID with Subscription ID and stored a subscription GUID as the application
 * id — which Entra rejects at verify time with AADSTS700016. A field we cannot label stays empty.
 */
export function parseAzureIds(text: string): AzureIds {
	// `[_\s]*id` spans both `Client ID:` and `client_id=`. The separator class must not exclude hex
	// letters: `d`/`D` is a hex digit, so a `[^0-9a-fA-F]*` gap can never cross the "id" to reach the
	// GUID — which is why every label match used to fail and the positional fallback always ran.
	const grab = (label: string) =>
		text.match(new RegExp(`${label}[_\\s]*id\\s*[:=]\\s*(${GUID})`, "i"))?.[1];
	return {
		tenantId: grab("tenant"),
		clientId: grab("client"),
		subscriptionId: grab("subscription"),
	};
}

/**
 * The field that holds the wrong GUID, if two of the three collide. The tenant, the managed
 * identity's application id and the subscription name three different things, so a repeat is always
 * a mis-paste — most often the Subscription ID landing in Client ID, which fails at verify with an
 * opaque `AADSTS700016: Application with identifier '…' was not found in the directory`.
 *
 * Returns null when the three ids are distinct.
 */
export function azureIdConflict(
	ids: Required<AzureIds>,
): { field: "clientId" | "subscriptionId"; message: string } | null {
	const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
	const clientIdHint =
		"Paste the managed identity's Client ID (az identity show --query clientId).";
	if (same(ids.clientId, ids.subscriptionId)) {
		return {
			field: "clientId",
			message: `That's the Subscription ID. ${clientIdHint}`,
		};
	}
	if (same(ids.clientId, ids.tenantId)) {
		return {
			field: "clientId",
			message: `That's the Tenant ID. ${clientIdHint}`,
		};
	}
	if (same(ids.tenantId, ids.subscriptionId)) {
		return {
			field: "subscriptionId",
			message: "That's the Tenant ID. Paste the Subscription ID.",
		};
	}
	return null;
}
