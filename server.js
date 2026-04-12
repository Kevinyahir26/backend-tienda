import admin from "firebase-admin";
import { readFileSync } from "fs";

const serviceAccount = JSON.parse(
    readFileSync("./cerro-girasol-firebase-adminsdk-fbsvc-78e4d9c7cd.json", "utf8")
);

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
app.use(cors());
app.use(express.json());

const client = new MercadoPagoConfig({
    accessToken: "APP_USR-5021755149745946-040518-97323883ca24caefe768f36d4356cc4f-3315715483"
});

// 🛒 CREAR PAGO
app.post("/crear-pago", async (req, res) => {
    try {
        const { carrito, datos } = req.body;

        if (!carrito || !Array.isArray(carrito) || carrito.length === 0) {
            return res.status(400).json({ error: "Carrito inválido" });
        }

        const items = carrito.map(p => ({
            title: String(p.nombre),
            quantity: Number(p.cantidad),
            unit_price: Number(p.precio),
            currency_id: "MXN"
        }));

        const preference = new Preference(client);

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
                    success: "http://localhost:5500/gracias.html",
                    failure: "http://localhost:5500/error.html",
                    pending: "http://localhost:5500/pendiente.html"
                },
                // ❌ auto_return eliminado (causaba el error)
                external_reference: "pedido_" + Date.now()
            }
        });

        res.json({
            init_point: response.init_point
        });

    } catch (error) {
        console.error("❌ ERROR MERCADO PAGO:", error);

        res.status(500).json({
            error: "Error al crear pago",
            detalle: error.message
        });
    }
});

// 🔔 WEBHOOK
app.post("/webhook", async (req, res) => {
    try {
        const paymentId = req.body?.data?.id;

        if (!paymentId) return res.sendStatus(200);

        const response = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
            headers: {
                Authorization: `Bearer APP_USR-5021755149745946-040518-97323883ca24caefe768f36d4356cc4f-3315715483`
            }
        });

        const data = await response.json();

        if (data.status === "approved") {

            const meta = data.metadata || {};

            // 🔥 DESCONTAR STOCK
            if (meta.carrito && Array.isArray(meta.carrito)) {
                for (const producto of meta.carrito) {
                    const ref = db.collection("productos").doc(producto.id);
                    const docSnap = await ref.get();

                    if (docSnap.exists) {
                        const stockActual = docSnap.data().stock || 0;
                        await ref.update({
                            stock: Math.max(0, stockActual - producto.cantidad)
                        });
                    }
                }
            }

            // 🔥 GUARDAR PEDIDO
            await db.collection("pedidos").add({
                paymentId,
                estado: data.status,
                fecha: new Date(),
                total: data.transaction_amount || 0,
                email: data.payer?.email || "",

                nombre: meta.nombre || "",
                telefono: meta.telefono || "",
                direccion: meta.direccion || "",
                referencias: meta.referencias || "",

                carrito: meta.carrito || []
            });

            console.log("✅ Pedido guardado y stock actualizado");
        }

        res.sendStatus(200);

    } catch (error) {
        console.error("❌ Error webhook:", error);
        res.sendStatus(500);
    }
});

// 🚀 SERVIDOR
app.listen(3000, () => {
    console.log("🚀 Servidor corriendo en http://localhost:3000");
});