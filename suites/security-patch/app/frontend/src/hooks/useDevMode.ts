import { useEffect, useState } from "react";

export function useDevMode(): boolean {
  const [dev, setDev] = useState(false);
  useEffect(() => {
    let alive = true;
    fetch("/api/health").then(r => r.ok ? r.json() : null)
      .then(data => { if (alive) setDev(data?.dev === true); }).catch(() => {});
    return () => { alive = false; };
  }, []);
  return dev;
}
