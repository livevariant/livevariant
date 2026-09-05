import { useEffect, useState } from "react";
import { Link, NavLink, Outlet } from "react-router";
import { LogOut, Moon, Sun, User } from "lucide-react";
import { Button } from "@/components/ui/button";
import { OrgSwitcher } from "@/components/OrgSwitcher";
import { hostedPoliciesApply } from "@/lib/policies";
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
      {/* Wraps to a second row on phones instead of overflowing the
          viewport; nothing is hidden behind a menu. */}
      <header className="mx-auto flex min-h-16 w-full max-w-6xl flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2 sm:flex-nowrap sm:gap-6 sm:px-6 sm:py-0">
        <Link to="/" className="font-display flex items-center gap-2 text-2xl">
          {/* Decorative next to the wordmark, so no alt text; the pair
              switches with the site's own theme toggle, which a CSS
              media query cannot see. */}
          <img
            src={theme === "dark" ? "/logo-dark.svg" : "/logo-light.svg"}
            alt=""
            aria-hidden="true"
            className="h-5 w-auto"
          />
          LiveVariant
        </Link>
        <nav className="flex items-center gap-3 sm:gap-4">
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
        <nav className="ml-auto flex items-center gap-3 text-sm sm:gap-5">
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
          {/* The footer repeats this link, so phones lose no path. */}
          <Button variant="outline" className="hidden sm:inline-flex" asChild>
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
          <span>
            AGPL open source.{" "}
            <a
              className="underline transition-colors hover:text-foreground"
              href="https://deploy.workers.cloudflare.com/?url=https://github.com/livevariant/livevariant"
            >
              Deploy your own
            </a>{" "}
            on Cloudflare in one click.
          </span>
          {hostedPoliciesApply() && (
            <>
              {/* The agent colony is livevariant.com's, like the policies:
                  a self-hosted dashboard has no reason to point at it. */}
              <span aria-hidden="true">·</span>
              <a
                className="underline transition-colors hover:text-foreground"
                href="https://livevariant.ai"
              >
                Agents growing LiveVariant
              </a>
              <span aria-hidden="true">·</span>
              <Link
                className="underline transition-colors hover:text-foreground"
                to="/terms"
              >
                Terms
              </Link>
              <Link
                className="underline transition-colors hover:text-foreground"
                to="/privacy"
              >
                Privacy
              </Link>
            </>
          )}
        </div>
      </footer>
    </div>
  );
}
