// Models a daemon may think with, at the posted rate (= what obol pays, no fee on inference), USDG per 1M tokens.
// worst = the most one call can cost: a full prompt in, a full answer out — `max` on the step must cover it.
export const MODELS = {
  qwen: { id: "@cf/qwen/qwen3-30b-a3b-fp8", in: 0.051, out: 0.335, maxIn: 6000, maxOut: 600 },
};
export const worstCost = (m) => (m.maxIn * m.in + m.maxOut * m.out) / 1e6;
