// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// POST /api/cli/projects/:id/design (`alethia apply`) and a credential in provider_config (#5565).
// The refusal is the caller's input being wrong, so it is a 400 carrying the refusal — not the 500
// an unexpected server error gets. Both the applied and the staged mode answer the same way.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/server/actions/projects", () => ({
	updateProjectDesign: vi.fn(),
	getProjectAsFormData: vi.fn(),
}));
vi.mock("@/app/server/actions/staged-changes", () => ({ stageChanges: vi.fn() }));
vi.mock("@/lib/authz/actor-context", () => ({
	runWithActor: vi.fn((_actor: unknown, fn: () => unknown) => fn()),
}));
vi.mock("@/lib/authz/guard", () => ({ authorizeCli: vi.fn() }));
vi.mock("@/lib/cli/resolve-project", () => ({
	resolveCliProject: vi.fn(),
	resolveCliWriteEnvironment: vi.fn(),
}));
// The design document's own validation is not what this pins; it accepts the body as given.
vi.mock("@/lib/validations/project-form.schema", () => ({
	projectFormSchema: { safeParse: (raw: unknown) => ({ success: true, data: raw }) },
}));

import { POST } from "@/app/api/cli/projects/[id]/design/route";
import { updateProjectDesign } from "@/app/server/actions/projects";
import { stageChanges } from "@/app/server/actions/staged-changes";
import { CredentialKnobRefusedError } from "@/lib/cloud-providers/credential-knobs";
import { authorizeCli } from "@/lib/authz/guard";
import { resolveCliProject, resolveCliWriteEnvironment } from "@/lib/cli/resolve-project";

const REFUSAL = new CredentialKnobRefusedError(
	'provider_config cannot hold a credential, because Alethia would store it in plaintext (secret "api-key": value).',
	'secret "api-key": value',
);

/** Calls the route as `alethia apply` would. */
function post(query = "") {
	return POST(
		new Request(`https://console.local/api/cli/projects/shop/design${query}`, {
			method: "POST",
			body: JSON.stringify({ secrets: [{ name: "api-key", provider_config: { value: "hunter2" } }] }),
		}),
		{ params: Promise.resolve({ id: "shop" }) },
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(authorizeCli).mockResolvedValue({
		actor: { userId: "user-1", orgId: "org-1" },
		credential: "session",
		orgScope: ["org-1"],
	} as never);
	vi.mocked(resolveCliProject).mockResolvedValue({ id: "p1" } as never);
	vi.mocked(resolveCliWriteEnvironment).mockResolvedValue({ ok: true, id: "env-1", name: "prod" });
});

describe("POST /api/cli/projects/:id/design — a credential refusal", () => {
	it("is a 400 with the refusal when applied", async () => {
		vi.mocked(updateProjectDesign).mockRejectedValue(REFUSAL);
		const res = await post();
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error).toContain('secret "api-key": value');
		expect(JSON.stringify(body)).not.toContain("hunter2");
	});

	it("is a 400 when staged", async () => {
		vi.mocked(stageChanges).mockRejectedValue(REFUSAL);
		expect((await post("?stage")).status).toBe(400);
	});

	it("an unexpected error is still a 500", async () => {
		vi.mocked(updateProjectDesign).mockRejectedValue(new Error("connection reset"));
		expect((await post()).status).toBe(500);
	});
});
