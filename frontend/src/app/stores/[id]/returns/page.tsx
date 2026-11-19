"use client";
import { useParams } from "next/navigation";
import { ReturnsInbox } from "@/components/returns/ReturnsInbox";

export default function ReturnsPage() {
  const { id } = useParams<{ id: string }>();
  return <ReturnsInbox storeId={id} />;
}
