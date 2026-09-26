import assert from "node:assert/strict";
import http from "node:http";
import { app } from "../../../src/app.js";

export async function runCorsTests() {
  console.log("\n========================================================");
  console.log("  TEST SUITE: CORS Configuration & Security Guards     ");
  console.log("========================================================");

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as any).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // 1. Allowed Origin receives Access-Control-Allow-Origin
    console.log("  → Test 1: Allowed frontend origin (http://localhost:5173)");
    const allowedRes = await fetch(`${baseUrl}/api/health`, {
      method: "GET",
      headers: {
        Origin: "http://localhost:5173",
      },
    });

    assert.strictEqual(allowedRes.status, 200);
    assert.strictEqual(
      allowedRes.headers.get("access-control-allow-origin"),
      "http://localhost:5173",
      "Allowed origin must receive Access-Control-Allow-Origin header matching FRONTEND_URL"
    );
    assert.strictEqual(
      allowedRes.headers.get("access-control-allow-credentials"),
      null,
      "CORS credentials must NOT be enabled (JWT auth uses headers, not cookies)"
    );
    console.log(
      "    ✓ Allowed origin correctly reflected without credentials: true"
    );

    // 2. Preflight OPTIONS request
    console.log("  → Test 2: Preflight OPTIONS request handling");
    const preflightRes = await fetch(`${baseUrl}/api/cases`, {
      method: "OPTIONS",
      headers: {
        Origin: "http://localhost:5173",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "Authorization, Content-Type",
      },
    });

    assert.strictEqual(
      preflightRes.status,
      204,
      "Preflight OPTIONS must respond with 204 No Content"
    );
    assert.strictEqual(
      preflightRes.headers.get("access-control-allow-origin"),
      "http://localhost:5173"
    );
    assert.strictEqual(
      preflightRes.headers.get("access-control-allow-credentials"),
      null
    );
    console.log(
      "    ✓ Preflight OPTIONS request passed cleanly with 204 No Content"
    );

    // 3. Unauthorized Origin does NOT get Access-Control-Allow-Origin
    console.log("  → Test 3: Unauthorized external origin rejection");
    const disallowedRes = await fetch(`${baseUrl}/api/health`, {
      method: "GET",
      headers: {
        Origin: "http://malicious-site.com",
      },
    });

    assert.strictEqual(disallowedRes.status, 200);
    assert.strictEqual(
      disallowedRes.headers.get("access-control-allow-origin"),
      null,
      "Unauthorized origin must NOT receive Access-Control-Allow-Origin header"
    );
    console.log(
      "    ✓ Disallowed origin blocked from accessing resources across origins"
    );

    console.log("\n✓ All CORS tests passed successfully!");
  } finally {
    server.close();
  }
}

if (process.argv[1]?.endsWith("cors.test.ts")) {
  runCorsTests().catch((err) => {
    console.error("❌ CORS tests failed:", err);
    process.exit(1);
  });
}
