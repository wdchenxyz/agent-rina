import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  webpack: (config, { isServer }) => {
    if (isServer) {
      // just-bash → @mongodb-js/zstd tries to resolve native .node addons
      // that aren't built on Vercel. Mark the package as external to suppress
      // the "Module not found" warnings.
      config.externals = config.externals || [];
      config.externals.push("@mongodb-js/zstd");
    }
    return config;
  },
};

export default nextConfig;
