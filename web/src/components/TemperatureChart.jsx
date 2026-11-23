import { useMemo } from "react";
import {
  CategoryScale,
  Chart as ChartJS,
  Legend,
  LinearScale,
  LineElement,
  PointElement,
  Tooltip,
} from "chart.js";
import { Line } from "react-chartjs-2";

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Tooltip, Legend);

const overlayPlugin = {
  id: "overlayPlugin",
  beforeDatasetsDraw(chart, _, options) {
    const { ctx, chartArea, scales } = chart;
    if (!chartArea || !scales.x || !scales.y) {
      return;
    }

    const { safeMin, safeMax, doorRanges } = options;
    const safeTop = scales.y.getPixelForValue(safeMax);
    const safeBottom = scales.y.getPixelForValue(safeMin);

    ctx.save();
    ctx.fillStyle = "rgba(32, 30, 29, 0.08)";
    ctx.fillRect(chartArea.left, safeTop, chartArea.right - chartArea.left, safeBottom - safeTop);

    ctx.strokeStyle = "rgba(32, 30, 29, 0.45)";
    ctx.setLineDash([5, 5]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(chartArea.left, safeTop);
    ctx.lineTo(chartArea.right, safeTop);
    ctx.moveTo(chartArea.left, safeBottom);
    ctx.lineTo(chartArea.right, safeBottom);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle = "rgba(236, 48, 19, 0.18)";
    ctx.strokeStyle = "#ec3013";
    ctx.lineWidth = 2;

    doorRanges.forEach(({ start, end }) => {
      const x1 = scales.x.getPixelForValue(start);
      const x2 = scales.x.getPixelForValue(end);
      const left = Math.max(chartArea.left, Math.min(x1, x2));
      const right = Math.min(chartArea.right, Math.max(x1, x2));
      if (right <= left) {
        return;
      }
      ctx.fillRect(left, chartArea.top, right - left, chartArea.bottom - chartArea.top);
      ctx.beginPath();
      ctx.moveTo(left, chartArea.top);
      ctx.lineTo(right, chartArea.top);
      ctx.stroke();
    });

    ctx.restore();
  },
};

ChartJS.register(overlayPlugin);

function buildDoorRanges(readings) {
  const ranges = [];
  let currentStart = null;

  for (let index = 0; index < readings.length; index += 1) {
    const current = readings[index];
    const next = readings[index + 1];
    if (current.doorOpen && currentStart === null) {
      currentStart = current.timestampMs;
    }
    if (currentStart !== null && (!next || !next.doorOpen)) {
      ranges.push({
        start: currentStart,
        end: next?.timestampMs ?? current.timestampMs,
      });
      currentStart = null;
    }
  }

  return ranges;
}

function TemperatureChart({ readings, safeRange }) {
  const prepared = useMemo(
    () =>
      readings
        .filter((item) => item.temperature !== null && item.temperature !== undefined)
        .map((item) => ({
          x: item.timestampMs,
          y: Number(item.temperature),
        })),
    [readings],
  );

  const latestTs = prepared.length ? prepared[prepared.length - 1].x : Date.now();
  const minTs = latestTs - 5 * 60 * 1000;
  const doorRanges = useMemo(() => buildDoorRanges(readings), [readings]);
  const yMax = Math.max(14, safeRange.max + 3, ...prepared.map((point) => point.y + 1));

  const data = useMemo(
    () => ({
      datasets: [
        {
          label: "Temperatura",
          data: prepared,
          borderWidth: 2,
          pointRadius: 0,
          tension: 0,
          borderColor: "#201e1d",
          segment: {
            borderColor: (ctx) => {
              const y0 = ctx.p0.parsed.y;
              const y1 = ctx.p1.parsed.y;
              if (y0 < safeRange.min || y0 > safeRange.max || y1 < safeRange.min || y1 > safeRange.max) {
                return "#ec3013";
              }
              return "#201e1d";
            },
          },
        },
      ],
    }),
    [prepared, safeRange.max, safeRange.min],
  );

  const options = useMemo(
    () => ({
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      parsing: false,
      normalized: true,
      scales: {
        x: {
          type: "linear",
          min: minTs,
          max: latestTs,
          grid: {
            color: "rgba(32, 30, 29, 0.16)",
          },
          border: {
            color: "#201e1d",
            width: 2,
          },
          ticks: {
            maxTicksLimit: 6,
            callback: (value) => {
              const minutes = Math.round((latestTs - Number(value)) / 60000);
              if (minutes <= 0) {
                return "agora";
              }
              return `-${minutes} min`;
            },
          },
        },
        y: {
          min: 0,
          max: yMax,
          grid: {
            color: "rgba(32, 30, 29, 0.16)",
          },
          border: {
            color: "#201e1d",
            width: 2,
          },
          ticks: {
            callback: (value) => `${value}°`,
          },
        },
      },
      plugins: {
        legend: {
          display: false,
        },
        tooltip: {
          callbacks: {
            label: (context) => `${context.parsed.y.toFixed(1).replace(".", ",")} °C`,
          },
        },
        overlayPlugin: {
          safeMin: safeRange.min,
          safeMax: safeRange.max,
          doorRanges,
        },
      },
    }),
    [doorRanges, latestTs, minTs, safeRange.max, safeRange.min, yMax],
  );

  return (
    <div className="chart-wrapper">
      <Line data={data} options={options} />
    </div>
  );
}

export default TemperatureChart;
