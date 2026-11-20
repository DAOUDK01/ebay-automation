/**
 * What kind of part a listing is - its condition (from eBay's condition) and its origin: a genuine OEM
 * part (made by / for the car maker) or an aftermarket brand (FEBEST, Dorman, Moog...).
 *
 * The store's title format ends in fixed text like "OEM Used", written for used genuine parts. A new
 * aftermarket part must not be called "OEM Used", so the fixed text is adapted per part:
 *   used OEM -> "OEM Used"   new OEM -> "OEM New"   new aftermarket -> "New"   used aftermarket -> "Used"
 * Pure functions.
 */
import type { EbayItem } from "./ebay/types";

export type PartCondition = "new" | "used" | "reman" | "for_parts";
export type PartOrigin = "oem" | "aftermarket" | "unknown";

export interface PartKind {
  condition: PartCondition;
  origin: PartOrigin;
  /** the brand that decided the origin ("" if none) */
  brand: string;
  /** may the title / description say OEM or Genuine? */
  oemWording: boolean;
  /** the part number the title must keep ("" if the title has none) */
  partNumber: string;
  /** why, in plain words (shown on the review card) */
  reason: string;
}

/** vehicle makes: a part whose Brand is the car maker is a genuine (OEM) part */
const MAKES = [
  "acura", "alfa romeo", "aston martin", "audi", "bentley", "bmw", "buick", "cadillac", "chevrolet", "chevy", "chrysler",
  "datsun", "dodge", "ferrari", "fiat", "ford", "genesis", "geo", "gmc", "honda", "hummer", "hyundai", "infiniti", "isuzu",
  "jaguar", "jeep", "kia", "lamborghini", "land rover", "range rover", "lexus", "lincoln", "lotus", "maserati", "mazda",
  "mclaren", "mercedes", "mercedes-benz", "mercury", "mini", "mitsubishi", "nissan", "oldsmobile", "plymouth", "polestar",
  "pontiac", "porsche", "ram", "rivian", "rolls-royce", "saab", "saturn", "scion", "smart", "subaru", "suzuki", "tesla",
  "toyota", "volkswagen", "vw", "volvo", "freightliner", "international", "kenworth", "mack", "peterbilt", "harley-davidson",
  "yamaha", "kawasaki", "ducati", "triumph", "can-am", "polaris",
];
/** the car makers' own parts labels */
const OE_LABELS = ["motorcraft", "mopar", "acdelco", "ac delco", "gm", "gm genuine", "genuine", "oem", "oe", "genuine oem", "oem genuine", "factory", "nismo", "trd", "mugen", "ford racing", "mopar performance"];
/** placeholders sellers use when there is no brand */
const NO_BRAND = ["unbranded", "unbranded/generic", "generic", "does not apply", "n/a", "na", "none", "no brand", "unknown"];
/** a Brand value that itself says aftermarket */
const AFTERMARKET_WORDS = ["aftermarket", "replacement", "aftermarket replacement"];
/**
 * Companies that make parts FOR the car makers and also sell them under their own name. A used part with
 * this brand was usually pulled from a car (genuine), a new one is sold as their own (aftermarket) part.
 */
const OE_SUPPLIERS = [
  "bosch", "denso", "aisin", "valeo", "hella", "ngk", "ntk", "mahle", "delphi", "skf", "timken", "lemforder", "sachs",
  "bilstein", "luk", "exedy", "koito", "stanley", "trw", "zf", "continental", "hitachi", "mitsuba", "nsk", "nachi", "keihin",
  "magneti marelli", "marelli", "visteon", "behr", "nippondenso", "sumitomo", "yazaki", "aisan", "jatco", "getrag", "borgwarner",
];
/**
 * Common aftermarket brands - only used to spot the brand in a title when the Brand specific is missing.
 * Words that are also model names (Pilot, Crown, Spyder...) are deliberately left out.
 */
const AFTERMARKET_BRANDS = [
  "febest", "dorman", "moog", "anchor", "westar", "dea", "monroe", "kyb", "cardone", "tyc", "depo", "spectra", "beck arnley",
  "duralast", "detroit axle", "a-premium", "apremium", "mevotech", "standard motor products", "smp", "four seasons",
  "gates", "dayco", "raybestos", "wagner", "centric", "power stop", "akebono", "magnaflow", "spectra premium", "skp",
  "fel-pro", "felpro", "victor reinz", "corteco", "pronto", "rareelectrical", "unipoint", "tri-star", "trq",
  "replacement innovations", "evan fischer", "brock", "anzo", "morimoto", "duraflex", "rugged ridge", "omix-ada", "uro",
  "febi", "meyle", "vaico", "vemo", "gabriel", "sensen", "fcs", "eccpp", "ecccpp", "scitoo", "maxfavor", "bodeman",
];

const norm = (s: string) =>
  (s || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s/-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
const hasWord = (text: string, word: string) => new RegExp(`(^|[^a-z0-9])${word.replace(/[-/]/g, "\\$&")}($|[^a-z0-9])`).test(text);

const isMake = (brand: string) => MAKES.some((m) => hasWord(brand, m));
/** "Acura", "Toyota Genuine", "Mopar" - a value that names the car maker / its parts label */
export const isCarMakerBrand = (value: string) => {
  const b = norm(value);
  return isMake(b) || isOeLabel(b);
};
const isOeLabel = (brand: string) => OE_LABELS.includes(brand);

/** eBay condition id / name -> new / used / remanufactured / for parts. Unknown = used (a used-parts store). */
export function partCondition(conditionId: string | undefined, conditionName = ""): PartCondition {
  const id = Number(conditionId);
  if (id === 7000) return "for_parts";
  if (id >= 1000 && id < 2000) return "new";
  if (id >= 2000 && id < 2750) return "reman";
  if (id >= 2750 && id < 7000) return "used";
  const n = conditionName.toLowerCase();
  if (/for parts|not working/.test(n)) return "for_parts";
  if (/reman|refurb/.test(n)) return "reman";
  if (/\bnew\b/.test(n) && !/like new/.test(n)) return "new";
  return "used";
}

const YEARS = /^(19|20)\d{2}([-–](19|20)?\d{2})?$/;
/** a title word that looks like a part number: letters+digits or dashed groups, 6+ characters (HAB-133, 33150-TBA-A01) */
export function looksLikePartNumber(word: string): boolean {
  const w = word.replace(/^[#(]+|[),.;:]+$/g, "");
  // years, "AWD/4WD", "6-Speed", "12Volt", "4-Cylinder" are not part numbers
  if (YEARS.test(w) || w.includes("/") || /^\d{1,2}-?[a-z]{3,}$/i.test(w)) return false;
  const alnum = w.replace(/[^a-z0-9]/gi, "");
  if (alnum.length < 6 || !/\d/.test(alnum)) return false;
  return /[a-z]/i.test(alnum) || /[-.]/.test(w) || alnum.length >= 8;
}
const pnKey = (s: string) => s.replace(/[^a-z0-9]/gi, "").toUpperCase();

/** The part number a title must keep: the listing's Manufacturer Part Number if the title shows it, else the first one in the title. */
export function primaryPartNumber(title: string, specifics: Record<string, string[]> = {}): string {
  const words = (title || "").split(/\s+/).map((w) => w.replace(/^[#(]+|[),.;:]+$/g, ""));
  const inTitle = words.filter(looksLikePartNumber);
  const mpn = Object.entries(specifics).find(([k]) => /^manufacturer part number$/i.test(k))?.[1] ?? [];
  for (const v of mpn) {
    const hit = words.find((w) => pnKey(w) === pnKey(v) && pnKey(v).length >= 4);
    if (hit) return hit;
  }
  return inTitle[0] ?? "";
}

/** True when the title still contains the part number (dashes/spaces ignored: 33150TBAA01 = 33150-TBA-A01). */
export function titleHasPartNumber(title: string, pn: string): boolean {
  if (!pn) return true;
  const key = pnKey(pn);
  return (title || "").split(/\s+/).some((w) => pnKey(w) === key) || pnKey(title).includes(key);
}

export function classifyPart(item: Pick<EbayItem, "title" | "conditionId" | "condition" | "itemSpecifics">): PartKind {
  const condition = partCondition(item.conditionId, item.condition);
  const specifics = item.itemSpecifics ?? {};
  const brandRaw = (Object.entries(specifics).find(([k]) => /^brand$/i.test(k))?.[1]?.[0] ?? "").trim();
  const brand = norm(brandRaw);
  const title = norm(item.title);
  const partNumber = primaryPartNumber(item.title, specifics);

  let origin: PartOrigin = "unknown";
  let shownBrand = brandRaw;
  let reason = "";
  const used = condition === "used" || condition === "for_parts";
  if (hasWord(title, "aftermarket") || AFTERMARKET_WORDS.includes(brand)) {
    origin = "aftermarket";
    reason = 'the listing says "aftermarket"';
  } else if (brand && (isMake(brand) || isOeLabel(brand))) {
    origin = "oem";
    reason = `Brand is ${brandRaw} (the car maker's own part)`;
  } else if (brand && OE_SUPPLIERS.some((b) => hasWord(brand, b))) {
    // Denso, Bosch, Aisin...: pulled from a car = genuine; new = their own aftermarket part
    origin = used ? "unknown" : "aftermarket";
    reason = used
      ? `Brand is ${brandRaw}, who also supplies the car makers - a used one is usually the original part`
      : `Brand is ${brandRaw} and the part is new - sold under their own name, not as OEM`;
  } else if (brand && !NO_BRAND.includes(brand)) {
    origin = "aftermarket";
    reason = `Brand is ${brandRaw}, an aftermarket maker (not the car maker)`;
  } else if (brand && !used) {
    // "Unbranded" + new: the seller's own data wins over title words (an older title may say "OEM Used" by mistake)
    origin = "aftermarket";
    shownBrand = "";
    reason = `Brand is "${brandRaw}" and the part is not used`;
  } else {
    const titleBrand = AFTERMARKET_BRANDS.find((b) => hasWord(title, b));
    if (titleBrand) {
      origin = "aftermarket";
      shownBrand = item.title.split(/\s+/).find((w) => norm(w) === titleBrand.split(" ")[0]) ?? titleBrand;
      reason = `the title names ${shownBrand}, an aftermarket maker`;
    } else if (/\b(oem|genuine|factory|oe)\b/.test(title)) {
      origin = "oem";
      reason = "the title says OEM / genuine";
    } else {
      reason = "no brand information";
    }
  }
  // unknown + used: the store sells used genuine parts, so keep its usual "OEM" wording
  const oemWording = origin === "oem" || (origin === "unknown" && used);
  return { condition, origin, brand: origin === "oem" && !brand ? "" : shownBrand, oemWording, partNumber, reason };
}

const CONDITION_WORD: Record<PartCondition, string | null> = { used: null, new: "New", reman: "Remanufactured", for_parts: "For Parts" };
export const CONDITION_LABEL: Record<PartCondition, string> = { used: "Used", new: "New", reman: "Remanufactured", for_parts: "For parts" };

/** Fixed text adapted to the part: no "OEM"/"Genuine" unless it may say so, "Used" -> the real condition. */
export function adaptLiteral(text: string, k: Pick<PartKind, "condition" | "oemWording">): string {
  let s = text;
  if (!k.oemWording) s = s.replace(/\b(genuine|oem|oe)\b/gi, "");
  const word = CONDITION_WORD[k.condition];
  if (word) s = s.replace(/\bused\b/gi, word);
  return s.replace(/[ \t]{2,}/g, " ");
}

/** The store's title format for this part: only the text outside {…} changes. */
export function adaptTitleTemplate(template: string, k: Pick<PartKind, "condition" | "oemWording">): string {
  if (!template?.trim()) return template ?? "";
  return template
    .split(/(\{[^}]*\})/)
    .map((part) => (part.startsWith("{") ? part : adaptLiteral(part, k)))
    .join("")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** Short label for the review card, e.g. "New · Aftermarket (FEBEST)". */
export function partLabel(k: PartKind): string {
  const origin = k.origin === "oem" ? "Genuine OEM" : k.origin === "aftermarket" ? `Aftermarket${k.brand ? ` (${k.brand})` : ""}` : "Brand unknown";
  return `${CONDITION_LABEL[k.condition]} · ${origin}`;
}
