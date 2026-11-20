/**
 * Fake eBay Trading API for module tests: answers `call(name, xml)` from canned XML responses, parsed with the same
 * options as the real TradingClient (so single elements come back as objects, <Item> always as an array...).
 */
import { XMLParser } from "fast-xml-parser";

const ARRAY_TAGS = new Set(["Item", "NameValueList", "Value", "Compatibility", "Errors", "ShippingServiceOptions", "PictureURL"]);
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  removeNSPrefix: true,
  parseTagValue: false,
  trimValues: true,
  isArray: (name) => ARRAY_TAGS.has(name),
});

export type Responder = (xml: string, n: number) => string | Error;

export function fakeTrading(responders: Record<string, Responder>) {
  const calls: { name: string; xml: string }[] = [];
  const counts: Record<string, number> = {};
  return {
    calls,
    callsTo: (name: string) => calls.filter((c) => c.name === name),
    async call(name: string, xml: string) {
      calls.push({ name, xml });
      const n = (counts[name] = (counts[name] ?? 0) + 1);
      const r = responders[name];
      if (!r) throw new Error(`fake eBay: unexpected call ${name}`);
      const out = r(xml, n);
      if (out instanceof Error) throw out;
      const doc = parser.parse(`<${name}Response xmlns="urn:ebay:apis:eBLBaseComponents"><Ack>Success</Ack>${out}</${name}Response>`);
      return doc[`${name}Response`];
    },
  };
}
