import assert from "node:assert/strict";
import http from "node:http";
import { app } from "../../../src/app.js";

export async function runAuthRateLimitTests() {
  console.log("\n========================================================");
  console.log("  TEST SUITE: Edge Rate Limiting & Abuse Defense       ");
  console.log("========================================================");

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as any).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // ---------------------------------------------------------------
    // 1. Auth Login Rate Limiter (Brute-Force Protection)
    // ---------------------------------------------------------------
    const targetEmail = `brute_target_${Date.now()}@example.com`;

    console.log("  → Test 1: POST /api/auth/login brute-force defense");
    console.log(
      "    Sending 5 rapid failed login attempts (expecting 401 Unauthorized)..."
    );
    for (let i = 1; i <= 5; i++) {
      const res = await fetch(`${baseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: targetEmail,
          password: `wrong_pass_${i}`,
        }),
      });

      assert.strictEqual(
        res.status,
        401,
        `Attempt ${i} should return 401 Unauthorized before exceeding limit`
      );
    }

    console.log(
      "    Sending 6th failed login attempt (expecting 429 Rate Limit Exceeded)..."
    );
    const blockedLoginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: targetEmail,
        password: "wrong_pass_6",
      }),
    });

    const blockedLoginData = (await blockedLoginRes.json()) as any;
    console.log(`    Attempt 6: Status ${blockedLoginRes.status}`);
    console.log("    Response payload:", blockedLoginData);

    assert.strictEqual(
      blockedLoginRes.status,
      429,
      "6th failed login attempt must be blocked with HTTP 429 Rate Limit Exceeded"
    );
    assert.strictEqual(
      blockedLoginData.error.code,
      "rate_limit_exceeded",
      "Error code must be 'rate_limit_exceeded'"
    );

    // Verify response does not leak internal timer details in body
    assert.ok(
      !blockedLoginData.error.details ||
        Object.keys(blockedLoginData.error.details).length === 0,
      "Rate limit body must not leak countdown or attempt details to prevent attacker timing"
    );
    console.log("    ✓ Login brute-force lockout verified (blocked with 429)!");

    // ---------------------------------------------------------------
    // 2. Registration Rate Limiter (Anti-Bot Flooding Protection)
    // ---------------------------------------------------------------
    console.log("\n  → Test 2: POST /api/auth/register bot flooding defense");
    console.log("    Sending 10 rapid registration attempts...");
    for (let i = 1; i <= 10; i++) {
      const res = await fetch(`${baseUrl}/api/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          // Empty payload to quickly trigger validation without creating DB rows
          name: "",
        }),
      });

      assert.strictEqual(
        res.status,
        400,
        `Registration attempt ${i} should reach validation (400) before reaching rate limit`
      );
    }

    console.log(
      "    Sending 11th registration attempt (expecting 429 Rate Limit Exceeded)..."
    );
    const blockedRegRes = await fetch(`${baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Bot Account",
        email: "bot@example.com",
        password: "password12345",
      }),
    });

    const blockedRegData = (await blockedRegRes.json()) as any;
    console.log(`    Attempt 11: Status ${blockedRegRes.status}`);
    console.log("    Response payload:", blockedRegData);

    assert.strictEqual(
      blockedRegRes.status,
      429,
      "11th registration attempt must be blocked with HTTP 429 Rate Limit Exceeded"
    );
    assert.strictEqual(blockedRegData.error.code, "rate_limit_exceeded");
    console.log(
      "    ✓ Registration rate limit lockout verified (blocked with 429)!"
    );

    // ---------------------------------------------------------------
    // 3. Health Endpoint Isolation
    // ---------------------------------------------------------------
    console.log(
      "\n  → Test 3: Verifying unthrottled endpoints (/api/health)..."
    );
    const healthRes = await fetch(`${baseUrl}/api/health`);
    assert.strictEqual(
      healthRes.status,
      200,
      "Unrelated endpoints like /api/health must never be throttled"
    );
    console.log("    ✓ Route-specific isolation verified!");

    console.log("\n✓ All Rate Limiting tests passed successfully!");
  } finally {
    server.close();
  }
}

if (process.argv[1]?.endsWith("auth-rate-limit.test.ts")) {
  runAuthRateLimitTests().catch((err) => {
    console.error("❌ Rate limit test failed:", err);
    process.exit(1);
  });
}
