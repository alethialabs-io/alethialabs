import { create } from "zustand";
import { createClient } from "@/lib/supabase/client";
import {
	setDefaultWorker as setDefaultWorkerAction,
	deployWorker as deployWorkerAction,
	destroyWorker as destroyWorkerAction,
	removeWorker as removeWorkerAction,
} from "@/app/server/actions/workers";
import type { PublicWorkersRow } from "@/lib/validations/db.schemas";

const STALE_THRESHOLD = 30_000;

export interface ActiveJob {
	id: string;
	job_type: string;
	status: string;
	worker_id: string | null;
	vine_id: string | null;
	vines: { project_name: string } | null;
}

interface WorkersStore {
	workers: PublicWorkersRow[];
	activeJobs: ActiveJob[];
	isLoading: boolean;
	lastFetchedAt: number | null;

	fetchWorkers: (force?: boolean) => Promise<void>;
	addOrUpdateWorker: (worker: PublicWorkersRow) => void;
	removeWorker: (id: string) => void;
	setActiveJobs: (jobs: ActiveJob[]) => void;
	addOrUpdateJob: (job: ActiveJob) => void;
	removeJob: (id: string) => void;
	setDefaultWorker: (workerId: string | null) => Promise<void>;
	deployWorker: (params: Parameters<typeof deployWorkerAction>[0]) => Promise<{ workerId: string; jobId: string }>;
	destroyWorker: (workerId: string) => Promise<{ jobId: string }>;
	deleteWorker: (workerId: string) => Promise<void>;
}

export const useWorkersStore = create<WorkersStore>()((set, get) => ({
	workers: [],
	activeJobs: [],
	isLoading: false,
	lastFetchedAt: null,

	fetchWorkers: async (force = false) => {
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
			const [workersRes, jobsRes] = await Promise.all([
				supabase
					.from("workers")
					.select("*")
					.order("is_default", { ascending: false })
					.order("mode", { ascending: true })
					.order("created_at", { ascending: true }),
				supabase
					.from("provision_jobs")
					.select("id, job_type, status, worker_id, vine_id, vines(project_name)")
					.in("status", ["CLAIMED", "PROCESSING"]),
			]);

			set({
				workers: (workersRes.data ?? []) as PublicWorkersRow[],
				activeJobs: (jobsRes.data ?? []) as unknown as ActiveJob[],
				lastFetchedAt: Date.now(),
				isLoading: false,
			});
		} catch {
			set({ isLoading: false });
		}
	},

	addOrUpdateWorker: (worker) => {
		set((state) => {
			const idx = state.workers.findIndex((w) => w.id === worker.id);
			if (idx >= 0) {
				const next = [...state.workers];
				next[idx] = worker;
				return { workers: next };
			}
			return { workers: [...state.workers, worker] };
		});
	},

	removeWorker: (id) => {
		set((state) => ({
			workers: state.workers.filter((w) => w.id !== id),
		}));
	},

	setActiveJobs: (jobs) => set({ activeJobs: jobs }),

	addOrUpdateJob: (job) => {
		set((state) => {
			if (job.status === "CLAIMED" || job.status === "PROCESSING") {
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

	setDefaultWorker: async (workerId) => {
		await setDefaultWorkerAction(workerId);
		set((state) => ({
			workers: state.workers.map((w) => ({
				...w,
				is_default: w.id === workerId,
			} as PublicWorkersRow)),
		}));
	},

	deployWorker: async (params) => {
		const result = await deployWorkerAction(params);
		get().fetchWorkers(true);
		return result;
	},

	destroyWorker: async (workerId) => {
		const result = await destroyWorkerAction(workerId);
		get().fetchWorkers(true);
		return result;
	},

	deleteWorker: async (workerId) => {
		await removeWorkerAction(workerId);
		get().fetchWorkers(true);
	},
}));
