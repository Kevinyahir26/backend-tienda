import admin from "firebase-admin";

// 🔴 VALIDAR VARIABLE (IMPORTANTE)
if (!process.env.FIREBASE_KEY) {
    console.error("❌ FIREBASE_KEY NO EXISTE");
    process.exit(1);
}

// 🔥 USAR VARIABLE DE ENTORNO
const serviceAccount = JSON.parse(process.env.FIREBASE_KEY);

// 🔥 ARREGLAR SALTOS DE LÍNEA (ANTES DE USARLO)
serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');

// 🔍 LOG DESPUÉS DEL FIX
console.log("🔥 Firebase cargado:", serviceAccount.client_email);

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

// 🔥 MERCADO PAGO
const client = new MercadoPagoConfig({
    accessToken: process.env.MP_ACCESS_TOKEN
});

// 🛒 CREAR PAGO
app.post("/crear-pago", async (req, res) => {
    try {
        const { carrito, datos } = req.body;

        if (!carrito || !Array.isArray(carrito) || carrito.length === 0) {
            return res.status(400).json({ error: "Carrito inválido" });
        }

        let total = 0;
        const items = [];

        for (const p of carrito) {
            if (!p.id) {
                return res.status(400).json({ error: "Producto inválido" });
            }

            const ref = db.collection("productos").doc(p.id);
            const doc = await ref.get();

            if (!doc.exists) {
                return res.status(400).json({ error: "Producto no existe" });
            }

            const data = doc.data();

            if (data.stock < p.cantidad) {
                return res.status(400).json({
                    error: `No hay suficiente stock de ${data.nombre}`
                });
            }

            const precio = Number(data.precio);
            const cantidad = Number(p.cantidad);

            total += precio * cantidad;

            items.push({
                title: String(data.nombre),
                quantity: cantidad,
                unit_price: precio,
                currency_id: "MXN"
            });
        }

        const preference = new Preference(client);
        const externalRef = "pedido_" + Date.now();

        const response = await preference.create({
            body: {
                items,
                notification_url: "https://backend-tienda-mrvc.onrender.com/webhook",
                metadata: {
                    nombre: datos?.nombre || "",
                    telefono: datos?.telefono || "",
                    direccion: datos?.direccion || "",
                    referencias: datos?.referencias || "",
                    carrito: carrito
                },
                back_urls: {
                    success: `https://darling-gaufre-294769.netlify.app/gracias.html?ref=${externalRef}`,
                    failure: "https://darling-gaufre-294769.netlify.app/error.html",
                    pending: "https://darling-gaufre-294769.netlify.app/pendiente.html"
                },
                auto_return: "approved",
                external_reference: externalRef
            }
        });

        // 🔥 GENERAR FOLIO
        const contadorRef = db.collection("config").doc("contadorPedidos");

        let folio = "PED-0001";

        await db.runTransaction(async (t) => {
            const doc = await t.get(contadorRef);

            let numero = 1;

            if (doc.exists) {
                numero = doc.data().ultimo + 1;
            }

            t.set(contadorRef, { ultimo: numero });

            folio = "PED-" + String(numero).padStart(4, "0");
        });

        // 🔥 GUARDAR PEDIDO
        try {
            await db.collection("pedidos").doc(externalRef).set({
                estado: "pendiente",
                carrito,
                datos,
                total: total,
                folio: folio,
                fecha: new Date()
            });
        } catch (err) {
            console.log("⚠️ Firebase falló:", err.message);
        }

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

// 🔔 WEBHOOK (sin cambios)
app.post("/webhook", async (req, res) => {
    try {
        console.log("📩 WEBHOOK RECIBIDO");

        const paymentId =
            req.body?.data?.id ||
            req.query?.["data.id"] ||
            req.query?.id;

        if (!paymentId) return res.sendStatus(200);

        const response = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
            headers: {
                Authorization: `Bearer ${process.env.MP_ACCESS_TOKEN}`
            }
        });

        const data = await response.json();

        if (data.status === "approved") {
            console.log("🔥 PAGO APROBADO");

            const externalRef = data.external_reference;
            const pedidoRef = db.collection("pedidos").doc(externalRef);

            let pedido;

            await db.runTransaction(async (t) => {
                const doc = await t.get(pedidoRef);

                if (!doc.exists) return;

                pedido = doc.data();

                if (pedido.estado === "pagado" || pedido.estado === "procesando") {
                    console.log("⚠️ Ya procesado o en proceso");
                    pedido = null;
                    return;
                }

                t.update(pedidoRef, {
                    estado: "procesando"
                });
            });

            if (!pedido) return res.sendStatus(200);

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


// 🧾 OBTENER PEDIDO (MEJORADO)
app.get("/pedido/:ref", async (req, res) => {
    try {
        const ref = req.params.ref;
        const doc = await db.collection("pedidos").doc(ref).get();

        if (!doc.exists) {
            return res.status(404).json({ error: "Pedido no encontrado" });
        }

        const data = doc.data();

        res.json({
            folio: data.folio,
            total: data.total,
            nombre: data.datos?.nombre || "",
            telefono: data.datos?.telefono || "",
            direccion: data.datos?.direccion || "",
            referencias: data.datos?.referencias || "",
            carrito: data.carrito || [],
            fecha: data.fecha
        });

    } catch (error) {
        res.status(500).json({ error: "Error obteniendo pedido" });
    }
});


// 📲 WHATSAPP PRO
app.get("/whatsapp/:ref", async (req, res) => {
    try {
        const ref = req.params.ref;
        const doc = await db.collection("pedidos").doc(ref).get();

        if (!doc.exists) {
            return res.status(404).json({ error: "Pedido no encontrado" });
        }

        const data = doc.data();

        let mensaje = `🧾 *NUEVO PEDIDO*\n\n`;
        mensaje += `📌 Folio: ${data.folio}\n`;
        mensaje += `💰 Total: $${data.total}\n`;
        mensaje += `👤 Cliente: ${data.datos?.nombre}\n`;
        mensaje += `📞 Tel: ${data.datos?.telefono}\n`;
        mensaje += `📍 Dirección: ${data.datos?.direccion}\n`;

        if (data.datos?.referencias) {
            mensaje += `📝 Referencias: ${data.datos.referencias}\n`;
        }

        mensaje += `\n📦 *Productos:*\n`;

        data.carrito.forEach(p => {
            mensaje += `• ${p.nombre} x${p.cantidad}\n`;
        });

        mensaje += `\n📅 Fecha: ${new Date().toLocaleString()}`;

        const numero = "5218111843963"; // 👈 TU NÚMERO

        const url = `https://wa.me/${numero}?text=${encodeURIComponent(mensaje)}`;

        res.json({ url });

    } catch (error) {
        res.status(500).json({ error: "Error generando WhatsApp" });
    }
});


// 🚀 SERVIDOR
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log("🚀 Servidor corriendo en puerto " + PORT);
});
