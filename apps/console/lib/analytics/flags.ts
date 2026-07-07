// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Feature flags on top of the PostHog SDK the AnalyticsProvider mounts (window.__posthog). Kept in the
// provider-agnostic analytics layer so callers never name a vendor. Flags evaluate against the identified
// person + org group (see analytics-identity.tsx), so you can roll a feature out to a cohort (e.g. Paying
// orgs) from the PostHog UI. With no PostHog configured everything is disabled — the OSS build behaves as
// if every flag is off, which is the safe default for gating NEW surfaces.

import { useEffect, useState } from "react";

/** Imperative check — true only if PostHog is loaded AND the flag is enabled for this person/org. */
export function isFeatureEnabled(key: string): boolean {
	if (typeof window === "undefined") return false;
	try {
		return window.__posthog?.isFeatureEnabled(key) === true;
	} catch {
		return false;
	}
}

/** The raw flag value (a boolean, or a string for multivariate flags); undefined if unknown/unloaded. */
export function getFeatureFlag(key: string): boolean | string | undefined {
	if (typeof window === "undefined") return undefined;
	try {
		return window.__posthog?.getFeatureFlag(key);
	} catch {
		return undefined;
	}
}

/**
 * React hook: subscribes to PostHog flag updates so a component re-renders when flags resolve (they load
 * asynchronously after init) or change. Returns whether `key` is enabled. Safe when PostHog is absent
 * (stays false). Gate a surface with `const enabled = useFeatureFlag("new-thing")`.
 */
export function useFeatureFlag(key: string): boolean {
	const [enabled, setEnabled] = useState<boolean>(() => isFeatureEnabled(key));

	useEffect(() => {
		setEnabled(isFeatureEnabled(key));
		const ph = window.__posthog;
		if (!ph?.onFeatureFlags) return;
		try {
			// onFeatureFlags returns an unsubscribe fn; re-read the flag whenever PostHog re-evaluates.
			return ph.onFeatureFlags(() => setEnabled(isFeatureEnabled(key)));
		} catch {
			return;
		}
	}, [key]);

	return enabled;
}
