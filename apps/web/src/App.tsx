import { Link, NavLink, Outlet } from "react-router";
import { FlaskConical } from "lucide-react";
import { cn } from "@/lib/utils";

export function AppLayout() {
  const navClass = ({ isActive }: { isActive: boolean }) =>
    cn(
      "text-sm transition-colors hover:text-foreground",
      isActive ? "text-foreground font-medium" : "text-muted-foreground"
    );
  return (
    <div className="min-h-screen">
      <header className="border-b">
        <div className="mx-auto flex h-14 max-w-5xl items-center gap-6 px-4">
          <Link to="/" className="flex items-center gap-2 font-semibold">
            <FlaskConical className="size-5" />
            LiveVariant
          </Link>
          <nav className="flex items-center gap-4">
            <NavLink to="/builder" className={navClass}>
              Create a test
            </NavLink>
            <NavLink to="/tests" className={navClass}>
              My tests
            </NavLink>
          </nav>
          <div className="ml-auto">
            <a
              href="https://github.com/livevariant/livevariant"
              className="text-sm text-muted-foreground hover:text-foreground"
            >
              GitHub
            </a>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-4 py-10">
        <Outlet />
      </main>
      <footer className="border-t">
        <div className="mx-auto max-w-5xl px-4 py-6 text-sm text-muted-foreground">
          Open source (AGPL-3.0). Your tests live in your browser and your URLs;
          the server never stores variant content, raw user ids, or raw context.
        </div>
      </footer>
    </div>
  );
}
