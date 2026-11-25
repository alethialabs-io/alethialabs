ALTER TABLE "factura" DROP CONSTRAINT "factura_document_key";--> statement-breakpoint
ALTER TABLE "factura" DROP CONSTRAINT "factura_credit_note_has_refund";--> statement-breakpoint
ALTER TABLE "factura" ALTER COLUMN "organization_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "factura" ALTER COLUMN "stripe_invoice_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "factura" ADD COLUMN "source" text DEFAULT 'stripe' NOT NULL;--> statement-breakpoint
ALTER TABLE "factura" ADD COLUMN "manual_key" text;--> statement-breakpoint
ALTER TABLE "factura" ADD CONSTRAINT "factura_manual_key" UNIQUE("manual_key");--> statement-breakpoint
ALTER TABLE "factura" ADD CONSTRAINT "factura_document_key" UNIQUE NULLS NOT DISTINCT("stripe_invoice_id","kind","stripe_refund_id","manual_key");--> statement-breakpoint
ALTER TABLE "factura" ADD CONSTRAINT "factura_source_known" CHECK (source IN ('stripe', 'manual'));--> statement-breakpoint
ALTER TABLE "factura" ADD CONSTRAINT "factura_source_link" CHECK ((source = 'stripe' AND stripe_invoice_id IS NOT NULL AND organization_id IS NOT NULL AND manual_key IS NULL)
			OR (source = 'manual' AND stripe_invoice_id IS NULL AND stripe_refund_id IS NULL AND manual_key IS NOT NULL));--> statement-breakpoint
ALTER TABLE "factura" ADD CONSTRAINT "factura_credit_note_has_refund" CHECK (source <> 'stripe' OR (kind = 'credit_note') = (stripe_refund_id IS NOT NULL));