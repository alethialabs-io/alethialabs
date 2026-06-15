// SPDX-FileCopyrightText: 2026 Alethia OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";

function parseVpcListResult(job: {
	status: string;
	execution_metadata: Record<string, unknown> | null;
}): { status: string; vpcs: unknown[] | null } {
	if (job.status === "SUCCESS") {
		const metadata = job.execution_metadata;
		return {
			status: "SUCCESS",
			vpcs: (metadata?.vpcs as unknown[]) ?? [],
		};
	}
	if (job.status === "FAILED") {
		return { status: "FAILED", vpcs: null };
	}
	return { status: job.status, vpcs: null };
}

describe("VPC list result parsing", () => {
	it("extracts VPCs from successful job", () => {
		const result = parseVpcListResult({
			status: "SUCCESS",
			execution_metadata: {
				vpcs: [
					{ id: "vpc-1", cidr: "10.0.0.0/16", name: "prod" },
					{ id: "vpc-2", cidr: "172.16.0.0/16", name: "dev" },
				],
			},
		});
		expect(result.status).toBe("SUCCESS");
		expect(result.vpcs).toHaveLength(2);
	});

	it("returns empty array when no VPCs", () => {
		const result = parseVpcListResult({
			status: "SUCCESS",
			execution_metadata: {},
		});
		expect(result.vpcs).toEqual([]);
	});

	it("returns null for failed jobs", () => {
		const result = parseVpcListResult({
			status: "FAILED",
			execution_metadata: null,
		});
		expect(result.status).toBe("FAILED");
		expect(result.vpcs).toBeNull();
	});

	it("returns null for in-progress jobs", () => {
		const result = parseVpcListResult({
			status: "PROCESSING",
			execution_metadata: null,
		});
		expect(result.status).toBe("PROCESSING");
		expect(result.vpcs).toBeNull();
	});

	it("returns null for queued jobs", () => {
		const result = parseVpcListResult({
			status: "QUEUED",
			execution_metadata: null,
		});
		expect(result.vpcs).toBeNull();
	});
});
