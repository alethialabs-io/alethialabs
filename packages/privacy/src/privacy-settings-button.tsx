// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

"use client";

import type { CSSProperties } from "react";

import { useConsent } from "./consent-provider";

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
	children = "Privacy settings",
}: PrivacySettingsButtonProps) {
	const { hasDecision, openPreferences } = useConsent();

	if (!hasDecision) return null;

	return (
		<button type="button" onClick={openPreferences} className={className} style={style}>
			{children}
		</button>
	);
}
