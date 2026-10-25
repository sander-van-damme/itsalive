#!/usr/bin/env node
/** Opt-in real Chromium → provider → coding → verification → commit test.
 * No token ceilings, pre-request reservations, credential output or browser traces.
 */
import { spawn } from "node:child_process";
const options = new Map(
  process.argv.slice(2).map((arg) => {
    const [key, ...value] = arg.split("=");
    return [key, value.join("=")];
  }),
);
if (!options.has("--live")) {
  console.error(
    "Live tests are disabled. Use npm run test:live -- --live with OPENAI_API_KEY supplied securely. This creates and updates a real application and incurs provider charges measured after requests.",
  );
  process.exitCode = 2;
} else if ((options.get("--provider") ?? "openai") !== "openai") {
  console.error("The live browser scenario currently supports OpenAI.");
  process.exitCode = 2;
} else if (!process.env.OPENAI_API_KEY) {
  console.error(
    "LIVE PROVIDER VERIFICATION NOT RUN: OPENAI_API_KEY is unavailable. Deterministic browser tests do not establish real-provider readiness.",
  );
  process.exitCode = 1;
} else {
  const budget = options.get("--budget");
  if (
    budget !== undefined &&
    (!Number.isFinite(Number(budget)) || Number(budget) <= 0)
  ) {
    console.error(
      "An optional --budget must be a positive USD amount. It prevents further requests after recorded spending reaches the threshold; it cannot cap an in-flight request.",
    );
    process.exitCode = 2;
  } else {
    const child = spawn(
      process.platform === "win32" ? "npx.cmd" : "npx",
      ["playwright", "test", "e2e/live-provider.spec.ts", "--reporter=line"],
      {
        stdio: "inherit",
        env: {
          ...process.env,
          ITSALIVE_LIVE: "1",
          ...(budget ? { ITSALIVE_LIVE_BUDGET: budget } : {}),
        },
      },
    );
    child.on("exit", (code) => {
      process.exitCode = code ?? 1;
    });
    child.on("error", () => {
      console.error(
        "Could not start the live browser test. Install dependencies and Chromium first.",
      );
      process.exitCode = 1;
    });
  }
}
