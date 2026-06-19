// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { create } from "zustand";
import {
	setDefaultRunner as setDefaultRunnerAction,
	deployRunner as deployRunnerAction,
	destroyRunner as destroyRunnerAction,
	removeRunner as removeRunnerAction,
	updateRunner as updateRunnerAction,
	getRunnersWithReleases,
	getLatestRunnerRelease,
	getReleaseNotes,
} from "@/app/server/actions/runners";
import type {
	ProvisionJobStatus as PublicProvisionJobStatus,
	ProvisionJobType as PublicProvisionJobType,
	Runner,
} from "@/lib/db/schema";

const STALE_THRESHOLD = 30_000;

export interface ActiveJob {
	id: string;
	job_type: PublicProvisionJobType;
	status: PublicProvisionJobStatus;
	config_snapshot: Record<string, unknown>;
	runner_id: string | null;
	spec_id: string | null;
	specs: { project_name: string } | null;
}

export interface RunnerReleaseInfo {
	version: string;
	release_notes: string;
	released_at: string;
	github_release_url: string | null;
	commit_sha: string | null;
	is_breaking: boolean;
}

export type RunnerWithRelease = Runner & {
	runner_releases: RunnerReleaseInfo | null;
};

interface RunnersStore {
	runners: RunnerWithRelease[];
	latestRelease: RunnerReleaseInfo | null;
	isLoading: boolean;
	error: string | null;
	lastFetchedAt: number | null;

	fetchRunners: (force?: boolean) => Promise<void>;
	addOrUpdateRunner: (runner: RunnerWithRelease) => void;
	removeRunner: (id: string) => void;
	setDefaultRunner: (runnerId: string | null) => Promise<void>;
	deployRunner: (params: Parameters<typeof deployRunnerAction>[0]) => Promise<{ runnerId: string; jobId: string }>;
	updateRunner: (runnerId: string) => Promise<{ jobId: string }>;
	updateAllOutdated: (runnerIds: string[]) => Promise<{ queued: number; failed: number }>;
	destroyRunner: (runnerId: string, assignedRunnerId?: string | null) => Promise<{ jobId: string }>;
	deleteRunner: (runnerId: string) => Promise<void>;
	fetchReleaseNotes: (version: string) => Promise<RunnerReleaseInfo | null>;
}

export const useRunnersStore = create<RunnersStore>()((set, get) => ({
	runners: [],
	latestRelease: null,
	isLoading: false,
	error: null,
	lastFetchedAt: null,

	fetchRunners: async (force = false) => {
		const { lastFetchedAt, isLoading } = get();
		if (isLoading) return;

		if (
			!force &&
			lastFetchedAt &&
			Date.now() - lastFetchedAt < STALE_THRESHOLD
		) {
			return;
		}

		set({ isLoading: true, error: null });
		try {
			const [runners, latestRelease] = await Promise.all([
				getRunnersWithReleases(),
				getLatestRunnerRelease(),
			]);

			set({
				runners,
				latestRelease,
				lastFetchedAt: Date.now(),
				isLoading: false,
				error: null,
			});
		} catch (err) {
			set({ isLoading: false, error: err instanceof Error ? err.message : "Failed to fetch runners" });
		}
	},

	addOrUpdateRunner: (runner) => {
		set((state) => {
			const idx = state.runners.findIndex((r) => r.id === runner.id);
			if (idx >= 0) {
				const next = [...state.runners];
				next[idx] = runner;
				return { runners: next };
			}
			return { runners: [...state.runners, runner] };
		});
	},

	removeRunner: (id) => {
		set((state) => ({
			runners: state.runners.filter((r) => r.id !== id),
		}));
	},

	setDefaultRunner: async (runnerId) => {
		await setDefaultRunnerAction(runnerId);
		set((state) => ({
			runners: state.runners.map((r) => ({
				...r,
				is_default: r.id === runnerId,
			})),
		}));
	},

	deployRunner: async (params) => {
		const result = await deployRunnerAction(params);
		get().fetchRunners(true);
		return result;
	},

	updateRunner: async (runnerId) => {
		const result = await updateRunnerAction(runnerId);
		get().fetchRunners(true);
		return result;
	},

	updateAllOutdated: async (runnerIds) => {
		const results = await Promise.allSettled(
			runnerIds.map((id) => updateRunnerAction(id)),
		);
		get().fetchRunners(true);
		let queued = 0;
		let failed = 0;
		for (const r of results) {
			if (r.status === "fulfilled") queued++;
			else failed++;
		}
		return { queued, failed };
	},

	destroyRunner: async (runnerId, assignedRunnerId) => {
		const result = await destroyRunnerAction(runnerId, assignedRunnerId);
		get().fetchRunners(true);
		return result;
	},

	deleteRunner: async (runnerId) => {
		await removeRunnerAction(runnerId);
		get().fetchRunners(true);
	},

	fetchReleaseNotes: async (version) => {
		return getReleaseNotes(version);
	},
}));
