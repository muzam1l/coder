CREATE SCHEMA "coder";
--> statement-breakpoint
CREATE TABLE "coder"."agent" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"source" text NOT NULL,
	"repo" text,
	"path" text,
	"current_version" integer NOT NULL,
	"settings" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_organizationId_slug_unique" UNIQUE("organization_id","slug")
);
--> statement-breakpoint
CREATE TABLE "coder"."agent_version" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"agent_id" bigint NOT NULL,
	"version" integer NOT NULL,
	"definition" jsonb NOT NULL,
	"system_prompt" text NOT NULL,
	"files" jsonb,
	"commit" text,
	"imported_from" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_version_agentId_version_unique" UNIQUE("agent_id","version")
);
--> statement-breakpoint
CREATE TABLE "coder"."chat_item" (
	"key" text NOT NULL,
	"seq" bigint GENERATED ALWAYS AS IDENTITY (sequence name "coder"."chat_item_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"value" jsonb NOT NULL,
	"expires_at" timestamp with time zone,
	CONSTRAINT "chat_item_key_seq_pk" PRIMARY KEY("key","seq")
);
--> statement-breakpoint
CREATE TABLE "coder"."chat_state" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"expires_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "coder"."engine_credential" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"secret_id" bigint NOT NULL,
	"owner" text,
	"engine" text NOT NULL,
	"label" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"account" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "engine_credential_secretId_unique" UNIQUE("secret_id"),
	CONSTRAINT "engine_credential_organizationId_owner_label_unique" UNIQUE NULLS NOT DISTINCT("organization_id","owner","label")
);
--> statement-breakpoint
CREATE TABLE "coder"."integration_app" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"key" text NOT NULL,
	"integration" text NOT NULL,
	"platform_app_id" text NOT NULL,
	"agent" text NOT NULL,
	"name" text NOT NULL,
	"agents_repo" text,
	"branch" text,
	"credentials_secret_id" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "integration_app_organizationId_key_unique" UNIQUE("organization_id","key"),
	CONSTRAINT "integration_app_integration_platformAppId_unique" UNIQUE("integration","platform_app_id")
);
--> statement-breakpoint
CREATE TABLE "coder"."integration_app_installation" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"key" text NOT NULL,
	"app_id" bigint NOT NULL,
	"platform_install_id" text NOT NULL,
	"account" jsonb NOT NULL,
	"token_secret_id" bigint,
	"installer" text,
	"connections" jsonb,
	"settings" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "integration_app_installation_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "coder"."platform_link" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"platform" text NOT NULL,
	"platform_user_id" text NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"organizations" jsonb,
	"token" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "platform_link_platform_platformUserId_unique" UNIQUE("platform","platform_user_id")
);
--> statement-breakpoint
CREATE TABLE "coder"."runner" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"public_id" text NOT NULL,
	"owner" text,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"scope" text NOT NULL,
	"config" jsonb NOT NULL,
	"created_by" text,
	"is_default" boolean DEFAULT false NOT NULL,
	"last_seen" timestamp with time zone,
	"secret_id" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "runner_organizationId_publicId_unique" UNIQUE("organization_id","public_id")
);
--> statement-breakpoint
CREATE TABLE "coder"."secret" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"kind" text NOT NULL,
	"iv" text NOT NULL,
	"tag" text NOT NULL,
	"ciphertext" text NOT NULL,
	"key_version" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "coder"."task" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"public_id" text NOT NULL,
	"source" text NOT NULL,
	"status" text NOT NULL,
	"agent" text NOT NULL,
	"flow" text NOT NULL,
	"runner" text NOT NULL,
	"permissions" text,
	"app_id" bigint,
	"installation_id" bigint,
	"event" jsonb,
	"prompt" text,
	"args" jsonb,
	"mcp" jsonb,
	"author" text,
	"definition" jsonb NOT NULL,
	"credential" text,
	"requester" text,
	"runner_id" text,
	"usage" jsonb,
	"tools" jsonb NOT NULL,
	"tool_scopes" jsonb,
	"context" jsonb,
	"files" jsonb,
	"result" jsonb,
	"error" text,
	"tokens" jsonb,
	"handle" text,
	"token_hash" text,
	"last_seen_at" timestamp with time zone,
	"log_cursor" integer,
	"log_seq" integer,
	"log_bytes" integer,
	"archived_at" timestamp with time zone,
	"approval" jsonb,
	"answer" jsonb,
	"attempts" integer DEFAULT 0 NOT NULL,
	"inbox_seq" integer DEFAULT -1 NOT NULL,
	"inbox_ack" integer DEFAULT -1 NOT NULL,
	"generation" integer DEFAULT 0 NOT NULL,
	"locked_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"cancel_requested_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_organizationId_publicId_unique" UNIQUE("organization_id","public_id")
);
--> statement-breakpoint
CREATE TABLE "coder"."task_inbox" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"task_id" bigint NOT NULL,
	"seq" integer NOT NULL,
	"generation" integer DEFAULT 0 NOT NULL,
	"kind" text NOT NULL,
	"value" jsonb,
	"at" timestamp with time zone NOT NULL,
	CONSTRAINT "task_inbox_taskId_seq_unique" UNIQUE("task_id","seq")
);
--> statement-breakpoint
CREATE TABLE "coder"."task_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"task_id" bigint NOT NULL,
	"seq" integer NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"level" text NOT NULL,
	"line" text NOT NULL,
	CONSTRAINT "task_log_taskId_seq_unique" UNIQUE("task_id","seq")
);
--> statement-breakpoint
CREATE TABLE "coder"."usage" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"task_id" bigint NOT NULL,
	"installation_id" bigint,
	"agent" text NOT NULL,
	"target" text NOT NULL,
	"engine" text,
	"model" text,
	"credential" text NOT NULL,
	"runner_ms" integer NOT NULL,
	"tokens" jsonb,
	"at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "usage_taskId_unique" UNIQUE("task_id")
);
--> statement-breakpoint
ALTER TABLE "coder"."agent_version" ADD CONSTRAINT "agent_version_agent_id_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "coder"."agent"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coder"."engine_credential" ADD CONSTRAINT "engine_credential_secret_id_secret_id_fk" FOREIGN KEY ("secret_id") REFERENCES "coder"."secret"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coder"."integration_app" ADD CONSTRAINT "integration_app_credentials_secret_id_secret_id_fk" FOREIGN KEY ("credentials_secret_id") REFERENCES "coder"."secret"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coder"."integration_app_installation" ADD CONSTRAINT "integration_app_installation_app_id_integration_app_id_fk" FOREIGN KEY ("app_id") REFERENCES "coder"."integration_app"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coder"."integration_app_installation" ADD CONSTRAINT "integration_app_installation_token_secret_id_secret_id_fk" FOREIGN KEY ("token_secret_id") REFERENCES "coder"."secret"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coder"."runner" ADD CONSTRAINT "runner_secret_id_secret_id_fk" FOREIGN KEY ("secret_id") REFERENCES "coder"."secret"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coder"."task" ADD CONSTRAINT "task_app_id_integration_app_id_fk" FOREIGN KEY ("app_id") REFERENCES "coder"."integration_app"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coder"."task" ADD CONSTRAINT "task_installation_id_integration_app_installation_id_fk" FOREIGN KEY ("installation_id") REFERENCES "coder"."integration_app_installation"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coder"."task_inbox" ADD CONSTRAINT "task_inbox_task_id_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "coder"."task"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coder"."task_log" ADD CONSTRAINT "task_log_task_id_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "coder"."task"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coder"."usage" ADD CONSTRAINT "usage_task_id_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "coder"."task"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coder"."usage" ADD CONSTRAINT "usage_installation_id_integration_app_installation_id_fk" FOREIGN KEY ("installation_id") REFERENCES "coder"."integration_app_installation"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chat_item_expires_at_index" ON "coder"."chat_item" USING btree ("expires_at") WHERE "coder"."chat_item"."expires_at" is not null;--> statement-breakpoint
CREATE INDEX "chat_state_expires_at_index" ON "coder"."chat_state" USING btree ("expires_at") WHERE "coder"."chat_state"."expires_at" is not null;--> statement-breakpoint
CREATE INDEX "integration_app_installation_organization_id_app_id_index" ON "coder"."integration_app_installation" USING btree ("organization_id","app_id");--> statement-breakpoint
CREATE INDEX "platform_link_user_id_index" ON "coder"."platform_link" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "secret_organization_id_kind_index" ON "coder"."secret" USING btree ("organization_id","kind");--> statement-breakpoint
CREATE INDEX "task_public_id_index" ON "coder"."task" USING btree ("public_id");--> statement-breakpoint
CREATE INDEX "task_organization_id_created_at_public_id_index" ON "coder"."task" USING btree ("organization_id","created_at" DESC NULLS LAST,"public_id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "task_organization_id_index" ON "coder"."task" USING btree ("organization_id") WHERE "coder"."task"."status" = 'queued';--> statement-breakpoint
CREATE INDEX "task_status_created_at_index" ON "coder"."task" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "task_inbox_task_id_generation_seq_index" ON "coder"."task_inbox" USING btree ("task_id","generation","seq");--> statement-breakpoint
CREATE INDEX "usage_organization_id_at_index" ON "coder"."usage" USING btree ("organization_id","at");