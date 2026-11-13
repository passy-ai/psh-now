ALTER TABLE "tenants" ADD COLUMN "free_top_ups" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "free_top_up_at" timestamp with time zone;