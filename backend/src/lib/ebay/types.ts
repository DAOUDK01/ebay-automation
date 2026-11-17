export interface ActiveListingSummary {
  itemId: string;
  title: string;
  sku: string;
  price: number;
  quantitySold: number;
  watchCount: number;
  listingType: string;
  imageUrl: string;
}

export type Specifics = Record<string, string[]>;
export type CompatRow = Record<string, string>;

export interface EbayItem {
  itemId: string;
  title: string;
  subtitle: string;
  sku: string;
  listingType: string;
  categoryId: string;
  categoryName: string;
  conditionId: string;
  condition: string;
  price: number;
  currency: string;
  quantity: number;
  quantitySold: number;
  watchCount: number;
  hasVariations: boolean;
  variationNames: string[];
  itemSpecifics: Specifics;
  compatibilityCount: number;
  compatibilitySample: CompatRow[];
  /** full existing fitment (not sent to Claude; used to avoid adding duplicates) */
  compatibilityAll?: CompatRow[];
  shipping: {
    options: { service: string; cost: string; free: boolean }[];
    dispatchDays: string;
    policy: string;
    /** business shipping policy id */
    policyId?: string;
    location: string;
    /** package weight/size from the listing (converted to kg/cm), if the seller filled it in */
    package?: PackageDetails;
  };
  pictureCount: number;
  imageUrl: string;
  /** all photo URLs (preview gallery) */
  pictures?: string[];
  descriptionText: string;
  /** raw description HTML (preview/edit only - never sent to Claude) */
  descriptionHtml?: string;
  conditionDescription?: string;
  url: string;
  /** Trading API site code the listing lives on, e.g. "US" or "eBayMotors" */
  site?: string;
}

export interface Aspect {
  name: string;
  required: boolean;
  usage: string;
  mode: "FREE_TEXT" | "SELECTION_ONLY" | string;
  multi: boolean;
  maxLength?: number;
  values: string[];
}

export interface Competitor {
  title: string;
  price: number;
  shipping: number | null;
  condition: string;
  sellerFeedback: number | null;
  sellerPositivePct: string | null;
  topRated: boolean;
  url: string;
}

export interface PackageDetails {
  weightKg: number;
  lengthCm: number;
  widthCm: number;
  heightCm: number;
}

export interface ShippingPolicy {
  id: string;
  name: string;
  /** weight bracket parsed from the policy name, e.g. "Ground 7 KG" -> 7 */
  kg: number | null;
  /** part words from the name, e.g. "BLAP Engine policy" -> ["engine"]; such policies are used for that part */
  parts?: string[];
  /** eBay duplicate ("... Copy (3)") - never suggested */
  copy?: boolean;
}

export interface ShippingAnalysis {
  /** where weight/size came from */
  source: "listing" | "estimate" | "none";
  /** "part" = a policy named after this part (e.g. Engine) was chosen; "weight" = weight bracket */
  rule?: "part" | "weight";
  confidence?: string;
  basis?: string;
  package?: PackageDetails;
  actualKg: number;
  dimensionalKg: number;
  divisor: number;
  billableKg: number;
  /** weight bracket the item belongs in (min applied, rounded up) */
  categoryKg: number;
  overMax: boolean;
  current: { id: string; name: string; kg: number | null } | null;
  suggested: { id: string; name: string; kg: number | null } | null;
  /** current policy is the right one */
  matches: boolean;
  note: string;
}

/** Where a fitment row came from */
export type FitmentSource = "ebay_listings" | "listing_text" | "part_number_knowledge";

export interface FitmentRow extends CompatRow {
  _source: FitmentSource;
  /** for ebay_listings: how many reference listings contain this vehicle ("" otherwise) */
  _support: string;
}

export interface FitmentReference {
  itemId: string;
  title: string;
  url: string;
  partNumber: string;
  rowCount: number;
}

export interface ListingChanges {
  title?: string;
  price?: number;
  /** manual edits only */
  quantity?: number;
  /** manual edits only: full description HTML */
  description?: string;
  itemSpecifics?: Specifics;
  /** optimizer: rows added to the existing fitment */
  compatibilityAdd?: CompatRow[];
  /** manual edits only: the complete fitment list (replaces eBay's) */
  compatibilityReplace?: CompatRow[];
  /** business shipping policy to switch the listing to */
  shippingPolicyId?: string;
  /** manual edits only: package weight/size (kg/cm) */
  packageDetails?: PackageDetails;
}
