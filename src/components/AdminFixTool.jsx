// src/components/AdminFixTool.jsx
import React from "react";

export default function AdminFixTool({ onDone }) {
  return (
    <div style={{ padding: 12 }}>
      <h3 style={{ marginTop: 0 }}>🧰 Herramienta de Correcciones</h3>
      <p>Aquí podrás agregar utilidades de corrección.</p>
      <button onClick={onDone}>Cerrar</button>
    </div>
  );
}
