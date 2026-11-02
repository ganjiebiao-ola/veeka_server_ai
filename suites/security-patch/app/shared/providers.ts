import providers from "./providers.json";

type Provider = {
  label: string;
  driver: string;
  transport: string;
  canFix: boolean;
  models: Array<{ value: string; label: string; disabled?: boolean }>;
  efforts: string[];
  defaultModel: string;
  defaultEffort: string;
  command: string[];
  auth: string;
  modes: Record<string, string>;
  unavailableReason: string;
};

export const PROVIDERS: Record<keyof typeof providers, Provider> = providers;
export type ProviderId = keyof typeof PROVIDERS;
