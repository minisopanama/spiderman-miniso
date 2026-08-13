// Recibe el registro del formulario de pre-save y lo sincroniza con ActiveCampaign.
// Variables de entorno requeridas (Netlify → Site settings → Environment variables):
//   AC_API_URL        https://tuempresa.api-us1.com   (Settings → Developer en ActiveCampaign)
//   AC_API_KEY        tu API Key                       (Settings → Developer en ActiveCampaign)
//   AC_LIST_ID        4                                 (ID de la lista, ya confirmado)
// Opcionales:
//   AC_TAG_NAME       nombre del tag a aplicar (default: "presave-spiderman").
//                     La función busca el ID por nombre en cada envío — no hace
//                     falta ir a buscarlo a mano. Este tag es el que dispara la
//                     automatización de los 3 emails en ActiveCampaign.
//   AC_TAG_ID         si prefieres fijar el ID directamente, se usa en vez de
//                     buscar por nombre (evita una llamada extra a la API).
//   AC_CODE_FIELD_ID  ID del campo personalizado donde guardar el código único

async function resolveTagId(API_URL, headers, tagName) {
  const res = await fetch(API_URL + "/api/3/tags?search=" + encodeURIComponent(tagName), { headers: headers });
  if (!res.ok) return null;
  const data = await res.json();
  const tags = data.tags || [];
  const exact = tags.find(function (t) { return t.tag === tagName; });
  return exact ? exact.id : (tags[0] ? tags[0].id : null);
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method Not Allowed" }) };
  }

  let data;
  try {
    data = JSON.parse(event.body || "{}");
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: "JSON inválido" }) };
  }

  // Honeypot: si el campo trampa viene lleno, es un bot. Respondemos OK sin procesar
  // para no delatar que fue detectado.
  if (data.empresa) {
    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  }

  const nombre = (data.nombre || "").trim();
  const telefono = (data.telefono || "").trim();
  const email = (data.email || "").trim();
  const codigo = (data.codigo || "").trim();

  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  const telefonoOk = telefono.replace(/\D/g, "").length >= 7;
  if (nombre.length < 3 || !telefonoOk || !emailOk) {
    return { statusCode: 400, body: JSON.stringify({ error: "Datos inválidos" }) };
  }

  const API_URL = process.env.AC_API_URL;
  const API_KEY = process.env.AC_API_KEY;
  const LIST_ID = process.env.AC_LIST_ID;
  const TAG_ID_ENV = process.env.AC_TAG_ID;
  const TAG_NAME = process.env.AC_TAG_NAME || "presave-spiderman";
  const CODE_FIELD_ID = process.env.AC_CODE_FIELD_ID;

  if (!API_URL || !API_KEY) {
    return { statusCode: 500, body: JSON.stringify({ error: "Integración de ActiveCampaign no configurada" }) };
  }

  const headers = {
    "Api-Token": API_KEY,
    "Content-Type": "application/json"
  };

  try {
    const fieldValues = [];
    if (CODE_FIELD_ID) {
      fieldValues.push({ field: CODE_FIELD_ID, value: codigo });
    }

    // 1. Crea o actualiza el contacto (contact/sync es idempotente por email)
    const syncRes = await fetch(API_URL + "/api/3/contact/sync", {
      method: "POST",
      headers,
      body: JSON.stringify({
        contact: {
          email: email,
          firstName: nombre,
          phone: telefono,
          fieldValues: fieldValues
        }
      })
    });

    if (!syncRes.ok) {
      const errText = await syncRes.text();
      return { statusCode: 502, body: JSON.stringify({ error: "No se pudo sincronizar con ActiveCampaign", detail: errText }) };
    }

    const syncData = await syncRes.json();
    const contactId = syncData.contact && syncData.contact.id;

    // 2. Suscribe el contacto a la lista
    if (contactId && LIST_ID) {
      await fetch(API_URL + "/api/3/contactLists", {
        method: "POST",
        headers,
        body: JSON.stringify({
          contactList: { list: LIST_ID, contact: contactId, status: 1 }
        })
      });
    }

    // 3. Aplica el tag (dispara la automatización de emails en ActiveCampaign).
    //    Si no fijaron AC_TAG_ID, lo resuelve buscando por nombre (AC_TAG_NAME).
    let tagId = TAG_ID_ENV || null;
    if (!tagId && TAG_NAME) {
      tagId = await resolveTagId(API_URL, headers, TAG_NAME);
    }
    if (contactId && tagId) {
      await fetch(API_URL + "/api/3/contactTags", {
        method: "POST",
        headers,
        body: JSON.stringify({
          contactTag: { contact: contactId, tag: tagId }
        })
      });
    }

    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: "Error interno", detail: String(err) }) };
  }
};
