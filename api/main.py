from fastapi import FastAPI

app = FastAPI(title="TermoGuarda API")


@app.get("/health")
def health():
    return {"status": "ok"}

