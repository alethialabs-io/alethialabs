"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The connect sheet's body for a keyless cloud on an instance that cannot serve a keyless connect
// (EDN-H6): no issuer signing key, or an app URL no cloud can reach. Shown INSTEAD of the form, so
// a person is told why up-front rather than after a connect fails at the cloud's token exchange
// with an error that names neither cause.
//
// It names the requirement, the one reason the server reported, and the two ways forward on a
// private network: a token cloud (Hetzner) when this deployment offers it, or a self-operated
// runner holding its own cloud credentials. The reason is a code from the server; nothing here
// reads, shows or asks for a key.

import { Alert, AlertDescription, AlertTitle } from "@repo/ui/alert";
import { Button } from "@repo/ui/button";
import { ExternalLink, Globe } from "lucide-react";
import type { KeylessNotReadyReason } from "@/lib/oidc/keyless-readiness";

/** The self-hosting guide's page on the keyless connectors and what they need. */
const KEYLESS_DOCS_URL = "/docs/guides/self-hosting/managed-cloud-connectors";

/** What each reason means for the person reading it. */
const REASON_TEXT: Record<KeylessNotReadyReason, string> = {
	"signing-key-missing":
		"This instance has no issuer signing key, so it cannot sign the assertion your cloud verifies.",
	"origin-missing":
		"This instance has no public URL configured, so your cloud has no address to fetch its signing keys from.",
	"origin-not-https": "This instance's URL is not HTTPS. Clouds fetch signing keys only over HTTPS.",
	"origin-not-public":
		"This instance's URL is a private or local address that your cloud cannot reach from the internet.",
};

/** Props of {@link KeylessNotReachable}. */
export interface KeylessNotReachableProps {
	/** The cloud's display name, e.g. "AWS". */
	readonly cloudName: string;
	readonly reason: KeylessNotReadyReason;
	/** Opens the Hetzner connect instead. Absent when this deployment does not offer Hetzner. */
	readonly onUseHetzner?: () => void;
	readonly onClose: () => void;
}

/** Says why a keyless connect cannot work here, and what to do instead. See the header. */
export function KeylessNotReachable({ cloudName, reason, onUseHetzner, onClose }: KeylessNotReachableProps) {
	return (
		<div className="space-y-4" data-testid="keyless-not-reachable">
			<Alert>
				<Globe aria-hidden />
				<AlertTitle>This instance is not publicly reachable</AlertTitle>
				<AlertDescription>
					<p>
						{`Connecting ${cloudName} is keyless: your cloud verifies Alethia by fetching this instance's signing keys over HTTPS from the public internet.`}
					</p>
					<p>{REASON_TEXT[reason]}</p>
				</AlertDescription>
			</Alert>
			<p className="text-muted-foreground text-sm">
				On a private network, connect Hetzner with an API token, or run a self-operated runner that holds its own
				cloud credentials. The person who runs this instance can make it reachable instead.
			</p>
			<div className="flex flex-wrap items-center justify-end gap-2">
				<a
					href={KEYLESS_DOCS_URL}
					target="_blank"
					rel="noopener noreferrer"
					className="mr-auto inline-flex items-center gap-1.5 text-muted-foreground text-sm hover:text-foreground"
				>
					What this instance needs
					<ExternalLink aria-hidden className="size-3.5" />
				</a>
				<Button type="button" variant="outline" onClick={onClose}>
					Close
				</Button>
				{onUseHetzner ? (
					<Button type="button" onClick={onUseHetzner}>
						Connect Hetzner instead
					</Button>
				) : null}
			</div>
		</div>
	);
}
