/** @type {import('next').NextConfig} */
const backend = process.env.BACKEND_URL || "http://localhost:4100";

const nextConfig = {
  reactStrictMode: true,
  // All /api calls are proxied to the Express backend, so the auth cookie is same-origin.
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${backend}/api/:path*` }];
  },
  images: { unoptimized: true },
};

export default nextConfig;
