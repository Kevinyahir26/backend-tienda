import admin from "firebase-admin";

// 🔥 USAR VARIABLE DE ENTORNO
const serviceAccount = JSON.parse(process.env.FIREBASE_KEY);

import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import { MercadoPagoConfig, Preference } from "mercadopago";

// 🔥 FUNCIÓN MENSAJE
function generarMensajeCompleto(data, meta) {
    let mensaje = `🔥 NUEVO PEDIDO 🔥\n\n`;

    mensaje += `💳 Pago aprobado\n`;
    mensaje += `💰 Total: $${data.transaction_amount}\n`;
    mensaje += `📧 Email: ${data.payer?.email || "no definido"}\n`;
    mensaje += `🆔 ID Pago: ${data.id}\n\n`;

    if (meta) {
        mensaje += `👤 Nombre: ${meta.nombre}\n`;
        mensaje += `📞 Teléfono: ${meta.telefono}\n`;
        mensaje += `📍 Dirección: ${meta.direccion}\n`;
        mensaje += `📝 Referencias: ${meta.referencias}\n\n`;

        mensaje += `🛒 Productos:\n`;

        if (meta.carrito && Array.isArray(meta.carrito)) {
            meta.carrito.forEach(p => {
                mensaje += `- ${p.nombre} x${p.cantidad} ($${p.precio})\n`;
            });
        }
    }

    return mensaje;
}

// 🔥 FIREBASE
admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

const app = express();

app.use(cors({ origin: "*" }));
app.use(express.json());

// 🔥 MERCADO PAGO
const client = new MercadoPagoConfig({
    accessToken: "TU_ACCESS_TOKEN_AQUI"
});

// 🛒 CREAR PAGO
app.post("/crear-pago", async (req, res) => {
    try {
        const { carrito, datos } = req.body;

        console.log("🛒 Carrito recibido:", carrito);
        console.log("📄 Datos cliente:", datos);

        if (!carrito || !Array.isArray(carrito) || carrito.length === 0) {
            return res.status(400).json({ error: "Carrito inválido" });
        }

        const items = carrito.map(p => ({
            title: String(p.nombre),
            quantity: Number(p.cantidad),
            unit_price: Number(p.precio),
            currency_id: "MXN"
        }));

        console.log("📦 Items enviados a MP:", items);

        const preference = new Preference(client);
        const externalRef = "pedido_" + Date.now();

        const response = await preference.create({
            body: {
                items,
                metadata: {
                    nombre: datos?.nombre || "",
                    telefono: datos?.telefono || "",
                    direccion: datos?.direccion || "",
                    referencias: datos?.referencias || "",
                    carrito: carrito
                },
                back_urls: {
                    success: "https://darling-gaufre-294769.netlify.app/gracias.html",
                    failure: "https://darling-gaufre-294769.netlify.app/error.html",
                    pending: "https://darling-gaufre-294769.netlify.app/pendiente.html"
                },
                auto_return: "approved",
                external_reference: externalRef
            }
        });

        console.log("✅ RESPUESTA MP:", response);

        // 🔥 GUARDAR PEDIDO SIN ROMPER
        try {
            await db.collection("pedidos").doc(externalRef).set({
                estado: "pendiente",
                carrito,
                datos,
                fecha: new Date()
            });
        } catch (err) {
            console.log("⚠️ Firebase falló pero no rompe:", err.message);
        }

        // 🔥 ESTO ES LO QUE TE FALTABA
        res.json({
            init_point: response.init_point
        });

    } catch (error) {
        console.error("❌ ERROR:", error);
        res.status(500).json({
            error: "Error al crear pago",
            detalle: error.message
        });
    }
});

// 🔔 WEBHOOK (igual que antes)
app.post("/webhook", async (req, res) => {
    try {
        console.log("📩 WEBHOOK RECIBIDO");

        const paymentId = req.body?.data?.id;
        if (!paymentId) return res.sendStatus(200);

        const response = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
            headers: {
                Authorization: `Bearer TU_ACCESS_TOKEN_AQUI`
            }
        });

        const data = await response.json();

        if (data.status === "approved") {
            console.log("🔥 PAGO APROBADO");
        }

        res.sendStatus(200);

    } catch (error) {
        console.error("❌ Error webhook:", error);
        res.sendStatus(500);
    }
});

// 🚀 SERVIDOR
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log("🚀 Servidor corriendo en puerto " + PORT);
});
