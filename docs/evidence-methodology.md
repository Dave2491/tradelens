# Evidence Methodology

TradeLens is built to show what happened to a checked trade idea after it was reviewed. The goal is not to promise profit. The goal is to make the decision auditable.

In simple trading terms: TradeLens asks, "If someone followed this signal, and if someone followed the safer TradeLens version, what would have happened after entry?"

## What TradeLens records

For each paper-tracked plan, TradeLens records:

- the original signal text
- the parsed market, side, entry, stop, target, and leverage
- the live Bitget market snapshot used during analysis
- the safer TradeLens plan, when one exists
- the user-confirmed paper balance and risk setting
- estimated trading fee
- entry behavior
- target allocation
- stop-loss or take-profit outcome
- estimated gross move, fees, funding, and net PnL

## Trade lifecycle

TradeLens treats a paper trade like a simple futures position:

1. The user reviews a signal.
2. The user chooses to paper-track the original plan, the safer plan, or both.
3. The user confirms simulated account balance, maximum loss, fee, entry behavior, leverage, and target allocation.
4. TradeLens monitors Bitget candles.
5. If price reaches the entry condition, the simulated position opens.
6. If price reaches a take-profit level, the matching portion of the position closes.
7. If price reaches the stop-loss, the remaining position closes.
8. Closed outcomes are included in the Evidence page and export.

## Terms

`Entry` is the price where the trade opens.

`TP` means take-profit. It is the price where a trader plans to take money off the table.

`SL` means stop-loss. It is the price where a trader exits because the idea is wrong.

`PnL` means profit and loss.

`Leverage` means borrowed exposure. With 2x leverage, a 1% price move behaves like roughly a 2% move on the trader's margin before fees.

`R` means risk unit. If the planned loss is $10, then `+1R` means a $10 gain and `-1R` means a $10 loss.

## Human-like assumptions

TradeLens avoids assumptions that would not match normal trading behavior.

The current model uses:

- user-confirmed simulated balance instead of pretending to know the user's real account
- user-confirmed maximum loss if stop is hit
- user-confirmed fee estimate
- market entry only when the user chooses immediate entry
- target allocation chosen by the user
- stop-loss and target closes based on Bitget candle behavior

TradeLens does not:

- assume the user has unlimited balance
- assume every signal is worth trading
- close an open trade just because a timer expires
- claim a live real-money position was opened
- claim exact exchange fees unless the user provides them

## Why this matters

For futures traders, the dangerous part is not only choosing direction. The dangerous part is poor risk structure.

A trade can be directionally correct but still lose money if:

- the stop is too tight
- leverage is too high
- fees eat the reward
- the entry is too late
- the target is not worth the risk

The Evidence page helps show whether TradeLens improved survival and outcome quality compared with the original signal.

