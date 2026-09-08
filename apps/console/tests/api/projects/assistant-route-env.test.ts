// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// Pins the environment scoping of POST /api/projects/[projectId]/assistant. Before this the
// route never learned which environment the user was looking at: the prompt had no scope, the
// tools had no scope, and the approval card planned/deployed the project's DEFAULT environment
// whatever the topbar switcher said. Every collaborator is mocked; what is asserted is the
// wiring — the body's id goes through `resolveActiveEnvironmentId` (org-scoped, falls back to
// the default), the resolved id reaches the prompt, the knowledge readers and the tool builder.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const streamText = vi.fn(() => ({ toUIMessageStream: () => ({}) }));
vi.mock("ai", () => ({
	convertToModelMessages: vi.fn(async (m: unknown) => m),
	createUIMessageStream: vi.fn(
		({ execute }: { execute: (o: { writer: unknown }) => void }) => {
			execute({ writer: { write: vi.fn(), merge: vi.fn() } });
			return {};
		},
	),
	createUIMessageStreamResponse: vi.fn(() => new Response("ok")),
	stepCountIs: vi.fn(() => () => false),
	streamText: (args: unknown) => streamText(args),
}));

vi.mock("@/app/server/actions/agent", () => ({ saveThreadMessages: vi.fn() }));
vi.mock("@/app/server/actions/resolve", () => ({
	resolveActiveEnvironmentId: vi.fn(),
}));
vi.mock("@/lib/ai/project-knowledge", () => ({
	buildProjectKnowledge: vi.fn(),
	formatContextBlock: vi.fn(() => ""),
	readAgentContext: vi.fn(async () => null),
}));
vi.mock("@/lib/ai/environment-knowledge", () => ({
	buildEnvironmentKnowledge: vi.fn(),
}));
vi.mock("@/lib/ai/tools", () => ({ buildProjectAgentTools: vi.fn(() => ({})) }));
vi.mock("@/lib/auth/owner", () => ({ getOwner: vi.fn(async () => "user-1") }));
vi.mock("@/lib/authz/guard", () => ({
	currentActor: vi.fn(async () => ({ userId: "user-1", orgId: "org-1" })),
}));
vi.mock("@/lib/billing/agent-metering", () => ({ recordAgentTurnUsage: vi.fn() }));
vi.mock("@/lib/billing/ai-quota", () => ({
	meteringFailed: vi.fn(() => () => undefined),
	recordAiUsage: vi.fn(),
}));
vi.mock("@/lib/billing/ai-guard", () => ({
	AiBudgetError: class AiBudgetError extends Error {},
	assertAiAllowed: vi.fn(async () => ({ source: "included", credits: 1 })),
	releaseAiHold: vi.fn(),
}));
vi.mock("@/lib/billing/ai-plan", () => ({ resolveAiTier: vi.fn(async () => "ai_free") }));
vi.mock("@/lib/config/ai", () => ({
	isAiConfigured: () => true,
	getExecutorModel: () => ({ key: "haiku", model: {} }),
	getAdvisorModel: () => ({ key: "haiku", model: {} }),
}));

import { resolveActiveEnvironmentId } from "@/app/server/actions/resolve";
import { buildEnvironmentKnowledge } from "@/lib/ai/environment-knowledge";
import { buildProjectKnowledge } from "@/lib/ai/project-knowledge";
import { buildProjectAgentTools } from "@/lib/ai/tools";

const PROJECT = "2b6c0d1e-7a3c-4b5d-8f0a-1c2d3e4f5a6b";
const REQUESTED_ENV = "3f7c1a2e-8b4d-4c6e-9a1b-2d3e4f5a6b7c";
const DEFAULT_ENV = "4a8d2b3f-9c5e-4d7f-8b2c-3e4f5a6b7c8d";

/** POST the route with a body; only `environmentId` / `view` vary per test. */
async function post(body: Record<string, unknown>) {
	const { POST } = await import("@/app/api/projects/[projectId]/assistant/route");
	return POST(
		new Request(`https://console.local/api/projects/${PROJECT}/assistant`, {
			method: "POST",
			body: JSON.stringify({ messages: [], mentions: [], deepReasoning: false, ...body }),
		}),
		{ params: Promise.resolve({ projectId: PROJECT }) },
	);
}

/** The system prompt the route handed to streamText. */
function systemPrompt(): string {
	const call = streamText.mock.calls[0]?.[0] as
		| { messages: Array<{ role: string; content: string }> }
		| undefined;
	const system = call?.messages.find((m) => m.role === "system");
	if (!system) throw new Error("streamText was not handed a system message");
	return system.content;
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(resolveActiveEnvironmentId).mockResolvedValue(REQUESTED_ENV);
	vi.mocked(buildProjectKnowledge).mockResolvedValue("## Project knowledge\n- Name: checkout");
	vi.mocked(buildEnvironmentKnowledge).mockResolvedValue({
		name: "prod-eu",
		block: `## Environment knowledge (live)\n- Name: prod-eu · id: ${REQUESTED_ENV}`,
	});
});

describe("POST /api/projects/[projectId]/assistant — environment scope", () => {
	it("resolves the body's environment id under the caller's org", async () => {
		const res = await post({ environmentId: REQUESTED_ENV });
		expect(res.status).toBe(200);
		expect(resolveActiveEnvironmentId).toHaveBeenCalledWith(PROJECT, REQUESTED_ENV);
	});

	it("puts the Environment block and the scope rule on the system prompt", async () => {
		await post({
			environmentId: REQUESTED_ENV,
			view: {
				path: "/acme/checkout/prod-eu",
				surface: "architecture",
				openCard: { kind: "database", name: "orders" },
			},
		});
		const system = systemPrompt();
		expect(system).toContain("## Environment knowledge (live)");
		expect(system).toContain(`- Name: prod-eu · id: ${REQUESTED_ENV}`);
		expect(system).toContain(
			`This conversation is scoped to environment "prod-eu" (id: ${REQUESTED_ENV})`,
		);
		expect(system).toContain(
			`Every \`propose_operation\` MUST carry \`environmentId: ${REQUESTED_ENV}\``,
		);
		expect(system).toContain(
			'The user is on the architecture surface (/acme/checkout/prod-eu) with the database card "orders" open.',
		);
		expect(system).toContain("discussed a different environment, say so before acting");
		// The knowledge readers are scoped to the same id the prompt names.
		expect(buildEnvironmentKnowledge).toHaveBeenCalledWith(
			{ userId: "user-1", orgId: "org-1" },
			PROJECT,
			REQUESTED_ENV,
		);
		expect(buildProjectKnowledge).toHaveBeenCalledWith(
			{ userId: "user-1", orgId: "org-1" },
			PROJECT,
			REQUESTED_ENV,
		);
	});

	it("hands the resolved environment to the tool builder", async () => {
		await post({ environmentId: REQUESTED_ENV });
		expect(buildProjectAgentTools).toHaveBeenCalledWith(undefined, {
			environmentId: REQUESTED_ENV,
		});
	});

	it("scopes to the RESOLVED id, not the requested one, when a foreign id falls back to the default", async () => {
		vi.mocked(resolveActiveEnvironmentId).mockResolvedValue(DEFAULT_ENV);
		vi.mocked(buildEnvironmentKnowledge).mockResolvedValue({ name: "dev", block: "" });
		await post({ environmentId: REQUESTED_ENV });
		expect(resolveActiveEnvironmentId).toHaveBeenCalledWith(PROJECT, REQUESTED_ENV);
		expect(buildProjectAgentTools).toHaveBeenCalledWith(undefined, {
			environmentId: DEFAULT_ENV,
		});
		const system = systemPrompt();
		expect(system).toContain(`environmentId: ${DEFAULT_ENV}`);
		expect(system).not.toContain(REQUESTED_ENV);
	});

	it("resolves the default when the body carries no environment (a malformed id parses to null)", async () => {
		vi.mocked(resolveActiveEnvironmentId).mockResolvedValue(DEFAULT_ENV);
		await post({ environmentId: "not-a-uuid" });
		expect(resolveActiveEnvironmentId).toHaveBeenCalledWith(PROJECT, undefined);
	});

	it("orients the model on an unknown surface as 'other' rather than dropping the turn", async () => {
		const res = await post({
			environmentId: REQUESTED_ENV,
			view: { path: "/acme/checkout/billing", surface: "billing" },
		});
		expect(res.status).toBe(200);
		expect(systemPrompt()).toContain("The user is on the other surface (/acme/checkout/billing).");
	});

	it("says so in the prompt when no environment resolves, and scopes nothing", async () => {
		vi.mocked(resolveActiveEnvironmentId).mockRejectedValue(
			new Error("Project has no default environment"),
		);
		await post({});
		expect(buildEnvironmentKnowledge).not.toHaveBeenCalled();
		expect(buildProjectAgentTools).toHaveBeenCalledWith(undefined, { environmentId: null });
		const system = systemPrompt();
		expect(system).toContain("No environment could be resolved for this conversation");
		expect(system).not.toContain("## Environment knowledge");
	});

	it("keeps the prompt when the environment knowledge read fails (a degraded block, not a 500)", async () => {
		vi.mocked(buildEnvironmentKnowledge).mockRejectedValue(new Error("db down"));
		const res = await post({ environmentId: REQUESTED_ENV });
		expect(res.status).toBe(200);
		const system = systemPrompt();
		// The id still scopes the proposals even when the name could not be read.
		expect(system).toContain(`(name not visible) (id: ${REQUESTED_ENV})`);
	});
});
