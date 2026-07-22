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
import { JOB_TYPES } from "@/components/jobs/columns";
import { useJobsQuery } from "@/lib/query/use-jobs-query";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Fragment, useMemo } from "react";

const SEGMENT_LABELS: Record<string, string> = {
	new: "New project",
	clusters: "Clusters",
	jobs: "Jobs",
	connectors: "Connectors",
	alerts: "Alerts",
	runners: "Runners",
	settings: "Settings",
	general: "General",
	members: "Members",
	teams: "Teams",
	roles: "Roles",
	access: "Access",
	sso: "Single Sign-On",
	activity: "Activity",
	billing: "Billing",
	usage: "Usage",
	agent: "Agent",
};

/** A nice label for a URL segment: the map first, else a capitalized fallback. */
function segmentLabel(seg: string): string {
	return SEGMENT_LABELS[seg] ?? seg.charAt(0).toUpperCase() + seg.slice(1);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Crumb {
	label: string;
	href?: string;
}

/** Branding + route-aware breadcrumb bar for the dashboard header. */
export function HeaderBreadcrumbs() {
	const pathname = usePathname();
	const { data: jobs = [] } = useJobsQuery();

	const crumbs = useMemo(() => {
		// C2 slug drilldown `/{org}/{project}/{env}` — resolve the project name from the
		// store (the OrgSwitcher already shows the org, so the trail starts at the project).
		const segs = pathname.split("/").filter(Boolean);
		if (segs.length >= 1 && segs[0] !== "dashboard") {
			const [orgSeg, second] = segs;

			// Bare org overview `/{org}` — the trail is just the current page.
			if (segs.length === 1) return [{ label: "Overview" }];

			// `/{org}/~/{page}[/…]` — an org-global page. Label from SEGMENT_LABELS
			// (jobs/runners/settings/general/…), resolving job UUIDs by type.
			if (second === "~") {
				const rest = segs.slice(2);
				const out: Crumb[] = [];
				for (let j = 0; j < rest.length; j++) {
					const s = rest[j];
					const isLast = j === rest.length - 1;
					if (!UUID_RE.test(s)) {
						out.push({
							label: segmentLabel(s),
							href: isLast
								? undefined
								: `/${orgSeg}/~/${rest.slice(0, j + 1).join("/")}`,
						});
					} else if (UUID_RE.test(s) && rest[j - 1] === "jobs") {
						const job = jobs.find((v) => v.id === s);
						const jt = job?.job_type;
						out.push({
							label:
								jt && JOB_TYPES[jt]
									? JOB_TYPES[jt].label
									: `${s.slice(0, 8)}…`,
						});
					} else {
						out.push({ label: s });
					}
				}
				return out;
			}

			// `/{org}/{project}` — the canvas IS the project's Overview (the project name is
			// already shown in the Project switcher). Deeper `/{org}/{project}/{sub}...` pages
			// show only the sub-page labels — the project name is not repeated here. (Env now
			// lives in `?environment_id=`, not a path segment, so there's no env crumb.)
			const [, projectSlug, ...rest] = segs;
			if (rest.length === 0) return [{ label: "Overview" }];
			const out: Crumb[] = [];
			for (let j = 0; j < rest.length; j++) {
				const s = rest[j];
				const isLast = j === rest.length - 1;
				out.push({
					label: segmentLabel(s),
					href: isLast
						? undefined
						: `/${orgSeg}/${projectSlug}/${rest.slice(0, j + 1).join("/")}`,
				});
			}
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

			if (UUID_RE.test(seg)) {
				const prev = raw[i - 1];
				if (prev === "jobs") {
					const job = jobs.find((j) => j.id === seg);
					const jobType = job?.job_type;
					const label = jobType && JOB_TYPES[jobType]
						? JOB_TYPES[jobType].label
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
	}, [pathname, jobs]);

	// On /dashboard there are no route crumbs — the bar is just "[·] / Org".
	if (crumbs.length === 0) return null;

	return (
		<Breadcrumb>
			<BreadcrumbList className="flex-nowrap">
				{/* Separators sit between crumbs only — no leading chevron. */}
				{crumbs.map((crumb, i) => (
					<Fragment key={crumb.href ?? crumb.label}>
						{i > 0 && <BreadcrumbSeparator />}
						<BreadcrumbItem className="min-w-0">
							{i < crumbs.length - 1 && crumb.href ? (
								<BreadcrumbLink
									render={
										<Link
											href={crumb.href}
											className="truncate max-w-[120px] sm:max-w-[180px]"
										/>
									}
								>
									{crumb.label}
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
