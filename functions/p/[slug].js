// /p/<slug> — the canonical product URL. Serves public/product.html with
// product-specific <title>, description, social-preview tags and Product
// structured data injected server-side, so search engines and social apps
// see them without running JavaScript.

import db from "../../lib/db";
import { withDb, siteOrigin } from "../../lib/workers";
import { productHeadTags } from "../../lib/seo";

export async function onRequest(context) {
  const { request, env, params } = context;
  const page = await env.ASSETS.fetch(new URL("/product", request.url));
  const data = await withDb(context, async () => {
    const { rows } = await db.query(`SELECT * FROM products WHERE slug = $1 AND status = 'active'`, [params.slug]);
    if (!rows[0]) return null;
    const { rows: r } = await db.query(
      `SELECT count(*)::int AS count, avg(rating)::float AS average FROM reviews
       WHERE product_id = $1 AND source = 'verified' AND status = 'published'`,
      [rows[0].id]
    );
    return { product: rows[0], rating: r[0] };
  });

  const headers = new Headers(page.headers);
  if (!data) return new Response(page.body, { status: 404, headers });

  const url = `${siteOrigin(request)}/p/${encodeURIComponent(data.product.slug)}`;
  const tags = productHeadTags(data.product, url, data.rating);
  headers.set("Cache-Control", "public, max-age=60");
  return new HTMLRewriter()
    .on("title", { element: (el) => el.setInnerContent(tags.title) })
    .on('meta[name="description"]', { element: (el) => el.setAttribute("content", tags.description) })
    .on("head", { element: (el) => el.append(tags.headHtml, { html: true }) })
    .transform(new Response(page.body, { status: 200, headers }));
}
