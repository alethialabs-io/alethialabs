// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// The Architecture board's design and job writes on the mutation contract (#6119,
// app/server/actions/canvas-writes.ts). Each runs the SAME project-domain function every other caller
// runs; what this file pins is what the action adds: the input is parsed before anything runs, the
// environment is resolved inside the actor's org before it is written, a returned refusal becomes a
// `conflict` whose sentence is the user's, a refusal the function THROWS on purpose keeps its kind,
// and an unknown failure is `unexpected` — its text never leaves the server.

import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	resolveActiveEnvironmentId: vi.fn(),
	applyStagedChanges: vi.fn(),
	discardStagedChanges: vi.fn(),
	tryProvisionProject: vi.fn(),
	tryDestroyProject: vi.fn(),
	tryPlanProject: vi.fn(),
	tryQueueDriftDetection: vi.fn(),
	tryCreateProject: vi.fn(),
}));
vi.mock("@/app/server/actions/resolve", () => ({
	resolveActiveEnvironmentId: m.resolveActiveEnvironmentId,
}));
vi.mock("@/app/server/actions/staged-changes", () => ({
	applyStagedChanges: m.applyStagedChanges,
	discardStagedChanges: m.discardStagedChanges,
}));
vi.mock("@/app/server/actions/projects", () => ({
	tryProvisionProject: m.tryProvisionProject,
	tryDestroyProject: m.tryDestroyProject,
	tryPlanProject: m.tryPlanProject,
	tryQueueDriftDetection: m.tryQueueDriftDetection,
	tryCreateProject: m.tryCreateProject,
}));
// The design schema is the project form's own subject; here any object is a design.
vi.mock("@/lib/validations/project-form.schema", async () => {
	const { z } = await import("zod");
	return { projectFormSchema: z.object({ project: z.object({ project_name: z.string() }) }) };
});

import {
	createProjectFromDesignAction,
	deployDesignAction,
	destroyEnvironmentAction,
	detectDriftAction,
	discardStagedDesignAction,
	planEnvironmentAction,
	saveDesignAction,
} from "@/app/server/actions/canvas-writes";
import { UsageLimitError } from "@/lib/billing/usage-guard";
import { NO_DEFAULT_ENVIRONMENT } from "@/lib/canvas/write-refusals";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const ENV = "22222222-2222-4222-8222-222222222222";
// Typed as the action's real input (the mocked schema accepts it); the full project form is not
// this file's subject.
const DESIGN = { project: { project_name: "shop" } } as never;

beforeEach(() => {
	vi.clearAllMocks();
	vi.spyOn(console, "error").mockImplementation(() => {});
	m.resolveActiveEnvironmentId.mockResolvedValue(ENV);
	m.applyStagedChanges.mockResolvedValue({ success: true });
	m.discardStagedChanges.mockResolvedValue({ success: true });
});

describe("deployDesignAction", () => {
	it("saves the design to the RESOLVED environment, then queues its deploy", async () => {
		m.tryProvisionProject.mockResolvedValue({ ok: true, jobId: "job-1" });

		const result = await deployDesignAction({ projectId: PROJECT, environmentId: null, design: DESIGN });

		expect(result).toEqual({ ok: true, data: { environmentId: ENV, jobId: "job-1" } });
		expect(m.resolveActiveEnvironmentId).toHaveBeenCalledWith(PROJECT, null);
		expect(m.applyStagedChanges).toHaveBeenCalledWith(PROJECT, ENV, DESIGN);
		expect(m.tryProvisionProject).toHaveBeenCalledWith(PROJECT, undefined, undefined, ENV);
		expect(m.applyStagedChanges.mock.invocationCallOrder[0]).toBeLessThan(
			m.tryProvisionProject.mock.invocationCallOrder[0],
		);
	});

	it("answers a refused deploy as a conflict with its sentence — the design is saved by then", async () => {
		const reason = "Connect a cloud account for this project before deploying.";
		m.tryProvisionProject.mockResolvedValue({ ok: false, error: reason });

		const result = await deployDesignAction({ projectId: PROJECT, environmentId: ENV, design: DESIGN });

		expect(result).toEqual({ ok: false, error: { kind: "conflict", message: reason } });
		expect(m.applyStagedChanges).toHaveBeenCalledTimes(1);
	});

	it("refuses an environment that does not resolve for the actor as not-found, writing nothing", async () => {
		m.resolveActiveEnvironmentId.mockRejectedValue(new Error(NO_DEFAULT_ENVIRONMENT));

		const result = await deployDesignAction({ projectId: PROJECT, environmentId: ENV, design: DESIGN });

		expect(result).toEqual({
			ok: false,
			error: { kind: "not-found", message: "Environment not found." },
		});
		expect(m.applyStagedChanges).not.toHaveBeenCalled();
		expect(m.tryProvisionProject).not.toHaveBeenCalled();
	});

	it("parses its input before anything runs", async () => {
		const result = await deployDesignAction({ projectId: "not-a-uuid", environmentId: null, design: DESIGN });

		expect(result.ok).toBe(false);
		expect(!result.ok && result.error.kind).toBe("validation");
		expect(m.resolveActiveEnvironmentId).not.toHaveBeenCalled();
	});

	it("keeps an unknown failure's text on the server", async () => {
		m.applyStagedChanges.mockRejectedValue(new Error("connection terminated"));

		const result = await deployDesignAction({ projectId: PROJECT, environmentId: ENV, design: DESIGN });

		expect(result.ok).toBe(false);
		expect(!result.ok && result.error.kind).toBe("unexpected");
		expect(JSON.stringify(result)).not.toContain("connection terminated");
	});
});

describe("saveDesignAction / discardStagedDesignAction", () => {
	it("saves without provisioning", async () => {
		const result = await saveDesignAction({ projectId: PROJECT, environmentId: ENV, design: DESIGN });

		expect(result).toEqual({ ok: true, data: { environmentId: ENV } });
		expect(m.applyStagedChanges).toHaveBeenCalledWith(PROJECT, ENV, DESIGN);
		expect(m.tryProvisionProject).not.toHaveBeenCalled();
	});

	it("discards the RESOLVED environment's staged changes", async () => {
		const result = await discardStagedDesignAction({ projectId: PROJECT, environmentId: null });

		expect(result).toEqual({ ok: true, data: { environmentId: ENV } });
		expect(m.discardStagedChanges).toHaveBeenCalledWith(PROJECT, ENV);
	});
});

describe("destroyEnvironmentAction", () => {
	it("queues the destroy on the resolved environment and answers how many were queued", async () => {
		m.tryDestroyProject.mockResolvedValue({ ok: true, jobId: "a", jobs: [{ jobId: "b" }, { jobId: "a" }] });

		const result = await destroyEnvironmentAction({ projectId: PROJECT, environmentId: ENV, cascade: true });

		expect(result).toEqual({ ok: true, data: { environmentId: ENV, queued: 2 } });
		expect(m.tryDestroyProject).toHaveBeenCalledWith(PROJECT, ENV, null, { cascade: true });
	});

	it("answers the orphaned-tenants refusal as a conflict naming them", async () => {
		const reason = "This cluster still hosts 2 environments — destroy them first, or cascade.";
		m.tryDestroyProject.mockResolvedValue({ ok: false, error: reason });

		const result = await destroyEnvironmentAction({ projectId: PROJECT, environmentId: ENV, cascade: false });

		expect(result).toEqual({ ok: false, error: { kind: "conflict", message: reason } });
	});
});

describe("the Run menu's Plan and Detect drift", () => {
	it("queue against the named environment", async () => {
		m.tryPlanProject.mockResolvedValue({ ok: true, jobId: "plan-1" });
		m.tryQueueDriftDetection.mockResolvedValue({ ok: true, jobId: "drift-1" });

		expect(await planEnvironmentAction({ projectId: PROJECT, environmentId: ENV })).toEqual({
			ok: true,
			data: { jobId: "plan-1" },
		});
		expect(m.tryPlanProject).toHaveBeenCalledWith(PROJECT, null, ENV);
		expect(await detectDriftAction({ projectId: PROJECT, environmentId: ENV })).toEqual({
			ok: true,
			data: { jobId: "drift-1" },
		});
		expect(m.tryQueueDriftDetection).toHaveBeenCalledWith(PROJECT, ENV);
	});

	it("an upgradable job cap is an entitlement refusal; a hard one is a conflict", async () => {
		m.tryPlanProject.mockRejectedValueOnce(new UsageLimitError("Free plan: 20 jobs a day.", true));
		expect(await planEnvironmentAction({ projectId: PROJECT, environmentId: ENV })).toEqual({
			ok: false,
			error: { kind: "entitlement", message: "Free plan: 20 jobs a day.", feature: "jobQuota" },
		});
		m.tryPlanProject.mockRejectedValueOnce(new UsageLimitError("Usage cap reached.", false));
		expect(await planEnvironmentAction({ projectId: PROJECT, environmentId: ENV })).toEqual({
			ok: false,
			error: { kind: "conflict", message: "Usage cap reached." },
		});
	});
});

describe("createProjectFromDesignAction", () => {
	it("answers the new project's id and slug", async () => {
		m.tryCreateProject.mockResolvedValue({ ok: true, project: { id: PROJECT, slug: "shop" } });

		expect(await createProjectFromDesignAction({ design: DESIGN })).toEqual({
			ok: true,
			data: { projectId: PROJECT, slug: "shop" },
		});
	});

	it("answers a name the org already holds as a conflict with its sentence", async () => {
		const reason = "A project named “shop” already exists in this organization.";
		m.tryCreateProject.mockResolvedValue({ ok: false, error: reason });

		expect(await createProjectFromDesignAction({ design: DESIGN })).toEqual({
			ok: false,
			error: { kind: "conflict", message: reason },
		});
	});
});
