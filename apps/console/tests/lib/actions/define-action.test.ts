// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6113 (ADR 0005 D4): every outcome of an action becomes one `ActionResult` kind, and nothing a
// user sees is raw validator or exception text (F013).

import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

vi.mock("server-only", () => ({}));

import { defineAction } from "@/lib/actions/define-action";
import { ActionRefusal, FieldRefusal } from "@/lib/actions/result";
import { UnauthorizedError } from "@/lib/auth/errors";
import { ForbiddenError } from "@/lib/authz/types";

const rename = (run: () => Promise<string>) =>
	defineAction({ input: z.object({ name: z.string().min(1, "Name is required").max(64) }), run });

describe("defineAction", () => {
	it("returns the body's value as ok", async () => {
		await expect(rename(async () => "done")({ name: "Acme" })).resolves.toEqual({ ok: true, data: "done" });
	});

	it("turns invalid input into field errors without running the body", async () => {
		const run = vi.fn(async () => "never");
		const result = await rename(run)({ name: "" });
		expect(run).not.toHaveBeenCalled();
		expect(result).toEqual({
			ok: false,
			error: { kind: "validation", message: "Name is required", fields: { name: ["Name is required"] } },
		});
	});

	it("maps a deliberate refusal to its kind with its message", async () => {
		const result = await rename(async () => {
			throw new ActionRefusal("conflict", "A project with that name already exists.");
		})({ name: "Acme" });
		expect(result).toEqual({ ok: false, error: { kind: "conflict", message: "A project with that name already exists." } });
	});

	it("#6128: maps a server-decided field refusal to field errors, like a schema failure", async () => {
		const result = await rename(async () => {
			throw new FieldRefusal({ slug: ["That slug is taken — try another."] }, "That slug is taken — try another.");
		})({ name: "Acme" });
		expect(result).toEqual({
			ok: false,
			error: {
				kind: "validation",
				message: "That slug is taken — try another.",
				fields: { slug: ["That slug is taken — try another."] },
			},
		});
	});

	it("maps a PDP refusal and a missing session", async () => {
		await expect(
			rename(async () => {
				throw new ForbiddenError("manage_billing", { type: "billing" });
			})({ name: "Acme" }),
		).resolves.toMatchObject({ ok: false, error: { kind: "forbidden" } });
		await expect(
			rename(async () => {
				throw new UnauthorizedError();
			})({ name: "Acme" }),
		).resolves.toEqual({ ok: false, error: { kind: "unauthenticated" } });
	});

	it("never leaks an unexpected error's text; it returns a reference instead", async () => {
		const spy = vi.spyOn(console, "error").mockImplementation(() => {});
		const result = await rename(async () => {
			throw new Error("duplicate key value violates unique constraint projects_pkey");
		})({ name: "Acme" });
		expect(result.ok).toBe(false);
		expect(JSON.stringify(result)).not.toContain("projects_pkey");
		expect(result).toMatchObject({ error: { kind: "unexpected", ref: expect.stringMatching(/^[0-9a-f]{8}$/) } });
		spy.mockRestore();
	});

	it("lets Next's own control flow (redirect / notFound) through untouched", async () => {
		const redirect = Object.assign(new Error("NEXT_REDIRECT"), { digest: "NEXT_REDIRECT;replace;/x;307;" });
		await expect(
			rename(async () => {
				throw redirect;
			})({ name: "Acme" }),
		).rejects.toBe(redirect);
	});
});
