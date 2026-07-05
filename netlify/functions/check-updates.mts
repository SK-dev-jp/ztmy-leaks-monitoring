import type { Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { parse } from "node-html-parser";
import OAuth from "oauth-1.0a";
import { createHmac } from "crypto";

// ─── Types ───────────────────────────────────────────────────────────────────

interface PostInfo {
  title: string;
  url: string;
}

interface StoredState {
  latestUrl: string;
  latestTitle: string;
  checkedAt: string;
}

// ─── Site Scraping ───────────────────────────────────────────────────────────

async function fetchLatestPost(): Promise<PostInfo | null> {
  const res = await fetch("http://ihihi.me/", {
    headers: {
      "User-Agent": "ZTMY-LEAKS-Monitor/1.0",
    },
  });

  if (!res.ok) {
    console.error(`Failed to fetch ihihi.me: ${res.status} ${res.statusText}`);
    return null;
  }

  const html = await res.text();
  const root = parse(html);

  // WordPress Twenty Twenty theme: h2.entry-title > a
  const titleLink = root.querySelector("h2.entry-title a");
  if (!titleLink) {
    console.error("Could not find latest post element (h2.entry-title a)");
    return null;
  }

  const title = titleLink.textContent.trim();
  const url = titleLink.getAttribute("href") || "";

  if (!title || !url) {
    console.error("Extracted empty title or URL");
    return null;
  }

  return { title, url };
}

// ─── X (Twitter) API ─────────────────────────────────────────────────────────

function getOAuthClient(): OAuth {
  const apiKey = Netlify.env.get("X_API_KEY") || "";
  const apiSecret = Netlify.env.get("X_API_SECRET") || "";

  return new OAuth({
    consumer: { key: apiKey, secret: apiSecret },
    signature_method: "HMAC-SHA1",
    hash_function(baseString: string, key: string) {
      return createHmac("sha1", key).update(baseString).digest("base64");
    },
  });
}

function getTokens() {
  return {
    key: Netlify.env.get("X_ACCESS_TOKEN") || "",
    secret: Netlify.env.get("X_ACCESS_TOKEN_SECRET") || "",
  };
}

async function postToX(post: PostInfo): Promise<boolean> {
  const apiKey = Netlify.env.get("X_API_KEY");
  if (!apiKey) {
    console.warn("X API credentials not configured — skipping post");
    return false;
  }

  const tweetText = `🚨 ZTMY LEAKS 更新！\n\n📝 ${post.title}\n🔗 ${post.url}`;

  const oauth = getOAuthClient();
  const tokens = getTokens();

  const requestData = {
    url: "https://api.x.com/2/tweets",
    method: "POST" as const,
  };

  const authHeader = oauth.toHeader(
    oauth.authorize(requestData, tokens)
  );

  try {
    const res = await fetch(requestData.url, {
      method: "POST",
      headers: {
        ...authHeader,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text: tweetText }),
    });

    if (!res.ok) {
      const errorBody = await res.text();
      console.error(`X API error: ${res.status} ${res.statusText}`, errorBody);
      return false;
    }

    const data = await res.json();
    console.log("Successfully posted to X:", JSON.stringify(data));
    return true;
  } catch (err) {
    console.error("Failed to post to X:", err);
    return false;
  }
}

// ─── LINE Messaging API ──────────────────────────────────────────────────────

async function sendLineNotification(post: PostInfo): Promise<boolean> {
  const channelAccessToken = Netlify.env.get("LINE_CHANNEL_ACCESS_TOKEN");

  if (!channelAccessToken) {
    console.warn("LINE credentials not configured — skipping LINE notification");
    return false;
  }

  const messageText = `🚨 ZTMY LEAKS 更新！\n\n📝 ${post.title}\n🔗 ${post.url}`;

  try {
    // Broadcast to ALL friends (no user ID needed)
    const res = await fetch("https://api.line.me/v2/bot/message/broadcast", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${channelAccessToken}`,
      },
      body: JSON.stringify({
        messages: [
          {
            type: "text",
            text: messageText,
          },
        ],
      }),
    });

    if (!res.ok) {
      const errorBody = await res.text();
      console.error(`LINE API error: ${res.status} ${res.statusText}`, errorBody);
      return false;
    }

    console.log("Successfully sent LINE broadcast notification");
    return true;
  } catch (err) {
    console.error("Failed to send LINE notification:", err);
    return false;
  }
}

// ─── Main Handler ────────────────────────────────────────────────────────────

const STORE_NAME = "ihihi-monitor";
const STATE_KEY = "latest-post";

export default async (req: Request) => {
  const { next_run } = await req.json();
  console.log(`[check-updates] Running. Next invocation at: ${next_run}`);

  // 1. Fetch latest post from ihihi.me
  const latestPost = await fetchLatestPost();
  if (!latestPost) {
    console.log("Could not fetch latest post — aborting this run");
    return;
  }

  console.log(`Latest post: "${latestPost.title}" — ${latestPost.url}`);

  // 2. Compare with stored state
  const store = getStore({ name: STORE_NAME, consistency: "strong" });
  const storedState = await store.get(STATE_KEY, { type: "json" }) as StoredState | null;

  if (storedState && storedState.latestUrl === latestPost.url) {
    console.log("No new post detected — same as stored state");
    return;
  }

  // 3. New post detected!
  console.log(
    storedState
      ? `New post detected! Previous: "${storedState.latestTitle}" → New: "${latestPost.title}"`
      : `First run — storing initial state: "${latestPost.title}"`
  );

  // 4. Notify (only if not the first run — first run just stores the baseline)
  if (storedState) {
    await Promise.allSettled([
      postToX(latestPost),
      sendLineNotification(latestPost),
    ]);
  } else {
    console.log("First run — skipping notifications, storing baseline state");
  }

  // 5. Update stored state
  const newState: StoredState = {
    latestUrl: latestPost.url,
    latestTitle: latestPost.title,
    checkedAt: new Date().toISOString(),
  };
  await store.setJSON(STATE_KEY, newState);
  console.log("State updated in Netlify Blobs");
};

export const config: Config = {
  schedule: "*/30 * * * *",
};
