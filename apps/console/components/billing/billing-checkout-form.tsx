"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// THE shared, fully-custom checkout form (the project's "State 2"). Stripe's SPLIT card
// elements (Card Number / Expiry / CVC, styled by us) + our own name / address / tax-id
// fields + a derived order summary. On submit it confirms the subscription's first
// payment via stripe.confirmCardPayment(clientSecret) (cards only; 3-D Secure inline),
// then hands the collected billing details to the consumer's `onPaid` which persists them
// (standalone customer vs active org) and advances the flow. Render inside
// <StripeElementsProvider clientSecret={…}>. Reused by the create-org sheet, /onboarding,
// the upgrade-org sheet, and billing settings.

import { coerceEnum } from "@/lib/coerce";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  CardCvcElement,
  CardExpiryElement,
  CardNumberElement,
  useElements,
  useStripe,
} from "@stripe/react-stripe-js";
import { ChevronRight, Info, Lock, Plus, X } from "lucide-react";
import { useTheme } from "next-themes";
import { useId, useState } from "react";
import { Controller, type UseFormReturn, useForm } from "react-hook-form";
import { z } from "zod";
import { cardElementStyle } from "@/components/billing/stripe-elements";
import { BILLING_FIELD_CAPS, tooLongMessage } from "@/lib/billing/billing-field-caps";
import {
  DEFAULT_TAX_ID_TYPE,
  TAX_ID_TYPES,
  type TaxIdType,
  taxIdOption,
} from "@/lib/billing/tax-ids";
import { formatMoney, type Money, money } from "@repo/format";
import type { PriceByCurrency, SupportedCurrency } from "@repo/plan-catalog";
import { Button } from "@repo/ui/button";
import { Checkbox } from "@repo/ui/checkbox";
import { CountrySelect } from "@repo/ui/country-select";
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
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@repo/ui/tooltip";
import { cn } from "@repo/ui/utils";

/**
 * The subset of catalog display fields the checkout form actually renders (name + the
 * per-currency price + optional included credit). Both `PlanCatalogEntry` (org plans) and
 * `AiPlanCatalogEntry` (standalone AI tiers) satisfy it structurally, so the one form serves
 * org-plan checkout AND AI-subscription checkout with no duplication.
 */
export interface CheckoutMeta {
  name: string;
  /** Per-currency monthly amount in MINOR units (`PlanCatalogEntry.priceMonthly`). */
  priceMonthly?: PriceByCurrency;
  /** Per-currency included usage credit in MINOR units. Absent = none. */
  includedCredit?: PriceByCurrency;
}

/** The billing details the form collects and hands back on a confirmed charge. */
export interface CollectedBilling {
  name: string;
  line1: string;
  line2?: string;
  city: string;
  state?: string;
  postalCode: string;
  country: string;
  taxType: TaxIdType;
  taxValue: string;
  /** Whether to also store this address as the org's primary address. */
  useAsPrimary: boolean;
}

/**
 * The address subset of a CollectedBilling — its shape is accepted by both
 * `updateBillingAddress` / `setCustomerBillingAddress` (Stripe customer) and
 * `updateOrgPrimaryAddress` (org metadata), so checkout consumers don't re-map fields.
 */
export function billingAddressFrom(b: CollectedBilling) {
  return {
    name: b.name,
    line1: b.line1,
    line2: b.line2,
    city: b.city,
    state: b.state,
    postalCode: b.postalCode,
    country: b.country,
  };
}

/** A trimmed string no longer than `max` — the server's cap for the same field (billing-field-caps.ts). */
function capped(max: number) {
  return z.string().trim().max(max, tooLongMessage(max));
}

const schema = z.object({
  name: capped(BILLING_FIELD_CAPS.name).min(1, "Enter the cardholder name."),
  country: capped(BILLING_FIELD_CAPS.country).min(2, "Select a country or region."),
  line1: capped(BILLING_FIELD_CAPS.line1).min(1, "Enter your address."),
  line2: capped(BILLING_FIELD_CAPS.line2),
  city: capped(BILLING_FIELD_CAPS.city).min(1, "Enter your city."),
  state: capped(BILLING_FIELD_CAPS.state),
  postalCode: capped(BILLING_FIELD_CAPS.postalCode).min(1, "Enter your postal code."),
  useAsPrimary: z.boolean(),
  taxType: z.custom<TaxIdType>(
    (v) => typeof v === "string" && TAX_ID_TYPES.some((t) => t.value === v),
  ),
  taxValue: capped(BILLING_FIELD_CAPS.taxValue),
});

/** A refusal from `beforeConfirm`: the field it is about (null for the form as a whole) and why. */
export interface CheckoutRefusal {
  field: keyof CollectedBilling | null;
  message: string;
}

/** The checkout field a server-side field name refers to, or null when it is not one of this form's. */
export function checkoutFieldOf(field: string): keyof CollectedBilling | null {
  switch (field) {
    case "name":
    case "line1":
    case "line2":
    case "city":
    case "state":
    case "postalCode":
    case "country":
    case "taxType":
    case "taxValue":
    case "useAsPrimary":
      return field;
    default:
      return null;
  }
}
type FormData = z.infer<typeof schema>;

/**
 * The catalog figure for one currency as a `Money`, and zero when there is none.
 *
 * THE `* 100` THIS FILE USED TO CARRY IS GONE (#4176 part b). The catalog handed it MAJOR units
 * (29, 0.5) and `formatMoney` takes minor ones, so a `toCents` sat in the middle rounding a float
 * price; `priceMonthly` and `includedCredit` are minor units at the source now, so there is
 * nothing to round and nothing to convert. A zero is still a real amount — an included member
 * renders `$0.00`, not a blank — which is why this returns a `Money` rather than null.
 *
 * This file used to carry its own `money()` too, which picked the symbol from a two-entry `€`/`$`
 * table and glued it onto `toLocaleString("en-US")`. It rendered `$29` where every other billing
 * surface renders `$29.00`, and because the symbol was a VARIABLE rather than a literal, no
 * `$`-in-front-of-an-interpolation guard could see it.
 */
function catalogMoney(
  prices: PriceByCurrency | undefined,
  currency: SupportedCurrency,
): Money {
  return money(prices?.[currency] ?? 0, currency);
}

interface BillingCheckoutFormProps {
  /** The subscription intent's client secret (confirmed here). */
  clientSecret: string;
  /** Catalog display fields — drives the name, included credit, and price copy. */
  meta: CheckoutMeta;
  /** Live per-seat price from Stripe — authoritative; falls back to the catalog. MUST be quoted
   *  in `currency` below; one that is not is ignored (see the resolution in the body). */
  unitAmount?: Money | null;
  /** The billing currency (drives the money formatting + fallback). */
  currency: SupportedCurrency;
  /** Owner email for the "1 member" summary row. */
  ownerEmail?: string;
  /**
   * Show the seat rows ("1 member", $0) in the order summary. True for the per-seat org
   * plan; pass false for the standalone AI subscription (no seats — it's a flat product).
   */
  showMembers?: boolean;
  submitLabel?: string;
  /**
   * When true (inside the purchase sheets), the form fills its flex parent: the fields
   * scroll and the submit button is pinned in a sticky footer. Default false → normal
   * flow (onboarding), where the button sits at the end of the fields.
   */
  scrollable?: boolean;
  /**
   * Called after the card is confirmed (charge done). The consumer persists the billing
   * details (address / tax id / primary address) and advances the view. Awaited — keep
   * the button in its processing state until it resolves; never re-charges.
   */
  onPaid: (billing: CollectedBilling) => void | Promise<void>;
  /**
   * Runs BEFORE the card is confirmed, with the details about to be charged for. A refusal (or a
   * throw) stops the charge and is shown on the form — the customer has not paid, and nothing they
   * typed is lost. The create-a-team sheet saves the details server-side here, so a crash after the
   * charge cannot lose them (#5445).
   */
  beforeConfirm?: (billing: CollectedBilling) => Promise<CheckoutRefusal | null>;
}

export function BillingCheckoutForm({
  clientSecret,
  meta,
  unitAmount,
  currency,
  ownerEmail,
  showMembers = true,
  submitLabel,
  scrollable = false,
  onPaid,
  beforeConfirm,
}: BillingCheckoutFormProps) {
  const stripe = useStripe();
  const elements = useElements();
  const { resolvedTheme } = useTheme();
  const style = cardElementStyle(resolvedTheme === "dark");

  const [showTaxId, setShowTaxId] = useState(false);
  const [membersExpanded, setMembersExpanded] = useState(false);

  const form = useForm<FormData>({
    resolver: zodResolver(schema),
    defaultValues: {
      name: "",
      country: "",
      line1: "",
      line2: "",
      city: "",
      state: "",
      postalCode: "",
      useAsPrimary: true,
      taxType: DEFAULT_TAX_ID_TYPE,
      taxValue: "",
    },
    mode: "onChange",
  });

  // Stripe-authoritative seat price in the selected currency (catalog fallback while it
  // loads / offline).
  //
  // THE `unitAmount` PROP IS ONLY USED WHEN IT IS IN `currency`. `useLivePlanPrice(plan, currency)`
  // returns the amount for the currency it was asked for, so the two agree by construction — but
  // "by construction" is a property of the CALLER, and this form is the one place both values are
  // in scope. A mismatch now falls back to the catalog figure for the selected currency instead
  // of printing a euro amount under a dollar total, which is the class of failure #4176 is about.
  const live = unitAmount != null && unitAmount.currency === currency ? unitAmount : null;
  const unit = live ?? catalogMoney(meta.priceMonthly, currency);
  const credit = catalogMoney(meta.includedCredit, currency);
  const included = money(0, currency);
  // Order summary line items — base product + (per-seat plans only) the included member at $0.
  const lineItems = [
    { label: meta.name, cost: unit },
    ...(showMembers ? [{ label: "1 member", cost: included, member: true }] : []),
  ];
  // Summed in MINOR units and re-attached to `currency`, so the total is in the same currency as
  // every line above it by construction rather than by a third variable everyone has to pass.
  const total = money(
    lineItems.reduce((sum, li) => sum + li.cost.minor, 0),
    currency,
  );

  const submitting = form.formState.isSubmitting;
  const cardOptions = { style, showIcon: true } as const;

  async function onValid(values: FormData) {
    if (!stripe || !elements) return;
    const card = elements.getElement(CardNumberElement);
    if (!card) {
      form.setError("root", { message: "Card details are not ready yet." });
      return;
    }
    const billing: CollectedBilling = {
      name: values.name,
      line1: values.line1,
      line2: values.line2 || undefined,
      city: values.city,
      state: values.state || undefined,
      postalCode: values.postalCode,
      country: values.country,
      taxType: values.taxType,
      taxValue: showTaxId ? values.taxValue : "",
      useAsPrimary: values.useAsPrimary,
    };
    if (beforeConfirm) {
      let refusal: CheckoutRefusal | null;
      try {
        refusal = await beforeConfirm(billing);
      } catch {
        refusal = {
          field: null,
          message: "Couldn't save your billing details. You have not been charged — try again.",
        };
      }
      if (refusal) {
        if (refusal.field) form.setError(refusal.field, { message: refusal.message });
        else form.setError("root", { message: refusal.message });
        return;
      }
    }
    const result = await stripe.confirmCardPayment(clientSecret, {
      payment_method: {
        card,
        billing_details: {
          name: values.name,
          address: {
            line1: values.line1,
            line2: values.line2 || undefined,
            city: values.city,
            state: values.state || undefined,
            postal_code: values.postalCode,
            country: values.country,
          },
        },
      },
    });
    if (result.error) {
      form.setError("root", {
        message: result.error.message ?? "Your card couldn't be charged.",
      });
      return;
    }
    // Charge confirmed — hand off; the consumer persists + swaps the view. Errors
    // there are handled by the consumer (retry without re-charging).
    await onPaid(billing);
  }

  return (
    <TooltipProvider>
      <form
        onSubmit={form.handleSubmit(onValid)}
        className={cn("flex flex-col", scrollable ? "min-h-0 flex-1" : "gap-5")}
      >
        <div
          className={cn(
            "space-y-5",
            scrollable && "min-h-0 flex-1 overflow-y-auto pr-1",
          )}
        >
          {/* included credit */}
          {credit.minor > 0 && (
            <div className="flex items-center justify-between rounded-lg border border-border px-4 py-3">
              <div className="flex items-center gap-2 text-ui-md text-text-secondary">
                <span className="font-medium text-text-primary">
                  Included credit
                </span>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <button
                        type="button"
                        aria-label="What is included credit?"
                      >
                        <Info size={13} className="text-text-tertiary" />
                      </button>
                    }
                  />
                  <TooltipContent className="max-w-[220px]">
                    A monthly usage credit applied toward metered resources
                    (runner-minutes & AI) before any overage.
                  </TooltipContent>
                </Tooltip>
              </div>
              <span className="font-mono text-ui-md text-text-primary">
                {formatMoney(credit)}
              </span>
            </div>
          )}

          {/* card row — number full-width, expiry + cvc below */}
          <div className="space-y-2">
            <Label className="text-ui-md">Card information</Label>
            <CardField>
              <CardNumberElement options={cardOptions} />
            </CardField>
            <div className="grid grid-cols-2 gap-2">
              <CardField>
                <CardExpiryElement options={cardOptions} />
              </CardField>
              <CardField>
                <CardCvcElement options={cardOptions} />
              </CardField>
            </div>
            <p className="flex items-center gap-1.5 text-ui-xs text-text-tertiary">
              <Lock size={11} />
              You authorize Alethia to charge your card for this and future
              payments per the terms below.
            </p>
          </div>

          {/* full name */}
          <Field label="Full name" error={form.formState.errors.name?.message}>
            {(id) => (
              <Input
                id={id}
                placeholder="Jane Doe"
                autoComplete="name"
                {...form.register("name")}
              />
            )}
          </Field>

          {/* country */}
          <Field
            label="Country or region"
            error={form.formState.errors.country?.message}
          >
            <Controller
              control={form.control}
              name="country"
              render={({ field }) => (
                <CountrySelect
                  value={field.value}
                  onChange={field.onChange}
                  invalid={Boolean(form.formState.errors.country)}
                />
              )}
            />
          </Field>

          {/* address line 1 */}
          <Field
            label="Address line 1"
            error={form.formState.errors.line1?.message}
          >
            {(id) => (
              <Input
                id={id}
                placeholder="123 Main St"
                autoComplete="address-line1"
                {...form.register("line1")}
              />
            )}
          </Field>

          {/* address line 2 (optional) */}
          <Field
            label="Address line 2"
            optional
            error={form.formState.errors.line2?.message}
          >
            {(id) => (
              <Input
                id={id}
                placeholder="Suite, unit, floor"
                autoComplete="address-line2"
                {...form.register("line2")}
              />
            )}
          </Field>

          {/* city + postal code */}
          <div className="grid grid-cols-2 gap-3">
            <Field label="City" error={form.formState.errors.city?.message}>
              {(id) => (
                <Input
                  id={id}
                  placeholder="Berlin"
                  autoComplete="address-level2"
                  {...form.register("city")}
                />
              )}
            </Field>
            <Field
              label="Postal code"
              error={form.formState.errors.postalCode?.message}
            >
              {(id) => (
                <Input
                  id={id}
                  placeholder="10115"
                  autoComplete="postal-code"
                  {...form.register("postalCode")}
                />
              )}
            </Field>
          </div>

          {/* state / province (optional) */}
          <Field
            label="State / province"
            optional
            error={form.formState.errors.state?.message}
          >
            {(id) => (
              <Input
                id={id}
                placeholder="Optional"
                autoComplete="address-level1"
                {...form.register("state")}
              />
            )}
          </Field>

          {/* use as primary address */}
          <Controller
            control={form.control}
            name="useAsPrimary"
            render={({ field }) => (
              <label className="flex items-center gap-2.5 text-ui-sm text-text-secondary">
                <Checkbox
                  checked={field.value}
                  onCheckedChange={(v) => field.onChange(v === true)}
                />
                Use the billing address as my team&apos;s primary address
              </label>
            )}
          />

          {/* tax id — optional disclosure */}
          <TaxIdSection
            show={showTaxId}
            onShow={() => setShowTaxId(true)}
            onHide={() => {
              setShowTaxId(false);
              form.setValue("taxValue", "");
            }}
            form={form}
          />

          {/* legal paragraph */}
          <p className="text-ui-xs leading-relaxed text-text-tertiary">
            By clicking {submitLabel ?? "Create"}, you authorize a charge of{" "}
            {formatMoney(total)} now and the same amount each month until
            you cancel. Any applicable tax is estimated and finalized on your
            invoice.
          </p>

          {/* order summary */}
          <div className="rounded-lg border border-border">
            {/* header */}
            <div className="flex items-center justify-between border-b border-border px-4 py-2.5 font-mono text-ui-2xs uppercase tracking-wide text-text-tertiary">
              <span>Product</span>
              <span>Cost</span>
            </div>

            {/* plan row */}
            <div className="flex items-center justify-between px-4 py-3 text-ui-sm">
              <span className="font-medium text-text-primary">{meta.name}</span>
              <span className="font-mono text-ui-sm text-text-secondary">
                {formatMoney(unit)}
              </span>
            </div>

            {/* member row — collapsible (per-seat plans only) */}
            {showMembers && (
              <div className="border-t border-border">
                <button
                  type="button"
                  onClick={() => setMembersExpanded((v) => !v)}
                  className="flex w-full items-center justify-between px-4 py-3 text-ui-sm"
                >
                  <span className="flex items-center gap-1.5 text-text-secondary">
                    <ChevronRight
                      size={14}
                      className={cn(
                        "text-text-tertiary transition-transform",
                        membersExpanded && "rotate-90",
                      )}
                    />
                    1 member
                  </span>
                  <span className="font-mono text-ui-sm text-text-secondary">
                    {formatMoney(included)}
                  </span>
                </button>
                {membersExpanded && ownerEmail && (
                  <div className="flex items-center justify-between px-4 pb-3 pl-[34px] text-ui-xs text-text-tertiary">
                    <span className="flex items-center gap-1.5">
                      <span className="truncate">{ownerEmail}</span>
                      <span className="rounded-full border border-border px-1.5 py-px font-mono text-ui-3xs uppercase tracking-wide text-text-tertiary">
                        Owner
                      </span>
                    </span>
                    <span className="font-mono text-ui-2xs">Included</span>
                  </div>
                )}
              </div>
            )}

            {/* total — below divider, right-aligned */}
            <div className="flex items-center justify-end gap-3 border-t border-border px-4 py-3">
              <span className="text-ui-md font-medium text-text-primary">
                Total
              </span>
              <span className="font-display text-ui-xl font-semibold text-text-primary">
                {formatMoney(total)}
                <span className="font-mono text-ui-xs font-normal text-text-tertiary">
                  {" "}
                  / month
                </span>
              </span>
            </div>
          </div>
        </div>

        <div
          className={cn(
            "space-y-3",
            scrollable && "shrink-0 border-t border-border bg-background pt-4",
          )}
        >
          {form.formState.errors.root?.message && (
            <p className="text-ui-sm text-destructive">
              {form.formState.errors.root.message}
            </p>
          )}

          <Button
            type="submit"
            className="w-full"
            disabled={!stripe || submitting}
          >
            {submitting
              ? "Processing…"
              : (submitLabel ?? `Create — ${formatMoney(total)}`)}
          </Button>
        </div>
      </form>
    </TooltipProvider>
  );
}

/** The optional Tax ID block — a link until opened, then a type selector + value input. */
function TaxIdSection({
  show,
  onShow,
  onHide,
  form,
}: {
  show: boolean;
  onShow: () => void;
  onHide: () => void;
  form: UseFormReturn<FormData>;
}) {
  const taxValueId = useId();
  if (!show) {
    return (
      <button
        type="button"
        onClick={onShow}
        className="flex items-center gap-1.5 text-ui-sm text-text-secondary transition-colors hover:text-text-primary"
      >
        <Plus size={13} />
        Add a tax ID
      </button>
    );
  }
  const taxType = form.watch("taxType");
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <label htmlFor={taxValueId} className="text-ui-md font-medium text-text-primary">
          Tax ID
        </label>
        <button
          type="button"
          onClick={onHide}
          aria-label="Remove tax ID"
          className="flex items-center gap-1 font-mono text-ui-2xs uppercase tracking-wide text-text-tertiary transition-colors hover:text-text-primary"
        >
          <X size={12} />
          Remove
        </button>
      </div>
      <div className="grid grid-cols-[180px_1fr] gap-2">
        <Controller
          control={form.control}
          name="taxType"
          render={({ field }) => (
            <Select
              value={field.value}
              onValueChange={(v) =>
                field.onChange(
                  coerceEnum(
                    v,
                    TAX_ID_TYPES.map((t) => t.value),
                    DEFAULT_TAX_ID_TYPE,
                  ),
                )
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TAX_ID_TYPES.map((t) => (
                  <SelectItem key={t.value} value={t.value}>
                    {t.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        />
        <Input
          id={taxValueId}
          placeholder={taxIdOption(taxType).example}
          autoComplete="off"
          {...form.register("taxValue")}
        />
      </div>
      {(form.formState.errors.taxValue?.message ?? form.formState.errors.taxType?.message) && (
        <p className="text-ui-xs text-destructive">
          {form.formState.errors.taxValue?.message ?? form.formState.errors.taxType?.message}
        </p>
      )}
    </div>
  );
}

/** A bordered shell that frames a Stripe split-card element like our text inputs. */
function CardField({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-9 items-center rounded-sm border border-input bg-transparent px-3 transition-shadow focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50 [&>*]:w-full">
      {children}
    </div>
  );
}

/** A labeled field with an optional error / optional badge. */
function Field({
  label,
  optional,
  error,
  children,
}: {
  label: string;
  optional?: boolean;
  error?: string;
  /** A render function receives the `id` its `<label htmlFor>` names, so the label is the
   * field's accessible name; a plain node (a composite control with no single field) gets the
   * same text with no association. */
  children: React.ReactNode | ((id: string) => React.ReactNode);
}) {
  const id = useId();
  const text = (
    <>
      {label}
      {optional && (
        <span className="font-mono text-ui-2xs uppercase tracking-wide text-text-tertiary">
          optional
        </span>
      )}
    </>
  );
  const labelClass = "flex items-center gap-1.5 text-ui-md font-medium text-text-primary";
  return (
    <div className="space-y-1.5">
      {typeof children === "function" ? (
        <label htmlFor={id} className={labelClass}>
          {text}
        </label>
      ) : (
        <div className={labelClass}>{text}</div>
      )}
      {typeof children === "function" ? children(id) : children}
      {error && <p className="text-ui-xs text-destructive">{error}</p>}
    </div>
  );
}
