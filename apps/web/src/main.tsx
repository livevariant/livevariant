import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router";
import "@fontsource/instrument-serif/400.css";
import "@fontsource/instrument-serif/400-italic.css";
import "./index.css";
import { AppLayout } from "./App.js";
import { Landing } from "./pages/Landing.js";
import { Builder } from "./pages/Builder.js";
import { Terms } from "./pages/Terms.js";
import { Privacy } from "./pages/Privacy.js";
import { Tests } from "./pages/Tests.js";
import { TestDetail } from "./pages/TestDetail.js";
import { Login } from "./pages/Login.js";
import { Settings } from "./pages/Settings.js";
import { AcceptInvitation } from "./pages/AcceptInvitation.js";

const router = createBrowserRouter([
  {
    element: <AppLayout />,
    children: [
      { path: "/", element: <Landing /> },
      { path: "/builder", element: <Builder /> },
      { path: "/tests", element: <Tests /> },
      { path: "/tests/:testId", element: <TestDetail /> },
      // The manage link: the whole test in the URL, the stats secret in
      // its #fragment. Served by the SPA fallback; the old server-side
      // shell is gone and the URL shape is unchanged.
      { path: "/manage/:encoded", element: <TestDetail /> },
      { path: "/login", element: <Login /> },
      { path: "/settings", element: <Settings /> },
      { path: "/terms", element: <Terms /> },
      { path: "/privacy", element: <Privacy /> },
      { path: "/accept-invitation/:id", element: <AcceptInvitation /> }
    ]
  }
]);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>
);
