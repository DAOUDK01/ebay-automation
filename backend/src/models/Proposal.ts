import { Schema, model } from "mongoose";

export const PROPOSAL_STATUSES = [
  "proposed", // waiting for review
  "approved", // approved, waiting to be pushed
  "rejected",
  "pushed",
  "failed",
  "no_change",
  "skipped",
  "error",
  "reverted",
] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

/** changes = what will be sent to eBay: { title?, price?, itemSpecifics?, compatibilityAdd? } */
const proposalSchema = new Schema(
  {
    storeId: { type: Schema.Types.ObjectId, ref: "Store", required: true },
    /** null for manual edits made on the listing page */
    batchId: { type: Schema.Types.ObjectId, ref: "Batch", default: null, index: true },
    kind: { type: String, enum: ["optimizer", "manual"], default: "optimizer" },
    itemId: { type: String, required: true },
    status: { type: String, enum: PROPOSAL_STATUSES, required: true },
    before: { type: Schema.Types.Mixed, default: {} },
    suggestion: { type: Schema.Types.Mixed, default: {} },
    changes: { type: Schema.Types.Mixed, default: {} },
    notes: [String],
    competitorQuery: String,
    competitors: { type: Schema.Types.Mixed, default: [] },
    /** shipping weight analysis (actual / dimensional / billable kg, current vs suggested policy) */
    shipping: { type: Schema.Types.Mixed, default: null },
    /** what kind of part: condition + genuine OEM / aftermarket (lib/partKind), with a short label */
    part: { type: Schema.Types.Mixed, default: null },
    /** fitment research: part numbers, reference listings used, rows dropped and why */
    fitment: { type: Schema.Types.Mixed, default: null },
    error: { type: String, default: "" },
    warnings: [String],
    costUsd: { type: Number, default: 0 },
    pushedAt: Date,
    revertedAt: Date,
  },
  { timestamps: true, minimize: false },
);
proposalSchema.index({ storeId: 1, status: 1, pushedAt: -1 });
proposalSchema.index({ storeId: 1, itemId: 1, createdAt: -1 });

export const Proposal = model("Proposal", proposalSchema);
