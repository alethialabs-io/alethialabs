// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Ties the analytics session to a real person + organization. Without this, PostHog only ever sees
// anonymous events. Mounted once inside the authenticated shell. Direct identifiers such as email,
// name, organization name, and slug are deliberately excluded; consent-gated providers receive only
// internal ids and low-cardinality plan/role attributes.

import { useEffect, useRef } from "react";
import { useSession } from "@/lib/auth/client";
import { useWorkspaceStore } from "@/lib/stores/use-workspace-store";
import { group, identify, reset } from "@/lib/analytics/track";

/** Headless: identifies the user + active org to analytics, resets on sign-out. Renders nothing. */
export function AnalyticsIdentity() {
	const { data: session } = useSession();
	const activeOrgId = useWorkspaceStore((s) => s.activeOrgId);
	const org = useWorkspaceStore((s) =>
		s.organizations.find((o) => o.id === s.activeOrgId),
	);
	// Track whether we currently hold an identified session so we only reset() on a real sign-out.
	const identified = useRef(false);

	useEffect(() => {
		const user = session?.user;
		if (user?.id) {
			identify(user.id);
			identified.current = true;
			if (activeOrgId) {
				group(activeOrgId, {
					plan: org?.plan,
					role: org?.role,
				});
			}
		} else if (identified.current) {
			// Session went away (sign-out) → drop the person/group so the next visitor is anonymous.
			reset();
			identified.current = false;
		}
	}, [session?.user, activeOrgId, org?.plan, org?.role]);

	return null;
}
