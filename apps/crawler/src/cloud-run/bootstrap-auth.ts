import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Storage } from "@google-cloud/storage";
import { chromium } from "playwright";

const ACCOUNTS_URL = "https://moneyforward.com/accounts";
const DEFAULT_TIMEOUT_MINUTES = 30;

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function isAuthenticatedAccountsUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.origin === "https://moneyforward.com" && parsed.pathname.startsWith("/accounts");
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const projectId = requireEnv("GCP_PROJECT_ID");
  const timeoutMinutes = Number.parseInt(
    process.env.AUTH_BOOTSTRAP_TIMEOUT_MINUTES || String(DEFAULT_TIMEOUT_MINUTES),
    10,
  );
  if (!Number.isSafeInteger(timeoutMinutes) || timeoutMinutes <= 0) {
    throw new Error("AUTH_BOOTSTRAP_TIMEOUT_MINUTES must be a positive integer");
  }
  const bucket = process.env.GCS_BUCKET?.trim() || `${projectId}-moneyforward-state`;
  const statePrefix = process.env.GCS_STATE_PREFIX?.trim() || "moneyforward";
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "mf-auth-bootstrap-"));
  const statePath = path.join(tempDir, "auth-state.json");
  const browser = await chromium.launch({ headless: false });

  try {
    const context = await browser.newContext({ locale: "ja-JP", timezoneId: "Asia/Tokyo" });
    const page = await context.newPage();
    console.error("[bootstrap-mf] Money Forwardのログイン画面を開きました。");
    console.error(
      `[bootstrap-mf] ブラウザー上でログインを完了してください（最大${timeoutMinutes}分待機します）。`,
    );
    await page.goto(ACCOUNTS_URL, { waitUntil: "domcontentloaded" });

    if (!isAuthenticatedAccountsUrl(page.url())) {
      await page.waitForURL((url) => isAuthenticatedAccountsUrl(url.toString()), {
        timeout: timeoutMinutes * 60 * 1000,
      });
    }
    await page.goto(ACCOUNTS_URL, { waitUntil: "domcontentloaded" });
    if (!isAuthenticatedAccountsUrl(page.url())) {
      throw new Error("Money Forward login did not reach the authenticated accounts page");
    }

    await context.storageState({ path: statePath });
    await new Storage({ projectId }).bucket(bucket).upload(statePath, {
      destination: `${statePrefix}/auth-state.json`,
      metadata: { cacheControl: "no-store" },
      resumable: false,
    });
    console.error(
      `[bootstrap-mf] 認証状態を gs://${bucket}/${statePrefix}/auth-state.json へ保存しました。`,
    );
  } finally {
    await browser.close();
    await rm(tempDir, { force: true, recursive: true });
  }
}

main().catch((failure) => {
  console.error("[bootstrap-mf] failed:", failure instanceof Error ? failure.message : failure);
  process.exitCode = 1;
});
