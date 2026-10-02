// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// The console's kubeconfig download actions (#5285) — thin seats over the mint library the CLI routes
// use. What is asserted: the exact action is checked first (cluster:access_readonly), the request is
// always read-only / static / 1h with the caller's public key, the shared rate limit applies, each
// refusal maps to the status the CLI route answers, the audit is stamped `console`/`session`, and a
// failure logs the error's NAME only — never its message, which could quote the ciphertext.

import { KUBECONFIG_MINT_SHARED_CLUSTER_REASON } from "@/lib/clusters/mint-eligibility";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({
	headers: vi.fn(async () => new Headers({ "x-forwarded-for": "203.0.113.7" })),
}));
vi.mock("@/lib/authz/guard", () => ({
	authorize: vi.fn(),
	authorizeQuiet: vi.fn(),
	currentActor: vi.fn(),
}));
vi.mock("@/lib/authz", () => ({ getPdp: vi.fn() }));
vi.mock("@/lib/kubeconfig-mint/request", () => ({ requestKubeconfigMint: vi.fn() }));
vi.mock("@/lib/kubeconfig-mint/poll", () => ({ pollKubeconfigMint: vi.fn() }));
vi.mock("@/lib/kubeconfig-mint/gates", () => ({
	takeMintRateLimit: vi.fn(() => true),
	mayCollectTier: vi.fn(async () => true),
}));
vi.mock("@/lib/observability/log", () => {
	const child = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
	return { log: { child: () => child, ...child } };
});

import {
	canDownloadKubeconfig,
	pollKubeconfigDownload,
	requestKubeconfigDownload,
} from "@/app/server/actions/kubeconfig-download";
import { getPdp } from "@/lib/authz";
import { authorize, authorizeQuiet, currentActor } from "@/lib/authz/guard";
import { ForbiddenError } from "@/lib/authz/types";
import { UsageLimitError } from "@/lib/billing/usage-guard";
import { mayCollectTier, takeMintRateLimit } from "@/lib/kubeconfig-mint/gates";
import { pollKubeconfigMint } from "@/lib/kubeconfig-mint/poll";
import { requestKubeconfigMint } from "@/lib/kubeconfig-mint/request";
import { log } from "@/lib/observability/log";

const CLUSTER = "b2e4f6a8-1c3d-4e5f-8a9b-0c1d2e3f4a5b";
const MINT = "3f1c9a52-7d4e-4b8a-9c21-6e0f5a7b8c9d";
const PUB = "hufrF92CG1HA7VvGLgUKrklVI-A4E6RmImXDhK_s9Rg";
const ACTOR = { userId: "u1", orgId: "o1" };
const SEALED = "S".repeat(80);

/** A PDP whose `can` answers `allowed`. */
function pdp(allowed: boolean) {
	return { can: vi.fn(async () => ({ allowed })), enforce: vi.fn() };
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(authorize).mockResolvedValue(ACTOR as never);
	vi.mocked(authorizeQuiet).mockResolvedValue(ACTOR as never);
	vi.mocked(currentActor).mockResolvedValue(ACTOR as never);
	vi.mocked(takeMintRateLimit).mockReturnValue(true);
});

describe("canDownloadKubeconfig", () => {
	it("asks the PDP for exactly cluster:access_readonly on the cluster", async () => {
		const p = pdp(true);
		vi.mocked(getPdp).mockReturnValue(p as never);
		expect(await canDownloadKubeconfig(CLUSTER)).toBe(true);
		expect(p.can).toHaveBeenCalledWith(ACTOR, "access_readonly", { type: "cluster", id: CLUSTER });
	});

	it("is false when denied, on any error, and for a malformed id", async () => {
		vi.mocked(getPdp).mockReturnValue(pdp(false) as never);
		expect(await canDownloadKubeconfig(CLUSTER)).toBe(false);
		vi.mocked(currentActor).mockRejectedValue(new Error("no session"));
		expect(await canDownloadKubeconfig(CLUSTER)).toBe(false);
		expect(await canDownloadKubeconfig("not-a-uuid")).toBe(false);
	});
});

describe("requestKubeconfigDownload", () => {
	it("enforces cluster:access_readonly, then queues a read-only static 1h mint stamped console/session", async () => {
		vi.mocked(requestKubeconfigMint).mockResolvedValue({
			ok: true,
			mint: {
				id: MINT,
				cluster_id: CLUSTER,
				job_id: MINT,
				tier: "readonly",
				shape: "static",
				ttl_seconds: 3600,
				status: "pending",
				expires_at: new Date("2026-10-02T12:10:00.000Z"),
			},
		});
		const out = await requestKubeconfigDownload({ clusterId: CLUSTER, clientPublicKey: PUB });
		expect(out).toEqual({ ok: true, mintId: MINT, pollExpiresAt: "2026-10-02T12:10:00.000Z" });
		expect(authorize).toHaveBeenCalledWith("access_readonly", { type: "cluster", id: CLUSTER });
		expect(requestKubeconfigMint).toHaveBeenCalledWith(
			expect.objectContaining({
				actor: ACTOR,
				clusterId: CLUSTER,
				request: { tier: "readonly", shape: "static", ttl_seconds: 3600, client_public_key: PUB },
				client: "console",
				credential: { kind: "session" },
			}),
		);
	});

	it("answers 403 without queuing for someone the PDP refuses", async () => {
		vi.mocked(authorize).mockRejectedValue(
			new ForbiddenError("access_readonly", { type: "cluster", id: CLUSTER }),
		);
		expect(await requestKubeconfigDownload({ clusterId: CLUSTER, clientPublicKey: PUB })).toEqual({
			ok: false,
			status: 403,
		});
		expect(requestKubeconfigMint).not.toHaveBeenCalled();
	});

	it("answers 429 over the shared rate limit, before queuing", async () => {
		vi.mocked(takeMintRateLimit).mockReturnValue(false);
		expect(await requestKubeconfigDownload({ clusterId: CLUSTER, clientPublicKey: PUB })).toEqual({
			ok: false,
			status: 429,
		});
		expect(requestKubeconfigMint).not.toHaveBeenCalled();
	});

	it.each([
		["admin-needs-a-person", 403],
		["not-found", 404],
		["not-provisioned", 409],
		["unsupported-cloud", 422],
		["static-only", 422],
	] as const)("maps the %s refusal to %d, as the CLI route does", async (refusal, status) => {
		vi.mocked(requestKubeconfigMint).mockResolvedValue({ ok: false, refusal });
		expect(await requestKubeconfigDownload({ clusterId: CLUSTER, clientPublicKey: PUB })).toEqual({
			ok: false,
			status,
		});
	});

	it("maps the shared-cluster refusal to 422 with the reason sentence, as the CLI route does", async () => {
		vi.mocked(requestKubeconfigMint).mockResolvedValue({ ok: false, refusal: "shared-cluster" });
		expect(await requestKubeconfigDownload({ clusterId: CLUSTER, clientPublicKey: PUB })).toEqual({
			ok: false,
			status: 422,
			message: KUBECONFIG_MINT_SHARED_CLUSTER_REASON,
		});
	});

	it("maps a usage limit to 402 with the guard's own sentence", async () => {
		vi.mocked(requestKubeconfigMint).mockRejectedValue(new UsageLimitError("Daily job quota reached.", true));
		expect(await requestKubeconfigDownload({ clusterId: CLUSTER, clientPublicKey: PUB })).toEqual({
			ok: false,
			status: 402,
			message: "Daily job quota reached.",
		});
	});

	it("refuses a malformed public key or cluster id before any authz or I/O", async () => {
		expect(await requestKubeconfigDownload({ clusterId: CLUSTER, clientPublicKey: `${PUB}=` })).toEqual({
			ok: false,
			status: 400,
		});
		expect(await requestKubeconfigDownload({ clusterId: "x", clientPublicKey: PUB })).toEqual({
			ok: false,
			status: 400,
		});
		expect(authorize).not.toHaveBeenCalled();
	});

	it("logs a server error by NAME only", async () => {
		vi.mocked(requestKubeconfigMint).mockRejectedValue(new TypeError(`insert failed: ${PUB}`));
		expect(await requestKubeconfigDownload({ clusterId: CLUSTER, clientPublicKey: PUB })).toEqual({
			ok: false,
			status: 500,
		});
		const logged = JSON.stringify(vi.mocked(log.child({}).error).mock.calls);
		expect(logged).toContain("TypeError");
		expect(logged).not.toContain(PUB);
	});
});

describe("pollKubeconfigDownload", () => {
	it("checks quietly, collects through the library with the shared tier re-check, and returns the body", async () => {
		vi.mocked(pollKubeconfigMint).mockImplementation(async (input) => {
			await input.mayCollect("admin");
			return { ok: true, body: { status: "ready", private_endpoint: false, sealed: SEALED } };
		});
		const out = await pollKubeconfigDownload({ clusterId: CLUSTER, mintId: MINT });
		expect(out).toEqual({ ok: true, poll: { status: "ready", private_endpoint: false, sealed: SEALED } });
		expect(authorizeQuiet).toHaveBeenCalledWith("access_readonly", { type: "cluster", id: CLUSTER });
		expect(mayCollectTier).toHaveBeenCalledWith(ACTOR, CLUSTER, "admin");
		expect(pollKubeconfigMint).toHaveBeenCalledWith(
			expect.objectContaining({ mintId: MINT, client: "console", credential: { kind: "session" } }),
		);
	});

	it.each([
		["not-found", 404],
		["consumed", 404],
		["forbidden", 403],
	] as const)("maps %s to %d", async (refusal, status) => {
		vi.mocked(pollKubeconfigMint).mockResolvedValue({ ok: false, refusal });
		expect(await pollKubeconfigDownload({ clusterId: CLUSTER, mintId: MINT })).toEqual({ ok: false, status });
	});

	it("never logs the ciphertext, even when the failure's message carries it", async () => {
		vi.mocked(pollKubeconfigMint).mockRejectedValue(new Error(`delete returned ${SEALED}`));
		expect(await pollKubeconfigDownload({ clusterId: CLUSTER, mintId: MINT })).toEqual({ ok: false, status: 500 });
		expect(JSON.stringify(vi.mocked(log.child({}).error).mock.calls)).not.toContain(SEALED);
	});
});
