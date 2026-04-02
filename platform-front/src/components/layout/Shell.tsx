import { Outlet } from "react-router";
import { Sidebar } from "./Sidebar";

export function Shell() {
  return (
    <div className="flex h-full overflow-hidden bg-base">
      <Sidebar />
      <div className="flex-1 flex flex-col overflow-hidden min-w-0">
        <Outlet />
      </div>
    </div>
  );
}
