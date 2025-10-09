// src/components/AuditoriaPagos.jsx
import { useEffect, useMemo, useState } from "react";
import {
  collection,
  getDocs,
  onSnapshot,
  orderBy,
  query,
  where,
  Timestamp,
} from "firebase/firestore";
import { db } from "../lib/firebase";

/* ===== Helpers ===== */
const money = (n) => `$${(Number(n || 0)).toFixed(2)}`;
const todayISO = () => {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
};
const labelFromMaps = (email, labelsMap) => {
  if (!email || email === "—") return "—";
  return (labelsMap && labelsMap.get(email)) || email;
};
const safeDate = (tsLike) => {
  try {
    if (!tsLike) return null;
    if (typeof tsLike?.toDate === "function") return tsLike.toDate();
    if (typeof tsLike === "string") return new Date(tsLike);
    return null;
  } catch {
    return null;
  }
};

/* ===== Componente ===== */
export default function AuditoriaPagos() {
  /* Filtros */
  const [fromISO, setFromISO] = useState(todayISO());
  const [toISO, setToISO] = useState(todayISO());
  const [collector, setCollector] = useState("Todos");
  const [pon, setPon] = useState("Todos");

  /* Catálogos */
  const [collectorOptions, setCollectorOptions] = useState(["Todos"]);
  const [collectorLabels, setCollectorLabels] = useState(new Map());
  const [ponOptions, setPonOptions] = useState(["Todos"]);

  /* Datos de clientes para mapear nombre y PON */
  const [clientPonById, setClientPonById] = useState(new Map());
  const [clientNameById, setClientNameById] = useState(new Map());

  /* Estado de auditoría */
  const [loading, setLoading] = useState(false);
  const [uniqueCount, setUniqueCount] = useState(null);
  const [totalAmount, setTotalAmount] = useState(0);
  const [rows, setRows] = useState([]); // <<<< lista de pagos mostrados

  /* ===== Cargar cobradores (labels) ===== */
  useEffect(() => {
    const qUsers = query(collection(db, "users"), where("role", "==", "collector"));
    const unsub = onSnapshot(qUsers, (snap) => {
      const emails = [];
      const labels = new Map();
      snap.forEach((d) => {
        const u = d.data() || {};
        const email = String(u.email || "").trim();
        if (!email) return;
        const alias = String(u.alias || u.displayName || u.name || "").trim();
        emails.push(email);
        labels.set(email, alias || email);
      });
      emails.sort((a, b) => (labels.get(a) || a).localeCompare(labels.get(b) || b));
      setCollectorOptions(["Todos", ...emails]);
      setCollectorLabels(labels);
    });
    return () => unsub();
  }, []);

  /* ===== Cargar clientes (nombre y PON) ===== */
  useEffect(() => {
    const unsub = onSnapshot(
      query(collection(db, "clients"), orderBy("nombre")),
      (snap) => {
        const mPon = new Map();
        const mName = new Map();
        const ponSet = new Set();
        snap.forEach((d) => {
          const c = d.data() || {};
          const id = d.id;
          const p = String(c.pon ?? "").trim();
          const nm = String(c.nombre || id);
          mPon.set(id, p || "");
          mName.set(id, nm);
          if (p) ponSet.add(p);
        });
        setClientPonById(mPon);
        setClientNameById(mName);
        setPonOptions(["Todos", ...Array.from(ponSet).sort((a, b) => a.localeCompare(b))]);
      }
    );
    return () => unsub();
  }, []);

  async function runAudit() {
    if (!fromISO || !toISO) {
      alert("Selecciona ambas fechas.");
      return;
    }
    setLoading(true);
    try {
      const start = Timestamp.fromDate(new Date(`${fromISO}T00:00:00`));
      const end = Timestamp.fromDate(new Date(`${toISO}T23:59:59.999`));

      let docs = [];

      // 1) Rango por approvedAt (evita índice compuesto con status)
      {
        const q1 = query(
          collection(db, "payments"),
          where("approvedAt", ">=", start),
          where("approvedAt", "<=", end)
        );
        const s1 = await getDocs(q1);
        if (!s1.empty) docs = s1.docs.map((d) => ({ id: d.id, ...d.data() }));
      }

      // 2) Fallback: createdAt
      if (docs.length === 0) {
        const q2 = query(
          collection(db, "payments"),
          where("createdAt", ">=", start),
          where("createdAt", "<=", end)
        );
        const s2 = await getDocs(q2);
        if (!s2.empty) docs = s2.docs.map((d) => ({ id: d.id, ...d.data() }));
      }

      // 3) Último recurso: batchDate string
      if (docs.length === 0) {
        const sAll = await getDocs(collection(db, "payments"));
        const fromStr = fromISO;
        const toStr = toISO;
        docs = sAll.docs
          .map((d) => ({ id: d.id, ...d.data() }))
          .filter((p) => typeof p.batchDate === "string" && p.batchDate >= fromStr && p.batchDate <= toStr);
      }

      // Filtrar aprobados en cliente (evita índice con status)
      let filtered = docs.filter((p) => p.status === "approved");

      // Aplicar filtros de UI
      filtered = filtered.filter((p) => {
        if (collector !== "Todos" && (p.createdBy || "—") !== collector) return false;
        if (pon !== "Todos") {
          const cp = clientPonById.get(p.clientId || "") || "";
          if (cp !== pon) return false;
        }
        return true;
      });

      // Ordenar por approvedAt desc, con caídas a createdAt/batchDate
      filtered.sort((a, b) => {
        const da = safeDate(a.approvedAt) || safeDate(a.createdAt) || (a.batchDate ? new Date(a.batchDate) : null);
        const db = safeDate(b.approvedAt) || safeDate(b.createdAt) || (b.batchDate ? new Date(b.batchDate) : null);
        const ta = da ? da.getTime() : 0;
        const tb = db ? db.getTime() : 0;
        return tb - ta;
      });

      // Calcular totales y setear filas para la tabla
      const unique = new Set();
      let sum = 0;
      const mappedRows = filtered.map((p) => {
        unique.add(p.clientId || null);
        sum += Number(p.amount || 0);
        return {
          id: p.id,
          when:
            safeDate(p.approvedAt)?.toLocaleString() ||
            safeDate(p.createdAt)?.toLocaleString() ||
            (typeof p.batchDate === "string" ? p.batchDate : "—"),
          client: clientNameById.get(p.clientId || "") || (p.clientId || "—"),
          amount: Number(p.amount || 0),
          period: p.period || "—",
          type: p.type || "—",
          collector: p.createdBy || "—",
          collectorLabel: labelFromMaps(p.createdBy || "—", collectorLabels),
          pon: clientPonById.get(p.clientId || "") || "",
        };
      });

      setRows(mappedRows);
      setUniqueCount(unique.size);
      setTotalAmount(sum);
    } catch (e) {
      console.error(e);
      let msg = "No se pudo ejecutar la auditoría.";
      const text = String(e?.message || "");
      if (text.includes("FAILED_PRECONDITION")) {
        msg =
          "Falta un índice en Firestore (status + approvedAt). Puedes crear el índice compuesto o dejar este filtro en cliente.";
      } else if (text.includes("PERMISSION_DENIED")) {
        msg =
          "Las reglas de Firestore no permiten leer 'payments/users/clients' con tu usuario actual.";
      }
      alert(msg);
    } finally {
      setLoading(false);
    }
  }

  const canRun = useMemo(() => !!fromISO && !!toISO, [fromISO, toISO]);

  /* ===== Export CSV de la lista mostrada ===== */
  function exportCSV() {
    if (!rows.length) return;
    const decimalComma = (1.1).toLocaleString().includes(",");
    const SEP = decimalComma ? ";" : ",";
    const header = [
      "Fecha/Hora",
      "Cliente",
      "Monto",
      "Período",
      "Tipo",
      "Cobrador",
      "PON",
    ].join(SEP);
    const lines = rows.map((r) =>
      [
        `"${String(r.when || "").replace(/"/g, '""')}"`,
        `"${String(r.client || "").replace(/"/g, '""')}"`,
        Number(r.amount || 0).toFixed(2),
        `"${String(r.period || "").replace(/"/g, '""')}"`,
        `"${String(r.type || "").replace(/"/g, '""')}"`,
        `"${String(r.collectorLabel || r.collector || "").replace(/"/g, '""')}"`,
        `"${String(r.pon || "").replace(/"/g, '""')}"`,
      ].join(SEP)
    );
    const csv = "\uFEFF" + [header, ...lines].join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `auditoria_${fromISO}_a_${toISO}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  return (
    <div
      style={{
        border: "1px solid #e5e7eb",
        borderRadius: 10,
        padding: 12,
        background: "#fff",
        margin: "10px 0 16px",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <div style={{ fontWeight: 700, marginBottom: 8, flex: 1 }}>
          🧮 Auditoría de pagos aprobados
        </div>
        {/* Resumen */}
        <div style={{ fontSize: 14, whiteSpace: "nowrap" }}>
          {uniqueCount != null && (
            <>
              <b>{uniqueCount}</b> cliente{uniqueCount === 1 ? "" : "s"} • Total{" "}
              <b>{money(totalAmount)}</b>
            </>
          )}
        </div>
      </div>

      {/* Controles */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(5, minmax(130px, 1fr)) auto auto",
          gap: 8,
          alignItems: "end",
          marginBottom: 8,
        }}
      >
        <div style={{ display: "grid", gap: 4 }}>
          <label style={{ fontSize: 12, color: "#555" }}>Desde</label>
          <input
            type="date"
            value={fromISO}
            onChange={(e) => setFromISO(e.target.value)}
            autoComplete="off"
            data-lpignore="true"
          />
        </div>

        <div style={{ display: "grid", gap: 4 }}>
          <label style={{ fontSize: 12, color: "#555" }}>Hasta</label>
          <input
            type="date"
            value={toISO}
            onChange={(e) => setToISO(e.target.value)}
            autoComplete="off"
            data-lpignore="true"
          />
        </div>

        <div style={{ display: "grid", gap: 4 }}>
          <label style={{ fontSize: 12, color: "#555" }}>Cobrador</label>
          <select value={collector} onChange={(e) => setCollector(e.target.value)}>
            {collectorOptions.map((op) => (
              <option key={op} value={op}>
                {op === "Todos" ? "Todos" : labelFromMaps(op, collectorLabels)}
              </option>
            ))}
          </select>
        </div>

        <div style={{ display: "grid", gap: 4 }}>
          <label style={{ fontSize: 12, color: "#555" }}>PON</label>
          <select value={pon} onChange={(e) => setPon(e.target.value)}>
            {ponOptions.map((op) => (
              <option key={op} value={op}>
                {op}
              </option>
            ))}
          </select>
        </div>

        <div>
          <button onClick={runAudit} disabled={!canRun || loading}>
            {loading ? "Contando..." : "Contar"}
          </button>
        </div>

        <div>
          <button onClick={exportCSV} disabled={!rows.length}>
            Exportar CSV
          </button>
        </div>
      </div>

      {/* Tabla de resultados */}
      <div
        style={{
          borderTop: "1px solid #eee",
          marginTop: 6,
          paddingTop: 8,
        }}
      >
        {!rows.length ? (
          <div style={{ color: "#666" }}>
            {uniqueCount == null
              ? "Ejecuta la auditoría para ver resultados."
              : "No hay pagos aprobados para los filtros seleccionados."}
          </div>
        ) : (
          <>
            <div
              style={{
                display: "grid",
                gridTemplateColumns:
                  "170px 1fr 110px 110px 100px 170px 100px",
                gap: 8,
                fontWeight: 700,
                padding: "6px 0",
                borderBottom: "1px dashed #eee",
              }}
            >
              <div>Fecha/hora</div>
              <div>Cliente</div>
              <div>Monto</div>
              <div>Período</div>
              <div>Tipo</div>
              <div>Cobrador</div>
              <div>PON</div>
            </div>

            {rows.map((r) => (
              <div
                key={r.id}
                style={{
                  display: "grid",
                  gridTemplateColumns:
                    "170px 1fr 110px 110px 100px 170px 100px",
                  gap: 8,
                  padding: "6px 0",
                  borderBottom: "1px dashed #f3f3f3",
                  alignItems: "center",
                }}
              >
                <div>{r.when || "—"}</div>
                <div>{r.client}</div>
                <div>{money(r.amount)}</div>
                <div>{r.period}</div>
                <div>{r.type}</div>
                <div>{r.collectorLabel}</div>
                <div>{r.pon || "—"}</div>
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
