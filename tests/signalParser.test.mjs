import assert from "node:assert/strict";
import test from "node:test";
import { parseLocalSignalDraft, toLocalSignalInput } from "../src/lib/signalParser.ts";

const symbols = [
  { symbol: "SUIUSDT", baseCoin: "SUI", quoteCoin: "USDT" },
  { symbol: "BNBUSDT", baseCoin: "BNB", quoteCoin: "USDT" },
];

test("multiline current-price signals use the fast local parser", () => {
  const raw = `LONG SUIUSDT
Entry: around current
TP: 0.7472 / 0.7544
SL: 0.7256
Leverage: 3x`;
  const draft = parseLocalSignalDraft(raw, symbols);

  assert.ok(draft);
  assert.equal(draft.entryMode, "current");
  assert.deepEqual(draft.takeProfits, [0.7472, 0.7544]);
  assert.equal(draft.stopLoss, 0.7256);
  assert.equal(draft.leverage, 3);

  const signal = toLocalSignalInput(draft, raw, 0.7328);
  assert.equal(signal.entry, 0.7328);
});

test("one-line reordered Telegram-style signals parse only target values", () => {
  const raw = "SUI long | current entry | targets 0.7472, 0.7544 | stop 0.7256 | lev 3x";
  const draft = parseLocalSignalDraft(raw, symbols);

  assert.ok(draft);
  assert.equal(draft.pair, "SUIUSDT");
  assert.deepEqual(draft.takeProfits, [0.7472, 0.7544]);
  assert.equal(draft.stopLoss, 0.7256);
});

test("compact exact-entry signals parse locally", () => {
  const raw = "BNBUSDT SHORT @ 600 | TP 590 / 580 | SL 605 | 2x";
  const draft = parseLocalSignalDraft(raw, symbols);

  assert.ok(draft);
  assert.equal(draft.entry, 600);
  assert.equal(draft.side, "short");
  assert.deepEqual(draft.takeProfits, [590, 580]);
});

test("unclear conversational signals remain available for Qwen fallback", () => {
  const raw = "I think SUI may bounce soon, perhaps buy if momentum improves.";
  assert.equal(parseLocalSignalDraft(raw, symbols), undefined);
});
