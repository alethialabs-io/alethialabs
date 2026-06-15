"use client";

import {
	Breadcrumb,
	BreadcrumbItem,
	BreadcrumbLink,
	BreadcrumbList,
	BreadcrumbPage,
	BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { VertexLogo } from "@/components/vertex-logo";
import { JOB_TYPES } from "@/components/jobs/columns";
import { useVineyardsStore } from "@/lib/stores/use-vineyards-store";
import { useJobsStore } from "@/lib/stores/use-jobs-store";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Fragment, useMemo } from "react";

const SEGMENT_LABELS: Record<string, string> = {
	plant: "Plant a Vine",
	clusters: "Clusters",
	jobs: "Jobs",
	integrations: "Integrations",
	tendrils: "Tendrils",
	profile: "Profile",
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Crumb {
	label: string;
	href?: string;
}

/** Branding + route-aware breadcrumb bar for the dashboard header. */
export function HeaderBreadcrumbs() {
	const pathname = usePathname();
	const { vineyards } = useVineyardsStore();
	const { jobs } = useJobsStore();

	const crumbs = useMemo(() => {
		const raw = pathname.replace(/^\/dashboard\/?/, "").split("/").filter(Boolean);
		if (raw.length === 0) return [];

		const result: Crumb[] = [];
		let i = 0;

		while (i < raw.length) {
			const seg = raw[i];

			if (SEGMENT_LABELS[seg]) {
				const isLast = i === raw.length - 1;
				result.push({
					label: SEGMENT_LABELS[seg],
					href: isLast ? undefined : `/dashboard/${raw.slice(0, i + 1).join("/")}`,
				});
				i++;
				continue;
			}

			if (seg === "vineyards") {
				const vineyardId = raw[i + 1];
				if (vineyardId && UUID_RE.test(vineyardId)) {
					const vy = vineyards.find((v) => v.id === vineyardId);
					const vyName = vy?.name ?? vineyardId.slice(0, 8) + "…";
					const vineId = raw[i + 2] === "vines" ? raw[i + 3] : undefined;

					if (vineId && UUID_RE.test(vineId)) {
						const vine = vy?.vines.find((v) => v.id === vineId);
						const vineName = vine?.project_name ?? vineId.slice(0, 8) + "…";
						result.push({ label: vyName, href: `/dashboard/vineyards/${vineyardId}` });
						result.push({ label: vineName });
						i += 4;
					} else {
						result.push({ label: vyName });
						i += 2;
					}
				} else {
					result.push({ label: "Vineyards" });
					i++;
				}
				continue;
			}

			if (UUID_RE.test(seg)) {
				const prev = raw[i - 1];
				if (prev === "jobs") {
					const job = jobs.find((j) => j.id === seg);
					const jobType = job?.job_type as string | undefined;
					const label = jobType && JOB_TYPES[jobType as keyof typeof JOB_TYPES]
						? JOB_TYPES[jobType as keyof typeof JOB_TYPES].label
						: seg.slice(0, 8) + "…";
					result.push({ label });
					i++;
					continue;
				}
			}

			result.push({ label: seg });
			i++;
		}

		return result;
	}, [pathname, vineyards, jobs]);

	const isHome = crumbs.length === 0;

	return (
		<Breadcrumb>
			<BreadcrumbList className="flex-nowrap">
				{/* Logo + "Vertex" — links to /dashboard */}
				<BreadcrumbItem className="shrink-0">
					{isHome ? (
						<BreadcrumbPage className="flex items-center gap-1.5">
							<VertexLogo className="h-5 w-5" />
							<span className="font-semibold">Vertex</span>
						</BreadcrumbPage>
					) : (
						<BreadcrumbLink asChild>
							<Link href="/dashboard" className="flex items-center gap-1.5">
								<VertexLogo className="h-5 w-5" />
								<span className="font-semibold text-foreground">Vertex</span>
							</Link>
						</BreadcrumbLink>
					)}
				</BreadcrumbItem>

				{/* "by Borislav Borisov" — separate from the Link to avoid nested <a> */}
				<li className="hidden sm:inline-flex items-center gap-1.5 text-sm">
					<span className="text-muted-foreground">by</span>
					<a
						href="https://www.linkedin.com/in/bborisov1/"
						target="_blank"
						rel="noopener noreferrer"
						className="text-muted-foreground hover:text-foreground transition-colors"
					>
						Borislav Borisov
					</a>
				</li>

				{/* Route segments */}
				{crumbs.map((crumb, i) => (
					<Fragment key={crumb.href ?? crumb.label}>
						<BreadcrumbSeparator />
						<BreadcrumbItem className="min-w-0">
							{i < crumbs.length - 1 && crumb.href ? (
								<BreadcrumbLink asChild>
									<Link href={crumb.href} className="truncate max-w-[120px] sm:max-w-[180px]">
										{crumb.label}
									</Link>
								</BreadcrumbLink>
							) : (
								<BreadcrumbPage className="truncate max-w-[120px] sm:max-w-[180px]">
									{crumb.label}
								</BreadcrumbPage>
							)}
						</BreadcrumbItem>
					</Fragment>
				))}
			</BreadcrumbList>
		</Breadcrumb>
	);
}
