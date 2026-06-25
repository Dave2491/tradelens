# TradeLens

TradeLens is an AI-assisted futures signal risk checker built for Bitget AI Base Camp Hackathon S1.

It helps a trader paste a crypto signal before following it, checks that signal against live Bitget futures data, asks Qwen AI to explain the risk in plain language, and creates a paper-trading evidence trail that can be exported for review.

TradeLens does not place real trades. It is designed to protect decision-making before a trader sends money into a futures position.

## Problem

Retail traders often copy signals from Telegram, X, Discord, or trading groups without checking:

- whether the entry is still close to the live market price
- whether the stop-loss is on the correct side
- whether the target is worth the risk
- whether leverage is too aggressive
- whether the market context has already changed

In futures trading, small mistakes can become expensive quickly because leverage magnifies profit and loss.

## What TradeLens does

1. Parses messy trade signals into structured data.
2. Resolves the market against Bitget USDT futures symbols.
3. Fetches live Bitget market data.
4. Scores the signal using deterministic risk rules.
5. Uses Qwen AI to explain the verdict in beginner-friendly language.
6. Compares the original signal against a safer TradeLens plan.
7. Lets the user paper-track the original plan, the safer plan, or both.
8. Exports an evidence report showing what was checked, what data was used, and what happened.

## Core verdicts

TradeLens returns one of three verdicts:

- `Accept`: the setup passes the current structural checks.
- `Modify`: the trade idea may be usable, but risk controls should be adjusted.
- `Avoid`: the setup is too fragile, invalid, or unsafe under current market conditions.

The verdict is a risk-structure score, not a profit prediction.

## Data sources

TradeLens uses real Bitget public market data for:

- USDT futures symbols
- live ticker price
- closed candles
- ATR volatility
- RSI
- EMA trend checks
- funding rate
- open interest
- bid/ask spread
- order-book depth
- mark and index price basis

No mock prices are used for market analysis.

## AI usage

Qwen AI is used for language understanding and explanation:

- parsing flexible signal formats when the local parser needs help
- writing the AI trade review
- explaining completed paper-trade outcomes

TradeLens does not let the AI secretly invent market data. The risk engine still uses Bitget market data and deterministic rules for the structural checks.

## Paper-trading evidence

Paper trading means TradeLens simulates what would have happened without placing a real trade.

The Evidence page is built for hackathon review. It shows:

- the signal that was checked
- the Bitget data used
- whether the trade is still being monitored
- whether take-profit or stop-loss was hit
- estimated fees, spread, funding, and net PnL
- head-to-head comparison between the original signal and the TradeLens plan
- exportable JSON evidence

Important terms:

- `TP` means take-profit, the price where the trade takes profit.
- `SL` means stop-loss, the price where the trade exits because the idea is wrong.
- `PnL` means profit and loss.
- `R` means the result measured against the initial planned risk. `+1R` earns one risk unit; `-1R` loses one risk unit.

## Example signals

Current-price long:

```txt
LONG SUIUSDT
Entry: around current
TP: 0.7472 / 0.7544
SL: 0.7256
Leverage: 3x
```

Current-price short:

```txt
SHORT HYPEUSDT
Entry: around current
TP: 60.85 / 59.62
SL: 62.71
Leverage: 2x
```

Exact-entry setup:

```txt
LONG BNBUSDT
Entry: 581.00
TP: 593.00 / 605.00
SL: 575.00
Leverage: 3x
Timeframe: 1H
```

TradeLens also supports more compact signal formats, but the signal should include pair, side, entry, target, stop, and leverage for the best result.

## Tech stack

- React
- TypeScript
- Vite
- React Router
- Lightweight Charts
- Lucide icons
- Vercel serverless API routes
- Bitget public futures API
- Qwen API through the Bitget hackathon endpoint

## Environment variables

Create a local `.env` from `.env.example`.

```txt
BITGET_QWEN_API_KEY=
QWEN_BASE_URL=https://hackathon.bitgetops.com/v1
QWEN_MODEL=qwen3.6-plus
QWEN_PARSE_MODEL=qwen3.6-flash
QWEN_REVIEW_MODEL=qwen3.6-flash
QWEN_OUTCOME_MODEL=qwen3.6-plus
```

Do not commit real keys. These are server-side secrets and must not be exposed through `VITE_` browser variables.

Bitget market data does not require a private API key in the current MVP because TradeLens uses public market endpoints.

## Local development

Install dependencies:

```bash
npm install
```

Run the Vite dev server:

```bash
npm run dev
```

Run with Vercel-style local API routes:

```bash
npm run dev:vercel
```

Run tests:

```bash
npm test
```

Build for production:

```bash
npm run build
```

## Submission evidence checklist

Before final hackathon submission, include:

- GitHub repository link
- deployed app link, if available
- short demo video
- screenshots of Signal Desk, Trade Monitor, and Evidence pages
- exported evidence JSON from the Evidence page
- this README
- supporting notes in the `docs/` folder

The app can still run during review if the deployment and Qwen key remain active, but the repo and demo evidence should be enough to show how the agent worked at submission time.

## Supporting docs

- [Evidence methodology](docs/evidence-methodology.md)
- [Data sources](docs/data-sources.md)
- [Sample signals](docs/sample-signals.md)
- [Demo script](docs/demo-script.md)
- [Submission checklist](docs/submission-checklist.md)

## Current scope

TradeLens currently focuses on risk checking and paper-trade evidence.

It intentionally does not:

- execute real trades
- request a user's private Bitget API key
- manage real account balances
- promise profit or win probability

This keeps the MVP safer for retail users while still demonstrating AI-assisted crypto trading analysis with live Bitget data.
