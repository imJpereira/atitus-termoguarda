import asyncio
from collections import deque
from contextlib import asynccontextmanager, closing, suppress
import math
import os
import sqlite3
import threading
import time
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
import serial

SERIAL_PORT = os.getenv("SERIAL_PORT", "/dev/ttyACM0")
DB_PATH = os.getenv("DB_PATH", "alerts.db")
BAUD_RATE = 9600
SAFE_MIN_C = 2.0
SAFE_MAX_C = 8.0
DOOR_OPEN_LIMIT_CM = 10.0
DOOR_OPEN_SECONDS = 15.0
REMAINING_WARNING_SECONDS = 30.0
TREND_WINDOW_SECONDS = 60.0
READINGS_WINDOW_SECONDS = 300.0
ARDUINO_ONLINE_TIMEOUT_SECONDS = 3.0
MAX_READINGS = 300

serial_conn = None
serial_lock = threading.Lock()
stop_event = threading.Event()
current_state = "OK"
latest_reading = None
readings = deque(maxlen=MAX_READINGS)
door_open_since = None
clients: set[WebSocket] = set()
main_loop: asyncio.AbstractEventLoop | None = None


def init_db():
    with closing(sqlite3.connect(DB_PATH)) as conn, conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS alerts (
                timestamp REAL NOT NULL,
                state TEXT NOT NULL,
                temperature REAL,
                reason TEXT NOT NULL
            )
            """
        )


def save_alert(timestamp: float, state: str, temperature: float | None, reason: str):
    init_db()
    with closing(sqlite3.connect(DB_PATH)) as conn, conn:
        conn.execute(
            "INSERT INTO alerts (timestamp, state, temperature, reason) VALUES (?, ?, ?, ?)",
            (timestamp, state, temperature, reason),
        )


def get_alerts(limit: int = 100) -> list[dict]:
    init_db()
    with closing(sqlite3.connect(DB_PATH)) as conn:
        rows = conn.execute(
            "SELECT timestamp, state, temperature, reason FROM alerts ORDER BY timestamp DESC, rowid DESC LIMIT ?",
            (limit,),
        ).fetchall()
    return [
        {
            "timestamp": row[0],
            "state": row[1],
            "temperature": row[2],
            "reason": row[3],
        }
        for row in rows
    ]


def parse_reading(line: str):
    parts = line.split(",")
    if len(parts) != 3:
        return None
    t_part, h_part, d_part = parts
    if not (t_part.startswith("T:") and h_part.startswith("H:") and d_part.startswith("D:")):
        return None
    t_val, h_val, d_val = t_part[2:], h_part[2:], d_part[2:]
    try:
        temperature = None if t_val == "ERR" else float(t_val)
        humidity = None if h_val == "ERR" else float(h_val)
        distance = float(d_val)
    except ValueError:
        return None
    if (
        (temperature is not None and not math.isfinite(temperature))
        or (humidity is not None and not math.isfinite(humidity))
        or not math.isfinite(distance)
    ):
        return None
    return {
        "temperature": temperature,
        "humidity": humidity,
        "distance": distance,
    }


def estimate_remaining_seconds(current_temp: float | None, now: float) -> int | None:
    if current_temp is None or current_temp > SAFE_MAX_C:
        return None
    cutoff = now - TREND_WINDOW_SECONDS
    oldest = None
    for item in readings:
        if item["timestamp"] >= cutoff and item["temperature"] is not None:
            oldest = item
            break
    if oldest is None:
        return None
    dt = now - oldest["timestamp"]
    if dt <= 0:
        return None
    rate_per_sec = (current_temp - oldest["temperature"]) / dt
    if rate_per_sec <= 0:
        return None
    return max(0, round((SAFE_MAX_C - current_temp) / rate_per_sec))


def evaluate_state(
    temperature: float | None,
    humidity: float | None,
    door_open: bool,
    door_open_duration: float,
    remaining_seconds: int | None,
) -> tuple[str, str | None]:
    if temperature is None or humidity is None:
        return "ALARME", "falha do sensor"
    if temperature < SAFE_MIN_C or temperature > SAFE_MAX_C:
        return "ALARME", "temperatura fora da faixa"
    if door_open and door_open_duration >= DOOR_OPEN_SECONDS:
        return "ATENCAO", "porta aberta"
    if remaining_seconds is not None and remaining_seconds < REMAINING_WARNING_SECONDS:
        return "ATENCAO", "tempo restante baixo"
    return "OK", None


def process_reading(parsed: dict, now: float | None = None) -> dict:
    global current_state, latest_reading, door_open_since
    if now is None:
        now = time.time()
    temperature = parsed["temperature"]
    humidity = parsed["humidity"]
    distance = parsed["distance"]
    door_open = distance < 0 or distance > DOOR_OPEN_LIMIT_CM
    if door_open:
        if door_open_since is None:
            door_open_since = now
        door_open_duration = now - door_open_since
    else:
        door_open_since = None
        door_open_duration = 0.0

    remaining_seconds = estimate_remaining_seconds(temperature, now)
    state, reason = evaluate_state(
        temperature,
        humidity,
        door_open,
        door_open_duration,
        remaining_seconds,
    )
    entry = {
        "timestamp": now,
        "temperature": temperature,
        "humidity": humidity,
        "distance": distance,
        "door_open": door_open,
        "state": state,
        "remaining_seconds": remaining_seconds,
        "reason": reason,
    }
    readings.append(entry)
    if state in ("ATENCAO", "ALARME") and state != current_state and reason is not None:
        save_alert(now, state, temperature, reason)
        alert = {
            "type": "alert",
            "timestamp": now,
            "state": state,
            "temperature": temperature,
            "reason": reason,
        }
        if main_loop is not None:
            asyncio.run_coroutine_threadsafe(broadcast(alert), main_loop)
    current_state = state
    latest_reading = entry
    return entry


def is_arduino_online(now: float | None = None) -> bool:
    if now is None:
        now = time.time()
    if latest_reading is None or serial_conn is None or not serial_conn.is_open:
        return False
    return (now - latest_reading["timestamp"]) <= ARDUINO_ONLINE_TIMEOUT_SECONDS


def build_reading(now: float | None = None) -> dict:
    if now is None:
        now = time.time()
    reading = latest_reading or {}
    return {
        "type": "reading",
        "timestamp": reading.get("timestamp", now),
        "temperature": reading.get("temperature"),
        "humidity": reading.get("humidity"),
        "distance": reading.get("distance"),
        "state": reading.get("state", current_state),
        "remaining_seconds": reading.get("remaining_seconds"),
        "door_open": reading.get("door_open"),
        "arduino_online": is_arduino_online(now),
    }


def build_snapshot(now: float | None = None) -> dict:
    if now is None:
        now = time.time()
    reading = latest_reading or {}
    cutoff = now - READINGS_WINDOW_SECONDS
    recent_readings = [
        {
            "timestamp": item["timestamp"],
            "temperature": item["temperature"],
            "humidity": item["humidity"],
            "distance": item["distance"],
            "door_open": item["door_open"],
        }
        for item in readings
        if item["timestamp"] >= cutoff
    ]
    return {
        "type": "snapshot",
        "config": {
            "range_min": SAFE_MIN_C,
            "range_max": SAFE_MAX_C,
            "door_open_seconds": DOOR_OPEN_SECONDS,
            "remaining_warning_seconds": REMAINING_WARNING_SECONDS,
        },
        "state": {
            "temperature": reading.get("temperature"),
            "humidity": reading.get("humidity"),
            "distance": reading.get("distance"),
            "state": reading.get("state", current_state),
            "remaining_seconds": reading.get("remaining_seconds"),
            "door_open": reading.get("door_open"),
            "arduino_online": is_arduino_online(now),
        },
        "readings": recent_readings,
        "alerts": get_alerts(100),
    }


def send_state(state: str) -> bool:
    with serial_lock:
        if serial_conn is None or not serial_conn.is_open:
            return False
        try:
            serial_conn.write(f"S:{state}\n".encode("utf-8"))
            serial_conn.flush()
            return True
        except (serial.SerialException, OSError):
            return False


def serial_worker():
    global serial_conn
    while not stop_event.is_set():
        try:
            if serial_conn is None or not serial_conn.is_open:
                with serial_lock:
                    serial_conn = serial.Serial(SERIAL_PORT, BAUD_RATE, timeout=1)
            raw = serial_conn.readline()
            if not raw:
                continue
            line = raw.decode("utf-8", errors="ignore").strip()
            if not line:
                continue
            if line == "B:1":
                print("B:1", flush=True)
                continue
            reading = parse_reading(line)
            if reading is not None:
                process_reading(reading)
                print(line, flush=True)
                send_state(current_state)
        except (serial.SerialException, OSError):
            with serial_lock:
                if serial_conn is not None:
                    try:
                        serial_conn.close()
                    except (serial.SerialException, OSError):
                        pass
                    serial_conn = None
            stop_event.wait(1)


async def broadcast(message: dict):
    for client in list(clients):
        try:
            await client.send_json(message)
        except Exception:
            clients.discard(client)


async def reading_broadcaster():
    while not stop_event.is_set():
        await asyncio.sleep(1)
        await broadcast(build_reading())


@asynccontextmanager
async def lifespan(_: FastAPI):
    global main_loop
    init_db()
    stop_event.clear()
    main_loop = asyncio.get_running_loop()
    thread = threading.Thread(target=serial_worker, daemon=True)
    thread.start()
    broadcaster_task = asyncio.create_task(reading_broadcaster())
    yield
    stop_event.set()
    broadcaster_task.cancel()
    with suppress(asyncio.CancelledError):
        await broadcaster_task
    main_loop = None
    thread.join(timeout=2)
    with serial_lock:
        if serial_conn is not None and serial_conn.is_open:
            try:
                serial_conn.close()
            except (serial.SerialException, OSError):
                pass


app = FastAPI(title="TermoGuarda API", lifespan=lifespan)


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    clients.add(websocket)
    try:
        await websocket.send_json(build_snapshot())
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        clients.discard(websocket)
