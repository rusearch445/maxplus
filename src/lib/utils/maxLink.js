import { invoke } from "@tauri-apps/api/core";
import { getWebAppProxyBase } from "./proxyConfig";
import { showAlert } from "./alert";
import { parseApiError } from "./errors";

const RESERVED_SLUGS = new Set([
  "login",
  "ps",
  "tos",
  "privacy",
  "about",
  "help",
  "settings",
]);

const VALID_IDENTIFIER_REGEX = /^[A-Za-z0-9_]+$/;

export function extractMaxUrlInfo(rawInput) {
  if (!rawInput || typeof rawInput !== "string") return null;

  let value = rawInput.trim();
  if (!value) return null;

  if (value.startsWith("max://")) {
    const withoutScheme = value.slice(6);
    value = withoutScheme.startsWith("max.ru")
      ? `https://${withoutScheme}`
      : `https://max.ru/${withoutScheme.replace(/^\/+/, "")}`;
  } else if (!value.includes("://")) {
    if (!/^(?:www\.)?max\.ru(?:\/|$)/i.test(value)) return null;
    value = `https://${value}`;
  }

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }

  const hostname = parsed.hostname.toLowerCase();
  if (hostname !== "max.ru" && hostname !== "www.max.ru") return null;

  if (parsed.searchParams.get("externalCallback") === "1" || value.includes("externalCallback=1")) {
    return {
      isMax: true,
      kind: "external_callback",
      canonicalUrl: value,
      startPayload: null,
      startAppParam: null,
      targetName: null,
    };
  }

  const segments = parsed.pathname
    .split("/")
    .map((s) => s.trim())
    .filter(Boolean);

  const startParam = parsed.searchParams.get("start");
  const startPayload = startParam !== null ? startParam.trim() : null;

  const startAppParam =
    parsed.searchParams.get("startapp") ||
    parsed.searchParams.get("startApp") ||
    parsed.searchParams.get("WebAppStartParam") ||
    parsed.searchParams.get("start_param") ||
    null;

  if (segments.length === 0) {
    return {
      isMax: true,
      kind: "root",
      canonicalUrl: "https://max.ru",
      startPayload: null,
      startAppParam: null,
      targetName: null,
    };
  }

  const firstSegment = segments[0];
  const cleanName = firstSegment.startsWith("@")
    ? firstSegment.slice(1)
    : firstSegment;

  if (cleanName.startsWith(":")) {
    return {
      isMax: true,
      kind: "route",
      targetName: cleanName,
      canonicalUrl: value,
      startPayload,
      startAppParam,
    };
  }

  if (cleanName === 'get-plugin') {
    return {
      isMax: true,
      kind: 'get_plugin',
      pluginId: parsed.searchParams.get('id') || null,
      canonicalUrl: value,
      startPayload: null,
      startAppParam: null,
      targetName: null,
    };
  }

  if (cleanName === 'get-avatar') {
    return {
      isMax: true,
      kind: 'get_avatar',
      avatarId: parsed.searchParams.get('id') || null,
      canonicalUrl: value,
      startPayload: null,
      startAppParam: null,
      targetName: null,
    };
  }

  if (RESERVED_SLUGS.has(cleanName.toLowerCase())) return null;
  if (!VALID_IDENTIFIER_REGEX.test(cleanName)) return null;

  const fullPath = [cleanName, ...segments.slice(1)].join("/");

  return {
    isMax: true,
    kind: startAppParam ? "app" : "entity",
    targetName: cleanName,
    canonicalUrl: `https://max.ru/${fullPath}`,
    startPayload,
    startAppParam,
  };
}

async function isChatAccessible(chatId, api) {
  try {
    const { getChat } = await import("../stores/messages");
    if (getChat(chatId)?.getInfo?.()) return true;
  } catch {}
  try {
    const res = api && typeof api.getChat === "function"
      ? await api.getChat(chatId)
      : await invoke("get_chats", { chatIds: [chatId] });
    return Boolean(res?.chats?.length);
  } catch {
    return false;
  }
}

// Invite links resolve to a chat the user may not be a member of yet. Opening it
// directly fails ("чат закрыт"), so ask first and join, like the official client.
// Returns true when the chat can be opened.
async function ensureChatJoined(chat, link, api) {
  const chatId = chat.id;
  if (await isChatAccessible(chatId, api)) return true;

  const isChannel = chat.type === "CHANNEL";
  const count = chat.participantsCount ?? chat.membersCount ?? null;
  const title = chat.title || (isChannel ? "Канал" : "Чат");
  const { askJoinChat } = await import("../stores/joinPrompt");
  const accepted = await askJoinChat({
    title: isChannel ? "Подписаться на канал?" : "Вступить в чат?",
    message: count ? `${title} · участников: ${count}` : title,
    confirmText: isChannel ? "Подписаться" : "Вступить",
  });
  if (!accepted) return false;

  try {
    const joined = api && typeof api.joinChannel === "function"
      ? await api.joinChannel(link)
      : (await invoke("join_channel", { link }))?.chat;
    if (joined?.id || await isChatAccessible(chatId, api)) return true;
    showAlert("Запрос отправлен", "Если в чате включены заявки, дождитесь одобрения администратора.");
    return false;
  } catch (err) {
    console.error(err);
    showAlert(parseApiError(err));
    return false;
  }
}

export async function processMaxLink(targetUrl, { currentUserId, api, onOpenChat, onLaunchApp } = {}) {
  const info = extractMaxUrlInfo(targetUrl);
  if (!info || !info.isMax) return false;

  let chatOpener = onOpenChat;
  if (!chatOpener) {
    try {
      const session = await import("../stores/session");
      chatOpener = session.openChat;
    } catch {}
  }

  let appOpener = onLaunchApp;
  if (!appOpener) {
    try {
      const webapp = await import("../stores/webapp");
      appOpener = webapp.openMiniApp;
    } catch {}
  }

  if (info.kind === "external_callback") {
    if (api && typeof api.processExternalCallback === "function") {
      try {
        const launch = await api.processExternalCallback(info.canonicalUrl || targetUrl);
        if (launch && typeof appOpener === "function") {
          await appOpener({
            botId: launch.botId,
            title: launch.botId === 8250447 ? "Цифровой ID" : "Мини-приложение",
            url: launch.url,
            startParam: launch.startParam,
            entryPoint: "link",
          });
          return true;
        }
      } catch (err) {
        console.error(err);
      }
    }
    return false;
  }

  if (info.kind === 'get_plugin') {
    if (info.pluginId) {
      try {
        const { handlePluginDeepLink } = await import('../plugins/runtime');
        await handlePluginDeepLink(info.pluginId);
      } catch (err) {
        console.error(err);
      }
    }
    return true;
  }

  if (info.kind === 'get_avatar') {
    if (info.avatarId) {
      try {
        const { goto } = await import("$app/navigation");
        goto(`/settings/profile?avatar=${encodeURIComponent(info.avatarId)}`);
      } catch (err) {
        console.error(err);
      }
    }
    return true;
  }

  if (info.kind === "app") {
    let resolved = null;
    try {
      if (api && typeof api.resolveLink === "function") {
        resolved = await api.resolveLink(info.canonicalUrl);
      } else {
        resolved = await invoke("resolve_link", { link: info.canonicalUrl });
      }
    } catch (err) {
      console.error(err);
    }

    const botId =
      resolved?.user?.contact?.id ||
      resolved?.user?.id ||
      resolved?.chat?.id ||
      null;

    if (botId && typeof appOpener === "function") {
      appOpener({
        botId,
        title: resolved?.chat?.title || resolved?.user?.contact?.names?.[0]?.name || info.targetName,
        startParam: info.startAppParam,
        entryPoint: "link",
      });
      return true;
    }
  }

  if (info.kind === "entity") {
    let resolved = null;
    try {
      if (api && typeof api.resolveLink === "function") {
        resolved = await api.resolveLink(info.canonicalUrl);
      } else {
        resolved = await invoke("resolve_link", { link: info.canonicalUrl });
      }
    } catch (err) {
      console.error(err);
    }

    let targetChatId = null;

    if (resolved?.chat?.id) {
      targetChatId = resolved.chat.id;
    } else if (resolved?.user) {
      const contactId = resolved.user.contact?.id || resolved.user.id;
      if (contactId && currentUserId) {
        targetChatId = Number(BigInt(currentUserId) ^ BigInt(contactId));
      }
    }

    if (targetChatId && resolved?.chat?.id) {
      const proceed = await ensureChatJoined(resolved.chat, info.canonicalUrl, api);
      if (!proceed) return true;
    }

    if (targetChatId) {
      if (info.startPayload !== null && api && typeof api.sendBotStart === "function") {
        try {
          const res = await api.sendBotStart(targetChatId, info.startPayload);
          if (res?.error) {
            showAlert(parseApiError(res));
          } else {
            const msg = res?.message;
            if (msg && typeof msg === "object") {
              const msgCopy = { ...msg, status: 1 };
              try {
                const { getChat } = await import("../stores/messages");
                const c = getChat(targetChatId);
                if (c) {
                  c.receivedMessage?.set(msgCopy);
                  c.updateMessages?.([msgCopy]);
                }
              } catch {}
            }
          }
        } catch (err) {
          console.error(err);
          showAlert(parseApiError(err));
        }
      }

      if (typeof chatOpener === "function") {
        await chatOpener(targetChatId);
      }
      return true;
    }
  }

  return false;
}

export function resolveWebAppUrl(url) {
  if (!url || typeof url !== "string") return url;
  if (!url.startsWith("https://") && !url.startsWith("http://")) return url;
  if (url.startsWith("http://127.0.0.1") || url.startsWith("http://localhost")) return url;
  const hashIndex = url.indexOf("#");
  const base = hashIndex >= 0 ? url.slice(0, hashIndex) : url;
  const hash = hashIndex >= 0 ? url.slice(hashIndex) : "";
  const proxyBase = getWebAppProxyBase();
  return `${proxyBase}/proxy?url=${encodeURIComponent(base)}${hash}`;
}
