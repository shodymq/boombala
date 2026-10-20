import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Deployed on Vercel (no custom output). To run in a container later, add `output: "standalone"`.
  poweredByHeader: false,
  // Native modules / drivers stay external to the bundle.
  serverExternalPackages: ["pg", "@node-rs/argon2"],
};

export default nextConfig;
