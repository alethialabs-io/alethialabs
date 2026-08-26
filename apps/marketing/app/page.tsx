// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { MarketingHome } from "@/components/landing/home/marketing-home";

/**
 * Alethia Labs public home page.
 *
 * Four moves: an asymmetric hero, the clouds it provisions into, three bands
 * (console, CLI, receipt), and a close. No scrollytelling, no numbered beats,
 * no client islands — the previous comment here described a ten-section version
 * that no longer exists.
 */
export default async function HomePage() {
	return <MarketingHome />;
}
