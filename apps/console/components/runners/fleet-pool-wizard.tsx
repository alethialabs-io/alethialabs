"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Guided "add / edit warm pool" flow: a right Sheet that walks Cloud → Placement → Capacity →
// Version → Review on the shared wizard engine (`lib/wizard/`, definition in `fleet-pool.wizard.ts`).
// What that gives this sheet, each one a fix:
//   - the sheet and its step live in the URL (`?wizard=fleet-pool&step=capacity`, plus `&pool=<id>`
//     when editing) and the typed values in a tab draft, so a reload, Back or closing the sheet by
//     accident brings the pool back where it was, with "Restored your draft · Start over";
//   - the two advanced knobs belong to Capacity, so a bad value there — on Next, on Create, or in a
//     server refusal — returns to Capacity with "Advanced scaling" open and the field focused,
//     instead of a Create button that does nothing visible (C-25);
//   - a refusal no field owns is shown above the buttons, not only in a toast that goes away;
//   - the clouds offered are the deployment's own (`offeredClouds`, read through the connectors
//     board), never a list kept here, and a new pool's location starts at that cloud's default region.
//
// The parent still owns `open` and the pool being edited: opening writes the URL, and the URL closing
// (Back, the close button, a successful save) is reported back through `onOpenChange`.

import { Button } from "@repo/ui/button";
import { Input } from "@repo/ui/input";
import { Label } from "@repo/ui/label";
import { PROVIDER_LABELS, ProviderIcon } from "@repo/ui/provider-icon";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@repo/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@repo/ui/sheet";
import { Skeleton } from "@repo/ui/skeleton";
import { cn } from "@repo/ui/utils";
import {
	Stepper,
	WizardDisclosure,
	WizardFooter,
	WizardFormError,
	WizardRestoredNotice,
	WizardStepHeading,
} from "@repo/ui/wizard";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Check } from "lucide-react";
import { type FormEvent, useEffect, useId, useRef } from "react";
import { toast } from "sonner";
import { createFleetPoolAction, updateFleetPoolAction } from "@/app/server/actions/fleet";
import {
	FLEET_POOL_WIZARD_ID,
	type FleetPoolWizardValues,
	defaultLocationsFor,
	fleetPoolWizard,
	parseLocations,
} from "@/components/runners/fleet-pool.wizard";
import { FieldHelp, FieldLabel, RequiredMark } from "@/components/runners/field-help";
import { SkeletonRoot } from "@/components/skeleton/skeleton-root";
import type { FieldErrors } from "@/lib/actions/result";
import { useActionMutation } from "@/lib/actions/use-action-mutation";
import { isConnectableCloudSlug } from "@/lib/cloud-providers/provider-slug";
import type { CloudProvider, FleetPool } from "@/lib/db/schema";
import { useFleetQuery } from "@/lib/query/use-fleet-query";
import { TOPIC_KEYS } from "@/lib/query/topics";
import { isWizardOpenInUrl, readViewParam, STEP_PARAM, WIZARD_PARAM } from "@/lib/query/view-url-params";
import { orpc } from "@/lib/rpc/client";
import { useActiveOrgSlug } from "@/lib/stores/use-workspace-store";
import type { FleetPoolCreateInput } from "@/lib/validations/fleet";
import { useWizardEnvironment } from "@/lib/wizard/location";
import { useWizard } from "@/lib/wizard/use-wizard";

/** The query param naming the pool being edited, beside `?wizard=fleet-pool`. Absent = a new pool. */
export const POOL_PARAM = "pool";

/** The step rail's accessible name. */
const STEPPER_LABEL = "Warm pool";

/** Said when the pool named in the URL is not among the configured pools any more. */
const POOL_GONE_MESSAGE = "That pool no longer exists.";

/** Said when the pool named in the URL cannot be looked up because the pools did not load. */
const POOL_UNREADABLE_MESSAGE = "The pool could not be loaded. Open it again from its card.";

const MONO_LABEL = "font-mono text-ui-3xs uppercase tracking-[0.12em] text-muted-foreground";

/** The heading and one line of copy each step opens with. */
interface StepCopy {
	readonly title: string;
	readonly description: string;
}

/** Each step's heading, by step id. */
const STEP_COPY: Readonly<Record<string, StepCopy>> = {
	cloud: { title: "Cloud", description: "The cloud whose runners this pool manages." },
	placement: { title: "Placement", description: "Where the controller spreads the runners." },
	capacity: { title: "Capacity", description: "How many runners stay warm, and how far the pool may grow." },
	version: { title: "Version", description: "Which runner release the pool converges to." },
	review: { title: "Review", description: "Check the pool before it is saved." },
};

/** What a step without its own copy would show; never reached while every step id is above. */
const FALLBACK_COPY: StepCopy = { title: "Warm pool", description: "" };

/** The clouds a new pool may be put on, as far as this sheet knows them. */
type OfferedClouds =
	| { readonly status: "pending" }
	| { readonly status: "error"; readonly retry: () => void }
	| { readonly status: "ready"; readonly clouds: readonly CloudProvider[] };

/** The values a new pool starts with, before a cloud is chosen. */
const NEW_POOL_VALUES = {
	name: "",
	locationsCsv: "",
	minPerLocation: 0,
	warmMin: 1,
	max: 10,
	buffer: 1,
	slotsPerRunner: 1,
	surge: 1,
	scaleDownGraceTicks: 5,
	versionSource: "channel",
	channel: "stable",
	version: "",
} as const satisfies Omit<FleetPoolWizardValues, "provider">;

/** A stored pool row as form values (edit mode). */
function poolToForm(pool: FleetPool): FleetPoolWizardValues {
	return {
		provider: pool.provider,
		name: pool.name ?? "",
		locationsCsv: pool.locations.join(", "),
		minPerLocation: pool.min_per_location,
		warmMin: pool.warm_min,
		max: pool.max,
		buffer: pool.buffer,
		slotsPerRunner: pool.slots_per_runner,
		surge: pool.surge,
		scaleDownGraceTicks: pool.scale_down_grace_ticks,
		versionSource: pool.version ? "pin" : "channel",
		channel: pool.channel ?? "stable",
		version: pool.version ?? "",
	};
}

/**
 * The values a new pool starts with: the first offered cloud nobody has pooled yet, with that
 * cloud's default region. No cloud while the offered list is not known.
 */
function newPoolValues(firstChoosable: CloudProvider | undefined): Partial<FleetPoolWizardValues> {
	if (firstChoosable === undefined) return { ...NEW_POOL_VALUES };
	return { ...NEW_POOL_VALUES, provider: firstChoosable, locationsCsv: defaultLocationsFor(firstChoosable) };
}

/**
 * A server's field errors in the form's names: the create input's `locations` (and its items) is
 * the form's `locationsCsv`, and an edit's fields arrive under `input.`. Anything else keeps its name,
 * so a field no step owns still reaches the message above the buttons.
 */
export function toWizardFieldErrors(fields: FieldErrors): FieldErrors {
	const mapped: FieldErrors = {};
	for (const [name, messages] of Object.entries(fields)) {
		const bare = name.startsWith("input.") ? name.slice("input.".length) : name;
		const key = bare === "locations" || bare.startsWith("locations.") ? "locationsCsv" : bare;
		mapped[key] = [...(mapped[key] ?? []), ...(messages ?? [])];
	}
	return mapped;
}

/** A form value from an `<input type="number">`: a number, or `null` while the field is empty. */
function numberOrNull(raw: unknown): number | null {
	if (raw === "" || raw === null || raw === undefined) return null;
	const value = typeof raw === "number" ? raw : Number(raw);
	return Number.isFinite(value) ? value : null;
}

/** The offered clouds, read from the server (`offeredClouds` on the connectors board). */
function useOfferedClouds(): OfferedClouds {
	const query = useQuery({ ...orpc.connectors.board.queryOptions({ input: {} }), staleTime: 5 * 60_000 });
	if (query.data !== undefined) {
		return { status: "ready", clouds: query.data.offeredClouds.filter(isConnectableCloudSlug) };
	}
	if (query.isError) return { status: "error", retry: () => void query.refetch() };
	return { status: "pending" };
}

interface FleetPoolWizardProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/** Null = create; a row = edit (provider is then fixed). */
	pool: FleetPool | null;
	/** Providers that already have a pool (disabled in the create select). */
	usedProviders: string[];
}

/**
 * Create/edit a managed warm pool. Provider is immutable once created (one pool per cloud). The URL
 * is the sheet's open state; see the header for how it and the parent's `open` stay in step.
 */
export function FleetPoolWizard({ open, onOpenChange, pool, usedProviders }: FleetPoolWizardProps) {
	const { location } = useWizardEnvironment();
	const reader = { get: (name: string) => location.read(name) };
	const urlOpen = isWizardOpenInUrl(reader, FLEET_POOL_WIZARD_ID);
	const urlPoolId = readViewParam(reader, POOL_PARAM);
	const offered = useOfferedClouds();
	const fleet = useFleetQuery();

	// The pool being edited: the parent's row when it is the one the URL names, else the configured
	// row with that id (a reload keeps the URL but not the parent's state).
	const configs = fleet.data?.configs;
	const editing =
		urlPoolId === null
			? null
			: pool !== null && pool.id === urlPoolId
				? pool
				: (configs?.find((row) => row.id === urlPoolId) ?? null);
	const poolGone =
		urlOpen && urlPoolId !== null && editing === null && (configs !== undefined || fleet.isError);
	const waitingForPool = urlPoolId !== null && editing === null && !poolGone;

	const lastPropOpen = useRef(false);
	const lastUrlOpen = useRef(false);
	const announcedGone = useRef(false);

	// The parent opened the sheet: say so in the URL, naming the pool when it is an edit.
	useEffect(() => {
		const opened = open && !lastPropOpen.current;
		lastPropOpen.current = open;
		if (opened && !urlOpen) {
			location.push({ [WIZARD_PARAM]: FLEET_POOL_WIZARD_ID, [STEP_PARAM]: null, [POOL_PARAM]: pool?.id ?? null });
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps -- reacts to the parent's open edge only
	}, [open]);

	// The URL opened or closed the sheet (a reload, Back, the close button, a save): tell the parent,
	// and drop the pool param a closed sheet leaves behind.
	useEffect(() => {
		const was = lastUrlOpen.current;
		lastUrlOpen.current = urlOpen;
		if (urlOpen && !was && !open) onOpenChange(true);
		if (!urlOpen && was && open) onOpenChange(false);
		if (!urlOpen && urlPoolId !== null) location.replace({ [POOL_PARAM]: null });
		// eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the URL, not on the callbacks
	}, [urlOpen, urlPoolId]);

	// The pool the URL names was deleted, or could not be read: close the sheet and say why, once.
	useEffect(() => {
		if (!poolGone) {
			announcedGone.current = false;
			return;
		}
		if (announcedGone.current) return;
		announcedGone.current = true;
		toast.error(configs !== undefined ? POOL_GONE_MESSAGE : POOL_UNREADABLE_MESSAGE);
		location.replace({ [WIZARD_PARAM]: null, [STEP_PARAM]: null, [POOL_PARAM]: null });
		// eslint-disable-next-line react-hooks/exhaustive-deps -- fires once per vanished pool
	}, [poolGone]);

	/** Closes the sheet: a history entry, so Forward reopens it. */
	function close(): void {
		location.push({ [WIZARD_PARAM]: null, [STEP_PARAM]: null, [POOL_PARAM]: null });
	}

	return (
		<Sheet open={urlOpen && !poolGone} onOpenChange={(next) => (next ? undefined : close())}>
			<SheetContent className="flex w-full flex-col gap-0 sm:max-w-md">
				{waitingForPool ? (
					<FleetPoolWizardSkeleton title="Edit pool" />
				) : (
					<FleetPoolWizardBody
						key={editing?.id ?? "new"}
						pool={editing}
						usedProviders={usedProviders}
						offered={offered}
					/>
				)}
			</SheetContent>
		</Sheet>
	);
}

/** Props of the sheet's content once the pool (if any) is known. */
interface FleetPoolWizardBodyProps {
	readonly pool: FleetPool | null;
	readonly usedProviders: readonly string[];
	readonly offered: OfferedClouds;
}

/** The wizard itself: one engine per pool (a new pool is one more), keyed by the parent. */
function FleetPoolWizardBody({ pool, usedProviders, offered }: FleetPoolWizardBodyProps) {
	const orgSlug = useActiveOrgSlug();
	const isEdit = pool !== null;
	const nameId = useId();
	const locationsId = useId();
	const versionId = useId();
	const channelId = useId();

	const choosable = offered.status === "ready" ? offered.clouds.filter((p) => !usedProviders.includes(p)) : [];
	const firstChoosable = choosable[0];

	// The wizard calls this when every step passes; it is pointed at the mutation after each render.
	const save = useRef<(input: FleetPoolCreateInput) => void>(() => undefined);
	const wizard = useWizard<FleetPoolWizardValues, FleetPoolCreateInput>(fleetPoolWizard, {
		defaultValues: pool !== null ? poolToForm(pool) : newPoolValues(firstChoosable),
		scope: `${orgSlug}:${pool?.id ?? "new"}`,
		onSubmit: (input) => save.current(input),
	});
	const { form } = wizard;
	const {
		register,
		formState: { errors },
	} = form;

	/** Routes a server refusal to the step that owns it, or above the buttons. */
	const routeRefusal = {
		onValidationError: (fields: FieldErrors) => wizard.applyFieldErrors(toWizardFieldErrors(fields)),
		onRefusal: (error: { message: string }) => wizard.applyFieldErrors({ _form: [error.message] }),
		onSuccess: () => wizard.complete(),
	};
	const create = useActionMutation(createFleetPoolAction, {
		invalidates: TOPIC_KEYS.fleet(),
		successMessage: "Pool created",
		...routeRefusal,
	});
	const update = useActionMutation(updateFleetPoolAction, {
		invalidates: TOPIC_KEYS.fleet(),
		successMessage: "Pool updated",
		...routeRefusal,
	});

	useEffect(() => {
		save.current = (input) => {
			if (pool !== null) update.submit({ id: pool.id, input });
			else create.submit(input);
		};
	});

	// A new pool whose offered clouds arrived after the sheet opened takes the first free one now,
	// unless a cloud is already chosen (typed, or restored from the draft).
	useEffect(() => {
		if (!wizard.ready || isEdit || firstChoosable === undefined) return;
		const current: string | undefined = form.getValues("provider");
		if (current !== undefined) return;
		form.setValue("provider", firstChoosable);
		if (form.getValues("locationsCsv").trim() === "") {
			form.setValue("locationsCsv", defaultLocationsFor(firstChoosable));
		}
	}, [wizard.ready, isEdit, firstChoosable, form]);

	if (!wizard.ready) return <FleetPoolWizardSkeleton title={isEdit ? "Edit pool" : "Add a warm pool"} />;

	const values = form.getValues();
	const step = wizard.current.id;
	const copy = STEP_COPY[step] ?? FALLBACK_COPY;
	const pending = create.isPending || update.isPending || create.isSuccess || update.isSuccess;
	const provider: CloudProvider | undefined = values.provider;
	const providerLabel = provider === undefined ? "this cloud" : (PROVIDER_LABELS[provider] ?? provider);
	const locations = parseLocations(values.locationsCsv);
	const minPerLocation = numberOrNull(values.minPerLocation) ?? 0;
	const max = numberOrNull(values.max);
	const overcommit = locations.length > 0 && max !== null && minPerLocation * locations.length > max;
	const advancedError = errors.surge !== undefined || errors.scaleDownGraceTicks !== undefined;
	// Edit mode lists the pool's own cloud even when this deployment no longer offers it.
	const providerOptions: readonly CloudProvider[] =
		pool !== null ? [pool.provider] : offered.status === "ready" ? offered.clouds : [];

	/** Why Next cannot be pressed on the Cloud step of a new pool, if it cannot. */
	function cloudReason(): string | undefined {
		if (isEdit || step !== "cloud") return undefined;
		if (offered.status === "pending") return "Loading the clouds this deployment offers.";
		if (offered.status === "error") return "The clouds this deployment offers could not be loaded.";
		if (choosable.length === 0) return "Every cloud offered here already has a pool. Edit that pool instead.";
		if (provider === undefined) return "Choose a cloud to continue.";
		return undefined;
	}

	/** A new cloud also moves the location to its default region, unless the person typed their own. */
	function chooseProvider(next: string): void {
		if (!isConnectableCloudSlug(next)) return;
		const typed = form.getValues("locationsCsv").trim();
		const previous: string | undefined = form.getValues("provider");
		form.setValue("provider", next);
		form.clearErrors("provider");
		if (typed === "" || typed === defaultLocationsFor(previous)) {
			form.setValue("locationsCsv", defaultLocationsFor(next));
		}
	}

	/** Enter in a field means "go on": Next before the last step, Create on it. */
	function onEnter(event: FormEvent<HTMLFormElement>): void {
		event.preventDefault();
		if (pending) return;
		void (wizard.isLast ? wizard.submit() : wizard.next());
	}

	return (
		<>
			<SheetHeader className="border-b border-border">
				<SheetTitle>{isEdit ? "Edit pool" : "Add a warm pool"}</SheetTitle>
				<SheetDescription>A declarative pool of managed runners the controller keeps sized to demand.</SheetDescription>
				<div className="mt-2">
					<Stepper label={STEPPER_LABEL} items={wizard.items} onSelect={wizard.goTo} />
				</div>
			</SheetHeader>

			<form onSubmit={onEnter} noValidate className="flex min-h-0 flex-1 flex-col">
				<div className="flex-1 space-y-4 overflow-y-auto p-4">
					{wizard.restored ? <WizardRestoredNotice onStartOver={wizard.discard} /> : null}
					<WizardStepHeading
						title={copy.title}
						description={copy.description}
						position={wizard.stepNumber}
						total={wizard.stepCount}
						level={3}
					/>

					{step === "cloud" && (
						<div className="space-y-4">
							{offered.status === "error" && !isEdit ? (
								<Notice tone="warning">
									<span>The clouds this deployment offers could not be loaded. </span>
									<button
										type="button"
										onClick={offered.retry}
										className="underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-ring"
									>
										Try again
									</button>
								</Notice>
							) : null}
							{offered.status === "ready" && !isEdit && choosable.length === 0 ? (
								<Notice>Every cloud offered here already has a pool. Close this and edit that pool instead.</Notice>
							) : null}
							<div className="space-y-1.5">
								<FieldLabel
									required
									help={{
										title: "Cloud provider",
										description:
											"The cloud whose runners this pool manages. One pool per cloud; the provider can't change after creation.",
									}}
								>
									Cloud provider
								</FieldLabel>
								{offered.status === "pending" && !isEdit ? (
									<Skeleton className="h-9 w-full rounded-none" />
								) : (
									<Select value={provider ?? ""} onValueChange={chooseProvider} disabled={isEdit}>
										<SelectTrigger
											className="w-full"
											aria-label="Cloud provider"
											aria-invalid={errors.provider !== undefined}
										>
											<SelectValue placeholder="Choose a cloud" />
										</SelectTrigger>
										<SelectContent>
											{providerOptions.map((p) => {
												const pooled = !isEdit && usedProviders.includes(p);
												return (
													<SelectItem key={p} value={p} disabled={pooled}>
														<span className="flex items-center gap-2">
															<ProviderIcon provider={p} size={16} />
															{PROVIDER_LABELS[p] ?? p}
															{pooled && <span className="text-ui-2xs text-muted-foreground">· pooled</span>}
														</span>
													</SelectItem>
												);
											})}
										</SelectContent>
									</Select>
								)}
								<FieldError message={errors.provider?.message} />
							</div>
							<div className="space-y-1.5">
								<FieldLabel htmlFor={nameId}>Display name (optional)</FieldLabel>
								<Input
									id={nameId}
									placeholder="e.g. AWS primary"
									aria-invalid={errors.name !== undefined}
									{...register("name")}
								/>
								<FieldError message={errors.name?.message} />
								<p className="text-ui-xs text-muted-foreground">Shown on the pool card. Defaults to the provider name.</p>
							</div>
						</div>
					)}

					{step === "placement" && (
						<div className="space-y-4">
							<div className="space-y-1.5">
								<FieldLabel
									htmlFor={locationsId}
									required
									help={{
										title: "Locations",
										description:
											"Region or datacenter codes the controller spreads runners across. More locations = better resilience if one region degrades.",
									}}
								>
									Locations
								</FieldLabel>
								<Input
									id={locationsId}
									placeholder={defaultLocationsFor(provider) || "region codes"}
									aria-invalid={errors.locationsCsv !== undefined}
									{...register("locationsCsv")}
								/>
								<FieldError message={errors.locationsCsv?.message} />
								<p className="text-ui-xs text-muted-foreground">Comma-separated region codes for {providerLabel}.</p>
								{locations.length > 0 && (
									<div className="flex flex-wrap gap-1.5 pt-1">
										{locations.map((l) => (
											<span
												key={l}
												className="border border-border bg-muted px-2 py-0.5 font-mono text-ui-xs text-foreground"
											>
												{l}
											</span>
										))}
									</div>
								)}
							</div>
							<NumberField
								label="Minimum per location"
								hint="0 = no per-location floor."
								help={{
									title: "Minimum per location",
									description:
										"Keep at least this many healthy runners in every location, so a single region can always serve work. Leave 0 unless you need guaranteed per-region capacity.",
								}}
								error={errors.minPerLocation?.message}
								{...register("minPerLocation", { setValueAs: numberOrNull })}
							/>
						</div>
					)}

					{step === "capacity" && (
						<div className="space-y-5">
							<div className="grid grid-cols-2 gap-3">
								<NumberField
									label="Warm minimum"
									required
									hint="Always-on floor"
									help={{
										title: "Warm minimum",
										description:
											"Runners kept booted and ready at all times, even with zero queued jobs — they absorb the first burst with no cold-start wait.",
									}}
									error={errors.warmMin?.message}
									{...register("warmMin", { setValueAs: numberOrNull })}
								/>
								<NumberField
									label="Maximum"
									required
									hint="Hard ceiling"
									help={{
										title: "Maximum",
										description:
											"The most runners this pool will ever provision, no matter how deep the queue gets. Caps spend.",
									}}
									error={errors.max?.message}
									{...register("max", { setValueAs: numberOrNull })}
								/>
								<NumberField
									label="Idle buffer"
									hint="Spare above demand"
									help={{
										title: "Idle buffer",
										description:
											"Extra idle runners kept above current demand (N+1 headroom) so a new job rarely waits for a boot. 0 = scale exactly to demand.",
									}}
									error={errors.buffer?.message}
									{...register("buffer", { setValueAs: numberOrNull })}
								/>
								<NumberField
									label="Slots / runner"
									required
									hint="Concurrent jobs each"
									help={{
										title: "Slots per runner",
										description:
											"How many jobs one runner executes at once. Higher packs more work per VM (cheaper) but shares CPU/memory across jobs.",
									}}
									error={errors.slotsPerRunner?.message}
									{...register("slotsPerRunner", { setValueAs: numberOrNull })}
								/>
							</div>

							{overcommit && max !== null && (
								<Notice tone="warning">
									{minPerLocation} per location × {locations.length} locations needs{" "}
									{minPerLocation * locations.length} runners — above your max of {max}. Raise max or lower the
									per-location floor.
								</Notice>
							)}

							<PoolCapacityPreview
								warmMin={numberOrNull(values.warmMin) ?? 0}
								max={max ?? 1}
								buffer={numberOrNull(values.buffer) ?? 0}
								slots={numberOrNull(values.slotsPerRunner) ?? 1}
							/>

							<WizardDisclosure label="Advanced scaling" forceOpen={advancedError}>
								<div className="grid grid-cols-2 gap-3">
									<NumberField
										label="Rollout surge"
										hint="Extra during a version roll"
										help={{
											title: "Rollout surge",
											description:
												"During a version rollout the controller may run this many runners above the ceiling so it can replace old ones without dropping capacity.",
										}}
										error={errors.surge?.message}
										{...register("surge", { setValueAs: numberOrNull })}
									/>
									<NumberField
										label="Scale-down grace"
										hint="Idle ticks before reap"
										help={{
											title: "Scale-down grace",
											description:
												"Consecutive 60s ticks a runner must sit idle before it's removed. Higher avoids flapping when demand is spiky.",
										}}
										error={errors.scaleDownGraceTicks?.message}
										{...register("scaleDownGraceTicks", { setValueAs: numberOrNull })}
									/>
								</div>
							</WizardDisclosure>
						</div>
					)}

					{step === "version" && (
						<div className="space-y-4">
							<div className="space-y-1.5">
								<FieldLabel
									help={{
										title: "Version source",
										description:
											"Channel tracks a moving release stream and auto-updates as new runner versions ship. Pinned holds one exact version until you change it.",
									}}
								>
									Version source
								</FieldLabel>
								<div role="radiogroup" aria-label="Version source" className="grid grid-cols-2 gap-2">
									{(
										[
											{ value: "channel", title: "Channel", desc: "Auto-update to the channel's newest release." },
											{ value: "pin", title: "Pinned", desc: "Hold an exact version until you change it." },
										] as const
									).map((opt) => {
										const on = values.versionSource === opt.value;
										return (
											<button
												key={opt.value}
												type="button"
												role="radio"
												aria-checked={on}
												onClick={() => {
													form.setValue("versionSource", opt.value);
													form.clearErrors(["version", "channel"]);
												}}
												className={cn(
													"flex flex-col items-start gap-1 rounded-md border p-3 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
													on ? "border-foreground/40 bg-muted" : "border-border hover:bg-muted/40",
												)}
											>
												<span className="flex items-center gap-1.5 text-sm font-medium text-foreground">
													<span
														className={cn(
															"flex h-4 w-4 items-center justify-center rounded-full border",
															on ? "border-foreground bg-foreground text-background" : "border-border",
														)}
													>
														{on && <Check className="h-3 w-3" aria-hidden />}
													</span>
													{opt.title}
												</span>
												<span className="text-ui-xs leading-relaxed text-muted-foreground">{opt.desc}</span>
											</button>
										);
									})}
								</div>
							</div>
							{values.versionSource === "pin" ? (
								<div className="space-y-1.5">
									<FieldLabel htmlFor={versionId} required>
										Pinned version
									</FieldLabel>
									<Input
										id={versionId}
										placeholder="e.g. v1.4.2"
										aria-invalid={errors.version !== undefined}
										{...register("version")}
									/>
									<FieldError message={errors.version?.message} />
								</div>
							) : (
								<div className="space-y-1.5">
									<FieldLabel htmlFor={channelId} required>
										Channel
									</FieldLabel>
									<Input
										id={channelId}
										placeholder="stable"
										aria-invalid={errors.channel !== undefined}
										{...register("channel")}
									/>
									<FieldError message={errors.channel?.message} />
									<p className="text-ui-xs text-muted-foreground">
										Usually <span className="font-mono">stable</span>.
									</p>
								</div>
							)}
						</div>
					)}

					{step === "review" && (
						<dl className="divide-y divide-border rounded-lg border border-border text-sm">
							<ReviewRow label="Provider" value={providerLabel} />
							{values.name.trim() && <ReviewRow label="Name" value={values.name.trim()} />}
							<ReviewRow label="Locations" value={locations.join(", ") || "—"} />
							<ReviewRow
								label="Capacity"
								value={`warm ${values.warmMin} · max ${values.max} · +${values.buffer} spare`}
							/>
							<ReviewRow label="Slots / runner" value={String(values.slotsPerRunner)} />
							{minPerLocation > 0 && <ReviewRow label="Min / location" value={String(minPerLocation)} />}
							<ReviewRow label="Surge" value={String(values.surge)} />
							<ReviewRow label="Scale-down grace" value={`${values.scaleDownGraceTicks} ticks`} />
							<ReviewRow
								label="Version"
								value={
									values.versionSource === "pin"
										? values.version.trim() || "—"
										: `${values.channel.trim() || "stable"} (channel)`
								}
							/>
						</dl>
					)}

					<WizardFormError message={wizard.formError} />
				</div>

				<SheetFooter className="border-t border-border">
					<WizardFooter
						back={wizard.stepNumber > 1 ? wizard.back : null}
						primary={
							wizard.isLast
								? {
										kind: "submit",
										label: isEdit ? "Save changes" : "Create pool",
										onPress: () => void wizard.submit(),
									}
								: { kind: "next", label: "Next", onPress: () => void wizard.next() }
						}
						pending={pending}
						disabledReason={cloudReason()}
					/>
				</SheetFooter>
			</form>
		</>
	);
}

/**
 * The sheet while the draft is read (or the edited pool is looked up): the header, the rail on its
 * first step and the Cloud step's two fields, in the places the answered sheet draws them.
 */
function FleetPoolWizardSkeleton({ title }: { title: string }) {
	return (
		<>
			<SheetHeader className="border-b border-border">
				<SheetTitle>{title}</SheetTitle>
				<SheetDescription>A declarative pool of managed runners the controller keeps sized to demand.</SheetDescription>
				<div className="mt-2">
					<Stepper
						label={STEPPER_LABEL}
						items={fleetPoolWizard.steps.map((s, i) => ({
							id: s.id,
							label: s.label,
							state: i === 0 ? "current" : "todo",
						}))}
					/>
				</div>
			</SheetHeader>
			<SkeletonRoot className="flex-1 space-y-4 p-4">
				<Skeleton className="h-5 w-24 rounded-none" />
				<Skeleton className="h-9 w-full rounded-none" />
				<Skeleton className="h-9 w-full rounded-none" />
			</SkeletonRoot>
			<SheetFooter className="border-t border-border">
				<div className="flex items-center justify-end">
					<Skeleton className="h-9 w-20 rounded-none" />
				</div>
			</SheetFooter>
		</>
	);
}

/** A labelled number input with a hint, optional help popover, and an inline error. */
function NumberField({
	label,
	hint,
	help,
	error,
	required,
	...props
}: React.ComponentProps<"input"> & {
	label: string;
	hint: string;
	help?: { title: string; description: string };
	error?: string;
	required?: boolean;
}) {
	const id = useId();
	return (
		<div className="space-y-1.5">
			<div className="flex items-center gap-1.5">
				<Label className="text-xs" htmlFor={id}>
					{label}
					{required && <RequiredMark />}
				</Label>
				{help && <FieldHelp title={help.title} description={help.description} />}
			</div>
			<Input id={id} type="number" min={0} aria-invalid={!!error} {...props} />
			{error ? (
				<FieldError message={error} />
			) : (
				<p className="text-ui-2xs leading-tight text-muted-foreground">{hint}</p>
			)}
		</div>
	);
}

/** Inline field error message. */
function FieldError({ message }: { message?: string }) {
	if (!message) return null;
	return <p className="text-ui-xs text-destructive">{message}</p>;
}

/** A small inline notice block (informational by default, or a warning). */
function Notice({ children, tone = "info" }: { children: React.ReactNode; tone?: "info" | "warning" }) {
	return (
		<div
			className={cn(
				"flex items-start gap-2 rounded-md border px-3 py-2 text-xs leading-relaxed",
				tone === "warning"
					? "border-dashed border-foreground/30 bg-muted text-foreground"
					: "border-dashed border-border bg-muted/40 text-muted-foreground",
			)}
		>
			{tone === "warning" && <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />}
			<span>{children}</span>
		</div>
	);
}

/** Live, plain-English read on what the capacity numbers mean, with a small grayscale meter:
 *  solid = always-warm floor, hatched = idle spare, outline = headroom up to the ceiling. */
function PoolCapacityPreview({
	warmMin,
	max,
	buffer,
	slots,
}: {
	warmMin: number;
	max: number;
	buffer: number;
	slots: number;
}) {
	const safeMax = Math.max(1, Number.isFinite(max) ? max : 1);
	const warm = Math.max(0, Math.min(Number.isFinite(warmMin) ? warmMin : 0, safeMax));
	const spare = Math.max(0, Math.min(Number.isFinite(buffer) ? buffer : 0, safeMax - warm));
	const slotCount = Math.max(1, Number.isFinite(slots) ? slots : 1);
	const cells = Math.min(safeMax, 16);

	return (
		<div className="space-y-2 rounded-md border border-border bg-muted/30 p-3">
			<span className={MONO_LABEL}>What this means</span>
			<div className="flex gap-[3px]">
				{Array.from({ length: cells }, (_, i) => {
					const kind = i < warm ? "warm" : i < warm + spare ? "spare" : "ceiling";
					return (
						<span
							key={i}
							className={cn(
								"h-2.5 flex-1",
								kind === "warm" && "border border-foreground bg-foreground",
								kind === "spare" && "border border-foreground",
								kind === "ceiling" && "border border-dashed border-border",
							)}
							style={
								kind === "spare"
									? {
											backgroundImage:
												"repeating-linear-gradient(45deg, transparent 0 2px, var(--foreground) 2px 3px)",
										}
									: undefined
							}
						/>
					);
				})}
			</div>
			<p className="text-xs leading-relaxed text-foreground">
				Keeps <strong>{warm}</strong> runner{warm !== 1 ? "s" : ""} warm, scales to demand{" "}
				{spare > 0 ? (
					<>
						plus <strong>{spare}</strong> idle spare
					</>
				) : (
					"with no spare"
				)}
				, never past <strong>{safeMax}</strong>. Each runner takes <strong>{slotCount}</strong> job
				{slotCount !== 1 ? "s" : ""} at once
				{slotCount > 1 ? ` (up to ${safeMax * slotCount} concurrent jobs)` : ""}.
			</p>
		</div>
	);
}

/** One label/value row of the Review step. */
function ReviewRow({ label, value }: { label: string; value: string }) {
	return (
		<div className="flex items-start justify-between gap-4 px-4 py-2.5">
			<dt className="font-mono text-ui-2xs uppercase tracking-wider text-muted-foreground">{label}</dt>
			<dd className="max-w-[60%] text-right text-ui-md">{value}</dd>
		</div>
	);
}
