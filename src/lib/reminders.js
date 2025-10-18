// src/lib/reminders.js
import { collection, query, where, orderBy, onSnapshot } from "firebase/firestore";
import { db } from "./firebase";

export function subscribeActiveReminders({ assignedTo }, callback) {
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0); // ⬅️ clave: incluir todo el día de hoy

  const q = query(
    collection(db, "reminders"),
    where("active", "==", true),
    orderBy("dueAt", "asc")
  );

  return onSnapshot(q, (snap) => {
    const email = (assignedTo || "").toLowerCase();
    const list = snap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .filter((r) => {
        const due = r?.dueAt?.toDate?.() || new Date(0);
        const assigned =
          !r.assignedTo ||
          r.assignedTo === "ALL" ||
          r.assignedTo === email;
        return assigned && due >= startOfToday; // ⬅️ antes era “now”
      })
      .sort((a, b) => {
        const ta = a?.dueAt?.toDate?.()?.getTime?.() || 0;
        const tb = b?.dueAt?.toDate?.()?.getTime?.() || 0;
        return ta - tb;
      });

    callback(list);
  });
}
