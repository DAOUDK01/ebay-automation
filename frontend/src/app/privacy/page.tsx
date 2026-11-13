import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = { title: "Privacy Policy – Listing Optimizer" };

export default function PrivacyPage() {
  return (
    <main className="mx-auto max-w-3xl px-4 py-12 text-slate-700">
      <Link href="/login" className="text-sm text-brand-600">
        ← Listing Optimizer
      </Link>
      <h1 className="mt-4 text-3xl font-semibold text-slate-900">Privacy Policy</h1>
      <p className="mt-2 text-sm text-slate-500">Last updated: November 2026</p>

      <div className="mt-8 space-y-6 text-sm leading-6">
        <section>
          <h2 className="text-base font-semibold text-slate-900">What this app does</h2>
          <p>
            Listing Optimizer helps eBay sellers improve their own listings (titles, item specifics, prices and parts
            compatibility). It is used by the store owner to manage their own eBay account.
          </p>
        </section>
        <section>
          <h2 className="text-base font-semibold text-slate-900">Data we access</h2>
          <p>
            When you connect an eBay account, eBay grants the app an access token with the permissions you approve on
            eBay&apos;s consent page. The app uses it to read your active listings and, when you approve or enable it,
            update those listings. It also reads public eBay search results to compare prices.
          </p>
        </section>
        <section>
          <h2 className="text-base font-semibold text-slate-900">Data we store</h2>
          <ul className="list-disc pl-5">
            <li>Your account email, name and a hashed password.</li>
            <li>Your eBay refresh token, stored encrypted (AES-256-GCM).</li>
            <li>Copies of your listing data, suggested changes and a history of changes pushed to eBay.</li>
            <li>Optional item costs you enter, used to keep prices above your margin.</li>
          </ul>
          <p className="mt-2">We do not store eBay buyer data and we do not sell or share your data with third parties.</p>
        </section>
        <section>
          <h2 className="text-base font-semibold text-slate-900">Service providers</h2>
          <p>
            Listing details (titles, specifics, descriptions and competitor prices) are sent to Anthropic&apos;s Claude
            API to generate suggestions. The app is hosted on Vercel and Railway.
          </p>
        </section>
        <section>
          <h2 className="text-base font-semibold text-slate-900">Your choices</h2>
          <p>
            You can disconnect an eBay store at any time in the app (Settings → Disconnect store), which deletes its
            stored data, and you can revoke the app&apos;s access in your eBay account settings.
          </p>
        </section>
      </div>
    </main>
  );
}
