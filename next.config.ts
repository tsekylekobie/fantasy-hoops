import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Lets a second dev server run from the same checkout without the two
  // overwriting each other's build output (e.g. NEXT_DIST_DIR=.next-2).
  distDir: process.env.NEXT_DIST_DIR || ".next",
  images: {
    remotePatterns: [{ protocol: "https", hostname: "cdn.nba.com", pathname: "/headshots/**" }],
  },
};

export default nextConfig;
