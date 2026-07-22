"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type * as React from "react";
import { Accordion as AccordionPrimitive } from "@base-ui-components/react/accordion";

/** base-ui Accordion root. base-ui's `multiple` defaults to `true`; pass `multiple={false}` with a
 *  controlled array `value` for an auto-closing accordion (opening one section closes the others).
 *  base-ui renames Radix's `Content` part to `Panel`; the `AccordionContent` export name is kept so
 *  call sites don't change. Triggers emit `data-panel-open` (was `data-state=open`). */
function Accordion({
  ...props
}: React.ComponentProps<typeof AccordionPrimitive.Root>) {
  return <AccordionPrimitive.Root data-slot="accordion" {...props} />;
}

function AccordionItem({
  ...props
}: React.ComponentProps<typeof AccordionPrimitive.Item>) {
  return <AccordionPrimitive.Item data-slot="accordion-item" {...props} />;
}

function AccordionHeader({
  ...props
}: React.ComponentProps<typeof AccordionPrimitive.Header>) {
  return <AccordionPrimitive.Header data-slot="accordion-header" {...props} />;
}

function AccordionTrigger({
  ...props
}: React.ComponentProps<typeof AccordionPrimitive.Trigger>) {
  return (
    <AccordionPrimitive.Trigger data-slot="accordion-trigger" {...props} />
  );
}

function AccordionContent({
  ...props
}: React.ComponentProps<typeof AccordionPrimitive.Panel>) {
  return <AccordionPrimitive.Panel data-slot="accordion-content" {...props} />;
}

export {
  Accordion,
  AccordionItem,
  AccordionHeader,
  AccordionTrigger,
  AccordionContent,
};
