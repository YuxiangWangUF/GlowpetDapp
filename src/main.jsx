import { captureClaimBootstrap } from "./claim-bootstrap.js";

// Capture and scrub a charm credential before loading the sign-in SDK or any
// other third-party code. The credential then lives only in this page's memory.
captureClaimBootstrap();

import("./main-app.jsx");
