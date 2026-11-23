from contextlib import asynccontextmanager
import math
import os
import threading
from fastapi import FastAPI, HTTPException
import serial

SERIAL_PORT = os.getenv("SERIAL_PORT", "/dev/ttyACM0")
BAUD_RATE = 9600
VALID_STATES = {"OK", "ATENCAO", "ALARME"}

serial_conn = None
serial_lock = threading.Lock()
stop_event = threading.Event()
current_state = "OK"
latest_reading = None


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
    global serial_conn, latest_reading
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
                latest_reading = reading
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


@asynccontextmanager
async def lifespan(_: FastAPI):
    stop_event.clear()
    thread = threading.Thread(target=serial_worker, daemon=True)
    thread.start()
    yield
    stop_event.set()
    thread.join(timeout=2)
    with serial_lock:
        if serial_conn is not None and serial_conn.is_open:
            try:
                serial_conn.close()
            except (serial.SerialException, OSError):
                pass


app = FastAPI(title="TermoGuarda API", lifespan=lifespan)


@app.get("/health")
def health():
    return {
        "status": "ok",
        "state": current_state,
        "reading": latest_reading,
    }


@app.post("/state/{state}")
def set_state(state: str):
    global current_state
    normalized = state.upper()
    if normalized not in VALID_STATES:
        raise HTTPException(status_code=400, detail="Invalid state")
    current_state = normalized
    sent = send_state(current_state)
    return {"state": current_state, "sent": sent}


