// Telegram webhook -> either answers directly (simple HTTP) or dispatches
// a GitHub Actions workflow run (anything needing real shell/curl).

export default {
  async fetch(request, env, ctx) {
    if (request.method !== "POST") return new Response("ok");

    // Reject anything that isn't actually from Telegram. Telegram sets this
    // header on every webhook POST when a secret_token was configured via
    // setWebhook; without this check, anyone who finds the Worker URL could
    // trigger arbitrary command dispatch.
    const incomingSecret = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
    if (incomingSecret !== env.WEBHOOK_SECRET_TOKEN) {
      return new Response("unauthorized", { status: 401 });
    }

    let update;
    try {
      update = await request.json();
    } catch {
      return new Response("bad request", { status: 400 });
    }

    const msg = update.message;
    if (!msg || !msg.text) return new Response("ok");

    const userId = String(msg.from.id);
    const allowed = env.ALLOWED_USER_IDS.split(",").map(s => s.trim());
    if (!allowed.includes(userId)) {
      // Silently ignore unauthorized users.
      return new Response("ok");
    }

    const chatId = msg.chat.id;
    const text = msg.text.trim();

    if (text === "/help" || text === "/start") {
      ctx.waitUntil((async () => {
        await sendMessage(env, chatId,
          "Send 'GET <url>' for a direct fetch, or any other text to run as a shell command via GitHub Actions."
        );
      })());
      return new Response("ok");
    }

    // Very simple routing: "GET <url>" handled directly by the Worker.
    // Anything else goes to GitHub Actions to run as a real shell command.
    const simpleGet = text.match(/^GET\s+(\S+)/i);
    if (simpleGet) {
      ctx.waitUntil((async () => {
        // Ack fast so Telegram doesn't retry.
        await sendMessage(env, chatId, "Working on it…");
        try {
          const res = await fetch(simpleGet[1]);
          const body = (await res.text()).slice(0, 3500);
          await sendMessage(env, chatId, `Status: ${res.status}\n${body}`);
        } catch (e) {
          await sendMessage(env, chatId, `Fetch failed: ${e.message}`);
        }
      })());
      return new Response("ok");
    }

    // Otherwise: dispatch to GitHub Actions.
    ctx.waitUntil((async () => {
      // Ack fast so Telegram doesn't retry.
      await sendMessage(env, chatId, "Working on it…");

      const commandB64 = btoa(unescape(encodeURIComponent(text)));
      const ghRes = await fetch(
        `https://api.github.com/repos/${env.GH_OWNER}/${env.GH_REPO}/dispatches`,
        {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${env.GH_PAT}`,
            "Accept": "application/vnd.github+json",
            "User-Agent": "tg-curl-bot-worker",
          },
          body: JSON.stringify({
            event_type: "run-command",
            client_payload: { command_b64: commandB64, chat_id: chatId },
          }),
        }
      );

      if (!ghRes.ok) {
        await sendMessage(env, chatId, `Failed to dispatch job (${ghRes.status}).`);
      }
    })());

    return new Response("ok");
  },
};

async function sendMessage(env, chatId, text) {
  // Best-effort retry: Telegram/network hiccups shouldn't silently drop
  // the only feedback the user gets.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text }),
      });
      if (res.ok) return;
    } catch {
      // fall through to retry
    }
    await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
  }
}
