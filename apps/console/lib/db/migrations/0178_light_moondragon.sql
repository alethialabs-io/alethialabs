CREATE TABLE "email_preference" (
	"email" text NOT NULL,
	"category" text NOT NULL,
	"enabled" boolean NOT NULL,
	"user_id" uuid,
	"source" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_preference_email_category_pk" PRIMARY KEY("email","category")
);
--> statement-breakpoint
ALTER TABLE "email_preference" ADD CONSTRAINT "email_preference_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "email_preference_user_idx" ON "email_preference" USING btree ("user_id");