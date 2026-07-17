"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The Alerts hub (dataroom/spec/mvp/25): a single page with the three surfaces stacked
// vertically — Policies, Channels, Activity. No page header, KPIs or tabs; navigation is
// the secondary "Alerts" sidebar (components/shell/sidebar-drill.tsx), whose items
// anchor-scroll to these sections and highlight via the shared use-alerts-section store.
// Each section has a connectors-style group header (icon + title + inline description +
// Docs link). The whole surface is gated behind the `alerting` entitlement (Pro+); below
// that we show the upsell.

import { coerceEnum } from "@/lib/coerce";
import { Activity, BookOpen, type LucideIcon, ShieldAlert, Webhook } from "lucide-react";
import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import type { AlertsBootstrap } from "@/app/server/actions/alerts";
import { ActivityPanel } from "@/components/alerts/activity-panel";
import { ChannelsPanel } from "@/components/alerts/channels-panel";
import { PoliciesPanel } from "@/components/alerts/policies-panel";
import { FeatureUpsell } from "@/components/settings/upgrade/feature-upsell";
import {
	type AlertsSection,
	useAlertsSection,
} from "@/lib/stores/use-alerts-section";

const SECTIONS: AlertsSection[] = ["policies", "channels", "activity"];

export function AlertsPage({ bootstrap }: { bootstrap: AlertsBootstrap }) {
	const router = useRouter();
	const { alerting } = bootstrap;
	const setActive = useAlertsSection((s) => s.setActive);
	const setSelectedPolicyId = useAlertsSection((s) => s.setSelectedPolicyId);
	const setSelectedChannelId = useAlertsSection((s) => s.setSelectedChannelId);
	const visible = useRef<Map<string, boolean>>(new Map());

	// Scroll-spy: the top-most in-view section drives the sidebar highlight. Also honour a
	// deep-link hash (e.g. arriving at …/alerts#channels) once on mount.
	useEffect(() => {
		if (!alerting) return;
		const observer = new IntersectionObserver(
			(entries) => {
				for (const e of entries) visible.current.set(e.target.id, e.isIntersecting);
				const top = SECTIONS.find((id) => visible.current.get(id));
				if (top) setActive(top);
			},
			{ rootMargin: "-80px 0px -55% 0px", threshold: 0 },
		);
		for (const id of SECTIONS) {
			const el = document.getElementById(id);
			if (el) observer.observe(el);
		}
		const hash = coerceEnum(
			window.location.hash.slice(1),
			SECTIONS,
			"policies",
		);
		if (SECTIONS.includes(hash)) {
			document
				.getElementById(hash)
				?.scrollIntoView({ behavior: "smooth", block: "start" });
			setActive(hash);
		}
		return () => observer.disconnect();
	}, [alerting, setActive]);

	// The plan doesn't unlock alerting — show the upsell instead of the surface.
	if (!alerting) {
		return (
			<div className="mx-auto w-full max-w-[1200px]">
				<FeatureUpsell feature="alerting" />
			</div>
		);
	}

	const refresh = () => router.refresh();
	const scrollTo = (id: AlertsSection) => {
		document
			.getElementById(id)
			?.scrollIntoView({ behavior: "smooth", block: "start" });
		setActive(id);
	};
	// Cross-links: jump to the other section AND select the target so it opens in view.
	const openPolicy = (id?: string) => {
		if (id) setSelectedPolicyId(id);
		scrollTo("policies");
	};
	const openChannel = (id?: string) => {
		if (id) setSelectedChannelId(id);
		scrollTo("channels");
	};

	return (
		<div className="mx-auto w-full max-w-[1200px] space-y-12">
			<section id="policies" className="scroll-mt-4">
				<SectionHeader
					icon={ShieldAlert}
					title="Policies"
					description="A policy watches a set of events and routes them to channels."
					docsHref="/docs/console/alerts#policies"
				/>
				<PoliciesPanel
					bootstrap={bootstrap}
					onChanged={refresh}
					onOpenChannel={openChannel}
				/>
			</section>

			<section id="channels" className="scroll-mt-4">
				<SectionHeader
					icon={Webhook}
					title="Channels"
					description="Channels are where alerts go — webhooks, Slack, Rocket.Chat or email."
					docsHref="/docs/console/alerts#channels"
				/>
				<ChannelsPanel
					bootstrap={bootstrap}
					onChanged={refresh}
					onOpenPolicy={openPolicy}
				/>
			</section>

			<section id="activity" className="scroll-mt-4">
				<SectionHeader
					icon={Activity}
					title="Activity"
					description="The delivery ledger — every notification routed, with retry status."
					docsHref="/docs/console/alerts#activity"
				/>
				<ActivityPanel bootstrap={bootstrap} />
			</section>
		</div>
	);
}

function SectionHeader({
	icon: Icon,
	title,
	description,
	docsHref,
}: {
	icon: LucideIcon;
	title: string;
	description: string;
	docsHref: string;
}) {
	return (
		<div className="mb-4 flex items-start justify-between gap-4">
			<div className="flex items-center gap-2.5">
				<span className="flex size-7 shrink-0 items-center justify-center rounded-md border border-border/60 bg-muted/20 text-muted-foreground">
					<Icon className="size-4" />
				</span>
				<div>
					<h2 className="font-display font-semibold text-[15px] tracking-tight">
						{title}
					</h2>
					<p className="text-muted-foreground text-xs">{description}</p>
				</div>
			</div>
			<a
				href={docsHref}
				target="_blank"
				rel="noreferrer"
				className="flex shrink-0 items-center gap-1.5 rounded-md border border-border/60 bg-muted/20 px-2.5 py-1.5 text-muted-foreground text-xs transition-colors hover:text-foreground"
			>
				<BookOpen className="size-3.5" />
				Docs
			</a>
		</div>
	);
}
