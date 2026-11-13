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
  shipping: {
    options: { service: string; cost: string; free: boolean }[];
    dispatchDays: string;
    policy: string;
    location: string;
  };
  pictureCount: number;
  imageUrl: string;
  descriptionText: string;
  url: string;
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

export interface ListingChanges {
  title?: string;
  price?: number;
  itemSpecifics?: Specifics;
  compatibilityAdd?: CompatRow[];
}
