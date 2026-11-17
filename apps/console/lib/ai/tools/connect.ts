// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// connect_cloud — the generative "connect a cloud" action. It checks whether the provider is already
// connected (so the model doesn't tell a user to connect something they already have), and returns a
// result the chat renders as a "Connect <provider>" action that opens the Connectors page with the
// connect sheet (?connect=<provider>). A cloud that federates connects with a short role/SP setup
// and no key to paste; a token cloud connects with a scoped API token.

import { tool } from "ai";
import { z } from "zod";
import { getVerifiedCloudIdentities } from "@/app/server/actions/aws/identities";
import { isCloudOffered } from "@/lib/cloud-providers/availability";
import { CLOUD_PROVIDER_SLUGS } from "@/lib/cloud-providers/provider-slug";

/**
 * The connect-action tool set. The clouds it accepts are the ones a project can be provisioned on
 * in this deployment, read on each call, so the model cannot be offered or pass any other.
 */
export function connectTools() {
	const clouds = CLOUD_PROVIDER_SLUGS.filter((slug) => isCloudOffered(slug));
	return {
		connect_cloud: tool({
			description:
				"Surface a one-click action to CONNECT a cloud provider — it opens the Connectors page with the " +
				"connect sheet for that cloud. Call this when the user asks to connect a cloud, or when they want " +
				"to build on / provision to a cloud that isn't connected yet. It first checks whether the cloud is " +
				"already connected (don't tell them to connect something they already have). A cloud that " +
				"federates connects KEYLESS (a short role/service-principal setup that trusts Alethia — no key " +
				"to paste); a token cloud connects with a scoped API token.",
			inputSchema: z.object({
				provider: z.enum(clouds).describe(`The cloud to connect: ${clouds.join(" | ")}.`),
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
