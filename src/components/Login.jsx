// src/components/Login.jsx
import { useState } from "react";
import { signInWithEmailAndPassword, createUserWithEmailAndPassword } from "firebase/auth";
import { doc, setDoc } from "firebase/firestore";
import { auth, db } from "../lib/firebase";

export default function Login() {
  const [email, setEmail] = useState("");
  const [pass, setPass] = useState("");
  const [mode, setMode] = useState("login");
  const [msg, setMsg] = useState("");

  const onSubmit = async (e) => {
    e.preventDefault();
    setMsg("");
    try {
      if (mode === "login") {
        await signInWithEmailAndPassword(auth, email, pass);
      } else {
        const cred = await createUserWithEmailAndPassword(auth, email, pass);
        await setDoc(doc(db, "users", cred.user.uid), {
          email,
          role: "collector",
          createdAt: new Date().toISOString(),
        });
        setMsg("Usuario creado como cobrador.");
      }
    } catch (err) {
      setMsg(err.message);
    }
  };

  return (
    <div className="login">
      <h2>{mode === "login" ? "Ingresar" : "Crear cuenta (cobrador)"}</h2>
      <form onSubmit={onSubmit}>
        <input placeholder="Email" value={email} onChange={(e)=>setEmail(e.target.value)} />
        <input placeholder="Contraseña" type="password" value={pass} onChange={(e)=>setPass(e.target.value)} />
        <button type="submit">{mode === "login" ? "Entrar" : "Registrarme"}</button>
      </form>
      {msg && <p style={{color:"#666"}}>{msg}</p>}
      <button className="secondary" onClick={()=>setMode(mode==="login"?"register":"login")}>
        {mode==="login" ? "Crear cuenta" : "Ya tengo cuenta"}
      </button>

      <style>{`
        .login{max-width:360px;margin:40px auto;padding:24px;border:1px solid #eee;border-radius:12px}
        input{width:100%;padding:10px;margin:8px 0;border:1px solid #ddd;border-radius:8px}
        button{padding:10px 14px;border:0;background:#111;color:#fff;border-radius:8px;cursor:pointer}
        .secondary{background:#555;margin-top:8px}
      `}</style>
    </div>
  );
}
