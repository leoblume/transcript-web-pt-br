import { createFileRoute } from "@tanstack/react-router";

// Proxies GET/HEAD requests for Hugging Face Hub model files through this
// Worker instead of letting the browser fetch huggingface.co directly.
//
// Why: transcribe.worker.ts downloads the Whisper model straight from
// huggingface.co in the browser. That request is cross-origin, so it only
// works if HF's edge sends back an Access-Control-Allow-Origin header for
// that particular request/host/redirect chain — and in practice this is
// exactly what breaks in some networks/browsers (ad/privacy blockers,
// corporate proxies, occasional HF edge hiccups), surfacing as a CORS error
// in the console even though the real cause has nothing to do with our own
// Cloudflare config.
//
// Fetching huggingface.co from *inside* the Worker is a plain server-to-server
// request (no CORS involved at all), and streaming the bytes back to the
// browser from our own origin means the browser never talks to huggingface.co
// directly — so this class of error goes away regardless of its root cause.
const HF_HOST = "https://huggingface.co";

const FORWARD_REQUEST_HEADERS = ["range", "if-none-match", "if-modified-since"];
const FORWARD_RESPONSE_HEADERS = [
  "content-type",
  "content-length",
  "accept-ranges",
  "content-range",
  "etag",
  "last-modified",
  "cache-control",
];

async function proxyToHuggingFace({
  request,
  params,
}: {
  request: Request;
  params: { _splat?: string };
}) {
  const splat = params._splat ?? "";
  if (!splat) {
    return new Response("Missing model path", { status: 400 });
  }

  const incomingUrl = new URL(request.url);
  const targetUrl = `${HF_HOST}/${splat}${incomingUrl.search}`;

  const headers = new Headers();
  for (const name of FORWARD_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }

  let upstream: Response;
  try {
    upstream = await fetch(targetUrl, {
      method: request.method,
      headers,
      redirect: "follow",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return new Response(`Falha ao buscar modelo no Hugging Face: ${message}`, { status: 502 });
  }

  const responseHeaders = new Headers();
  for (const name of FORWARD_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) responseHeaders.set(name, value);
  }
  // Same-origin from the browser's point of view, but set this anyway in
  // case the artifact/preview is ever loaded from another origin.
  responseHeaders.set("Access-Control-Allow-Origin", "*");

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}

export const Route = createFileRoute("/api/hf/$")({
  server: {
    handlers: {
      GET: proxyToHuggingFace,
      HEAD: proxyToHuggingFace,
    },
  },
});
