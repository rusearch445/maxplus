import { writable, get } from "svelte/store";

// Pending "join this chat?" question, rendered by +layout.svelte.
// Shape: { title, message, confirmText, resolve } or null.
export const joinPrompt = writable(null);

export function askJoinChat({ title, message, confirmText = "Вступить" }) {
  const previous = get(joinPrompt);
  if (previous?.resolve) previous.resolve(false);

  return new Promise((resolve) => {
    joinPrompt.set({
      title,
      message,
      confirmText,
      resolve: (answer) => {
        joinPrompt.set(null);
        resolve(Boolean(answer));
      },
    });
  });
}
