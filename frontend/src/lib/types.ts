export interface User {
  id: string;
  email: string;
  name: string;
}

export interface StoreSettings {
  mode: "review" | "auto";
  batchSize: number;
  gapBetweenListingsSec: number;
  gapBetweenPushesSec: number;
  gapBetweenBatchesMin: number;
  cooldownDays: number;
  resyncHours: number;
  activeHours: { enabled: boolean; start: string; end: string; timezone: string };
  competitorCount: number;
  excludeSeller: string;
  claude: {
    model: string;
    effort: "low" | "medium" | "high";
    monthlyBudgetUsd: number;
    inputPricePerMtok: number;
    outputPricePerMtok: number;
  };
  modules: {
    title: { enabled: boolean; template: string };
    pricing: {
      enabled: boolean;
      maxChangePct: number;
      requireCostForDecrease: boolean;
      minMarginPct: number;
      feePct: number;
      minPrice: number;
    };
    specifics: { enabled: boolean; overwriteExisting: boolean };
    compatibility: {
      enabled: boolean;
      apply: boolean;
      researchEbay: boolean;
      allowKnowledge: boolean;
      minListings: number;
      maxReferenceListings: number;
    };
  };
}

export interface StoreStats {
  activeListings: number;
  processedListings: number;
  neverProcessed: number;
  pendingReview: number;
  pushedTotal: number;
  monthSpendUsd: number;
  monthCalls: number;
}

export interface Store {
  id: string;
  name: string;
  ebayUserId: string;
  marketplaceId: string;
  settings: StoreSettings;
  runner: { enabled: boolean; nextRunAt?: string; lastBatchAt?: string; lastError?: string };
  lastSyncAt?: string;
  tokenExpiresAt?: string;
  stats?: StoreStats;
}

export interface Job {
  _id: string;
  type: "sync" | "batch" | "push";
  status: "queued" | "running" | "done" | "failed" | "cancelled";
  payload: any;
  result?: any;
  error?: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface Batch {
  _id: string;
  number: number;
  status: "running" | "review" | "pushing" | "done" | "error";
  mode: "review" | "auto";
  trigger: "schedule" | "manual";
  startedAt: string;
  finishedAt?: string;
  costUsd: number;
  error?: string;
  counts: { total: number; processed: number; proposed: number; noChange: number; errors: number; pushed: number; failed: number };
  push?: { total: number; done: number; failed: number; currentItemId?: string; startedAt?: string | null; finishedAt?: string | null };
}

export interface Listing {
  _id: string;
  itemId: string;
  title: string;
  sku: string;
  price: number;
  quantitySold: number;
  watchCount: number;
  listingType: string;
  imageUrl?: string;
  lastProcessedAt?: string | null;
  cost: number | null;
}

export interface EbayItemSnapshot {
  itemId: string;
  title: string;
  price: number;
  currency: string;
  categoryName: string;
  condition: string;
  imageUrl: string;
  url: string;
  itemSpecifics: Record<string, string[]>;
  shipping?: { dispatchDays: string; policy: string; options: { service: string; cost: string; free: boolean }[] };
}

export interface FitmentRow {
  Year: string;
  Make: string;
  Model: string;
  Trim?: string;
  Engine?: string;
  _source: "ebay_listings" | "listing_text" | "part_number_knowledge";
  _support: string;
}

export interface FitmentInfo {
  partNumbers: string[];
  references: { itemId: string; title: string; url: string; partNumber: string; rowCount: number }[];
  dropped: string[];
  existingCount: number;
}

export interface Proposal {
  _id: string;
  batchId: string;
  itemId: string;
  status: "proposed" | "approved" | "rejected" | "pushed" | "failed" | "no_change" | "skipped" | "error" | "reverted";
  before: EbayItemSnapshot;
  suggestion: {
    title?: string;
    title_reason?: string;
    recommended_price?: number;
    price_reason?: string;
    shipping_notes?: string;
    other_notes?: string;
    confidence?: string;
    suggested_compatibility_rows?: (Record<string, string> & Partial<Pick<FitmentRow, "_source" | "_support">>)[];
  };
  changes: {
    title?: string;
    price?: number;
    itemSpecifics?: Record<string, string[]>;
    compatibilityAdd?: Record<string, string>[];
  };
  notes: string[];
  fitment?: FitmentInfo | null;
  competitors?: { title: string; price: number; shipping: number | null; condition: string; url: string; sellerFeedback: number | null }[];
  error?: string;
  warnings?: string[];
  costUsd: number;
  pushedAt?: string;
  revertedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Paged<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}
