import {
  addDoc,
  updateDoc,
  deleteDoc,
  onSnapshot,
  query,
  orderBy,
} from "firebase/firestore";
import { fb } from "../lib/firebase";

// Colección: clients
const C = "clients";

export function subscribeClients(cb) {
  const q = query(fb.col(C), orderBy("nombre"));
  return onSnapshot(q, (snap) => {
    cb(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
  });
}

export async function addClient(data) {
  const payload = {
    nombre: (data.nombre || "").toUpperCase(),
    telefono: data.telefono || "",
    fechaInstalacion: data.fechaInstalacion || null, // "YYYY-MM-DD"
    pon: Number(data.pon ?? 0),
    plan: Number(data.plan ?? 0),
    domicilio: (data.domicilio || "").toUpperCase(),
    lastPaidPeriod: data.lastPaidPeriod || "", // "YYYY-MM"
    nota: data.nota || "",
    active: true,
    createdAt: fb.serverTimestamp(),
    updatedAt: fb.serverTimestamp(),
    createdBy: data.createdBy || null, // email o uid
  };
  return addDoc(fb.col(C), payload);
}

export async function updateClient(id, patch) {
  const ref = fb.doc(C, id);
  await updateDoc(ref, { ...patch, updatedAt: fb.serverTimestamp() });
}

export async function deleteClient(id) {
  await deleteDoc(fb.doc(C, id));
}
