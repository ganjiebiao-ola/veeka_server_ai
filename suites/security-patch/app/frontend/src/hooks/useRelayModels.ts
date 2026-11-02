import { useEffect, useState } from "react";
import type { RelayModels } from "../types/events";

export function useRelayModels(): RelayModels {
  const [relay, setRelay] = useState<RelayModels>({ configured: false, models: [] });
  useEffect(() => {
    let alive = true;
    fetch("/api/relay/models")
      .then(async (r) => {
        const data = await r.json() as RelayModels;
        if (alive) setRelay({ configured: Boolean(data.configured), models: data.models ?? [], error: data.error });
      })
      .catch(() => {});
    return () => { alive = false; };
  }, []);
  return relay;
}
