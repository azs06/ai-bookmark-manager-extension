// On-device summarization via Chrome's stable Summarizer API.
//
// Returns { summary, source } on success, null when the API is unavailable
// or the model can't produce output. Callers MUST treat null as "skip" —
// the backend will run Gemma normally when no client summary arrives.
//
// We intentionally don't fall back to the Prompt API: it's still origin-trial
// gated and the trial token + stable extension ID dance isn't worth it for
// a backup path Gemma already covers.

const SHARED_CONTEXT = 'A web page the user is bookmarking for later reference.';

export async function summarizeOnDevice(text, { signal } = {}) {
  if (!isSummarizerSupported()) return null;

  let availability;
  try {
    availability = await globalThis.Summarizer.availability();
  } catch {
    return null;
  }
  if (availability === 'unavailable') return null;

  let summarizer;
  try {
    summarizer = await globalThis.Summarizer.create({
      type: 'tldr',
      format: 'plain-text',
      length: 'short',
      sharedContext: SHARED_CONTEXT,
      signal,
    });
  } catch {
    // Most likely cause: model needs to download and the user hasn't opted in,
    // or the API is gated by enterprise policy. Either way, skip silently.
    return null;
  }

  try {
    const summary = (await summarizer.summarize(text, { signal })).trim();
    if (!summary) return null;
    return { summary, source: 'on-device' };
  } catch {
    return null;
  } finally {
    summarizer.destroy?.();
  }
}

function isSummarizerSupported() {
  return typeof globalThis.Summarizer?.availability === 'function'
    && typeof globalThis.Summarizer?.create === 'function';
}
