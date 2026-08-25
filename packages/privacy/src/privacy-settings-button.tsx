// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

"use client";

import type { CSSProperties } from "react";

import { CONSENT_LABELS } from "./consent";
import { useOptionalConsent } from "./consent-provider";

interface PrivacySettingsButtonProps {
	className?: string;
	style?: CSSProperties;
	children?: string;
}

/**
 * Reopens the consent preferences dialog.
 *
 * This is the marketing site's consent-withdrawal control. It replaces the
 * floating "Privacy choices" launcher, which was removed because it covered the
 * console's sidebar profile. Consent must stay withdrawable as easily as it was
 * given, so every surface mounting `ConsentProvider` needs a control like this
 * one — the console's lives in the account menu.
 *
 * Renders nothing until a decision exists: before that the first-visit notice is
 * already on screen and offering the same dialog.
 */
export function PrivacySettingsButton({
	className,
	style,
	children = CONSENT_LABELS.settings,
}: PrivacySettingsButtonProps) {
	const consent = useOptionalConsent();

	// TWO DIFFERENT FACTS, kept apart even though both render nothing.
	//
	// `consent === null` means no ConsentProvider is mounted above this surface — a WIRING BUG, and
	// the one that took the blog's build down before the hook was made optional. `hasDecision ===
	// false` is the NORMAL first-visit case, where the notice is already on screen offering the same
	// dialog.
	//
	// Collapsing them into one `!consent?.hasDecision` made a bug and an ordinary state
	// indistinguishable in the source, which is the shape this repository keeps paying for. The
	// hook warns in dev for the first; this keeps the intent legible for the next reader.
	if (consent === null) return null;
	if (!consent.hasDecision) return null;
	const { openPreferences } = consent;

	return (
		<button type="button" onClick={openPreferences} className={className} style={style}>
			{children}
		</button>
	);
}
