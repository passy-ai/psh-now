/**
 * Content encoding, done in the app.
 *
 * The origin used to hand every byte over raw: `curl -H 'accept-encoding: br,gzip'`
 * on `https://psh.now/` returned a 48 KB stylesheet and a 50 KB document with no
 * `content-encoding` at all, and Cloudflare passed it through. Lighthouse charged
 * 114 KiB per page load to that, and the first-paint cost that comes with it.
 *
 * Doing it here rather than at the edge is deliberate: the tunnel is a dumb pipe,
 * so whatever this process sends is what the browser gets, on every hostname.
 *
 * Brotli first, gzip second, nothing third. The whole point is a smaller transfer,
 * so a body that would not shrink is returned untouched rather than paying 20
 * bytes of framing for nothing.
 */
import { brotliCompressSync, gzipSync, constants } from "node:zlib";

/** Types worth compressing: text, plus the JSON the API answers with. */
const COMPRESSIBLE =
  /^(?:text\/|application\/(?:json|javascript|xml|manifest\+json)|image\/svg\+xml)/;

/** Below this, framing costs more than it saves. */
const MIN_BYTES = 1024;

/**
 * Above this, quality 11 is too slow to run inside a request. Brotli's quality
 * curve is steep at the top: `website/styles.css` is 14.4 KB at q11 (75 ms) and
 * 16.2 KB at q6 (1.2 ms). Large documents take q6, which is where the extra
 * effort stops buying anything close to its cost.
 */
const Q11_LIMIT = 96 * 1024;

/**
 * Compressed bodies, keyed by encoding and body length. Asset and page bodies are
 * derived from files on disk and only change when a deploy restarts the process;
 * the length is part of the key so a rebuilt stylesheet cannot collide with the
 * cached bytes of the previous one. This is what keeps quality 11 affordable: the
 * 75 ms is paid once per file, not once per request.
 */
const cache = new Map<string, Uint8Array>();
const CACHE_LIMIT = 64;

/** `br`, `gzip`, or null when the client asked for neither. */
export function pickEncoding(acceptEncoding: string | null): "br" | "gzip" | null {
  const header = (acceptEncoding ?? "").toLowerCase();
  if (/\bbr\b/.test(header)) return "br";
  if (/\bgzip\b/.test(header)) return "gzip";
  return null;
}

/** Compress a buffer, reusing the cached result for identical bodies. */
function compress(buf: Buffer, encoding: "br" | "gzip"): Uint8Array {
  const key = `${encoding}:${buf.length}:${buf.subarray(0, 64).toString("latin1")}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const out =
    encoding === "br"
      ? brotliCompressSync(buf, {
          params: {
            [constants.BROTLI_PARAM_QUALITY]: buf.length <= Q11_LIMIT ? 11 : 6,
            [constants.BROTLI_PARAM_SIZE_HINT]: buf.length,
          },
        })
      : gzipSync(buf, { level: 9 });

  if (cache.size >= CACHE_LIMIT) cache.clear();
  cache.set(key, out);
  return out;
}

/**
 * Wrap a response in the client's preferred encoding, when it is worth doing.
 *
 * Returns the response untouched for anything already encoded, anything that is
 * not text, anything too small to bother with, and any body that failed to
 * shrink. `content-length` is dropped because it no longer describes the body,
 * and `vary` gains `Accept-Encoding` so a cache cannot hand brotli to a client
 * that asked for gzip.
 */
export async function compressResponse(
  response: Response,
  acceptEncoding: string | null,
): Promise<Response> {
  if (response.status === 204 || response.status === 304) return response;
  if (response.headers.has("content-encoding")) return response;
  if (!COMPRESSIBLE.test(response.headers.get("content-type") ?? "")) return response;
  if (response.body === null) return response;

  const encoding = pickEncoding(acceptEncoding);
  if (encoding === null) return response;

  // Reading the body consumes it, so from here on the original response can no longer be
  // returned: every path below rebuilds one from `buf`. (Returning the original after this
  // point sent an empty body for every response under `MIN_BYTES`.)
  let buf: Buffer;
  try {
    buf = Buffer.from(await response.arrayBuffer());
  } catch {
    return response;
  }

  const headers = new Headers(response.headers);
  // `Buffer` is a `Uint8Array` at runtime but the DOM types do not accept it as `BodyInit`,
  // so the body is narrowed to a plain byte view.
  const rebuild = (body: Uint8Array) => {
    headers.delete("content-length");
    return new Response(body as unknown as BodyInit, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  };

  if (buf.length < MIN_BYTES) return rebuild(buf);

  const out = compress(buf, encoding);
  if (out.length >= buf.length) return rebuild(buf);

  headers.set("content-encoding", encoding);
  const vary = headers.get("vary");
  headers.set(
    "vary",
    vary && vary !== "*" ? `${vary}, Accept-Encoding` : "Accept-Encoding",
  );
  return rebuild(out);
}
