// 滝マップ Notion プロキシ Worker
// GET  /api/falls                        — 全滝データ取得
// POST /api/falls                        — 新規滝追加 { name, pref, lat, lng, description?, imageUrl? }
// POST /api/falls/:pageId/visit          — 「行った」true + 行った日=今日
// POST /api/falls/:pageId/unvisit        — 「行った」false + 行った日クリア
// POST /api/falls/:pageId/coords         — 緯度経度更新 { lat, lng }
// POST /api/falls/:pageId/description    — 解説更新 { description }

const NOTION_VERSION = "2022-06-28";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = {
      "Access-Control-Allow-Origin": env.ALLOW_ORIGIN || "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: cors });
    }

    try {
      if (url.pathname === "/api/falls" && request.method === "GET") {
        const data = await fetchAllFalls(env);
        return json(data, cors);
      }

      if (url.pathname === "/api/falls" && request.method === "POST") {
        const body = await request.json();
        const result = await createFall(body, env);
        return json(result, cors);
      }

      const visitMatch = url.pathname.match(/^\/api\/falls\/([0-9a-f-]+)\/(visit|unvisit)$/i);
      if (visitMatch && request.method === "POST") {
        const [, pageId, action] = visitMatch;
        const result = await toggleVisit(pageId, action.toLowerCase() === "visit", env);
        return json(result, cors);
      }

      const coordsMatch = url.pathname.match(/^\/api\/falls\/([0-9a-f-]+)\/coords$/i);
      if (coordsMatch && request.method === "POST") {
        const [, pageId] = coordsMatch;
        const body = await request.json();
        const result = await updateCoords(pageId, body.lat, body.lng, env);
        return json(result, cors);
      }

      const descMatch = url.pathname.match(/^\/api\/falls\/([0-9a-f-]+)\/description$/i);
      if (descMatch && request.method === "POST") {
        const [, pageId] = descMatch;
        const body = await request.json();
        const result = await updateDescription(pageId, body.description, env);
        return json(result, cors);
      }

      if (url.pathname === "/" || url.pathname === "/api/health") {
        return json({ ok: true, service: "taki-map-api" }, cors);
      }

      return new Response(JSON.stringify({ error: "Not Found", path: url.pathname }), {
        status: 404,
        headers: { ...cors, "Content-Type": "application/json" },
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: String(e), stack: e.stack }), {
        status: 500,
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }
  },
};

function json(obj, cors) {
  return new Response(JSON.stringify(obj), {
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

async function notionFetch(path, opts, env) {
  const res = await fetch(`https://api.notion.com${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${env.NOTION_TOKEN}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Notion API ${res.status}: ${txt}`);
  }
  return res.json();
}

async function fetchAllFalls(env) {
  const falls = [];
  let cursor;
  do {
    const body = { page_size: 100 };
    if (cursor) body.start_cursor = cursor;
    const data = await notionFetch(
      `/v1/databases/${env.DATABASE_ID}/query`,
      { method: "POST", body: JSON.stringify(body) },
      env
    );
    for (const page of data.results) {
      const p = page.properties;
      const name = textOf(p["滝名"]?.title);
      const pref = textOf(p["都道府県"]?.rich_text);
      const lat = p["緯度"]?.number;
      const lng = p["経度"]?.number;
      const visited = p["行った"]?.checkbox || false;
      const visitDate = p["行った日"]?.date?.start || null;
      const description = textOf(p["解説"]?.rich_text);
      const imageFiles = p["イメージ画"]?.files || [];
      const imageUrl = imageFiles.find(f => f.external)?.external?.url || null;
      const evidenceFiles = p["証拠写真"]?.files || [];
      const evidenceUrl = evidenceFiles.find(f => f.external)?.external?.url
                        || (evidenceFiles[0]?.file?.url ?? null);
      falls.push({
        id: page.id,
        name,
        pref,
        lat,
        lng,
        visited,
        visitDate,
        description,
        notionUrl: page.url,
        imageUrl,
        evidenceUrl,
      });
    }
    cursor = data.has_more ? data.next_cursor : null;
  } while (cursor);
  return { updatedAt: new Date().toISOString(), falls };
}

function textOf(arr) {
  if (!arr || !Array.isArray(arr) || arr.length === 0) return "";
  return arr.map(t => t.plain_text || "").join("");
}

async function createFall(body, env) {
  const { name, pref, lat, lng, description, imageUrl } = body || {};
  if (!name || typeof lat !== "number" || typeof lng !== "number") {
    throw new Error("name, lat, lng are required");
  }
  const properties = {
    "滝名": { title: [{ text: { content: name } }] },
    "都道府県": { rich_text: [{ text: { content: pref || "" } }] },
    "緯度": { number: lat },
    "経度": { number: lng },
    "行った": { checkbox: false },
  };
  if (description) {
    properties["解説"] = { rich_text: [{ text: { content: description } }] };
  }
  if (imageUrl) {
    properties["イメージ画"] = {
      files: [{ name: name + " image", external: { url: imageUrl } }],
    };
  }
  const data = await notionFetch(
    `/v1/pages`,
    {
      method: "POST",
      body: JSON.stringify({
        parent: { database_id: env.DATABASE_ID },
        properties,
      }),
    },
    env
  );
  return { ok: true, id: data.id, url: data.url };
}

async function toggleVisit(pageId, visited, env) {
  const today = new Date().toISOString().slice(0, 10);
  const properties = {
    "行った": { checkbox: visited },
    "行った日": visited ? { date: { start: today } } : { date: null },
  };
  await notionFetch(
    `/v1/pages/${pageId}`,
    { method: "PATCH", body: JSON.stringify({ properties }) },
    env
  );
  return { ok: true, pageId, visited, visitDate: visited ? today : null };
}

async function updateCoords(pageId, lat, lng, env) {
  if (typeof lat !== "number" || typeof lng !== "number") {
    throw new Error("lat/lng must be numbers");
  }
  const properties = {
    "緯度": { number: lat },
    "経度": { number: lng },
  };
  await notionFetch(
    `/v1/pages/${pageId}`,
    { method: "PATCH", body: JSON.stringify({ properties }) },
    env
  );
  return { ok: true, pageId, lat, lng };
}

async function updateDescription(pageId, description, env) {
  const properties = {
    "解説": { rich_text: description ? [{ text: { content: description } }] : [] },
  };
  await notionFetch(
    `/v1/pages/${pageId}`,
    { method: "PATCH", body: JSON.stringify({ properties }) },
    env
  );
  return { ok: true, pageId };
}
