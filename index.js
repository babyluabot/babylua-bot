const express = require('express');
const axios = require('axios');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
app.use(express.json());

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const SHOPIFY_STORE = 'sd8gcy-zj.myshopify.com';

const conversations = {};

// Detectar país por código de teléfono
function detectCountry(phone) {
  if (phone.startsWith('51')) return { name: 'Perú', currency: 'PEN', symbol: 'S/', rate: 0.17 };
  if (phone.startsWith('593')) return { name: 'Ecuador', currency: 'USD', symbol: '$', rate: 0.05 };
  if (phone.startsWith('52')) return { name: 'México', currency: 'MXN', symbol: '$', rate: 1 };
  return { name: 'México', currency: 'MXN', symbol: '$', rate: 1 };
}

// Consultar productos de Shopify
async function getShopifyProducts(query = '') {
  try {
    const response = await axios.get(
      `https://${SHOPIFY_STORE}/admin/api/2024-01/products.json?limit=10&status=active${query ? '&title=' + encodeURIComponent(query) : ''}`,
      { headers: { 'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN } }
    );
    return response.data.products || [];
  } catch (err) {
    console.error('Error Shopify:', err.message);
    return [];
  }
}

// Formatear productos para Valeria
function formatProducts(products, country) {
  return products.slice(0, 5).map(p => {
    const price = parseFloat(p.variants[0]?.price || 0);
    const localPrice = (price * country.rate).toFixed(2);
    const image = p.images[0]?.src || '';
    return {
      id: p.id,
      title: p.title,
      price: price,
      localPrice: `${country.symbol}${localPrice} ${country.currency}`,
      mxnPrice: price,
      image: image,
      handle: p.handle,
      variantId: p.variants[0]?.id
    };
  });
}

// Armar link de checkout con carrito
function buildCheckoutLink(variantIds) {
  const items = variantIds.map(id => `${id}:1`).join(',');
  return `https://babylua.com.mx/cart/${items}`;
}

// Enviar mensaje de texto
async function sendMessage(to, message) {
  await axios.post(
    `https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`,
    { messaging_product: 'whatsapp', to, type: 'text', text: { body: message } },
    { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } }
  );
}

// Enviar imagen
async function sendImage(to, imageUrl, caption = '') {
  try {
    await axios.post(
      `https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: 'whatsapp', to, type: 'image',
        image: { link: imageUrl, caption }
      },
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } }
    );
  } catch (err) {
    console.error('Error enviando imagen:', err.message);
  }
}

async function getAIResponse(userId, userMessage, country, products) {
  if (!conversations[userId]) conversations[userId] = [];

  let productContext = '';
  if (products.length > 0) {
    productContext = '\n\nPRODUCTOS DISPONIBLES AHORA EN TIENDA:\n' +
      products.map((p, i) => `${i+1}. ${p.title} — ${p.localPrice} (ID variante: ${p.variantId})`).join('\n') +
      '\n\nCuando el cliente elija productos, incluye en tu respuesta los IDs de variante entre [VARIANTES: id1,id2] para armar su carrito.';
  }

  const systemPrompt = `Eres Valeria, asesora de ventas de Baby Lua, tienda de ropa, accesorios y juguetes para bebés. Atiendes por WhatsApp.
El cliente está en ${country.name} y los precios están en ${country.currency}.

PERSONALIDAD:
- Cálida, amigable, natural — como una amiga que sabe de bebés
- Mensajes CORTOS: máximo 3-4 líneas
- Usas emojis con moderación (1-2 por mensaje)
- Lenguaje informal, usas "tú"
- Haces preguntas para personalizar la atención
- JAMÁS menciones que eres IA o bot

TIENDA BABY LUA:
- Ropa bebés 0-3 años: bodies, pijamas, conjuntos
- Accesorios: baberos, gorros, calcetines, mantas, portabebés
- Juguetes: mordedores, sonajeros, peluches, sensoriales
- Envíos: toda ${country.name === 'México' ? 'México, 3-7 días hábiles, gratis +$600 MXN' : country.name + ', consultar tienda'}
- Pagos: tarjeta, transferencia${country.name === 'México' ? ', OXXO' : ''}
- Tienda: babylua.com.mx

VENTAS:
- Pregunta edad y sexo del bebé para recomendar mejor
- Muestra productos del catálogo real cuando sea relevante
- Cuando el cliente elija, incluye [VARIANTES: id1,id2] en tu respuesta
- Cierra con "¿Te armo el carrito directo?" 
- Nunca presiones, sé genuina${productContext}`;

  conversations[userId].push({ role: 'user', content: userMessage });
  if (conversations[userId].length > 20) conversations[userId] = conversations[userId].slice(-20);

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 600,
    system: systemPrompt,
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
  const body = req.body;
  if (body.object !== 'whatsapp_business_account') return;
  const entry = body.entry?.[0]?.changes?.[0]?.value;
  const message = entry?.messages?.[0];
  if (!message) return;

  const from = message.from;
  const country = detectCountry(from);

  // Manejo de mensajes de voz
  if (message.type === 'audio') {
    await sendMessage(from, 'Hola 😊 prefiero que me escribas para atenderte mejor, ¿qué buscas para tu bebé?');
    return;
  }

  if (message.type !== 'text') return;
  const text = message.text.body;

  try {
    // Buscar productos relevantes
    const products = await getShopifyProducts();
    const formatted = formatProducts(products, country);

    const reply = await getAIResponse(from, text, country, formatted);

    // Detectar si hay variantes seleccionadas
    const variantMatch = reply.match(/\[VARIANTES:\s*([\d,\s]+)\]/);
    const cleanReply = reply.replace(/\[VARIANTES:[\d,\s]+\]/g, '').trim();

    await sendMessage(from, cleanReply);

    // Enviar fotos de productos mencionados
    for (const product of formatted) {
      if (cleanReply.toLowerCase().includes(product.title.toLowerCase().split(' ')[0]) && product.image) {
        await sendImage(from, product.image, `${product.title} — ${product.localPrice}`);
      }
    }

    // Enviar link de carrito si hay variantes
    if (variantMatch) {
      const variantIds = variantMatch[1].split(',').map(id => id.trim()).filter(Boolean);
      if (variantIds.length > 0) {
        const checkoutLink = buildCheckoutLink(variantIds);
        await sendMessage(from, `🛒 Aquí está tu carrito listo para pagar:\n${checkoutLink}`);
      }
    }

  } catch (err) {
    console.error('Error:', err.message);
    await sendMessage(from, 'Disculpa, tuve un problemita 😅 ¿Me repites qué necesitas?');
  }
});

app.get('/', (req, res) => res.send('Baby Lua Bot activo ✅'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Bot corriendo en puerto ${PORT}`));
