// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Supervisor / colony orchestration core (elench A4). The deterministic, replayable
 * harness that delegates tasks to sub-agents and drives them to completion via a
 * Magentic-style Task Ledger (facts + plan) and Progress Ledger (per-task status +
 * a stall counter that triggers a bounded re-plan). The actual sub-agent execution
 * (the LLM-backed agent runs) is INJECTED, so this control flow is fully testable
 * without a model — the same "AI executes, deterministic code decides" discipline as
 * RunRemediationLoop.
 *
 * Scope guard (research): a standing colony costs ~15× the tokens and loses on work
 * over one convergent state. This core is intended for breadth-first READ fan-out
 * (drift/cost/security across accounts) and tenant-isolated tasks; callers must keep
 * write/converge work on a single-threaded path, not parallelize it here.
 */

export type TaskStatus = "pending" | "in_progress" | "done" | "failed";

export interface Task {
	id: string;
	objective: string;
	/** Which sub-agent persona should handle it (advisory; the runner decides). */
	assignedTo?: string;
	status: TaskStatus;
	result?: string;
}

/** The supervisor's shared blackboard + audit trail. */
export interface Ledger {
	/** Established facts (infra state, drift, cost) accumulated across the run. */
	facts: string[];
	/** The current plan (ordered task ids). */
	plan: string[];
	tasks: Task[];
	/** Consecutive failures since the last success — drives re-plan. */
	stall: number;
	/** How many times the supervisor re-planned. */
	replans: number;
}

/** Runs one delegated task and returns its outcome. Injected (LLM/agent-backed). */
export type SubAgentRunner = (
	task: Task,
	ledger: Ledger,
) => Promise<{ ok: boolean; result: string; facts?: string[] }>;

export interface SupervisorOptions {
	/** Consecutive failures that trigger a re-plan (default 2 — Magentic's stall>2). */
	maxStall?: number;
	/** Hard cap on rounds so the loop always terminates (default tasks*3). */
	maxRounds?: number;
	/** Re-plan hook: may reorder/prune the plan when stalled. Default: drop the head. */
	replan?: (ledger: Ledger) => void;
}

export interface SupervisorResult {
	completed: Task[];
	failed: Task[];
	replans: number;
	ledger: Ledger;
}

/**
 * Drive a set of tasks to completion by delegating each to the injected runner,
 * tracking progress on the ledger, and re-planning when the run stalls. Always
 * terminates (bounded by maxRounds); never loops forever.
 */
export async function runSupervisor(
	initialTasks: Task[],
	run: SubAgentRunner,
	opts: SupervisorOptions = {},
): Promise<SupervisorResult> {
	const maxStall = opts.maxStall ?? 2;
	const maxRounds = opts.maxRounds ?? Math.max(1, initialTasks.length * 3);

	const ledger: Ledger = {
		facts: [],
		plan: initialTasks.map((t) => t.id),
		tasks: initialTasks.map((t) => ({ ...t, status: "pending" as TaskStatus })),
		stall: 0,
		replans: 0,
	};

	const byId = new Map(ledger.tasks.map((t) => [t.id, t]));

	for (let round = 0; round < maxRounds; round++) {
		const nextId = ledger.plan.find((id) => byId.get(id)?.status === "pending");
		if (!nextId) break; // nothing left to do
		const task = byId.get(nextId);
		if (!task) {
			ledger.plan = ledger.plan.filter((id) => id !== nextId);
			continue;
		}

		task.status = "in_progress";
		const outcome = await run(task, ledger);
		if (outcome.facts?.length) ledger.facts.push(...outcome.facts);

		if (outcome.ok) {
			task.status = "done";
			task.result = outcome.result;
			ledger.stall = 0;
		} else {
			task.status = "failed";
			task.result = outcome.result;
			ledger.stall++;
			if (ledger.stall > maxStall) {
				ledger.replans++;
				ledger.stall = 0;
				if (opts.replan) {
					opts.replan(ledger);
				} else {
					// Default re-plan: drop already-resolved tasks from the plan head so
					// the supervisor re-focuses on what still needs doing.
					ledger.plan = ledger.plan.filter(
						(id) => byId.get(id)?.status === "pending",
					);
				}
			}
		}
	}

	const completed = ledger.tasks.filter((t) => t.status === "done");
	const failed = ledger.tasks.filter((t) => t.status === "failed");
	return { completed, failed, replans: ledger.replans, ledger };
}
