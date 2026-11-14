/** "You may also like": pick other items from the same store that suit the buyer of this listing. */

export interface RelatedItem {
  itemId: string;
  title: string;
  price: number;
  imageUrl: string;
  quantitySold?: number;
}

const STOP = new Set(
  "used oem genuine new the and for with fits fit front rear left right driver passenger side assembly assy part parts oe set pair lh rh upper lower inner outer complete original factory".split(
    " ",
  ),
);

/** Meaningful words of a title: no years, part numbers, filler or position words. */
export function keywords(title: string): string[] {
  return [
    ...new Set(
      (title || "")
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, " ")
        .split(/\s+/)
        .filter((t) => !/\d/.test(t)) // years, part numbers like 33150-TBA-A01
        .flatMap((t) => t.split("-"))
        .filter((w) => w.length > 2 && !STOP.has(w)),
    ),
  ];
}

/**
 * Rank candidates by shared vehicle/part words with the current listing (vehicle words count double),
 * with a small bonus for items that sell. Skips the listing itself, duplicates of the same title and
 * items without an https photo.
 */
export function rankRelated(
  current: { itemId: string; title: string },
  vehicleWords: string[],
  candidates: RelatedItem[],
  count: number,
): RelatedItem[] {
  const mine = new Set(keywords(current.title));
  const vehicle = new Set(vehicleWords.map((w) => w.toLowerCase()));
  const seen = new Set<string>([current.title.trim().toLowerCase()]);
  return candidates
    .filter((c) => c.itemId !== current.itemId && /^https:\/\//.test(c.imageUrl || "") && c.price > 0)
    .map((c) => {
      let score = 0;
      for (const w of keywords(c.title)) score += vehicle.has(w) ? 2 : mine.has(w) ? 1 : 0;
      return { c, score: score + Math.min(c.quantitySold ?? 0, 20) / 20 };
    })
    .sort((a, b) => b.score - a.score)
    .filter(({ c }) => {
      const k = c.title.trim().toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .slice(0, count)
    .map(({ c }) => c);
}
