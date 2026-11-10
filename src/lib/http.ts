/** An error carrying an HTTP status code, translated by the global onError. */
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public code = "error",
    public details?: unknown,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export const badRequest = (msg: string, details?: unknown) =>
  new HttpError(400, msg, "bad_request", details);
export const unauthorized = (msg = "Missing or invalid credentials") =>
  new HttpError(401, msg, "unauthorized");
export const forbidden = (msg = "Forbidden") => new HttpError(403, msg, "forbidden");
export const notFound = (msg = "Not found") => new HttpError(404, msg, "not_found");
export const conflict = (msg: string) => new HttpError(409, msg, "conflict");
export const gone = (msg: string) => new HttpError(410, msg, "gone");
export const paymentRequired = (msg: string, details?: unknown) =>
  new HttpError(402, msg, "plan_limit", details);
export const tooMany = (msg = "Too many requests") =>
  new HttpError(429, msg, "rate_limited");
