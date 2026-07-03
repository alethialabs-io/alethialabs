// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { Metadata } from "next";
import type React from "react";

// Every route under (private) is behind authentication — crawlers only ever reach a login
// redirect, so the whole group is marked noindex. Per-page titles + OpenGraph still apply
// (Next merges metadata down the tree; pages never set `robots`, so they inherit this), which
// keeps internal link unfurls working without exposing the app to search indexing.
export const metadata: Metadata = {
	robots: { index: false, follow: false },
};

export default function PrivateLayout({
	children,
}: {
	children: React.ReactNode;
}) {
	return children;
}
