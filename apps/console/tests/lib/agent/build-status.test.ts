// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The build-phase derivation is the whole contract of the Build tab: there is no per-service status
// column, so the phase must read HONESTLY from (job status × digest presence). These pin the matrix —
// including that image-sourced services never build and a SUCCESS with no digest is NOT a fake "pushed".

import { describe, expect, it } from "vitest";
import {
	type BuildJobState,
	type BuildServiceInput,
	deriveBuildStates,
	prebuiltImageCount,
} from "@/lib/agent/build-status";

const repo = (name: string, resolved_image: string | null = null): BuildServiceInput => ({
	name,
	source: { kind: "repo", repo_url: `https://github.com/acme/${name}`, path: "." },
	resolved_image,
});
const image = (name: string): BuildServiceInput => ({
	name,
	source: { kind: "image", image: "ghcr.io/acme/x:1.0" },
});
const job = (status: BuildJobState["status"], buildResult: Record<string, string> = {}): BuildJobState => ({
	status,
	buildResult,
});
const DIGEST = "111.dkr.ecr.eu-west-1.amazonaws.com/api@sha256:abc123";

describe("deriveBuildStates", () => {
	it("excludes image-sourced services — they carry no build", () => {
		const states = deriveBuildStates([repo("api"), image("web")], null);
		expect(states.map((s) => s.name)).toEqual(["api"]);
		expect(prebuiltImageCount([repo("api"), image("web")])).toBe(1);
	});

	it("with no live build, reads the persisted resolved_image", () => {
		const [built, unbuilt] = deriveBuildStates(
			[repo("api", DIGEST), repo("worker")],
			null,
		);
		expect(built).toMatchObject({ phase: "pushed", image: DIGEST });
		expect(unbuilt).toMatchObject({ phase: "not-built", image: null });
	});

	it("maps the BUILD job status × digest presence to a phase", () => {
		const svcs = [repo("api"), repo("worker")];
		// QUEUED → all queued
		expect(deriveBuildStates(svcs, job("QUEUED")).every((s) => s.phase === "queued")).toBe(true);
		// PROCESSING with one digest landed → that one pushed, the rest building
		const mid = deriveBuildStates(svcs, job("PROCESSING", { api: DIGEST }));
		expect(mid.find((s) => s.name === "api")?.phase).toBe("pushed");
		expect(mid.find((s) => s.name === "worker")?.phase).toBe("building");
		// CLAIMED → building
		expect(deriveBuildStates(svcs, job("CLAIMED")).every((s) => s.phase === "building")).toBe(true);
		// FAILED → services without a digest failed; with a digest, pushed (partial success)
		const failed = deriveBuildStates(svcs, job("FAILED", { api: DIGEST }));
		expect(failed.find((s) => s.name === "api")?.phase).toBe("pushed");
		expect(failed.find((s) => s.name === "worker")?.phase).toBe("failed");
	});

	it("SUCCESS with a digest is pushed; SUCCESS with none is an honest not-built, never a fake pushed", () => {
		const svcs = [repo("api"), repo("ghost")];
		const states = deriveBuildStates(svcs, job("SUCCESS", { api: DIGEST }));
		expect(states.find((s) => s.name === "api")).toMatchObject({ phase: "pushed", image: DIGEST });
		expect(states.find((s) => s.name === "ghost")).toMatchObject({ phase: "not-built", image: null });
	});

	it("prefers the live job digest over a stale persisted one", () => {
		const fresh = "reg/api@sha256:fresh";
		const [s] = deriveBuildStates([repo("api", DIGEST)], job("PROCESSING", { api: fresh }));
		expect(s.image).toBe(fresh);
		expect(s.phase).toBe("pushed");
	});
});
