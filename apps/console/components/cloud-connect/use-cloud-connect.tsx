"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Cloud connect for a host surface (the connectors board, the create-project form): one sheet for
// every cloud, opened from the URL.
//
//   ?wizard=cloud-connect&step=<cloud>
//
// The URL is the sheet's open state, so a refresh, Back or a shared link reopens it on the same
// cloud, and the cloud's form comes back filled in from its draft (identifiers only — see
// `cloud-connect.wizard.ts`). `openConnect` pushes that URL; closing removes it.
//
// WHICH CLOUDS. The sheets are a map over every connectable cloud — an exhaustive map the compiler
// keeps complete. Which of them can be OPENED is the server's answer (`offeredClouds` on the
// connectors board, derived from `lib/cloud-providers/availability.ts`): AWS, GCP, Azure and
// Hetzner in this release, plus any cloud an operator re-enables. Until that answer arrives the
// build-time list (`AVAILABLE_CLOUDS`) stands in. A link naming a cloud that is not offered opens
// the sheet on a sentence saying so, never on a form the server would refuse.
//
// KEYLESS READINESS (EDN-H6). AWS, GCP and Azure (and Alibaba when re-enabled) connect keylessly:
// the customer's cloud fetches this instance's issuer keys over HTTPS from the public internet. When
// the server says that cannot work here (`keylessReadiness` on the board — no signing key, or an app
// URL that is not public HTTPS) the sheet shows "this instance is not publicly reachable" in place
// of the form. A token cloud (Hetzner) is unaffected. Until the server answers, a keyless cloud's
// sheet waits rather than flashing a form it may take away; if the read fails, the form is shown and
// the connect reports what the cloud says.
//
// WHAT THE HOST GETS BACK. `onConnected` receives a `ConnectedAccount` — the stored identity's id
// and its cloud, nothing else — the moment a connect verifies, so the screen behind can select it.

import { useQuery } from "@tanstack/react-query";
import { AVAILABLE_CLOUDS } from "@repo/cloud-catalog";
import { Button } from "@repo/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@repo/ui/sheet";
import { Skeleton } from "@repo/ui/skeleton";
import { BookOpen, ExternalLink } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import type { ConnectorWithConnection } from "@/app/server/actions/connectors";
import { startCloudConnect } from "@/app/server/actions/identities";
import { CLOUD_CONNECT_WIZARD_ID } from "@/components/cloud-connect/cloud-connect.wizard";
import type { ConnectSession } from "@/components/cloud-connect/use-connect-wizard";
import { KeylessNotReachable } from "@/components/cloud-connect/keyless-not-reachable";
import { AwsConnection } from "@/components/connectors/aws-connection";
import { AzureConnection } from "@/components/connectors/azure-connection";
import { CONNECTOR_DOCS_BASE } from "@/components/connectors/connector-assets";
import { ConnectorIcon, isThirdPartyMark } from "@/components/connectors/connector-icon";
import { AlibabaConnection, TokenCloudConnection } from "@/components/connectors/extra-cloud-connection";
import { GcpConnection } from "@/components/connectors/gcp-connection";
import { GitProviderIcon } from "@/components/connectors/git-provider-icon";
import { HetznerConnection } from "@/components/connectors/hetzner-connection";
import { SkeletonRoot } from "@/components/skeleton/skeleton-root";
import type { ActionResult } from "@/lib/actions/result";
import { type ConnectableCloudSlug, PROVIDERS } from "@/lib/cloud-providers/generated/catalog";
import { isConnectableCloudSlug } from "@/lib/cloud-providers/provider-slug";
import { cloudNeedsPublicIssuer, type KeylessReadiness } from "@/lib/oidc/keyless-readiness";
import { type ConnectedAccount, connectedAccount } from "@/lib/projects/connected-account";
import { hrefWithParamPatch, isWizardOpenInUrl, readViewParam, STEP_PARAM, WIZARD_PARAM } from "@/lib/query/view-url-params";
import { orpc } from "@/lib/rpc/client";
import { useActiveOrgSlug } from "@/lib/stores/use-workspace-store";

/** The clouds with a dedicated connect guide in the docs. */
const GUIDED_CLOUDS: readonly string[] = ["aws", "gcp", "azure", "alibaba", "hetzner"];

/**
 * The connectors-docs page for a connector — the Alethia connect guide (mirrors the
 * board's per-category docs links). Cloud-native clouds with a dedicated guide get their own
 * page; pluggable api_key providers share the pluggable guide; the rest fall to the index.
 */
function connectorDocsHref(integration: ConnectorWithConnection): string {
	const { slug } = integration;
	// Matched before the generic api_key → /pluggable fallback below: Hetzner is api_key-authed.
	if (GUIDED_CLOUDS.includes(slug)) return `${CONNECTOR_DOCS_BASE}/${slug}`;
	if (integration.category === "git") return `${CONNECTOR_DOCS_BASE}/git-providers`;
	if (integration.auth_method === "api_key") return `${CONNECTOR_DOCS_BASE}/pluggable`;
	return CONNECTOR_DOCS_BASE;
}

/**
 * Shared header for a connect-flow sheet — the provider's logo beside the title +
 * description, matching the manage sheet so connect and manage read as one family.
 */
export function ConnectSheetHeader({
	integration,
	title,
	description,
}: {
	integration?: ConnectorWithConnection;
	title: string;
	description: string;
}) {
	return (
		<SheetHeader className="border-b border-border/40 px-6 pb-4 pt-6">
			<div className="flex items-center gap-3.5">
				{integration && (
					<div className="flex size-11 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border/50 bg-background p-2">
						{integration.category === "git" ? (
							<GitProviderIcon provider={integration.slug} size={26} mono={false} />
						) : (
							<ConnectorIcon
								src={integration.icon_url}
								name={integration.name}
								size={28}
								mono={!isThirdPartyMark(integration.icon_url)}
								canLink
							/>
						)}
					</div>
				)}
				<div className="min-w-0">
					<SheetTitle>{title}</SheetTitle>
					<SheetDescription>{description}</SheetDescription>
				</div>
				{integration && (
					<a
						href={connectorDocsHref(integration)}
						target="_blank"
						rel="noopener noreferrer"
						className="ml-auto inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border/50 px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
					>
						<BookOpen className="size-3.5" />
						Docs
						<ExternalLink className="size-3" />
					</a>
				)}
			</div>
		</SheetHeader>
	);
}

/** What one cloud's sheet header says. */
interface ConnectSheetCopy {
	readonly title: string;
	readonly description: string;
}

/** Every connectable cloud's sheet header. Which may be opened is decided by `offeredClouds`, not here. */
const CONNECT_SHEETS: Record<ConnectableCloudSlug, ConnectSheetCopy> = {
	aws: {
		title: "Connect AWS Account",
		description:
			"Create a keyless IAM role that trusts the Alethia issuer, so Alethia can provision infrastructure in your AWS account.",
	},
	gcp: {
		title: "Connect GCP Project",
		description:
			"Set up Workload Identity Federation to allow Alethia to provision infrastructure in your GCP project.",
	},
	azure: {
		title: "Connect Azure Subscription",
		description:
			"Set up federated identity credentials to allow Alethia to provision infrastructure in your Azure subscription.",
	},
	hetzner: {
		title: "Connect Hetzner Cloud",
		description:
			"Connect with a scoped API token (encrypted at rest) to provision a Talos Kubernetes cluster.",
	},
	alibaba: {
		title: "Connect Alibaba Cloud",
		description: "Connect via a RAM role — Alethia stores no Alibaba credentials.",
	},
	digitalocean: {
		title: "Connect DigitalOcean",
		description: "Connect with a scoped API token (encrypted at rest).",
	},
	civo: {
		title: "Connect Civo",
		description: "Connect with a scoped API token (encrypted at rest).",
	},
};

/** The clouds a connect may be opened for: the server's answer, or the build-time list until then. */
interface OfferedClouds {
	readonly clouds: readonly string[];
	/** True once the server has answered (or failed to). */
	readonly settled: boolean;
	/** Whether a keyless connect can work here. `undefined` until the server answers, or if it failed. */
	readonly keyless: KeylessReadiness | undefined;
}

/** The offered clouds, read from the connectors board while a sheet is open. */
function useOfferedClouds(enabled: boolean): OfferedClouds {
	const query = useQuery({
		...orpc.connectors.board.queryOptions({ input: {} }),
		staleTime: 5 * 60_000,
		enabled,
	});
	if (query.data !== undefined) {
		return { clouds: query.data.offeredClouds, settled: true, keyless: query.data.keylessReadiness };
	}
	return { clouds: AVAILABLE_CLOUDS, settled: query.isError, keyless: undefined };
}

/** What the sheet shows for an offered cloud: its form, a wait, or why a keyless connect cannot work. */
type OfferedBody = { kind: "form" } | { kind: "pending" } | { kind: "not-reachable"; readiness: Extract<KeylessReadiness, { ready: false }> };

/** Decides an offered cloud's body from the server's keyless readiness. Token clouds always get the form. */
function offeredBody(cloud: ConnectableCloudSlug, offered: OfferedClouds): OfferedBody {
	if (!cloudNeedsPublicIssuer(cloud)) return { kind: "form" };
	const readiness = offered.keyless;
	if (readiness === undefined) return offered.settled ? { kind: "form" } : { kind: "pending" };
	return readiness.ready ? { kind: "form" } : { kind: "not-reachable", readiness };
}

/** A pending identity a host created ahead, so the first connect saves into it. */
type Seed = { identityId: string } | null | undefined;

interface UseCloudConnectArgs {
	integrations: ConnectorWithConnection[];
	/**
	 * Pending identities the host already created. Optional: without one, the connect session is
	 * started when the person presses Connect (`startCloudConnect`), never just by opening a sheet.
	 */
	awsSetup?: Seed;
	gcpSetup?: Seed;
	azureSetup?: Seed;
	extraSetup?: Record<string, { identityId: string; externalId?: string }>;
	/**
	 * Re-render the route when a sheet closes. Right for a host whose server component renders the
	 * connector list (the create-project form); a host that reads the list through a query (the
	 * connectors board) passes `false` — a connect invalidates that query itself.
	 */
	refreshRouteOnClose?: boolean;
	/** A connect verified: the account, to select it. Called before the person presses Done. */
	onConnected?: (account: ConnectedAccount) => void;
}

/**
 * The cloud connect flow, shared by the connectors board and the create-project cloud picker.
 * Call {@link CloudConnectResult.openConnect} from a card's Connect action and render
 * {@link CloudConnectResult.sheets} once in the surface. Git/api-key/manage/disconnect are
 * intentionally NOT handled here — those stay on the connectors board.
 */
export interface CloudConnectResult {
	/** Opens the connect sheet for a cloud connector, when the cloud is offered. */
	openConnect: (integration: ConnectorWithConnection) => Promise<void>;
	/**
	 * A slug whose connect is starting. Opening is now immediate — the session starts on Connect —
	 * so this is always `null`; it stays for the hosts that still read it.
	 */
	connectingSlug: string | null;
	/** The connect sheet to render once in the host surface. */
	sheets: React.ReactNode;
}

/** Runs cloud connect for a host surface. See the header. */
export function useCloudConnect({
	integrations,
	awsSetup,
	gcpSetup,
	azureSetup,
	extraSetup,
	refreshRouteOnClose = true,
	onConnected,
}: UseCloudConnectArgs): CloudConnectResult {
	const router = useRouter();
	const pathname = usePathname();
	const searchParams = useSearchParams();
	const search = searchParams.toString();
	const reader = { get: (name: string) => searchParams.get(name) };
	const open = isWizardOpenInUrl(reader, CLOUD_CONNECT_WIZARD_ID);
	const requested = open ? readViewParam(reader, STEP_PARAM) : null;
	const provider = requested !== null && isConnectableCloudSlug(requested) ? requested : null;
	const offered = useOfferedClouds(open);
	// Seeds already connected: the next connect of that cloud starts a fresh session.
	const [consumed, setConsumed] = useState<readonly ConnectableCloudSlug[]>([]);
	const [verified, setVerified] = useState(false);

	/** Applies a URL change: `push` for the person's open and close, `replace` after a finish. */
	const navigate = (mode: "push" | "replace", patch: Readonly<Record<string, string | null>>) => {
		const href = hrefWithParamPatch(pathname, search, patch);
		if (mode === "push") router.push(href, { scroll: false });
		else router.replace(href, { scroll: false });
	};

	/** Looks up a connector by slug — used to glyph the sheet header. */
	const bySlug = (slug: string) => integrations.find((i) => i.slug === slug);

	/** The seeded pending identity for `cloud`, unless it was used or this connect adds another account. */
	const seedFor = (cloud: ConnectableCloudSlug): Seed => {
		if (consumed.includes(cloud) || bySlug(cloud)?.connected) return null;
		if (cloud === "aws") return awsSetup;
		if (cloud === "gcp") return gcpSetup;
		if (cloud === "azure") return azureSetup;
		return extraSetup?.[cloud];
	};

	const openConnect = async (integration: ConnectorWithConnection): Promise<void> => {
		const slug = integration.slug;
		if (!isConnectableCloudSlug(slug) || !offered.clouds.includes(slug)) return;
		setVerified(false);
		navigate("push", { [WIZARD_PARAM]: CLOUD_CONNECT_WIZARD_ID, [STEP_PARAM]: slug });
	};

	/** Leaves the sheet. After a finish the URL is already clean; after a verify it is replaced. */
	const close = (finished: boolean) => {
		if (!finished) {
			navigate(verified ? "replace" : "push", { [WIZARD_PARAM]: null, [STEP_PARAM]: null });
		}
		setVerified(false);
		if (refreshRouteOnClose) router.refresh();
	};

	/** The session one cloud's form saves through. */
	const sessionFor = (cloud: ConnectableCloudSlug, scope: string): ConnectSession => ({
		provider: cloud,
		scope,
		identity: async (): Promise<ActionResult<{ identityId: string }>> => {
			const seed = seedFor(cloud);
			if (!seed) return startCloudConnect({ provider: cloud });
			const seeded: ActionResult<{ identityId: string }> = { ok: true, data: { identityId: seed.identityId } };
			return seeded;
		},
		onVerified: (identityId) => {
			setConsumed((previous) => (previous.includes(cloud) ? previous : [...previous, cloud]));
			setVerified(true);
			const account = connectedAccount({ identityId, provider: cloud }, offered.clouds);
			if (account.ok) onConnected?.(account.account);
		},
		close,
	});

	const sheets = (
		<Sheet open={open} onOpenChange={(next) => (next ? undefined : close(false))}>
			<SheetContent side="right" className="w-full overflow-y-auto p-0 sm:max-w-2xl">
				{/* Nothing while closing: the panel slides out empty rather than flashing another state. */}
				{!open ? null : provider !== null && offered.clouds.includes(provider) ? (
					<OfferedCloudSheet
						cloud={provider}
						body={offeredBody(provider, offered)}
						integration={bySlug(provider)}
						sessionFor={sessionFor}
						onUseHetzner={
							offered.clouds.includes("hetzner")
								? () => navigate("replace", { [WIZARD_PARAM]: CLOUD_CONNECT_WIZARD_ID, [STEP_PARAM]: "hetzner" })
								: undefined
						}
						onClose={() => close(false)}
					/>
				) : provider !== null && !offered.settled ? (
					<CloudConnectPending title={CONNECT_SHEETS[provider].title} />
				) : (
					<CloudNotOffered
						cloud={provider}
						offered={offered.clouds.filter(isConnectableCloudSlug)}
						onClose={() => close(false)}
					/>
				)}
			</SheetContent>
		</Sheet>
	);

	return { openConnect, connectingSlug: null, sheets };
}

/** An offered cloud's sheet: its header over its form, the readiness wait, or the not-reachable state. */
function OfferedCloudSheet({
	cloud,
	body,
	integration,
	sessionFor,
	onUseHetzner,
	onClose,
}: {
	cloud: ConnectableCloudSlug;
	body: OfferedBody;
	integration: ConnectorWithConnection | undefined;
	sessionFor: (cloud: ConnectableCloudSlug, scope: string) => ConnectSession;
	onUseHetzner: (() => void) | undefined;
	onClose: () => void;
}) {
	if (body.kind === "pending") return <CloudConnectPending title={CONNECT_SHEETS[cloud].title} />;
	return (
		<>
			<ConnectSheetHeader
				integration={integration}
				title={CONNECT_SHEETS[cloud].title}
				description={CONNECT_SHEETS[cloud].description}
			/>
			<div className="px-6 py-6">
				{body.kind === "not-reachable" ? (
					<KeylessNotReachable
						cloudName={PROVIDERS[cloud].shortName}
						reason={body.readiness.reason}
						onUseHetzner={onUseHetzner}
						onClose={onClose}
					/>
				) : (
					<CloudConnectBody key={cloud} cloud={cloud} sessionFor={sessionFor} />
				)}
			</div>
		</>
	);
}

/** One cloud's form, with its draft scoped to the org and the cloud. Mounted only while open. */
function CloudConnectBody({
	cloud,
	sessionFor,
}: {
	cloud: ConnectableCloudSlug;
	sessionFor: (cloud: ConnectableCloudSlug, scope: string) => ConnectSession;
}) {
	const orgSlug = useActiveOrgSlug();
	const session = sessionFor(cloud, `${orgSlug}:${cloud}`);
	switch (cloud) {
		case "aws":
			return <AwsConnection session={session} />;
		case "gcp":
			return <GcpConnection session={session} />;
		case "azure":
			return <AzureConnection session={session} />;
		case "hetzner":
			return <HetznerConnection session={session} />;
		case "alibaba":
			return <AlibabaConnection session={session} />;
		case "digitalocean":
		case "civo":
			return <TokenCloudConnection cloud={cloud} session={session} />;
	}
}

/** The sheet while the server has not yet said whether a re-enabled cloud is offered. */
function CloudConnectPending({ title }: { title: string }) {
	return (
		<>
			<ConnectSheetHeader title={title} description="Checking what this deployment can connect." />
			<SkeletonRoot className="space-y-4 px-6 py-6">
				<Skeleton className="h-4 w-48" />
				<Skeleton className="h-9 w-full" />
				<Skeleton className="h-9 w-full" />
			</SkeletonRoot>
		</>
	);
}

/** The sheet opened on a cloud this deployment does not offer, or on no cloud at all. */
function CloudNotOffered({
	cloud,
	offered,
	onClose,
}: {
	cloud: ConnectableCloudSlug | null;
	offered: readonly ConnectableCloudSlug[];
	onClose: () => void;
}) {
	const sentence =
		cloud === null
			? "This link does not name a cloud that can be connected here."
			: `${PROVIDERS[cloud].name} is not available in this release.`;
	return (
		<>
			<ConnectSheetHeader title="Connect a cloud" description={sentence} />
			<div className="space-y-4 px-6 py-6">
				<p className="text-muted-foreground text-sm">
					Connect one of the clouds offered here instead: {offered.map((slug) => PROVIDERS[slug].shortName).join(", ")}.
				</p>
				<div className="flex justify-end">
					<Button type="button" variant="outline" onClick={onClose}>
						Close
					</Button>
				</div>
			</div>
		</>
	);
}
