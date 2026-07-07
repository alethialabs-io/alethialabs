"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The enable / configure sheet for one add-on: the add-on's schema'd knobs + a delivery-mode
// selector (Managed apply vs GitOps into the customer's apps repo) + an Advanced raw Helm-values
// (YAML) override. Submitting writes a PENDING project_addons row; the add-on reconciles on the
// next Deploy. Knobs mirror the Zod schema (re-validated server-side); the YAML is validated on
// save and deep-merged on top of the knobs at resolve time.

import { ChevronsUpDown } from "lucide-react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { Button } from "@repo/ui/button";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@repo/ui/collapsible";
import { Input } from "@repo/ui/input";
import { Label } from "@repo/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@repo/ui/select";
import {
	Sheet,
	SheetClose,
	SheetContent,
	SheetDescription,
	SheetFooter,
	SheetHeader,
	SheetTitle,
} from "@repo/ui/sheet";
import { Switch } from "@repo/ui/switch";
import { Textarea } from "@repo/ui/textarea";
import type { AddonMarketItem } from "@/app/server/actions/addons";
import type { AddOnMode } from "@/lib/addons/types";
import { useEnableAddon } from "@/lib/query/use-addons-query";

/** Reserved RHF field names (kept distinct from add-on knob keys). */
type FormShape = Record<string, unknown> & {
	_mode: AddOnMode;
	_valuesYaml: string;
};

/** Builds the form's default values: the add-on knobs + mode + raw YAML (existing install wins). */
function initialValues(item: AddonMarketItem): FormShape {
	const out: FormShape = {
		_mode: item.install?.mode ?? "managed",
		_valuesYaml: item.install?.valuesYaml ?? "",
	};
	for (const f of item.fields) {
		out[f.key] = item.install?.values?.[f.key] ?? f.default;
	}
	return out;
}

/**
 * The configure sheet. Controlled by the parent (open/onOpenChange) so a single sheet serves
 * whichever add-on the user is enabling. `item` null-guards the closed state.
 */
export function ConfigureSheet({
	item,
	projectId,
	environmentId,
	hasAppsRepo,
	open,
	onOpenChange,
}: {
	item: AddonMarketItem | null;
	projectId: string;
	environmentId: string | null;
	hasAppsRepo: boolean;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const enable = useEnableAddon(projectId, environmentId);
	const form = useForm<FormShape>({
		values: item
			? initialValues(item)
			: ({ _mode: "managed", _valuesYaml: "" } as FormShape),
	});
	const mode = form.watch("_mode");

	if (!item) return null;
	const isInstalled = item.install !== null;

	const onSubmit = form.handleSubmit(async (values) => {
		const { _mode, _valuesYaml, ...knobs } = values;
		try {
			await enable.mutateAsync({
				projectId,
				environmentId,
				addonId: item.id,
				mode: _mode,
				values: knobs,
				valuesYaml: _valuesYaml,
			});
			toast.success(
				isInstalled
					? `${item.name} updated — Deploy to apply`
					: `${item.name} enabled — Deploy to install`,
			);
			onOpenChange(false);
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Failed to save add-on");
		}
	});

	return (
		<Sheet open={open} onOpenChange={onOpenChange}>
			<SheetContent className="flex w-full flex-col sm:max-w-md">
				<SheetHeader>
					<SheetTitle>
						{isInstalled ? "Configure" : "Enable"} {item.name}
					</SheetTitle>
					<SheetDescription>
						{item.summary} Installs the <code>{item.chart}</code> chart into{" "}
						<code>{item.namespace}</code>. Reconciles on your next Deploy.
					</SheetDescription>
				</SheetHeader>

				<form
					onSubmit={onSubmit}
					className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4"
				>
					<div className="space-y-5 py-2">
						{/* Delivery mode */}
						<div className="space-y-2">
							<Label>Delivery</Label>
							<Select
								value={mode}
								onValueChange={(v) => form.setValue("_mode", v as AddOnMode)}
							>
								<SelectTrigger>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="managed">
										Managed — Alethia applies it
									</SelectItem>
									<SelectItem value="gitops" disabled={!hasAppsRepo}>
										GitOps — written to your apps repo
									</SelectItem>
								</SelectContent>
							</Select>
							<p className="text-xs text-muted-foreground">
								{mode === "gitops"
									? "The manifest is seeded into your apps repo (you own + edit it thereafter); ArgoCD syncs it."
									: !hasAppsRepo
										? "GitOps mode needs an apps repo on this environment (set one in the project)."
										: "Alethia renders + applies the ArgoCD Application directly."}
							</p>
						</div>

						{/* Schema'd knobs */}
						{item.fields.map((f) => (
							<div key={f.key} className="space-y-2">
								{f.type === "boolean" ? (
									<div className="flex items-center justify-between">
										<Label htmlFor={f.key}>{f.label}</Label>
										<Switch
											id={f.key}
											defaultChecked={Boolean(
												item.install?.values?.[f.key] ?? f.default,
											)}
											onCheckedChange={(v) => form.setValue(f.key, v)}
										/>
									</div>
								) : (
									<>
										<Label htmlFor={f.key}>{f.label}</Label>
										<Input
											id={f.key}
											type={f.type === "number" ? "number" : "text"}
											min={f.min}
											max={f.max}
											{...form.register(
												f.key,
												f.type === "number" ? { valueAsNumber: true } : {},
											)}
										/>
									</>
								)}
								{f.help && (
									<p className="text-xs text-muted-foreground">{f.help}</p>
								)}
							</div>
						))}

						{/* Advanced — raw Helm values */}
						<Collapsible>
							<CollapsibleTrigger className="flex w-full items-center justify-between rounded-md border px-3 py-2 text-sm hover:bg-muted/50">
								<span>Advanced — raw Helm values (YAML)</span>
								<ChevronsUpDown className="h-4 w-4 text-muted-foreground" />
							</CollapsibleTrigger>
							<CollapsibleContent className="pt-2">
								<Textarea
									rows={8}
									spellCheck={false}
									placeholder={"# deep-merged on top of the options above\n# e.g.\n# resources:\n#   requests:\n#     cpu: 100m"}
									className="font-mono text-xs"
									{...form.register("_valuesYaml")}
								/>
								<p className="mt-1 text-xs text-muted-foreground">
									Overrides the options above; merged into the chart values.
								</p>
							</CollapsibleContent>
						</Collapsible>
					</div>

					<SheetFooter className="mt-auto flex-row justify-end gap-2 px-0">
						<SheetClose asChild>
							<Button type="button" variant="ghost">
								Cancel
							</Button>
						</SheetClose>
						<Button type="submit" disabled={enable.isPending}>
							{enable.isPending
								? "Saving…"
								: isInstalled
									? "Save changes"
									: "Enable add-on"}
						</Button>
					</SheetFooter>
				</form>
			</SheetContent>
		</Sheet>
	);
}
