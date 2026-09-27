// Shared storefront code: brand settings, cart (localStorage), cart drawer.

const Store = (() => {
  let settings = { name: "", currencySymbol: "$", supportEmail: "" };
  const CART_KEY = "cart.v1";
  const ATTR_KEY = "attr.v1";

  // Remember which ad/campaign brought the shopper (utm_campaign), so the
  // P&L can attribute orders to ads. Last touch, 7-day window.
  function captureAttribution() {
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

  function money(n) {
    return `${settings.currencySymbol}${Number(n).toFixed(2)}`;
  }
  function esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  }

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
  function add(product, quantity = 1) {
    const cart = readCart();
    const line = cart.find((l) => l.id === product.id);
    if (line) line.quantity = Math.min(10, line.quantity + quantity);
    else cart.push({ id: product.id, title: product.title, price: product.price, image: (product.images || [])[0], slug: product.slug, quantity });
    writeCart(cart);
    open();
  }
  function remove(id) {
    writeCart(readCart().filter((l) => l.id !== id));
  }
  function open() {
    document.body.classList.add("cart-open");
  }
  function close() {
    document.body.classList.remove("cart-open");
  }

  function renderCart() {
    const cart = readCart();
    const count = cart.reduce((s, l) => s + l.quantity, 0);
    document.querySelectorAll("[data-cart-count]").forEach((el) => (el.textContent = count));
    const lines = document.getElementById("cart-lines");
    if (!lines) return;
    lines.innerHTML = cart.length
      ? cart
          .map(
            (l) => `<div class="line"><img src="${esc(l.image)}" alt="">
            <div><div class="t">${esc(l.title)}</div><div class="t" style="color:var(--muted)">Qty ${l.quantity}</div>
            <button class="rm" data-rm="${l.id}">Remove</button></div>
            <div class="price">${money(l.price * l.quantity)}</div></div>`
          )
          .join("")
      : `<p class="empty">Your cart is empty.</p>`;
    document.getElementById("cart-total").textContent = money(cart.reduce((s, l) => s + l.price * l.quantity, 0));
    document.getElementById("checkout-btn").disabled = cart.length === 0;
  }

  async function checkout() {
    const btn = document.getElementById("checkout-btn");
    const err = document.getElementById("cart-error");
    btn.disabled = true;
    btn.textContent = "Redirecting…";
    err.textContent = "";
    try {
      const res = await fetch("/api/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items: readCart().map((l) => ({ productId: l.id, quantity: l.quantity })),
          attribution: readAttribution(),
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "Checkout failed");
      location.href = body.url;
    } catch (e) {
      err.textContent = e.message.includes("unavailable")
        ? "An item in your cart just sold out. Please remove it and try again."
        : e.message;
      btn.disabled = false;
      btn.textContent = "Secure checkout";
    }
  }

  const drawerHtml = `
  <div class="drawer-bg" data-close></div>
  <aside class="drawer" aria-label="Cart">
    <header><strong>Your cart</strong><button class="x" data-close aria-label="Close">×</button></header>
    <div class="lines" id="cart-lines"></div>
    <footer>
      <div class="row"><span>Total</span><span id="cart-total"></span></div>
      <p style="color:var(--muted);font-size:13px;margin:0 0 12px">Free tracked shipping. Taxes calculated at checkout.</p>
      <button class="btn" id="checkout-btn">Secure checkout</button>
      <p class="error" id="cart-error"></p>
    </footer>
  </aside>`;

  // ---- AI support chat ----------------------------------------------------
  const CHAT_KEY = "chat.v1";
  const chatHtml = `
  <button class="chat-fab" id="chat-fab" aria-label="Chat with support">Help</button>
  <section class="chat" id="chat" hidden aria-label="Support chat">
    <header><div><strong>Support</strong><div class="chat-sub">AI assistant · a human takes over when needed</div></div>
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
    const intro = `<div class="msg bot">Hi! I'm the ${esc(settings.name || "store")} AI assistant. I can track an order (have your email and order number ready), answer product questions, or pass you to the team.</div>`;
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
    document.body.insertAdjacentHTML("beforeend", drawerHtml);
    document.addEventListener("click", (e) => {
      if (e.target.closest("[data-close]")) close();
      if (e.target.closest("[data-open-cart]")) open();
      const rm = e.target.closest("[data-rm]");
      if (rm) remove(Number(rm.dataset.rm));
    });
    document.getElementById("checkout-btn").addEventListener("click", checkout);
    if (location.hash === "#cart") open();

    try {
      settings = await (await fetch("/api/shop/store")).json();
    } catch {}
    document.querySelectorAll("[data-brand]").forEach((el) => (el.textContent = settings.name));
    document.querySelectorAll("[data-tagline]").forEach((el) => (el.textContent = settings.tagline));
    document.querySelectorAll("[data-support]").forEach((el) => {
      el.textContent = settings.supportEmail;
      if (el.tagName === "A") el.href = `mailto:${settings.supportEmail}`;
    });
    document.querySelectorAll("[data-year]").forEach((el) => (el.textContent = new Date().getFullYear()));
    if (settings.name && !document.title.includes(settings.name)) document.title = `${document.title} · ${settings.name}`;
    renderCart();
    initChat();
  }

  return { init, add, money, esc, readCart, writeCart };
})();
