// Deep Take Tech 计数接口：总访问人数 / 今日访问人数 / 文章阅读数 / 文章点赞数
// 部署：Cloudflare Pages Functions（随 GitHub 仓库自动部署）；持久化：KV，绑定名 STATS
// 前端每次打开页面调 ?action=visit；打开文章调 ?action=read&slug=<文章内部 id>；点赞调 ?action=like&slug=<id>，取消点赞调 ?action=unlike&slug=<id>
// “今日”按 Asia/Shanghai 日期算。UV 去重由前端 localStorage 控制（new=首次访问，newToday=今日首次访问）。
// 注意：KV 没有原子自增，极端并发下可能丢 1 个计数；本站量级可忽略。

function shanghaiToday() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const get = (t) => {
    const p = parts.find((x) => x.type === t);
    return p ? p.value : "";
  };
  return `${get("year")}-${get("month")}-${get("day")}`;
}

async function incr(kv, key, ttlSeconds) {
  const cur = parseInt((await kv.get(key, "text")) || "0", 10) || 0;
  const n = cur + 1;
  if (ttlSeconds) await kv.put(key, String(n), { expirationTtl: ttlSeconds });
  else await kv.put(key, String(n));
  return n;
}

async function getNum(kv, key) {
  return parseInt((await kv.get(key, "text")) || "0", 10) || 0;
}

export async function onRequest(context) {
  const { request, env } = context;
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store",
  };
  const kv = env.STATS;
  if (!kv) {
    return new Response(JSON.stringify({ ok: false, error: "KV not bound" }), {
      status: 503,
      headers,
    });
  }
  const url = new URL(request.url);
  const action = url.searchParams.get("action") || "visit";
  const today = shanghaiToday();
  try {
    if (action === "visit") {
      const isNew = url.searchParams.get("new") === "1";
      const isNewToday = url.searchParams.get("newToday") === "1";
      const slugs = (url.searchParams.get("slugs") || "")
        .split(",")
        .filter(Boolean);
      const pvTotal = await incr(kv, "pv:total");
      const pvToday = await incr(kv, "pv:" + today, 172800);
      let uvTotal = await getNum(kv, "uv:total");
      let uvToday = await getNum(kv, "uv:" + today);
      if (isNew) uvTotal = await incr(kv, "uv:total");
      if (isNewToday) uvToday = await incr(kv, "uv:" + today, 172800);
      const reads = {};
      const likes = {};
      for (const s of slugs) {
        reads[s] = await getNum(kv, "reads:" + s);
        likes[s] = await getNum(kv, "likes:" + s);
      }
      return new Response(
        JSON.stringify({
          ok: true,
          date: today,
          uvTotal,
          uvToday,
          pvTotal,
          pvToday,
          reads,
          likes,
        }),
        { headers }
      );
    }
    if (action === "read") {
      const slug = url.searchParams.get("slug") || "";
      if (!slug)
        return new Response(
          JSON.stringify({ ok: false, error: "missing slug" }),
          { status: 400, headers }
        );
      const n = await incr(kv, "reads:" + slug);
      return new Response(JSON.stringify({ ok: true, slug, reads: n }), {
        headers,
      });
    }
    if (action === "like" || action === "unlike") {
      const slug = url.searchParams.get("slug") || "";
      if (!slug)
        return new Response(
          JSON.stringify({ ok: false, error: "missing slug" }),
          { status: 400, headers }
        );
      const key = "likes:" + slug;
      let n;
      if (action === "like") {
        n = await incr(kv, key);
      } else {
        const cur = await getNum(kv, key);
        n = Math.max(0, cur - 1);
        await kv.put(key, String(n));
      }
      return new Response(JSON.stringify({ ok: true, slug, likes: n }), {
        headers,
      });
    }
    return new Response(JSON.stringify({ ok: false, error: "bad action" }), {
      status: 400,
      headers,
    });
  } catch (e) {
    return new Response(
      JSON.stringify({ ok: false, error: String((e && e.message) || e) }),
      { status: 500, headers }
    );
  }
}
