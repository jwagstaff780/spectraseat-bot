const stripe = require("../../lib/stripe");
const fulfilment = require("../../lib/fulfilment");
const meta = require("../../lib/ads/meta");
const { methodNotAllowed, serverError, readRawBody } = require("../../lib/http");

// POST /api/webhooks/stripe — point a Stripe webhook endpoint here for
// `checkout.session.completed`, `checkout.session.async_payment_succeeded`
// and `checkout.session.expired` (abandoned-cart recovery).
// Records the order, emails the customer and places the supplier order
// immediately; the fulfilment cron retries anything that fails here.
module.exports = async (req, res) => {
  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);
  try {
    const raw = await readRawBody(req);
    if (!stripe.verifyWebhook(raw, req.headers["stripe-signature"], process.env.STRIPE_WEBHOOK_SECRET)) {
      return res.status(400).json({ error: "bad signature" });
    }
    const event = JSON.parse(raw);
    const session = event.data && event.data.object;

    if (event.type === "checkout.session.expired") {
      return res.status(200).json(await fulfilment.recoverCheckout(session));
    }

    const paidEvent =
      event.type === "checkout.session.async_payment_succeeded" ||
      (event.type === "checkout.session.completed" && session.payment_status === "paid");
    if (!paidEvent) return res.status(200).json({ ignored: event.type });

    const { order, created } = await fulfilment.recordPaidOrder(session);
    // Best-effort side effects: failures here are retried by the cron, and
    // we still return 200 so Stripe doesn't redeliver an already-recorded order.
    const tasks = [fulfilment.sendConfirmation(order), fulfilment.placeOrder(order.id)];
    // Report the sale to Meta (Conversions API) so the ads agent's numbers are real.
    if (created) tasks.push(meta.sendPurchase(order));
    const results = await Promise.allSettled(tasks);
    results.filter((r) => r.status === "rejected").forEach((r) => console.error(r.reason));

    res.status(200).json({ orderId: order.id, created });
  } catch (err) {
    serverError(res, err);
  }
};
