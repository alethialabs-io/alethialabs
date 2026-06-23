"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only


import {
	Breadcrumb,
	BreadcrumbItem,
	BreadcrumbLink,
	BreadcrumbList,
	BreadcrumbPage,
	BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { AlethiaLogo } from "@/components/alethia-logo";
import { JOB_TYPES } from "@/components/jobs/columns";
import { useZonesStore } from "@/lib/stores/use-zones-store";
import { useJobsStore } from "@/lib/stores/use-jobs-store";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Fragment, useMemo } from "react";

const SEGMENT_LABELS: Record<string, string> = {
	"design-spec": "Create a Spec",
	clusters: "Clusters",
	jobs: "Jobs",
	connectors: "Connectors",
	alerts: "Alerts",
	runners: "Runners",
	profile: "Profile",
	settings: "Settings",
	general: "General",
	members: "Members",
	teams: "Teams",
	roles: "Roles",
	access: "Access",
	sso: "Single Sign-On",
	audit: "Audit Log",
	billing: "Billing",
	usage: "Usage",
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Crumb {
	label: string;
	href?: string;
}

/** Branding + route-aware breadcrumb bar for the dashboard header. */
export function HeaderBreadcrumbs() {
	const pathname = usePathname();
	const { zones } = useZonesStore();
	const { jobs } = useJobsStore();

	const crumbs = useMemo(() => {
		// C2 slug drilldown `/{org}/{zone}/{spec}/{env}` — resolve names from the store
		// (the OrgSwitcher already shows the org, so the trail starts at the zone).
		const segs = pathname.split("/").filter(Boolean);
		if (segs.length >= 1 && segs[0] !== "dashboard") {
			const [orgSeg, second] = segs;

			// `/{org}/~/{page}[/…]` — an org-global page. Label from SEGMENT_LABELS
			// (jobs/runners/settings/general/…), resolving job UUIDs by type.
			if (second === "~") {
				const rest = segs.slice(2);
				const out: Crumb[] = [];
				for (let j = 0; j < rest.length; j++) {
					const s = rest[j];
					const isLast = j === rest.length - 1;
					if (SEGMENT_LABELS[s]) {
						out.push({
							label: SEGMENT_LABELS[s],
							href: isLast
								? undefined
								: `/${orgSeg}/~/${rest.slice(0, j + 1).join("/")}`,
						});
					} else if (UUID_RE.test(s) && rest[j - 1] === "jobs") {
						const job = jobs.find((v) => v.id === s);
						const jt = job?.job_type as string | undefined;
						out.push({
							label:
								jt && JOB_TYPES[jt as keyof typeof JOB_TYPES]
									? JOB_TYPES[jt as keyof typeof JOB_TYPES].label
									: `${s.slice(0, 8)}…`,
						});
					} else {
						out.push({ label: s });
					}
				}
				return out;
			}

			const [, zoneSlug, specSlug, envSeg] = segs;
			const out: Crumb[] = [];
			const z = zones.find((v) => v.slug === zoneSlug);
			if (zoneSlug) {
				out.push({
					label: z?.name ?? zoneSlug,
					href: specSlug ? `/${orgSeg}/${zoneSlug}` : undefined,
				});
			}
			if (specSlug) {
				const sp = z?.specs.find((v) => v.slug === specSlug);
				out.push({
					label: sp?.project_name ?? specSlug,
					href: envSeg ? `/${orgSeg}/${zoneSlug}/${specSlug}` : undefined,
				});
			}
			if (envSeg) out.push({ label: envSeg });
			return out;
		}

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

			if (seg === "zones") {
				const zoneId = raw[i + 1];
				if (zoneId && UUID_RE.test(zoneId)) {
					const z = zones.find((v) => v.id === zoneId);
					const zoneName = z?.name ?? zoneId.slice(0, 8) + "…";
					const specId = raw[i + 2] === "specs" ? raw[i + 3] : undefined;

					if (specId && UUID_RE.test(specId)) {
						const spec = z?.specs.find((v) => v.id === specId);
						const specName = spec?.project_name ?? specId.slice(0, 8) + "…";
						result.push({ label: zoneName, href: `/dashboard/zones/${zoneId}` });
						result.push({ label: specName });
						i += 4;
					} else {
						result.push({ label: zoneName });
						i += 2;
					}
				} else {
					result.push({ label: "Zones" });
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
	}, [pathname, zones, jobs]);

	const isHome = crumbs.length === 0;

	return (
		<Breadcrumb>
			<BreadcrumbList className="flex-nowrap">
				{/* Logo + "Alethia" — links to /dashboard */}
				<BreadcrumbItem className="shrink-0">
					{isHome ? (
						<BreadcrumbPage className="flex items-center gap-1.5">
							<AlethiaLogo className="h-5 w-5" />
							<span className="font-semibold">Alethia</span>
						</BreadcrumbPage>
					) : (
						<BreadcrumbLink asChild>
							<Link href="/dashboard" className="flex items-center gap-1.5">
								<AlethiaLogo className="h-5 w-5" />
								<span className="font-semibold text-foreground">Alethia</span>
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
