"use client"
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Accordion as AccordionPrimitive } from "radix-ui"

/** Radix Accordion root. `type="single" collapsible` + a controlled `value` gives an
 *  auto-closing accordion (opening one section closes the others). */
function Accordion({
  ...props
}: React.ComponentProps<typeof AccordionPrimitive.Root>) {
  return <AccordionPrimitive.Root data-slot="accordion" {...props} />
}

function AccordionItem({
  ...props
}: React.ComponentProps<typeof AccordionPrimitive.Item>) {
  return <AccordionPrimitive.Item data-slot="accordion-item" {...props} />
}

function AccordionHeader({
  ...props
}: React.ComponentProps<typeof AccordionPrimitive.Header>) {
  return <AccordionPrimitive.Header data-slot="accordion-header" {...props} />
}

function AccordionTrigger({
  ...props
}: React.ComponentProps<typeof AccordionPrimitive.Trigger>) {
  return <AccordionPrimitive.Trigger data-slot="accordion-trigger" {...props} />
}

function AccordionContent({
  ...props
}: React.ComponentProps<typeof AccordionPrimitive.Content>) {
  return <AccordionPrimitive.Content data-slot="accordion-content" {...props} />
}

export {
  Accordion,
  AccordionItem,
  AccordionHeader,
  AccordionTrigger,
  AccordionContent,
}
