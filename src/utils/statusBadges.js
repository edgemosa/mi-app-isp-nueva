// src/utils/statusBadges.js
import { todayISO, diffDays, currentDueDateFromInstall } from "./dates";

/**
 * Calcula el chip de estado visual (texto + “tone”) de forma consistente
 * para ambos paneles.
 *
 * Parámetros:
 * - saldo:       número (restante del mes actual)
 * - exonerado:   boolean
 * - dueISO:      string YYYY-MM-DD (fecha de corte de ESTE mes). Opcional.
 * - overdueDays: número opcional para forzar días de atraso (útil cuando
 *                detectas “mes vencido” por historial y quieres que salga rojo).
 *
 * Retorna: { text, tone } donde tone ∈ "red" | "yellow" | "green" | "purple" | "blue"
 */
export function computeStatusBadge({ saldo = 0, exonerado = false, dueISO = null, overdueDays = undefined, installISO = null } = {}) {
  // 1) Estados terminales
  if (exonerado) return { text: "EXONERADO", tone: "purple" };
  if (Number(saldo) <= 0) return { text: "PAGADO", tone: "blue" };

  // 2) Determinar días de atraso
  const today = todayISO();
  // Si no nos pasan dueISO, tratamos de derivarlo desde la fecha de instalación
  const effectiveDueISO = dueISO || currentDueDateFromInstall(installISO, today);

  let d = 0;
  if (typeof overdueDays === "number") {
    d = overdueDays; // forzado (p.ej. ≥30 para “mes vencido” ⇒ rojo)
  } else if (effectiveDueISO) {
    d = diffDays(effectiveDueISO, today); // >=0 ya llegó el corte
  }

  // 3) Semáforo
  if (d >= 8)  return { text: "PENDIENTE", tone: "red" };
  if (d >= 4)  return { text: "PENDIENTE", tone: "yellow" };
  if (d >= 0)  return { text: "PENDIENTE", tone: "green" };   // llegó al corte pero <4 días
  return { text: "PENDIENTE", tone: "purple" };               // antes del corte (morado)
}

/** Estilos inline según el “tone” (idénticos en ambos paneles) */
export function chipStyle(tone) {
  const MAP = {
    red:    { background: "#fee2e2", color: "#991b1b", border: "1px solid #fecaca" },
    yellow: { background: "#fef9c3", color: "#92400e", border: "1px solid #fde68a" },
    green:  { background: "#dcfce7", color: "#166534", border: "1px solid #bbf7d0" },
    purple: { background: "#f3e8ff", color: "#6b21a8", border: "1px solid #e9d5ff" },
    blue:   { background: "#e0f2fe", color: "#0369a1", border: "1px solid #bae6fd" },
  };
  return MAP[tone] || { background: "#f1f5f9", color: "#0f172a", border: "1px solid #e2e8f0" };
}
