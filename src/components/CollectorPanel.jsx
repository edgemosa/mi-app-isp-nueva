// src/components/CollectorPanel.jsx
import { useEffect, useMemo, useRef, useState } from "react";
import {
  collection,
  query,
  where,
  onSnapshot,
  getDocs,
  addDoc,
  serverTimestamp,
  deleteDoc,
  doc,
  orderBy,
} from "firebase/firestore";
import { db, auth } from "../lib/firebase";
import { signOut } from "firebase/auth";
import localforage from "localforage";

/* =================== Helpers =================== */
const money = (n) =>
  Number(n || 0).toLocaleString("en-US", { style: "currency", currency: "USD" });

const yyyymm = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;

const todayISO = () => new Date().toISOString().slice(0, 10);
const currentPeriod = () => yyyymm();

const prevYM = (ym) => {
  const [y, m] = ym.split("-").map(Number);
  const M = m === 1 ? 12 : m - 1;
  const Y = m === 1 ? y - 1 : y;
  return `${Y}-${String(M).padStart(2, "0")}`;
};

const ymFromISO = (iso) => {
  if (!iso) return null;
  const s = String(iso).slice(0, 7); // YYYY-MM
  return /^\d{4}-\d{2}$/.test(s) ? s : null;
};

const monthsDiffInclusive = (fromYM, toYM) => {
  if (!fromYM || !toYM) return 0;
  const [fy, fm] = fromYM.split("-").map(Number);
  const [ty, tm] = toYM.split("-").map(Number);
  const diff = (ty - fy) * 12 + (tm - fm);
  return diff < 0 ? 0 : diff + 1;
};

const yyyymmFromDate = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;

const cmpYM = (a, b) => (a === b ? 0 : a < b ? -1 : 1);

const incYM = (ym) => {
  let [y, m] = ym.split("-").map(Number);
  m += 1;
  if (m === 13) {
    m = 1;
    y += 1;
  }
  return `${y}-${String(m).padStart(2, "0")}`;
};

const lastDayOfMonth = (y, m /*1-12*/) => new Date(y, m, 0).getDate();

/** Solo para etiqueta “vence hoy”. */
const isExactDueDayThisCycle = (fechaInstalacionISO) => {
  if (!fechaInstalacionISO) return false;
  const install = new Date(`${fechaInstalacionISO}T00:00:00`);
  if (Number.isNaN(install.getTime())) return false;

  const today = new Date();
  if (today < install) return false;

  const y = today.getFullYear();
  const m = today.getMonth() + 1;
  const dayInstall = install.getDate();
  const dueDay = Math.min(dayInstall, lastDayOfMonth(y, m));
  return today.getDate() === dueDay;
};

/* ===== Consolidación igual que Admin ===== */
function paymentKey(p) {
  const clientId = String(p.clientId || "");
  const per = String(p.period || "");
  const batchDate = String(p.batchDate || "");
  const createdBy = String(p.createdBy || "");
  return `${clientId}__${per}__${batchDate}__${createdBy}`;
}

function consolidatePayments(rows) {
  const map = new Map();
  for (const p of rows) {
    const k = paymentKey(p);
    const cur = map.get(k);
    if (!cur) {
      map.set(k, { ...p, amount: Number(p.amount || 0), _ids: [p.id] });
    } else {
      const amt = Number(cur.amount || 0) + Number(p.amount || 0);
      const newer =
        (p.createdAt?.toMillis?.() || 0) > (cur.createdAt?.toMillis?.() || 0) ? p : cur;
      map.set(k, { ...newer, amount: amt, _ids: [...(cur._ids || []), p.id] });
    }
  }
  return Array.from(map.values());
}

/* ===== Helpers de fecha para listas ===== */
const isoLocalDate = (d) => {
  const tz = d.getTimezoneOffset();
  const local = new Date(d.getTime() - tz * 60 * 1000);
  return local.toISOString().slice(0, 10);
};
const formatBatchDateTime = (p) => {
  const datePart = p.batchDate || (p.createdAt?.toDate ? isoLocalDate(p.createdAt.toDate()) : "");
  const timePart = p.createdAt?.toDate?.().toLocaleTimeString?.() || "";
  return (datePart && timePart) ? `${datePart} ${timePart}` : (datePart || "—");
};

/* ======= MISMO cálculo que Admin ======= */
const dueReachedThisMonth = (fechaInstalacionISO) => {
  if (!fechaInstalacionISO) return false;
  const install = new Date(`${fechaInstalacionISO}T00:00:00`);
  if (Number.isNaN(install.getTime())) return false;

  const today = new Date();
  if (today < install) return false;

  const y = today.getFullYear();
  const m = today.getMonth() + 1;
  const dueDay = Math.min(install.getDate(), lastDayOfMonth(y, m));
  const due = new Date(y, m - 1, dueDay, 23, 59, 59);
  return today.getTime() >= due.getTime();
};

const planForYM = (client, ym) => {
  const plan = Math.max(0, Number(client.plan || 0));
  const installYM = ymFromISO(client.fechaInstalacion);
  if (!installYM) return plan;
  if (ym === installYM) return 0;
  if (cmpYM(ym, installYM) < 0) return 0;
  return plan;
};

const computeArrears = (c, ymNowStr, approvedByClientByPeriod) => {
  if (c.exonerado) return 0;
  const installYM = ymFromISO(c.fechaInstalacion);
  const [y, m] = ymNowStr.split("-").map(Number);
  const prev = `${m === 1 ? y - 1 : y}-${String(m === 1 ? 12 : m - 1).padStart(2, "0")}`;

  const start = incYM(installYM);
  if (cmpYM(start, prev) > 0) return 0;

  let theoretical = 0;
  for (let ym = start; ; ym = incYM(ym)) {
    theoretical += planForYM(c, ym);
    if (ym === prev) break;
  }

  let approved = 0;
  const perMap = approvedByClientByPeriod.get(c.id);
  if (perMap) {
    for (const [per, amt] of perMap.entries()) {
      if (cmpYM(per, prev) <= 0) approved += Number(amt || 0);
    }
  }
  return Math.max(theoretical - approved, 0);
};

/* === NUEVOS helpers (idénticos a Admin) para “nuevo del mes” === */
const isInCurrentMonth = (iso) => {
  if (!iso) return false;
  const ym = String(iso).slice(0, 7);
  const now = yyyymm();
  return ym === now;
};
const isTimestampInCurrentMonth = (ts) => {
  if (!ts?.toDate) return false;
  const d = ts.toDate();
  const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  return ym === yyyymm();
};
// diferencia en meses AÑO/MES (ignora el día)
function monthsSinceInstallYM(installISO, ref = new Date()) {
  if (!installISO) return 0;
  const inst = new Date(`${installISO}T00:00:00`);
  if (Number.isNaN(inst.getTime())) return 0;
  return (ref.getFullYear() - inst.getFullYear()) * 12 + (ref.getMonth() - inst.getMonth());
}

const _todayISO = (d = new Date()) => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};
const _daysInMonth = (y, m) => new Date(y, m, 0).getDate();
const _parseYMD = (iso) => {
  if (!iso || typeof iso !== "string") return { y: NaN, m: NaN, d: NaN };
  const [y, m, d] = iso.split("-").map(Number);
  return { y, m, d };
};
const _diffDays = (fromISO, toISO = _todayISO()) => {
  if (!fromISO) return 0;
  const A = new Date(`${fromISO}T00:00:00`);
  const B = new Date(`${toISO}T00:00:00`);
  if (Number.isNaN(A.getTime()) || Number.isNaN(B.getTime())) return 0;
  return Math.floor((B - A) / 86_400_000);
};
const _currentDueDateFromInstall = (installISO, refISO = _todayISO()) => {
  if (!installISO) return refISO;
  const { d: dayInstall } = _parseYMD(installISO);
  const { y, m } = _parseYMD(refISO);
  if (!Number.isFinite(dayInstall) || !Number.isFinite(y) || !Number.isFinite(m)) {
    return refISO;
  }
  const dayThisMonth = Math.min(dayInstall, _daysInMonth(y, m));
  const dueThisMonth = `${y}-${String(m).padStart(2, "0")}-${String(dayThisMonth).padStart(2, "0")}`;
  if (refISO < dueThisMonth) {
    const prev = new Date(`${y}-${String(m).padStart(2, "0")}-01T00:00:00`);
    prev.setDate(0);
    const py = prev.getFullYear();
    const pm = prev.getMonth() + 1;
    const dayPrev = Math.min(dayInstall, _daysInMonth(py, pm));
    return `${py}-${String(pm).padStart(2, "0")}-${String(dayPrev).padStart(2, "0")}`;
  }
  return dueThisMonth;
};
const pendingBadgeForClient = (client, today = _todayISO()) => {
  const dueISO =
    client?._dueISO ||
    _currentDueDateFromInstall(client?.fechaInstalacion, today);
  const delta = _diffDays(dueISO, today);
  let cls = "badge-green";
  if (delta >= 4 && delta <= 7) cls = "badge-yellow";
  else if (delta >= 8) cls = "badge-red";
  return { label: "PENDIENTE", cls };
};
const badgeStyle = (cls) => {
  if (cls === "badge-red")    return { background: "#fee2e2", color: "#991b1b", border: "1px solid #fecaca" };
  if (cls === "badge-yellow") return { background: "#fef9c3", color: "#92400e", border: "1px solid #fde68a" };
  if (cls === "badge-green")  return { background: "#dcfce7", color: "#166534", border: "1px solid #bbf7d0" };
  return { background: "#f1f5f9", color: "#0f172a", border: "1px solid #e2e8f0" };
};

/* === IndexedDB (localforage) para borrador local === */
const draftStore = localforage.createInstance({
  name: "capcorp",
  storeName: "collectorDrafts",
});
async function loadDraft(key) {
  const d = (await draftStore.getItem(key)) || {};
  return {
    carrito: Array.isArray(d.carrito) ? d.carrito : [],
    gastosPendientes: Array.isArray(d.gastosPendientes) ? d.gastosPendientes : [],
  };
}
async function saveDraft(key, data) {
  await draftStore.setItem(key, data);
}
async function clearDraft(key) {
  await draftStore.removeItem(key);
}

/* ====== Orden de PON igual que Admin ====== */
const PON_ORDER = [
  "0 CAP","1 CAP","2 CAP","3 CAP","4 CAP","5 CAP","6 CAP","8 CAP","10 CAP","11 CAP",
  "2 MAV","3 MAV","4 MAV","5 MAV","7 MAV","8 MAV","10 MAV","11 MAV","12 MAV","13 MAV",
  "WIFI",
];

/* =================== Componente =================== */
export default function CollectorPanel() {
  const meEmail = auth.currentUser?.email || "cobrador@capcorp.com";

  // Fecha seleccionada para el lote (por defecto HOY)
  const [batchDate, setBatchDate] = useState(todayISO()); // YYYY-MM-DD
  const PERIOD = ymFromISO(batchDate) || currentPeriod();
  const BILLABLE_YM = prevYM(PERIOD);

  // Borrador local por fecha
  const DRAFT_KEY = useMemo(() => `draft:${meEmail}:${batchDate}`, [meEmail, batchDate]);

  const [clientes, setClientes] = useState([]);

  // pagos para cálculo (¡ahora se guardan ya consolidados!)
  const [approvedAll, setApprovedAll] = useState([]);
  const [submittedAll, setSubmittedAll] = useState([]);

  // Filtros
  const [filtroEstado, setFiltroEstado] = useState("Pendientes");
  const [busqueda, setBusqueda] = useState("");

  // PON (multi)
  const [ponOpen, setPonOpen] = useState(false);
  const [ponSeleccion, setPonSeleccion] = useState([]);
  const ponRef = useRef(null);

  const [expand, setExpand] = useState(null);
  const [pagosCliente, setPagosCliente] = useState({});
  const [error, setError] = useState(null);

  // Enviados del cobrador en la FECHA seleccionada (consolidado)
  const [hoyPagos, setHoyPagos] = useState([]);
  const [hoyPorCliente, setHoyPorCliente] = useState({});

  // Borrador local
  const [carrito, setCarrito] = useState([]);
  const [gastosPendientes, setGastosPendientes] = useState([]);

  // Gastos
  const [gastosOpen, setGastosOpen] = useState(false);
  const [hoyGastos, setHoyGastos] = useState([]);

  /* -------- Borrador local -------- */
  useEffect(() => {
    let alive = true;
    (async () => {
      const d = await loadDraft(DRAFT_KEY);
      if (!alive) return;
      setCarrito(d.carrito);
      setGastosPendientes(d.gastosPendientes);
    })();
    return () => { alive = false; };
  }, [DRAFT_KEY]);

  useEffect(() => {
    saveDraft(DRAFT_KEY, { carrito, gastosPendientes }).catch(() => {});
  }, [carrito, gastosPendientes, DRAFT_KEY]);

  /* -------- Suscripciones -------- */
  useEffect(() => {
    const unsub = onSnapshot(
      query(collection(db, "clients"), orderBy("nombre")),
      (snap) => {
        const arr = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        setClientes(arr);
        setError(null);
      },
      (e) => setError(e.message || String(e))
    );
    return unsub;
  }, []);

  // === IMPORTANTE: consolidamos approved y submitted como en Admin ===
  useEffect(() => {
    const unsub = onSnapshot(
      query(collection(db, "payments"), where("status", "==", "approved")),
      (snap) => {
        const raw = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        setApprovedAll(consolidatePayments(raw));
      },
      (e) => setError(e.message || String(e))
    );
    return unsub;
  }, []);

  useEffect(() => {
    const unsub = onSnapshot(
      query(collection(db, "payments"), where("status", "==", "submitted")),
      (snap) => {
        const raw = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        setSubmittedAll(consolidatePayments(raw));
      },
      (e) => setError(e.message || String(e))
    );
    return unsub;
  }, []);

  // Pagos enviados en la FECHA SELECCIONADA por este cobrador (consolidado)
  useEffect(() => {
    const qhoy = query(
      collection(db, "payments"),
      where("status", "==", "submitted"),
      where("batchDate", "==", batchDate),
      where("createdBy", "==", meEmail)
    );
    const unsub = onSnapshot(
      qhoy,
      (snap) => {
        const listRaw = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        const list = consolidatePayments(listRaw);
        setHoyPagos(list);
        const porCliente = list.reduce((acc, p) => {
          acc[p.clientId] = (acc[p.clientId] || 0) + Number(p.amount || 0);
          return acc;
        }, {});
        setHoyPorCliente(porCliente);
      },
      (e) => setError(e.message || String(e))
    );
    return unsub;
  }, [meEmail, batchDate]);

  // Gastos enviados en la FECHA SELECCIONADA
  useEffect(() => {
    const q = query(
      collection(db, "expenses"),
      where("batchDate", "==", batchDate),
      where("createdBy", "==", meEmail)
    );
    const unsub = onSnapshot(
      q,
      (snap) => {
        const list = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        list.sort((a, b) => {
          const ta = a.createdAt?.toMillis?.() ?? 0;
          const tb = b.createdAt?.toMillis?.() ?? 0;
          return tb - ta;
        });
        setHoyGastos(list);
      },
      (e) => setError(e.message || String(e))
    );
    return unsub;
  }, [meEmail, batchDate]);

  /* -------- Cerrar popover PON al click afuera -------- */
  useEffect(() => {
    function onDown(e) {
      if (ponOpen && ponRef.current && !ponRef.current.contains(e.target)) {
        setPonOpen(false);
      }
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [ponOpen]);

  /* -------- Derivados (totales) -------- */
  const carritoTotal = useMemo(
    () => carrito.reduce((s, it) => s + Number(it.amount || 0), 0),
    [carrito]
  );
  const totalCobradoYa = useMemo(
    () => hoyPagos.reduce((s, p) => s + Number(p.amount || 0), 0),
    [hoyPagos]
  );
  const totalGastosHoy = useMemo(
    () => hoyGastos.reduce((s, g) => s + Number(g.amount || 0), 0),
    [hoyGastos]
  );
  const totalGastosPendientes = useMemo(
    () => gastosPendientes.reduce((s, g) => s + Number(g.amount || 0), 0),
    [gastosPendientes]
  );
  const totalCobrosPrevistos = useMemo(
    () => totalCobradoYa + carritoTotal,
    [totalCobradoYa, carritoTotal]
  );
  const totalGastosPrevistos = useMemo(
    () => totalGastosHoy + totalGastosPendientes,
    [totalGastosHoy, totalGastosPendientes]
  );
  const netoPrevisto = useMemo(
    () => totalCobrosPrevistos - totalGastosPrevistos,
    [totalCobrosPrevistos, totalGastosPrevistos]
  );

  /* -------- Agregados por cliente (desde arrays YA consolidados) -------- */
  const approvedByClient = useMemo(() => {
    const m = new Map();
    for (const p of approvedAll) {
      m.set(p.clientId, (m.get(p.clientId) || 0) + Number(p.amount || 0));
    }
    return m;
  }, [approvedAll]);

  const submittedByClient = useMemo(() => {
    const m = new Map();
    for (const p of submittedAll) {
      m.set(p.clientId, (m.get(p.clientId) || 0) + Number(p.amount || 0));
    }
    return m;
  }, [submittedAll]);

  const approvedByClientByPeriod = useMemo(() => {
    const m = new Map();
    for (const p of approvedAll) {
      const per = String(p.period || "");
      if (!per) continue;
      if (!m.has(p.clientId)) m.set(p.clientId, new Map());
      const mm = m.get(p.clientId);
      mm.set(per, (mm.get(per) || 0) + Number(p.amount || 0));
    }
    return m;
  }, [approvedAll]);

  const submittedByClientByPeriod = useMemo(() => {
    const m = new Map();
    for (const p of submittedAll) {
      const per = String(p.period || "");
      if (!per) continue;
      if (!m.has(p.clientId)) m.set(p.clientId, new Map());
      const mm = m.get(p.clientId);
      mm.set(per, (mm.get(per) || 0) + Number(p.amount || 0));
    }
    return m;
  }, [submittedAll]);

  const lastPaidPeriodByClient = useMemo(() => {
    const m = new Map();
    for (const p of approvedAll) {
      const per = String(p.period || "");
      if (!per) continue;
      const cur = m.get(p.clientId) || "";
      if (per > cur) m.set(p.clientId, per);
    }
    return m;
  }, [approvedAll]);

  /* -------- Decoración -------- */
  const decorated = useMemo(() => {
    return clientes.map((c) => {
      const plan = Math.max(0, Number(c.plan || 0));
      const installYM = ymFromISO(c.fechaInstalacion);

      const monthsBillable = Math.max(0, monthsDiffInclusive(installYM, BILLABLE_YM));
      const totalDue = plan * monthsBillable;
      const aprobadoHist = approvedByClient.get(c.id) || 0;
      const enviadoHist  = submittedByClient.get(c.id) || 0;
      const saldo = Math.max(totalDue - aprobadoHist, 0);
      const saldoAfterSubmitted = Math.max(totalDue - aprobadoHist - enviadoHist, 0);

      const planMes = planForYM(c, PERIOD);
      const apMes  = approvedByClientByPeriod.get(c.id)?.get(PERIOD) || 0;
      const sbMes  = submittedByClientByPeriod.get(c.id)?.get(PERIOD) || 0;
      const saldoMes = Math.max(planMes - apMes, 0);
      const saldoMesAfterSubmitted = Math.max(planMes - apMes - sbMes, 0);

      const arrears = computeArrears(c, PERIOD, approvedByClientByPeriod);
      const dueReached = dueReachedThisMonth(c.fechaInstalacion);

      // === “nuevo del mes” igual que Admin
      let isNew = isTimestampInCurrentMonth(c.createdAt);
      if (!c.createdAt && isInCurrentMonth(c.fechaInstalacion)) isNew = true;
      const monthsNewYM = isNew ? monthsSinceInstallYM(c.fechaInstalacion) : 0;

      // === BADGE igual que Admin
      let badge = null;
      if (!c.exonerado && saldoMes > 0) {
        if (arrears > 0) {
          badge = { label: "PENDIENTE", cls: "badge-red" };
        } else if (isNew) {
          if (monthsNewYM >= 2) badge = { label: "PENDIENTE", cls: "badge-red" };
          else if (monthsNewYM === 1) badge = { label: "PENDIENTE", cls: "badge-yellow" };
        }
      }

      return {
        ...c,
        plan,
        monthsBillable,
        totalDue,
        aprobado: aprobadoHist,
        submitted: enviadoHist,
        saldo,
        saldoAfterSubmitted,

        planMes,
        aprobadoMes: apMes,
        submittedMes: sbMes,
        saldoMes,
        saldoMesAfterSubmitted,

        arrears,
        dueReached,

        // NUEVO para sincronizar con Admin
        isNew,
        monthsNewYM,
        badge,

        lastPaidPeriod: lastPaidPeriodByClient.get(c.id) || "",
      };
    });
  }, [
    clientes,
    BILLABLE_YM,
    PERIOD,
    approvedByClient,
    submittedByClient,
    approvedByClientByPeriod,
    submittedByClientByPeriod,
    lastPaidPeriodByClient,
  ]);

  /* ======== PON: lista en el MISMO orden que Admin ======== */
  const ponList = useMemo(() => {
    const present = new Set();
    for (const c of clientes) {
      const v = String(c.pon ?? "").trim();
      if (v) present.add(v);
    }
    const ordered = PON_ORDER.filter((p) => present.has(p));
    const extras = Array.from(present).filter((p) => !PON_ORDER.includes(p)).sort((a,b)=>a.localeCompare(b));
    return [...ordered, ...extras];
  }, [clientes]);

  /* -------- Filtros -------- */
  const baseSinPON = useMemo(() => {
    const texto = (busqueda || "").trim().toLowerCase();
    let arr = decorated;

    if (filtroEstado === "Exonerados") {
      arr = arr.filter((c) => !!c.exonerado);
    } else if (filtroEstado === "Pagados") {
      arr = arr.filter((c) => !c.exonerado && c.saldoMesAfterSubmitted <= 0);
    } else if (filtroEstado === "Pendientes") {
      // === Igual que Admin
      arr = arr.filter((c) => {
        if (c.exonerado) return false;
        const isPendingNormal = c.arrears > 0 || (c.dueReached && c.saldoMes > 0);
        const isPendingByInstall = (c.saldoMes > 0 && c.monthsNewYM >= 1);
        return isPendingNormal || isPendingByInstall;
      });
    }

    if (texto) {
      arr = arr.filter((c) => {
        const n = (c.nombre || "").toLowerCase();
        const t = (c.telefono || "").toLowerCase();
        const d = (c.domicilio || "").toLowerCase();
        return n.includes(texto) || t.includes(texto) || d.includes(texto);
      });
    }
    return arr;
  }, [decorated, filtroEstado, busqueda]);

  const ponCounts = useMemo(() => {
    const m = new Map();
    for (const c of baseSinPON) {
      const k = String(c.pon ?? "").trim();
      if (!k) continue;
      m.set(k, (m.get(k) || 0) + 1);
    }
    return m;
  }, [baseSinPON]);

  const filtrados = useMemo(() => {
    let arr = baseSinPON;
    if (ponSeleccion.length > 0) {
      const set = new Set(ponSeleccion.map(String));
      arr = arr.filter((c) => set.has(String(c.pon ?? "")));
    }
    arr.sort((a, b) => (a.nombre || "").localeCompare(b.nombre || ""));
    return arr;
  }, [baseSinPON, ponSeleccion]);

  /* -------- Cargar pagos recientes por cliente (consolidado) -------- */
  const loadPagosCliente = async (clientId) => {
    try {
      const qs = await getDocs(
        query(collection(db, "payments"), where("clientId", "==", clientId))
      );
      const raw = qs.docs.map((d) => ({ id: d.id, ...d.data() }));
      const list = consolidatePayments(raw);
      list.sort((a, b) => {
        const am = a.createdAt?.toMillis?.() ?? 0;
        const bm = b.createdAt?.toMillis?.() ?? 0;
        return bm - am;
      });
      setPagosCliente((prev) => ({ ...prev, [clientId]: list.slice(0, 5) }));
    } catch (e) {
      setError(e.message || String(e));
    }
  };

  /* -------- Comentarios -------- */
  const enviarComentario = async (client) => {
    const msg = prompt(`Comentario para ${client.nombre}:`);
    if (!msg || !msg.trim()) return;
    await addDoc(collection(db, "comments"), {
      clientId: client.id,
      message: msg.trim(),
      createdAt: serverTimestamp(),
      createdBy: meEmail,
      read: false,
    });
    alert("Comentario enviado ✅");
  };

  /* -------- Cobrar -------- */
  const cobrar = async (c) => {
    if (c.exonerado) return alert("Cliente exonerado: no se puede cobrar.");

    const porEnviar = carrito
      .filter((it) => it.clientId === c.id)
      .reduce((s, it) => s + Number(it.amount || 0), 0);

    const saldoDisponible = Math.max(c.saldoAfterSubmitted - porEnviar, 0);
    if (saldoDisponible <= 0) return alert("El saldo disponible ya está cubierto.");

    const inp = prompt(
      `Cobro para ${c.nombre}
Deuda acumulada: ${money(c.totalDue)}
Pagado (aprobado): ${money(c.aprobado)}
Restante (después de enviados): ${money(saldoDisponible)}

Ingresa monto (<= restante):`,
      String(saldoDisponible)
    );
    if (inp == null) return;
    const amount = Number(String(inp).replace(",", "."));
    if (!(amount > 0)) return alert("Monto inválido");
    if (amount > saldoDisponible) return alert("No puede superar el saldo restante");

    const type =
      Math.abs(amount - Number(c.plan || 0)) < 0.0001 || amount === saldoDisponible
        ? "total"
        : "parcial";

    setCarrito((prev) => [...prev, { clientId: c.id, amount, type }]);
  };

  /* -------- Gastos -------- */
  const agregarGasto = async () => {
    const m = prompt("Monto del gasto (ej: 2.50):", "0");
    if (m == null) return;
    const amount = Number(String(m).replace(",", "."));
    if (!(amount > 0)) return alert("Monto inválido");

    const nota = prompt("Nota / concepto del gasto (opcional):", "") || "";
    setGastosPendientes((prev) => [
      ...prev,
      { id: "local_" + Date.now(), amount, note: nota.trim(), createdAt: new Date() },
    ]);
  };

  const eliminarGasto = async (g) => {
    if (!g?.id) return;
    if (!confirm("¿Eliminar este gasto enviado?")) return;
    try {
      await deleteDoc(doc(db, "expenses", g.id));
    } catch {
      alert("No se pudo eliminar el gasto.");
    }
  };
  const eliminarGastoPendiente = (id) => {
    setGastosPendientes((prev) => prev.filter((x) => x.id !== id));
  };

  /* -------- Enviar lote de la FECHA SELECCIONADA -------- */
  const enviarPagosDelDia = async () => {
    if (!carrito.length && !gastosPendientes.length) return;

    const email = meEmail;
    const batchId = `${batchDate}_${email.replace(/[^a-z0-9]/gi, "")}_${Date.now()}`;

    const cobrosTrasEnvio = totalCobradoYa + carritoTotal;
    const gastosTrasEnvio =
      totalGastosHoy + gastosPendientes.reduce((s, g) => s + Number(g.amount || 0), 0);
    const neto = cobrosTrasEnvio - gastosTrasEnvio;

    try {
      for (const it of carrito) {
        await addDoc(collection(db, "payments"), {
          clientId: it.clientId,
          amount: Number(it.amount || 0),
          period: PERIOD, // período de la fecha seleccionada
          type: it.type,
          status: "submitted",
          createdAt: serverTimestamp(),
          createdBy: email,
          batchDate, // FECHA SELECCIONADA
          batchId,
        });
      }
      for (const g of gastosPendientes) {
        await addDoc(collection(db, "expenses"), {
          amount: Number(g.amount || 0),
          note: g.note || "",
          createdAt: serverTimestamp(),
          createdBy: email,
          batchDate,
          batchId,
        });
      }

      setCarrito([]);
      setGastosPendientes([]);
      await clearDraft(DRAFT_KEY);

      alert(
        `Pagos/gastos enviados (${batchId}).\n` +
          `Cobrado ${batchDate}: ${money(cobrosTrasEnvio)}\n` +
          `Gastos ${batchDate}: ${money(gastosTrasEnvio)}\n` +
          `Neto ${batchDate}: ${money(neto)}`
      );
    } catch {
      alert("No se pudo enviar el lote ahora. Reintenta más tarde.");
    }
  };

  const puedeEnviar = carrito.length > 0 || gastosPendientes.length > 0;

  /* -------- Header -------- */
  const handleSignOut = async () => {
    await signOut(auth);
  };

  // utilidades PON (multi)
  const isPonChecked = (pon) => ponSeleccion.includes(pon);
  const togglePon = (pon) =>
    setPonSeleccion((prev) =>
      prev.includes(pon) ? prev.filter((x) => x !== pon) : [...prev, pon]
    );
  const clearPon = () => setPonSeleccion([]);
  const selectAllPon = () => setPonSeleccion(ponList.slice());

  /* =================== UI =================== */
  return (
    <div style={{ padding: 16 }}>
      {/* Header */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "auto 1fr",
          alignItems: "center",
          gap: 12,
          marginBottom: 12,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: 14, color: "#333" }}>{meEmail}</span>
          <button onClick={handleSignOut}>Cerrar sesión</button>
        </div>

        <h1 style={{ margin: 0, textAlign: "center" }}>CAPCORP</h1>
      </div>

      {/* Filtros + Acciones */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "auto auto auto 1fr auto auto auto",
          gap: 8,
          alignItems: "center",
          marginBottom: 10,
          position: "relative",
        }}
      >
        <select
          value={filtroEstado}
          onChange={(e) => setFiltroEstado(e.target.value)}
          style={{ padding: 6 }}
          title="Filtrar por estado"
        >
          <option>Pendientes</option>
          <option>Pagados</option>
          <option>Exonerados</option>
          <option>Todos</option>
        </select>

        {/* Fecha del lote */}
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <label style={{ fontSize: 12, color: "#333" }}>Fecha lote:</label>
          <input
            type="date"
            value={batchDate}
            onChange={(e) => {
              const v = e.target.value || todayISO();
              const max = todayISO();
              setBatchDate(v > max ? max : v);
            }}
            max={todayISO()}
            style={{
              padding: "6px 8px",
              border: "1px solid #ddd",
              borderRadius: 8,
            }}
            title="Elige la fecha a enviar (por ejemplo, ayer)"
          />
        </div>

        {/* PON (multi) */}
        <div style={{ position: "relative" }} ref={ponRef}>
          <button
            onClick={() => setPonOpen((v) => !v)}
            title="Filtrar por PON"
            style={{
              padding: "6px 10px",
              borderRadius: 8,
              border: "1px solid #ddd",
              background: "#fff",
              minWidth: 200,
              textAlign: "left",
            }}
          >
            {ponSeleccion.length === 0
              ? "PON: Todos"
              : `PON: ${ponSeleccion.slice().sort((a,b)=>a.localeCompare(b)).join(", ")}`}
          </button>

          {ponOpen && (
            <div
              style={{
                position: "absolute",
                top: "110%",
                left: 0,
                zIndex: 20,
                background: "#fff",
                border: "1px solid #ddd",
                borderRadius: 8,
                boxShadow: "0 8px 20px rgba(0,0,0,.08)",
                width: 260,
                padding: 8,
              }}
            >
              <div style={{display:"flex", gap:8, marginBottom:8}}>
                <button onClick={selectAllPon} style={{padding:"4px 8px"}}>Marcar todos</button>
                <button onClick={clearPon} style={{padding:"4px 8px"}}>Limpiar</button>
              </div>
              <div style={{ maxHeight: 280, overflow: "auto", paddingRight: 4 }}>
                {ponList.map((pon) => {
                  const count = ponCounts.get(pon) || 0;
                  return (
                    <label
                      key={pon}
                      style={{
                        display: "grid",
                        gridTemplateColumns: "auto 1fr auto",
                        alignItems: "center",
                        gap: 8,
                        padding: "6px 6px",
                        borderBottom: "1px dashed #eee",
                        cursor: "pointer",
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={isPonChecked(pon)}
                        onChange={() => togglePon(pon)}
                      />
                      <span>{pon}</span>
                      <span
                        style={{
                          minWidth: 28,
                          fontSize: 12,
                          padding: "2px 6px",
                          borderRadius: 12,
                          background: "#f1f5f9",
                          color: "#334155",
                          textAlign: "center",
                        }}
                      >
                        {count}
                      </span>
                    </label>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <input
            value={busqueda}
            onChange={(e) => setBusqueda(e.target.value)}
            placeholder="Buscar por nombre, teléfono o dirección…"
            style={{ padding: 6, width: "100%" }}
          />
          <div style={{ fontSize: 12, color: "#666", whiteSpace: "nowrap" }}>
            Resultados: {filtrados.length}
          </div>
        </div>

        <div style={{ display: "flex", gap: 6 }}>
          <button onClick={agregarGasto} title="Agregar gasto (queda pendiente)">➕ Gasto</button>
          <button onClick={() => setGastosOpen((v) => !v)} title="Ver gastos">
            {gastosOpen ? "Ocultar gastos" : "Ver gastos"}
          </button>
        </div>

        <button
          onClick={enviarPagosDelDia}
          disabled={!puedeEnviar}
          style={{
            padding: "8px 12px",
            background: puedeEnviar ? "#111" : "#aaa",
            color: "#fff",
            border: 0,
            borderRadius: 8,
            cursor: puedeEnviar ? "pointer" : "not-allowed",
            whiteSpace: "nowrap",
          }}
          title={
            puedeEnviar
              ? `Enviar pagos y gastos del ${batchDate}`
              : "No hay elementos para enviar"
          }
        >
          Enviar del {batchDate} (pagos {carrito.length}, gastos {gastosPendientes.length}) • {money(carritoTotal)}
        </button>
      </div>

      {/* Resumen */}
      <div
        style={{
          display: "flex",
          gap: 16,
          alignItems: "center",
          margin: "6px 0 12px",
          fontSize: 14,
          color: "#333",
          flexWrap: "wrap",
        }}
      >
        <span><b>Cobrado {batchDate} (incluye carrito):</b> {money(totalCobrosPrevistos)}</span>
        <span>
          <b>Gastos {batchDate} (incluye pendientes):</b> {money(totalGastosPrevistos)}{" "}
          <span style={{ color: "#666" }}>(enviados: {hoyGastos.length}, pendientes: {gastosPendientes.length})</span>
        </span>
        <span>
          <b>Neto {batchDate}:</b>{" "}
          <span style={{ color: netoPrevisto >= 0 ? "#16794f" : "#a40000" }}>{money(netoPrevisto)}</span>
        </span>
      </div>

      {/* Panel de gastos */}
      {gastosOpen && (
        <div style={{ border: "1px solid #eee", borderRadius: 8, padding: 10, marginBottom: 12 }}>
          <div style={{ fontWeight: 600, marginBottom: 8 }}>Gastos del {batchDate}</div>

          <div style={{ marginBottom: 10 }}>
            <div style={{ fontWeight: 600, margin: "6px 0" }}>
              Pendientes por enviar ({gastosPendientes.length}) — Total: {money(totalGastosPendientes)}
            </div>
            {!gastosPendientes.length ? (
              <div style={{ color: "#777" }}>No hay gastos pendientes.</div>
            ) : (
              <div style={{ display: "grid", gap: 6 }}>
                {gastosPendientes.map((g) => (
                  <div
                    key={g.id}
                    style={{
                      display: "grid",
                      gridTemplateColumns: "160px 1fr 120px auto",
                      gap: 8,
                      alignItems: "center",
                      borderBottom: "1px dashed #eee",
                      paddingBottom: 6,
                    }}
                  >
                    <div>{g.createdAt?.toLocaleTimeString?.() || "—"}</div>
                    <div>{g.note || "—"}</div>
                    <div style={{ fontWeight: 600 }}>{money(g.amount)}</div>
                    <button onClick={() => eliminarGastoPendiente(g.id)} title="Quitar">🗑️</button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div>
            <div style={{ fontWeight: 600, margin: "6px 0" }}>
              Enviados {batchDate} ({hoyGastos.length}) — Total: {money(totalGastosHoy)}
            </div>
            {!hoyGastos.length ? (
              <div style={{ color: "#666" }}>No hay gastos registrados en esta fecha.</div>
            ) : (
              <div style={{ display: "grid", gap: 6 }}>
                {hoyGastos.map((g) => (
                  <div
                    key={g.id}
                    style={{
                      display: "grid",
                      gridTemplateColumns: "160px 1fr 120px auto",
                      gap: 8,
                      alignItems: "center",
                      borderBottom: "1px dashed #eee",
                      paddingBottom: 6,
                    }}
                  >
                    <div>{g.createdAt?.toDate?.().toLocaleTimeString?.() || "—"}</div>
                    <div>{g.note || g.description || "—"}</div>
                    <div style={{ fontWeight: 600 }}>{money(g.amount)}</div>
                    <button onClick={() => eliminarGasto(g)} title="Eliminar gasto">🗑️</button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Tabla */}
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr>
            <th style={{ textAlign: "left" }}>NOMBRE</th>
            <th style={{ textAlign: "left" }}>ESTADO</th>
            <th style={{ textAlign: "left" }}>ACCIONES</th>
          </tr>
        </thead>
        <tbody>
          {filtrados.map((c) => {
            const porEnviar = carrito
              .filter((it) => it.clientId === c.id)
              .reduce((s, it) => s + Number(it.amount || 0), 0);
            const saldoDisponible = Math.max(c.saldoAfterSubmitted - porEnviar, 0);

            const trabajoHoy = (hoyPorCliente[c.id] || 0) > 0 || porEnviar > 0;

            // === BADGE sincronizado con Admin ===
            let estadoChip = null;
            if (c.exonerado) {
              estadoChip = (
                <span
                  style={{
                    fontSize: 12,
                    padding: "2px 8px",
                    borderRadius: 12,
                    marginRight: 8,
                    background: "#f3e8ff",
                    color: "#6b21a8",
                    border: "1px solid #e9d5ff",
                    fontWeight: 700,
                    textTransform: "uppercase",
                  }}
                >
                  EXONERADO
                </span>
              );
            } else if (c.saldoMes <= 0) {
              estadoChip = (
                <span
                  style={{
                    fontSize: 12,
                    padding: "2px 8px",
                    borderRadius: 12,
                    marginRight: 8,
                    background: "#e0f2fe",
                    color: "#0369a1",
                    border: "1px solid #bae6fd",
                    fontWeight: 700,
                    textTransform: "uppercase",
                  }}
                >
                  PAGADO
                </span>
              );
            } else if (c.badge) {
              estadoChip = (
                <span
                  style={{
                    fontSize: 12,
                    padding: "2px 8px",
                    borderRadius: 12,
                    marginRight: 8,
                    fontWeight: 700,
                    textTransform: "uppercase",
                    ...badgeStyle(c.badge.cls),
                  }}
                  title={
                    c.monthsNewYM >= 2
                      ? "Tiene 2 meses o más vencidos desde la instalación"
                      : "Tiene 1 mes vencido desde la instalación"
                  }
                >
                  {c.badge.label}
                </span>
              );
            } else if (!c.dueReached) {
              // antes de llegar al día de corte de este mes → morado (como Admin)
              estadoChip = (
                <span
                  style={{
                    fontSize: 12,
                    padding: "2px 8px",
                    borderRadius: 12,
                    marginRight: 8,
                    background: "#f5e8ff",
                    color: "#6b21a8",
                    border: "1px solid #e9d5ff",
                    fontWeight: 700,
                    textTransform: "uppercase",
                  }}
                >
                  PENDIENTE
                </span>
              );
            } else {
              // semáforo por días desde el vencimiento (verde/amarillo/rojo)
              const { label, cls } = pendingBadgeForClient(c);
              estadoChip = (
                <span
                  style={{
                    fontSize: 12,
                    padding: "2px 8px",
                    borderRadius: 12,
                    marginRight: 8,
                    fontWeight: 700,
                    textTransform: "uppercase",
                    ...badgeStyle(cls),
                  }}
                >
                  {label}
                </span>
              );
            }

            return (
              <>
                <tr key={c.id} style={{ borderTop: "1px solid #eee" }}>
                  <td style={{ padding: "10px 6px" }}>
                    <b>{c.nombre}</b>{" "}
                    <span style={{ color: "#777", fontSize: 12 }}>
                      PON {String(c.pon ?? "—")} · Plan {money(c.plan || 0)}
                    </span>
                  </td>
                  <td style={{ padding: "10px 6px" }}>
                    {estadoChip}
                    {/* Saldo del mes (igual que Admin) */}
                    Saldo: {money(c.saldoMes)}{" "}
                    {c.isNew && c.monthsNewYM > 0 && (
                      <span style={{ marginLeft: 8, fontSize: 11, color: "#6b7280" }}>
                        • {c.monthsNewYM} mes{c.monthsNewYM > 1 ? "es" : ""} vencido{c.monthsNewYM > 1 ? "s" : ""}
                      </span>
                    )}
                    {trabajoHoy && (
                      <span
                        style={{
                          marginLeft: 8,
                          fontSize: 11,
                          padding: "2px 6px",
                          borderRadius: 999,
                          border: "1px solid #cde",
                          background: "#eef5ff",
                          color: "#356",
                        }}
                      >
                        trabajado {batchDate}
                      </span>
                    )}
                  </td>
                  <td style={{ padding: "10px 6px" }}>
                    <button
                      onClick={() => {
                        const next = expand === c.id ? null : c.id;
                        setExpand(next);
                        if (next) loadPagosCliente(c.id);
                      }}
                    >
                      Info
                    </button>{" "}
                    <button onClick={() => enviarComentario(c)}>Comentar</button>{" "}
                    <button
                      onClick={() => cobrar(c)}
                      disabled={saldoDisponible <= 0 || c.exonerado}
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 6,
                        padding: "6px 10px",
                        borderRadius: 8,
                        border: "1px solid #ddd",
                        background: saldoDisponible > 0 ? "#fff" : "#f2f2f2",
                        cursor: saldoDisponible > 0 ? "pointer" : "not-allowed",
                      }}
                      title={
                        c.exonerado
                          ? "Cliente exonerado"
                          : (saldoDisponible > 0 ? "Agregar al lote" : "Sin saldo disponible")
                      }
                    >
                      Cobrar
                    </button>
                  </td>
                </tr>

                {expand === c.id && (
                  <tr>
                    <td colSpan={3} style={{ padding: "12px 6px 20px 6px", background: "#fafafa" }}>
                      <div style={{ display: "flex", gap: 24, flexWrap: "wrap", marginBottom: 10 }}>
                        <div><b>Teléfono:</b> {c.telefono || "—"}</div>
                        <div><b>Fecha instalación:</b> {c.fechaInstalacion || "—"}</div>
                        <div><b>PON:</b> {String(c.pon ?? "—")}</div>
                        <div><b>Plan:</b> {money(c.plan || 0)}</div>
                        <div><b>Saldo acumulado:</b> {money(c.saldo)}</div>
                        <div><b>Mes actual (restante incl. enviados):</b> {money(c.saldoMesAfterSubmitted)}</div>
                        <div><b>Dirección:</b> {c.domicilio || "—"}</div>
                        <div><b>Últ. pagado:</b> {c.lastPaidPeriod || "—"}</div>
                      </div>

                      <div style={{ marginTop: 6 }}>
                        <b>Últimos pagos</b>
                        {(() => {
                          const pagos = pagosCliente[c.id] || [];
                          if (!pagos.length) return <div style={{ color: "#777" }}>No hay pagos.</div>;
                          return (
                            <ul style={{ paddingLeft: 18, marginTop: 6 }}>
                              {pagos.map((p) => (
                                <li key={p.id}>
                                  {p.createdAt?.toDate?.().toLocaleString?.() || "…"} · {money(p.amount)} · {p.type || "—"} · <i>{p.status}</i> · Periodo: {p.period}
                                </li>
                              ))}
                            </ul>
                          );
                        })()}
                      </div>
                    </td>
                  </tr>
                )}
              </>
            );
          })}
        </tbody>
      </table>

      {/* Errores */}
      {error && (
        <div style={{ marginTop: 10, color: "#a40000" }}>
          Error: {error}
        </div>
      )}
    </div>
  );
}
