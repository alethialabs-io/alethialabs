// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// connect_cloud — the generative "connect a cloud" action. It checks whether the provider is already
// connected (so the model doesn't tell a user to connect something they already have), and returns a
// result the chat renders as a "Connect <provider>" action that opens the Connectors page with the
// connect sheet (?connect=<provider>). Keyless: connecting runs a short role/SP setup, no key to paste.

import { tool } from "ai";
import { z } from "zod";
import { getVerifiedCloudIdentities } from "@/app/server/actions/aws/identities";

/** The managed clouds a user can connect + provision. */
export const CONNECTABLE_CLOUDS = ["aws", "gcp", "azure", "alibaba"] as const;

/** The connect-action tool set. */
export function connectTools() {
	return {
		connect_cloud: tool({
			description:
				"Surface a one-click action to CONNECT a cloud provider — it opens the Connectors page with the " +
				"connect sheet for that cloud. Call this when the user asks to connect a cloud, or when they want " +
				"to build on / provision to a cloud that isn't connected yet. It first checks whether the cloud is " +
				"already connected (don't tell them to connect something they already have). Connecting is KEYLESS " +
				"(a short role/service-principal setup that trusts Alethia — no key to paste).",
			inputSchema: z.object({
				provider: z
					.enum(CONNECTABLE_CLOUDS)
					.describe("The cloud to connect: aws | gcp | azure | alibaba."),
			}),
			execute: async ({ provider }) => {
				let identities: Awaited<ReturnType<typeof getVerifiedCloudIdentities>> = [];
				try {
					identities = await getVerifiedCloudIdentities();
				} catch {
					// A lookup failure shouldn't break the connect action — surface it as "not connected".
					identities = [];
				}
				const existing = (identities ?? []).filter((i) => i.provider === provider);
				return {
					provider,
					alreadyConnected: existing.length > 0,
					connectedAccounts: existing
						.map((i) => i.displayId || i.name)
						.filter((x): x is string => Boolean(x)),
				};
			},
		}),
	};
}
