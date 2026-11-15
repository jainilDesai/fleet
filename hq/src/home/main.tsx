import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Home } from "./Home";
import "../index.css";
import { applyFont, savedFont } from "../theme/fonts";

applyFont(savedFont());

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <Home />
  </StrictMode>,
);
