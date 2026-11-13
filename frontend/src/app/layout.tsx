import type { Metadata } from "next";
import { Toaster } from "@/components/toast";
import "./globals.css";

export const metadata: Metadata = {
  title: "Listing Optimizer",
  description: "AI-powered eBay listing optimization",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        {children}
        <Toaster />
      </body>
    </html>
  );
}
