import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Self-contained server bundle for the Docker image on the Kazakhstan VPS.
  output: "standalone",
  poweredByHeader: false,
  // Native modules / drivers stay external to the bundle.
  serverExternalPackages: ["pg", "@node-rs/argon2"],
};

export default nextConfig;
