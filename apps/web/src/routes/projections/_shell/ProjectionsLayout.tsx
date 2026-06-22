// apps/web/src/routes/projections/_shell/ProjectionsLayout.tsx

import { NavLink, Outlet, useLocation } from "react-router-dom";
import { projections } from "./projectionRegistry";

export function ProjectionsLayout() {
  const location = useLocation();
  const onIndex =
    location.pathname === "/projections" || location.pathname === "/projections/";

  return (
    <div className="flex flex-col gap-4">
      <header className="flex items-center gap-3 border-b border-stone-200 pb-3">
        <NavLink
          to="/projections"
          end
          className={({ isActive }) =>
            `text-sm font-semibold ${isActive ? "text-stone-900" : "text-stone-700 hover:text-stone-900"}`
          }
        >
          Projections
        </NavLink>
        {!onIndex && (
          <>
            <span className="text-stone-400">/</span>
            <nav className="flex items-center gap-2 text-sm">
              {projections.map((p, i) => (
                <span key={p.slug} className="flex items-center gap-2">
                  {i > 0 && <span className="text-stone-300">·</span>}
                  <NavLink
                    to={`/projections/${p.slug}`}
                    className={({ isActive }) =>
                      isActive
                        ? "font-semibold text-stone-900"
                        : "text-stone-500 hover:text-stone-700"
                    }
                  >
                    {p.title}
                  </NavLink>
                </span>
              ))}
            </nav>
          </>
        )}
        <div id="projection-toolbar" className="ml-auto" />
      </header>
      <Outlet />
    </div>
  );
}
