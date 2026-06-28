// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// S3-compatible storage wrapper (lib/storage/index.ts). Mocked boundary: the @aws-sdk/client-s3
// S3Client.send + the command constructors (we capture each command's input), and getStorageConfig
// (to flip autoCreateBuckets). Assert: put ensures-then-puts with the right input, get decodes bytes
// / returns null on absence / rethrows real errors, and the ensureBucket create/skip/error branches.

import { beforeEach, describe, expect, it, vi } from "vitest";

// `mockSend` is the single S3Client.send spy; commands carry their `input` so we can inspect them.
const { mockSend } = vi.hoisted(() => ({ mockSend: vi.fn() }));

vi.mock("@aws-sdk/client-s3", () => {
	class S3Client {
		send = mockSend;
		config: unknown;
		constructor(config: unknown) {
			this.config = config;
		}
	}
	class PutObjectCommand {
		input: unknown;
		constructor(input: unknown) {
			this.input = input;
		}
	}
	class GetObjectCommand {
		input: unknown;
		constructor(input: unknown) {
			this.input = input;
		}
	}
	class HeadBucketCommand {
		input: unknown;
		constructor(input: unknown) {
			this.input = input;
		}
	}
	class CreateBucketCommand {
		input: unknown;
		constructor(input: unknown) {
			this.input = input;
		}
	}
	return {
		S3Client,
		PutObjectCommand,
		GetObjectCommand,
		HeadBucketCommand,
		CreateBucketCommand,
	};
});

const storageConfig = {
	endpoint: "http://seaweedfs:8333",
	region: "us-east-1",
	accessKeyId: "AK",
	secretAccessKey: "SK",
	autoCreateBuckets: true,
};

vi.mock("@/lib/config/storage", () => ({
	getStorageConfig: vi.fn(() => storageConfig),
}));

/** A command captured by the send spy, narrowed to its constructor name + input. */
interface CapturedCommand {
	constructor: { name: string };
	input?: { Bucket?: string; Key?: string; Body?: Uint8Array; ContentType?: string };
}

/** Returns every command of `name` that was sent, in call order. */
function callsOf(name: string): CapturedCommand[] {
	return mockSend.mock.calls
		.map((c) => c[0] as CapturedCommand)
		.filter((c) => c.constructor.name === name);
}

/** An S3 SDK-shaped error carrying a `name` and/or HTTP status. */
function s3Error(name?: string, status?: number): Error {
	const err = new Error(name ?? `status-${status}`);
	if (name) err.name = name;
	if (status) (err as unknown as { $metadata: { httpStatusCode: number } }).$metadata = {
		httpStatusCode: status,
	};
	return err;
}

/** Re-imports the module fresh so the per-process bucket/client caches reset between tests. */
async function freshStorage() {
	vi.resetModules();
	return (await import("@/lib/storage")).storage;
}

beforeEach(() => {
	vi.clearAllMocks();
	storageConfig.autoCreateBuckets = true;
	// Default: every command (Head/Put/Create) succeeds; get-tests override per case.
	mockSend.mockResolvedValue({});
});

describe("storage.put", () => {
	it("ensures the bucket first, then issues a PutObjectCommand with the exact key/body/content-type", async () => {
		const storage = await freshStorage();
		const body = new Uint8Array([1, 2, 3]);

		await storage.put("artifacts", "jobs/42/plan.json", body, "application/json");

		// HeadBucket runs before the Put (ensure-then-write order).
		expect(mockSend.mock.calls[0][0].constructor.name).toBe("HeadBucketCommand");
		const heads = callsOf("HeadBucketCommand");
		expect(heads[0].input).toEqual({ Bucket: "artifacts" });

		const puts = callsOf("PutObjectCommand");
		expect(puts).toHaveLength(1);
		expect(puts[0].input).toEqual({
			Bucket: "artifacts",
			Key: "jobs/42/plan.json",
			Body: body,
			ContentType: "application/json",
		});
	});

	it("caches the bucket check so a second put to the same bucket skips HeadBucket", async () => {
		const storage = await freshStorage();
		const body = new Uint8Array([9]);

		await storage.put("artifacts", "a", body, "text/plain");
		await storage.put("artifacts", "b", body, "text/plain");

		// Only ONE HeadBucket across both puts (ensuredBuckets memo), but two Puts.
		expect(callsOf("HeadBucketCommand")).toHaveLength(1);
		expect(callsOf("PutObjectCommand")).toHaveLength(2);
	});

	it("creates the bucket when HeadBucket 404s and autoCreateBuckets is on", async () => {
		const storage = await freshStorage();
		mockSend.mockImplementation(async (cmd: CapturedCommand) => {
			if (cmd.constructor.name === "HeadBucketCommand") throw s3Error("NotFound");
			return {};
		});

		await storage.put("new-bucket", "k", new Uint8Array([1]), "text/plain");

		const creates = callsOf("CreateBucketCommand");
		expect(creates).toHaveLength(1);
		expect(creates[0].input).toEqual({ Bucket: "new-bucket" });
		expect(callsOf("PutObjectCommand")).toHaveLength(1);
	});

	it("swallows BucketAlreadyOwnedByYou on create (race) and still puts", async () => {
		const storage = await freshStorage();
		mockSend.mockImplementation(async (cmd: CapturedCommand) => {
			if (cmd.constructor.name === "HeadBucketCommand") throw s3Error(undefined, 404);
			if (cmd.constructor.name === "CreateBucketCommand")
				throw s3Error("BucketAlreadyOwnedByYou");
			return {};
		});

		await expect(
			storage.put("raced", "k", new Uint8Array([1]), "text/plain"),
		).resolves.toBeUndefined();
		expect(callsOf("PutObjectCommand")).toHaveLength(1);
	});

	it("refuses to auto-create when autoCreateBuckets is off (managed S3) and surfaces the missing bucket", async () => {
		storageConfig.autoCreateBuckets = false;
		const storage = await freshStorage();
		mockSend.mockImplementation(async (cmd: CapturedCommand) => {
			if (cmd.constructor.name === "HeadBucketCommand") throw s3Error("NotFound");
			return {};
		});

		await expect(
			storage.put("managed", "k", new Uint8Array([1]), "text/plain"),
		).rejects.toThrow(/not found.*disabled/i);
		expect(callsOf("CreateBucketCommand")).toHaveLength(0);
		expect(callsOf("PutObjectCommand")).toHaveLength(0);
	});

	it("rethrows a non-not-found HeadBucket error (e.g. access denied) without creating or putting", async () => {
		const storage = await freshStorage();
		mockSend.mockImplementation(async (cmd: CapturedCommand) => {
			if (cmd.constructor.name === "HeadBucketCommand") throw s3Error("AccessDenied", 403);
			return {};
		});

		await expect(
			storage.put("locked", "k", new Uint8Array([1]), "text/plain"),
		).rejects.toThrow("AccessDenied");
		expect(callsOf("CreateBucketCommand")).toHaveLength(0);
		expect(callsOf("PutObjectCommand")).toHaveLength(0);
	});
});

describe("storage.get", () => {
	it("issues a GetObjectCommand for the key and decodes the body to bytes", async () => {
		const storage = await freshStorage();
		const bytes = new Uint8Array([7, 8, 9]);
		mockSend.mockResolvedValue({
			Body: { transformToByteArray: vi.fn(async () => bytes) },
		});

		const out = await storage.get("artifacts", "jobs/1/state");

		expect(out).toBe(bytes);
		const gets = callsOf("GetObjectCommand");
		expect(gets).toHaveLength(1);
		expect(gets[0].input).toEqual({ Bucket: "artifacts", Key: "jobs/1/state" });
		// get() does NOT ensure/create the bucket — it only reads.
		expect(callsOf("HeadBucketCommand")).toHaveLength(0);
	});

	it("returns null when the response has no Body", async () => {
		const storage = await freshStorage();
		mockSend.mockResolvedValue({ Body: undefined });

		expect(await storage.get("artifacts", "missing")).toBeNull();
	});

	it("returns null on a NoSuchKey error (absent object)", async () => {
		const storage = await freshStorage();
		mockSend.mockRejectedValue(s3Error("NoSuchKey"));

		expect(await storage.get("artifacts", "gone")).toBeNull();
	});

	it("returns null on a 404 status error", async () => {
		const storage = await freshStorage();
		mockSend.mockRejectedValue(s3Error(undefined, 404));

		expect(await storage.get("artifacts", "gone")).toBeNull();
	});

	it("rethrows a real (non-not-found) error rather than masking it as null", async () => {
		const storage = await freshStorage();
		mockSend.mockRejectedValue(s3Error("InternalError", 500));

		await expect(storage.get("artifacts", "boom")).rejects.toThrow("InternalError");
	});
});
