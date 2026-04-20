# AI Bookmark Manager Extension

This is the official companion browser extension for the AI Bookmark Manager app.

It is not standalone. The extension expects a compatible AI Bookmark Manager backend and uses your existing browser session for that app.

## What it does

- Save the current tab to your AI Bookmark Manager library
- Queue retries when the app is temporarily unreachable
- Import Chrome bookmarks into the app in batches

## Requirements

You need a deployed AI Bookmark Manager app that exposes:

- `POST /api/bookmarks`
- `POST /api/bookmarks/import`

The extension also expects you to be logged into the app in the same browser profile. When the app session expires, the extension opens the dashboard so you can sign in again.

## Setup

1. Load the extension in Chrome from `chrome://extensions`.
2. Open the extension settings page.
3. Enter your app URL, for example `https://your-ai-bookmarks.example.com`.
4. Approve the host permission request for that URL.
5. Log into the app in your browser.

After that, the popup can save the current page directly to your bookmark library.

## Permissions model

This repo intentionally does not ship with a hardcoded production host in the manifest.

Instead, when you save the app URL in settings, the extension requests host access for that specific origin. That keeps the repo publish-safe while still making the extension work with your own deployment.

## Local development

For local app development, point the extension at:

- `http://localhost:8787`

If your app uses a different local host or port, use that origin in settings and grant permission when prompted.

## Relationship to the app repo

This repo is the companion client only. The app itself lives in the AI Bookmark Manager app repo, which contains the Worker API, D1/Vectorize integration, and web dashboard.
