// src/App.jsx
import { useEffect, useState } from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import { onAuthStateChanged } from "firebase/auth";
import { doc, getDoc } from "firebase/firestore";
import { auth, db } from "./lib/firebase";

import AdminPanel from "./components/AdminPanel";
import CollectorPanel from "./components/CollectorPanel";
import Login from "./components/Login";

const ADMIN_EMAIL = "admin@capcorp.com";

export default function App() {
  const [user, setUser] = useState(null);
  const [role, setRole] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (u) => {
      try {
        setUser(u);
        if (u) {
          if ((u.email || "").toLowerCase() === ADMIN_EMAIL.toLowerCase()) {
            setRole("admin"); // admin por email
          } else {
            const snap = await getDoc(doc(db, "users", u.uid));
            setRole(snap.exists() ? snap.data().role || "collector" : "collector");
          }
        } else {
          setRole(null);
        }
      } catch (e) {
        console.error("Auth/role error:", e);
        setRole(null);
      } finally {
        setLoading(false);
      }
    });
    return unsub;
  }, []);

  if (loading) return <div className="center">Cargando…</div>;
  if (!user) return <Login />;

  return (
    <Routes>
      <Route
        path="/"
        element={role === "admin" ? <Navigate to="/admin" replace /> : <Navigate to="/cobrador" replace />}
      />
      <Route
        path="/admin"
        element={role === "admin" ? <AdminPanel /> : <Navigate to="/cobrador" replace />}
      />
      <Route
        path="/cobrador"
        element={role === "collector" ? <CollectorPanel /> : <Navigate to="/admin" replace />}
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
