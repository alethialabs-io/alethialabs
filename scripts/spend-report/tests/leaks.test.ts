// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The leak list must use the sweepers' selector, not a new one. These are the cases from
// scripts/e2e/lib/scope-key.sh's own `--self-test`, replayed against the TypeScript port, plus a
// test that reads that file and fails if the shell rule's two patterns change underneath the port.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { arnKind, awsLeaksFromMappings, e2eScopeAttribute, groupLeaks } from "../src/leaks";

describe("e2eScopeAttribute — scope-key.sh's self-test cases", () => {
	it("a seeded resource is attributed to its project-id handle", () => {
		expect(e2eScopeAttribute("e2e-36135826614-1", "e2e-36135826614-1")).toEqual({ handle: "e2e-36135826614-1", key: "project-id" });
	});
	it("an old seeded resource with no e2e-run tag is still found", () => {
		expect(e2eScopeAttribute("e2e-31459117502-1", "")).toEqual({ handle: "e2e-31459117502-1", key: "project-id" });
	});
	it("a CLI-created resource (UUID project-id) is attributed to its e2e-run handle", () => {
		expect(e2eScopeAttribute("3e9d7e82-6bfc-4faa-9006-7c1e27d72249", "e2e-36135826614-1")).toEqual({ handle: "e2e-36135826614-1", key: "e2e-run" });
	});
	it("a customer resource with neither handle is not attributed", () => {
		expect(e2eScopeAttribute("3e9d7e82-6bfc-4faa-9006-7c1e27d72249", "")).toBeNull();
	});
	it("a customer's own e2e-run value that is not a CI run shape is not attributed", () => {
		expect(e2eScopeAttribute("3e9d7e82-6bfc-4faa-9006-7c1e27d72249", "e2e-staging")).toBeNull();
	});
	it("a bare e2e- value is not a handle", () => {
		expect(e2eScopeAttribute("e2e-", "")).toBeNull();
	});
});

describe("the port still matches the shell rule", () => {
	const src = readFileSync(join(__dirname, "..", "..", "e2e", "lib", "scope-key.sh"), "utf8");
	it("scope-key.sh still keys project-id on `e2e-?*`", () => {
		expect(src).toContain("e2e-?*)");
	});
	it("scope-key.sh still holds e2e-run to `^e2e-[0-9]+-[0-9]+$`", () => {
		expect(src).toContain("grep -Eq '^e2e-[0-9]+-[0-9]+$'");
	});
});

describe("AWS leaks", () => {
	it("attributes tagged resources, once per ARN", () => {
		const vpc = "arn:aws:ec2:us-east-1:270587882865:vpc/vpc-0abc";
		const leaks = awsLeaksFromMappings([
			{ ResourceARN: vpc, Tags: [{ Key: "alethia:project-id", Value: "e2e-1-1" }] },
			{ ResourceARN: vpc, Tags: [{ Key: "alethia:e2e-run", Value: "e2e-1-1" }] },
			{ ResourceARN: "arn:aws:eks:us-east-1:270587882865:cluster/x", Tags: [{ Key: "alethia:project-id", Value: "3e9d7e82" }, { Key: "alethia:e2e-run", Value: "e2e-2-1" }] },
			{ ResourceARN: "arn:aws:s3:::prod-bucket", Tags: [{ Key: "alethia:project-id", Value: "prod" }] },
		]);
		expect(leaks.map((l) => [l.kind, l.handle, l.key])).toEqual([
			["ec2:vpc", "e2e-1-1", "project-id"],
			["eks:cluster", "e2e-2-1", "e2e-run"],
		]);
	});
	it("names the resource type from the ARN", () => {
		expect(arnKind("arn:aws:s3:::bucket")).toBe("s3:bucket");
		expect(arnKind("arn:aws:rds:us-east-1:1:db:mydb")).toBe("rds:db");
	});
	it("groups leaks by run", () => {
		const g = groupLeaks([
			{ cloud: "aws", id: "a", kind: "ec2:vpc", handle: "e2e-1-1", key: "project-id" },
			{ cloud: "aws", id: "b", kind: "ec2:subnet", handle: "e2e-1-1", key: "project-id" },
		]);
		expect(g).toEqual([{ cloud: "aws", handle: "e2e-1-1", count: 2, kinds: ["ec2:subnet", "ec2:vpc"], ids: ["a", "b"] }]);
	});
});
