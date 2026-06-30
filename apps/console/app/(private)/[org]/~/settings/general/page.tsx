// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { OrgGeneral } from "@/components/settings/general/org-general";
import { pageMetadata } from "@/lib/seo/page-metadata";

export const metadata = pageMetadata({
	title: "General · Settings",
	description: "Organization name, slug, and primary billing address.",
});

export default function GeneralPage() {
	return <OrgGeneral />;
}
