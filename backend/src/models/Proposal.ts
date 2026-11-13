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
    batchId: { type: Schema.Types.ObjectId, ref: "Batch", required: true, index: true },
    itemId: { type: String, required: true },
    status: { type: String, enum: PROPOSAL_STATUSES, required: true },
    before: { type: Schema.Types.Mixed, default: {} },
    suggestion: { type: Schema.Types.Mixed, default: {} },
    changes: { type: Schema.Types.Mixed, default: {} },
    notes: [String],
    competitorQuery: String,
    competitors: { type: Schema.Types.Mixed, default: [] },
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
