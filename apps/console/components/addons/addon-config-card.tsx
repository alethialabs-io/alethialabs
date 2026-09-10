"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The enable / configure / remove card for one cluster add-on, opened from the Architecture
// canvas's Add palette (the standalone Add-ons page was retired — add-ons now live on the canvas).
// It renders the add-on's schema'd knobs + a delivery-mode selector (Managed apply vs GitOps into
// the customer's apps repo) + an Advanced raw Helm-values (YAML) override. Submitting writes a
// PENDING project_addons row that reconciles on the next Deploy. The knobs mirror the Zod schema
// (re-validated server-side); the YAML is validated on save and deep-merged on top of the knobs at
// resolve time.
//
// A docked card on the workspace rail, not a modal Sheet: it used to open OVER the board, so you
// could not read the cluster's cards while deciding an add-on's namespace or delivery mode.

import { asRecord } from "@/lib/records";
import { ChevronsUpDown } from "lucide-react";
import { useRef } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { Badge } from "@repo/ui/badge";
import { addonCompat } from "@/lib/compat";
import { PROJECT_NODE_ID, useCanvasStore } from "@/lib/stores/use-canvas-store";
import { SheetCard } from "@/components/design-project/canvas/cards/sheet-card";
import { EmptyState } from "@repo/ui/empty";
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
import { Switch } from "@repo/ui/switch";
import { Textarea } from "@repo/ui/textarea";
import type { AddonMarketItem } from "@/app/server/actions/addons";
import { REQUIREMENT_HINTS } from "@/lib/addons/requirements";
import type { AddOnField, AddOnMode } from "@/lib/addons/types";
import type { CloudProviderSlug } from "@/lib/cloud-providers/generated/catalog";
import {
  useAddonsQuery,
  useDisableAddon,
  useEnableAddon,
} from "@/lib/query/use-addons-query";
import { AddonIcon, AddonStatusBadge } from "./addon-visuals";

/** Reserved RHF field names (kept distinct from add-on knob keys). */
type FormShape = Record<string, unknown> & {
  _mode: AddOnMode;
  _valuesYaml: string;
};

/**
 * Whether a stored value counts as a present secret — an `EncryptedSecret` envelope, or a
 * legacy non-empty plaintext string. Mirrors `lib/addons/secrets.ts::hasStoredSecret` inline
 * so the client never imports the server-only crypto module that file also exports.
 */
function isSecretSet(v: unknown): boolean {
  return (
    (typeof v === "object" &&
      v !== null &&
      "iv" in v &&
      "tag" in v &&
      "data" in v) ||
    (typeof v === "string" && v.length > 0)
  );
}

/**
 * Seeds one field's form value from its stored value. A `secret` is write-only — it is seeded
 * BLANK, never with the stored `EncryptedSecret` (the ciphertext must not reach the form/DOM,
 * and an untouched submit must not send the envelope back through the string schema). A `nested`
 * field recurses into an object of its children; a scalar takes the stored value or its default.
 */
function seedField(f: AddOnField, stored: unknown): unknown {
  if (f.type === "secret") return "";
  if (f.type === "nested") {
    const parent = stored && typeof stored === "object" ? asRecord(stored) : {};
    const obj: Record<string, unknown> = {};
    for (const child of f.fields ?? []) {
      obj[child.key] = seedField(child, parent[child.key]);
    }
    return obj;
  }
  return stored ?? f.default;
}

/** Builds the form's default values: the add-on knobs + mode + raw YAML (existing install wins). */
function initialValues(item: AddonMarketItem): FormShape {
  const out: FormShape = {
    _mode: item.install?.mode ?? "managed",
    _valuesYaml: item.install?.valuesYaml ?? "",
  };
  for (const f of item.fields) {
    out[f.key] = seedField(f, item.install?.values?.[f.key]);
  }
  return out;
}

/**
 * The add-on card on the workspace rail. Resolves the catalog item by id from the environment's
 * add-ons query (the same poll the Add palette reads), so the card is addressable by
 * `{kind:"addon", itemId}` alone — and re-renders with the install state as it changes.
 */
export function AddonConfigCard({
  itemId,
  projectId,
  environmentId,
}: {
  itemId: string;
  projectId: string;
  environmentId: string | null;
}) {
  const addons = useAddonsQuery(projectId, environmentId);
  const closeCard = useCanvasStore((s) => s.closeCard);
  const provider = useCanvasStore((s) => s.getEffectiveProvider(PROJECT_NODE_ID));
  const live = addons.data?.items.find((i) => i.id === itemId) ?? null;

  // The row is FROZEN at the moment the card resolves it, and that is the whole point. This query
  // polls every 15s and `AddonConfigForm` seeds react-hook-form through the `values` option, which
  // re-`reset()`s the form whenever that object deep-changes — so a teammate (or the user's own
  // second tab) enabling or reconfiguring the same add-on would land a refetch that silently wiped
  // whatever was half-typed, the Advanced YAML override above all. The Sheet this card replaced
  // could not do that, because it captured the item at click time; a card resolving live from the
  // poll reintroduced the hazard. Freezing restores the old guarantee: an open form belongs to the
  // person typing in it.
  const frozen = useRef<AddonMarketItem | null>(null);
  if (live && (frozen.current === null || frozen.current.id !== itemId)) {
    frozen.current = live;
  }
  const item = frozen.current?.id === itemId ? frozen.current : null;

  if (!item) {
    return (
      <SheetCard title="Add-on" eyebrow="Add-on" onClose={closeCard}>
        <EmptyState
          title={addons.isPending ? "Loading the catalog…" : "This add-on is not in the catalog"}
          description={
            addons.isPending
              ? undefined
              : "It may have been removed from the marketplace. Pick one from the Add palette."
          }
        />
      </SheetCard>
    );
  }
  return (
    <AddonConfigForm
      item={item}
      projectId={projectId}
      environmentId={environmentId}
      hasAppsRepo={addons.data?.hasAppsRepo ?? false}
      provider={provider}
      onDone={closeCard}
    />
  );
}

/**
 * The add-on's enable / configure / remove form, as a card. Props-driven so the catalog item can
 * be handed in directly (tests, and any surface that already holds the item); `onDone` is called
 * after a successful save or removal, and by Cancel.
 */
export function AddonConfigForm({
  item,
  projectId,
  environmentId,
  hasAppsRepo,
  provider,
  onDone,
}: {
  item: AddonMarketItem;
  projectId: string;
  environmentId: string | null;
  hasAppsRepo: boolean;
  /** The project's effective cloud provider — drives the requirement hints (null = unset). */
  provider: CloudProviderSlug | null;
  onDone: () => void;
}) {
  const enable = useEnableAddon(projectId, environmentId);
  const disable = useDisableAddon(projectId, environmentId);
  const form = useForm<FormShape>({
    values: initialValues(item),
  });
  const mode = form.watch("_mode");
  // The env's Kubernetes minor, straight from the canvas store — above the early return, since hooks
  // must run in the same order every render. No cluster / unset version → undefined → the engine
  // answers `not_evaluable` rather than a false pass.
  const k8sVersion = useCanvasStore((s) => {
    const c = s.nodes.find((n) => n.data.kind === "cluster")?.data.config;
    const v = c && "cluster_version" in c ? c.cluster_version : null;
    return typeof v === "string" && v ? v : undefined;
  });

  // Silent when the add-on's recorded window fits — same calm rule as the canvas chip (#1222).
  const addonVerdict = addonCompat(item.id, k8sVersion);
  const compat = addonVerdict.status === "pass" ? null : addonVerdict;
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
      onDone();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to save add-on");
    }
  });

  /** Remove the add-on from this environment (reconciled away on the next Deploy). */
  const onRemove = async () => {
    try {
      await disable.mutateAsync({
        projectId,
        environmentId,
        addonId: item.id,
      });
      toast.success(`${item.name} removed`);
      onDone();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to remove add-on");
    }
  };

  /**
   * Renders one schema'd knob, discriminated on `f.type`, at RHF path `path` (dotted for a
   * nested child, e.g. `resources.cpu`). `stored` is this field's persisted value, used for a
   * boolean's initial state and a secret's set/unset indicator. Recurses one level for `nested`.
   */
  const renderField = (f: AddOnField, path: string, stored: unknown) => {
    const help = f.help ? (
      <p className="text-xs text-muted-foreground">{f.help}</p>
    ) : null;

    if (f.type === "nested") {
      const parent =
        stored && typeof stored === "object" ? asRecord(stored) : {};
      return (
        <div key={path} className="space-y-2">
          <Label>{f.label}</Label>
          <div className="space-y-4 rounded-md border border-l-2 border-l-border bg-muted/20 p-3">
            {(f.fields ?? []).map((child) =>
              renderField(child, `${path}.${child.key}`, parent[child.key]),
            )}
          </div>
          {help}
        </div>
      );
    }

    if (f.type === "boolean") {
      return (
        <div key={path} className="space-y-2">
          <div className="flex items-center justify-between">
            <Label htmlFor={path}>{f.label}</Label>
            <Switch
              id={path}
              defaultChecked={Boolean(stored ?? f.default)}
              onCheckedChange={(v) => form.setValue(path, v)}
            />
          </div>
          {help}
        </div>
      );
    }

    if (f.type === "enum") {
      // Uncontrolled: Radix owns the display from `defaultValue`; RHF gets each change via
      // setValue (the stored value is already seeded into the form's initial values). The
      // value is stored, the option label is shown.
      const initial = String(stored ?? f.default ?? "");
      return (
        <div key={path} className="space-y-2">
          <Label htmlFor={path}>{f.label}</Label>
          <Select
            defaultValue={initial}
            onValueChange={(v) => form.setValue(path, v)}
          >
            <SelectTrigger id={path}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(f.options ?? []).map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {help}
        </div>
      );
    }

    if (f.type === "secret") {
      // Write-only: the input never binds to the stored value (an EncryptedSecret envelope),
      // so the ciphertext never reaches the DOM. The pill reads set/unset from the stored
      // value; typing sets a new plaintext (encrypted server-side).
      const set = isSecretSet(stored);
      return (
        <div key={path} className="space-y-2">
          <div className="flex items-center justify-between">
            <Label htmlFor={path}>{f.label}</Label>
            <span className="font-mono text-ui-2xs uppercase tracking-wide text-muted-foreground">
              {set ? "Set" : "Unset"}
            </span>
          </div>
          <Input
            id={path}
            type="password"
            autoComplete="off"
            placeholder={set ? "Enter a new value to replace" : "Set a value"}
            onChange={(e) => form.setValue(path, e.target.value)}
          />
          {help}
        </div>
      );
    }

    // number / string
    return (
      <div key={path} className="space-y-2">
        <Label htmlFor={path}>{f.label}</Label>
        <Input
          id={path}
          type={f.type === "number" ? "number" : "text"}
          min={f.min}
          max={f.max}
          {...form.register(
            path,
            f.type === "number" ? { valueAsNumber: true } : {},
          )}
        />
        {help}
      </div>
    );
  };

  return (
    <SheetCard
      eyebrow="Add-on"
      icon={<AddonIcon icon={item.icon} className="h-4 w-4" />}
      title={
        <span className="flex flex-wrap items-center gap-2">
          {item.name}
          {item.install && (
            <AddonStatusBadge
              status={item.install.status}
              health={item.install.health}
            />
          )}
        </span>
      }
      description={
        <>
          {item.summary} Installs the <code>{item.chart}</code> chart into{" "}
          <code>{item.namespace}</code>. Reconciles on your next Deploy.
        </>
      }
      onClose={onDone}
      footer={
        <>
          {isInstalled ? (
            <Button
              type="button"
              variant="ghost"
              className="text-muted-foreground hover:text-destructive"
              onClick={onRemove}
              disabled={disable.isPending}
            >
              Remove
            </Button>
          ) : (
            <Button type="button" variant="ghost" onClick={onDone}>
              Cancel
            </Button>
          )}
          <Button type="submit" form="addon-config-form" disabled={enable.isPending}>
            {enable.isPending
              ? "Saving…"
              : isInstalled
                ? "Save changes"
                : "Enable add-on"}
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Badge variant="outline" className="text-ui-2xs uppercase">
              Free · OSS
            </Badge>
            <span>{item.license}</span>
          </div>
          {item.requires.length > 0 && (
            <div className="space-y-1.5 pt-2">
              <p className="text-xs font-medium text-muted-foreground">
                Requirements
              </p>
              {item.requires.map((req) => {
                const h = REQUIREMENT_HINTS[req](provider);
                return (
                  <div key={req} className="flex items-start gap-2">
                    <Badge
                      variant="outline"
                      className="shrink-0 text-ui-2xs uppercase"
                    >
                      {h.label}
                    </Badge>
                    <span className="text-xs text-muted-foreground">
                      {h.hint}
                    </span>
                  </div>
                );
              })}
            </div>
          )}

          {/* Kubernetes compatibility (#1221) — the same register as Requirements: a badge and one
              line of prose. Silent when the recorded window fits this cluster; `not_evaluable` is
              stated as unknown rather than dressed up as fine. */}
          {compat && (
            <div className="flex items-start gap-2 pt-2">
              <Badge
                variant={compat.status === "fail" ? "destructive" : "outline"}
                className="shrink-0 text-ui-2xs uppercase"
              >
                {compat.status === "fail" ? "Incompatible" : "Unverified"}
              </Badge>
              <span className="text-xs text-muted-foreground">{compat.note}</span>
            </div>
          )}
        </div>

        <form id="addon-config-form" onSubmit={onSubmit} className="space-y-5">
            {/* Delivery mode */}
            <div className="space-y-2">
              <Label>Delivery</Label>
              <Select
                value={mode}
                onValueChange={(v) =>
                  form.setValue("_mode", v === "gitops" ? "gitops" : "managed")
                }
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

            {/* Schema'd knobs — discriminated on field type (enum/secret/nested + scalars). */}
            {item.fields
              // `generated` knobs are minted for the user and have no form (#2846): the chart
              // dictates their key names, and nobody has an opinion about a CSRF key's value.
              .filter((f) => !f.generated)
              .map((f) => renderField(f, f.key, item.install?.values?.[f.key]))}

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
                  placeholder={
                    "# deep-merged on top of the options above\n# e.g.\n# resources:\n#   requests:\n#     cpu: 100m"
                  }
                  className="font-mono text-xs"
                  {...form.register("_valuesYaml")}
                />
                <p className="mt-1 text-xs text-muted-foreground">
                  Overrides the options above; merged into the chart values.
                </p>
              </CollapsibleContent>
            </Collapsible>
        </form>
      </div>
    </SheetCard>
  );
}
