import assert from "node:assert/strict";
import test from "node:test";
import { buildEvidenceReport } from "../src/lib/evidence.ts";

function completedTrade(overrides = {}) {
  return {
    costModelVersion: 1,
    id: crypto.randomUUID(),
    reportId: "report-1",
    createdAt: "2026-06-20T10:00:00.000Z",
    updatedAt: "2026-06-20T11:00:00.000Z",
    plan: "original",
    pair: "BTCUSDT",
    side: "long",
    entry: 100,
    fillEntry: 100,
    stopLoss: 90,
    takeProfit: 120,
    targets: [{ price: 120, allocationPct: 100, hitAt: "2026-06-20T11:00:00.000Z" }],
    leverage: 2,
    quantity: 10,
    remainingQuantity: 0,
    currentPrice: 120,
    exitPrice: 120,
    exitAt: "2026-06-20T11:00:00.000Z",
    unrealizedPnl: 0,
    realizedPnl: 90,
    grossUnrealizedPnl: 0,
    grossRealizedPnl: 100,
    feeRatePct: 0.06,
    entryFee: 5,
    exitFees: 5,
    estimatedExitFee: 0,
    fundingCost: 0,
    balanceBefore: 10_000,
    balanceAfter: 10_090,
    status: "take-profit",
    timeframeLabel: "1H",
    timeframe: "1H",
    expiresAt: "2026-06-20T13:00:00.000Z",
    entryHitAt: "2026-06-20T10:00:00.000Z",
    ...overrides,
  };
}

test("evidence metrics use completed net outcomes and execution costs", () => {
  const trades = [
    completedTrade(),
    completedTrade({
      id: "loss",
      reportId: "report-2",
      updatedAt: "2026-06-21T11:00:00.000Z",
      exitAt: "2026-06-21T11:00:00.000Z",
      status: "stop-loss",
      grossRealizedPnl: -50,
      realizedPnl: -55,
      entryFee: 2.5,
      exitFees: 2.5,
    }),
  ];
  const report = buildEvidenceReport(trades);

  assert.equal(report.original.completed, 2);
  assert.equal(report.original.winRatePct, 50);
  assert.equal(report.original.netPnl, 35);
  assert.equal(report.original.netCosts, 15);
  assert.equal(report.original.profitFactor, 1.64);
  assert.equal(report.original.maxDrawdown, 55);
});

test("head-to-head evidence waits until both plans have completed", () => {
  const original = completedTrade({ realizedPnl: -50, grossRealizedPnl: -40 });
  const safer = completedTrade({
    id: "safer",
    plan: "safer",
    realizedPnl: -20,
    grossRealizedPnl: -10,
  });
  const report = buildEvidenceReport([original, safer]);

  assert.equal(report.completedPairs, 1);
  assert.equal(report.paired.saferLed, 1);
  assert.equal(report.sampleQuality, "insufficient");
});

test("open trades do not inflate completed performance", () => {
  const open = completedTrade({
    status: "active",
    exitAt: undefined,
    remainingQuantity: 10,
    realizedPnl: -5,
    unrealizedPnl: 40,
  });
  const report = buildEvidenceReport([open]);

  assert.equal(report.completedOutcomes, 0);
  assert.equal(report.original.completed, 0);
  assert.equal(report.monitoringTrades, 1);
});
