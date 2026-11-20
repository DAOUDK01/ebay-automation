/**
 * Buyer messages: Trading GetMyMessages / GetMemberMessages / ReviseMyMessages / AddMemberMessageRTQ /
 * AddMemberMessageAAQToPartner, plus Claude-drafted replies and saved templates.
 *  - model.ts    messages (threads = buyer + item) and reply templates
 *  - trading.ts  Trading XML mapping and request bodies
 *  - sync.ts     background refresh since a cursor
 *  - draft.ts    Claude draft (never sends)
 *  - router.ts   API
 * The Trading API works with the base api_scope every connected account already has.
 */
import type { StoreDocument } from "../../models/Store";
import type { AccountModule, Counts } from "../types";
import { Message } from "./model";
import router from "./router";
import { syncMessages } from "./sync";

/** Unread buyer messages (individual messages, not threads). */
export async function messagesCounts(store: StoreDocument): Promise<Counts> {
  return { unreadMessages: await Message.countDocuments({ storeId: store._id, direction: "in", read: false }) };
}

const messages: AccountModule = {
  key: "messages",
  label: "Messages",
  ready: true,
  scopes: [],
  router,
  sync: syncMessages,
  counts: messagesCounts,
};

export default messages;
