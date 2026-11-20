/**
 * "Draft with Claude": a short, polite, factual reply built from the thread, the listing and the order /
 * return status. Returns text for the user to edit - it never sends anything.
 */
import Anthropic from "@anthropic-ai/sdk";

export interface DraftInput {
  storeName: string;
  sellerId: string;
  buyer: string;
  /** oldest first */
  thread: { from: "buyer" | "seller"; at: string | null; subject: string; body: string }[];
  listing: Record<string, unknown> | null;
  order: Record<string, unknown> | null;
  returns: Record<string, unknown>[];
  /** extra instructions typed by the user, e.g. "offer 10% off" */
  instructions?: string;
}

export interface DraftOptions {
  model: string;
  inputPricePerMtok: number;
  outputPricePerMtok: number;
}

export interface DraftResult {
  text: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
}

export type DraftFn = (input: DraftInput, opts: DraftOptions) => Promise<DraftResult>;

export const DRAFT_SYSTEM_PROMPT = `You write replies to eBay buyer messages for a small eBay seller.
Write the reply the seller will send to the buyer's latest message.

Rules:
- Polite, warm and short: usually 2-5 sentences. Plain text only, no markdown, no subject line.
- Start with a greeting using the buyer's username, end with a short sign-off from the store name.
- Only state facts found in the provided listing, order and return data. Never invent fitment,
  measurements, part numbers, stock, shipping dates or tracking numbers. If the data doesn't answer
  the question, say you will check and get back to them (or ask for the VIN / details you need).
- For "will it fit" questions, answer from the listing's compatibility list and item specifics; if the
  vehicle isn't listed, say it isn't listed and suggest they send their VIN.
- Never promise refunds, discounts or anything outside eBay; don't ask the buyer to pay or talk outside eBay.
- Don't include email addresses, phone numbers or links.
- If seller instructions are given, follow them as long as they don't break these rules.
Return only the reply text.`;

let client: Anthropic | null = null;
const getClient = () => (client ??= new Anthropic()); // reads ANTHROPIC_API_KEY

export const draftReply: DraftFn = async (input, opts) => {
  const resp: any = await getClient().messages.create({
    model: opts.model,
    max_tokens: 1200,
    system: DRAFT_SYSTEM_PROMPT,
    messages: [{ role: "user", content: JSON.stringify(input) }],
  } as any);
  const u = resp.usage ?? {};
  const inputTokens = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) * 1.25 + (u.cache_read_input_tokens ?? 0) * 0.1;
  const outputTokens = u.output_tokens ?? 0;
  const costUsd = (inputTokens / 1e6) * opts.inputPricePerMtok + (outputTokens / 1e6) * opts.outputPricePerMtok;
  if (resp.stop_reason === "refusal") throw Object.assign(new Error("Claude declined to draft this reply"), { costUsd });
  const text = (resp.content ?? [])
    .filter((b: any) => b.type === "text")
    .map((b: any) => b.text)
    .join("")
    .trim();
  return { text, costUsd, inputTokens: Math.round(inputTokens), outputTokens };
};
