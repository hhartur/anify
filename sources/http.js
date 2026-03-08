const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

export async function http(url, referer) {
  const WORKER = process.env.PROXY_WORKER_URL || "";

  console.log(`[http] PROXY_WORKER_URL=${WORKER || "(vazio)"}`);
  console.log(`[http] url=${url}`);

  const fetchUrl = WORKER
    ? `${WORKER}?url=${encodeURIComponent(url)}`
    : url;

  console.log(`[http] fetchUrl=${fetchUrl}`);

  const res = await fetch(fetchUrl, {
    headers: {
      "User-Agent": UA,
      Referer: referer || new URL(url).origin,
      "Accept-Language": "pt-BR,pt;q=0.9",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
  });

  console.log(`[http] status=${res.status}`);

  if (!res.ok)
    throw Object.assign(new Error(`Upstream ${res.status}: ${url}`), {
      statusCode: res.status,
    });
  return res.text();
}
