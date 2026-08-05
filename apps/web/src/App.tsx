import { useEffect, useState } from "react";
import { Link, NavLink, Outlet } from "react-router";
import { LogOut, Moon, Sun, User } from "lucide-react";
import { Button } from "@/components/ui/button";
import { OrgSwitcher } from "@/components/OrgSwitcher";
import { signOut, useAccount } from "@/lib/account";
import { useGoogleTagManager } from "@/lib/gtm";
import { useDeploymentConfig } from "@/lib/serve-url";
import { cn } from "@/lib/utils";

type Theme = "dark" | "light";

/**
 * Theme = the visitor's OS preference until they choose; a choice is
 * stored and wins from then on. The tiny script in index.html applies
 * the same logic before hydration so there is no flash.
 */
function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(() => {
    const stored = localStorage.getItem("lv-theme");
    if (stored === "dark" || stored === "light") {
      return stored;
    }
    return window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  });
  useEffect(() => {
    // Follow OS changes only while the visitor has not chosen.
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      if (!localStorage.getItem("lv-theme")) {
        setTheme(mq.matches ? "dark" : "light");
      }
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  useEffect(() => {
    document.documentElement.style.backgroundColor =
      theme === "dark" ? "#0a0a0a" : "#f6f1e7";
  }, [theme]);
  const toggle = () => {
    setTheme(current => {
      const next = current === "dark" ? "light" : "dark";
      localStorage.setItem("lv-theme", next);
      return next;
    });
  };
  return [theme, toggle];
}

/**
 * One shell for every page, landing included: the midnight theme
 * (DESIGN.md), the serif wordmark, app navigation on the left, project
 * links on the right, and the AGPL footer. Pages only render content.
 */
export function AppLayout() {
  const [theme, toggleTheme] = useTheme();
  const account = useAccount();
  const deployment = useDeploymentConfig();
  useGoogleTagManager(deployment.gtmId);
  const navClass = ({ isActive }: { isActive: boolean }) =>
    cn(
      "text-sm transition-colors hover:text-foreground",
      isActive ? "text-foreground" : "text-muted-foreground"
    );
  return (
    <div
      className={cn(
        theme === "dark" ? "midnight" : "daylight",
        "flex min-h-screen flex-col font-sans"
      )}
    >
      <header className="mx-auto flex h-16 w-full max-w-6xl items-center gap-6 px-6">
        <Link to="/" className="font-display text-2xl">
          LiveVariant
        </Link>
        <nav className="flex items-center gap-4">
          <NavLink to="/builder" className={navClass}>
            Create a test
          </NavLink>
          <NavLink to="/tests" className={navClass}>
            My tests
          </NavLink>
          {account.ready && account.available && account.me && (
            <NavLink to="/settings" className={navClass}>
              Settings
            </NavLink>
          )}
        </nav>
        <nav className="ml-auto flex items-center gap-5 text-sm">
          <a
            href="https://github.com/livevariant/livevariant"
            className="text-muted-foreground transition-colors hover:text-foreground"
          >
            GitHub
          </a>
          <a
            href="https://github.com/livevariant/livevariant#readme"
            className="text-muted-foreground transition-colors hover:text-foreground"
          >
            Docs
          </a>
          <Button
            variant="ghost"
            size="icon"
            aria-label={
              theme === "dark"
                ? "Switch to light theme"
                : "Switch to dark theme"
            }
            className="text-muted-foreground hover:text-foreground"
            onClick={toggleTheme}
          >
            {theme === "dark" ? <Sun /> : <Moon />}
          </Button>
          <OrgSwitcher account={account} />
          {/* Account controls exist only on deployments that have the
              module; a plain self-host renders neither button. */}
          {account.ready &&
            account.available &&
            (account.me ? (
              <Button
                variant="ghost"
                size="icon"
                aria-label="Sign out"
                className="text-muted-foreground hover:text-foreground"
                onClick={() => {
                  void signOut().then(() => account.refresh());
                }}
              >
                <LogOut />
              </Button>
            ) : (
              <Button variant="ghost" asChild>
                <Link to="/login">
                  <User /> Sign in
                </Link>
              </Button>
            ))}
          <Button variant="outline" asChild>
            <a href="https://deploy.workers.cloudflare.com/?url=https://github.com/livevariant/livevariant">
              Deploy your own
            </a>
          </Button>
        </nav>
      </header>
      <main className="mx-auto w-full max-w-6xl flex-1 px-6">
        <Outlet />
      </main>
      <footer className="border-t border-border">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-center gap-x-2 gap-y-1 px-6 py-8 text-sm text-muted-foreground">
          <span>AGPL open source.</span>
          <a
            className="underline transition-colors hover:text-foreground"
            href="https://deploy.workers.cloudflare.com/?url=https://github.com/livevariant/livevariant"
          >
            Deploy your own
          </a>
          <span>on Cloudflare in one click.</span>
        </div>
      </footer>
    </div>
  );
}
