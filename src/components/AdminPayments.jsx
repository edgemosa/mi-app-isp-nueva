// src/components/AdminPayments.jsx
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

/* ========== Helpers ========== */
const todayISO = () => new Date().toISOString().slice(0, 10);
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
        (p.createdAt?.toMillis?.() || 0) > (cur.createdAt?.toMillis?.() || 0)
          ? p
          : cur;
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
      : (p.createdAt?.toDate?.()
          ? p.createdAt.toDate().toISOString().slice(0, 10)
          : "—");
  const timePart = p.createdAt?.toDate?.()
    ? p.createdAt.toDate().toLocaleTimeString()
    : "—";
  return `${datePart} ${timePart}`;
}

export default function AdminPayments() {
  const [dateSel, setDateSel] = useState(todayISO());
  const [statusSel, setStatusSel] = useState("submitted");

  const [rows, setRows] = useState([]);           // filas consolidadas
  const [docsCount, setDocsCount] = useState(0);  // documentos reales tras unión A∪B
  const [clientsMap, setClientsMap] = useState(new Map());
  const [collectorLabels, setCollectorLabels] = useState(new Map()); // alias cobradores

  const currentUserEmail = auth.currentUser?.email || "admin@capcorp.com";

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
        const m = new Map();
        snap.forEach((d) => {
          const u = d.data() || {};
          const email = String(u.email || "").trim();
          const lbl = String(u.alias || u.displayName || u.name || "").trim();
          if (email) m.set(email, lbl || email);
        });
        setCollectorLabels(m);
      },
      () => setCollectorLabels(new Map())
    );
    return () => unsub && unsub();
  }, []);

  /* ==== Pagos del día (A ∪ B) ==== */
  useEffect(() => {
    if (!dateSel) return;

    const start = new Date(dateSel + "T00:00:00");
    const end = new Date(dateSel + "T23:59:59.999");
    const startBuf = new Date(start.getTime() - 6 * 60 * 60 * 1000);
    const endBuf = new Date(end.getTime() + 6 * 60 * 60 * 1000);

    const statusClause =
      statusSel && statusSel !== "Todos" ? [where("status", "==", statusSel)] : [];

    let rowsA = []; // por batchDate
    let rowsB = []; // por createdAt

    const mergeAndSet = () => {
      const merged = uniqById([...rowsA, ...rowsB]);
      merged.sort(
        (a, b) =>
          (b.createdAt?.toMillis?.() ?? 0) - (a.createdAt?.toMillis?.() ?? 0)
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
        rowsA = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        mergeAndSet();
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
        rowsB = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        mergeAndSet();
      }
    );

    return () => {
      unsubA && unsubA();
      unsubB && unsubB();
    };
  }, [dateSel, statusSel]);

  const totalAmount = useMemo(
    () => rows.reduce((s, p) => s + Number(p.amount || 0), 0),
    [rows]
  );

  // === ACTUALIZAR TODOS LOS DOCUMENTOS DEL GRUPO CONSOLIDADO ===
  const idsOf = (p) => (Array.isArray(p._ids) && p._ids.length ? p._ids : [p.id]);

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
  };

  const rejectPayment = async (p) => {
    const ids = idsOf(p);
    const batch = writeBatch(db);
    ids.forEach((id) => {
      batch.update(doc(db, "payments", id), {
        status: "rejected",
        rejectedAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        updatedBy: currentUserEmail,
      });
    });
    await batch.commit();
  };

  return (
    <div style={{ minWidth: 880 }}>
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
      `}</style>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr auto auto",
          gap: 10,
          alignItems: "center",
          marginBottom: 10,
        }}
      >
        <div style={{ fontWeight: 700, fontSize: 18 }}>
          Pagos {statusSel === "submitted" ? "por aprobar" : ""}
          <span style={{ fontWeight: 400, fontSize: 14, marginLeft: 8 }}>
            Fecha lote: <b>{dateSel}</b> • Estado: <b>{statusSel}</b> •
            Grupos: <b>{rows.length}</b>{" "}
            <span style={{ color: "#666" }}>(documentos reales: {docsCount})</span>
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
      </div>

      <div style={{ marginBottom: 8, color: "#333" }}>
        <b>{rows.length}</b> grupo(s) • Total: <b>{money(totalAmount)}</b>
        <span style={{ color: "#666" }}> — documentos reales: {docsCount}</span>
      </div>

      {!rows.length ? (
        <div style={{ color: "#666" }}>No hay pagos para esos filtros.</div>
      ) : (
        <>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "170px 1fr 190px 120px 90px 170px",
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
            <div>Acciones</div>
          </div>

          {rows.map((p) => (
            <div
              key={p.id}
              style={{
                display: "grid",
                gridTemplateColumns: "170px 1fr 190px 120px 90px 170px",
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
                  <span
                    style={{
                      fontSize: 12,
                      padding: "2px 8px",
                      borderRadius: 999,
                      border: "1px solid #ddd",
                      background: p.status === "approved" ? "#e8fff0" : "#fff4e8",
                      color: p.status === "approved" ? "#16794f" : "#9a5e00",
                    }}
                  >
                    {p.status}
                  </span>
                )}
              </div>
            </div>
          ))}
        </>
      )}
    </div>
  );
}
