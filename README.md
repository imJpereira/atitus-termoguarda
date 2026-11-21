# TermoGuarda

Monitor de cadeia fria para vacinas e medicamentos em apagões e ondas de calor. Estima o tempo até a temperatura sair da faixa segura de 2–8 °C.

Projeto final de Hardware Architecture (Ciência da Computação, Universidade Atitus). Tema: Mudanças Climáticas e Cidades Resilientes.

## Estrutura

- `api/`: API da Raspberry Pi (Python, FastAPI, `uv`)
- `web/`: aplicação web em tempo real (React, Vite)
- `docs/`: documentação do projeto

## Stack do projeto

- **Arduino:** C++ (Arduino IDE), sensores DHT11 e HC-SR04, LEDs, buzzer e botão.
- **Raspberry Pi:** Raspberry Pi OS, Python, `pyserial`, FastAPI com `uvicorn` e WebSocket.
- **Ambiente Python:** `uv` (obrigatório).
- **Banco de dados:** SQLite, só para o histórico de alertas.
- **Web:** React com Vite, em projeto separado rodando no notebook.
- **Deploy:** tudo local, na rede da faculdade.
- **Versionamento:** Git e GitHub.

## Como rodar

### API (Raspberry Pi)

Requer o [`uv`](https://docs.astral.sh/uv/) instalado.

```bash
cd api
uv sync
uv run uvicorn main:app --host 0.0.0.0 --port 8000
```

### Web (notebook)

Requer Node.js e npm.

```bash
cd web
cp .env.example .env
npm install
npm run dev
```

Ajuste `VITE_API_URL` no `.env` para o endereço da API (por exemplo `http://<ip-da-pi>:8000`).

As instruções de montagem do circuito serão adicionadas conforme o projeto avança.
