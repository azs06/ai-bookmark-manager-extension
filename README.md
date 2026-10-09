# AI Bookmark Manager Extension

This is the official companion browser extension for the AI Bookmark Manager app.

It is not standalone. The extension expects a compatible AI Bookmark Manager backend and uses your existing browser session for that app.

## What it does

- Save the current tab to your AI Bookmark Manager library, or remove it
- Shorten the current URL and copy the short link
- Subscribe to the current page's RSS/Atom feed (with a picker when a page exposes several)
- Show a "saved" toolbar icon on pages already in your library
- Queue saves while the app is unreachable or you're logged out, and sync them later (queued count shows on the toolbar badge)
- Import Chrome bookmarks into the app in batches, with folder paths as tags
- Optionally summarize pages on-device with Chrome's built-in Summarizer before saving (off by default)

## Requirements

You need a deployed AI Bookmark Manager app that exposes:

- `POST /api/bookmarks` — save (accepts optional `auto_shorten`, `ai_summary`, `summary_source`)
- `POST /api/bookmarks/remove`
- `POST /api/bookmarks/import`
- `GET /api/bookmarks/hashes` — SHA-256 hashes of saved, normalized URLs (ETag / `If-None-Match` supported but optional)
- `POST /api/feeds` — subscribe (`300` with candidates, `409` when already subscribed)

The extension also expects you to be logged into the app in the same browser profile. When the app session expires, the extension opens the dashboard so you can sign in again.

## Setup

1. Load the extension in Chrome from `chrome://extensions`.
2. Open the extension settings page.
3. Enter your app URL, for example `https://your-ai-bookmarks.example.com`. A subpath such as `https://example.com/bookmarks` works too. Plain `http` is only allowed for `localhost` and `127.0.0.1`.
4. Approve the host permission request for that URL.
5. Log into the app in your browser.

After that, the popup can save the current page directly to your bookmark library.

## Permissions model

This repo intentionally does not ship with a hardcoded production host in the manifest.

Instead, when you save the app URL in settings, the extension requests host access for that specific origin. That keeps the repo publish-safe while still making the extension work with your own deployment.

Other permissions:

- `tabs` — read the active tab's URL on tab switches and navigations to swap in the "saved" icon. Chrome shows this as "Read your browsing history"; URLs are only hashed and compared locally, never sent anywhere.
- `activeTab` + `scripting` — read the text of the current page when you open the popup, only if on-device summaries are enabled in settings.
- `bookmarks` — the one-time Chrome bookmark import.
- `alarms`, `storage` — offline queue retries and the saved-URL cache.

## On-device summaries

When enabled in settings, the popup extracts the current page's text and summarizes it with Chrome's built-in Summarizer API, then sends that summary with the bookmark. The model runs locally, but the resulting summary is uploaded to your app. Because it reflects the page as you see it — including pages behind a login — it's opt-in.

## URL normalization contract

`lib/url.js` mirrors the backend's URL normalization and hashing exactly; the "already saved" icon depends on both sides producing identical hashes. `test/fixtures/url-vectors.json` holds shared test vectors — run the same assertions in the app repo to catch drift.

## Local development

Run the tests with `npm test` (Node 22+, no dependencies).

For local app development, point the extension at:

- `http://localhost:8787`

If your app uses a different local host or port, use that origin in settings and grant permission when prompted.

## Relationship to the app repo

This repo is the companion client only. The app itself lives in the AI Bookmark Manager app repo, which contains the Worker API, D1/Vectorize integration, and web dashboard.
