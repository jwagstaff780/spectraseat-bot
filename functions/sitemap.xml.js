// /sitemap.xml — every live product, guide and core page, for search engines.
import db from "../lib/db";
import { withDb, siteOrigin } from "../lib/workers";

const PAGES = ["/", "/blog", "/about", "/faq", "/contact", "/track", "/policies", "/terms"];
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");

export async function onRequest(context) {
  const origin = siteOrigin(context.request);
  const { products, articles } = await withDb(context, async () => ({
    products: (await db.query(`SELECT slug, updated_at FROM products WHERE status = 'active' ORDER BY id`)).rows,
    articles: (await db.query(`SELECT slug, published_at FROM content WHERE kind = 'blog' AND status = 'published' ORDER BY id`)).rows,
  }));
  const urls = [
    ...PAGES.map((p) => `<url><loc>${origin}${p}</loc></url>`),
    ...products.map((p) => `<url><loc>${esc(`${origin}/p/${encodeURIComponent(p.slug)}`)}</loc><lastmod>${new Date(p.updated_at).toISOString().slice(0, 10)}</lastmod></url>`),
    ...articles.map((a) => `<url><loc>${esc(`${origin}/blog?slug=${encodeURIComponent(a.slug)}`)}</loc><lastmod>${new Date(a.published_at).toISOString().slice(0, 10)}</lastmod></url>`),
  ];
  return new Response(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>\n`, {
    headers: { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": "public, max-age=3600" },
  });
}
