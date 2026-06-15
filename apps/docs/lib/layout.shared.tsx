// SPDX-FileCopyrightText: 2026 Alethia OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { BookText } from "lucide-react";
import type { BaseLayoutProps, LinkItemType } from "fumadocs-ui/layouts/shared";

export const linkItems: LinkItemType[] = [
	{
		text: "Documentation",
		url: "/",
		active: "nested-url",
	},
];

export const logo = (
	<div className="flex items-center gap-2">
		<BookText className="size-5 text-fd-primary" />
	</div>
);

export function baseOptions(): BaseLayoutProps {
	return {
		nav: {
			title: logo,
		},
		links: linkItems,
	};
}
