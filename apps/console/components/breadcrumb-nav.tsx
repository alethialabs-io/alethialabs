"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only


import {
	Breadcrumb,
	BreadcrumbItem,
	BreadcrumbLink,
	BreadcrumbList,
	BreadcrumbPage,
	BreadcrumbSeparator,
} from "@repo/ui/breadcrumb";
import Link from "next/link";
import { Fragment } from "react";

export interface BreadcrumbSegment {
	label: string;
	href?: string;
}

/** Renders a breadcrumb trail. The last segment is rendered as the current page. */
export function BreadcrumbNav({ items }: { items: BreadcrumbSegment[] }) {
	return (
		<Breadcrumb>
			<BreadcrumbList>
				{items.map((item, i) => (
					<Fragment key={item.href ?? item.label}>
						{i > 0 && <BreadcrumbSeparator />}
						<BreadcrumbItem>
							{i < items.length - 1 && item.href ? (
								<BreadcrumbLink render={<Link href={item.href} />}>
									{item.label}
								</BreadcrumbLink>
							) : (
								<BreadcrumbPage>{item.label}</BreadcrumbPage>
							)}
						</BreadcrumbItem>
					</Fragment>
				))}
			</BreadcrumbList>
		</Breadcrumb>
	);
}
