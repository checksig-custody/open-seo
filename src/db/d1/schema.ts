// Raw SQLite schema for the D1 client. Imported directly (not via ../schema,
// which is the provider-aware barrel) so the D1 client always binds to the
// SQLite tables regardless of DATABASE_PROVIDER.
export * from "../app.schema";
export * from "../audit.schema";
export * from "../sam.schema";
export * from "../better-auth-schema";
export * from "../billing.schema";
export * from "../gsc.schema";
export * from "../reddit-attribution.schema";
export * from "../telemetry.schema";
// MORGANA LOCAL PATCH (UPSTREAM.md, patch P6).
export * from "../search-intelligence.schema";
export * from "../search-intelligence-p2.schema";
export * from "../search-intelligence-p3.schema";
export * from "../search-intelligence-p4.schema";
