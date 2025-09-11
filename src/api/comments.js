import { addDoc, onSnapshot, query, where, orderBy } from "firebase/firestore";
import { fb } from "../lib/firebase";

// Colección plana: comments
// Campos: clientId, text, createdAt, authorUid, authorEmail, authorRole('collector'|'admin'),
// read(false/true), surfaced(false/true)
const CMT = "comments";

export async function addComment({ clientId, text, authorUid, authorEmail, authorRole }) {
  return addDoc(fb.col(CMT), {
    clientId,
    text,
    authorUid: authorUid || null,
    authorEmail: authorEmail || null,
    authorRole: authorRole || "collector",
    read: false,
    surfaced: false,
    createdAt: fb.serverTimestamp(),
  });
}

// Admin: escuchar comentarios no leídos
export function subscribeUnreadComments(cb) {
  const q = query(
    fb.col(CMT),
    where("read", "==", false),
    orderBy("createdAt", "desc")
  );
  return onSnapshot(q, (snap) =>
    cb(snap.docs.map((d) => ({ id: d.id, ...d.data() })))
  );
}
