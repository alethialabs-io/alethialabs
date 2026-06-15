"use client";

import {
	Breadcrumb,
	BreadcrumbItem,
	BreadcrumbLink,
	BreadcrumbList,
	BreadcrumbPage,
	BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
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
								<BreadcrumbLink asChild>
									<Link href={item.href}>{item.label}</Link>
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
