import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router";
import "@fontsource/instrument-serif/400.css";
import "@fontsource/instrument-serif/400-italic.css";
import "./index.css";
import { AppLayout } from "./App.js";
import { Landing } from "./pages/Landing.js";
import { Builder } from "./pages/Builder.js";
import { Tests } from "./pages/Tests.js";
import { TestDetail } from "./pages/TestDetail.js";

const router = createBrowserRouter([
  {
    element: <AppLayout />,
    children: [
      { path: "/", element: <Landing /> },
      { path: "/builder", element: <Builder /> },
      { path: "/tests", element: <Tests /> },
      { path: "/tests/:testId", element: <TestDetail /> }
    ]
  }
]);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>
);
