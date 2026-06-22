import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useEffect } from "react";
import { PrivacyBanner, usePrivacy } from "./lib/privacy";
import { useSummary } from "./lib/queries";
import { isOnboarded, shouldOnboard } from "./lib/onboarding";

const navItems = [
  { to: "/", label: "Overview", end: true },
  { to: "/transactions", label: "Transactions" },
  { to: "/spending", label: "Spending" },
  { to: "/bundles", label: "Bundles" },
  { to: "/goals", label: "Goals" },
  { to: "/debt", label: "Debt" },
  { to: "/investments", label: "Investments" },
  { to: "/settings", label: "Settings" },
  { to: "/projections", label: "Projections" },
];

export function App() {
  const summary = useSummary().data;
  const location = useLocation();
  const navigate = useNavigate();
  useEffect(() => {
    if (summary && shouldOnboard(summary.counts.accounts, isOnboarded(), location.pathname)) {
      navigate("/welcome", { replace: true });
    }
  }, [summary, location.pathname, navigate]);

  return (
    <div className="flex h-full min-h-screen flex-col">
      <PrivacyBanner />
      <div className="flex flex-1 min-h-0">
        <aside className="flex w-56 flex-col border-r border-stone-200 bg-white p-5">
          <div className="mb-8 text-sm font-semibold uppercase tracking-wider text-stone-500">
            Finance
          </div>
          <nav className="flex flex-col gap-1">
            {navItems.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  `rounded px-3 py-1.5 text-sm transition-colors ${
                    isActive
                      ? "bg-stone-900 text-white"
                      : "text-stone-700 hover:bg-stone-100"
                  }`
                }
              >
                {item.label}
              </NavLink>
            ))}
          </nav>
          <div className="mt-auto pt-6">
            <PrivacySwitcher />
          </div>
        </aside>
        <main className="flex min-h-0 flex-1 flex-col overflow-auto p-8">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

function PrivacySwitcher() {
  const { enabled, toggle } = usePrivacy();
  return (
    <button
      type="button"
      onClick={toggle}
      className={`w-full rounded-md border px-3 py-2 text-xs font-medium transition-colors ${
        enabled
          ? "border-amber-300 bg-amber-50 text-amber-800 hover:bg-amber-100"
          : "border-stone-200 bg-white text-stone-600 hover:bg-stone-50"
      }`}
    >
      {enabled ? "Privacy: ON" : "Privacy: off"}
    </button>
  );
}
