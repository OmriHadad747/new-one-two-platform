import { useState } from "react";
import { ToggleRow } from "@/components/features/settings/ToggleRow";
import { Button } from "@/components/ui/Button";

export function AppSettingsView() {
  const [active, setActive] = useState(true);
  const [debug, setDebug] = useState(false);

  return (
    <div className="max-w-[560px]">
      <div className="bg-white/[0.03] border border-white/7 rounded-xl overflow-hidden mb-5">
        <ToggleRow
          title="App Status"
          sub="Controls whether this widget renders on your storefront"
          checked={active}
          onChange={setActive}
        />
        <ToggleRow
          title="Debug Mode"
          sub="Logs host API calls to the browser console"
          checked={debug}
          onChange={setDebug}
          last
        />
      </div>
      <Button variant="danger">🗑 Delete App</Button>
    </div>
  );
}
