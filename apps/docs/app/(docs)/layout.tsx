// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { baseOptions, linkItems } from "@/lib/layout.shared";
import { source } from "@/lib/source";
import { DocsLayout } from "fumadocs-ui/layouts/docs";
import type { ReactNode } from "react";

/**
 * The docs shell: ONE sidebar over the whole page tree. No section is a `root` folder, so there is
 * no tab switcher. Opening a section used to hide every other section from the sidebar, which made
 * the docs feel like ten separate sites. The order and the groups live in content/docs/meta.json.
 */
export default function Layout({ children }: { children: ReactNode }) {
	return (
		<DocsLayout {...baseOptions()} tree={source.getPageTree()} links={linkItems}>
			{children}
		</DocsLayout>
	);
}
