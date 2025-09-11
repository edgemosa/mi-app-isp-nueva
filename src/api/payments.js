import {
  addDoc,
  updateDoc,
  deleteDoc,
  onSnapshot,
  query,
  where,
  orderBy,
  limit,
  getDocs,
  writeBatch,
} from "firebase/firestore";
import { fb } from "../lib/firebase";

// Colección: payments
// Campos: clientId, amount, period("YYYY-MM"), type("total"|"parcial"),
// status("submitted"|"approved"|"rejected"), createdAt, createdBy(uid/email),
// batchDate("YYYY-MM-DD"), approvedAt, approvedBy
const P = "payments";

export function subscribePaymentsByClientPeriod(clientId, period, cb) {
  const q = query(
    fb.col(P),
    where("clientId", "==", clientId),
    where("period", "==", period),
    orderBy("createdAt", "desc")
  );
  return onSnapshot(q, (snap) => {
    cb(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
  });
}

// Para el panel del admin: ver enviados
export function subscribeSubmitted(cb) {
  const q = query(
    fb.col(P),
    where("status", "==", "submitted"),
    orderBy("createdAt", "desc"),
    limit(500)
  );
  return onSnapshot(q, (snap) => {
    cb(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
  });
}

// Cobrador: enviar lote del día
export async function submitPayments(payments, { createdBy, batchDate }) {
  const now = fb.serverTimestamp();
  const writes = payments.map((p) =>
    addDoc(fb.col(P), {
      ...p,
      status: "submitted",
      createdBy,
      createdAt: now,
      batchDate, // "YYYY-MM-DD"
    })
  );
  await Promise.all(writes);
}

// Admin: aprobar uno
export async function approvePayment(id, { approvedBy }) {
  await updateDoc(fb.doc(P, id), {
    status: "approved",
    approvedBy,
    approvedAt: fb.serverTimestamp(),
  });
}

// Admin: rechazar uno
export async function rejectPayment(id) {
  await updateDoc(fb.doc(P, id), { status: "rejected" });
}

// Admin: aprobar todos los "submitted" (en lotes de 500)
export async function approveAllSubmitted({ approvedBy }) {
  const q = query(fb.col(P), where("status", "==", "submitted"), limit(500));
  const snap = await getDocs(q);
  const batch = writeBatch(fb.doc); // truco: necesitamos db, lo obtendremos de fb.doc internamente
  // writeBatch no acepta fb.doc() directo; mejor:
  const w = writeBatch((await import("firebase/firestore")).getFirestore());
  snap.forEach((d) =>
    w.update(d.ref, {
      status: "approved",
      approvedBy,
      approvedAt: fb.serverTimestamp(),
    })
  );
  await w.commit();
}

// Revertir (cobrador): borrar un enviado del mismo día (status=submitted)
export async function deleteSubmitted(id) {
  await deleteDoc(fb.doc(P, id));
}
