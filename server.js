import admin from "firebase-admin";

// 🔥 USAR VARIABLE DE ENTORNO
const serviceAccount = JSON.parse(process.env.FIREBASE_KEY);

import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import { MercadoPagoConfig, Preference } from "mercadopago";

// 🔥 FIREBASE
admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

const app = express();

app.use(cors({ origin: "*" }));
app.use(express.json());

// 🔥 MERCADO PAGO (YA CON TU TOKEN REAL)
const client = new MercadoPagoConfig({
    accessToken: "APP_USR-4196814984350035-040517-24a4dd917f368c9ec4656f3e36f9f66f-3316869280"
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

        await db.collection("pedidos").doc(externalRef).set({
            estado: "pendiente",
            carrito,
            datos,
            fecha: new Date()
        });

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

// 🔔 WEBHOOK COMPLETO
app.post("/webhook", async (req, res) => {
    try {
        console.log("📩 WEBHOOK RECIBIDO");

        const paymentId = req.body?.data?.id;
        if (!paymentId) return res.sendStatus(200);

        const response = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
            headers: {
                Authorization: `Bearer APP_USR-4196814984350035-040517-24a4dd917f368c9ec4656f3e36f9f66f-3316869280`
            }
        });

        const data = await response.json();

        if (data.status === "approved") {
            console.log("🔥 PAGO APROBADO");

            const externalRef = data.external_reference;

            const pedidoRef = db.collection("pedidos").doc(externalRef);
            const pedidoDoc = await pedidoRef.get();

            if (!pedidoDoc.exists) return res.sendStatus(200);

            const pedido = pedidoDoc.data();

            // 🔥 EVITAR DOBLE PROCESO
            if (pedido.estado === "pagado") {
                console.log("⚠️ Ya estaba procesado");
                return res.sendStatus(200);
            }

            // 🔻 DESCONTAR STOCK
            for (const producto of pedido.carrito) {
                const ref = db.collection("productos").doc(producto.id);

                await db.runTransaction(async (t) => {
                    const doc = await t.get(ref);

                    if (!doc.exists) return;

                    const stockActual = doc.data().stock || 0;
                    const nuevoStock = stockActual - producto.cantidad;

                    t.update(ref, {
                        stock: nuevoStock < 0 ? 0 : nuevoStock
                    });
                });
            }

            // ✅ MARCAR COMO PAGADO
            await pedidoRef.update({
                estado: "pagado",
                payment_id: data.id
            });

            console.log("✅ STOCK ACTUALIZADO");
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
