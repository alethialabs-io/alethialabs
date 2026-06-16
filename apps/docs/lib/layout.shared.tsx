// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { BaseLayoutProps, LinkItemType } from "fumadocs-ui/layouts/shared";

export const linkItems: LinkItemType[] = [
	{
		text: "Documentation",
		url: "/",
		active: "nested-url",
	},
];

export const logo = (
	<span className="inline-flex items-center gap-2 font-semibold">
		<svg
			width="20"
			height="20"
			viewBox="0 0 32 32"
			fill="none"
			aria-hidden="true"
		>
			<path
				d="M11 6 H6.5 V26 H11"
				stroke="currentColor"
				strokeWidth="2.4"
				strokeLinecap="round"
				strokeLinejoin="round"
			/>
			<path
				d="M21 6 H25.5 V26 H21"
				stroke="currentColor"
				strokeWidth="2.4"
				strokeLinecap="round"
				strokeLinejoin="round"
			/>
			<circle cx="16" cy="16" r="2.9" fill="currentColor" />
		</svg>
		<span>Alethia</span>
		<span className="font-normal text-fd-muted-foreground">Docs</span>
	</span>
);

export function baseOptions(): BaseLayoutProps {
	return {
		nav: {
			title: logo,
		},
		links: linkItems,
	};
}
