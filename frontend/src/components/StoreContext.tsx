"use client";
import { createContext, useContext } from "react";
import type { KeyedMutator } from "swr";
import type { Batch, Job, Store } from "@/lib/types";

export interface StoreDetail {
  store: Store;
  jobs: Job[];
  batches: Batch[];
  usage: { month: string; usd: number; calls: number }[];
}

export const StoreCtx = createContext<{ data: StoreDetail; mutate: KeyedMutator<StoreDetail> } | null>(null);

export function useStore() {
  const ctx = useContext(StoreCtx);
  if (!ctx) throw new Error("useStore must be used inside the store layout");
  return ctx;
}
