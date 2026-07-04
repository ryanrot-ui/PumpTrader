"use client";

import { useEffect, useRef } from "react";
import {
  createChart,
  ColorType,
  type IChartApi,
  type UTCTimestamp,
} from "lightweight-charts";

export interface PricePoint {
  time: number; // unix seconds
  price: number;
  volume?: number | null;
}

export interface TradeMarker {
  time: number;
  side: "BUY" | "SELL";
  label: string;
}

/**
 * Price + volume chart using TradingView's lightweight-charts, with entry and
 * exit markers overlaid so every trade is visible in context.
 */
export function PriceChart({
  points,
  markers = [],
  height = 280,
}: {
  points: PricePoint[];
  markers?: TradeMarker[];
  height?: number;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);

  useEffect(() => {
    if (!containerRef.current || points.length === 0) return;

    const chart = createChart(containerRef.current, {
      height,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: "#64748b",
      },
      grid: {
        vertLines: { color: "#1a2030" },
        horzLines: { color: "#1a2030" },
      },
      timeScale: { timeVisible: true, secondsVisible: true, borderColor: "#232a3b" },
      rightPriceScale: { borderColor: "#232a3b" },
      crosshair: { mode: 0 },
    });
    chartRef.current = chart;

    const priceSeries = chart.addAreaSeries({
      lineColor: "#6366f1",
      topColor: "rgba(99,102,241,0.35)",
      bottomColor: "rgba(99,102,241,0)",
      lineWidth: 2,
      priceFormat: { type: "price", precision: 8, minMove: 0.00000001 },
    });
    priceSeries.setData(
      points.map((p) => ({ time: p.time as UTCTimestamp, value: p.price }))
    );

    const volumes = points.filter((p) => p.volume != null);
    if (volumes.length > 0) {
      const volSeries = chart.addHistogramSeries({
        priceScaleId: "vol",
        color: "rgba(99,102,241,0.3)",
        priceFormat: { type: "volume" },
      });
      chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
      volSeries.setData(
        volumes.map((p) => ({ time: p.time as UTCTimestamp, value: p.volume! }))
      );
    }

    if (markers.length > 0) {
      priceSeries.setMarkers(
        markers
          .sort((a, b) => a.time - b.time)
          .map((m) => ({
            time: m.time as UTCTimestamp,
            position: m.side === "BUY" ? "belowBar" : "aboveBar",
            color: m.side === "BUY" ? "#22c55e" : "#ef4444",
            shape: m.side === "BUY" ? "arrowUp" : "arrowDown",
            text: m.label,
          }))
      );
    }

    chart.timeScale().fitContent();

    const onResize = () => {
      if (containerRef.current) chart.applyOptions({ width: containerRef.current.clientWidth });
    };
    onResize();
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      chart.remove();
      chartRef.current = null;
    };
  }, [points, markers, height]);

  if (points.length === 0) {
    return (
      <div className="h-40 flex items-center justify-center text-sm text-slate-600">
        No price history captured yet
      </div>
    );
  }
  return <div ref={containerRef} className="w-full" />;
}
