import { useEffect, useMemo, useRef, useState } from "react";
import TemperatureChart from "./components/TemperatureChart";

const WINDOW_STALE_MS = 15000;
const WINDOW_HISTORY_MS = 5 * 60 * 1000;
const DEFAULT_SAFE_RANGE = { min: 2, max: 8 };

function toWsFromApi(apiUrl) {
  if (!apiUrl) {
    return "";
  }

  if (apiUrl.startsWith("https://")) {
    return `${apiUrl.replace("https://", "wss://")}/ws`;
  }

  if (apiUrl.startsWith("http://")) {
    return `${apiUrl.replace("http://", "ws://")}/ws`;
  }

  return "";
}

function normalizeState(value) {
  if (!value) {
    return "SEM_DADOS";
  }

  const text = String(value).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase();

  if (text === "OK") {
    return "OK";
  }

  if (text === "ATENCAO") {
    return "ATENCAO";
  }

  if (text === "ALARME") {
    return "ALARME";
  }

  return "SEM_DADOS";
}

function pick(obj, keys) {
  return keys.find((key) => obj?.[key] !== undefined);
}

function normalizeReading(source) {
  if (!source || typeof source !== "object") {
    return null;
  }

  const timestampKey = pick(source, ["timestamp", "ts", "time", "created_at"]);
  const stateKey = pick(source, ["state", "status"]);
  const temperatureKey = pick(source, ["temperature", "temp", "t"]);
  const humidityKey = pick(source, ["humidity", "h"]);
  const distanceKey = pick(source, ["distance", "d"]);
  const remainingKey = pick(source, ["remaining_seconds", "remaining", "remainingSecs"]);
  const doorOpenKey = pick(source, ["door_open", "doorOpen", "porta_aberta", "porta"]);
  const arduinoKey = pick(source, ["arduino_online", "arduinoOnline", "online"]);

  return {
    timestamp: timestampKey ? source[timestampKey] : null,
    state: normalizeState(stateKey ? source[stateKey] : null),
    temperature: temperatureKey ? source[temperatureKey] : null,
    humidity: humidityKey ? source[humidityKey] : null,
    distance: distanceKey ? source[distanceKey] : null,
    remainingSeconds: remainingKey ? source[remainingKey] : null,
    doorOpen: doorOpenKey ? source[doorOpenKey] : null,
    arduinoOnline: arduinoKey ? source[arduinoKey] : null,
  };
}

function toMs(value) {
  if (value === null || value === undefined) {
    return null;
  }

  const num = Number(value);
  if (!Number.isFinite(num)) {
    return null;
  }

  if (num > 10_000_000_000) {
    return num;
  }

  return num * 1000;
}

function buildStateFromSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object") {
    return null;
  }

  const stateObj = snapshot.state && typeof snapshot.state === "object" ? snapshot.state : null;
  const sourceReading =
    stateObj ||
    snapshot.reading ||
    snapshot.current ||
    (Array.isArray(snapshot.readings) ? snapshot.readings[snapshot.readings.length - 1] : null) ||
    snapshot;
  const normalized = normalizeReading(sourceReading);
  const fallback = normalizeReading(snapshot);

  if (!normalized) {
    return null;
  }

  return {
    ...normalized,
    arduinoOnline:
      normalized.arduinoOnline !== null ? normalized.arduinoOnline : fallback?.arduinoOnline ?? null,
    state: normalized.state !== "SEM_DADOS" ? normalized.state : fallback?.state ?? "SEM_DADOS",
    remainingSeconds:
      normalized.remainingSeconds !== null
        ? normalized.remainingSeconds
        : fallback?.remainingSeconds ?? null,
    timestampMs: toMs(normalized.timestamp) ?? Date.now(),
  };
}

function normalizeSafeRange(snapshotPayload) {
  const config = snapshotPayload?.config || snapshotPayload || {};
  const minKey = pick(config, ["range_min", "rangeMin", "safe_min", "safeMin", "safe_min_c", "min_temp", "min", "low"]);
  const maxKey = pick(config, ["range_max", "rangeMax", "safe_max", "safeMax", "safe_max_c", "max_temp", "max", "high"]);

  const min = minKey ? Number(config[minKey]) : Number.NaN;
  const max = maxKey ? Number(config[maxKey]) : Number.NaN;

  if (Number.isFinite(min) && Number.isFinite(max) && min < max) {
    return { min, max };
  }

  return DEFAULT_SAFE_RANGE;
}

function trimReadings(readings, referenceTs) {
  const cutoff = referenceTs - WINDOW_HISTORY_MS;
  return readings.filter((item) => item.timestampMs >= cutoff);
}

function normalizeReadingsList(list) {
  if (!Array.isArray(list)) {
    return [];
  }

  return list
    .map((entry) => {
      const normalized = normalizeReading(entry);
      if (!normalized) {
        return null;
      }
      const timestampMs = toMs(normalized.timestamp);
      if (!timestampMs) {
        return null;
      }
      return {
        ...normalized,
        timestampMs,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.timestampMs - b.timestampMs);
}

function normalizeAlert(source) {
  if (!source || typeof source !== "object") {
    return null;
  }

  const timestampKey = pick(source, ["timestamp", "ts", "time", "created_at", "at"]);
  const stateKey = pick(source, ["state", "status"]);
  const reasonKey = pick(source, ["reason", "motivo", "message", "description"]);
  const temperatureKey = pick(source, ["temperature", "temp", "t"]);

  const timestampMs = toMs(timestampKey ? source[timestampKey] : null);
  if (!timestampMs) {
    return null;
  }

  return {
    id: `${timestampMs}-${Math.random().toString(36).slice(2, 10)}`,
    timestampMs,
    state: normalizeState(stateKey ? source[stateKey] : null),
    reason: reasonKey ? String(source[reasonKey]) : "Motivo não informado",
    temperature: temperatureKey ? source[temperatureKey] : null,
  };
}

function normalizeAlertsList(list) {
  if (!Array.isArray(list)) {
    return [];
  }

  return list
    .map((item) => normalizeAlert(item))
    .filter(Boolean)
    .sort((a, b) => b.timestampMs - a.timestampMs)
    .slice(0, 100);
}

function formatAlertDate(value) {
  return new Date(value).toLocaleDateString("pt-BR");
}

function formatAlertTime(value) {
  return new Date(value).toLocaleTimeString("pt-BR");
}

function alertStateLabel(value) {
  if (value === "ATENCAO") {
    return "ATENÇÃO";
  }
  if (value === "ALARME") {
    return "ALARME";
  }
  if (value === "OK") {
    return "OK";
  }
  return "SEM DADOS";
}

function alertStateClass(value) {
  if (value === "ALARME") {
    return "alert-tag alert-tag-alarm";
  }
  if (value === "ATENCAO") {
    return "alert-tag alert-tag-attention";
  }
  return "alert-tag";
}

function formatTemp(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return "—";
  }
  return `${Number(value).toFixed(1).replace(".", ",")} °C`;
}

function formatHumidity(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return "—";
  }
  return `${Math.round(Number(value))}%`;
}

function formatDistance(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return "—";
  }
  return `${Number(value).toFixed(1).replace(".", ",")} cm`;
}

function formatRemaining(value) {
  if (value === null || value === undefined) {
    return "Estável";
  }

  const total = Math.max(0, Math.round(Number(value)));
  if (!Number.isFinite(total)) {
    return "Estável";
  }

  const minutes = Math.floor(total / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function stateLabel(state) {
  if (state === "ATENCAO") {
    return "ATENÇÃO";
  }
  if (state === "ALARME") {
    return "ALARME";
  }
  if (state === "OK") {
    return "OK";
  }
  return "SEM DADOS";
}

function stateTitle(state) {
  if (state === "ATENCAO") {
    return "Atenção operacional";
  }
  if (state === "ALARME") {
    return "Intervenção imediata";
  }
  if (state === "OK") {
    return "Faixa segura";
  }
  return "Sem dados do Arduino";
}

function stateDescription(state) {
  if (state === "ATENCAO") {
    return "Verifique a caixa térmica. O backend sinalizou condição de atenção.";
  }
  if (state === "ALARME") {
    return "Risco para a conservação. O backend sinalizou condição de alarme.";
  }
  if (state === "OK") {
    return "Leituras em condição segura de operação.";
  }
  return "Aguardando snapshot inicial ou reconexão do WebSocket.";
}

function sectionStateClass(state) {
  if (state === "SEM_DADOS") {
    return "status-section status-offline";
  }
  if (state === "ATENCAO") {
    return "status-section status-attention";
  }
  if (state === "ALARME") {
    return "status-section status-alarm";
  }
  return "status-section";
}

function badgeClass(state) {
  if (state === "ATENCAO") {
    return "value-state value-attention";
  }
  if (state === "ALARME") {
    return "value-state value-alarm";
  }
  return "value-state value-ok";
}

function useRealtimeDashboard(socketUrl) {
  const [connection, setConnection] = useState("connecting");
  const [snapshotLoaded, setSnapshotLoaded] = useState(false);
  const [reading, setReading] = useState(null);
  const [readings, setReadings] = useState([]);
  const [alerts, setAlerts] = useState([]);
  const [safeRange, setSafeRange] = useState(DEFAULT_SAFE_RANGE);
  const [lastEventAt, setLastEventAt] = useState(null);
  const socketRef = useRef(null);
  const reconnectRef = useRef(null);
  const shouldReconnectRef = useRef(true);

  useEffect(() => {
    if (!socketUrl) {
      setConnection("disconnected");
      return undefined;
    }

    shouldReconnectRef.current = true;

    const connect = () => {
      setConnection("connecting");
      const ws = new WebSocket(socketUrl);
      socketRef.current = ws;

      ws.onopen = () => {
        setConnection("connected");
      };

      ws.onmessage = (event) => {
        let parsed;
        try {
          parsed = JSON.parse(event.data);
        } catch {
          return;
        }

        const eventType = parsed?.type || parsed?.event || parsed?.kind;
        const payload = parsed?.data ?? parsed;
        const now = Date.now();

        if (eventType === "snapshot" || (!eventType && (payload?.readings || payload?.snapshot))) {
          const snapshotPayload = payload?.snapshot || payload;
          const normalized = buildStateFromSnapshot(snapshotPayload);
          const normalizedReadings = normalizeReadingsList(snapshotPayload?.readings);
          const normalizedAlerts = normalizeAlertsList(snapshotPayload?.alerts);
          const baseTs = normalized?.timestampMs || normalizedReadings[normalizedReadings.length - 1]?.timestampMs;

          if (normalized) {
            setReading(normalized);
          } else if (normalizedReadings.length) {
            setReading(normalizedReadings[normalizedReadings.length - 1]);
          }
          if (normalized || normalizedReadings.length || normalizedAlerts.length) {
            setReadings(baseTs ? trimReadings(normalizedReadings, baseTs) : normalizedReadings);
            setAlerts(normalizedAlerts);
            setSafeRange(normalizeSafeRange(snapshotPayload?.config || snapshotPayload));
            setSnapshotLoaded(true);
            setLastEventAt(now);
          }
          return;
        }

        if (eventType === "config") {
          setSafeRange(normalizeSafeRange(payload));
          return;
        }

        if (
          eventType === "reading" ||
          (!eventType &&
            (payload?.temperature !== undefined || payload?.reading?.temperature !== undefined))
        ) {
          const normalized = normalizeReading(payload?.reading || payload?.current || payload);
          if (normalized) {
            const normalizedWithTs = {
              ...normalized,
              timestampMs: toMs(normalized.timestamp) ?? now,
            };
            setReading(normalizedWithTs);
            setReadings((current) => trimReadings([...current, normalizedWithTs], normalizedWithTs.timestampMs));
            setSnapshotLoaded(true);
            setLastEventAt(now);
          }
          return;
        }

        if (
          eventType === "alert" ||
          (!eventType &&
            (payload?.reason !== undefined ||
              payload?.motivo !== undefined ||
              payload?.alert?.reason !== undefined))
        ) {
          const normalizedAlert = normalizeAlert(payload?.alert || payload);
          if (normalizedAlert) {
            setAlerts((current) => [normalizedAlert, ...current].slice(0, 100));
            setLastEventAt(now);
          }
        }
      };

      ws.onclose = () => {
        setConnection("disconnected");
        socketRef.current = null;
        if (shouldReconnectRef.current) {
          reconnectRef.current = setTimeout(connect, 3000);
        }
      };

      ws.onerror = () => {
        ws.close();
      };
    };

    connect();

    return () => {
      shouldReconnectRef.current = false;
      if (reconnectRef.current) {
        clearTimeout(reconnectRef.current);
      }
      if (socketRef.current) {
        socketRef.current.close();
      }
    };
  }, [socketUrl]);

  const sendRange = (min, max) => {
    const ws = socketRef.current;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "set_range", min, max }));
    }
  };

  return { connection, snapshotLoaded, reading, readings, alerts, safeRange, lastEventAt, sendRange };
}

function RangeForm({ safeRange, onSave, disabled }) {
  const [min, setMin] = useState(String(safeRange.min));
  const [max, setMax] = useState(String(safeRange.max));

  useEffect(() => {
    setMin(String(safeRange.min));
    setMax(String(safeRange.max));
  }, [safeRange.min, safeRange.max]);

  const minN = Number(min);
  const maxN = Number(max);
  const valid = min !== "" && max !== "" && minN >= 0 && minN < maxN && maxN <= 50;

  return (
    <form
      className="range-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (valid) onSave(minN, maxN);
      }}
    >
      <span className="kicker">Faixa segura (°C)</span>
      <input type="number" step="0.5" min="0" max="50" value={min} onChange={(e) => setMin(e.target.value)} aria-label="Mínimo" />
      <span>a</span>
      <input type="number" step="0.5" min="0" max="50" value={max} onChange={(e) => setMax(e.target.value)} aria-label="Máximo" />
      <button type="submit" disabled={!valid || disabled}>Salvar</button>
    </form>
  );
}

function App() {
  const apiUrl = import.meta.env.VITE_API_URL || "";
  const wsUrl = import.meta.env.VITE_WS_URL || toWsFromApi(apiUrl);
  const { connection, snapshotLoaded, reading, readings, alerts, safeRange, lastEventAt, sendRange } =
    useRealtimeDashboard(wsUrl);
  const [modalOpen, setModalOpen] = useState(false);
  const now = Date.now();
  const stale = reading?.timestampMs ? now - reading.timestampMs > WINDOW_STALE_MS : false;
  const recentAlerts = useMemo(() => alerts.slice(0, 5), [alerts]);

  const effectiveState = useMemo(() => {
    if (!snapshotLoaded || !reading) {
      return "SEM_DADOS";
    }
    if (reading.arduinoOnline === false || stale) {
      return "SEM_DADOS";
    }
    return reading.state || "SEM_DADOS";
  }, [reading, snapshotLoaded, stale]);

  const connectionText =
    connection === "connected"
      ? "Conectado"
      : connection === "connecting"
        ? "Conectando"
        : "Conexão indisponível (tentando reconectar)";

  const arduinoText =
    reading?.arduinoOnline === false || stale || !snapshotLoaded
      ? "Sem dados do Arduino"
      : "Arduino online";

  const updatedText = lastEventAt ? new Date(lastEventAt).toLocaleTimeString("pt-BR") : "—";
  const connectionDotClass = connection === "connected" ? "dot dot-ok" : "dot dot-alarm";
  const arduinoDotClass =
    reading?.arduinoOnline === false || stale || !snapshotLoaded ? "dot dot-alarm" : "dot dot-ok";

  useEffect(() => {
    if (!modalOpen) {
      return undefined;
    }

    const handleKeyDown = (event) => {
      if (event.key === "Escape") {
        setModalOpen(false);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [modalOpen]);

  return (
    <main className="dashboard">
      <header className="topbar">
        <div className="topbar-brand">
          <h1>TermoGuarda</h1>
          <p>Caixa térmica · Posto de saúde</p>
        </div>
        <div className="topbar-meta">
          <span className="meta-status">
            <i className={connectionDotClass} />
            {connectionText}
          </span>
          <span className="meta-status">
            <i className={arduinoDotClass} />
            {arduinoText}
          </span>
          <span className="meta-clock">{new Date().toLocaleString("pt-BR")}</span>
        </div>
      </header>

      <section className={sectionStateClass(effectiveState)}>
        <div>
          <span className="kicker">Estado atual</span>
          <strong className={badgeClass(effectiveState)}>{stateLabel(effectiveState)}</strong>
        </div>
        <div className="status-copy">
          <h2>{stateTitle(effectiveState)}</h2>
          <p>{stateDescription(effectiveState)}</p>
          <small>Última atualização: {updatedText}</small>
        </div>
      </section>

      <section className="metrics-grid">
        <article>
          <span className="kicker">Temperatura</span>
          <strong>{formatTemp(reading?.temperature)}</strong>
          <small>
            Faixa segura {safeRange.min.toString().replace(".", ",")} °C a{" "}
            {safeRange.max.toString().replace(".", ",")} °C
          </small>
        </article>
        <article>
          <span className="kicker">Tempo até {safeRange.max.toString().replace(".", ",")} °C</span>
          <strong>{formatRemaining(reading?.remainingSeconds)}</strong>
          <small>{reading?.remainingSeconds === null ? "Temperatura estável" : "Estimativa atual"}</small>
        </article>
        <article>
          <span className="kicker">Porta</span>
          <strong>
            {reading?.doorOpen === null || reading?.doorOpen === undefined
              ? "—"
              : reading.doorOpen
                ? "Aberta"
                : "Fechada"}
          </strong>
          <small>Distância: {formatDistance(reading?.distance)}</small>
        </article>
        <article>
          <span className="kicker">Umidade</span>
          <strong>{formatHumidity(reading?.humidity)}</strong>
          <small>Leitura relativa interna</small>
        </article>
      </section>

      <section className="bottom-grid">
        <article className="panel">
          <div className="panel-header">
            <h3>Últimos 5 minutos</h3>
          </div>
          <div className="chart-legend">
            <span>
              <i className="legend-safe" />
              Faixa segura
            </span>
            <span>
              <i className="legend-door" />
              Porta aberta
            </span>
            <span>
              <i className="legend-alert" />
              Fora da faixa
            </span>
          </div>
          <TemperatureChart readings={readings} safeRange={safeRange} />
          <RangeForm safeRange={safeRange} onSave={sendRange} disabled={connection !== "connected"} />
        </article>
        <article className="panel">
          <div className="panel-header">
            <h3>Alertas</h3>
            <span className="alerts-count">{alerts.length} registrados</span>
          </div>
          {recentAlerts.length ? (
            <div className="alerts-list">
              {recentAlerts.map((alertItem) => (
                <div className="alerts-item" key={alertItem.id}>
                  <span className="alerts-time">{formatAlertTime(alertItem.timestampMs)}</span>
                  <div className="alerts-body">
                    <strong>{alertItem.reason}</strong>
                    <small>
                      {formatAlertDate(alertItem.timestampMs)} · {formatTemp(alertItem.temperature)}
                    </small>
                  </div>
                  <span className={alertStateClass(alertItem.state)}>{alertStateLabel(alertItem.state)}</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="alerts-empty">Nenhum alerta registrado</p>
          )}
          <button type="button" className="ghost-button" onClick={() => setModalOpen(true)}>
            Ver histórico completo
          </button>
        </article>
      </section>

      <footer className="footer">
        <span>API: {apiUrl || "não configurada"}</span>
        <span>WS: {wsUrl || "não configurado"}</span>
      </footer>

      {modalOpen ? (
        <div className="modal-backdrop" onClick={() => setModalOpen(false)}>
          <div className="modal" role="dialog" aria-label="Histórico de alertas" onClick={(event) => event.stopPropagation()}>
            <div className="modal-header">
              <h4>Histórico de alertas</h4>
              <button type="button" className="modal-close" aria-label="Fechar" onClick={() => setModalOpen(false)}>
                X
              </button>
            </div>
            <p className="modal-subtitle">Mais recentes primeiro, limitado a 100 registros em memória.</p>
            <div className="modal-table-wrap">
              <table className="alerts-table">
                <thead>
                  <tr>
                    <th>Data</th>
                    <th>Hora</th>
                    <th>Estado</th>
                    <th>Motivo</th>
                    <th>Temperatura</th>
                  </tr>
                </thead>
                <tbody>
                  {alerts.length ? (
                    alerts.map((alertItem) => (
                      <tr key={`full-${alertItem.id}`}>
                        <td>{formatAlertDate(alertItem.timestampMs)}</td>
                        <td>{formatAlertTime(alertItem.timestampMs)}</td>
                        <td>
                          <span className={alertStateClass(alertItem.state)}>{alertStateLabel(alertItem.state)}</span>
                        </td>
                        <td>{alertItem.reason}</td>
                        <td>{formatTemp(alertItem.temperature)}</td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan={5}>Nenhum alerta registrado</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}

export default App;
