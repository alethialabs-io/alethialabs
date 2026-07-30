// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { Metadata } from "next";
import { MarketingHome } from "@/components/landing/home/marketing-home";

export const metadata: Metadata = {
	alternates: { canonical: "/" },
	robots: { index: false, follow: true },
};

/** Authenticated alias for the public homepage, with signed-in header actions. */
export default async function AuthenticatedHomePage() {
	return <MarketingHome homeHref="/home" />;
}
