# Sample Signals

These examples are for testing TradeLens. Prices move constantly, so update the numbers if the market has moved far away from the example.

## Current-price long

Use this when the trader wants to enter near the live price.

```txt
LONG SUIUSDT
Entry: around current
TP: 0.7472 / 0.7544
SL: 0.7256
Leverage: 3x
```

Meaning:

- long means the trader expects price to go up
- entry around current means enter near the live price
- TP is where profit is taken
- SL is where the trade exits if wrong
- 3x leverage means the position moves like roughly three times the margin exposure before fees

## Current-price short

Use this when the trader wants to enter near the live price and expects price to fall.

```txt
SHORT HYPEUSDT
Entry: around current
TP: 60.85 / 59.62
SL: 62.71
Leverage: 2x
```

Meaning:

- short means the trader expects price to go down
- the stop-loss is above entry because a short loses when price rises
- the take-profit targets are below entry because a short profits when price falls

## Exact-entry long

Use this when the trader only wants the trade if price reaches a specific level.

```txt
LONG BNBUSDT
Entry: 581.00
TP: 593.00 / 605.00
SL: 575.00
Leverage: 3x
Timeframe: 1H
```

Meaning:

- TradeLens checks whether 581.00 is still close to the live market
- the 1H timeframe asks TradeLens to judge the signal using 1-hour candle context

## Bad signal for testing

Use this to confirm TradeLens can reject unsafe structure.

```txt
LONG BTCUSDT
Entry: around current
TP: 64100
SL: 65000
Leverage: 20x
```

This is intentionally flawed because a long trade should usually have its stop-loss below entry, not above entry.

