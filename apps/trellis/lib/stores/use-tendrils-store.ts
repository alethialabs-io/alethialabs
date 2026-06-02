import { create } from "zustand";
import { createClient } from "@/lib/supabase/client";
import {
	setDefaultWorker as setDefaultTendrilAction,
	deployWorker as deployTendrilAction,
	destroyWorker as destroyTendrilAction,
	removeWorker as removeTendrilAction,
	updateWorker as updateTendrilAction,
} from "@/app/server/actions/tendrils";
import type {
	PublicProvisionJobStatus,
	PublicProvisionJobType,
	PublicWorkersRow,
} from "@/lib/validations/db.schemas";

const STALE_THRESHOLD = 30_000;

export interface ActiveJob {
	id: string;
	job_type: PublicProvisionJobType;
	status: PublicProvisionJobStatus;
	config_snapshot: Record<string, unknown>;
	worker_id: string | null;
	vine_id: string | null;
	vines: { project_name: string } | null;
}

export interface TendrilRelease {
	version: string;
	release_notes: string;
	released_at: string;
	github_release_url: string | null;
	commit_sha: string | null;
	is_breaking: boolean;
}

export type TendrilWithRelease = PublicWorkersRow & {
	worker_releases: TendrilRelease | null;
};

interface TendrilsStore {
	tendrils: TendrilWithRelease[];
	activeJobs: ActiveJob[];
	latestRelease: TendrilRelease | null;
	isLoading: boolean;
	lastFetchedAt: number | null;

	fetchTendrils: (force?: boolean) => Promise<void>;
	addOrUpdateTendril: (tendril: TendrilWithRelease) => void;
	removeTendril: (id: string) => void;
	setActiveJobs: (jobs: ActiveJob[]) => void;
	addOrUpdateJob: (job: ActiveJob) => void;
	removeJob: (id: string) => void;
	setDefaultTendril: (tendrilId: string | null) => Promise<void>;
	deployTendril: (params: Parameters<typeof deployTendrilAction>[0]) => Promise<{ workerId: string; jobId: string }>;
	updateTendril: (tendrilId: string) => Promise<{ jobId: string }>;
	updateAllOutdated: (tendrilIds: string[]) => Promise<{ queued: number; failed: number }>;
	destroyTendril: (tendrilId: string, assignedTendrilId?: string | null) => Promise<{ jobId: string }>;
	deleteTendril: (tendrilId: string) => Promise<void>;
	fetchReleaseNotes: (version: string) => Promise<TendrilRelease | null>;
}

export const useTendrilsStore = create<TendrilsStore>()((set, get) => ({
	tendrils: [],
	activeJobs: [],
	latestRelease: null,
	isLoading: false,
	lastFetchedAt: null,

	fetchTendrils: async (force = false) => {
		const { lastFetchedAt, isLoading } = get();
		if (isLoading) return;

		if (
			!force &&
			lastFetchedAt &&
			Date.now() - lastFetchedAt < STALE_THRESHOLD
		) {
			return;
		}

		set({ isLoading: true });
		try {
			const supabase = createClient();
			const [tendrilsRes, jobsRes, releaseRes] = await Promise.all([
				supabase
					.from("workers")
					.select("*, worker_releases(version, release_notes, released_at, github_release_url, commit_sha, is_breaking)")
					.order("is_default", { ascending: false })
					.order("mode", { ascending: true })
					.order("created_at", { ascending: true }),
				supabase
					.from("provision_jobs")
					.select("id, job_type, status, config_snapshot, worker_id, vine_id, vines(project_name)")
					.in("status", ["QUEUED", "CLAIMED", "PROCESSING"]),
				supabase
					.from("worker_releases")
					.select("version, release_notes, released_at, github_release_url, commit_sha, is_breaking")
					.order("released_at", { ascending: false })
					.limit(1)
					.maybeSingle(),
			]);

			set({
				tendrils: (tendrilsRes.data ?? []) as unknown as TendrilWithRelease[],
				activeJobs: (jobsRes.data ?? []) as ActiveJob[],
				latestRelease: (releaseRes.data as TendrilRelease) ?? null,
				lastFetchedAt: Date.now(),
				isLoading: false,
			});
		} catch {
			set({ isLoading: false });
		}
	},

	addOrUpdateTendril: (tendril) => {
		set((state) => {
			const idx = state.tendrils.findIndex((t) => t.id === tendril.id);
			if (idx >= 0) {
				const next = [...state.tendrils];
				next[idx] = tendril;
				return { tendrils: next };
			}
			return { tendrils: [...state.tendrils, tendril] };
		});
	},

	removeTendril: (id) => {
		set((state) => ({
			tendrils: state.tendrils.filter((t) => t.id !== id),
		}));
	},

	setActiveJobs: (jobs) => set({ activeJobs: jobs }),

	addOrUpdateJob: (job) => {
		set((state) => {
			if (job.status === "QUEUED" || job.status === "CLAIMED" || job.status === "PROCESSING") {
				const idx = state.activeJobs.findIndex((j) => j.id === job.id);
				if (idx >= 0) {
					const next = [...state.activeJobs];
					next[idx] = job;
					return { activeJobs: next };
				}
				return { activeJobs: [...state.activeJobs, job] };
			}
			return { activeJobs: state.activeJobs.filter((j) => j.id !== job.id) };
		});
	},

	removeJob: (id) => {
		set((state) => ({
			activeJobs: state.activeJobs.filter((j) => j.id !== id),
		}));
	},

	setDefaultTendril: async (tendrilId) => {
		await setDefaultTendrilAction(tendrilId);
		set((state) => ({
			tendrils: state.tendrils.map((t) => ({
				...t,
				is_default: t.id === tendrilId,
			})),
		}));
	},

	deployTendril: async (params) => {
		const result = await deployTendrilAction(params);
		get().fetchTendrils(true);
		return result;
	},

	updateTendril: async (tendrilId) => {
		const result = await updateTendrilAction(tendrilId);
		get().fetchTendrils(true);
		return result;
	},

	updateAllOutdated: async (tendrilIds) => {
		const results = await Promise.allSettled(
			tendrilIds.map((id) => updateTendrilAction(id)),
		);
		get().fetchTendrils(true);
		let queued = 0;
		let failed = 0;
		for (const r of results) {
			if (r.status === "fulfilled") queued++;
			else failed++;
		}
		return { queued, failed };
	},

	destroyTendril: async (tendrilId, assignedTendrilId) => {
		const result = await destroyTendrilAction(tendrilId, assignedTendrilId);
		get().fetchTendrils(true);
		return result;
	},

	deleteTendril: async (tendrilId) => {
		await removeTendrilAction(tendrilId);
		get().fetchTendrils(true);
	},

	fetchReleaseNotes: async (version) => {
		const supabase = createClient();
		const { data } = await supabase
			.from("worker_releases")
			.select("version, release_notes, released_at, github_release_url, commit_sha, is_breaking")
			.eq("version", version)
			.maybeSingle();
		return (data as TendrilRelease) ?? null;
	},
}));
