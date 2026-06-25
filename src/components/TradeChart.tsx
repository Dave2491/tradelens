import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  LineStyle,
  createChart,
  type IChartApi,
  type UTCTimestamp,
} from "lightweight-charts";
import { fetchMarketSnapshot } from "../lib/bitget";
import type { MarketSnapshot, RiskReport } from "../lib/types";

type OverlayMode = "both" | "original" | "tradelens";

type TradeChartProps = {
  report: RiskReport;
  theme: "dark" | "light";
};

function pricePrecision(value: number) {
  if (value >= 1) return 2;
  if (value >= 0.1) return 4;
  if (value >= 0.01) return 5;
  return 6;
}

function formatPrice(value: number, precision: number) {
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: precision,
    maximumFractionDigits: precision,
  }).format(value);
}

function formatTime(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
}

export function TradeChart({ report, theme }: TradeChartProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const refreshInFlightRef = useRef(false);
  const [overlayMode, setOverlayMode] = useState<OverlayMode>("both");
  const [market, setMarket] = useState<MarketSnapshot>(report.market);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState("");

  const precision = useMemo(() => pricePrecision(market.price), [market.price]);
  const saferPlanIsTradeable = report.saferPlan.riskPct > 0;

  useEffect(() => {
    setMarket(report.market);
    setRefreshError("");
  }, [report.id, report.market]);

  const refreshChart = useCallback(async () => {
    if (refreshInFlightRef.current) return;
    refreshInFlightRef.current = true;
    setIsRefreshing(true);
    try {
      const next = await fetchMarketSnapshot(
        report.signal.pair,
        report.market.timeframe,
        report.market.timeframeSource,
        false,
      );
      setMarket(next);
      setRefreshError("");
    } catch (error) {
      setRefreshError(error instanceof Error ? error.message : "Live chart refresh failed.");
    } finally {
      refreshInFlightRef.current = false;
      setIsRefreshing(false);
    }
  }, [report.market.timeframe, report.market.timeframeSource, report.signal.pair]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      void refreshChart();
    }, 15_000);
    return () => window.clearInterval(interval);
  }, [refreshChart]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !market.candles.length) return;

    chartRef.current?.remove();
    const isLight = theme === "light";
    const chart = createChart(host, {
      width: host.clientWidth,
      height: 430,
      layout: {
        background: { type: ColorType.Solid, color: isLight ? "#ffffff" : "#0b0e15" },
        textColor: isLight ? "#667085" : "#c2c6d6",
        fontFamily: '"Inter Variable", Inter, ui-sans-serif, system-ui, sans-serif',
      },
      grid: {
        vertLines: { color: isLight ? "rgba(71, 84, 103, 0.09)" : "rgba(175, 198, 255, 0.05)" },
        horzLines: { color: isLight ? "rgba(71, 84, 103, 0.09)" : "rgba(175, 198, 255, 0.05)" },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: isLight ? "rgba(71, 84, 103, 0.35)" : "rgba(175, 198, 255, 0.4)", labelBackgroundColor: isLight ? "#475467" : "#131a2e" },
        horzLine: { color: isLight ? "rgba(71, 84, 103, 0.35)" : "rgba(175, 198, 255, 0.4)", labelBackgroundColor: isLight ? "#475467" : "#131a2e" },
      },
      rightPriceScale: {
        borderColor: isLight ? "rgba(71, 84, 103, 0.18)" : "rgba(255, 255, 255, 0.1)",
        scaleMargins: { top: 0.12, bottom: 0.12 },
      },
      timeScale: {
        borderColor: isLight ? "rgba(71, 84, 103, 0.18)" : "rgba(255, 255, 255, 0.1)",
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 5,
        barSpacing: 8,
      },
    });
    chartRef.current = chart;

    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: "#4ade80",
      downColor: "#f87171",
      borderUpColor: "#4ade80",
      borderDownColor: "#f87171",
      wickUpColor: "#4ade80",
      wickDownColor: "#ffb4ab",
      priceFormat: {
        type: "price",
        precision,
        minMove: 10 ** -precision,
      },
    });

    candleSeries.setData(market.candles.map((candle) => ({
      time: Math.floor(candle.time / 1000) as UTCTimestamp,
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
    })));

    candleSeries.createPriceLine({
      price: market.price,
      color: isLight ? "#172033" : "#e1e2ec",
      lineWidth: 1,
      lineStyle: LineStyle.Dotted,
      axisLabelVisible: true,
      title: "LIVE",
    });

    if (overlayMode === "both" || overlayMode === "original") {
      candleSeries.createPriceLine({
        price: report.signal.entry,
        color: "#ffb77b",
        lineWidth: 2,
        lineStyle: LineStyle.Solid,
        axisLabelVisible: true,
        title: "ORIG ENTRY",
      });
      if (report.signal.stopLoss) {
        candleSeries.createPriceLine({
          price: report.signal.stopLoss,
          color: "#f87171",
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true,
          title: "ORIG STOP",
        });
      }
      report.signal.takeProfits.forEach((target, index) => {
        candleSeries.createPriceLine({
          price: target,
          color: "#ffb77b",
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true,
          title: `ORIG TP${index + 1}`,
        });
      });
    }

    if (saferPlanIsTradeable && (overlayMode === "both" || overlayMode === "tradelens")) {
      candleSeries.createPriceLine({
        price: report.saferPlan.entry,
        color: "#4ade80",
        lineWidth: 2,
        lineStyle: LineStyle.Solid,
        axisLabelVisible: true,
        title: "TL ENTRY",
      });
      candleSeries.createPriceLine({
        price: report.saferPlan.stopLoss,
        color: "#ffb4ab",
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: "TL STOP",
      });
      candleSeries.createPriceLine({
        price: report.saferPlan.takeProfit,
        color: "#4ade80",
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: "TL TARGET",
      });
    }

    chart.timeScale().fitContent();
    const resizeObserver = new ResizeObserver(([entry]) => {
      chart.applyOptions({ width: Math.floor(entry.contentRect.width) });
    });
    resizeObserver.observe(host);

    return () => {
      resizeObserver.disconnect();
      chart.remove();
      if (chartRef.current === chart) chartRef.current = null;
    };
  }, [market, overlayMode, precision, report, saferPlanIsTradeable, theme]);

  return (
    <section className="surface trade-chart-panel">
      <div className="trade-chart-heading">
        <div>
          <p className="eyebrow">Live trade map</p>
          <h2>{report.signal.pair} price and plan levels</h2>
        </div>
        <div className="trade-chart-controls">
          <div className="chart-mode" aria-label="Chart plan overlays">
            <button type="button" aria-pressed={overlayMode === "original"} onClick={() => setOverlayMode("original")}>Original</button>
            <button type="button" aria-pressed={overlayMode === "tradelens"} disabled={!saferPlanIsTradeable} onClick={() => setOverlayMode("tradelens")}>TradeLens</button>
            <button type="button" aria-pressed={overlayMode === "both"} disabled={!saferPlanIsTradeable} onClick={() => setOverlayMode("both")}>Both</button>
          </div>
          <button type="button" className="ghost-button tiny" onClick={() => void refreshChart()} disabled={isRefreshing}>
            {isRefreshing ? "Refreshing..." : "Refresh chart"}
          </button>
        </div>
      </div>

      <div className="chart-status-row">
        <span><i className="status-dot" />Live Bitget chart: {formatTime(market.fetchedAt)}</span>
        <span>Verdict snapshot: {formatTime(report.market.fetchedAt)}</span>
        <span>{market.timeframe} candles: {market.candles.length} completed</span>
      </div>
      {refreshError ? <p className="chart-refresh-error">{refreshError} Showing the last verified chart.</p> : null}

      <div className="trade-chart-host" ref={hostRef} aria-label={`${report.signal.pair} Bitget candlestick chart`} />

      <div className="chart-plan-legend">
        {(overlayMode === "both" || overlayMode === "original") ? (
          <article className="chart-plan-summary original">
            <div><span className="legend-swatch" /><strong>Original signal</strong></div>
            <dl>
              <div><dt>Stop / loss zone</dt><dd>{report.signal.stopLoss ? formatPrice(report.signal.stopLoss, precision) : "Missing"}</dd></div>
              <div><dt>Entry</dt><dd>{formatPrice(report.signal.entry, precision)}</dd></div>
              <div><dt>First profit target</dt><dd>{report.signal.takeProfits[0] ? formatPrice(report.signal.takeProfits[0], precision) : "Missing"}</dd></div>
            </dl>
          </article>
        ) : null}
        {saferPlanIsTradeable && (overlayMode === "both" || overlayMode === "tradelens") ? (
          <article className="chart-plan-summary tradelens">
            <div><span className="legend-swatch" /><strong>TradeLens plan</strong></div>
            <dl>
              <div><dt>Stop / loss zone</dt><dd>{formatPrice(report.saferPlan.stopLoss, precision)}</dd></div>
              <div><dt>Entry</dt><dd>{formatPrice(report.saferPlan.entry, precision)}</dd></div>
              <div><dt>Profit target</dt><dd>{formatPrice(report.saferPlan.takeProfit, precision)}</dd></div>
            </dl>
          </article>
        ) : null}
      </div>
    </section>
  );
}
