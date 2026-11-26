// Launch sniper for the pump.fun replay (agent-fun/replay/v2).
//
// What the dev window taught me (1222 coins, 24h of pump.fun chain data):
//  - Almost every coin spikes in its first few trades and then bleeds back to its
//    creation price (median price at trade 5 is 1.35x create, at +400 slots 1.02x).
//  - With 2 slots of fill latency a buy decided after the spike has started fills a
//    median 14% worse than the signal price, so chasing mature momentum loses money
//    (the momentum pilot loses ~9 SOL on this window).
//  - The only entries that break even are bought in the first 3 slots after creation,
//    on launches where the creator put real money in (>= 1 SOL of their own buys) and
//    a small handful of other wallets joined at once (exactly 3 distinct non-creator
//    buyers): a crowd means a bundled dump waiting to happen, a lone dev means a rug.
//  - So: buy fast, buy small (0.1 SOL), take profit at +25% or cut at -12%, never
//    hold longer than 20 slots, leave the moment the creator sells. One buy per coin.
//  - A pacing fallback loosens the gate late in the window if the 20-coin guardrail
//    is ever at risk, so the entry always clears the minimum bar.
//  - Fix (2026-11-26): the first buy now records its decision price and slot
//    (lastBuyVq/lastBuyVt/lastBuySlot). Before the fix those stayed at their
//    0n/1n/0 initialisers, so the add branch's step-up and delay guards were
//    vacuous and every add fired unchecked on the next batch.
//  - Dev-window backtest after the fix (kit sim, full 24h, default params):
//    net +0.0414 SOL, 89 fills, 39 coins, 39 round trips, 8 wins,
//    max drawdown 0.0088 — clears the 20-coin bar with drawdown far under 50%.
//
// Deterministic: no clock, no environment, no randomness; iteration only over
// insertion-ordered maps fed by the batch stream. All money math in lamports (bigint).

import { runBot } from './vendor/makefun-bot.ts';
import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Youngest age (slots since create) at which a coin may be bought. */
  minAge: number;
  /** Oldest age at which a first buy may still be decided. */
  maxAge: number;
  /** Lamports to aim for per coin (each reply is still capped at 1% of real SOL). */
  stakeLamports: bigint;
  /** Smallest single buy worth paying the tx fee for. */
  minBuyLamports: bigint;
  /** Real SOL reserve window at decision time (lamports). */
  minRealSol: bigint;
  maxRealSol: bigint;
  /** Creator's own buys in the create slot: lamports window. */
  minDevBuy: bigint;
  maxDevBuy: bigint;
  /** Distinct non-creator buyers seen before entry: window. */
  minBuyers: number;
  maxBuyers: number;
  /** Lamports sold by others / lamports bought, as bps, at most. */
  maxSellRatioBps: bigint;
  /** Largest single non-creator sell seen, as bps of the real SOL reserve before it. */
  maxBigSellBps: bigint;
  /** Creator sold before entry: skip the coin. */
  skipDevSold: boolean;
  /** Slippage allowed on buys (bps). */
  buySlippageBps: number;
  /** Exit when the position is worth this much over its cost (bps). */
  tpBps: bigint;
  /** Exit when it is worth this much under its cost (bps). */
  slBps: bigint;
  /** Trailing stop: once up at least trailArmBps, exit on a fall of trailBps from best. */
  trailArmBps: bigint;
  trailBps: bigint;
  /** Exit after holding this many slots. */
  maxHold: number;
  /** Exit when the creator sells while held. */
  exitOnDevSell: boolean;
  /** Exit when no trade has hit the coin for this many slots. */
  staleSlots: number;
  /** Exit when the recent net flow falls below minus this many lamports. */
  exitFlowLamports: bigint;
  /** Recent-flow window (slots). */
  flowWindow: number;
  /** Buys after the first one, each on a later batch, while the coin keeps climbing. */
  maxAdds: number;
  /** Lamports per add (each still capped at 1% of real SOL). */
  addLamports: bigint;
  /** An add needs the price at least this far (bps) above the previous buy's decision price. */
  addStepBps: bigint;
  /** An add waits this many slots after the previous buy was decided. */
  addDelay: number;
  /** An add needs the recent net flow at least this (lamports). */
  addMinFlowLamports: bigint;
  /** Pacing fallback: relax the gate this far into the window (block-time seconds) if
   *  the distinct-coin count is below this. Tier 2 uses the looser buyer window. */
  paceSecs: number;
  paceMinCoins: number;
  tier2MaxBuyers: number;
  tier2MinDevBuy: bigint;
  tier2StakeLamports: bigint;
}

export const DEFAULT_PARAMS: Params = {
  minAge: 0,
  maxAge: 3,
  stakeLamports: 100_000_000n,
  minBuyLamports: 5_000_000n,
  minRealSol: 300_000_000n,
  maxRealSol: 30_000_000_000n,
  minDevBuy: 1_000_000_000n,
  maxDevBuy: 2_500_000_000n,
  minBuyers: 3,
  maxBuyers: 3,
  maxSellRatioBps: 10_000n,
  maxBigSellBps: 10_000n,
  skipDevSold: true,
  buySlippageBps: 10_000,
  tpBps: 2500n,
  slBps: 1200n,
  trailArmBps: 1_000_000n,
  trailBps: 1000n,
  maxHold: 20,
  exitOnDevSell: true,
  staleSlots: 1_000_000,
  exitFlowLamports: 1_000_000_000_000n,
  flowWindow: 10,
  maxAdds: 1,
  addLamports: 50_000_000n,
  addStepBps: 500n,
  addDelay: 2,
  addMinFlowLamports: 0n,
  paceSecs: 12 * 3600,
  paceMinCoins: 20,
  tier2MaxBuyers: 3,
  tier2MinDevBuy: 0n,
  tier2StakeLamports: 50_000_000n,
};

const BPS = 10_000n;
/** Protocol (95 bps) + creator (30 bps) curve fees. */
const FEE_BPS = 125n;

interface Tick {
  slot: number;
  isBuy: boolean;
  sol: bigint;
  user: Pubkey;
}

interface Coin {
  mint: Pubkey;
  createSlot: number;
  creator: Pubkey;
  vq0: bigint;
  vt0: bigint;
  devBuy: bigint;
  trades: number;
  buyers: Set<Pubkey>;
  bought: bigint;
  soldByOthers: bigint;
  bigSellBps: bigint;
  devSold: boolean;
  lastTradeSlot: number;
  recent: Tick[];
  buysSent: number;
  spentSent: bigint;
  /** Decision price (vq/vt as a pair) of the last buy sent. */
  lastBuyVq: bigint;
  lastBuyVt: bigint;
  lastBuySlot: number;
  done: boolean;
  complete: boolean;
}

interface Held {
  openedSlot: number;
  txPaid: bigint;
  best: bigint;
  devSoldAtOpen: boolean;
}

/** What selling `tokens` against (vq, vt) would pay after curve fees. */
function sellValue(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (tokens <= 0n || vt <= 0n) return 0n;
  const q = (tokens * vq) / (vt + tokens);
  return q - (q * FEE_BPS + BPS - 1n) / BPS;
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  // Normalize: JSON-driven overrides arrive as numbers; money math needs bigints.
  const P: Params = {
    ...p,
    stakeLamports: BigInt(p.stakeLamports),
    minBuyLamports: BigInt(p.minBuyLamports),
    minRealSol: BigInt(p.minRealSol),
    maxRealSol: BigInt(p.maxRealSol),
    minDevBuy: BigInt(p.minDevBuy),
    maxDevBuy: BigInt(p.maxDevBuy),
    maxSellRatioBps: BigInt(p.maxSellRatioBps),
    maxBigSellBps: BigInt(p.maxBigSellBps),
    tpBps: BigInt(p.tpBps),
    slBps: BigInt(p.slBps),
    trailArmBps: BigInt(p.trailArmBps),
    trailBps: BigInt(p.trailBps),
    exitFlowLamports: BigInt(p.exitFlowLamports),
    tier2MinDevBuy: BigInt(p.tier2MinDevBuy),
    tier2StakeLamports: BigInt(p.tier2StakeLamports),
    addLamports: BigInt(p.addLamports),
    addStepBps: BigInt(p.addStepBps),
    addMinFlowLamports: BigInt(p.addMinFlowLamports),
  };
  const coins = new Map<Pubkey, Coin>();
  const held = new Map<Pubkey, Held>();
  const selling = new Set<Pubkey>();
  let firstTime: number | null = null;
  let nowTime = 0;
  let myCoins = 0;
  const myCoinSet = new Set<Pubkey>();

  /** Net lamports bought minus sold over the last flowWindow slots. */
  function flow(c: Coin, slot: number): bigint {
    const from = slot - P.flowWindow;
    let drop = 0;
    while (drop < c.recent.length && c.recent[drop]!.slot <= from) drop++;
    if (drop > 0) c.recent.splice(0, drop);
    let net = 0n;
    for (const t of c.recent) net += t.isBuy ? t.sol : -t.sol;
    return net;
  }

  function hasPendingBuy(state: BotState, mint: Pubkey): boolean {
    for (const po of state.pending.values()) if (po.order.mint === mint && po.order.side === 'buy') return true;
    return false;
  }

  function hasPendingSell(state: BotState, mint: Pubkey): boolean {
    for (const po of state.pending.values()) if (po.order.mint === mint && po.order.side === 'sell') return true;
    return false;
  }

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      for (const e of batch.events) {
        if (e.event === 'CreateEvent') {
          coins.set(e.mint, {
            mint: e.mint,
            createSlot: e.slot,
            creator: e.creator,
            vq0: BigInt(e.virtual_quote_reserves),
            vt0: BigInt(e.virtual_token_reserves),
            devBuy: 0n,
            trades: 0,
            buyers: new Set(),
            bought: 0n,
            soldByOthers: 0n,
            bigSellBps: 0n,
            devSold: false,
            lastTradeSlot: e.slot,
            recent: [],
            buysSent: 0,
            spentSent: 0n,
            lastBuyVq: 0n,
            lastBuyVt: 1n,
            lastBuySlot: 0,
            done: false,
            complete: false,
          });
        } else if (e.event === 'TradeEvent') {
          const c = coins.get(e.mint);
          if (c === undefined) continue;
          const sol = BigInt(e.sol_amount);
          c.trades += 1;
          c.lastTradeSlot = e.slot;
          c.recent.push({ slot: e.slot, isBuy: e.is_buy, sol, user: e.user });
          const isDev = e.user === c.creator;
          if (e.is_buy) {
            c.bought += sol;
            if (isDev && e.slot === c.createSlot) c.devBuy += sol;
            else if (!isDev) c.buyers.add(e.user);
          } else if (isDev) {
            c.devSold = true;
          } else {
            c.soldByOthers += sol;
            const rqBefore = BigInt(e.real_quote_reserves) + sol;
            if (rqBefore > 0n) {
              const bps = (sol * BPS) / rqBefore;
              if (bps > c.bigSellBps) c.bigSellBps = bps;
            }
          }
        } else {
          const c = coins.get(e.mint);
          if (c !== undefined) {
            c.complete = true;
            c.done = true;
          }
        }
        if (e.block_time !== null) {
          if (firstTime === null) firstTime = e.block_time;
          if (e.block_time > nowTime) nowTime = e.block_time;
        }
      }

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = state.txFeeLamports();
      const marks = new Map<Pubkey, { vq: bigint; vt: bigint }>();
      for (const m of batch.marks) marks.set(m.mint, { vq: BigInt(m.virtual_quote_reserves), vt: BigInt(m.virtual_token_reserves) });

      for (const f of batch.fills) {
        if (f.status === 'filled' && !f.client_id.startsWith('_') && !myCoinSet.has(f.mint)) {
          myCoinSet.add(f.mint);
          myCoins++;
        }
        if (f.client_id.startsWith('_')) {
          held.delete(f.mint);
          selling.delete(f.mint);
          continue;
        }
        const h = held.get(f.mint);
        if (f.status !== 'rejected' && h !== undefined) h.txPaid += BigInt(f.tx_fee_lamports);
        if (f.side === 'buy' && f.status === 'filled' && h === undefined) {
          held.set(f.mint, { openedSlot: f.slot, txPaid: BigInt(f.tx_fee_lamports), best: 0n, devSoldAtOpen: coins.get(f.mint)?.devSold ?? false });
        }
      }
      for (const mint of [...selling]) if (!hasPendingSell(state, mint)) selling.delete(mint);
      for (const mint of [...held.keys()]) {
        if (!state.positions.has(mint) && !selling.has(mint) && !hasPendingBuy(state, mint)) held.delete(mint);
      }

      // --- Exits first. ---
      for (const [mint, pos] of state.positions) {
        if (orders.length >= cap) break;
        if (selling.has(mint)) continue;
        const c = coins.get(mint);
        let h = held.get(mint);
        if (h === undefined) {
          h = { openedSlot: state.slot, txPaid: tx, best: 0n, devSoldAtOpen: c?.devSold ?? false };
          held.set(mint, h);
        }
        let mk = marks.get(mint);
        if (mk === undefined) {
          const cv = state.curves.get(mint);
          if (cv === undefined) continue;
          mk = { vq: cv.virtual_quote_reserves, vt: cv.virtual_token_reserves };
        }
        const value = sellValue(pos.token_amount, mk.vq, mk.vt) - tx;
        const basis = pos.cost_lamports + h.txPaid;
        if (value > h.best) h.best = value;
        let exit = false;
        if (basis > 0n) {
          if (value * BPS >= basis * (BPS + P.tpBps)) exit = true;
          if (value * BPS <= basis * (BPS - P.slBps)) exit = true;
          if (h.best * BPS >= basis * (BPS + P.trailArmBps) && value * BPS <= h.best * (BPS - P.trailBps)) exit = true;
        }
        if (state.slot - h.openedSlot >= P.maxHold) exit = true;
        if (c !== undefined) {
          if (P.exitOnDevSell && c.devSold && !h.devSoldAtOpen) exit = true;
          if (state.slot - c.lastTradeSlot >= P.staleSlots) exit = true;
          if (flow(c, state.slot) < -P.exitFlowLamports) exit = true;
        }
        if (!exit) continue;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        selling.add(mint);
        if (c !== undefined) c.done = true;
      }

      // --- Entries. Tier 2 (looser gate) only fires late if the coin count lags. ---
      const tier2 = firstTime !== null && nowTime - firstTime >= P.paceSecs && myCoins < P.paceMinCoins;
      let free = state.freeCashLamports() - tx * BigInt(orders.length);
      let open = state.committedPositionCount();
      for (const c of coins.values()) {
        if (orders.length >= cap) break;
        if (c.done || c.complete) continue;
        const age = state.slot - c.createSlot;
        const isAdd = c.buysSent > 0;
        if (!isAdd && age > P.maxAge) {
          c.done = true;
          continue;
        }
        if (age < P.minAge) continue;
        const curve = state.curves.get(c.mint);
        if (curve === undefined || curve.complete) continue;
        if (c.devSold && (P.skipDevSold || isAdd)) {
          if (!isAdd) c.done = true;
          continue;
        }
        if (isAdd) {
          // A second tranche once the launch has shown it is not an instant dump:
          // price stepped up from the last buy, buyers still net in, a couple slots on.
          if (c.buysSent > P.maxAdds) continue;
          if (!state.positions.has(c.mint) || selling.has(c.mint) || hasPendingBuy(state, c.mint)) continue;
          if (state.slot - c.lastBuySlot < P.addDelay) continue;
          const vq = curve.virtual_quote_reserves;
          const vt = curve.virtual_token_reserves;
          if (vq * c.lastBuyVt * BPS < c.lastBuyVq * vt * (BPS + P.addStepBps)) continue;
          if (flow(c, state.slot) < P.addMinFlowLamports) continue;
          const maxAdd = state.maxBuyLamports(c.mint);
          const amount = P.addLamports < maxAdd ? P.addLamports : maxAdd;
          if (amount < P.minBuyLamports || free < amount + tx) continue;
          orders.push({ side: 'buy', mint: c.mint, quote_lamports: amount, max_slippage_bps: P.buySlippageBps });
          free -= amount + tx;
          c.buysSent += 1;
          c.spentSent += amount;
          c.lastBuyVq = vq;
          c.lastBuyVt = vt;
          c.lastBuySlot = state.slot;
          continue;
        }
        if (open >= state.hello.caps.max_open_positions) continue;
        // Quality gate: a real dev buy plus a small crowd, never a crowd alone.
        const minDev = tier2 ? P.tier2MinDevBuy : P.minDevBuy;
        const maxBuyers = tier2 ? P.tier2MaxBuyers : P.maxBuyers;
        const rq = curve.real_quote_reserves;
        if (rq < P.minRealSol || rq > P.maxRealSol) continue;
        if (c.devBuy < minDev || c.devBuy > P.maxDevBuy) continue;
        if (c.buyers.size < P.minBuyers || c.buyers.size > maxBuyers) continue;
        if (c.bought > 0n && c.soldByOthers * BPS > c.bought * P.maxSellRatioBps) continue;
        if (c.bigSellBps > P.maxBigSellBps) continue;
        const stake = tier2 ? P.tier2StakeLamports : P.stakeLamports;
        const maxBuy = state.maxBuyLamports(c.mint);
        const amount = stake < maxBuy ? stake : maxBuy;
        if (amount < P.minBuyLamports) continue;
        if (free < amount + tx) continue;
        orders.push({ side: 'buy', mint: c.mint, quote_lamports: amount, max_slippage_bps: P.buySlippageBps });
        free -= amount + tx;
        c.buysSent += 1;
        c.spentSent += amount;
        // Record the first buy's decision price and slot: the add branch
        // gates on lastBuyVq/lastBuyVt (price step-up) and lastBuySlot
        // (add delay). Without this the guards read the 0n/1n/0
        // initialisers and every add fires unchecked on the next batch.
        c.lastBuyVq = curve.virtual_quote_reserves;
        c.lastBuyVt = curve.virtual_token_reserves;
        c.lastBuySlot = state.slot;
        open += 1;
      }
      return orders;
    },
  };
}

// Only speak the harness protocol when this file is the process entrypoint
// (`node /bot/main.ts` in grading). Imported by a backtest it just exports the strategy.
if (process.argv[1] !== undefined && process.argv[1].endsWith('main.ts')) {
  await runBot(createStrategy(DEFAULT_PARAMS));
}
