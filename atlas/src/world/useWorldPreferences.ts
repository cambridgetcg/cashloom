import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY = "cashloom.world.preferences.v1";

export const BASE_CURRENCIES = ["USD", "EUR", "GBP", "JPY", "CHF", "CAD", "AUD", "CNY"] as const;

export type BaseCurrency = (typeof BASE_CURRENCIES)[number];

interface WorldPreferences {
  baseCurrency: BaseCurrency;
  watched: string[];
  watchOnly: boolean;
}

const defaults: WorldPreferences = {
  baseCurrency: "USD",
  watched: [],
  watchOnly: false,
};

function readPreferences(): WorldPreferences {
  if (typeof window === "undefined") return defaults;
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "null");
    if (!parsed || typeof parsed !== "object") return defaults;
    const candidate = parsed as Partial<WorldPreferences>;
    const baseCurrency = BASE_CURRENCIES.includes(candidate.baseCurrency as BaseCurrency)
      ? (candidate.baseCurrency as BaseCurrency)
      : defaults.baseCurrency;
    const watched = Array.isArray(candidate.watched)
      ? candidate.watched.filter((item): item is string => typeof item === "string").slice(0, 200)
      : [];
    return { baseCurrency, watched, watchOnly: candidate.watchOnly === true };
  } catch {
    return defaults;
  }
}

export function useWorldPreferences() {
  const [preferences, setPreferences] = useState<WorldPreferences>(readPreferences);

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
    } catch {
      // Private browsing and embedded webviews may decline local storage.
    }
  }, [preferences]);

  const setBaseCurrency = useCallback((baseCurrency: BaseCurrency) => {
    setPreferences((current) => ({ ...current, baseCurrency }));
  }, []);

  const toggleWatched = useCallback((id: string) => {
    setPreferences((current) => ({
      ...current,
      watched: current.watched.includes(id)
        ? current.watched.filter((item) => item !== id)
        : [...current.watched, id],
    }));
  }, []);

  const toggleWatchOnly = useCallback(() => {
    setPreferences((current) => ({ ...current, watchOnly: !current.watchOnly }));
  }, []);

  return {
    ...preferences,
    setBaseCurrency,
    toggleWatched,
    toggleWatchOnly,
  };
}
