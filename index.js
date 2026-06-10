const express = require('express');
const axios = require('axios');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
app.use(express.json());

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

const conversations = {};

const SYSTEM_PROMPT = `Eres Valeria, asesora de ventas de Baby Lua, tienda mexicana de ropa, accesorios y juguetes para bebés. Atiendes por WhatsApp.

PERSONALIDAD:
- Cálida, amigable, natural — como una amiga que sabe de bebés
- Mensajes CORTOS: máximo 3-4 líneas
- Usas emojis con moderación (1-2 por mensaje)
- Lenguaje mexicano informal, usas "tú"
- Haces preguntas para personalizar la atención
- JAMÁS menciones que eres IA o bot

TIENDA BABY LUA:
- Ropa bebés 0-3 años: bodies, pijamas, conjuntos
- Accesorios: baberos, gorros, calcetines, mantas, portabebés
- Juguetes: mordedores, sonajeros, peluches, sensoriales
- Precios: $150 a $800 MXN
- Envíos: todo México, 3-7 días hábiles, gratis +$600 MXN
- Pagos: tarjeta, transferencia, OXXO
- Tienda: babylua.mx

PEDIDOS Y RASTREO:
- Para rastrear pide número de orden (#BL) o nombre/correo
- Pedidos normalmente salen en 1-2 días hábiles
- Simula consultar el sistema con respuestas realistas

VENTAS:
- Pregunta edad y sexo del bebé para recomendar mejor
- Si dudan por precio ofrece opciones o combos
- Cierra con "¿Te lo separo?" o "¿Te mando el link directo?"
- Nunca presiones, sé genuina`;

async function sendMessage(to, message) {
  await axios.post(
    `https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body: message }
    },
    { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } }
  );
}

async function getAIResponse(userId, userMessage) {
  if (!conversations[userId]) conversations[userId] = [];
  conversations[userId].push({ role: 'user', content: userMessage });
  if (conversations[userId].length > 20) conversations[userId] = conversations[userId].slice(-20);

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 500,
    system: SYSTEM_PROMPT,
    messages: conversations[userId]
  });

  const reply = response.content[0].text;
  conversations[userId].push({ role: 'assistant', content: reply });
  return reply;
}

// Webhook verification
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// Receive messages
app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  console.log('Webhook recibido:', JSON.stringify(req.body, null, 2));
  const body = req.body;
  if (body.object !== 'whatsapp_business_account') return;
  const entry = body.entry?.[0]?.changes?.[0]?.value;
  const message = entry?.messages?.[0];
  if (!message || message.type !== 'text') return;
  const from = message.from;
  const text = message.text.body;
  try {
    const reply = await getAIResponse(from, text);
    await sendMessage(from, reply);
  } catch (err) {
    console.error('Error:', err.message);
  }
});

app.get('/', (req, res) => res.send('Baby Lua Bot activo ✅'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Bot corriendo en puerto ${PORT}`));
