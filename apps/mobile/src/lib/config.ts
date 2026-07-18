// The Ctrl+ArcZ backend base URL (the @ctrl-arcz/api service). Override with
// EXPO_PUBLIC_API_BASE for local development, e.g. http://192.168.1.10:8788 for a
// device on your LAN talking to a locally running api.
export const API_BASE = process.env.EXPO_PUBLIC_API_BASE ?? 'https://api.ctrlarcz.xyz';
