// src/main.jsx
import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App.jsx";
import "./index.css";
import { persistenceReady } from "./lib/firebase"; // 👈 importa la promesa

(async () => {
  // Espera a que Firestore habilite la persistencia (multi-tab o fallback)
  try {
    await persistenceReady;
  } catch (e) {
    console.warn("App seguirá sin cache offline:", e);
  }

  ReactDOM.createRoot(document.getElementById("root")).render(
    <React.StrictMode>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </React.StrictMode>
  );
})();
