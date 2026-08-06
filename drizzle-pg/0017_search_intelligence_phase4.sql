CREATE TABLE "si_campaign_signals" (
	"id" text PRIMARY KEY NOT NULL,
	"campaign_id" text NOT NULL,
	"signal_type" text NOT NULL,
	"magnitude" real,
	"observed_at" text NOT NULL,
	"reason" text NOT NULL,
	"family" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "si_campaigns" (
	"id" text PRIMARY KEY NOT NULL,
	"category" text NOT NULL,
	"subject_entity_id" text,
	"subject_label" text NOT NULL,
	"start_at" text NOT NULL,
	"last_activity_at" text NOT NULL,
	"window_days" integer DEFAULT 7 NOT NULL,
	"signal_count" integer DEFAULT 0 NOT NULL,
	"confidence" real,
	"status" text DEFAULT 'candidate' NOT NULL,
	"entities" text DEFAULT '[]' NOT NULL,
	"reviewed_by" text,
	"reviewed_at" text,
	"review_note" text,
	"dedupe_key" text NOT NULL,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "si_correlation_checkpoints" (
	"id" text PRIMARY KEY NOT NULL,
	"source_key" text NOT NULL,
	"cursor" text,
	"last_run_at" text,
	"last_run_status" text,
	"records_processed" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "si_graph_edges" (
	"id" text PRIMARY KEY NOT NULL,
	"source_node_id" text NOT NULL,
	"target_node_id" text NOT NULL,
	"edge_type" text NOT NULL,
	"weight" real DEFAULT 1 NOT NULL,
	"confidence" real,
	"evidence_count" integer DEFAULT 1 NOT NULL,
	"first_seen_at" text NOT NULL,
	"last_seen_at" text NOT NULL,
	"metadata" text,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "si_graph_evidence" (
	"id" text PRIMARY KEY NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" text NOT NULL,
	"evidence_type" text NOT NULL,
	"source_record_id" text,
	"source_system" text NOT NULL,
	"observed_at" text NOT NULL,
	"weight" real DEFAULT 1 NOT NULL,
	"reason" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "si_graph_nodes" (
	"id" text PRIMARY KEY NOT NULL,
	"node_type" text NOT NULL,
	"external_id" text,
	"source_system" text DEFAULT 'derived' NOT NULL,
	"label" text NOT NULL,
	"canonical_value" text NOT NULL,
	"metadata" text,
	"first_seen_at" text NOT NULL,
	"last_seen_at" text NOT NULL,
	"observation_count" integer DEFAULT 1 NOT NULL,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "si_reputation_findings" (
	"id" text PRIMARY KEY NOT NULL,
	"category" text NOT NULL,
	"severity" text DEFAULT 'low' NOT NULL,
	"confidence" real,
	"signals" text DEFAULT '[]' NOT NULL,
	"affected_entities" text DEFAULT '[]' NOT NULL,
	"subject_label" text NOT NULL,
	"independent_families" integer DEFAULT 0 NOT NULL,
	"channel" text DEFAULT 'none' NOT NULL,
	"delivery_status" text DEFAULT 'detected' NOT NULL,
	"delivered_at" text,
	"suppression_reason" text,
	"first_seen_at" text NOT NULL,
	"last_seen_at" text NOT NULL,
	"status" text DEFAULT 'new' NOT NULL,
	"reviewed_by" text,
	"reviewed_at" text,
	"review_note" text,
	"dedupe_key" text NOT NULL,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "si_timeline_events" (
	"id" text PRIMARY KEY NOT NULL,
	"occurred_at" text NOT NULL,
	"event_type" text NOT NULL,
	"entity_node_id" text,
	"entity_label" text NOT NULL,
	"summary" text NOT NULL,
	"severity" text DEFAULT 'info' NOT NULL,
	"source_system" text NOT NULL,
	"source_record_id" text,
	"evidence_ref" text,
	"dedupe_key" text NOT NULL,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "si_campaign_signals_dedupe_idx" ON "si_campaign_signals" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "si_campaign_signals_campaign_idx" ON "si_campaign_signals" USING btree ("campaign_id");--> statement-breakpoint
CREATE UNIQUE INDEX "si_campaigns_dedupe_idx" ON "si_campaigns" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "si_campaigns_status_idx" ON "si_campaigns" USING btree ("status","last_activity_at");--> statement-breakpoint
CREATE UNIQUE INDEX "si_correlation_checkpoints_source_idx" ON "si_correlation_checkpoints" USING btree ("source_key");--> statement-breakpoint
CREATE UNIQUE INDEX "si_graph_edges_identity_idx" ON "si_graph_edges" USING btree ("source_node_id","target_node_id","edge_type");--> statement-breakpoint
CREATE INDEX "si_graph_edges_out_idx" ON "si_graph_edges" USING btree ("source_node_id","edge_type");--> statement-breakpoint
CREATE INDEX "si_graph_edges_in_idx" ON "si_graph_edges" USING btree ("target_node_id","edge_type");--> statement-breakpoint
CREATE UNIQUE INDEX "si_graph_evidence_dedupe_idx" ON "si_graph_evidence" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "si_graph_evidence_subject_idx" ON "si_graph_evidence" USING btree ("subject_type","subject_id");--> statement-breakpoint
CREATE UNIQUE INDEX "si_graph_nodes_identity_idx" ON "si_graph_nodes" USING btree ("node_type","canonical_value");--> statement-breakpoint
CREATE INDEX "si_graph_nodes_type_idx" ON "si_graph_nodes" USING btree ("node_type","last_seen_at");--> statement-breakpoint
CREATE INDEX "si_graph_nodes_external_idx" ON "si_graph_nodes" USING btree ("source_system","external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "si_reputation_findings_dedupe_idx" ON "si_reputation_findings" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "si_reputation_findings_status_idx" ON "si_reputation_findings" USING btree ("status","severity");--> statement-breakpoint
CREATE INDEX "si_reputation_findings_delivery_idx" ON "si_reputation_findings" USING btree ("delivery_status","channel");--> statement-breakpoint
CREATE UNIQUE INDEX "si_timeline_events_dedupe_idx" ON "si_timeline_events" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "si_timeline_events_time_idx" ON "si_timeline_events" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX "si_timeline_events_type_idx" ON "si_timeline_events" USING btree ("event_type","occurred_at");--> statement-breakpoint
CREATE INDEX "si_timeline_events_entity_idx" ON "si_timeline_events" USING btree ("entity_node_id","occurred_at");