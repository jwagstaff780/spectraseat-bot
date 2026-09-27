// Shared Claude access for every agent. Agents use it to *write* (copy,
// ads, articles, reports, support replies). Anything that moves money —
// ad budgets, refunds, pausing products — is decided by deterministic,
// capped rules elsewhere, never by model output alone.

const Anthropic = require("@anthropic-ai/sdk");
const config = require("./config");

let client = null;
function getClient() {
  if (!client) client = new Anthropic();
  return client;
}

function enabled() {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

// Base request options: default model with server-side refusal fallback.
function baseRequest(extra) {
  return {
    model: config.AI_MODEL,
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    ...extra,
  };
}

// One structured-output call. Returns the parsed object, or null if the
// model refused / was cut off / AI is not configured.
async function generateJson({ system, prompt, schema, effort = "low" }) {
  if (!enabled()) return null;
  const response = await getClient().beta.messages.create(
    baseRequest({
      output_config: { effort, format: { type: "json_schema", schema } },
      system,
      messages: [{ role: "user", content: prompt }],
    })
  );
  if (response.stop_reason === "refusal" || response.stop_reason === "max_tokens") return null;
  const text = response.content.find((b) => b.type === "text");
  return text ? JSON.parse(text.text) : null;
}

module.exports = { getClient, enabled, baseRequest, generateJson };
