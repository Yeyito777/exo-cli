import type { ModelId, ProviderId } from "./shared/protocol";

export interface ModelSelection {
  provider: ProviderId | null;
  model: ModelId | null;
}

const DEEPSEEK_ALIASES: Record<string, ModelId> = {
  pro: "deepseek-v4-pro",
  "v4-pro": "deepseek-v4-pro",
  "deepseek-v4-pro": "deepseek-v4-pro",
  flash: "deepseek-v4-flash",
  "v4-flash": "deepseek-v4-flash",
  "deepseek-v4-flash": "deepseek-v4-flash",
};

export function isProviderId(value: string): value is ProviderId {
  return value === "openai" || value === "deepseek" || value === "opencode" || value === "openrouter";
}

export function inferProviderForModel(model: ModelId | null): ProviderId | undefined {
  if (!model) return undefined;
  const lowered = model.trim().toLowerCase();
  if (Object.hasOwn(DEEPSEEK_ALIASES, lowered) || lowered.startsWith("deepseek-")) return "deepseek";
  return undefined;
}

export function normalizeModelForProvider(provider: ProviderId | null, model: string): ModelId {
  const trimmed = model.trim();
  if (!trimmed) throw new Error("--model requires a non-empty value");
  const lowered = trimmed.toLowerCase();
  if (provider === "deepseek" || provider === null) {
    const deepseek = Object.hasOwn(DEEPSEEK_ALIASES, lowered) ? DEEPSEEK_ALIASES[lowered] : undefined;
    if (deepseek) return deepseek;
  }
  return trimmed;
}

export function parseModelSpecifier(spec: string, explicitProvider: ProviderId | null = null): ModelSelection {
  const trimmed = spec.trim();
  if (!trimmed) {
    throw new Error("--model requires a non-empty value");
  }

  const slash = trimmed.indexOf("/");
  if (slash !== -1) {
    const providerPart = trimmed.slice(0, slash).trim().toLowerCase();
    const modelPart = trimmed.slice(slash + 1).trim();
    if (!isProviderId(providerPart)) {
      // OpenRouter/OpenCode custom IDs can themselves contain a namespace slash.
      if (explicitProvider === "openrouter" || explicitProvider === "opencode") {
        return { provider: explicitProvider, model: trimmed };
      }
      throw new Error(`Unknown provider in model spec: ${providerPart}`);
    }
    if (explicitProvider && explicitProvider !== providerPart) {
      throw new Error(`Provider ${explicitProvider} conflicts with model spec provider ${providerPart}`);
    }
    if (!modelPart) {
      throw new Error(`Missing model name after provider in --model ${JSON.stringify(spec)}`);
    }
    return {
      provider: providerPart,
      model: normalizeModelForProvider(providerPart, modelPart),
    };
  }

  const lowered = trimmed.toLowerCase();
  const deepseek = (explicitProvider === null || explicitProvider === "deepseek") && Object.hasOwn(DEEPSEEK_ALIASES, lowered) ? DEEPSEEK_ALIASES[lowered] : undefined;
  if (deepseek) {
    return { provider: "deepseek", model: deepseek };
  }

  return { provider: explicitProvider, model: trimmed };
}
