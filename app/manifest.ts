import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Treat Health Expenses",
    short_name: "Expenses",
    start_url: "/",
    display: "standalone",
    background_color: "#0d0d0d",
    theme_color: "#0d0d0d",
    icons: [
      {
        src:
          "data:image/svg+xml," +
          encodeURIComponent(
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 192 192"><rect width="192" height="192" rx="36" fill="#2a78d6"/><text x="96" y="130" font-size="110" text-anchor="middle" fill="white" font-family="sans-serif" font-weight="700">$</text></svg>'
          ),
        sizes: "192x192",
        type: "image/svg+xml",
      },
    ],
  };
}
