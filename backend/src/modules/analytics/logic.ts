/** Pure Analytics helpers: parse eBay reports, thresholds. */

export const TRAFFIC_METRICS = [
  "LISTING_IMPRESSION_TOTAL",
  "LISTING_VIEWS_TOTAL",
  "CLICK_THROUGH_RATE",
  "SALES_CONVERSION_RATE",
  "TRANSACTION",
] as const;

/** eBay's published seller-standards limits (US), used when the profile doesn't carry its own threshold. Percent. */
export const EBAY_THRESHOLDS: Record<string, { label: string; topRated: number; aboveStandard: number }> = {
  DEFECTIVE_TRANSACTION_RATE: { label: "Transaction defect rate", topRated: 0.5, aboveStandard: 2 },
  CLAIMS_SAF_RATE: { label: "Cases closed without seller resolution", topRated: 0.3, aboveStandard: 0.3 },
  SHIPPING_MISS_RATE: { label: "Late shipment rate", topRated: 3, aboveStandard: 7 },
};

const toNum = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "object") return toNum((v as any).value);
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

export interface TrafficRow {
  key: string;
  impressions: number;
  views: number;
  ctr: number | null;
  conversion: number | null;
  transactions: number;
}

/** traffic_report -> rows keyed by the first dimension value (a day "YYYYMMDD" or a listing id). */
export function parseTrafficReport(report: any): TrafficRow[] {
  const keys: string[] = (report?.header?.metrics ?? []).map((m: any) => m.key);
  return (report?.records ?? []).map((rec: any) => {
    const v = (k: string) => {
      const i = keys.indexOf(k);
      const mv = i < 0 ? undefined : rec.metricValues?.[i];
      return mv?.applicable === false ? null : toNum(mv?.value);
    };
    return {
      key: String(rec.dimensionValues?.[0]?.value ?? ""),
      impressions: v("LISTING_IMPRESSION_TOTAL") ?? 0,
      views: v("LISTING_VIEWS_TOTAL") ?? 0,
      ctr: v("CLICK_THROUGH_RATE"),
      conversion: v("SALES_CONVERSION_RATE"),
      transactions: v("TRANSACTION") ?? 0,
    };
  });
}

/** YYYYMMDD (eBay) <-> YYYY-MM-DD (ours) */
export const ebayDay = (d: Date) => d.toISOString().slice(0, 10).replace(/-/g, "");
export const isoDay = (s: string) => (/^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : s.slice(0, 10));

/** The last `days` complete days, ending yesterday (UTC). */
export function trafficWindow(days = 30, now = new Date()) {
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1));
  const start = new Date(end.getTime() - (days - 1) * 86_400_000);
  return { start, end };
}

export function trafficQuery(dimension: "DAY" | "LISTING", marketplaceId: string, start: Date, end: Date) {
  return {
    dimension,
    filter: `marketplace_ids:{${marketplaceId}},date_range:[${ebayDay(start)}..${ebayDay(end)}]`,
    metric: TRAFFIC_METRICS.join(","),
    ...(dimension === "LISTING" ? { sort: "-LISTING_IMPRESSION_TOTAL" } : {}),
  };
}

export interface StandardsProfile {
  program?: string;
  level?: string;
  cycle?: string;
  evaluationDate?: string;
  evaluationReason?: string;
  defaultProgram?: boolean;
  metrics: {
    key: string;
    name?: string;
    value: number | null;
    numerator: number | null;
    denominator: number | null;
    level?: string;
    thresholdUpper: number | null;
    thresholdLower: number | null;
    lookbackStart?: string;
    lookbackEnd?: string;
  }[];
}

export function mapStandardsProfiles(r: any): StandardsProfile[] {
  return (r?.standardsProfiles ?? []).map((p: any) => ({
    program: p.program,
    level: p.standardsLevel,
    cycle: p.cycle?.cycleType,
    evaluationDate: p.cycle?.evaluationDate,
    evaluationReason: p.evaluationReason,
    defaultProgram: !!p.defaultProgram,
    metrics: (p.metrics ?? []).map((m: any) => ({
      key: m.metricKey,
      name: m.name,
      value: toNum(m.value),
      numerator: toNum(m.numerator),
      denominator: toNum(m.denominator),
      level: m.level,
      thresholdUpper: toNum(m.thresholdUpperBound),
      thresholdLower: toNum(m.thresholdLowerBound),
      lookbackStart: m.lookbackStartDate,
      lookbackEnd: m.lookbackEndDate,
    })),
  }));
}

/** The level to show: the default program's current cycle (else the first current one, else anything). */
export function currentSellerLevel(profiles: StandardsProfile[]): string | null {
  const cur = profiles.filter((p) => p.cycle === "CURRENT");
  return (cur.find((p) => p.defaultProgram) ?? cur[0] ?? profiles[0])?.level ?? null;
}

export function mapCustomerService(type: string, r: any) {
  return (r?.dimensionMetrics ?? []).map((dm: any) => {
    const m = (dm.metrics ?? [])[0] ?? {};
    return {
      type,
      dimension: dm.dimension?.name ?? dm.dimension?.value ?? "All",
      rate: toNum(m.value),
      rating: m.benchmark?.rating,
      peerRate: toNum(m.benchmark?.metadata?.[0]?.value ?? m.benchmark?.adjustment),
    };
  });
}
