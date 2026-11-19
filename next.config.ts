import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: { serverActions: { bodySizeLimit: "256kb" } },
  serverExternalPackages: ["pg"],
};

export default nextConfig;
