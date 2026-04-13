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

app.use(cors({ origin: "*" }));
app.use(express.json());

// 🔥 MERCADO PAGO
const client = new MercadoPagoConfig({
    accessToken: "APP_USR-5021755149745946-040518-97323883ca24caefe768f36d4356cc4f-3315715483"
});

// 🛒 CREAR PAGO
app.post("/crear-pago", async (req, res) => {
    try {
        const { carrito, datos } = req.body;

        console.log("🛒 Carrito recibido:", carrito);

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

        // 🔥 GUARDAR PEDIDO PREVIO (NUEVO PERO NO AFECTA NADA)
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
        console.error("❌ ERROR MERCADO PAGO:", error);
        console.error("📛 DETALLE:", error.response?.data);

        res.status(500).json({
            error: "Error al crear pago",
            detalle: error.message
        });
    }
});

// 🔔 WEBHOOK
app.post("/webhook", async (req, res) => {
    try {
        console.log("📩 WEBHOOK RECIBIDO");

        const paymentId = req.body?.data?.id;

        if (!paymentId) {
            console.log("❌ No hay paymentId");
            return res.sendStatus(200);
        }

        const response = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
            headers: {
                Authorization: `Bearer APP_USR-5021755149745946-040518-97323883ca24caefe768f36d4356cc4f-3315715483`
            }
        });

        const data = await response.json();

        console.log("💳 Estado:", data.status);

        if (data.status === "approved") {

            console.log("🔥 PAGO APROBADO");

            const meta = data.metadata || {};
            console.log("🧠 Metadata:", meta);

            let carrito = meta.carrito;

            // 🔥 FALLBACK SI NO LLEGA METADATA
            if (!carrito) {
                console.log("⚠️ No llegó carrito, buscando en Firebase");

                const refPedido = data.external_reference;
                const docPedido = await db.collection("pedidos").doc(refPedido).get();

                if (docPedido.exists) {
                    carrito = docPedido.data().carrito;
                    console.log("✅ Carrito recuperado");
                }
            }

            if (!carrito) {
                console.log("❌ No hay carrito, no se descuenta");
                return res.sendStatus(200);
            }

            // 🚫 EVITAR DOBLE PROCESO
            const yaProcesado = await db.collection("pagos").doc(String(paymentId)).get();

            if (yaProcesado.exists) {
                console.log("⚠️ Pago ya procesado");
                return res.sendStatus(200);
            }

            // 🔥 DESCONTAR STOCK
            for (const producto of carrito) {
                console.log("📦 Producto:", producto);

                const ref = db.collection("productos").doc(producto.id);
                const docSnap = await ref.get();

                if (docSnap.exists) {
                    const stockActual = docSnap.data().stock || 0;

                    console.log("📊 Stock actual:", stockActual);

                    await ref.update({
                        stock: Math.max(0, stockActual - producto.cantidad)
                    });

                    console.log(`📉 Stock actualizado: ${producto.nombre}`);
                } else {
                    console.log("❌ Producto no existe:", producto.id);
                }
            }

            // 🔥 MARCAR COMO PROCESADO
            await db.collection("pagos").doc(String(paymentId)).set({
                fecha: new Date()
            });

            // 🔥 GUARDAR PEDIDO FINAL
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
                carrito: carrito
            });

            const mensaje = generarMensajeCompleto(data, meta);
            console.log("📲 MENSAJE WHATSAPP:");
            console.log(mensaje);

            console.log("✅ TODO CORRECTO");
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
