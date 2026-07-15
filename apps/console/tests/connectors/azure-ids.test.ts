// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { azureIdConflict, parseAzureIds } from "@/lib/cloud-providers/azure-ids";

// Distinguishable, so a swap is unmissable.
const TENANT = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const CLIENT = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const SUB = "cccccccc-3333-4333-8333-cccccccccccc";

// Verbatim from infra/connector/azure/alethia-azure-setup.sh. The two blocks order their GUIDs
// DIFFERENTLY (human: tenant/subscription/client — CONFIG: tenant/client/subscription), which is
// exactly what made positional parsing swap Client ID with Subscription ID.
const HUMAN_BLOCK = `Copy these values into the Alethia dashboard:

  Tenant ID:       ${TENANT}
  Subscription ID: ${SUB}
  Client ID:       ${CLIENT}
`;

const CONFIG_BLOCK = `--- START CONFIG (machine-readable, parsed by the Alethia CLI) ---
tenant_id=${TENANT}
client_id=${CLIENT}
subscription_id=${SUB}
--- END CONFIG ---
`;

const WHOLE_OUTPUT = `============================================================
  Setup complete! (keyless, customer-side managed identity)
============================================================

${HUMAN_BLOCK}
${CONFIG_BLOCK}`;

describe("parseAzureIds", () => {
	// Each of these fails on the pre-fix parser: its `[^0-9a-fA-F]*` separator can't cross the
	// `d`/`D` in "id" (a hex digit), so every label match missed and the positional fallback ran.
	it.each([
		["the human-readable block", HUMAN_BLOCK],
		["the machine-readable CONFIG block", CONFIG_BLOCK],
		["the whole script output", WHOLE_OUTPUT],
	])("pulls each id from its own label — %s", (_label, text) => {
		expect(parseAzureIds(text)).toEqual({
			tenantId: TENANT,
			clientId: CLIENT,
			subscriptionId: SUB,
		});
	});

	it("does not guess from position when a label is missing", () => {
		// Three bare GUIDs in an unknown order. Guessing here is what stored a subscription GUID as
		// the application id; leaving the fields empty makes the user fill them in instead.
		expect(parseAzureIds(`${TENANT}\n${SUB}\n${CLIENT}`)).toEqual({
			tenantId: undefined,
			clientId: undefined,
			subscriptionId: undefined,
		});
	});

	it("fills only the labelled fields from a partial paste", () => {
		expect(parseAzureIds(`client_id=${CLIENT}`)).toEqual({
			tenantId: undefined,
			clientId: CLIENT,
			subscriptionId: undefined,
		});
	});
});

describe("azureIdConflict", () => {
	it("passes three distinct ids", () => {
		expect(
			azureIdConflict({
				tenantId: TENANT,
				clientId: CLIENT,
				subscriptionId: SUB,
			}),
		).toBeNull();
	});

	// The reported bug: the subscription GUID landed in Client ID, and Entra answered with
	// "AADSTS700016: Application with identifier '…' was not found in the directory".
	it("flags a Subscription ID pasted into Client ID", () => {
		const conflict = azureIdConflict({
			tenantId: TENANT,
			clientId: SUB,
			subscriptionId: SUB,
		});
		expect(conflict?.field).toBe("clientId");
		expect(conflict?.message).toMatch(/Subscription ID/);
	});

	it("flags a Tenant ID pasted into Client ID", () => {
		expect(
			azureIdConflict({
				tenantId: TENANT,
				clientId: TENANT,
				subscriptionId: SUB,
			})?.field,
		).toBe("clientId");
	});

	it("flags a Tenant ID pasted into Subscription ID", () => {
		expect(
			azureIdConflict({
				tenantId: TENANT,
				clientId: CLIENT,
				subscriptionId: TENANT,
			})?.field,
		).toBe("subscriptionId");
	});

	it("is case-insensitive (GUIDs are hex, casing is not meaningful)", () => {
		expect(
			azureIdConflict({
				tenantId: TENANT,
				clientId: SUB.toUpperCase(),
				subscriptionId: SUB,
			})?.field,
		).toBe("clientId");
	});
});
