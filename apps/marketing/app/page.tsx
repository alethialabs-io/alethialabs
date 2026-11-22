// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { MarketingHome } from "@/components/landing/home/marketing-home";

/**
 * Alethia Labs public home page: a statement, the film, the latest three releases and four
 * blog posts. The structure and the feeds are described on `MarketingHome`.
 */
export default async function HomePage() {
	return <MarketingHome />;
}
