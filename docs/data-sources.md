# Data Sources

TradeLens uses live Bitget public market data for its trading context. It does not use mock prices for signal analysis.

## Bitget public market data

The app uses Bitget futures market data for:

- futures symbol discovery
- live ticker price
- recent closed candles
- funding rate
- open interest
- order-book depth
- bid/ask spread
- mark price and index price comparison

These are public market reads. The current MVP does not require a private Bitget API key.

## Market indicators derived from Bitget data

TradeLens calculates:

- `ATR volatility`: how much price usually moves over recent candles
- `RSI`: whether price action is stretched or weak
- `EMA trend`: whether short-term and slower trend averages agree
- `entry gap`: how far the signal entry is from the live Bitget price
- `risk/reward`: how much the trade can make compared with what it risks
- `order-book tilt`: whether visible near-market depth leans more toward buyers or sellers

These indicators are not magic predictions. They are context checks.

## Qwen AI

Qwen AI is used for:

- parsing flexible signal text
- explaining the final risk verdict
- writing beginner-friendly trade reviews
- summarizing completed paper-trade outcomes

Qwen does not replace the market data. TradeLens sends market context and risk facts into the model so the written explanation stays grounded in the data.

## No private account data

TradeLens currently does not ask users to connect a Bitget account.

That means:

- no private account balance is fetched
- no private positions are fetched
- no orders are placed
- no real trades are executed

Paper-trading balance is simulated and user supplied.

## Why this matters

For the hackathon review, the important point is that TradeLens can show where the analysis came from:

- signal data from the user
- market data from Bitget
- risk checks from TradeLens policy
- written explanation from Qwen
- evidence report from paper-tracked outcomes

