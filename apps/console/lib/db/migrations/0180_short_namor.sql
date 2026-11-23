ALTER TABLE "factura" DROP CONSTRAINT "factura_stripe_invoice_kind";--> statement-breakpoint
ALTER TABLE "invoice" ADD COLUMN "factura_alerted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "factura" ADD COLUMN "stripe_refund_id" text;--> statement-breakpoint
CREATE INDEX "factura_issue_date_idx" ON "factura" USING btree ("issue_date");--> statement-breakpoint
ALTER TABLE "factura" ADD CONSTRAINT "factura_document_key" UNIQUE NULLS NOT DISTINCT("stripe_invoice_id","kind","stripe_refund_id");--> statement-breakpoint
ALTER TABLE "factura" ADD CONSTRAINT "factura_credit_note_has_refund" CHECK ((kind = 'credit_note') = (stripe_refund_id IS NOT NULL));