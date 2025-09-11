// src/lib/firebase.js
import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import {
  getFirestore,
  enableIndexedDbPersistence,
  enableMultiTabIndexedDbPersistence,
} from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyBGdNheO_PKDEgFqPN8rD5KAuPe_NY6nfw",
  authDomain: "capcorp-77ab7.firebaseapp.com",
  projectId: "capcorp-77ab7",
  // (opcional) si algún día usas Storage, el bucket correcto suele ser "<projectId>.appspot.com"
  // storageBucket: "capcorp-77ab7.appspot.com",
  messagingSenderId: "489334371476",
  appId: "1:489334371476:web:8071eafc54ff03921cb081",
};

const app = initializeApp(firebaseConfig);

export const auth = getAuth(app);
export const db = getFirestore(app);

// Promesa que habilita persistencia antes de usar Firestore
export const persistenceReady = (async () => {
  try {
    await enableMultiTabIndexedDbPersistence(db);
  } catch (e) {
    if (e.code === "failed-precondition") {
      // Multi-tab no disponible (o conflicto de pestañas) → intenta single-tab
      await enableIndexedDbPersistence(db);
    } else if (e.code === "unimplemented") {
      console.warn("IndexedDB no soportado; Firestore funcionará sin cache offline.");
    } else {
      console.warn("No se pudo habilitar persistencia offline:", e);
    }
  }
})();
