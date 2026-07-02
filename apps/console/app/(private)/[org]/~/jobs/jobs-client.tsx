"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { DataTable } from "@/components/data-table";
import { buildJobColumns } from "@/components/jobs/columns";
import type { JobAuthorInfo } from "@/components/jobs/job-author";
import { JOB_TYPES } from "@/lib/jobs/format";
import { getMembers, type MemberRow } from "@/app/server/actions/members";
import { displayName } from "@/lib/user-display";
import { useJobsQuery } from "@/lib/query/use-jobs-query";
import { useProjectsQuery } from "@/lib/query/use-projects-query";
import { useActiveOrgSlug } from "@/lib/stores/use-workspace-store";
import type { JobWithMeta } from "@/app/server/actions/jobs";
import { Button } from "@repo/ui/button";
import { DateRangeFilter } from "@repo/ui/date-range-filter";
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@repo/ui/empty";
import { MultiCombobox } from "@repo/ui/multi-combobox";
import { QuickRangeFilter } from "@repo/ui/quick-range-filter";
import {
	type DateRange,
	formatRangeLabel,
	presetRange,
	RANGE_PRESETS,
} from "@repo/ui/range";
import { TooltipProvider } from "@repo/ui/tooltip";
import { Activity, Boxes, ClipboardList, Layers, Users, Wrench } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

/** Jobs default to a wide window so history isn't hidden; users narrow with the range picker. */
const JOBS_DEFAULT_PRESET = "12mo";

const STATUS_OPTIONS = [
	"QUEUED",
	"CLAIMED",
	"PROCESSING",
	"SUCCESS",
	"FAILED",
	"CANCELLED",
].map((s) => ({ value: s, label: s.charAt(0) + s.slice(1).toLowerCase() }));

const TYPE_OPTIONS = Object.entries(JOB_TYPES).map(([value, info]) => ({
	value,
	label: info.label,
}));

/**
 * Jobs list UI. Data comes from the shared `useJobsQuery` cache (server-prefetched, hydrated,
 * then polled); filters are local. Pass `projectId` to scope it to one project (the Project facet
 * + column are then hidden) — used by a project's jobs tab; the org route passes none.
 */
export function JobsClient({ projectId }: { projectId?: string } = {}) {
	const router = useRouter();
	const orgSlug = useActiveOrgSlug();
	const { data: jobs = [] } = useJobsQuery();
	const { data: projects = [], isPending: projectsLoading } = useProjectsQuery();
	const [members, setMembers] = useState<MemberRow[]>([]);
	const [membersLoading, setMembersLoading] = useState(true);

	useEffect(() => {
		getMembers()
			.then(setMembers)
			.catch(() => setMembers([]))
			.finally(() => setMembersLoading(false));
	}, []);

	// Filters.
	const [range, setRange] = useState<DateRange>(() =>
		presetRange(JOBS_DEFAULT_PRESET),
	);
	const [rangeLabel, setRangeLabel] = useState(
		RANGE_PRESETS.find((p) => p.id === JOBS_DEFAULT_PRESET)?.label ??
			"Last 12 months",
	);
	const [authorIds, setAuthorIds] = useState<string[]>([]);
	const [envIds, setEnvIds] = useState<string[]>([]);
	const [projectIds, setProjectIds] = useState<string[]>([]);
	const [statuses, setStatuses] = useState<string[]>([]);
	const [types, setTypes] = useState<string[]>([]);
	const [pageIndex, setPageIndex] = useState(0);

	const authorById = useMemo(
		() =>
			new Map<string, JobAuthorInfo>(
				members.map((m) => [
					m.userId,
					{
						name: m.name,
						username: m.username,
						email: m.email,
						image: m.image,
					},
				]),
			),
		[members],
	);

	const userOptions = useMemo(
		() =>
			members.map((m) => ({
				value: m.userId,
				label: displayName({ name: m.name, username: m.username, email: m.email }),
				image: m.image,
			})),
		[members],
	);
	const projectOptions = useMemo(
		() => projects.map((p) => ({ value: p.id, label: p.project_name })),
		[projects],
	);
	// Environment options are derived from the jobs in view (a job carries env id + name).
	const envOptions = useMemo(() => {
		const seen = new Map<string, string>();
		for (const j of jobs) {
			if (j.environment_id && j.environment_name && !seen.has(j.environment_id)) {
				seen.set(
					j.environment_id,
					j.environment_stage
						? `${j.environment_name} (${j.environment_stage})`
						: j.environment_name,
				);
			}
		}
		return [...seen].map(([value, label]) => ({ value, label }));
	}, [jobs]);

	const filtered = useMemo(() => {
		const from = range.from.getTime();
		const to = range.to.getTime();
		const authorSet = new Set(authorIds);
		const envSet = new Set(envIds);
		const projectSet = new Set(projectIds);
		const statusSet = new Set(statuses);
		const typeSet = new Set(types);

		return jobs.filter((j) => {
			if (projectId && j.project_id !== projectId) return false;
			if (j.created_at) {
				const t = new Date(j.created_at).getTime();
				if (t < from || t > to) return false;
			}
			if (authorSet.size && (!j.user_id || !authorSet.has(j.user_id))) return false;
			if (envSet.size && (!j.environment_id || !envSet.has(j.environment_id)))
				return false;
			if (
				!projectId &&
				projectSet.size &&
				(!j.project_id || !projectSet.has(j.project_id))
			)
				return false;
			if (statusSet.size && !statusSet.has(j.status)) return false;
			if (typeSet.size && !typeSet.has(j.job_type)) return false;
			return true;
		});
	}, [jobs, projectId, range, authorIds, envIds, projectIds, statuses, types]);

	// Reset to the first page whenever the filters change (the set may shrink).
	useEffect(() => {
		setPageIndex(0);
	}, [range, authorIds, envIds, projectIds, statuses, types]);

	const columns = useMemo(
		() => buildJobColumns({ showProject: !projectId, authorById }),
		[projectId, authorById],
	);

	const handleRowClick = (job: JobWithMeta) => {
		router.push(`/${orgSlug}/~/jobs/${job.id}`);
	};

	return (
		<div className="space-y-6">
			{jobs.length === 0 ? (
				<Empty className="min-h-[60vh] border border-dashed">
					<EmptyHeader>
						<EmptyMedia variant="icon">
							<ClipboardList />
						</EmptyMedia>
						<EmptyTitle>No jobs yet</EmptyTitle>
						<EmptyDescription>
							Jobs are created when you provision a project or connect a cloud
							account.
						</EmptyDescription>
					</EmptyHeader>
					<EmptyContent>
						<Button asChild variant="outline" size="sm">
							<Link href={`/${orgSlug}/~/new`}>Create a project</Link>
						</Button>
					</EmptyContent>
				</Empty>
			) : (
				<>
					<div className="flex flex-wrap items-center gap-2.5">
						<QuickRangeFilter
							label={rangeLabel}
							value={range}
							onChange={(r, l) => {
								setRange(r);
								if (l !== undefined) setRangeLabel(l);
							}}
						/>
						<DateRangeFilter
							value={range}
							onChange={(r) => {
								setRange(r);
								setRangeLabel(formatRangeLabel(r));
							}}
						/>
						<MultiCombobox
							placeholder="All authors"
							icon={Users}
							options={userOptions}
							value={authorIds}
							onChange={setAuthorIds}
							withAvatar
							loading={membersLoading}
						/>
						<MultiCombobox
							placeholder="All environments"
							icon={Layers}
							options={envOptions}
							value={envIds}
							onChange={setEnvIds}
						/>
						{!projectId && (
							<MultiCombobox
								placeholder="All projects"
								icon={Boxes}
								options={projectOptions}
								value={projectIds}
								onChange={setProjectIds}
								loading={projectsLoading}
								emptyAction={{
									label: "Create project",
									onSelect: () => router.push(`/${orgSlug}/~/new`),
								}}
							/>
						)}
						<MultiCombobox
							placeholder="All statuses"
							icon={Activity}
							options={STATUS_OPTIONS}
							value={statuses}
							onChange={setStatuses}
						/>
						<MultiCombobox
							placeholder="All types"
							icon={Wrench}
							options={TYPE_OPTIONS}
							value={types}
							onChange={setTypes}
						/>
					</div>

					<TooltipProvider delayDuration={300}>
						<DataTable
							columns={columns}
							data={filtered}
							onRowClick={handleRowClick}
							pageIndex={pageIndex}
							onPageIndexChange={setPageIndex}
							scrollHeight="h-[70vh]"
						/>
					</TooltipProvider>
				</>
			)}
		</div>
	);
}
