const apiUrl = import.meta.env.VITE_API_URL;
const wsUrl = import.meta.env.VITE_WS_URL;

function App() {
  return (
    <main className="app-shell">
      <header className="app-header">
        <h1>TermoGuarda</h1>
        <p>Dashboard em preparação para integração em tempo real.</p>
      </header>
      <section className="app-info">
        <p>
          API: <code>{apiUrl || "Não configurada"}</code>
        </p>
        <p>
          WebSocket: <code>{wsUrl || "Não configurado"}</code>
        </p>
      </section>
    </main>
  );
}

export default App;
