import { useEffect, useMemo, useRef, useState } from "react";

const WINDOW_STALE_MS = 15000;

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

  const sourceReading =
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
          if (normalized) {
            setReading(normalized);
            setSnapshotLoaded(true);
            setLastEventAt(now);
          }
          return;
        }

        if (
          eventType === "reading" ||
          (!eventType &&
            (payload?.temperature !== undefined || payload?.reading?.temperature !== undefined))
        ) {
          const normalized = normalizeReading(payload?.reading || payload?.current || payload);
          if (normalized) {
            setReading({
              ...normalized,
              timestampMs: toMs(normalized.timestamp) ?? now,
            });
            setSnapshotLoaded(true);
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

  return { connection, snapshotLoaded, reading, lastEventAt };
}

function App() {
  const apiUrl = import.meta.env.VITE_API_URL || "";
  const wsUrl = import.meta.env.VITE_WS_URL || toWsFromApi(apiUrl);
  const { connection, snapshotLoaded, reading, lastEventAt } = useRealtimeDashboard(wsUrl);
  const now = Date.now();
  const stale = reading?.timestampMs ? now - reading.timestampMs > WINDOW_STALE_MS : false;

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

  return (
    <main className="dashboard">
      <header className="topbar">
        <div className="topbar-brand">
          <h1>TermoGuarda</h1>
          <p>Caixa térmica · Posto de saúde</p>
        </div>
        <div className="topbar-meta">
          <span>{connectionText}</span>
          <span>{arduinoText}</span>
          <span>{new Date().toLocaleString("pt-BR")}</span>
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
          <small>Faixa segura definida pelo backend</small>
        </article>
        <article>
          <span className="kicker">Tempo até 8 °C</span>
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
          <p>Estrutura visual pronta. O gráfico em tempo real entra na BAG-142.</p>
        </article>
        <article className="panel">
          <div className="panel-header">
            <h3>Alertas</h3>
          </div>
          <p>Histórico de alertas será integrado na BAG-143.</p>
          <button type="button" className="ghost-button" disabled>
            Ver histórico completo
          </button>
        </article>
      </section>

      <footer className="footer">
        <span>API: {apiUrl || "não configurada"}</span>
        <span>WS: {wsUrl || "não configurado"}</span>
      </footer>
    </main>
  );
}

export default App;
