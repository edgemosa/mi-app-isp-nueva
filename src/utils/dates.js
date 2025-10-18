// src/utils/dates.js

/* ==== Fechas básicas (local) ==== */
export function todayISO(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function ymFromISO(iso, fallback = null) {
  if (!iso) return fallback;
  const s = String(iso).slice(0, 7);
  return /^\d{4}-\d{2}$/.test(s) ? s : fallback;
}

export function incYM(ym) {
  let [y, m] = (ym || "").split("-").map(Number);
  if (!y || !m) return ym;
  m += 1;
  if (m === 13) { m = 1; y += 1; }
  return `${y}-${String(m).padStart(2, "0")}`;
}

export function prevYM(ym) {
  const [y, m] = (ym || "").split("-").map(Number);
  if (!y || !m) return ym;
  const Y = m === 1 ? y - 1 : y;
  const M = m === 1 ? 12 : m - 1;
  return `${Y}-${String(M).padStart(2, "0")}`;
}

/* ✅ Comparador YYYY-MM que faltaba */
export const cmpYM = (a, b) => (a === b ? 0 : a > b ? 1 : -1);

/* ==== Utilidades de mes actual ==== */
export function isInCurrentMonth(iso, ymNow = null) {
  if (!iso) return false;
  const now = ymNow || ymFromISO(todayISO());
  return ymFromISO(iso, "") === now;
}

export function isTimestampInCurrentMonth(ts, ymNow = null) {
  if (!ts?.toDate) return false;
  const d = ts.toDate();
  const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  const now = ymNow || ymFromISO(todayISO());
  return ym === now;
}

/* ==== Helpers para semáforo de “pendiente” ==== */
export function parseYMD(iso) {
  if (!iso || typeof iso !== "string") return { y: NaN, m: NaN, d: NaN };
  const [y, m, d] = iso.split("-").map(Number);
  return { y, m, d };
}

export function daysInMonth(y, m /*1-12*/) {
  return new Date(y, m, 0).getDate();
}

/** Diferencia (en días) B - A, usando medianoche local */
export function diffDays(fromISO, toISO = todayISO()) {
  if (!fromISO) return 0;
  const A = new Date(`${fromISO}T00:00:00`);
  const B = new Date(`${toISO}T00:00:00`);
  if (Number.isNaN(A.getTime()) || Number.isNaN(B.getTime())) return 0;
  return Math.floor((B - A) / 86_400_000);
}

/**
 * Dado el día de instalación, obtiene la “fecha de corte” vigente
 * en el mes de refISO (o hoy si no se pasa).
 */
export function currentDueDateFromInstall(installISO, refISO = todayISO()) {
  if (!installISO) return refISO;
  const { d: dayInstall } = parseYMD(installISO);
  const { y, m } = parseYMD(refISO);
  if (!Number.isFinite(dayInstall) || !Number.isFinite(y) || !Number.isFinite(m)) return refISO;

  const dayThisMonth = Math.min(dayInstall, daysInMonth(y, m));
  const dueThisMonth = `${y}-${String(m).padStart(2, "0")}-${String(dayThisMonth).padStart(2, "0")}`;

  // Si todavía no llegamos al día de corte de este mes, usar el del mes pasado
  if (refISO < dueThisMonth) {
    const prev = new Date(`${y}-${String(m).padStart(2, "0")}-01T00:00:00`);
    prev.setDate(0);
    const py = prev.getFullYear();
    const pm = prev.getMonth() + 1;
    const dayPrev = Math.min(dayInstall, daysInMonth(py, pm));
    return `${py}-${String(pm).padStart(2, "0")}-${String(dayPrev).padStart(2, "0")}`;
  }
  return dueThisMonth;
}
