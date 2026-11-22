// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// What "one network" means for the per-network sign-up ceiling, and the key it is counted under.
//
// A NETWORK, NOT AN ADDRESS. An IPv4 address is its own network: that is already how people share
// one (a household or an office behind one NAT address). An IPv6 client is normally handed a whole
// /64, so counting single IPv6 addresses would count nothing — the ceiling is kept per /64 prefix.
// An IPv4-mapped IPv6 address (`::ffff:192.0.2.1`) is the IPv4 address it carries.
//
// NEVER STORED RAW. The counter key is an HMAC of the network under the deployment's auth secret,
// truncated to 128 bits. The bucket table therefore holds no address, and a key read out of it
// cannot be turned back into one without the secret.

import { createHmac } from "node:crypto";
import { isIP } from "node:net";

/** The prefix every sign-up network counter key carries in the shared bucket table. */
export const SIGNUP_NETWORK_KEY_PREFIX = "signup:network:";

/** Parses one IPv4 dotted quad into its four octets, or null. */
function ipv4Octets(ip: string): number[] | null {
	if (isIP(ip) !== 4) return null;
	return ip.split(".").map(Number);
}

/**
 * Expands an IPv6 address into its eight 16-bit groups, or null when it is not one. Handles `::`
 * compression, an embedded dotted-quad tail and a zone id.
 */
export function ipv6Groups(ip: string): number[] | null {
	const bare = ip.split("%")[0] ?? "";
	if (isIP(bare) !== 6) return null;
	let text = bare.toLowerCase();
	const lastColon = text.lastIndexOf(":");
	const tail = text.slice(lastColon + 1);
	if (tail.includes(".")) {
		const o = ipv4Octets(tail);
		if (o === null) return null;
		const hi = ((o[0] ?? 0) << 8) | (o[1] ?? 0);
		const lo = ((o[2] ?? 0) << 8) | (o[3] ?? 0);
		text = `${text.slice(0, lastColon + 1)}${hi.toString(16)}:${lo.toString(16)}`;
	}
	const [left = "", right] = text.split("::");
	const head = left === "" ? [] : left.split(":");
	const rest = right === undefined || right === "" ? [] : right.split(":");
	const fill = right === undefined ? 0 : 8 - head.length - rest.length;
	const groups = [...head, ...Array<string>(fill).fill("0"), ...rest].map((g) => Number.parseInt(g, 16));
	return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff)
		? groups
		: null;
}

/**
 * The network a client address belongs to, as a canonical string: `v4:<address>` or
 * `v6:<first four groups>` (the /64). Null for anything that is not an IP address.
 */
export function networkOf(ip: string): string | null {
	const v4 = ipv4Octets(ip.trim());
	if (v4 !== null) return `v4:${v4.join(".")}`;
	const g = ipv6Groups(ip.trim());
	if (g === null) return null;
	// ::ffff:a.b.c.d — an IPv4 client seen through a dual-stack socket.
	if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
		const hi = g[6] ?? 0;
		const lo = g[7] ?? 0;
		return `v4:${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
	}
	return `v6:${g
		.slice(0, 4)
		.map((x) => x.toString(16))
		.join(":")}`;
}

/**
 * The bucket key the sign-up ceiling counts a client address under: the prefix plus a keyed hash
 * of its network. Null when the address is not an IP address — the caller then has no network to
 * count against.
 */
export function signupNetworkKey(ip: string, secret: string): string | null {
	const network = networkOf(ip);
	if (network === null) return null;
	const digest = createHmac("sha256", secret).update(`signup-network|${network}`).digest("hex");
	return `${SIGNUP_NETWORK_KEY_PREFIX}${digest.slice(0, 32)}`;
}
