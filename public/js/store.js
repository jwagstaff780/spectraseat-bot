// Shared storefront code: brand settings, site header/footer, cart
// (localStorage, variant-aware, multi-buy pricing preview), cart drawer,
// attribution capture and the AI support chat. Prices shown here are a
// preview — the server recalculates everything at checkout.

const Store = (() => {
  let settings = { name: "", currencySymbol: "$", supportEmail: "", tagline: "" };
  const CART_KEY = "cart.v2";
  const ATTR_KEY = "attr.v1";

  function money(n) {
    return `${settings.currencySymbol || "$"}${Number(n).toFixed(2)}`;
  }
  function esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  }
  function productUrl(slug) {
    return `/p/${encodeURIComponent(slug)}`;
  }

  // ---- consent (UK GDPR / PECR) ----------------------------------------------
  // The cart uses strictly necessary storage (no consent needed). Ad
  // attribution and sharing purchases with Meta are optional and only happen
  // after "Accept".
  const CONSENT_KEY = "consent.v1";
  function consent() {
    try {
      return localStorage.getItem(CONSENT_KEY);
    } catch {
      return null;
    }
  }
  function setConsent(value) {
    try {
      localStorage.setItem(CONSENT_KEY, value);
      if (value !== "granted") localStorage.removeItem(ATTR_KEY);
    } catch {}
    const b = document.getElementById("consent");
    if (b) b.remove();
    if (value === "granted") captureAttribution();
  }
  function showConsent() {
    if (document.getElementById("consent")) return;
    document.body.insertAdjacentHTML(
      "beforeend",
      `<div class="consent" id="consent" role="dialog" aria-label="Cookie choices">
        <p>We use essential storage to run your basket. With your permission we'd also like to measure which adverts bring
        you here and share purchase events with Meta, which helps keep prices low. <a href="/policies.html#privacy">Privacy policy</a></p>
        <div class="row"><button class="btn" data-consent="granted">Accept</button><button class="btn ghost" data-consent="denied">Reject</button></div>
      </div>`
    );
  }

  // ---- attribution (utm_campaign, last touch, 7 days) ----------------------
  function captureAttribution() {
    if (consent() !== "granted") return;
    const c = new URLSearchParams(location.search).get("utm_campaign");
    if (!c) return;
    try {
      localStorage.setItem(ATTR_KEY, JSON.stringify({ c: c.slice(0, 100), t: Date.now() }));
    } catch {}
  }
  function readAttribution() {
    try {
      const a = JSON.parse(localStorage.getItem(ATTR_KEY));
      return a && Date.now() - a.t < 7 * 86400000 ? a.c : null;
    } catch {
      return null;
    }
  }

  // ---- cart ------------------------------------------------------------------
  function readCart() {
    try {
      return JSON.parse(localStorage.getItem(CART_KEY)) || [];
    } catch {
      return [];
    }
  }
  function writeCart(cart) {
    try {
      localStorage.setItem(CART_KEY, JSON.stringify(cart));
    } catch {}
    renderCart();
  }
  // Mirror of the server's multi-buy rule (lib/pricing.js) for display.
  function tierFor(qtyDiscounts, qty) {
    return (qtyDiscounts || []).filter((t) => qty >= t.minQty).sort((a, b) => b.pct - a.pct)[0] || null;
  }
  function priced(cart) {
    const qtyByProduct = {};
    for (const l of cart) qtyByProduct[l.id] = (qtyByProduct[l.id] || 0) + l.quantity;
    return cart.map((l) => {
      const tier = tierFor(l.qtyDiscounts, qtyByProduct[l.id]);
      const unit = tier ? Math.round(l.price * (1 - tier.pct / 100) * 100) / 100 : l.price;
      return { ...l, unit, tier };
    });
  }
  function add(product, variant, quantity = 1) {
    const cart = readCart();
    const key = `${product.id}:${variant ? variant.id : ""}`;
    const line = cart.find((l) => l.key === key);
    if (line) line.quantity = Math.min(10, line.quantity + quantity);
    else
      cart.push({
        key,
        id: product.id,
        variantId: variant ? variant.id : null,
        variantName: variant && variant.name ? variant.name : "",
        title: product.title,
        price: product.price,
        qtyDiscounts: product.qtyDiscounts || [],
        image: (variant && variant.image) || (product.images || [])[0],
        slug: product.slug,
        quantity,
      });
    writeCart(cart);
    open();
  }
  function setQty(key, qty) {
    const cart = readCart()
      .map((l) => (l.key === key ? { ...l, quantity: Math.max(0, Math.min(10, qty)) } : l))
      .filter((l) => l.quantity > 0);
    writeCart(cart);
  }
  function open() {
    document.body.classList.add("cart-open");
  }
  function close() {
    document.body.classList.remove("cart-open");
  }

  function renderCart() {
    const cart = priced(readCart());
    const count = cart.reduce((s, l) => s + l.quantity, 0);
    document.querySelectorAll("[data-cart-count]").forEach((el) => (el.textContent = count));
    const lines = document.getElementById("cart-lines");
    if (!lines) return;
    const total = cart.reduce((s, l) => s + l.unit * l.quantity, 0);
    const saved = cart.reduce((s, l) => s + (l.price - l.unit) * l.quantity, 0);
    lines.innerHTML = cart.length
      ? cart
          .map(
            (l) => `<div class="line"><img src="${esc(l.image)}" alt="">
            <div><a class="t" href="${productUrl(l.slug)}">${esc(l.title)}</a>
              ${l.variantName ? `<div class="t muted">${esc(l.variantName)}</div>` : ""}
              <div class="qty qty-sm"><button data-q="${esc(l.key)}" data-d="-1" aria-label="Decrease">−</button><span>${l.quantity}</span><button data-q="${esc(l.key)}" data-d="1" aria-label="Increase">+</button></div>
            </div>
            <div class="price">${money(l.unit * l.quantity)}${l.tier ? `<div class="save">−${l.tier.pct}% multi-buy</div>` : ""}</div></div>`
          )
          .join("")
      : `<p class="empty">Your cart is empty.</p>`;
    document.getElementById("cart-total").textContent = money(total);
    document.getElementById("cart-saved").textContent = saved > 0 ? `You're saving ${money(saved)}` : "";
    const nudge = cart.find((l) => (l.qtyDiscounts || []).some((t) => t.minQty > cart.filter((x) => x.id === l.id).reduce((s, x) => s + x.quantity, 0)));
    if (nudge) {
      const have = cart.filter((x) => x.id === nudge.id).reduce((s, x) => s + x.quantity, 0);
      const next = nudge.qtyDiscounts.filter((t) => t.minQty > have).sort((a, b) => a.minQty - b.minQty)[0];
      document.getElementById("cart-nudge").textContent = `Add ${next.minQty - have} more ${nudge.title} to save ${next.pct}%.`;
    } else document.getElementById("cart-nudge").textContent = "";
    document.getElementById("checkout-btn").disabled = cart.length === 0;
  }

  async function checkout() {
    const btn = document.getElementById("checkout-btn");
    const err = document.getElementById("cart-error");
    btn.disabled = true;
    btn.textContent = "Redirecting to secure checkout…";
    err.textContent = "";
    try {
      const res = await fetch("/api/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items: readCart().map((l) => ({ productId: l.id, variantId: l.variantId, quantity: l.quantity })),
          attribution: consent() === "granted" ? readAttribution() : null,
          adConsent: consent() === "granted",
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "Checkout failed");
      location.href = body.url;
    } catch (e) {
      err.textContent = /unavailable/.test(e.message)
        ? "An item in your cart just sold out. Please remove it and try again."
        : e.message;
      btn.disabled = false;
      btn.textContent = "Secure checkout";
    }
  }

  const drawerHtml = `
  <div class="drawer-bg" data-close></div>
  <aside class="drawer" aria-label="Cart">
    <header><strong>Your cart</strong><button class="x" data-close aria-label="Close cart">×</button></header>
    <div class="lines" id="cart-lines"></div>
    <footer>
      <p class="nudge" id="cart-nudge"></p>
      <div class="row"><span>Total</span><span id="cart-total"></span></div>
      <p class="saved" id="cart-saved"></p>
      <p class="muted small">Free tracked shipping · 30-day returns · Taxes and discount codes at checkout</p>
      <button class="btn btn-block" id="checkout-btn">Secure checkout</button>
      <p class="error" id="cart-error" role="alert"></p>
    </footer>
  </aside>`;

  // ---- header / footer (shared by every page) -------------------------------
  function headerHtml() {
    return `<div class="wrap"><a class="logo" href="/" data-brand>${esc(settings.name)}</a>
      <nav class="nav" aria-label="Main">
        <a href="/#shop">Shop</a><a href="/blog.html">Guides</a><a href="/track.html">Track order</a>
        <button class="cart-btn" data-open-cart aria-label="Open cart">Cart <b data-cart-count>0</b></button>
      </nav></div>`;
  }
  function footerHtml() {
    const legal = [settings.businessName, settings.businessAddress].filter(Boolean).map(esc).join(" · ");
    return `<div class="wrap footer-grid">
      <div><strong data-brand>${esc(settings.name)}</strong><p class="muted small">${esc(settings.tagline || "")}</p>
        <p class="muted small">Secure checkout by Stripe · Free tracked shipping · 30-day returns</p></div>
      <div><strong>Shop</strong><a href="/#shop">All products</a><a href="/blog.html">Guides</a><a href="/track.html">Track your order</a></div>
      <div><strong>Help</strong><a href="/faq.html">FAQ</a><a href="/contact.html">Contact us</a><a href="/policies.html#shipping">Shipping</a><a href="/policies.html#returns">Returns &amp; refunds</a></div>
      <div><strong>Company</strong><a href="/about.html">About</a><a href="/terms.html">Terms of service</a><a href="/policies.html#privacy">Privacy</a><a href="#" data-cookie-settings>Cookie settings</a></div>
    </div>
    <div class="wrap legal muted small">© ${new Date().getFullYear()} ${esc(settings.name)}${legal ? ` · ${legal}` : ""}</div>`;
  }
  // ---- AI support chat ----------------------------------------------------
  const CHAT_KEY = "chat.v1";
  const chatHtml = `
  <button class="chat-fab" id="chat-fab" aria-label="Chat with support">Help</button>
  <section class="chat" id="chat" hidden aria-label="Support chat">
    <header><div><strong>Nova · Support</strong><div class="chat-sub">AI assistant · a human takes over when needed</div></div>
      <button class="x" id="chat-close" aria-label="Close">×</button></header>
    <div class="chat-log" id="chat-log"></div>
    <form id="chat-form"><input id="chat-input" autocomplete="off" maxlength="1000" placeholder="Ask about an order or product…" required>
      <button class="btn">Send</button></form>
  </section>`;
  function chatHistory() {
    try {
      return JSON.parse(sessionStorage.getItem(CHAT_KEY)) || [];
    } catch {
      return [];
    }
  }
  function saveChat(h) {
    try {
      sessionStorage.setItem(CHAT_KEY, JSON.stringify(h.slice(-20)));
    } catch {}
  }
  function renderChat(h, pending) {
    const log = document.getElementById("chat-log");
    const intro = `<div class="msg bot">Hi! I'm Nova, ${esc(settings.name || "the store")}'s AI assistant. I can track an order (have your email and order number ready), answer product questions, or pass you to the team.</div>`;
    log.innerHTML = intro + h.map((m) => `<div class="msg ${m.role === "user" ? "me" : "bot"}">${esc(m.content)}</div>`).join("") +
      (pending ? '<div class="msg bot">…</div>' : "");
    log.scrollTop = log.scrollHeight;
  }
  function initChat() {
    document.body.insertAdjacentHTML("beforeend", chatHtml);
    const panel = document.getElementById("chat");
    document.getElementById("chat-fab").onclick = () => {
      panel.hidden = !panel.hidden;
      renderChat(chatHistory());
      if (!panel.hidden) document.getElementById("chat-input").focus();
    };
    document.getElementById("chat-close").onclick = () => (panel.hidden = true);
    document.getElementById("chat-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const input = document.getElementById("chat-input");
      const text = input.value.trim();
      if (!text) return;
      input.value = "";
      const h = [...chatHistory(), { role: "user", content: text }];
      saveChat(h);
      renderChat(h, true);
      try {
        const res = await fetch("/api/shop/support", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messages: h }),
        });
        const body = await res.json();
        h.push({ role: "assistant", content: body.reply || body.error || "Sorry, something went wrong." });
      } catch {
        h.push({ role: "assistant", content: `Sorry, I'm having trouble. Please email ${settings.supportEmail}.` });
      }
      saveChat(h);
      renderChat(h);
    });
  }

  async function init() {
    captureAttribution();
    try {
      settings = await (await fetch("/api/shop/store")).json();
    } catch {}
    const header = document.querySelector("header.site");
    if (header) header.innerHTML = headerHtml();
    const footer = document.querySelector("footer.site");
    if (footer) footer.innerHTML = footerHtml();
    document.body.insertAdjacentHTML("beforeend", drawerHtml);
    document.addEventListener("click", (e) => {
      if (e.target.closest("[data-close]")) close();
      if (e.target.closest("[data-open-cart]")) open();
      const c = e.target.closest("[data-consent]");
      if (c) setConsent(c.dataset.consent);
      if (e.target.closest("[data-cookie-settings]")) {
        e.preventDefault();
        showConsent();
      }
      const q = e.target.closest("[data-q]");
      if (q) {
        const line = readCart().find((l) => l.key === q.dataset.q);
        if (line) setQty(line.key, line.quantity + Number(q.dataset.d));
      }
    });
    document.addEventListener("keydown", (e) => e.key === "Escape" && close());
    document.getElementById("checkout-btn").addEventListener("click", checkout);
    if (location.hash === "#cart") open();
    document.querySelectorAll("[data-brand]").forEach((el) => (el.textContent = settings.name));
    document.querySelectorAll("[data-tagline]").forEach((el) => (el.textContent = settings.tagline));
    document.querySelectorAll("[data-support]").forEach((el) => {
      el.textContent = settings.supportEmail;
      if (el.tagName === "A") el.href = `mailto:${settings.supportEmail}`;
    });
    document.querySelectorAll("[data-business]").forEach((el) => {
      el.textContent = [settings.businessName, settings.businessAddress].filter(Boolean).join(", ") || settings.name;
    });
    if (settings.name && !document.title.includes(settings.name)) document.title = `${document.title} · ${settings.name}`;
    renderCart();
    initChat();
    if (!consent()) showConsent();
  }

  return { init, add, money, esc, readCart, writeCart, productUrl, settings: () => settings, tierFor };
})();
