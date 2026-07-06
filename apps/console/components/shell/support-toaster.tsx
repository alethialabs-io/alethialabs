"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { useSupportToasts } from "@/hooks/use-support-toasts";

/**
 * Headless mount point for the support-reply toast driver. Rendered once by the app shell so
 * `useSupportToasts` has a single instance (the source of dedup) with access to the org slug for
 * client-side "View case" navigation. Renders nothing.
 */
export function SupportToaster() {
	useSupportToasts();
	return null;
}
