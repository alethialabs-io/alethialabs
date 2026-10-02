// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The browser's reading of an opened seal (#5285). Its schema is a local copy of the `static` arm of
// the wire contract (so the Drizzle schema stays out of the client bundle); these tests run the same
// inputs through both and fail if they disagree, so the copy cannot drift.

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	kubeconfigFileName,
	readOpenedCredential,
	staticReadonlyCredential,
} from "@/components/clusters/kubeconfig-download/credential";
import { kubeconfigMintCredential } from "@/lib/validations/cli-contract";

const VECTOR_PLAINTEXT: string = JSON.parse(
	readFileSync(
		path.resolve(__dirname, "../../../../../../packages/core/kubeaccess/testdata/seal_vectors.json"),
		"utf8",
	),
).alethia_mint.plaintext;

const GO_FIXTURE: unknown = JSON.parse(
	readFileSync(
		path.resolve(__dirname, "../../../../../../packages/core/api/testdata/kubeconfig_mint_credential.json"),
		"utf8",
	),
);

const STATIC_RO = {
	shape: "static",
	tier: "readonly",
	kubeconfig: "apiVersion: v1\nkind: Config\n",
	expires_at: "2026-10-01T13:00:00Z",
};

/** UTF-8 bytes of a JSON value. */
function bytes(v: unknown): Uint8Array {
	return new TextEncoder().encode(typeof v === "string" ? v : JSON.stringify(v));
}

describe("the local credential schema agrees with the wire contract", () => {
	it.each([
		["the Go seal vector's plaintext", JSON.parse(VECTOR_PLAINTEXT)],
		["a static read-only credential", STATIC_RO],
	])("both accept %s", (_label, value) => {
		expect(kubeconfigMintCredential.safeParse(value).success).toBe(true);
		expect(staticReadonlyCredential.safeParse(value).success).toBe(true);
	});

	it.each([
		["an extra field riding along", { ...STATIC_RO, token: "x" }],
		["an empty kubeconfig", { ...STATIC_RO, kubeconfig: "" }],
		["a non-ISO expiry", { ...STATIC_RO, expires_at: "tomorrow" }],
	])("both refuse %s", (_label, value) => {
		expect(kubeconfigMintCredential.safeParse(value).success).toBe(false);
		expect(staticReadonlyCredential.safeParse(value).success).toBe(false);
	});

	it.each([
		["the Go exec fixture", GO_FIXTURE],
		["an admin static credential", { ...STATIC_RO, tier: "admin" }],
	])("accepts on the wire but refuses in the card: %s (the card asked for static read-only)", (_l, value) => {
		expect(kubeconfigMintCredential.safeParse(value).success).toBe(true);
		expect(staticReadonlyCredential.safeParse(value).success).toBe(false);
	});
});

describe("readOpenedCredential", () => {
	it("returns the kubeconfig and expiry, and zeroes the plaintext bytes", () => {
		const pt = bytes(VECTOR_PLAINTEXT);
		expect(readOpenedCredential(pt)).toEqual({
			kubeconfig: "apiVersion: v1\nkind: Config\n",
			expiresAt: "2026-10-01T13:00:00Z",
		});
		expect(pt.every((b) => b === 0)).toBe(true);
	});

	it("returns null, and still zeroes, for bytes that are not JSON or not the right shape", () => {
		const garbage = bytes("{not json");
		expect(readOpenedCredential(garbage)).toBeNull();
		expect(garbage.every((b) => b === 0)).toBe(true);
		expect(readOpenedCredential(bytes({ ...STATIC_RO, shape: "exec" }))).toBeNull();
		expect(readOpenedCredential(new Uint8Array([0xff, 0xfe]))).toBeNull();
	});
});

describe("kubeconfigFileName", () => {
	it("is alethia-<project>-<env>.kubeconfig, made file-system safe", () => {
		expect(kubeconfigFileName("shop", "production")).toBe("alethia-shop-production.kubeconfig");
		expect(kubeconfigFileName("My Shop / EU", "Dev_1")).toBe("alethia-my-shop-eu-dev-1.kubeconfig");
		expect(kubeconfigFileName("../..", "")).toBe("alethia-cluster-cluster.kubeconfig");
	});
});
