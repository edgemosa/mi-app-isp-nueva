/// src/components/AdminPayments.jsx
import { useEffect, useMemo, useState } from "react";
import { db, auth } from "../lib/firebase";
import {
  collection,
  onSnapshot,
  query,
  where,
  orderBy,
  doc,
  serverTimestamp,
  writeBatch,
} from "firebase/firestore";

/* ========== Helpers (alineados con AdminPanel) ========== */
// Fecha local YYYY-MM-DD (no UTC)
const todayISO = () => {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};

const money = (n) => `$${Number(n || 0).toFixed(2)}`;
const uniqById = (arr) => Array.from(new Map(arr.map((x) => [x.id, x])).values());

// Alias rápidos (opcional).
const COLLECTOR_ALIASES = {
  "jeffersonhajajsvsh12@gmail.com": "JEFERSON",
};

const labelFromMaps = (email, labelsMap) =>
  email ? (labelsMap.get(email) || COLLECTOR_ALIASES[email] || email) : "—";

// Clave lógica de un pago (para consolidar duplicados legacy)
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

// Presenta "YYYY-MM-DD HH:MM:SS" usando batchDate + hora de createdAt
function formatRowDateTime(p) {
  const datePart =
    typeof p.batchDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(p.batchDate)
      ? p.batchDate
      : p.createdAt?.toDate?.()
      ? p.createdAt.toDate().toISOString().slice(0, 10)
      : "—";
  const timePart = p.createdAt?.toDate?.()
    ? p.createdAt.toDate().toLocaleTimeString()
    : "—";
  return `${datePart} ${timePart}`;
}

export default function AdminPayments({ onAction }) {
  const [dateSel, setDateSel] = useState(todayISO());
  const [statusSel, setStatusSel] = useState("submitted");

  // NUEVO: filtros UI
  const [collectorFilter, setCollectorFilter] = useState("Todos");
  const [showRejected, setShowRejected] = useState(false);

  const [rows, setRows] = useState([]);           // filas consolidadas (A∪B)
  const [docsCount, setDocsCount] = useState(0);  // documentos reales tras unión A∪B
  const [clientsMap, setClientsMap] = useState(new Map());
  const [collectorLabels, setCollectorLabels] = useState(new Map()); // alias cobradores
  const [collectorOptions, setCollectorOptions] = useState(["Todos"]); // NUEVO
  const [busyId, setBusyId] = useState(null);     // para deshabilitar botón mientras corrige
  const [exporting, setExporting] = useState(false);

  const currentUserEmail = auth.currentUser?.email || "admin@capcorp.com";

  // Persistencia del toggle "Mostrar rechazados"
  useEffect(() => {
    try {
      const v = typeof window !== "undefined" && localStorage.getItem("ap_showRejected") === "1";
      setShowRejected(!!v);
    } catch {}
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem("ap_showRejected", showRejected ? "1" : "0");
    } catch {}
  }, [showRejected]);

  /* ==== Clientes (nombres) ==== */
  useEffect(() => {
    const unsub = onSnapshot(query(collection(db, "clients")), (snap) => {
      const m = new Map();
      snap.forEach((d) => m.set(d.id, d.data()?.nombre || d.id));
      setClientsMap(m);
    });
    return () => unsub && unsub();
  }, []);

  /* ==== Alias de cobradores ==== */
  useEffect(() => {
    const unsub = onSnapshot(
      query(collection(db, "users"), where("role", "==", "collector")),
      (snap) => {
        const labels = new Map();
        const emails = [];
        snap.forEach((d) => {
          const u = d.data() || {};
          const email = String(u.email || "").trim();
          const lbl = String(u.alias || u.displayName || u.name || "").trim();
          if (email) {
            labels.set(email, lbl || email);
            emails.push(email);
          }
        });
        emails.sort((a, b) => (labels.get(a) || a).localeCompare(labels.get(b) || b));
        setCollectorLabels(labels);
        setCollectorOptions(["Todos", ...emails]);
      },
      // fallback si no hay users
      () => {
        setCollectorLabels(new Map());
        setCollectorOptions(["Todos"]);
      }
    );
    return () => unsub && unsub();
  }, []);

  /* ==== Pagos del día (A ∪ B) ==== */
  useEffect(() => {
    if (!dateSel) return;

    const start = new Date(dateSel + "T00:00:00");
    const end = new Date(dateSel + "T23:59:59.999");
    // Buffer ±6h por si el cliente está cerca del cambio de día
    const startBuf = new Date(start.getTime() - 6 * 60 * 60 * 1000);
    const endBuf = new Date(end.getTime() + 6 * 60 * 60 * 1000);

    const statusClause =
      statusSel && statusSel !== "Todos" ? [where("status", "==", statusSel)] : [];

    let rowsA = []; // por batchDate
    let rowsB = []; // por createdAt

    const mergeAndSet = () => {
      const merged = uniqById([...rowsA, ...rowsB]);
      merged.sort(
        (a, b) => (b.createdAt?.toMillis?.() ?? 0) - (a.createdAt?.toMillis?.() ?? 0)
      );
      setDocsCount(merged.length);
      setRows(consolidatePayments(merged));
    };

    const unsubA = onSnapshot(
      query(
        collection(db, "payments"),
        ...statusClause,
        where("batchDate", "==", dateSel),
        orderBy("createdAt", "desc")
      ),
      (snap) => {
        rowsA = snap.docs.map((d) => ({ id: d.id, ...d.data() })); mergeAndSet();
      }
    );

    const unsubB = onSnapshot(
      query(
        collection(db, "payments"),
        ...statusClause,
        where("createdAt", ">=", startBuf),
        where("createdAt", "<=", endBuf),
        orderBy("createdAt", "desc")
      ),
      (snap) => {
        rowsB = snap.docs.map((d) => ({ id: d.id, ...d.data() })); mergeAndSet();
      }
    );

    return () => {
      unsubA && unsubA();
      unsubB && unsubB();
    };
  }, [dateSel, statusSel]);

  // === Derivados con filtros locales (cobrador / rechazos) ===
  const rowsFiltered = useMemo(() => {
    let arr = rows;
    if (collectorFilter !== "Todos") {
      arr = arr.filter((p) => p.createdBy === collectorFilter);
    }
    if (statusSel === "Todos" && !showRejected) {
      arr = arr.filter((p) => String(p.status) !== "rejected");
    }
    return arr;
  }, [rows, collectorFilter, statusSel, showRejected]);

  const totalAmount = useMemo(
    () => rowsFiltered.reduce((s, p) => s + Number(p.amount || 0), 0),
    [rowsFiltered]
  );

  // === ACTUALIZAR TODOS LOS DOCUMENTOS DEL GRUPO CONSOLIDADO ===
  const idsOf = (p) => (Array.isArray(p._ids) && p._ids.length ? p._ids : [p.id]);

  const updateGroup = async (p, updater) => {
    const ids = idsOf(p);
    const batch = writeBatch(db);
    ids.forEach((id) => {
      const ref = doc(db, "payments", id);
      updater(batch, ref);
    });
    await batch.commit();
  };

  const approvePayment = async (p) => {
    const ids = idsOf(p);
    const batch = writeBatch(db);
    ids.forEach((id) => {
      batch.update(doc(db, "payments", id), {
        status: "approved",
        approvedAt: serverTimestamp(),
        approvedBy: currentUserEmail,
        updatedAt: serverTimestamp(),
        updatedBy: currentUserEmail,
      });
    });
    await batch.commit();
    onAction?.(); // cierra popover si viene desde AdminPanel
  };

  const rejectPayment = async (p) => {
    const ids = idsOf(p);
    const batch = writeBatch(db);
    ids.forEach((id) => {
      batch.update(doc(db, "payments", id), {
        status: "rejected",
        rejectedAt: serverTimestamp(),
        rejectedBy: currentUserEmail,
        updatedAt: serverTimestamp(),
        updatedBy: currentUserEmail,
      });
    });
    await batch.commit();
    onAction?.();
  };

  // === Correcciones ===
  const revertToSubmitted = (p) =>
    updateGroup(p, (batch, ref) => {
      batch.update(ref, {
        status: "submitted",
        approvedAt: null,
        approvedBy: null,
        rejectedAt: null,
        rejectedBy: null,
        updatedAt: serverTimestamp(),
        updatedBy: currentUserEmail,
      });
    });

  const changeBatchDateForGroup = (p, newDate) =>
    updateGroup(p, (batch, ref) => {
      batch.update(ref, {
        batchDate: newDate,
        updatedAt: serverTimestamp(),
        updatedBy: currentUserEmail,
      });
    });

  const changePeriodForGroup = (p, newPeriod) =>
    updateGroup(p, (batch, ref) => {
      batch.update(ref, {
        period: newPeriod,
        updatedAt: serverTimestamp(),
        updatedBy: currentUserEmail,
      });
    });

  const fixPayment = async (p) => {
    try {
      setBusyId(p.id);
      const choice = prompt(
        "Corrección:\n1 = Revertir a 'submitted'\n2 = Cambiar fecha de lote (YYYY-MM-DD)\n3 = Cambiar período (YYYY-MM)\n\nElige 1, 2 o 3:"
      );
      if (!choice) return;

      if (choice.trim() === "1") {
        await revertToSubmitted(p);
        alert("Revertido a 'submitted'.");
        return;
      }
      if (choice.trim() === "2") {
        const nd = prompt("Nueva fecha de lote (YYYY-MM-DD):", p.batchDate || todayISO());
        if (!nd) return;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(nd)) {
          alert("Fecha inválida.");
          return;
        }
        await changeBatchDateForGroup(p, nd);
        alert("Fecha de lote actualizada.");
        return;
      }
      if (choice.trim() === "3") {
        const np = prompt("Nuevo período (YYYY-MM):", p.period || "");
        if (!np) return;
        if (!/^\d{4}-\d{2}$/.test(np)) {
          alert("Período inválido.");
          return;
        }
        await changePeriodForGroup(p, np);
        alert("Período actualizado.");
        return;
      }

      alert("Opción no válida.");
    } catch (e) {
      alert("No se pudo aplicar la corrección: " + (e?.message || String(e)));
    } finally {
      setBusyId(null);
    }
  };

  // === NUEVO: acciones masivas sobre los visibles ===
  const approveAllVisible = async () => {
    if (!rowsFiltered.length) return;
    if (!confirm(`Aprobar ${rowsFiltered.length} grupo(s) visibles?`)) return;
    // Para no pasar el límite de 500 op por batch, iteramos grupo a grupo
    for (const p of rowsFiltered) {
      await approvePayment(p);
    }
    alert("Aprobados.");
  };

  const rejectAllVisible = async () => {
    if (!rowsFiltered.length) return;
    if (!confirm(`Rechazar ${rowsFiltered.length} grupo(s) visibles?`)) return;
    for (const p of rowsFiltered) {
      await rejectPayment(p);
    }
    alert("Rechazados.");
  };

  // === NUEVO: export CSV de los visibles
  const exportCSV = async () => {
    if (!rowsFiltered.length) {
      alert("No hay filas para exportar.");
      return;
    }
    try {
      setExporting(true);
      const decimalComma = (1.1).toLocaleString().includes(",");
      const SEP = decimalComma ? ";" : ",";
      const lines = [
        `FECHA${SEP}CLIENTE${SEP}COBRADOR${SEP}MONTO${SEP}TIPO${SEP}PERIODO${SEP}ESTADO`,
      ];
      for (const p of rowsFiltered) {
        const fecha = formatRowDateTime(p).replaceAll('"', '""');
        const cliente = (clientsMap.get(p.clientId) || p.clientId || "").replaceAll('"', '""');
        const cobrador = (labelFromMaps(p.createdBy, collectorLabels) || "").replaceAll('"', '""');
        const monto = Number(p.amount || 0).toFixed(2);
        const tipo = (p.type || "").replaceAll('"', '""');
        const per = (p.period || "").replaceAll('"', '""');
        const st = (p.status || "").replaceAll('"', '""');
        lines.push(`"${fecha}"${SEP}"${cliente}"${SEP}"${cobrador}"${SEP}${monto}${SEP}"${tipo}"${SEP}"${per}"${SEP}"${st}"`);
      }
      const csv = "\uFEFF" + lines.join("\n");
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const safeLbl = String(dateSel || todayISO()).replace(/[^\w\-]+/g, "_").slice(0, 40);
      a.download = `pagos_${safeLbl}_${statusSel}_${collectorFilter}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } finally {
      setExporting(false);
    }
  };

  return (
    <div style={{ minWidth: 980 }}>
      {/* === Estilos 3D para botones === */}
      <style>{`
        .btn-3d {
          appearance: none;
          border-radius: 8px;
          padding: 6px 12px;
          font-weight: 600;
          cursor: pointer;
          border: 1px solid #cfd4dc;
          box-shadow: 0 3px 0 rgba(0,0,0,.12), 0 8px 16px rgba(0,0,0,.08);
          transform: translateY(0);
          transition: transform .04s ease, box-shadow .04s ease, filter .12s ease, background .12s ease;
          user-select: none;
        }
        .btn-3d:active {
          transform: translateY(2px);
          box-shadow: 0 1px 0 rgba(0,0,0,.12), inset 0 2px 6px rgba(0,0,0,.08);
        }
        .btn-approve {
          background: linear-gradient(#13a154, #0a7d34);
          color: #fff;
          border-color: #0a6a2f;
        }
        .btn-approve:hover { filter: brightness(1.05); }
        .btn-reject {
          background: #fff;
          color: #a40000;
          border-color: #f2b5b5;
        }
        .btn-reject:hover { background: #fff6f6; }
        .btn-disabled { opacity: .6; cursor: not-allowed; }
      `}</style>

      {/* Filtros de cabecera */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr auto auto auto auto",
          gap: 10,
          alignItems: "center",
          marginBottom: 10,
        }}
      >
        <div style={{ fontWeight: 700, fontSize: 18 }}>
          Pagos {statusSel === "submitted" ? "por aprobar" : ""}
          <span style={{ fontWeight: 400, fontSize: 14, marginLeft: 8 }}>
            Fecha lote: <b>{dateSel}</b> • Estado: <b>{statusSel}</b> •
            Grupos: <b>{rowsFiltered.length}</b>{" "}
            <span style={{ color: "#666" }}>(doc. reales: {docsCount})</span>
          </span>
        </div>

        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <label style={{ fontSize: 12, color: "#555" }}>Fecha lote</label>
          <input
            type="date"
            value={dateSel}
            onChange={(e) => setDateSel(e.target.value || todayISO())}
          />
        </div>

        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <label style={{ fontSize: 12, color: "#555" }}>Estado</label>
          <select value={statusSel} onChange={(e) => setStatusSel(e.target.value)}>
            <option value="submitted">submitted</option>
            <option value="approved">approved</option>
            <option value="rejected">rejected</option>
            <option value="Todos">Todos</option>
          </select>
        </div>

        {/* NUEVO: filtro por cobrador */}
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <label style={{ fontSize: 12, color: "#555" }}>Cobrador</label>
          <select value={collectorFilter} onChange={(e) => setCollectorFilter(e.target.value)}>
            {collectorOptions.map((op) => (
              <option key={op} value={op}>
                {op === "Todos" ? "Todos" : labelFromMaps(op, collectorLabels)}
              </option>
            ))}
          </select>
        </div>

        {/* NUEVO: toggle mostrar rechazados (solo aplica si Estado=Todos) */}
        <label style={{ display: "flex", gap: 6, alignItems: "center" }} title="Ocultar/mostrar rechazados cuando Estado=Todos">
          <input
            type="checkbox"
            checked={showRejected}
            onChange={(e) => setShowRejected(e.target.checked)}
          />
          <span style={{ fontSize: 12, color: "#555" }}>Mostrar rechazados</span>
        </label>
      </div>

      <div style={{ marginBottom: 8, color: "#333", display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <span>
          <b>{rowsFiltered.length}</b> grupo(s) • Total: <b>{money(totalAmount)}</b>
          <span style={{ color: "#666" }}> — documentos reales: {docsCount}</span>
        </span>

        {/* NUEVO: acciones masivas */}
        <div style={{ display: "flex", gap: 8 }}>
          <button
            className="btn-3d btn-approve"
            onClick={approveAllVisible}
            disabled={!rowsFiltered.length || statusSel === "approved"}
            title="Aprobar todos los visibles"
          >
            Aprobar visibles
          </button>
          <button
            className="btn-3d btn-reject"
            onClick={rejectAllVisible}
            disabled={!rowsFiltered.length || statusSel === "rejected"}
            title="Rechazar todos los visibles"
          >
            Rechazar visibles
          </button>
          <button
            className={`btn-3d ${exporting ? "btn-disabled" : ""}`}
            onClick={exportCSV}
            disabled={exporting || !rowsFiltered.length}
            title="Exportar CSV de los visibles"
          >
            CSV
          </button>
        </div>
      </div>

      {!rowsFiltered.length ? (
        <div style={{ color: "#666" }}>No hay pagos para esos filtros.</div>
      ) : (
        <>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "170px 1fr 180px 110px 90px 110px 200px",
              gap: 8,
              fontWeight: 600,
              paddingBottom: 6,
              borderBottom: "1px dashed #eee",
            }}
          >
            <div>Fecha/horario</div>
            <div>Cliente</div>
            <div>Cobrador</div>
            <div>Monto</div>
            <div>Tipo</div>
            <div>Periodo</div>
            <div>Acciones</div>
          </div>

          {rowsFiltered.map((p) => (
            <div
              key={p.id}
              style={{
                display: "grid",
                gridTemplateColumns: "170px 1fr 180px 110px 90px 110px 200px",
                gap: 8,
                padding: "6px 0",
                borderBottom: "1px dashed #f3f3f3",
                alignItems: "center",
              }}
            >
              <div>{formatRowDateTime(p)}</div>
              <div>{clientsMap.get(p.clientId) || p.clientId}</div>
              <div>{labelFromMaps(p.createdBy, collectorLabels)}</div>
              <div style={{ fontWeight: 600 }}>{money(p.amount)}</div>
              <div>{p.type || "—"}</div>
              <div>{p.period || "—"}</div>
              <div>
                {p.status === "submitted" ? (
                  <>
                    <button
                      className="btn-3d btn-approve"
                      onClick={() => approvePayment(p)}
                      style={{ marginRight: 6 }}
                    >
                      Aprobar
                    </button>
                    <button
                      className="btn-3d btn-reject"
                      onClick={() => rejectPayment(p)}
                    >
                      Rechazar
                    </button>
                  </>
                ) : (
                  <>
                    <span
                      style={{
                        fontSize: 12,
                        padding: "2px 8px",
                        borderRadius: 999,
                        border: "1px solid #ddd",
                        background: p.status === "approved" ? "#e8fff0" : "#fff4e8",
                        color: p.status === "approved" ? "#16794f" : "#9a5e00",
                        marginRight: 8,
                        textTransform: "uppercase",
                        fontWeight: 700,
                      }}
                    >
                      {p.status}
                    </span>
                    <button
                      className={`btn-3d ${busyId === p.id ? "btn-disabled" : ""}`}
                      onClick={() => fixPayment(p)}
                      disabled={busyId === p.id}
                      title="Revertir o cambiar fecha/periodo del pago"
                    >
                      Corrección
                    </button>
                  </>
                )}
              </div>
            </div>
          ))}
        </>
      )}
    </div>
  );
}
