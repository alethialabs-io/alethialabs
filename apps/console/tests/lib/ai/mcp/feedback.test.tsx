// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The `send_feedback` sink (lib/ai/mcp/feedback.tsx): on the hosted service it emails the team inbox
// with the caller named by id only; a self-managed deployment has no vendor inbox, so nothing is sent
// and the tool reports it was not received.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@repo/email/send", () => ({ sendEmail: vi.fn() }));
vi.mock("@repo/email/config", () => ({ getEmailConfig: () => ({ from: { general: "Alethia <hello@example.test>" } }) }));
vi.mock("@/lib/billing/config", () => ({ deploymentMode: vi.fn() }));
vi.mock("next-runtime-env", () => ({ env: vi.fn() }));

import { sendEmail } from "@repo/email/send";
import { env } from "next-runtime-env";
import { AgentFeedbackEmail, sendAgentFeedback } from "@/lib/ai/mcp/feedback";
import type { Actor } from "@/lib/authz/types";
import { deploymentMode } from "@/lib/billing/config";

const ACTOR: Actor = { userId: "user-1", orgId: "org-1", credential: "agent_oauth", credentialRef: "client-1" };
const SUBMISSION = { text: "Cannot read cost per environment.", missingCapability: "per-environment cost" };

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(deploymentMode).mockReturnValue("hosted");
});

describe("sendAgentFeedback", () => {
	it("emails the team inbox on the hosted service, naming the caller by id", async () => {
		expect(await sendAgentFeedback(ACTOR, SUBMISSION)).toBe(true);
		expect(sendEmail).toHaveBeenCalledWith(
			expect.objectContaining({ to: "feedback@alethialabs.io", subject: "Agent feedback", from: "Alethia <hello@example.test>" }),
		);
		const { react } = vi.mocked(sendEmail).mock.calls[0][0];
		expect(react.props).toEqual({ submission: SUBMISSION, origin: { orgId: "org-1", userId: "user-1", clientId: "client-1" } });
	});

	it("uses the configured inbox, and names no client for a non-OAuth caller", async () => {
		vi.mocked(env).mockReturnValue("team@example.test");
		await sendAgentFeedback({ ...ACTOR, credential: "session" }, SUBMISSION);
		const args = vi.mocked(sendEmail).mock.calls[0][0];
		expect(args.to).toBe("team@example.test");
		expect(args.react.props).toMatchObject({ origin: { clientId: null } });

		await sendAgentFeedback({ ...ACTOR, credentialRef: undefined }, SUBMISSION);
		expect(vi.mocked(sendEmail).mock.calls[1][0].react.props).toMatchObject({ origin: { clientId: null } });
	});

	it("sends nothing on a self-managed deployment", async () => {
		vi.mocked(deploymentMode).mockReturnValue("self-hosted" as never);
		expect(await sendAgentFeedback(ACTOR, SUBMISSION)).toBe(false);
		expect(sendEmail).not.toHaveBeenCalled();
	});
});

describe("AgentFeedbackEmail", () => {
	it("renders the text, the missing capability when named, and the ids", () => {
		const origin = { orgId: "org-1", userId: "user-1", clientId: null };
		const text = JSON.stringify(AgentFeedbackEmail({ submission: SUBMISSION, origin }));
		expect(text).toContain("Cannot read cost per environment.");
		expect(text).toContain("per-environment cost");
		expect(text).toContain("none");
		const bare = JSON.stringify(AgentFeedbackEmail({ submission: { text: "hi", missingCapability: null }, origin }));
		expect(bare).not.toContain("Missing");
	});
});
