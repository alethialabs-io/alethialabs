// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { redirect } from "next/navigation";
import { pageMetadata } from "@/lib/seo/page-metadata";

/** T4: a redirect still owns a title — named for the section it lands on. */
export const metadata = pageMetadata({
	title: "General · Settings",
	description: "Rename or delete this project.",
});

/** /{org}/{project}/settings → General, the first project-scoped settings section. */
export default async function ProjectSettingsIndex({
	params,
}: {
	params: Promise<{ org: string; project: string }>;
}) {
	const { org, project } = await params;
	redirect(`/${org}/${project}/settings/general`);
}
