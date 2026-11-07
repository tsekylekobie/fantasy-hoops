// Web app manifest (/manifest.webmanifest). iPhones and iPads only allow web
// push from a site added to the Home Screen, and need this for it.
import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Fantasy Hoops",
    short_name: "Hoops",
    description: "Our 9-category fantasy basketball league",
    start_url: "/my-team",
    scope: "/",
    display: "standalone",
    background_color: "#ffffff",
    theme_color: "#ffffff",
    icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml" }],
  };
}
