// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6843: what each starting point sends and which seed the canvas opens with, and where a server
// refusal is shown. A new project starts with production alone; a template needs no account; the
// refusal goes to the field the screen can show is at fault, never to the name by default.

import { describe, expect, it, vi } from "vitest";
import {
	FORM_REFUSAL_KEY,
	PRODUCTION_ONLY,
	buildCreate,
	refusalFields,
} from "@/components/create-project/build-create";
import type { CreateProjectOutput } from "@/components/create-project/create-project.wizard";
import { DEFAULT_INSTANCE_TYPE } from "@/lib/cloud-providers";
import { serialiseCanvasSeed } from "@/lib/projects/canvas-handoff";

const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const JOB = "00000000-0000-4000-8000-0000000000aa";

/** Form values for `source`, on Hetzner, with an account unless told otherwise. */
function values(source: CreateProjectOutput["source"], identityId = ACCOUNT): CreateProjectOutput {
	return {
		source,
		name: "shop",
		provider: "hetzner",
		identityId,
		region: "nbg1",
		repoUrl: "",
		ref: "",
	};
}

const NO_SCAN = { jobId: null, design: null };

describe("buildCreate", () => {
	it("starts every project with production alone", () => {
		expect(PRODUCTION_ONLY.map((env) => [env.name, env.is_default])).toEqual([["production", true]]);
		for (const source of ["standard", "blank", "byo-helm"] as const) {
			expect(buildCreate(values(source), NO_SCAN).input.project.environments).toEqual(PRODUCTION_ONLY);
		}
	});

	it("a template on a cloud with an account sends that cloud's cluster preset and a template seed", () => {
		const plan = buildCreate(values("ai"), NO_SCAN);
		expect(plan.input.project.cloud_identity_id).toBe(ACCOUNT);
		expect(plan.input.project.region).toBe("nbg1");
		expect(plan.input.cluster.instance_types).toEqual([DEFAULT_INSTANCE_TYPE.hetzner]);
		expect(plan.seed).toEqual({ kind: "template", templateId: "ai", provider: "hetzner" });
		// The seed is one the contract accepts, so the hand-off link can be built.
		expect(serialiseCanvasSeed(plan.seed, ["aws", "gcp", "azure", "hetzner"])).toBe("v1.template.ai.hetzner");
	});

	it("a template with no account creates an empty project and still seeds the template", () => {
		const plan = buildCreate(values("standard", ""), NO_SCAN);
		expect(plan.input.project.cloud_identity_id).toBeNull();
		expect(plan.input.cluster.instance_types).toEqual([]);
		expect(plan.seed).toEqual({ kind: "template", templateId: "standard", provider: "hetzner" });
	});

	it("blank and the two BYO starting points are empty projects with their own seeds", () => {
		expect(buildCreate(values("blank", ""), NO_SCAN).seed).toEqual({ kind: "blank" });
		expect(buildCreate(values("byo-helm", ""), NO_SCAN).seed).toEqual({ kind: "byo", attach: "chart" });
		expect(buildCreate(values("byo-iac", ""), NO_SCAN).seed).toEqual({ kind: "byo", attach: "iac" });
	});

	it("an import sends the scan's design under the screen's name, region and account, seeded by the scan", () => {
		const base = buildCreate(values("standard"), NO_SCAN).input;
		const design = { ...base, project: { ...base.project, project_name: "from-scan", cloud_identity_id: "other" } };
		const plan = buildCreate(values("import"), { jobId: JOB, design });
		expect(plan.input.project.project_name).toBe("shop");
		expect(plan.input.project.cloud_identity_id).toBe(ACCOUNT);
		expect(plan.input.project.environments).toEqual(PRODUCTION_ONLY);
		expect(plan.seed).toEqual({ kind: "proposal", proposalId: JOB });
	});

	it("an import with no ready scan is an empty project on a blank canvas", () => {
		expect(buildCreate(values("import"), NO_SCAN).seed).toEqual({ kind: "blank" });
	});
});

describe("refusalFields", () => {
	it("puts a refusal on the name when the name breaks the schema's rule, without asking the server", async () => {
		const isNameTaken = vi.fn(async () => false);
		expect(await refusalFields({ message: "no", name: "!!!", identitySent: true, isNameTaken })).toEqual({
			name: ["no"],
		});
		expect(isNameTaken).not.toHaveBeenCalled();
	});

	it("puts it on the name when the org holds the name", async () => {
		expect(
			await refusalFields({ message: "taken", name: "shop", identitySent: true, isNameTaken: async () => true }),
		).toEqual({ name: ["taken"] });
	});

	it("puts it on the cloud account when an account was sent and the name is free", async () => {
		expect(
			await refusalFields({ message: "account", name: "shop", identitySent: true, isNameTaken: async () => false }),
		).toEqual({ identityId: ["account"] });
	});

	it("puts it on the name when no account was sent: nothing else on the screen is checked", async () => {
		expect(
			await refusalFields({ message: "x", name: "shop", identitySent: false, isNameTaken: async () => null }),
		).toEqual({ name: ["x"] });
	});

	it("does not read a failed name check as a free name: the refusal goes above the button", async () => {
		expect(
			await refusalFields({ message: "x", name: "shop", identitySent: true, isNameTaken: async () => null }),
		).toEqual({ [FORM_REFUSAL_KEY]: ["x"] });
	});
});
