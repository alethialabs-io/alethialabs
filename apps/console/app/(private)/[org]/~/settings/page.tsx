// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { redirect } from "next/navigation";
import { pageMetadata } from "@/lib/seo/page-metadata";

/** T4: a redirect still owns a title — named for the section it lands on. */
export const metadata = pageMetadata({
	title: "General · Settings",
	description: "Organization name, slug, and primary billing address.",
});

/** /{org}/~/settings → General, the first section (always available on every plan). */
export default async function SettingsIndex({
	params,
}: {
	params: Promise<{ org: string }>;
}) {
	const { org } = await params;
	redirect(`/${org}/~/settings/general`);
}
