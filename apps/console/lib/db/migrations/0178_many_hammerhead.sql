CREATE TABLE "factura" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"number" text NOT NULL,
	"kind" text NOT NULL,
	"original_factura_id" uuid,
	"stripe_invoice_id" text NOT NULL,
	"issue_date" date NOT NULL,
	"chargeable_date" date NOT NULL,
	"snapshot" jsonb NOT NULL,
	"pdf_key" text,
	"pdf_sha256" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "factura_number_unique" UNIQUE("number"),
	CONSTRAINT "factura_stripe_invoice_kind" UNIQUE("stripe_invoice_id","kind"),
	CONSTRAINT "factura_number_ten_digits" CHECK (number ~ '^[0-9]{10}$'),
	CONSTRAINT "factura_kind_known" CHECK (kind IN ('invoice', 'credit_note')),
	CONSTRAINT "factura_credit_note_has_original" CHECK ((kind = 'credit_note') = (original_factura_id IS NOT NULL)),
	CONSTRAINT "factura_pdf_pair" CHECK ((pdf_key IS NULL) = (pdf_sha256 IS NULL)),
	CONSTRAINT "factura_pdf_sha256_hex" CHECK (pdf_sha256 IS NULL OR pdf_sha256 ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "factura_series" (
	"id" text PRIMARY KEY NOT NULL,
	"last_number" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "factura_series_ten_digits" CHECK (last_number >= 0 AND last_number <= 9999999999)
);
--> statement-breakpoint
ALTER TABLE "factura" ADD CONSTRAINT "factura_original_factura_id_factura_id_fk" FOREIGN KEY ("original_factura_id") REFERENCES "public"."factura"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "factura_org_idx" ON "factura" USING btree ("organization_id");