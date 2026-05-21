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
  return value === "openai" || value === "deepseek";
}

export function inferProviderForModel(model: ModelId | null): ProviderId | undefined {
  if (!model) return undefined;
  const lowered = model.trim().toLowerCase();
  if (lowered in DEEPSEEK_ALIASES || lowered.startsWith("deepseek-")) return "deepseek";
  return undefined;
}

export function normalizeModelForProvider(provider: ProviderId | null, model: string): ModelId {
  const trimmed = model.trim();
  const lowered = trimmed.toLowerCase();
  if (provider === "deepseek" || provider === null) {
    const deepseek = DEEPSEEK_ALIASES[lowered];
    if (deepseek) return deepseek;
  }
  return trimmed;
}

export function parseModelSpecifier(spec: string): ModelSelection {
  const trimmed = spec.trim();
  if (!trimmed) {
    throw new Error("--model requires a non-empty value");
  }

  const slash = trimmed.indexOf("/");
  if (slash !== -1) {
    const providerPart = trimmed.slice(0, slash).trim().toLowerCase();
    const modelPart = trimmed.slice(slash + 1).trim();
    if (!isProviderId(providerPart)) {
      throw new Error(`Unknown provider in model spec: ${providerPart}`);
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
  const deepseek = DEEPSEEK_ALIASES[lowered];
  if (deepseek) {
    return { provider: "deepseek", model: deepseek };
  }

  return { provider: null, model: trimmed };
}
