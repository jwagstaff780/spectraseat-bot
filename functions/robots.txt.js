// /robots.txt — crawl the shop, not the admin/API/one-off pages.
import { exposeEnv, siteOrigin } from "../lib/workers";

export async function onRequest(context) {
  exposeEnv(context.env);
  const body = [
    "User-agent: *",
    "Allow: /",
    "Disallow: /admin",
    "Disallow: /api/",
    "Disallow: /review",
    "Disallow: /success",
    `Sitemap: ${siteOrigin(context.request)}/sitemap.xml`,
    "",
  ].join("\n");
  return new Response(body, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
}
