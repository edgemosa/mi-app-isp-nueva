// functions/src/abacus.ts
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";

const ABACUS_DEPLOYMENT_ID = defineSecret("ABACUS_DEPLOYMENT_ID");
const ABACUS_DEPLOYMENT_TOKEN = defineSecret("ABACUS_DEPLOYMENT_TOKEN");

// Node 18 tiene fetch global
export const scoreAnomaly = onCall(
  { secrets: [ABACUS_DEPLOYMENT_ID, ABACUS_DEPLOYMENT_TOKEN] },
  async (req) => {
    if (!req.auth) throw new HttpsError("unauthenticated", "Debes iniciar sesión.");

    const featureRow = req.data || {};
    if (!featureRow.client_id || featureRow.amount == null) {
      throw new HttpsError("invalid-argument", "Faltan campos requeridos.");
    }

    const body = {
      deploymentId: ABACUS_DEPLOYMENT_ID.value(),
      deploymentToken: ABACUS_DEPLOYMENT_TOKEN.value(),
      queryData: featureRow,
    };

    const r = await fetch("https://api.abacus.ai/predict/getEventAnomalyScore", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!r.ok) {
      const text = await r.text();
      throw new HttpsError("internal", `Abacus error: ${text}`);
    }
    return await r.json(); // { success: true, score: 0..1, ... }
  }
);
