// src/lib/billing.js
export const ymFromISO = (iso, fallbackYM) => {
  if (!iso) return fallbackYM;
  const s = String(iso).slice(0, 7);
  return /^\d{4}-\d{2}$/.test(s) ? s : fallbackYM;
};
export const cmpYM = (a, b) => (a === b ? 0 : a < b ? -1 : 1);
export const incYM = (ym) => {
  let [y, m] = ym.split("-").map(Number);
  m += 1; if (m === 13) { m = 1; y += 1; }
  return `${y}-${String(m).padStart(2, "0")}`;
};
export const planForYM = (client, ym, nowYM) => {
  const plan = Math.max(0, Number(client.plan || 0));
  const installYM = ymFromISO(client.fechaInstalacion, nowYM);
  if (ym === installYM) return 0;
  if (cmpYM(ym, installYM) < 0) return 0;
  return plan;
};
/** approvedMap: Map<clientId, Map<period, amount>> */
export const computeArrearsMonths = (client, nowYM, approvedMap) => {
  if (client.exonerado || !client.fechaInstalacion) return 0;
  const installYM = ymFromISO(client.fechaInstalacion, nowYM);
  const [y, m] = nowYM.split("-").map(Number);
  const prev = `${m === 1 ? y - 1 : y}-${String(m === 1 ? 12 : m - 1).padStart(2, "0")}`;
  const start = incYM(installYM);
  if (cmpYM(start, prev) > 0) return 0;

  let months = 0;
  const perMap = approvedMap.get(client.id) || new Map();
  for (let ym = start; ; ym = incYM(ym)) {
    const planM = planForYM(client, ym, nowYM);
    if (planM > 0) {
      const approved = Number(perMap.get(ym) || 0);
      if (approved + 1e-6 < planM) months += 1;
    }
    if (ym === prev) break;
  }
  return months;
};
