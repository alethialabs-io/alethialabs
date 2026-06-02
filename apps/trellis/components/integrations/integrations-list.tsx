"use client";

import type { IntegrationWithConnection } from "@/app/server/actions/integrations";
import { IntegrationCard } from "@/components/integrations/integration-card";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { ChevronDown } from "lucide-react";
import { useState } from "react";

interface IntegrationsListProps {
	integrations: IntegrationWithConnection[];
	onCardClick: (integration: IntegrationWithConnection) => void;
	onConnect: (integration: IntegrationWithConnection) => void;
	onDisconnect: (integration: IntegrationWithConnection) => void;
	connectingSlug?: string | null;
}

export function IntegrationsList({
	integrations,
	onCardClick,
	onConnect,
	onDisconnect,
	connectingSlug,
}: IntegrationsListProps) {
	const [activeOpen, setActiveOpen] = useState(true);
	const [availableOpen, setAvailableOpen] = useState(true);

	const active = integrations.filter((i) => i.connected);
	const available = integrations.filter((i) => !i.connected);

	if (integrations.length === 0) {
		return (
			<div className="flex-1 flex items-center justify-center py-16">
				<p className="text-sm text-muted-foreground">
					No integrations match your search.
				</p>
			</div>
		);
	}

	return (
		<div className="flex-1 space-y-4">
			{active.length > 0 && (
				<Collapsible open={activeOpen} onOpenChange={setActiveOpen}>
					<CollapsibleTrigger className="flex w-full items-center gap-2 px-1 py-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground transition-colors">
						<ChevronDown
							className={`h-3.5 w-3.5 transition-transform ${activeOpen ? "" : "-rotate-90"}`}
						/>
						Active
						<span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium tabular-nums">
							{active.length}
						</span>
					</CollapsibleTrigger>
					<CollapsibleContent>
						<div className="space-y-2 mt-2">
							{active.map((integration) => (
								<IntegrationCard
									key={integration.id}
									integration={integration}
									onClick={() => onCardClick(integration)}
									onConnect={() => onConnect(integration)}
									onDisconnect={() =>
										onDisconnect(integration)
									}
									isConnecting={
										connectingSlug === integration.slug
									}
								/>
							))}
						</div>
					</CollapsibleContent>
				</Collapsible>
			)}

			{available.length > 0 && (
				<Collapsible
					open={availableOpen}
					onOpenChange={setAvailableOpen}
				>
					<CollapsibleTrigger className="flex w-full items-center gap-2 px-1 py-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground transition-colors">
						<ChevronDown
							className={`h-3.5 w-3.5 transition-transform ${availableOpen ? "" : "-rotate-90"}`}
						/>
						Available
						<span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium tabular-nums">
							{available.length}
						</span>
					</CollapsibleTrigger>
					<CollapsibleContent>
						<div className="space-y-2 mt-2">
							{available.map((integration) => (
								<IntegrationCard
									key={integration.id}
									integration={integration}
									onClick={() => onCardClick(integration)}
									onConnect={() => onConnect(integration)}
									onDisconnect={() =>
										onDisconnect(integration)
									}
									isConnecting={
										connectingSlug === integration.slug
									}
								/>
							))}
						</div>
					</CollapsibleContent>
				</Collapsible>
			)}
		</div>
	);
}
