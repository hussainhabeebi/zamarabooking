/** Worker-compatible signing preparation only. This helper NEVER performs fetch(). */
export async function signedAkbarGatewayRequest(options: {
  origin: string;
  audience: string;
  keyId: string;
  signingKey: string;
  operation: "search" | "price";
  body: Record<string, unknown>;
  now?: number;
  nonce?: string;
}): Promise<Request> {
  const origin = new URL(options.origin);
  if (
    origin.protocol !== "https:" ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash ||
    origin.username ||
    origin.password ||
    options.signingKey.length < 32 ||
    !/^[A-Za-z0-9_-]{1,100}$/.test(options.keyId) ||
    !/^[A-Za-z0-9_.:-]{1,200}$/.test(options.audience) ||
    !["search", "price"].includes(options.operation)
  )
    throw new Error("Invalid Akbar gateway signing configuration");
  const timestamp = String(options.now ?? Date.now()),
    nonce = options.nonce ?? crypto.randomUUID();
  if (!/^\d{13}$/.test(timestamp) || !/^[A-Za-z0-9_-]{20,100}$/.test(nonce))
    throw new Error("Invalid Akbar gateway freshness data");
  const body = JSON.stringify(options.body),
    path = `/v1/akbar/${options.operation}`,
    encoder = new TextEncoder();
  const hex = (buffer: ArrayBuffer) =>
    Array.from(new Uint8Array(buffer), (n) =>
      n.toString(16).padStart(2, "0"),
    ).join("");
  const digest = hex(
    await crypto.subtle.digest("SHA-256", encoder.encode(body)),
  );
  const canonical = [
    "zamra-akbar-v1",
    options.audience,
    options.keyId,
    timestamp,
    nonce,
    "POST",
    path,
    digest,
  ].join("\n");
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(options.signingKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = hex(
    await crypto.subtle.sign("HMAC", key, encoder.encode(canonical)),
  );
  return new Request(origin.origin + path, {
    method: "POST",
    redirect: "error",
    headers: {
      "content-type": "application/json",
      "x-zamra-key-id": options.keyId,
      "x-zamra-timestamp": timestamp,
      "x-zamra-nonce": nonce,
      "x-zamra-signature": signature,
    },
    body,
  });
}
