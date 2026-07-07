// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Server-side analytics capture (posthog-node). Client instrumentation covers user-driven actions, but
// truth about revenue arrives asynchronously via Stripe webhooks — no browser is present — so those
// events are captured here. Gated on the same PostHog env as the browser SDK; with no key it no-ops, so
// the OSS/self-hosted build ships zero server telemetry. Events set the `organization` group so they line
// up with the client-side group() in the same PostHog project, and use the org owner's user id as the
// distinct_id (when known) so a person's client + server events stitch into one timeline.

import { PostHog } from "posthog-node";
import type { AnalyticsEvent } from "./events";
import type { AnalyticsProps } from "./track";

let client: PostHog | null | undefined;

/** Lazily builds the singleton PostHog server client, or null when analytics env is unset. */
function getClient(): PostHog | null {
	if (client !== undefined) return client;
	const key = process.env.NEXT_PUBLIC_POSTHOG_KEY;
	if (!key) {
		client = null;
		return client;
	}
	const host = (
		process.env.NEXT_PUBLIC_POSTHOG_HOST || "https://eu.i.posthog.com"
	).replace(/\/$/, "");
	// flushAt:1 → send on every capture (serverless has no long-lived process to batch across).
	client = new PostHog(key, { host, flushAt: 1, flushInterval: 0 });
	return client;
}

/**
 * Capture a server-side event, attached to the `organization` group so it segments with the client
 * funnels. `distinctId` should be the org owner's user id when available (stitches to their client
 * timeline); callers pass the org id as a fallback so the event still lands on the org group.
 * Best-effort and awaited-flush — never throws into the caller (a webhook must not fail on telemetry).
 */
export async function captureServer(
	distinctId: string,
	event: AnalyticsEvent,
	orgId: string,
	props?: AnalyticsProps,
): Promise<void> {
	const ph = getClient();
	if (!ph) return;
	try {
		ph.capture({
			distinctId,
			event,
			properties: { ...props },
			groups: { organization: orgId },
		});
		await ph.flush();
	} catch {
		/* analytics must never break a webhook */
	}
}
