// src/components/AdminFixTool.jsx
import { useEffect, useMemo, useState } from "react";
import { db, auth } from "../lib/firebase";
import {
  collection, query, where, orderBy, onSnapshot,
  updateDoc, doc, serverTimestamp, Timestamp, getDocs
} from "firebase/firestore";

const money = (n) => `$${Number(n||0).toFixed(2)}`;

export default function AdminFixTool({ onDone }) {
  const me = auth.currentUser?.email || "admin@capcorp.com";

  const [nameQ, setNameQ] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [statusSel, setStatusSel] = useState("Todos");

  const [clientsIdx, setClientsIdx] = useState(new Map()); // id -> nombre
  const [clientIds, setClientIds] = useState([]);          // ids que matchean nombre
  const [rows, setRows] = useState([]);

  // índice de clientes
  useEffect(() => {
    const unsub = onSnapshot(collection(db, "clients"), (snap) => {
      const m = new Map();
      snap.forEach(d => m.set(d.id, d.data()?.nombre || d.id));
      setClientsIdx(m);
    });
    return () => unsub && unsub();
  }, []);

  // resolver ids por nombre (búsqueda sencilla contains)
  useEffect(() => {
    if (!nameQ.trim()) { setClientIds([]); return; }
    const q = nameQ.trim().toUpperCase();
    const ids = [];
    for (const [id, nm] of clientsIdx) {
      if ((nm || "").toUpperCase().includes(q)) ids.push(id);
    }
    setClientIds(ids);
  }, [nameQ, clientsIdx]);

  // buscar pagos (reactivo)
  useEffect(() => {
    let unsubs = [];
    setRows([]);

    const statusClause = (statusSel !== "Todos") ? [where("status","==",statusSel)] : [];

    const pushListener = (qref) => {
      const u = onSnapshot(qref, (snap) => {
        setRows((prev) => {
          const add = snap.docs.map(d => ({ id: d.id, ...d.data() }));
          // unión por id
          const map = new Map(prev.map(x => [x.id, x]));
          for (const r of add) map.set(r.id, r);
          // orden por createdAt desc
          const arr = Array.from(map.values());
          arr.sort((a,b)=>(b.createdAt?.toMillis?.()??0)-(a.createdAt?.toMillis?.()??0));
          return arr;
        });
      });
      unsubs.push(u);
    };

    // Caso 1: filtrando por cliente(s)
    if (clientIds.length) {
      for (const cid of clientIds) {
        pushListener(
          query(collection(db,"payments"), where("clientId","==",cid), ...statusClause, orderBy("createdAt","desc"))
        );
      }
    } else {
      // Caso 2: por rango de fechas (createdAt) si se especifica
      if (dateFrom && dateTo) {
        const start = new Date(dateFrom+"T00:00:00");
        const end   = new Date(dateTo+"T23:59:59.999");
        pushListener(
          query(collection(db,"payments"),
            where("createdAt",">=", start),
            where("createdAt","<=", end),
            ...statusClause,
            orderBy("createdAt","desc"))
        );
      } else {
        // fallback: últimos 200 por estado
        pushListener(
          query(collection(db,"payments"), ...statusClause, orderBy("createdAt","desc"))
        );
      }
    }

    return () => unsubs.forEach(u=>u&&u());
  }, [clientIds, dateFrom, dateTo, statusSel]);

  const clientName = (id) => clientsIdx.get(id) || id;

  async function saveRow(r, patch) {
    await updateDoc(doc(db,"payments", r.id), {
      ...patch,
      updatedAt: serverTimestamp(),
      updatedBy: me,
    });
    alert("Actualizado ✅");
  }

  async function setStatus(r, status) {
    const patch = { status };
    if (status === "approved") {
      patch.approvedAt = serverTimestamp();
      patch.approvedBy = me;
    }
    if (status === "rejected") {
      patch.rejectedAt = serverTimestamp();
      patch.rejectedBy = me;
    }
    await saveRow(r, patch);
  }

  async function changeCreatedAt(r) {
    const s = prompt("Nueva fecha/hora de pago (YYYY-MM-DD HH:mm)", "");
    if (!s) return;
    const [dPart, tPart="00:00"] = s.trim().split(" ");
    const [H, M] = tPart.split(":").map(Number);
    const d = new Date(dPart+"T00:00:00");
    if (Number.isNaN(d.getTime())) return alert("Fecha inválida");
    d.setHours(Number.isFinite(H)?H:0, Number.isFinite(M)?M:0, 0, 0);
    await saveRow(r, { createdAt: Timestamp.fromDate(d) });
  }

  async function quickFixPeriodFromBatchDate(r) {
    // útil si el período quedó mal y debe ser el de la fecha del pago
    const ym = (r.batchDate || r.createdAt?.toDate?.()?.toISOString()?.slice(0,10) || "").slice(0,7);
    if (!ym) return alert("No se pudo inferir período");
    await saveRow(r, { period: ym });
  }

  return (
    <div style={{ minWidth: 900 }}>
      <div style={{ fontWeight: 700, marginBottom: 8 }}>Herramienta de Correcciones</div>

      {/* Filtros */}
      <div style={{ display:"grid", gridTemplateColumns:"1fr auto auto auto", gap:8, marginBottom:10 }}>
        <input placeholder="Buscar por cliente…" value={nameQ} onChange={e=>setNameQ(e.target.value)} />
        <input type="date" value={dateFrom} onChange={e=>setDateFrom(e.target.value)} />
        <input type="date" value={dateTo} onChange={e=>setDateTo(e.target.value)} />
        <select value={statusSel} onChange={e=>setStatusSel(e.target.value)}>
          <option>Todos</option>
          <option>submitted</option>
          <option>approved</option>
          <option>rejected</option>
          <option>reversed</option>
        </select>
      </div>

      {!rows.length ? (
        <div style={{ color:"#666" }}>No hay resultados con esos filtros.</div>
      ) : (
        <>
          <div style={{ color:"#333", marginBottom:6 }}>
            Resultados: <b>{rows.length}</b>
          </div>
          <div style={{ display:"grid", gridTemplateColumns:"160px 1fr 110px 110px 100px 220px", gap:8, fontWeight:600, borderBottom:"1px dashed #eee", paddingBottom:6 }}>
            <div>Fecha/hora</div>
            <div>Cliente</div>
            <div>Monto</div>
            <div>Periodo</div>
            <div>Estado</div>
            <div>Acciones</div>
          </div>

          {rows.map(r=>(
            <div key={r.id} style={{ display:"grid", gridTemplateColumns:"160px 1fr 110px 110px 100px 220px", gap:8, alignItems:"center", padding:"6px 0", borderBottom:"1px dashed #f3f3f3" }}>
              <div>{r.createdAt?.toDate ? r.createdAt.toDate().toLocaleString() : "—"}</div>
              <div style={{ overflow:"hidden", textOverflow:"ellipsis" }}>{clientName(r.clientId)}</div>

              <div>
                <input
                  style={{ width: 100 }}
                  defaultValue={Number(r.amount||0).toFixed(2)}
                  onBlur={(e)=>saveRow(r,{ amount:Number(e.target.value)||0 })}
                />
              </div>

              <div>
                <input
                  style={{ width: 100 }}
                  defaultValue={String(r.period||"")}
                  onBlur={(e)=>saveRow(r,{ period:e.target.value })}
                />
              </div>

              <div>
                <select defaultValue={r.status||"submitted"} onChange={(e)=>setStatus(r, e.target.value)}>
                  <option>submitted</option>
                  <option>approved</option>
                  <option>rejected</option>
                  <option>reversed</option>
                </select>
              </div>

              <div style={{ display:"flex", gap:6, flexWrap:"wrap" }}>
                <button onClick={()=>saveRow(r,{ batchDate: prompt("Nueva batchDate (YYYY-MM-DD)", r.batchDate || "") || r.batchDate })}>BatchDate</button>
                <button onClick={()=>changeCreatedAt(r)}>Fecha pago</button>
                <button onClick={()=>quickFixPeriodFromBatchDate(r)}>Período⇢batch</button>
              </div>
            </div>
          ))}
        </>
      )}

      <div style={{ marginTop:10, textAlign:"right" }}>
        <button onClick={onDone}>Cerrar</button>
      </div>
    </div>
  );
}
