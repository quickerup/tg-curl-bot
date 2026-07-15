# tg-curl-bot

Telegram bot -> Cloudflare Worker -> GitHub Actions `repository_dispatch`.

Messages from allowed Telegram user IDs are either answered directly by the
Worker (`GET <url>`) or dispatched as a shell command to a GitHub Actions
runner, which reports the result back to the same chat.

## Security model

- Only user IDs in `ALLOWED_USER_IDS` are served.
- The Worker verifies Telegram's `X-Telegram-Bot-Api-Secret-Token` header
  on every request, so a leaked/guessed Worker URL alone can't trigger a run.
- Commands run on GitHub Actions with a 60s timeout and access whatever
  `GH_PAT` and the runner's default environment allow — treat that PAT as
  fully privileged and keep the user allowlist short.
- Output is truncated to fit Telegram's 4096-character message limit.

## Re-running setup

The setup script is idempotent: it skips logins, repo creation, and
dependency installs that are already done, but re-prompts for secrets
each time (Worker/GitHub secrets can't be read back for comparison).
