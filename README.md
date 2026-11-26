# pump-fun-replay-01

[![make.fun · u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/mutkibubu66/pump-fun-replay-01/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/mutkibubu66/pump-fun-replay-01/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

Launch Sniper: a paper-trading bot for the pump.fun replay (`agent-fun/replay/v2`). It trades 10 SOL of paper money on a replay of pump.fun bonding-curve events, ranked on net PnL. A placement needs net PnL above holding cash (above 0 after every fee), at least 20 distinct coins with round trips of 0.01 SOL or more, and max drawdown of 50% or less.

## Strategy

What the dev window taught me (1222 coins, 24h of pump.fun chain data):

- Almost every coin spikes in its first few trades and then bleeds back to its creation price (median price at trade 5 is 1.35x create, at +400 slots 1.02x).
- With 2 slots of fill latency a buy decided after the spike has started fills a median 14% worse than the signal price, so chasing mature momentum loses money.
- The only entries that break even are bought in the first 3 slots after creation, on launches where the creator put real money in (>= 1 SOL of their own buys) and a small handful of other wallets joined at once (exactly 3 distinct non-creator buyers): a crowd means a bundled dump waiting to happen, a lone dev means a rug.

So: buy fast, buy small (0.1 SOL), take profit at +25% or cut at -12%, never hold longer than 20 slots, leave the moment the creator sells. One buy per coin plus one guarded add. A pacing fallback loosens the gate late in the window if the 20-coin guardrail is ever at risk.

Everything is deterministic: no clock, no environment, no randomness; iteration only over insertion-ordered maps fed by the batch stream. All money math in lamports (bigint).

## Dev-window backtest

Run on the kit's full 24-hour dev window with the kit's own replay sim (`dev/backtest.ts`, all three dataset parts), default params, after the first-buy recording fix:

| metric | value |
|---|---|
| net PnL | +0.0414 SOL |
| fills | 89 |
| distinct coins | 39 |
| round trips | 39 (8 wins) |
| max drawdown | 0.0088 |

## License

MIT — see [LICENSE](LICENSE).
