import { logger } from "../logging/logger";

export type NotifyEvent =
  | "buy"
  | "sell"
  | "profit_target"
  | "stop_loss"
  | "error"
  | "wallet_issue"
  | "high_score_token"
  | "rug_warning";

const EMOJI: Record<NotifyEvent, string> = {
  buy: "🟢",
  sell: "🔴",
  profit_target: "🎯",
  stop_loss: "🛑",
  error: "⚠️",
  wallet_issue: "👛",
  high_score_token: "⭐",
  rug_warning: "🚨",
};

/**
 * Fan-out notifications to every configured channel. Channels are optional
 * and independent — one failing never blocks the others or the engine.
 */
export async function notify(event: NotifyEvent, title: string, body: string): Promise<void> {
  const text = `${EMOJI[event]} ${title}\n${body}`;
  await Promise.allSettled([sendTelegram(text), sendDiscord(text), sendEmail(title, body)]);
}

async function sendTelegram(text: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(5000),
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (e) {
    logger.warn("notify", `telegram send failed: ${(e as Error).message}`);
  }
}

async function sendDiscord(text: string): Promise<void> {
  const url = process.env.DISCORD_WEBHOOK_URL;
  if (!url) return;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(5000),
      body: JSON.stringify({ content: text.slice(0, 1900) }),
    });
    if (!res.ok && res.status !== 204) throw new Error(`HTTP ${res.status}`);
  } catch (e) {
    logger.warn("notify", `discord send failed: ${(e as Error).message}`);
  }
}

let emailStubWarned = false;

async function sendEmail(_subject: string, _body: string): Promise<void> {
  const { SMTP_HOST, NOTIFY_EMAIL_TO } = process.env;
  if (!SMTP_HOST || !NOTIFY_EMAIL_TO) return;
  // Honest stub: SMTP delivery is NOT implemented (kept dependency-free).
  // Warn once so the operator never believes email alerts are flowing —
  // use Telegram or Discord for delivery today, or wire nodemailer here.
  if (!emailStubWarned) {
    emailStubWarned = true;
    logger.warn(
      "notify",
      "SMTP_HOST is set but email delivery is not implemented — use Telegram/Discord notifications, or add an SMTP client here"
    );
  }
}
