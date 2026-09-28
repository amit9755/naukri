import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["playwright-core", "@sparticuz/chromium-min"],
  outputFileTracingIncludes: {
    // Playwright loads this dynamically; automatic tracing misses it.
    "/api/test-browser": ["./node_modules/playwright-core/browsers.json"],
    "/api/test-naukri": ["./node_modules/playwright-core/browsers.json"],
  },
};

export default nextConfig;
