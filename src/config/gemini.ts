import { GoogleGenAI } from "@google/genai";
import { logger } from "../utils/logger";

interface GeminiKey {
  name: string;
  apiKey: string;
}

class GeminiClient {
  private clients: { name: string; ai: GoogleGenAI }[];
  private currentIndex = 0;

  constructor() {
    const raw = process.env.GEMINI_API_KEYS || "";
    const pairSeparator = "__SPLIT__";

    const keys: GeminiKey[] = raw
      .split(",")
      .map((entry: string) => entry.trim())
      .filter((entry: string) => entry.length > 0)
      .map((entry: string): GeminiKey | null => {
        const separatorIndex = entry.indexOf(pairSeparator);
        if (separatorIndex < 0) {
          logger.warn(`[Gemini] Skipping malformed key entry: missing "${pairSeparator}" separator`);
          return null;
        }

        const name = entry.slice(0, separatorIndex).trim();
        const apiKey = entry.slice(separatorIndex + pairSeparator.length).trim();
        if (!name || !apiKey) {
          logger.warn("[Gemini] Skipping malformed key entry: empty name or apiKey");
          return null;
        }

        return { name, apiKey };
      })
      .filter((k: GeminiKey | null): k is GeminiKey => k !== null);

    if (keys.length === 0) {
      throw new Error(`No Gemini API keys configured. Set GEMINI_API_KEYS using NAME${pairSeparator}APIKEY,NAME${pairSeparator}APIKEY format`);
    }

    this.clients = keys.map((k) => ({
      name: k.name,
      ai: new GoogleGenAI({ apiKey: k.apiKey }),
    }));

    logger.info(`✓ Gemini initialized with ${this.clients.length} key(s): ${this.clients.map((c) => c.name).join(", ")}`);
  }

  async generate(prompt: string, systemInstruction: string): Promise<string | null> {
    const maxRetries = 5;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const client = this.clients[this.currentIndex]!;
      this.currentIndex = (this.currentIndex + 1) % this.clients.length;

      logger.info(`[Gemini] Using key: ${client.name} (attempt ${attempt}/${maxRetries})`);

      try {
        const response = await client.ai.models.generateContent({
          model: "gemini-2.5-flash",
          contents: prompt,
          config: { systemInstruction },
        });

        return response.text || null;
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        const is503 = message.includes("503") || message.includes("UNAVAILABLE") || message.includes("high demand");
        const is429 = message.includes("429") || message.includes("RESOURCE_EXHAUSTED") || message.includes("rate limit");

        if ((is503 || is429) && attempt < maxRetries) {
          const waitSec = attempt * 5;
          logger.warn(`[Gemini] ${is503 ? "503 overloaded" : "429 rate limited"} — retrying in ${waitSec}s (attempt ${attempt}/${maxRetries})`);
          await new Promise((r) => setTimeout(r, waitSec * 1000));
          continue;
        }

        throw error;
      }
    }

    return null;
  }
}

let instance: GeminiClient | null = null;

export function getGemini(): GeminiClient {
  if (!instance) instance = new GeminiClient();
  return instance;
}
