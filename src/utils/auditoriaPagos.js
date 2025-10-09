// src/utils/auditoriaPagos.js
import {
  collection,
  query,
  where,
  getCountFromServer,
  getDocs,
  Timestamp,
  orderBy,
} from "firebase/firestore";
import { db } from "../lib/firebase";

// YYYY-MM-DD -> Date at local 00:00 / 23:59:59
const toRange = (fromISO, toISO) => {
  const start = new Date(`${fromISO}T00:00:00`);
  const end = new Date(`${toISO}T23:59:59`);
  return {
    startTs: Timestamp.fromDate(start),
    endTs: Timestamp.fromDate(end),
  };
};

export async function auditPagos({
  fromISO,           // "2025-10-01"
  toISO,             // "2025-10-31"
  pon = null,        // e.g. "2 MAV" (opcional)
  collectorEmail = null, // e.g. "jefferson@..." (opcional)
}) {
  const { startTs, endTs } = toRange(fromISO, toISO);

  // Query base: pagos aprobados en el rango de fechas
  let q = query(
    collection(db, "payments"),
    where("status", "==", "approved"),
    where("approvedAt", ">=", startTs),
    where("approvedAt", "<=", endTs),
    orderBy("approvedAt", "asc")
  );
  if (pon) q = query(q, where("pon", "==", pon));
  if (collectorEmail) q = query(q, where("collectorEmail", "==", collectorEmail));

  // 1) Conteo eficiente (no descarga todos los docs)
  const countSnap = await getCountFromServer(q);
  const totalPayments = Number(countSnap.data().count || 0);

  // 2) Para clientes únicos y suma de montos sí necesitamos leer docs
  const snap = await getDocs(q);

  let totalAmount = 0;
  const clientes = new Set();
  const breakdownPorDia = new Map(); // "YYYY-MM-DD" -> {count, amount}

  const ymd = (d) => {
    const x = d instanceof Date ? d : d.toDate?.() || new Date(d);
    const Y = x.getFullYear();
    const M = String(x.getMonth() + 1).padStart(2, "0");
    const D = String(x.getDate()).padStart(2, "0");
    return `${Y}-${M}-${D}`;
  };

  snap.forEach((doc) => {
    const data = doc.data();
    const cid = data.clientId || data.customerId || data.clienteId || data.uidCliente;
    if (cid) clientes.add(cid);
    const amt = Number(data.amount || 0);
    totalAmount += amt;

    const k = ymd(data.approvedAt);
    const prev = breakdownPorDia.get(k) || { count: 0, amount: 0 };
    prev.count += 1;
    prev.amount += amt;
    breakdownPorDia.set(k, prev);
  });

  // Convertir breakdown a arreglo ordenado por fecha
  const breakdown = Array.from(breakdownPorDia.entries())
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([date, v]) => ({ date, count: v.count, amount: Number(v.amount.toFixed(2)) }));

  return {
    range: { fromISO, toISO, pon, collectorEmail },
    totals: {
      totalPayments,
      uniqueClients: clientes.size,
      totalAmount: Number(totalAmount.toFixed(2)),
    },
    breakdown, // por día
  };
}
