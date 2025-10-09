// src/components/AdminPanel.jsx

import { useEffect, useMemo, useRef, useState } from "react";
import { db, auth } from "../lib/firebase";
import AuditoriaPagos from "./AuditoriaPagos";
import {
  collection,
  query,
  where,
  onSnapshot,
  orderBy,
  addDoc,
  updateDoc,
  deleteDoc,
  doc,
  serverTimestamp,
  getDocs,
  limit,
} from "firebase/firestore";
import { signOut } from "firebase/auth";
import AdminPayments from "./AdminPayments";
import AdminFixTool from "./AdminFixTool";

/* ========== Helpers ========== */
const COLLECTOR_ALIASES = {
  "jeffersonhajajsvsh12@gmail.com": "JEFERSON",
};

const labelFromMaps = (email, labelsMap) => {
  if (!email || email === "—") return "—";
  return (labelsMap && labelsMap.get(email)) || COLLECTOR_ALIASES[email] || email;
};

const money = (n) => {
  const x = Number.isFinite(Number(n)) ? Number(n) : 0;
  return `$${x.toFixed(2)}`;
};

// ✅ Fecha LOCAL (no UTC)
const todayISO = () => {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};

const currentPeriod = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
};
const period = currentPeriod();

const uniqById = (arr) => Array.from(new Map(arr.map((x) => [x.id, x])).values());

// === Clave lógica de un pago (para consolidar duplicados legacy)
function paymentKey(p) {
  const clientId = String(p.clientId || "");
  const per = String(p.period || "");
  const batchDate = String(p.batchDate || "");
  const createdBy = String(p.createdBy || "");
  return `${clientId}__${per}__${batchDate}__${createdBy}`;
}

// Consolida por clave: suma amount y toma createdAt más reciente
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

/* ========== Validaciones y constantes ========== */
const isValidPhone = (v) => /^09\d{8}$/.test(String(v || "").trim());
const isValidPlan = (v) => /^\d{1,3}$/.test(String(v || "").trim());

// PON fijos
const PON_OPTIONS = [
  "0 CAP","1 CAP","2 CAP","3 CAP","4 CAP","5 CAP","6 CAP","8 CAP","10 CAP","11 CAP",
  "2 MAV","3 MAV","4 MAV","5 MAV","7 MAV","8 MAV","10 MAV","11 MAV","12 MAV","13 MAV",
  "WIFI",
];

// Normaliza descripción de gasto
const getExpenseDesc = (e) => {
  if (!e) return "—";
  const candidates = [
    e.desc, e.description, e.detalle, e.detail, e.details, e.concepto, e.concept,
    e.nota, e.note, e.observacion, e["observación"], e.motivo,
  ];
  const found = candidates.find((v) => typeof v === "string" && v.trim());
  return found ? found.trim() : "—";
};

/* ========== Period helpers ========== */
const ymNow = period; // YYYY-MM

const ymFromISO = (iso) => {
  if (!iso) return ymNow;
  const s = String(iso).slice(0, 7);
  return /^\d{4}-\d{2}$/.test(s) ? s : ymNow;
};

// ¿La fecha (YYYY-MM-DD) pertenece al mes actual?
const isInCurrentMonth = (iso) => {
  if (!iso) return false;
  return ymFromISO(iso) === ymNow; // compara "YYYY-MM"
};

// ¿El Timestamp (Firestore) pertenece al mes actual?
const isTimestampInCurrentMonth = (ts) => {
  if (!ts?.toDate) return false;
  const d = ts.toDate();
  const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  return ym === ymNow;
};

const cmpYM = (a, b) => (a === b ? 0 : a < b ? -1 : 1);
function incYM(ym) {
  let [y, m] = ym.split("-").map(Number);
  m += 1;
  if (m === 13) {
    m = 1; y += 1;
  }
  return `${y}-${String(m).padStart(2, "0")}`;
}

// Diferencia en meses AÑO/MES (ignora el día)
function monthsSinceInstallYM(installISO, ref = new Date()) {
  if (!installISO) return 0;
  const inst = new Date(`${installISO}T00:00:00`);
  if (Number.isNaN(inst.getTime())) return 0;
  return (ref.getFullYear() - inst.getFullYear()) * 12 + (ref.getMonth() - inst.getMonth());
}

// Cargo del mes actual: 0 si es el mes de instalación; desde el siguiente se cobra plan
function planForYM(c, ym) {
  const plan = Math.max(0, Number(c.plan || 0));
  const installYM = ymFromISO(c.fechaInstalacion);
  if (ym === installYM) return 0;
  if (cmpYM(ym, installYM) < 0) return 0;
  return plan;
}

/* =====  “pendiente” por días (tu semáforo actual) ===== */
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
const pendingBadgeForClient = (
  client,
  today = (typeof todayISO === "function" ? todayISO() : _todayISO())
) => {
  const dueISO =
    client?._dueISO ||
    _currentDueDateFromInstall(
      client?.installDate || client?.installationDate || client?.fechaInstalacion,
      today
    );
  const delta = _diffDays(dueISO, today);
  let cls = "badge-green";
  if (delta >= 4 && delta <= 7) cls = "badge-yellow";
  else if (delta >= 8) cls = "badge-red";
  return { label: "PENDIENTE", cls };
};

/* === Helpers de tu lógica mensual === */
const lastDayOfMonth = (y, m) => new Date(y, m, 0).getDate();
function dueReachedThisMonth(fechaInstalacionISO) {
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
}
function computeArrears(c, ymNowStr, approvedByClientByPeriod) {
  if (c.exonerado) return 0;
  if (!c.fechaInstalacion) return 0;
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
}

/* ====== BALANCE (helpers de fecha) ====== */
const startOfThisMonth = () => {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1, 0, 0, 0, 0);
};
const startOfTomorrow = () => {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 0, 0, 0, 0);
};

/* ===== Util para mostrar fecha de fila ===== */
function formatRowDateTime(p) {
  const datePart =
    typeof p.batchDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(p.batchDate)
      ? p.batchDate
      : p.createdAt?.toDate
      ? p.createdAt.toDate().toISOString().slice(0, 10)
      : "—";
  const timePart = p.createdAt?.toDate ? p.createdAt.toDate().toLocaleTimeString() : "—";
  return `${datePart} ${timePart}`;
}

/* ======= NUEVO: meses vencidos por fecha de instalación ======= */
/**
 * Devuelve cuántos "aniversarios mensuales" de la instalación ya se cumplieron
 * (1 => mes pasado ya llegó el día de corte; 2 => hace dos meses o más, etc).
 * Si aún no llega el día de corte del mes actual, no cuenta ese mes.
 */
function monthsPastAnniversaries(installISO, ref = new Date()) {
  if (!installISO) return 0;
  const inst = new Date(`${installISO}T00:00:00`);
  if (Number.isNaN(inst.getTime())) return 0;
  if (ref < inst) return 0;

  // meses totales entre años/meses
  const totalMonths =
    (ref.getFullYear() - inst.getFullYear()) * 12 +
    (ref.getMonth() - inst.getMonth());

  // si aún NO llegó el día de corte en este mes, resta 1
  const reachedCutThisMonth = ref.getDate() >= inst.getDate();
  const months = totalMonths - (reachedCutThisMonth ? 0 : 1);

  return Math.max(0, months);
}

export default function AdminPanel() {
  /* ===== Formulario (registro) ===== */
  const [nombre, setNombre] = useState("");
  const [telefono, setTelefono] = useState("");
  const [fechaInstalacion, setFechaInstalacion] = useState("");
  const [ponForm, setPonForm] = useState("");
  const [planForm, setPlanForm] = useState("");
  const [domicilio, setDomicilio] = useState("");
  const [exoneradoForm, setExoneradoForm] = useState(false);

  /* ===== Data ===== */
  const [clients, setClients] = useState([]);
  const [commentsInbox, setCommentsInbox] = useState([]);
  const [approvedAll, setApprovedAll] = useState([]);
  const [submittedAll, setSubmittedAll] = useState([]);

  /* ===== Filtros ===== */
  const [filterEstado, setFilterEstado] = useState("Todos");
  const [ponSel, setPonSel] = useState("Todos");
  const [ponOpen, setPonOpen] = useState(false);
  const [search, setSearch] = useState("");

  /* ===== UI ===== */
  const [openRows, setOpenRows] = useState({});
  const [bellOpen, setBellOpen] = useState(false);
  const [paymentsOpen, setPaymentsOpen] = useState(false);
  const [submittedCount, setSubmittedCount] = useState(0);

  /* ===== Edit ===== */
  const [editId, setEditId] = useState(null);
  const [editData, setEditData] = useState({
    nombre: "",
    telefono: "",
    fechaInstalacion: "",
    pon: "",
    plan: "",
    domicilio: "",
    exonerado: false,
  });

  const ponRef = useRef(null);
  const bellRef = useRef(null);
  const paymentsRef = useRef(null);

  /* ===== BALANCE (UI y estado) ===== */
  const [monthOpen, setMonthOpen] = useState(false);
  const monthRef = useRef(null);
  const [mApprovedSum, setMApprovedSum] = useState(0);
  const [mApprovedCount, setMApprovedCount] = useState(0);
  const [mExpensesSum, setMExpensesSum] = useState(0);
  const [mExpensesCount, setMExpensesCount] = useState(0);
  // balance por día
  const [balanceDate, setBalanceDate] = useState(todayISO());
  const [bDayPaySubmitted, setBDayPaySubmitted] = useState(0);
  const [bDayPayApproved, setBDayPayApproved] = useState(0);
  const [bDayExpenses, setBDayExpenses] = useState(0);

  /* ===== Listas por fecha ===== */
  const [listsOpen, setListsOpen] = useState(false);
  const [collectorOptions, setCollectorOptions] = useState(["Todos"]);
  const [collectorLabels, setCollectorLabels] = useState(new Map());
  const [collectorFilter, setCollectorFilter] = useState("Todos");
  const [dateFilter, setDateFilter] = useState(todayISO());
  const [listGroups, setListGroups] = useState([]);

  const currentUserEmail = auth.currentUser?.email || "admin@capcorp.com";

  /* === Admin de cobradores === */
  const [collectorsOpen, setCollectorsOpen] = useState(false);
  const collectorsRef = useRef(null);
  const [collectors, setCollectors] = useState([]);
  const [editAliases, setEditAliases] = useState({});
  const [savingCollectorId, setSavingCollectorId] = useState(null);
  const [newCollectorEmail, setNewCollectorEmail] = useState("");
  const [newCollectorAlias, setNewCollectorAlias] = useState("");

  async function saveCollectorAlias(id, alias) {
    try {
      setSavingCollectorId(id);
      await updateDoc(doc(db, "users", id), {
        alias: String(alias || "").trim(),
        updatedAt: serverTimestamp(),
        updatedBy: currentUserEmail,
      });
    } finally {
      setSavingCollectorId(null);
    }
  }
  async function createCollector() {
    const email = newCollectorEmail.trim().toLowerCase();
    const alias = newCollectorAlias.trim();
    if (!/^[^@]+@[^@]+\.[^@]+$/.test(email)) return alert("Correo inválido");
    if (!alias) return alert("Alias requerido");
    await addDoc(collection(db, "users"), {
      role: "collector",
      email,
      alias,
      displayName: alias,
      createdAt: serverTimestamp(),
      createdBy: currentUserEmail,
      updatedAt: serverTimestamp(),
      updatedBy: currentUserEmail,
    });
    setNewCollectorEmail("");
    setNewCollectorAlias("");
    alert("Cobrador creado ✅");
  }

  /* ========= SUSCRIPCIONES ========= */
  // Clients
  useEffect(() => {
    const q = query(collection(db, "clients"), orderBy("nombre"));
    return onSnapshot(q, (snap) =>
      setClients(snap.docs.map((d) => ({ id: d.id, ...d.data() })))
    );
  }, []);

  // Approved (CONSOLIDADO)
  useEffect(() => {
    const q = query(collection(db, "payments"), where("status", "==", "approved"));
    return onSnapshot(q, (snap) => {
      const raw = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      setApprovedAll(consolidatePayments(raw));
    });
  }, []);

  // Submitted (CONSOLIDADO)
  useEffect(() => {
    const q = query(collection(db, "payments"), where("status", "==", "submitted"));
    return onSnapshot(q, (snap) => {
      const raw = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      const grouped = consolidatePayments(raw);
      setSubmittedAll(grouped);
      setSubmittedCount(grouped.length);
    });
  }, []);

  // Comentarios (con fallback)
  useEffect(() => {
    const q1 = query(
      collection(db, "comments"),
      where("read", "==", false),
      orderBy("createdAt", "desc")
    );
    let unsub = onSnapshot(
      q1,
      (snap) => {
        setCommentsInbox(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
      },
      () => {
        const q2 = query(
          collection(db, "comments"),
          orderBy("createdAt", "desc"),
          limit(200)
        );
        unsub = onSnapshot(q2, (snap2) => {
          const all = snap2.docs.map((d) => ({ id: d.id, ...d.data() }));
          setCommentsInbox(all.filter((c) => c.read !== true));
        });
      }
    );
    return () => unsub && unsub();
  }, []);

  // Cobradores (labels) con fallback a payments + lista editable
  useEffect(() => {
    const qUsers = query(collection(db, "users"), where("role", "==", "collector"));
    let unsubPayments = null;

    const unsubUsers = onSnapshot(
      qUsers,
      (snap) => {
        const emails = [];
        const labels = new Map();
        const arr = [];
        snap.forEach((d) => {
          const u = d.data() || {};
          const email = String(u.email || "").trim();
          if (!email) return;
          const alias = String(u.alias || u.displayName || u.name || "").trim();
          emails.push(email);
          labels.set(email, alias || email);
          arr.push({ id: d.id, email, alias, displayName: u.displayName || u.name || "" });
        });
        emails.sort((a, b) => {
          const la = labels.get(a) || COLLECTOR_ALIASES[a] || a;
          const lb = labels.get(b) || COLLECTOR_ALIASES[b] || b;
          return la.localeCompare(lb);
        });
        arr.sort((a, b) => (a.alias || a.email).localeCompare(b.alias || b.email));
        setCollectors(arr);
        setCollectorLabels(labels);
        setCollectorOptions(["Todos", ...emails]);
      },
      // fallback por payments
      () => {
        const qPay = query(collection(db, "payments"), orderBy("createdAt", "desc"), limit(300));
        unsubPayments = onSnapshot(qPay, (s2) => {
          const set = new Set();
          s2.forEach((d) => {
            const by = d.data()?.createdBy;
            if (by) set.add(String(by));
          });
          const emails = Array.from(set);
          emails.sort((a, b) => {
            const la = COLLECTOR_ALIASES[a] || a;
            const lb = COLLECTOR_ALIASES[b] || b;
            return la.localeCompare(lb);
          });
          const labels = new Map(emails.map((e) => [e, COLLECTOR_ALIASES[e] || e]));
          setCollectorLabels(labels);
          setCollectorOptions(["Todos", ...emails]);
          setCollectors([]); // sin docs de users no podemos editar
        });
      }
    );

    return () => {
      unsubUsers && unsubUsers();
      unsubPayments && unsubPayments();
    };
  }, []);

  // Cerrar popovers al click afuera
  const fixRef = useRef(null);
  const [fixOpen, setFixOpen] = useState(false);
  useEffect(() => {
    function onClick(e) {
      if (ponOpen && ponRef.current && !ponRef.current.contains(e.target)) {
        setPonOpen(false);
      }
      if (bellOpen && bellRef.current && !bellRef.current.contains(e.target)) {
        setBellOpen(false);
      }
      if (monthOpen && monthRef.current && !monthRef.current.contains(e.target)) {
        setMonthOpen(false);
      }
      if (paymentsOpen && paymentsRef.current && !paymentsRef.current.contains(e.target)) {
        setPaymentsOpen(false);
      }
      if (collectorsOpen && collectorsRef.current && !collectorsRef.current.contains(e.target)) {
        setCollectorsOpen(false);
      }
      if (fixOpen && fixRef.current && !fixRef.current.contains(e.target)) {
        setFixOpen(false);
      }
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [ponOpen, bellOpen, monthOpen, paymentsOpen, collectorsOpen, fixOpen]);

  /* ===== Derivados: pagos por cliente / período ===== */
  const approvedByClientByPeriod = useMemo(() => {
    const m = new Map();
    for (const p of approvedAll) {
      const cid = p.clientId;
      const per = String(p.period || "");
      const amt = Number(p.amount || 0);
      if (!per) continue;
      if (!m.has(cid)) m.set(cid, new Map());
      const mm = m.get(cid);
      mm.set(per, (mm.get(per) || 0) + amt);
    }
    return m;
  }, [approvedAll]);

  const submittedByClientByPeriod = useMemo(() => {
    const m = new Map();
    for (const p of submittedAll) {
      const cid = p.clientId;
      const per = String(p.period || "");
      const amt = Number(p.amount || 0);
      if (!per) continue;
      if (!m.has(cid)) m.set(cid, new Map());
      const mm = m.get(cid);
      mm.set(per, (mm.get(per) || 0) + amt);
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

  /* ===== Decorado clientes (incluye NUEVO monthsDue + badge) ===== */
  const decorated = useMemo(() => {
  return clients.map((c) => {
    const plan = Math.max(0, Number(c.plan || 0));
    const planMes = planForYM(c, ymNow);
    const aprobadoMes = approvedByClientByPeriod.get(c.id)?.get(ymNow) || 0;
    const submittedMes = submittedByClientByPeriod.get(c.id)?.get(ymNow) || 0;

    const saldoMes = Math.max(planMes - aprobadoMes, 0);
    const saldoMesAfterSubmitted = Math.max(planMes - aprobadoMes - submittedMes, 0);

    const arrears = computeArrears(c, ymNow, approvedByClientByPeriod);
    const dueReached = dueReachedThisMonth(c.fechaInstalacion);
    const estado = c.exonerado ? "EXONERADO" : (saldoMes <= 0 ? "PAGADO" : "PENDIENTE");

    // 👉 "Nuevo este mes": creado este mes (fallback a instalación si no hay createdAt)
    let isNew = isTimestampInCurrentMonth(c.createdAt);
    if (!c.createdAt && isInCurrentMonth(c.fechaInstalacion)) isNew = true;

    // Solo para NUEVOS calculo meses por instalación, ignorando el día.
    const monthsNewYM = isNew ? monthsSinceInstallYM(c.fechaInstalacion) : 0;

    // Badge visual (prioridad: arrears > 0 ⇒ rojo)
    let badge = null;
    if (!c.exonerado && saldoMes > 0) {
      if (arrears > 0) {
        badge = { label: "PENDIENTE", cls: "badge-red" };           // Debe meses anteriores
      } else if (isNew) {
        if (monthsNewYM >= 2) badge = { label: "PENDIENTE", cls: "badge-red" };   // p.ej. instalación agosto en octubre
        else if (monthsNewYM === 1) badge = { label: "PENDIENTE", cls: "badge-yellow" }; // instalación mes pasado
      }
      // Si no es nuevo y no hay arrears, el color por días se maneja en el render con pendingBadgeForClient
    }

    return {
      ...c,
      plan,
      planMes,
      aprobadoMes,
      submittedMes,
      saldoMes,
      saldoMesAfterSubmitted,
      estado,
      arrears,
      dueReached,
      lastPaidPeriod: lastPaidPeriodByClient.get(c.id) || "",
      // Nuevos:
      isNew,
      monthsNewYM,
      badge,
    };
  });
}, [clients, approvedByClientByPeriod, submittedByClientByPeriod, lastPaidPeriodByClient]);



  /* ===== Filtros / contadores (incluyen monthsDue) ===== */
  const counts = useMemo(() => {
    let todos = 0, pend = 0, paga = 0, exon = 0;
    for (const c of decorated) {
      const inPon = (ponSel === "Todos") || String(c.pon ?? "") === ponSel;
      const inSearch =
        !search.trim() || (c.nombre || "").toUpperCase().includes(search.trim().toUpperCase());
      if (!inPon || !inSearch) continue;

      todos += 1;
      if (c.exonerado) {
        exon += 1;
      } else if (c.saldoMes <= 0) {
        paga += 1;
      } else {
        const isPendingNormal = c.arrears > 0 || (c.dueReached && c.saldoMes > 0);
        const isPendingByInstall = (!c.exonerado && c.saldoMes > 0 && c.monthsDue >= 1);
        if (isPendingNormal || isPendingByInstall) pend += 1;
      }
    }
    return { todos, pend, paga, exon };
  }, [decorated, ponSel, search]);

  const visibles = useMemo(() => {
    let arr = decorated;

    if (filterEstado === "Pendiente") {
      arr = arr.filter((c) => {
        if (c.exonerado) return false;
        const isPendingNormal = c.arrears > 0 || (c.dueReached && c.saldoMes > 0);
        const isPendingByInstall = (c.saldoMes > 0 && c.monthsDue >= 1);
        return isPendingNormal || isPendingByInstall;
      });
    } else if (filterEstado === "Pagado") {
      arr = arr.filter((c) => !c.exonerado && c.saldoMes <= 0);
    } else if (filterEstado === "Exonerado") {
      arr = arr.filter((c) => c.exonerado);
    }

    if (ponSel !== "Todos") {
      arr = arr.filter((c) => String(c.pon ?? "") === ponSel);
    }

    const q = (search || "").trim().toUpperCase();
    if (q) arr = arr.filter((c) => (c.nombre || "").toUpperCase().includes(q));
    return arr;
  }, [decorated, filterEstado, ponSel, search]);

  const clientNameById = useMemo(() => {
    const m = new Map();
    for (const c of clients) m.set(c.id, c.nombre || c.id);
    return m;
  }, [clients]);

  /* ======== (La UI completa viene en la PARTE 2) ======== */
  // --- Aquí termina la PARTE 1 ---
  /* ===== Acciones campana ===== */
  async function markCommentRead(id) {
    await updateDoc(doc(db, "comments", id), {
      read: true,
      readAt: serverTimestamp(),
      readBy: currentUserEmail,
    });
  }
  async function attachCommentAsNote(c) {
    const note = `[${todayISO()}] ${c.message} (cobrador)`;
    await updateDoc(doc(db, "clients", c.clientId), {
      alerta: note,
      updatedAt: serverTimestamp(),
      updatedBy: currentUserEmail,
    });
    await markCommentRead(c.id);
  }

  /* ===== Export CSV ===== */
  function exportCSV(group) {
    if (!group || !group.items?.length) return;
    const decimalComma = (1.1).toLocaleString().includes(",");
    const SEP = decimalComma ? ";" : ",";
    const collectorLabel = labelFromMaps(group.collector || "—", collectorLabels);
    const lines = [`"${collectorLabel}"`, `CLIENTE${SEP}MONTO`];
    for (const p of group.items) {
      const cliente = (clientNameById.get(p.clientId) || p.clientId || "").replace(/"/g, '""');
      const monto = Number(p.amount || 0).toFixed(2);
      lines.push(`"${cliente}"${SEP}${monto}`);
    }
    const csv = "\uFEFF" + lines.join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const safeLbl = String(collectorLabel || "sin_cobrador").replace(/[^\w\-]+/g, "_").slice(0, 40);
    a.download = `pagos_${safeLbl}_${dateFilter || todayISO()}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  /* ===== Notas admin ===== */
  async function addNoteToClient(c) {
    const msg = prompt(`Nota para ${c.nombre}:`);
    if (!msg || !msg.trim()) return;
    await updateDoc(doc(db, "clients", c.id), {
      alerta: msg.trim(),
      updatedAt: serverTimestamp(),
      updatedBy: currentUserEmail,
    });
    alert("Nota agregada ✅");
  }
  async function clearNoteFromClient(c) {
    if (!c.alerta) return;
    if (!confirm(`Quitar la nota de ${c.nombre}?`)) return;
    await updateDoc(doc(db, "clients", c.id), {
      alerta: "",
      updatedAt: serverTimestamp(),
      updatedBy: currentUserEmail,
    });
    alert("Nota eliminada 🗑️");
  }

  const toggleInfo = (id) => setOpenRows((prev) => ({ ...prev, [id]: !prev[id] }));

  /* ===== Registro / edición / eliminar cliente ===== */
  async function handleRegister(e) {
    e?.preventDefault();
    const nombreOk = (nombre || "").trim();
    const telDigits = (telefono || "").trim();
    const planStr = String(planForm || "").trim();
    if (!nombreOk) return alert("Nombre es requerido");
    if (!fechaInstalacion) return alert("Fecha de instalación es requerida");
    if (!isValidPhone(telDigits)) {
      return alert("Teléfono inválido. Debe tener 10 dígitos y comenzar con 09 (ej: 09XXXXXXXX).");
    }
    if (!isValidPlan(planStr)) {
      return alert("Plan inválido. Debe ser numérico de hasta 3 dígitos (0 a 999).");
    }
    if (!ponForm) return alert("Selecciona un PON.");

    const planOk = Number(planStr);
    await addDoc(collection(db, "clients"), {
      active: true,
      createdAt: serverTimestamp(),
      createdBy: currentUserEmail,
      nombre: nombreOk,
      telefono: telDigits,
      fechaInstalacion,
      plan: planOk,
      pon: ponForm,
      domicilio: (domicilio || "").trim(),
      lastPaidPeriod: "",
      alerta: "",
      exonerado: exoneradoForm,
      updatedAt: serverTimestamp(),
      updatedBy: currentUserEmail,
    });
    handleClear();
    alert("Cliente registrado correctamente.");
  }
  function handleClear() {
    setNombre("");
    setTelefono("");
    setFechaInstalacion("");
    setPonForm("");
    setPlanForm("");
    setDomicilio("");
    setExoneradoForm(false);
  }
  function startEdit(c) {
    setEditId(c.id);
    setEditData({
      nombre: c.nombre || "",
      telefono: String(c.telefono || ""),
      fechaInstalacion: c.fechaInstalacion || "",
      pon: String(c.pon || ""),
      plan: String(c.plan ?? ""),
      domicilio: c.domicilio || "",
      exonerado: !!c.exonerado,
    });
  }
  function cancelEdit() {
    setEditId(null);
    setEditData({
      nombre: "", telefono: "", fechaInstalacion: "", pon: "", plan: "",
      domicilio: "", exonerado: false,
    });
  }
  async function saveEdit() {
    const id = editId;
    if (!id) return;
    const nombreOk = (editData.nombre || "").trim();
    const telDigits = String(editData.telefono || "").trim();
    const planStr = String(editData.plan || "").trim();
    const ponOk = String(editData.pon || "").trim();
    if (!nombreOk) return alert("Nombre es requerido");
    if (!editData.fechaInstalacion) return alert("Fecha de instalación es requerida");
    if (!isValidPhone(telDigits)) return alert("Teléfono inválido. Debe iniciar con 09 y tener 10 dígitos");
    if (!isValidPlan(planStr)) return alert("Plan inválido. Debe ser numérico de hasta 3 dígitos (0 a 999).");
    if (!ponOk) return alert("Selecciona un PON.");

    await updateDoc(doc(db, "clients", id), {
      nombre: nombreOk,
      telefono: telDigits,
      fechaInstalacion: editData.fechaInstalacion,
      pon: ponOk,
      plan: Number(planStr),
      domicilio: (editData.domicilio || "").trim(),
      exonerado: !!editData.exonerado,
      updatedAt: serverTimestamp(),
      updatedBy: currentUserEmail,
    });
    cancelEdit();
    alert("Cliente actualizado ✅");
  }
  async function handleDelete(c) {
    const ps = await getDocs(query(collection(db, "payments"), where("clientId", "==", c.id)));
    const count = ps.size;
    const msg1 =
      count > 0
        ? `Este cliente tiene ${count} pago(s) en la colección "payments".`
        : "Este cliente no tiene pagos registrados.";
    if (
      !confirm(
        `${msg1}\n\nSe eliminará SOLO el documento del cliente (no se tocarán pagos).\n¿Deseas continuar?`
      )
    ) {
      return;
    }
    await deleteDoc(doc(db, "clients", c.id));
    alert("Cliente eliminado.");
  }

  /* ===== Cobro (FIFO) y revertir ===== */
  async function handleCharge(c) {
    if (c.exonerado) {
      alert("Cliente exonerado: no se puede registrar cobros.");
      return;
    }
    const installYM = ymFromISO(c.fechaInstalacion);
    let ym = cmpYM(installYM, ymNow) >= 0 ? ymNow : incYM(installYM);
    let targetPeriod = ymNow;
    while (true) {
      const planMes = planForYM(c, ym);
      if (planMes > 0) {
        const ap = approvedByClientByPeriod.get(c.id)?.get(ym) || 0;
        const sb = submittedByClientByPeriod.get(c.id)?.get(ym) || 0;
        if (ap + sb < planMes) {
          targetPeriod = ym;
          break;
        }
      }
      if (ym === ymNow) {
        targetPeriod = ymNow;
        break;
      }
      ym = incYM(ym);
    }
    const planMes = planForYM(c, targetPeriod);
    if (planMes <= 0) {
      alert(`El período ${targetPeriod} no genera cargo (instalación).`);
      return;
    }
    const apMes = approvedByClientByPeriod.get(c.id)?.get(targetPeriod) || 0;
    const sbMes = submittedByClientByPeriod.get(c.id)?.get(targetPeriod) || 0;
    const restanteMes = Math.max(planMes - apMes - sbMes, 0);
    if (restanteMes <= 0) {
      alert(`El mes ${targetPeriod} ya está cubierto.`);
      return;
    }
    const inp = prompt(
      `Cobro para ${c.nombre}
Mes destino: ${targetPeriod}
Plan (mes): ${money(planMes)}
Pagado+enviado en ese mes: ${money(apMes + sbMes)}
Restante de ese mes: ${money(restanteMes)}
Ingresa monto (<= restante)`,
      String(restanteMes)
    );
    if (inp == null) return;
    const amount = Number(inp);
    if (!(amount > 0)) return alert("Monto inválido");
    if (amount > restanteMes) return alert("No puede superar el saldo restante de ese mes");
    const type = amount >= restanteMes ? "total" : "parcial";
    await addDoc(collection(db, "payments"), {
      clientId: c.id,
      amount,
      period: targetPeriod,
      type,
      status: "submitted",
      createdAt: serverTimestamp(),
      createdBy: currentUserEmail,
      batchDate: todayISO(), // fecha LOCAL del cobro
    });
    alert(`Pago enviado. Aplicado al período ${targetPeriod}.`);
  }

  async function handleRevertMonth(c) {
    if (
      !confirm(
        `Revertir pagos del período ${period} para ${c.nombre}?\n- 'approved' → 'reversed'\n- 'submitted' → 'rejected'`
      )
    )
      return;

    const qa = query(
      collection(db, "payments"),
      where("clientId", "==", c.id),
      where("period", "==", period),
      where("status", "==", "approved")
    );
    const sa = await getDocs(qa);
    for (const d of sa.docs) {
      await updateDoc(doc(db, "payments", d.id), {
        status: "reversed",
        updatedAt: serverTimestamp(),
        updatedBy: currentUserEmail,
      });
    }

    const qs = query(
      collection(db, "payments"),
      where("clientId", "==", c.id),
      where("period", "==", period),
      where("status", "==", "submitted")
    );
    const ss = await getDocs(qs);
    for (const d of ss.docs) {
      await updateDoc(doc(db, "payments", d.id), {
        status: "rejected",
        updatedAt: serverTimestamp(),
        updatedBy: currentUserEmail,
      });
    }
    alert("Reversión aplicada sobre el período actual.");
  }

  /* ===== Listas por fecha (agrupación A∪B y NETO) ===== */
  function buildGroupsFrom(paymentsRows, expensesRows) {
    const byCollector = new Map();

    // Pagos
    for (const p of paymentsRows) {
      const key = p.createdBy || "—";
      if (!byCollector.has(key)) {
        byCollector.set(key, {
          collector: key,
          items: [],
          total: 0,
          count: 0,
          statuses: {},
          expenses: [],
          expenseTotal: 0,
          expenseCount: 0,
          net: 0,
        });
      }
      const g = byCollector.get(key);
      g.items.push(p);
      g.total += Number(p.amount || 0);
      g.count += 1;
      g.statuses[p.status] = (g.statuses[p.status] || 0) + 1;
    }

    // Gastos
    for (const e of expensesRows) {
      const key = e.createdBy || "—";
      if (!byCollector.has(key)) {
        byCollector.set(key, {
          collector: key,
          items: [],
          total: 0,
          count: 0,
          statuses: {},
          expenses: [],
          expenseTotal: 0,
          expenseCount: 0,
          net: 0,
        });
      }
      const g = byCollector.get(key);
      g.expenses.push(e);
      g.expenseTotal += Number(e.amount || 0);
      g.expenseCount += 1;
    }

    const groups = Array.from(byCollector.values());
    for (const g of groups) {
      g.items.sort((a, b) => {
        const ta = a.createdAt?.toDate ? a.createdAt.toDate().getTime() : 0;
        const tb = b.createdAt?.toDate ? b.createdAt.toDate().getTime() : 0;
        return tb - ta;
      });
      g.expenses.sort((a, b) => {
        const ta = a.createdAt?.toDate ? a.createdAt.toDate().getTime() : 0;
        const tb = b.createdAt?.toDate ? b.createdAt.toDate().getTime() : 0;
        return tb - ta;
      });
      g.net = g.total - g.expenseTotal;
    }
    groups.sort((a, b) => a.collector.localeCompare(b.collector));
    setListGroups(groups);
  }

  // Suscripción cuando se abre "Listas y cobros"
  useEffect(() => {
    if (!listsOpen) return;

    const start = new Date(dateFilter + "T00:00:00");
    const end = new Date(dateFilter + "T23:59:59.999");
    const startBuf = new Date(start.getTime() - 6 * 60 * 60 * 1000);
    const endBuf = new Date(end.getTime() + 6 * 60 * 60 * 1000);

    const matchCollector = (x) =>
      collectorFilter === "Todos" || x.createdBy === collectorFilter;

    let payA = [], payB = [], expA = [], expB = [];

    const recompute = () => {
      const payUnionRaw = uniqById([...payA, ...payB]);
      const payConsolidated = consolidatePayments(payUnionRaw).filter(matchCollector);
      const expUnion = uniqById([...expA, ...expB]).filter(matchCollector);
      buildGroupsFrom(payConsolidated, expUnion);
    };

    const unsubPaymentsA = onSnapshot(
      query(collection(db, "payments"), where("batchDate", "==", dateFilter), orderBy("createdAt", "desc")),
      (snap) => { payA = snap.docs.map((d) => ({ id: d.id, ...d.data() })); recompute(); }
    );
    const unsubPaymentsB = onSnapshot(
      query(
        collection(db, "payments"),
        where("createdAt", ">=", startBuf),
        where("createdAt", "<=", endBuf),
        orderBy("createdAt", "desc")
      ),
      (snap) => { payB = snap.docs.map((d) => ({ id: d.id, ...d.data() })); recompute(); }
    );

    const unsubExpensesA = onSnapshot(
      query(collection(db, "expenses"), where("batchDate", "==", dateFilter), orderBy("createdAt", "desc")),
      (snap) => { expA = snap.docs.map((d) => ({ id: d.id, ...d.data() })); recompute(); }
    );
    const unsubExpensesB = onSnapshot(
      query(
        collection(db, "expenses"),
        where("createdAt", ">=", startBuf),
        where("createdAt", "<=", endBuf),
        orderBy("createdAt", "desc")
      ),
      (snap) => { expB = snap.docs.map((d) => ({ id: d.id, ...d.data() })); recompute(); }
    );

    return () => {
      unsubPaymentsA && unsubPaymentsA();
      unsubPaymentsB && unsubPaymentsB();
      unsubExpensesA && unsubExpensesA();
      unsubExpensesB && unsubExpensesB();
    };
  }, [listsOpen, dateFilter, collectorFilter]);

  /* ===== BALANCE (suscripciones) ===== */
  const [monthOpenLocal, setMonthOpenLocal] = [monthOpen, setMonthOpen]; // alias para claridad

  useEffect(() => {
    if (!monthOpenLocal) return;
    const start = startOfThisMonth();
    const end = startOfTomorrow();

    const unsubPays = onSnapshot(
      query(collection(db, "payments"), where("approvedAt", ">=", start), where("approvedAt", "<", end)),
      (snap) => {
        let sum = 0, cnt = 0;
        snap.forEach((d) => {
          const p = d.data() || {};
          if (p.status === "approved") {
            sum += Number(p.amount || 0);
            cnt += 1;
          }
        });
        setMApprovedSum(sum);
        setMApprovedCount(cnt);
      }
    );

    const unsubExp = onSnapshot(
      query(collection(db, "expenses"), where("createdAt", ">=", start), where("createdAt", "<", end)),
      (snap) => {
        let sum = 0, cnt = 0;
        snap.forEach((d) => {
          const e = d.data() || {};
          sum += Number(e.amount || 0);
          cnt += 1;
        });
        setMExpensesSum(sum);
        setMExpensesCount(cnt);
      }
    );

    return () => {
      unsubPays && unsubPays();
      unsubExp && unsubExp();
    };
  }, [monthOpenLocal]);

  useEffect(() => {
    if (!monthOpenLocal) return;

    const start = new Date(balanceDate + "T00:00:00");
    const end = new Date(balanceDate + "T23:59:59.999");
    const startBuf = new Date(start.getTime() - 6 * 60 * 60 * 1000);
    const endBuf = new Date(end.getTime() + 6 * 60 * 60 * 1000);

    let payA = [], payB = [], expA = [], expB = [];

    const recompute = () => {
      const payUnionRaw = uniqById([...payA, ...payB]);
      const payConsolidated = consolidatePayments(payUnionRaw);
      const sumSubmitted = payConsolidated.reduce((s, p) => s + Number(p.amount || 0), 0);
      setBDayPaySubmitted(sumSubmitted);

      const expUnion = uniqById([...expA, ...expB]);
      const sumExp = expUnion.reduce((s, e) => s + Number(e.amount || 0), 0);
      setBDayExpenses(sumExp);
    };

    const unsubSubmittedA = onSnapshot(
      query(collection(db, "payments"), where("batchDate", "==", balanceDate)),
      (snap) => { payA = snap.docs.map((d) => ({ id: d.id, ...d.data() })); recompute(); }
    );
    const unsubSubmittedB = onSnapshot(
      query(
        collection(db, "payments"),
        where("createdAt", ">=", startBuf),
        where("createdAt", "<=", endBuf)
      ),
      (snap) => { payB = snap.docs.map((d) => ({ id: d.id, ...d.data() })); recompute(); }
    );

    const unsubApproved = onSnapshot(
      query(collection(db, "payments"), where("approvedAt", ">=", start), where("approvedAt", "<=", end)),
      (snap) => {
        let sum = 0;
        snap.forEach((d) => {
          const p = d.data() || {};
          if (p.status === "approved") sum += Number(p.amount || 0);
        });
        setBDayPayApproved(sum);
      }
    );

    const unsubExpA = onSnapshot(
      query(collection(db, "expenses"), where("batchDate", "==", balanceDate)),
      (snap) => { expA = snap.docs.map((d) => ({ id: d.id, ...d.data() })); recompute(); }
    );
    const unsubExpB = onSnapshot(
      query(
        collection(db, "expenses"),
        where("createdAt", ">=", startBuf),
        where("createdAt", "<=", endBuf)
      ),
      (snap) => { expB = snap.docs.map((d) => ({ id: d.id, ...d.data() })); recompute(); }
    );

    return () => {
      unsubSubmittedA && unsubSubmittedA();
      unsubSubmittedB && unsubSubmittedB();
      unsubApproved && unsubApproved();
      unsubExpA && unsubExpA();
      unsubExpB && unsubExpB();
    };
  }, [monthOpenLocal, balanceDate]);

  /* ===== UI ===== */
  const badgeStyle = (cls) => {
    if (cls === "badge-red")   return { background: "#fee2e2", color: "#991b1b", border: "1px solid #fecaca" };
    if (cls === "badge-yellow")return { background: "#fef9c3", color: "#92400e", border: "1px solid #fde68a" };
    if (cls === "badge-green") return { background: "#dcfce7", color: "#166534", border: "1px solid #bbf7d0" };
    return { background: "#f1f5f9", color: "#0f172a", border: "1px solid #e2e8f0" };
  };

  return (
    <div style={{ maxWidth: 1100, margin: "0 auto", padding: 20 }}>
      {/* Encabezado */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "auto 1fr auto",
          alignItems: "center",
          marginBottom: 8,
          columnGap: 10,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: 14, color: "#333" }}>
            {labelFromMaps(auth.currentUser?.email, collectorLabels)}
          </span>
          <button onClick={() => signOut(auth)}>Cerrar sesión</button>
        </div>
        <h2 style={{ textAlign: "center", margin: 0 }}>CAPCORP</h2>

        {/* DERECHA: BALANCE / Listas / Pagos / Correcciones / Cobradores / Campana */}
        <div
          style={{
            display: "flex",
            gap: 10,
            alignItems: "center",
            justifySelf: "end",
          }}
        >
          {/* BALANCE */}
          <div style={{ position: "relative" }} ref={monthRef}>
            <button onClick={() => setMonthOpen((v) => !v)} title="Balance del mes">
              BALANCE
            </button>
            {monthOpen && (
              <div
                style={{
                  position: "absolute",
                  top: "115%",
                  left: 0,
                  background: "#fff",
                  border: "1px solid #ddd",
                  borderRadius: 10,
                  boxShadow: "0 10px 24px rgba(0,0,0,.12)",
                  zIndex: 20,
                  padding: 12,
                  minWidth: 360,
                }}
              >
                <div style={{ fontWeight: 700, marginBottom: 8 }}>Balance</div>

                {/* Mes */}
                <div style={{ fontSize: 12, color: "#555", marginBottom: 6 }}>
                  <b>Mes</b> (1 → {todayISO()})
                </div>
                <div style={{ display: "grid", gap: 6, fontSize: 14, marginBottom: 10 }}>
                  <div>
                    <b>Cobrados (aprobados):</b> {money(mApprovedSum)}{" "}
                    <span style={{ color: "#777" }}>({mApprovedCount})</span>
                  </div>
                  <div>
                    <b>Gastos:</b> {money(mExpensesSum)}{" "}
                    <span style={{ color: "#777" }}>({mExpensesCount})</span>
                  </div>
                  <div>
                    <b>Neto:</b>{" "}
                    <span
                      style={{
                        color: mApprovedSum - mExpensesSum >= 0 ? "#16794f" : "#a40000",
                      }}
                    >
                      {money(mApprovedSum - mExpensesSum)}
                    </span>
                  </div>
                </div>

                {/* Día */}
                <div
                  style={{
                    fontSize: 12,
                    color: "#555",
                    marginBottom: 6,
                    display: "flex",
                    gap: 8,
                    alignItems: "center",
                  }}
                >
                  <b>Día</b>
                  <input
                    type="date"
                    value={balanceDate}
                    onChange={(e) => setBalanceDate(e.target.value || todayISO())}
                    autoComplete="off"
                    data-lpignore="true"
                  />
                </div>
                <div style={{ display: "grid", gap: 6, fontSize: 14 }}>
                  <div><b>Pagos enviados (A∪B):</b> {money(bDayPaySubmitted)}</div>
                  <div><b>Pagos aprobados:</b> {money(bDayPayApproved)}</div>
                  <div><b>Gastos (A∪B):</b> {money(bDayExpenses)}</div>
                  <div>
                    <b>Neto (aprobados - gastos):</b>{" "}
                    <span
                      style={{
                        color: (bDayPayApproved - bDayExpenses) >= 0 ? "#16794f" : "#a40000",
                      }}
                    >
                      {money(bDayPayApproved - bDayExpenses)}
                    </span>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* LISTAS */}
          <button onClick={() => setListsOpen((v) => !v)} title="Listas y cobros">
            📋 Listas y cobros
          </button>

          {/* PAGOS (popover) */}
          <div style={{ position: "relative" }} ref={paymentsRef}>
            <div style={{ position: "relative", display: "inline-block" }}>
              <button onClick={() => setPaymentsOpen((v) => !v)} title="Pagos enviados">
                🧾 Pagos
                {!!submittedCount && (
                  <span
                    style={{
                      position: "absolute",
                      top: -6,
                      right: -6,
                      background: "#d00",
                      color: "#fff",
                      borderRadius: 999,
                      fontSize: 10,
                      padding: "0 5px",
                      lineHeight: "16px",
                      minWidth: 16,
                      textAlign: "center",
                    }}
                  >
                    {submittedCount}
                  </span>
                )}
              </button>
            </div>
            {paymentsOpen && (
              <div
                style={{
                  position: "absolute",
                  top: "115%",
                  right: 0,
                  zIndex: 19,
                  background: "#fff",
                  border: "1px solid #ddd",
                  borderRadius: 10,
                  boxShadow: "0 10px 24px rgba(0,0,0,.12)",
                  padding: 12,
                  width: 980,
                  maxWidth: "calc(100vw - 40px)",
                  maxHeight: "70vh",
                  overflow: "auto",
                }}
              >
                <AdminPayments onAction={() => setPaymentsOpen(false)} />
              </div>
            )}
          </div>

          {/* CORRECCIONES (popover) */}
          <div style={{ position: "relative" }} ref={fixRef}>
            <button onClick={() => setFixOpen(v => !v)} title="Herramientas de corrección">
              🧰 Correcciones
            </button>
            {fixOpen && (
              <div
                style={{
                  position: "absolute",
                  top: "115%",
                  right: 0,
                  zIndex: 21,
                  background: "#fff",
                  border: "1px solid #ddd",
                  borderRadius: 10,
                  boxShadow: "0 10px 24px rgba(0,0,0,.12)",
                  padding: 12,
                  width: 1000,
                  maxWidth: "calc(100vw - 40px)",
                  maxHeight: "70vh",
                  overflow: "auto",
                }}
              >
                <AdminFixTool onDone={() => setFixOpen(false)} />
              </div>
            )}
          </div>

          {/* COBRADORES (admin de alias) */}
          <div style={{ position: "relative" }} ref={collectorsRef}>
            <button onClick={() => setCollectorsOpen(v => !v)} title="Nombres de cobradores">
              👤 Cobradores
            </button>
            {collectorsOpen && (
              <div
                style={{
                  position: "absolute",
                  top: "115%",
                  right: 0,
                  zIndex: 19,
                  background: "#fff",
                  border: "1px solid #ddd",
                  borderRadius: 10,
                  boxShadow: "0 10px 24px rgba(0,0,0,.12)",
                  padding: 12,
                  width: 520,
                  maxHeight: "70vh",
                  overflow: "auto",
                }}
              >
                <div style={{ fontWeight: 700, marginBottom: 8 }}>Alias de cobradores</div>

                {collectors.length === 0 ? (
                  <div style={{ color: "#666", marginBottom: 10 }}>
                    No hay documentos en <code>users</code> con <code>role="collector"</code>.
                    Puedes crear uno abajo.
                  </div>
                ) : (
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "1fr 1fr auto",
                      gap: 8,
                      fontSize: 14,
                      marginBottom: 10,
                      alignItems: "center",
                      fontWeight: 600,
                    }}
                  >
                    <div>Correo</div>
                    <div>Alias (nombre a mostrar)</div>
                    <div></div>
                  </div>
                )}

                {collectors.map((u) => {
                  const val = editAliases[u.id] ?? u.alias ?? "";
                  return (
                    <div
                      key={u.id}
                      style={{
                        display: "grid",
                        gridTemplateColumns: "1fr 1fr auto",
                        gap: 8,
                        alignItems: "center",
                        marginBottom: 6,
                      }}
                    >
                      <div style={{ fontSize: 13, color: "#444", overflow: "hidden", textOverflow: "ellipsis" }}>
                        {u.email}
                      </div>
                      <input
                        value={val}
                        placeholder={u.email}
                        onChange={(e) => setEditAliases((s) => ({ ...s, [u.id]: e.target.value }))}
                      />
                      <button
                        onClick={() => saveCollectorAlias(u.id, val)}
                        disabled={savingCollectorId === u.id}
                      >
                        Guardar
                      </button>
                    </div>
                  );
                })}

                {/* Crear nuevo cobrador */}
                <div style={{ borderTop: "1px dashed #eee", marginTop: 10, paddingTop: 10 }}>
                  <div style={{ fontWeight: 600, marginBottom: 6 }}>Crear cobrador</div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr auto", gap: 8 }}>
                    <input
                      placeholder="correo@dominio.com"
                      value={newCollectorEmail}
                      onChange={(e) => setNewCollectorEmail(e.target.value)}
                    />
                    <input
                      placeholder="Alias a mostrar"
                      value={newCollectorAlias}
                      onChange={(e) => setNewCollectorAlias(e.target.value)}
                    />
                    <button onClick={createCollector}>Crear</button>
                  </div>
                  <div style={{ fontSize: 12, color: "#666", marginTop: 6 }}>
                    Se guarda en <code>users</code> con <code>role="collector</code> y campo <code>alias</code>.
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* CAMPANA */}
          <div style={{ position: "relative" }} ref={bellRef}>
            <button onClick={() => setBellOpen((v) => !v)} title="Comentarios" style={{ position: "relative" }}>
              🔔
              {!!commentsInbox.length && (
                <span
                  style={{
                    position: "absolute",
                    top: -6,
                    right: -6,
                    background: "#d00",
                    color: "#fff",
                    borderRadius: 999,
                    fontSize: 10,
                    padding: "0 5px",
                    lineHeight: "16px",
                    minWidth: 16,
                    textAlign: "center",
                  }}
                >
                  {commentsInbox.length}
                </span>
              )}
            </button>
            {bellOpen && (
              <div
                style={{
                  position: "absolute",
                  top: "115%",
                  right: 0,
                  width: 420,
                  background: "#fff",
                  border: "1px solid #ddd",
                  borderRadius: 10,
                  boxShadow: "0 10px 24px rgba(0,0,0,.12)",
                  zIndex: 10,
                  padding: 10,
                  maxHeight: 420,
                  overflow: "auto",
                }}
              >
                <div style={{ fontWeight: 700, marginBottom: 8 }}>Comentarios recientes</div>
                {!commentsInbox.length ? (
                  <div style={{ color: "#666" }}>No hay comentarios nuevos.</div>
                ) : (
                  commentsInbox.map((c) => (
                    <div
                      key={c.id}
                      style={{
                        border: "1px solid #eee",
                        borderRadius: 8,
                        padding: 8,
                        marginBottom: 8,
                        background: "#fafafa",
                      }}
                    >
                      <div style={{ fontWeight: 600 }}>
                        {clientNameById.get(c.clientId) || c.clientId}
                      </div>
                      <div style={{ fontSize: 12, color: "#444", whiteSpace: "pre-wrap", margin: "4px 0" }}>
                        {c.message || "—"}
                      </div>
                      <div style={{ fontSize: 11, color: "#777", marginBottom: 6 }}>
                        {labelFromMaps(c.createdBy, collectorLabels)} ·{" "}
                        {c.createdAt?.toDate ? c.createdAt.toDate().toLocaleString() : "—"}
                      </div>
                      <div style={{ display: "flex", gap: 6 }}>
                        <button onClick={() => attachCommentAsNote(c)}>Anotar</button>
                        <button onClick={() => markCommentRead(c.id)}>Marcar leído</button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
        </div>
      </div>
{/* Auditoría (rango de fechas, cobrador y PON) */}
<AuditoriaPagos />

      {/* ===== Formulario de registro ===== */}
      <form
        onSubmit={handleRegister}
        style={{
          display: "grid",
          gridTemplateColumns: "220px 160px 150px 140px 110px 1fr auto",
          gap: 8,
          alignItems: "center",
          marginBottom: 12,
        }}
      >
        <input
          placeholder="Nombre y apellido"
          value={nombre}
          onChange={(e) => setNombre(e.target.value)}
          required
        />
        <input
          type="tel"
          placeholder="Teléfono (09XXXXXXXX)"
          value={telefono}
          onChange={(e) => {
            const digits = e.target.value.replace(/\D/g, "").slice(0, 10);
            setTelefono(digits);
          }}
          pattern="^09[0-9]{8}$"
          maxLength={10}
          required
          title="Debe iniciar con 09 y tener 10 dígitos"
        />
        <input
          type="date"
          placeholder="Fecha instalación"
          value={fechaInstalacion}
          onChange={(e) => setFechaInstalacion(e.target.value)}
          required
          autoComplete="off"
          data-lpignore="true"
        />
        <select
          value={ponForm}
          onChange={(e) => setPonForm(e.target.value)}
          required
          title="Selecciona un PON"
        >
          <option value="">Seleccionar PON…</option>
          {PON_OPTIONS.map((op) => (
            <option key={op} value={op}>
              {op}
            </option>
          ))}
        </select>
        <input
          type="text"
          placeholder="Plan (0-999)"
          value={planForm}
          onChange={(e) => {
            const digits = e.target.value.replace(/\D/g, "").slice(0, 3);
            setPlanForm(digits);
          }}
          pattern="[0-9]{1,3}"
          inputMode="numeric"
          maxLength={3}
          required
          title="Numérico, hasta 3 dígitos (0–999)"
        />
        <input
          placeholder="Dirección / Sector"
          value={domicilio}
          onChange={(e) => setDomicilio(e.target.value)}
        />
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            whiteSpace: "nowrap",
            justifyContent: "flex-end",
          }}
        >
          <label style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <input
              type="checkbox"
              checked={exoneradoForm}
              onChange={(e) => setExoneradoForm(e.target.checked)}
            />
            Exonerado
          </label>
          <button type="submit">Registrar</button>
          <button type="button" onClick={handleClear}>
            Limpiar
          </button>
        </div>
      </form>

      {/* ===== Filtros (Estado + PON + búsqueda) ===== */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "260px 200px 1fr",
          gap: 10,
          alignItems: "center",
          marginBottom: 10,
        }}
      >
        <select
          value={filterEstado}
          onChange={(e) => setFilterEstado(e.target.value)}
          title="Filtrar por estado mensual"
        >
          <option value="Todos">Todos ({counts.todos})</option>
          <option value="Pendiente">Pendientes ({counts.pend})</option>
          <option value="Pagado">Pagados ({counts.paga})</option>
          <option value="Exonerado">Exonerados ({counts.exon})</option>
        </select>

        {/* PON */}
        <div style={{ position: "relative" }} ref={ponRef}>
          <button onClick={() => setPonOpen((v) => !v)} style={{ width: 200 }}>
            {ponSel === "Todos" ? "PON ▾" : `${ponSel} ▾`}
          </button>
          {ponOpen && (
            <div
              style={{
                position: "absolute",
                top: "110%",
                left: 0,
                background: "#fff",
                border: "1px solid #ddd",
                borderRadius: 8,
                boxShadow: "0 8px 20px rgba(0,0,0,.12)",
                minWidth: 200,
                zIndex: 5,
                padding: 6,
                maxHeight: 260,
                overflow: "auto",
              }}
            >
              {ponList.map((p) => (
                <div
                  key={p}
                  onClick={() => {
                    setPonSel(p);
                    setPonOpen(false);
                  }}
                  style={{
                    padding: "6px 10px",
                    cursor: "pointer",
                    borderRadius: 6,
                    fontWeight: ponSel === p ? 700 : 400,
                    background: ponSel === p ? "#f5f5f5" : "transparent",
                  }}
                >
                  {p}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Búsqueda */}
        <input
          placeholder="Buscar por nombre…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {/* ======= PANEL INLINE: LISTAS Y COBROS ======= */}
      {listsOpen && (
        <div
          style={{
            marginBottom: 12,
            background: "#fff",
            border: "1px solid #ddd",
            borderRadius: 10,
            boxShadow: "0 6px 16px rgba(0,0,0,.08)",
            padding: 12,
          }}
        >
          {/* Filtros Listas */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "150px 260px 1fr",
              gap: 10,
              alignItems: "center",
              marginBottom: 10,
            }}
          >
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <label style={{ fontSize: 12, color: "#555" }}>Fecha</label>
              <input
                type="date"
                value={dateFilter}
                onChange={(e) => setDateFilter(e.target.value)}
                autoComplete="off"
                data-lpignore="true"
              />
            </div>
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <label style={{ fontSize: 12, color: "#555" }}>Cobrador</label>
              <select
                value={collectorFilter}
                onChange={(e) => setCollectorFilter(e.target.value)}
                style={{ minWidth: 200 }}
              >
                {collectorOptions.map((op) => (
                  <option key={op} value={op}>
                    {op === "Todos" ? "Todos" : labelFromMaps(op, collectorLabels)}
                  </option>
                ))}
              </select>
            </div>
            <div style={{ textAlign: "right", color: "#666", fontSize: 12 }}>
              {dateFilter ? `Mostrando listas del ${dateFilter}` : "Elige una fecha para filtrar"}
            </div>
          </div>

          {/* Contenido Listas */}
          {!listGroups.length ? (
            <div style={{ color: "#666" }}>
              No hay pagos para los filtros seleccionados.
            </div>
          ) : (
            <div style={{ display: "grid", gap: 12 }}>
              {listGroups.map((g) => {
                const colLabel = labelFromMaps(g.collector, collectorLabels);
                return (
                  <div key={g.collector} style={{ border: "1px solid #eee", borderRadius: 8 }}>
                    <div
                      style={{
                        padding: "8px 10px",
                        background: "#fafafa",
                        borderBottom: "1px solid #eee",
                        borderTopLeftRadius: 8,
                        borderTopRightRadius: 8,
                        fontWeight: 600,
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        gap: 10,
                      }}
                    >
                      <div>
                        {colLabel} • {g.count} pago(s) • Total: {money(g.total)}{" "}
                        <span style={{ color: "#666", fontWeight: 400, marginLeft: 8 }}>
                          {Object.entries(g.statuses).map(([s, n]) => `${s}: ${n}`).join(" · ")}
                        </span>
                        <span style={{ marginLeft: 12 }}>
                          • Gastos: <b>{money(g.expenseTotal)}</b> ({g.expenseCount})
                        </span>
                        <span style={{ marginLeft: 12 }}>
                          • <b>Neto: {money(g.net)}</b>
                        </span>
                      </div>
                      <button onClick={() => exportCSV(g)} title="Exportar CSV">CSV</button>
                    </div>

                    <div style={{ padding: 10 }}>
                      <div
                        style={{
                          display: "grid",
                          gridTemplateColumns: "140px 1fr 120px 110px 120px",
                          gap: 8,
                          fontWeight: 600,
                          paddingBottom: 6,
                          borderBottom: "1px dashed #eee",
                        }}
                      >
                        <div>Fecha/hora</div>
                        <div>Cliente</div>
                        <div>Monto</div>
                        <div>Tipo</div>
                        <div>Estado</div>
                      </div>

                      {g.items.map((p) => (
                        <div
                          key={p.id}
                          style={{
                            display: "grid",
                            gridTemplateColumns: "140px 1fr 120px 110px 120px",
                            gap: 8,
                            padding: "6px 0",
                            borderBottom: "1px dashed #f3f3f3",
                            alignItems: "center",
                          }}
                        >
                          <div>{formatRowDateTime(p)}</div>
                          <div>{clientNameById.get(p.clientId) || p.clientId}</div>
                          <div>{money(p.amount)}</div>
                          <div>{p.type || "—"}</div>
                          <div>{p.status || "—"}</div>
                        </div>
                      ))}

                      {g.expenses.length > 0 && (
                        <>
                          <div style={{ marginTop: 12, fontWeight: 600 }}>Gastos</div>
                          <div
                            style={{
                              display: "grid",
                              gridTemplateColumns: "160px 1fr 140px",
                              gap: 8,
                              fontWeight: 600,
                              padding: "6px 0",
                              borderBottom: "1px dashed #eee",

                            }}
                          >
                            <div>Fecha/hora</div>
                            <div>Descripción</div>
                            <div>Monto</div>
                          </div>
                          {g.expenses.map((e) => (
                            <div
                              key={e.id}
                              style={{
                                display: "grid",
                                gridTemplateColumns: "160px 1fr 140px",
                                gap: 8,
                                padding: "6px 0",
                                borderBottom: "1px dashed #f3f3f3",
                                alignItems: "center",
                              }}
                            >
                              <div>
                                {e.createdAt?.toDate ? e.createdAt.toDate().toLocaleString() : "—"}
                              </div>
                              <div>{getExpenseDesc(e)}</div>
                              <div>{money(e.amount)}</div>
                            </div>
                          ))}
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ===== Cabecera lista de clientes ===== */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1.2fr 1fr 520px",
          gap: 10,
          fontWeight: 700,
          padding: "8px 0",
          borderTop: "2px solid #ddd",
        }}
      >
        <div>NOMBRE</div>
        <div>ESTADO</div>
        <div style={{ justifySelf: "end" }}>ACCIONES</div>
      </div>

      {/* Filas */}
      {visibles.map((c) => {
        const isOpen = !!openRows[c.id];
        const isEditing = editId === c.id;

        return (
          <div key={c.id} style={{ borderTop: "1px dashed #ddd", padding: "10px 0" }}>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1.2fr 1fr 520px",
                gap: 10,
                alignItems: "center",
              }}
            >
              {/* NOMBRE + chips (PON / NUEVO / Nota) */}
{/* COLUMNA 1: NOMBRE + etiquetas */}
<div
  style={{
    fontWeight: 700,
    display: "inline-flex",
    alignItems: "center",
    gap: 8,
    flexWrap: "wrap",
  }}
>
  <span style={c.isNew ? { color: "#1d4ed8", fontWeight: 800 } : undefined}>
  {c.nombre}
</span>
 {c.isNew && (
    // Chip "NUEVO"
    <span
      style={{
        fontSize: 11,
        background: "#dcfce7",
        color: "#166534",
        border: "1px solid #bbf7d0",
        padding: "1px 8px",
        borderRadius: 999,
        fontWeight: 800,
        letterSpacing: 0.2,
      }}
      title="Cliente registrado este mes"
    >
      NUEVO
    </span>
  )}

  {!!c.alerta && (
    // Chip "Nota"
    <span
      style={{
        fontSize: 12,
        background: "#fff3cd",
        border: "1px solid #ffe69c",
        padding: "1px 6px",
        borderRadius: 999,
      }}
      title={c.alerta}
    >
      Nota
    </span>
  )}
</div>


              {/* ESTADO */}
              <div>
                {c.exonerado ? (
                  <span
                    style={{
                      fontSize: 12,
                      padding: "2px 8px",
                      borderRadius: 999,
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
                ) : c.saldoMes <= 0 ? (
                  <span
                    style={{
                      fontSize: 12,
                      padding: "2px 8px",
                      borderRadius: 999,
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
                ) : c.badge ? (
                  // NUEVO: badge por meses vencidos (1 = amarillo, >=2 = rojo)
                  <span
                    style={{
                      fontSize: 12,
                      padding: "2px 8px",
                      borderRadius: 999,
                      marginRight: 8,
                      fontWeight: 700,
                      textTransform: "uppercase",
                      ...badgeStyle(c.badge.cls),
                    }}
                    title={
                      c.monthsDue >= 2
                        ? "Tiene 2 meses o más vencidos desde la instalación"
                        : "Tiene 1 mes vencido desde la instalación"
                    }
                  >
                    {c.badge.label}
                  </span>
                ) : !dueReachedThisMonth(c.fechaInstalacion) ? (
                  <span
                    style={{
                      fontSize: 12,
                      padding: "2px 8px",
                      borderRadius: 999,
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
                ) : (
                  (() => {
                    const { label, cls } = pendingBadgeForClient(c);
                    return (
                      <span
                        style={{
                          fontSize: 12,
                          padding: "2px 8px",
                          borderRadius: 999,
                          marginRight: 8,
                          fontWeight: 700,
                          textTransform: "uppercase",
                          ...badgeStyle(cls),
                        }}
                      >
                        {label}
                      </span>
                    );
                  })()
                )}

                <span>
                  Saldo: <b>{money(c.saldoMes)}</b>
                </span>
                {c.isNew && c.monthsNewYM > 0 && (
  <span style={{ marginLeft: 10, fontSize: 12, color: "#6b7280" }}>
    • {c.monthsNewYM} mes{c.monthsNewYM > 1 ? "es" : ""} vencido{c.monthsNewYM > 1 ? "s" : ""}
  </span>
)}

              </div>

              <div
                style={{
                  justifySelf: "end",
                  display: "flex",
                  gap: 8,
                  flexWrap: "wrap",
                }}
              >
                {!isEditing ? (
                  <>
                    <button
                      onClick={() => handleCharge(c)}
                      disabled={c.exonerado || c.planMes === 0}
                      title={
                        c.exonerado
                          ? "Cliente exonerado"
                          : c.planMes === 0
                          ? "El mes actual no genera cargo (instalación)"
                          : "Cobro FIFO"
                      }
                    >
                      Cobrar
                    </button>
                    <button onClick={() => toggleInfo(c.id)}>
                      {isOpen ? "Ocultar" : "Info"}
                    </button>
                  </>
                ) : (
                  <>
                    <button onClick={saveEdit} style={{ background: "#0b5", color: "#fff" }}>
                      Guardar
                    </button>
                    <button onClick={cancelEdit} className="secondary">
                      Cancelar
                    </button>
                  </>
                )}
              </div>
            </div>

            {/* Info */}
            {isOpen && !isEditing && (
              <div style={{ marginTop: 8, paddingLeft: 4 }}>
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns:
                      "1.2fr 1.2fr 0.8fr 1fr 1.4fr 1.2fr 0.8fr",
                    gap: 10,
                  }}
                >
                  <div><b>Teléfono:</b> {c.telefono || "—"}</div>
                  <div><b>Fecha instalación:</b> {c.fechaInstalacion || "—"}</div>
                  <div><b>PON:</b> {String(c.pon ?? "—")}</div>
                  <div><b>Plan (mes):</b> {money(c.plan)}</div>
                  <div><b>Saldo del mes:</b> {money(c.saldoMes)}</div>
                  <div><b>Saldo mes (incl. enviados):</b> {money(c.saldoMesAfterSubmitted)}</div>
                  <div><b>Exonerado:</b> {c.exonerado ? "Sí" : "No"}</div>
                </div>
                <div style={{ marginTop: 6 }}>
                  <b>Últ. pagado:</b> {c.lastPaidPeriod || "—"}
                </div>
                {!!c.alerta && (
                  <div style={{ marginTop: 6, color: "#664d03" }}>
                    <b>Nota:</b> {c.alerta}
                  </div>
                )}
                <div style={{ marginTop: 10, display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <button onClick={() => addNoteToClient(c)}>Añadir nota</button>
                  <button
                    onClick={() => clearNoteFromClient(c)}
                    disabled={!c.alerta}
                    title={c.alerta ? "Eliminar nota" : "Sin nota"}
                  >
                    Eliminar nota
                  </button>
                  <button onClick={() => startEdit(c)}>Editar</button>
                  <button
                    onClick={() => handleDelete(c)}
                    style={{ background: "#fff0f0", border: "1px solid #f2b5b5" }}
                    title="Eliminar cliente (no elimina sus pagos)"
                  >
                    Eliminar
                  </button>
                  <button onClick={() => handleRevertMonth(c)}>Revertir mes actual</button>
                </div>
              </div>
            )}

            {/* Edición inline */}
            {isEditing && (
              <div
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !(e.ctrlKey || e.metaKey)) e.preventDefault();
                }}
                style={{
                  marginTop: 10,
                  padding: 10,
                  border: "1px solid #eee",
                  borderRadius: 8,
                  background: "#fafafa",
                }}
              >
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns:
                      "1.2fr 1fr 1fr 1fr 0.8fr 1.4fr 0.9fr",
                    gap: 8,
                    alignItems: "center",
                  }}
                >
                  <div>
                    <label style={{ fontSize: 12, color: "#666" }}>Nombre</label>
                    <input
                      value={editData.nombre}
                      onChange={(e) =>
                        setEditData((s) => ({ ...s, nombre: e.target.value }))
                      }
                    />
                  </div>
                  <div>
                    <label style={{ fontSize: 12, color: "#666" }}>Teléfono</label>
                    <input
                      type="tel"
                      value={editData.telefono}
                      onChange={(e) =>
                        setEditData((s) => ({
                          ...s,
                          telefono: e.target.value.replace(/\D/g, "").slice(0, 10),
                        }))
                      }
                      pattern="^09\d{8}$"
                      maxLength={10}
                      title="Debe iniciar con 09 y tener 10 dígitos"
                    />
                  </div>
                  <div>
                    <label style={{ fontSize: 12, color: "#666" }}>Fecha instalación</label>
                    <input
                      type="date"
                      value={editData.fechaInstalacion}
                      onChange={(e) =>
                        setEditData((s) => ({ ...s, fechaInstalacion: e.target.value }))
                      }
                      autoComplete="off"
                      data-lpignore="true"
                    />
                  </div>
                  <div>
                    <label style={{ fontSize: 12, color: "#666" }}>PON</label>
                    <select
                      value={editData.pon}
                      onChange={(e) => setEditData((s) => ({ ...s, pon: e.target.value }))}
                    >
                      <option value="">Seleccionar PON…</option>
                      {PON_OPTIONS.map((op) => (
                        <option key={op} value={op}>
                          {op}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label style={{ fontSize: 12, color: "#666" }}>Plan</label>
                    <input
                      type="text"
                      value={editData.plan}
                      onChange={(e) =>
                        setEditData((s) => ({
                          ...s,
                          plan: e.target.value.replace(/\D/g, "").slice(0, 3),
                        }))
                      }
                      pattern="[0-9]{1,3}"
                      inputMode="numeric"
                      maxLength={3}
                      title="Numérico, hasta 3 dígitos (0–999)"
                    />
                  </div>
                  <div>
                    <label style={{ fontSize: 12, color: "#666" }}>Dirección / Sector</label>
                    <input
                      value={editData.domicilio}
                      onChange={(e) =>
                        setEditData((s) => ({ ...s, domicilio: e.target.value }))
                      }
                    />
                  </div>
                  <div>
                    <label style={{ fontSize: 12, color: "#666" }}>Exonerado</label>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <input
                        type="checkbox"
                        checked={!!editData.exonerado}
                        onChange={(e) =>
                          setEditData((s) => ({ ...s, exonerado: e.target.checked }))
                        }
                      />
                      <span style={{ fontSize: 12 }}>No factura</span>
                    </div>
                  </div>
                </div>
                <div style={{ marginTop: 10, display: "flex", gap: 8 }}>
                  <button onClick={saveEdit} style={{ background: "#0b5", color: "#fff" }}>
                    Guardar cambios
                  </button>
                  <button onClick={cancelEdit} className="secondary">
                    Cancelar
                  </button>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
