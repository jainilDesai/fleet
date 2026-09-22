// API list prices in USD per million tokens. Claude Code on a Pro/Max plan is not billed
// per token, so every cost Fleet shows is an "API-equivalent" estimate, not a bill.
// cacheRead defaults to 10% of input; cache writes are 1.25x (5 min) and 2x (1 hour).
const PRICES = [
  { match: /fable|mythos/, input: 10, output: 50, cacheRead: 0.25 },
  { match: /opus-5-5/, input: 4, output: 20, cacheRead: 0.2 },
  { match: /opus-(5|4-[5-9])/, input: 5, output: 25 },
  { match: /opus/, input: 15, output: 75 },
  { match: /sonnet-5/, input: 2, output: 10 },
  { match: /sonnet/, input: 3, output: 15 },
  { match: /haiku-4/, input: 1, output: 5 },
  { match: /haiku/, input: 0.8, output: 4 },
];

export function priceFor(model = '') {
  const p = PRICES.find((row) => row.match.test(model)) ?? PRICES[2];
  return { ...p, cacheRead: p.cacheRead ?? p.input * 0.1 };
}

// usage: the `usage` object Claude Code writes on each assistant message
export function costOf(model, u) {
  const p = priceFor(model);
  const write1h = u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  const write5m = (u.cache_creation_input_tokens ?? 0) - write1h;
  return (
    ((u.input_tokens ?? 0) * p.input +
      (u.output_tokens ?? 0) * p.output +
      (u.cache_read_input_tokens ?? 0) * p.cacheRead +
      write5m * p.input * 1.25 +
      write1h * p.input * 2) /
    1e6
  );
}

// Totals from stats-cache.json `modelUsage` use camelCase and have no 5m/1h split.
export function costOfTotals(model, t) {
  return costOf(model, {
    input_tokens: t.inputTokens,
    output_tokens: t.outputTokens,
    cache_read_input_tokens: t.cacheReadInputTokens,
    cache_creation_input_tokens: t.cacheCreationInputTokens,
  });
}

export function contextWindow(model = '') {
  return /haiku/.test(model) ? 200_000 : 1_000_000;
}

export function modelFamily(model = '') {
  for (const f of ['fable', 'mythos', 'opus', 'sonnet', 'haiku']) if (model.includes(f)) return f;
  return model || 'unknown';
}
