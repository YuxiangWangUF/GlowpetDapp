import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import AuthRoot from "./auth/AuthRoot.jsx";
import App from "./App.jsx";
import "./styles.css";

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <AuthRoot>
      <App />
    </AuthRoot>
  </StrictMode>,
);
