/**
 * Demo returns, a cancellation, cases and buyer message threads for the demo store.
 *   npm run seed:demo            (first - creates the demo user and store)
 *   npm run seed:returns-messages
 * Goes through the same mapping + upsert code as the real sync (with eBay-shaped JSON/XML objects).
 * Refuses to run against anything but a local MongoDB. Safe to re-run (replaces the demo rows).
 */
import mongoose from "mongoose";
import { env } from "../src/config/env";
import { Store } from "../src/models/Store";
import { User } from "../src/models/User";
import { Message, ReplyTemplate } from "../src/modules/messages/model";
import { dedupeOutbound, upsertMessages } from "../src/modules/messages/sync";
import { mapMemberExchange, mapMyMessage } from "../src/modules/messages/trading";
import { mapCancellation, mapCase, mapReturn } from "../src/modules/returns/ebay";
import { PostOrderCase } from "../src/modules/returns/model";
import { upsertCases } from "../src/modules/returns/sync";

const DEMO_EMAIL = "demo@listing-optimizer.test";
const HOUR = 3600_000;
const at = (hoursFromNow: number) => ({ value: new Date(Date.now() + hoursFromNow * HOUR).toISOString() });
const iso = (hoursFromNow: number) => new Date(Date.now() + hoursFromNow * HOUR).toISOString();
const item = (i: number) => String(256100000000 + i);

async function main() {
  if (env.isProd || !/127\.0\.0\.1|localhost/.test(env.mongoUri)) {
    throw new Error("seed:returns-messages only runs against a local MongoDB (MONGODB_URI must be localhost).");
  }
  await mongoose.connect(env.mongoUri, { dbName: env.mongoDbName });
  const user = await User.findOne({ email: DEMO_EMAIL });
  const store = user && (await Store.findOne({ userId: user._id }).sort({ createdAt: -1 }));
  if (!store) throw new Error("No demo store - run `npm run seed:demo` first.");
  const seller = store.ebayUserId;

  await Promise.all([
    PostOrderCase.deleteMany({ storeId: store._id }),
    Message.deleteMany({ storeId: store._id }),
    ReplyTemplate.deleteMany({ storeId: store._id }),
  ]);

  // ---- returns / cancellations / cases (Post-Order API JSON shapes)
  const returns = [
    {
      returnId: "5301234567",
      buyerLoginName: "mike_garage_77",
      currentType: "MONEY_BACK",
      state: "RETURN_REQUESTED",
      status: "RETURN_REQUESTED",
      creationInfo: {
        item: { itemId: item(1), transactionId: "2850011001", returnQuantity: 1 },
        reason: "NOT_AS_DESCRIBED",
        comments: { content: "Rotors are 300mm, my car needs 281mm. Listing said it fits my 2019 Camry LE." },
        creationDate: at(-30),
      },
      sellerTotalRefund: { estimatedRefundAmount: { value: 74.5, currency: "USD" } },
      sellerResponseDue: { activityDue: "SELLER_APPROVE_REQUEST", respondByDate: at(18) },
    },
    {
      returnId: "5301239876",
      buyerLoginName: "jenny.r",
      currentType: "MONEY_BACK",
      state: "ITEM_SHIPPED",
      status: "ITEM_DELIVERED",
      creationInfo: {
        item: { itemId: item(4), transactionId: "2850011002", returnQuantity: 1 },
        reason: "NO_LONGER_NEED_ITEM",
        comments: { content: "Ordered the wrong bulb size, sorry!" },
        creationDate: at(-24 * 6),
      },
      sellerTotalRefund: { estimatedRefundAmount: { value: 29.99, currency: "USD" } },
      sellerResponseDue: { activityDue: "SELLER_ISSUE_REFUND", respondByDate: at(-3) },
    },
    {
      returnId: "5301230001",
      buyerLoginName: "ok_tuning",
      currentType: "MONEY_BACK",
      state: "CLOSED",
      status: "CLOSED",
      creationInfo: {
        item: { itemId: item(6), transactionId: "2850011003", returnQuantity: 1 },
        reason: "DEFECTIVE_ITEM",
        comments: { content: "One coil has a cracked housing." },
        creationDate: at(-24 * 20),
      },
      sellerTotalRefund: { estimatedRefundAmount: { value: 59.9, currency: "USD" }, actualRefundAmount: { value: 59.9, currency: "USD" } },
      closeInfo: { returnCloseDate: at(-24 * 12) },
    },
  ];
  const cancellation = {
    cancelId: "5000412233",
    legacyOrderId: `${item(2)}-2850011004`,
    requestorType: "BUYER",
    cancelState: "INITIATED",
    cancelStatus: "CANCEL_REQUESTED",
    buyerLoginName: "fleet_parts_buyer",
    cancelReason: "BUYER_ASKED_CANCEL",
    requestRefundAmount: { value: 16.95, currency: "USD" },
    cancelRequestDate: at(-5),
    sellerResponseDueDate: at(67),
  };
  const cases = [
    {
      caseId: "5150098765",
      caseType: "ITEM_NOT_RECEIVED",
      caseStatusEnum: "OPEN",
      buyer: "dan_the_wrench",
      itemId: item(8),
      transactionId: "2850011005",
      claimAmount: { value: 68.0, currency: "USD" },
      creationDate: at(-24 * 3),
      lastModifiedDate: at(-20),
      respondByDate: at(30),
    },
    {
      caseId: "5150011111",
      caseType: "RETURN",
      caseStatusEnum: "CLOSED",
      buyer: "sara_k",
      itemId: item(10),
      transactionId: "2850011006",
      claimAmount: { value: 27.5, currency: "USD" },
      creationDate: at(-24 * 40),
      lastModifiedDate: at(-24 * 30),
    },
  ];
  await upsertCases(store._id, [...returns.map(mapReturn), mapCancellation(cancellation), ...cases.map(mapCase)]);
  // a little history so the detail timeline isn't empty
  await PostOrderCase.updateOne(
    { storeId: store._id, kind: "return", ebayId: "5301239876" },
    {
      $set: {
        timeline: [
          { at: new Date(iso(-24 * 6 + 2)), actor: "SELLER", action: "SELLER_APPROVE_REQUEST", text: "Return approved" },
          { at: new Date(iso(-24 * 4)), actor: "BUYER", action: "BUYER_SHIP_ITEM", text: "Shipped with USPS 9400 1000 0000 0000 0000 00" },
          { at: new Date(iso(-24)), actor: "SYSTEM", action: "ITEM_DELIVERED", text: "Delivered to the seller" },
        ],
      },
    },
  );

  // ---- messages (Trading API objects, as fast-xml-parser returns them)
  const headers = [
    {
      Sender: "mike_garage_77", RecipientUserID: seller, Subject: "Re: Rear Brake Rotors - return", MessageID: "81000001",
      Read: "false", ReceiveDate: iso(-29), ItemID: item(1), ItemTitle: "Rear Brake Rotors Pair Toyota Camry 2018-2023",
      MessageType: "ContactTransactionPartner", Folder: { FolderID: "0" },
    },
    {
      Sender: "carlos.auto", RecipientUserID: seller, Subject: "Shipping to Puerto Rico?", MessageID: "81000002",
      Read: "true", Replied: "true", ReceiveDate: iso(-50), ItemID: item(8), ItemTitle: "Wheel Hub Bearing Assembly Front Subaru Outback",
      MessageType: "AskSellerQuestion", ExternalMessageID: "Q-7700002", ResponseDetails: { ResponseEnabled: "true" }, Folder: { FolderID: "0" },
    },
    {
      Sender: seller, RecipientUserID: "carlos.auto", Subject: "Re: Shipping to Puerto Rico?", MessageID: "81000003",
      ReceiveDate: iso(-46), ItemID: item(8), MessageType: "ResponseToASQQuestion", Folder: { FolderID: "1" },
    },
    {
      Sender: "fleet_parts_buyer", RecipientUserID: seller, Subject: "Please cancel - ordered twice", MessageID: "81000004",
      Read: "false", ReceiveDate: iso(-5), ItemID: item(2), ItemTitle: "Engine Air Filter Ford F-150 2015-2020 5.0L",
      MessageType: "ContactTransactionPartner", Folder: { FolderID: "0" },
    },
  ];
  const exchanges = [
    {
      Item: { ItemID: item(0), Title: "Front Ceramic Brake Pad Set Honda Civic 2016-2021" },
      Question: {
        MessageID: "Q-7700001", SenderID: "civic_si_guy", RecipientID: seller, Subject: "Fitment question",
        Body: "Hi, will these fit a 2018 Civic Si? It has the bigger front brakes I think. Thanks!", MessageType: "AskSellerQuestion",
      },
      MessageStatus: "Unanswered", CreationDate: iso(-2),
    },
    {
      Item: { ItemID: item(5), Title: "Oxygen Sensor Upstream Nissan Altima 2.5L" },
      Question: {
        MessageID: "Q-7700003", SenderID: "altima_owner_2014", RecipientID: seller, Subject: "Is this OEM?",
        Body: "Is this an original Nissan sensor or aftermarket? And is it new or used?", MessageType: "AskSellerQuestion",
      },
      MessageStatus: "Unanswered", CreationDate: iso(-9),
    },
    {
      Item: { ItemID: item(8), Title: "Wheel Hub Bearing Assembly Front Subaru Outback" },
      Question: { MessageID: "Q-7700002", SenderID: "carlos.auto", RecipientID: seller, Subject: "Shipping to Puerto Rico?", Body: "Do you ship to Puerto Rico? How long does it take?" },
      MessageStatus: "Answered", Response: "Yes we do - USPS Priority, usually 4-6 business days.", CreationDate: iso(-50), LastModifiedDate: iso(-46),
    },
  ];
  await upsertMessages(store._id, [...headers.map((h) => mapMyMessage(h, seller)), ...exchanges.flatMap((e) => mapMemberExchange(e, seller))]);
  const bodies: Record<string, string> = {
    "81000001": "I opened a return. The rotors are 300mm but my 2019 Camry LE needs 281mm. Can you approve so I can send them back today?",
    "81000003": "Yes we do - USPS Priority, usually 4-6 business days.",
    "81000004": "Hi, I accidentally ordered this filter twice. I've requested a cancellation on the second order - please approve it before it ships. Thanks!",
  };
  for (const [messageId, body] of Object.entries(bodies)) {
    await Message.updateOne({ storeId: store._id, messageId }, { $set: { body, bodyFetched: true } });
  }
  await dedupeOutbound(store._id);

  await ReplyTemplate.insertMany([
    { storeId: store._id, name: "Fitment - send VIN", body: "Hi {buyer}, thanks for your interest in the {item}. To be sure it fits, please send us your VIN and we'll check it for you." },
    { storeId: store._id, name: "Shipped today", body: "Hi {buyer}, good news - your order shipped today. Tracking is in your eBay order details. Thanks for buying from us!" },
    { storeId: store._id, name: "Return approved", body: "Hi {buyer}, sorry it didn't work out. We've approved your return - please use the eBay label and we'll refund as soon as it arrives." },
  ]);

  const [cases_, msgs] = await Promise.all([PostOrderCase.countDocuments({ storeId: store._id }), Message.countDocuments({ storeId: store._id })]);
  console.log(`Seeded ${cases_} returns/cancellations/cases and ${msgs} messages for "${store.name}".`);
  await mongoose.disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await mongoose.disconnect();
  process.exit(1);
});
