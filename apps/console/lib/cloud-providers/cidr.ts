// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

/** Matches an IPv4 CIDR like "10.0.0.0/16". */
export const CIDR_REGEX = /^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/;

export interface CidrInfo {
	cidr: string;
	prefix: number;
	/** 2^(32-prefix) — every address in the block. */
	totalAddresses: number;
	/** Total minus the network + broadcast addresses. */
	usableHosts: number;
}

/**
 * Smallest IPv4 CIDR (largest prefix) that fits `hosts` addresses, clamped to a
 * sane VPC range (/16 … /28). E.g. 511 → "10.0.0.0/23" (512 addresses, 510 usable).
 * Pure — used by the AI assistant's `cidr_for_hosts` tool and reusable elsewhere.
 */
export function cidrForHosts(hosts: number, base = "10.0.0.0"): CidrInfo {
	const needed = Math.max(1, Math.floor(hosts));
	const prefix = Math.min(28, Math.max(16, 32 - Math.ceil(Math.log2(needed))));
	const totalAddresses = 2 ** (32 - prefix);
	return {
		cidr: `${base}/${prefix}`,
		prefix,
		totalAddresses,
		usableHosts: Math.max(totalAddresses - 2, 0),
	};
}

/**
 * Parses an IPv4 CIDR into address counts + range. Returns null when malformed.
 * Mirrors the inline calculator in section-network.tsx.
 */
export function parseCidr(cidr: string): {
	prefix: number;
	totalAddresses: number;
	usableHosts: number;
	rangeStart: string;
	rangeEnd: string;
} | null {
	if (!CIDR_REGEX.test(cidr)) return null;
	const [ip, prefixStr] = cidr.split("/");
	const prefix = Number.parseInt(prefixStr, 10);
	if (prefix < 0 || prefix > 32) return null;
	const parts = ip.split(".").map(Number);
	if (parts.some((p) => p < 0 || p > 255)) return null;

	const totalAddresses = 2 ** (32 - prefix);
	const ipNum =
		((parts[0] << 24) + (parts[1] << 16) + (parts[2] << 8) + parts[3]) >>> 0;
	const mask = prefix === 0 ? 0 : (~((1 << (32 - prefix)) - 1) >>> 0) >>> 0;
	const start = (ipNum & mask) >>> 0;
	const end = (start + totalAddresses - 1) >>> 0;
	const toIp = (n: number) =>
		`${(n >>> 24) & 255}.${(n >>> 16) & 255}.${(n >>> 8) & 255}.${n & 255}`;

	return {
		prefix,
		totalAddresses,
		usableHosts: Math.max(totalAddresses - 2, 0),
		rangeStart: toIp(start),
		rangeEnd: toIp(end),
	};
}
