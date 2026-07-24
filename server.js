const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const bodyParser = require("body-parser");
const authRoutes = require("./routes/authRoutes");
const leadRoutes = require("./routes/leadRoutes");
const meetingRoutes = require("./routes/meetingRoutes");
const customFieldRoutes = require("./routes/customFieldRoutes");
const leadFieldRoutes = require("./routes/leadFieldRoutes");
const userRoutes = require("./routes/userRoutes");
const emailRoutes = require("./routes/emailRoutes");
const workOrderRoutes = require("./routes/workOrderRoute");
// const workOrderItemsRoutes = require('./routes/workOrderItemsRoutes');
const productRoutes = require("./routes/productRoutes");
const quotationRoutes = require("./routes/quotationRoutes");
const contactsRoutes = require("./routes/contactsRoutes");
const companyRoutes = require("./routes/companyRoutes");
const quotationSettingsRoutes = require("./routes/quotationSettingsRoutes");
const settingsRoutes = require("./routes/settingsRoutes");
const activityRoutes = require("./routes/activityRoutes");
const notesRoutes = require("./routes/notesRoutes");
const filesRoutes = require("./routes/filesRoutes");
const uploadRoutes = require("./routes/upload.routes");
const invoiceRoutes = require("./routes/invoiceRoutes");
const invoiceSettingsRoutes = require("./routes/invoiceSettingsRoutes");
const kotRoutes = require("./routes/kotRoutes");
const kotSettingsRoutes = require("./routes/kotSettingsRoutes");
const deliveryRoutes = require("./routes/deliveryRoutes");
const couponRoutes = require("./routes/couponRoutes");
const reportRoutes = require("./routes/reportRoutes");
const roleRoutes = require("./routes/roleRoutes");
const paymentReminderRoutes = require("./routes/paymentReminderRoutes");
const orderFeedbackRoutes = require("./routes/orderFeedbackRoutes");
const notificationRoutes = require("./routes/notificationRoutes");
const {
  startPaymentReminderScheduler,
} = require("./services/paymentReminderScheduler");
const {
  startOrderFeedbackScheduler,
} = require("./services/orderFeedbackScheduler");
const { apiPublicRouter, publicRouter } = require("./routes/public");
const whatsappNotifinoRoutes = require("./routes/whatsappNotifinoRoutes");
const paymentRoutes = require("./routes/paymentRoutes");
const { handleRazorpayWebhook } = require("./controllers/paymentController");
const proformaInvoiceRoutes = require("./routes/proformaInvoiceRoutes");
const customerRoutes = require("./routes/customerRoutes");
const vendorRoutes = require("./routes/vendorRoutes");
const passbookRoutes = require("./routes/passbookRoutes");
const {
  isRazorpayEnabled,
  isWhatsAppEnabled,
} = require("./config/featureFlags");

const cookieParser = require("cookie-parser");
const path = require("path");
const fs = require("fs");
const swaggerUi = require("swagger-ui-express");

// Load environment variables
dotenv.config();

const app = express();

// Default allowlist for CORS
const allowedOrigins = [
  "http://localhost:3000",
  "http://localhost:4000",
  "http://localhost:5000",

  "https://erp.pavilionelectronics.com",
  "https://pavilionelectronics.com",
];

// Extend allowlist from env var ALLOWED_ORIGINS (comma-separated)
// Example: ALLOWED_ORIGINS="https://crm.jdhcaterers.com,https://app.example.com"
if (process.env.ALLOWED_ORIGINS) {
  try {
    const fromEnv = String(process.env.ALLOWED_ORIGINS)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    for (const o of fromEnv) {
      if (!allowedOrigins.includes(o)) allowedOrigins.push(o);
    }
    console.log("CORS: loaded ALLOWED_ORIGINS from env:", fromEnv);
  } catch (e) {
    console.warn(
      "CORS: failed to parse ALLOWED_ORIGINS env var",
      e && e.message,
    );
  }
}

// If the allowlist includes '*', treat as allow-all
const allowAnyOrigin = allowedOrigins.includes("*");

// Middleware

// Ensure preflight responses always include CORS headers so browsers don't block OPTIONS
// app.use((req, res, next) => {
//   const origin = req.headers.origin;
//   const allowOrigin = (!origin) ? '*' : (allowedOrigins.includes(origin) ? origin : null);

//   if (allowOrigin) {
//     res.setHeader('Access-Control-Allow-Origin', allowOrigin);
//     res.setHeader('Access-Control-Allow-Credentials', 'true');
//     res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
//     res.setHeader('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
//   }

//   // quick response for preflight
//   if (req.method === 'OPTIONS') {
//     return res.sendStatus(204);
//   }

//   next();
// });

// Keep explicit CORS middleware for runtime checks and credential handling
app.use(
  cors({
    origin: function (origin, callback) {
      // allow all when explicitly configured
      if (allowAnyOrigin) return callback(null, true);
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) return callback(null, true);
      // Reject unknown origins without throwing an exception so the server
      // stays up and returns a controlled CORS failure to browsers.
      console.warn("CORS blocked origin:", origin);
      return callback(null, false);
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    exposedHeaders: ["Content-Disposition"], 
  }),
);

app.options("*", cors());

// Fallback CORS middleware: ensure preflight and other responses always
// include the necessary CORS headers even in edge cases (proxies, errors).
app.use((req, res, next) => {
  const origin = req.headers.origin;
  const allowOrigin = !origin
    ? "*"
    : allowedOrigins.includes(origin)
      ? origin
      : null;
  if (allowOrigin) {
    res.setHeader("Access-Control-Allow-Origin", allowOrigin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader(
      "Access-Control-Allow-Methods",
      "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    );
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Origin, X-Requested-With, Content-Type, Accept, Authorization",
    );
  }

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  next();
});

app.use(
  bodyParser.json({
    limit: "10mb",
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  }),
);
app.use(cookieParser());

// Keep Razorpay webhook explicitly public at the app level.
if (isRazorpayEnabled()) {
  app.get("/api/razorpay/webhook-health", (req, res) => {
    return res.status(200).json({
      ok: true,
      route: "/api/razorpay/webhook",
      ts: new Date().toISOString(),
    });
  });
  app.post("/api/razorpay/webhook", handleRazorpayWebhook);
}

app.use("/api/public", apiPublicRouter);
app.use("/public", publicRouter);
if (isWhatsAppEnabled()) {
  app.use("/api/whatsapp", whatsappNotifinoRoutes);
}

// Routes
// Notification routes should be available to authenticated users (not admin-only).
app.use("/auth", authRoutes);
app.use("/api", notificationRoutes);
app.use("/api", leadRoutes); // For lead management routes
app.use("/api", customFieldRoutes);
app.use("/api", leadFieldRoutes);
app.use("/api/meetings", meetingRoutes); // For Meeting Routes
app.use("/api", userRoutes);
app.use("/api", emailRoutes);
app.use("/api", workOrderRoutes); // For work
// app.use('/api', workOrderItemsRoutes);
app.use("/api", productRoutes); // For product routes
app.use("/api", quotationRoutes); // For product routes
// Default route for health check
app.use("/api", contactsRoutes);
app.use("/api", companyRoutes);

app.use("/api", proformaInvoiceRoutes);
app.use("/api", quotationSettingsRoutes);
app.use("/api", settingsRoutes);

app.use("/api", activityRoutes);
app.use("/api", notesRoutes);
app.use("/api", filesRoutes);
app.use("/api", uploadRoutes);
app.use("/api", invoiceRoutes);
app.use("/api", invoiceSettingsRoutes);
app.use("/api", kotRoutes);
app.use("/api", kotSettingsRoutes);
app.use("/api/deliveries", deliveryRoutes);
app.use("/api/reports", reportRoutes);
app.use("/api", couponRoutes);
app.use("/api", roleRoutes);
app.use("/api/customers", customerRoutes);
app.use("/api", vendorRoutes);
app.use("/api", passbookRoutes);
app.use("/api", paymentReminderRoutes);
app.use("/api", orderFeedbackRoutes);
if (isRazorpayEnabled()) {
  app.use("/payment", paymentRoutes);
  app.use("/api/razorpay", paymentRoutes);
}

app.get("/", (req, res) => {
  res.json({ message: "API is running" });
});

// Serve uploaded files from the configured uploads directory.
// The uploads directory is configurable via the `UPLOADS_DIR` env var.
try {
  const uploadMiddleware = require("./middleware/upload");
  const serveUploadsPath =
    uploadMiddleware.baseUploads || path.join(__dirname, "uploads");
  console.log("Serving uploads from (configured):", serveUploadsPath);
  app.use("/uploads", express.static(serveUploadsPath));
} catch (e) {
  // Fallback to the repo-local uploads folder
  const fallback = path.join(__dirname, "uploads");
  if (!fs.existsSync(fallback)) fs.mkdirSync(fallback, { recursive: true });
  console.log("Serving uploads from (fallback):", fallback);
  app.use("/uploads", express.static(fallback));
}

console.log("Server setup complete, routes registered.");

// Dynamically generate a minimal OpenAPI spec from registered Express routes
const generateOpenAPISpec = () => {
  const paths = {};

  const regexpToPath = (regexp) => {
    if (!regexp) return "";
    let s = regexp.source;
    s = s.replace("\\/?(?=\\/|$)", "");
    s = s.replace("(?=\\/|$)", "");
    s = s.replace("^", "").replace("$", "");
    s = s.replace(/\\\//g, "/");
    // replace unnamed capture groups with :param
    s = s.replace(/\(\?:\^?\\?\w\+\)/g, ":param");
    return s;
  };

  const traverse = (stack, prefix = "") => {
    stack.forEach((layer) => {
      if (layer.route && layer.route.path) {
        const routePath = (prefix + layer.route.path).replace(/\\/g, "");
        const cleanPath = routePath.replace(/\\/g, "").replace(/\/\/+/, "/");
        const methods = Object.keys(layer.route.methods || {});
        if (!paths[cleanPath]) paths[cleanPath] = {};

        // derive tag from the first meaningful path segment
        const tag = (
          cleanPath.split("/").filter(Boolean)[0] || "general"
        ).replace(/[^a-zA-Z0-9_-]/g, "");

        // detect path params like :id
        const pathParams = [];
        const paramMatches = cleanPath.match(/:([a-zA-Z0-9_]+)/g) || [];
        paramMatches.forEach((p) => {
          const name = p.replace(":", "");
          pathParams.push({
            name,
            in: "path",
            required: true,
            schema: { type: "string" },
            description: `${name} (path parameter)`,
          });
        });

        methods.forEach((m) => {
          const operation = {
            tags: [tag],
            summary: `Auto-generated ${m.toUpperCase()} ${cleanPath}`,
            operationId: `${m}_${cleanPath.replace(/[^a-zA-Z0-9]/g, "_")}`,
            parameters: [...pathParams],
            responses: {
              200: { description: "Success" },
              400: { description: "Bad Request" },
              401: { description: "Unauthorized" },
              404: { description: "Not Found" },
              500: { description: "Server Error" },
            },
          };

          // add common query params for GET-like operations
          if (["get", "delete"].includes(m)) {
            operation.parameters.push({
              name: "page",
              in: "query",
              schema: { type: "integer" },
              required: false,
              description: "Page number",
            });
            operation.parameters.push({
              name: "per_page",
              in: "query",
              schema: { type: "integer" },
              required: false,
              description: "Items per page",
            });
            operation.parameters.push({
              name: "search",
              in: "query",
              schema: { type: "string" },
              required: false,
              description: "Search query",
            });
            operation.parameters.push({
              name: "sort",
              in: "query",
              schema: { type: "string" },
              required: false,
              description: "Sort option",
            });
            operation.parameters.push({
              name: "startDate",
              in: "query",
              schema: { type: "string", format: "date" },
              required: false,
              description: "Filter start date",
            });
            operation.parameters.push({
              name: "endDate",
              in: "query",
              schema: { type: "string", format: "date" },
              required: false,
              description: "Filter end date",
            });
          }

          // add requestBody stub for POST/PUT/PATCH
          if (["post", "put", "patch"].includes(m)) {
            operation.requestBody = {
              description: "Request payload (schema may vary by endpoint)",
              required: true,
              content: {
                "application/json": {
                  schema: { type: "object" },
                  example: {},
                },
              },
            };
          }

          paths[cleanPath][m] = operation;
        });
      } else if (
        layer.name === "router" &&
        layer.handle &&
        layer.handle.stack
      ) {
        const newPrefix = prefix + regexpToPath(layer.regexp);
        traverse(layer.handle.stack, newPrefix);
      }
    });
  };

  if (app && app._router && Array.isArray(app._router.stack)) {
    traverse(app._router.stack, "");
  }

  return {
    openapi: "3.0.0",
    info: {
      title: "ZOANS CRM API",
      version: "1.0.0",
      description: "Dynamically generated API routes overview (auto-generated)",
    },
    servers: [
      {
        url: "https://api.jdhcaterers.com",
        description: "Primary API (production)",
      },
      {
        url: `http://localhost:${process.env.PORT || 5000}`,
        description: "Local server",
      },
    ],
    paths,
  };
};

try {
  const openapiSpec = generateOpenAPISpec();
  app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(openapiSpec));
  app.get("/api-docs.json", (req, res) => res.json(openapiSpec));
  console.log("Swagger UI available at /api-docs");
} catch (e) {
  console.error("Failed to mount Swagger UI:", e && e.message ? e.message : e);
  app.get("/api-docs", (req, res) =>
    res.status(500).send("Swagger docs unavailable"),
  );
}

// Global process-level error handlers to capture startup/runtime problems
// on hosting platforms (helpful when debugging 5xx / 503 gateway responses)
process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Rejection at:", promise, "reason:", reason);
});

process.on("uncaughtException", (err) => {
  console.error("Uncaught Exception thrown:", err);
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: "Something went wrong" });
});

// Server listener with socket.io
const http = require("http");
const server = http.createServer(app);
// Log raw HTTP upgrade requests to help debug websocket proxy/upgrade problems
server.on("upgrade", (req, socket, head) => {
  try {
    console.log("HTTP upgrade request", {
      url: req.url,
      headers: {
        upgrade: req.headers.upgrade,
        connection: req.headers.connection,
        origin: req.headers.origin,
        host: req.headers.host,
      },
      remoteAddress: req.socket && req.socket.remoteAddress,
    });
  } catch (e) {
    console.error(
      "Error logging upgrade request:",
      e && e.message ? e.message : e,
    );
  }
});
const PORT = process.env.PORT || 5000;

// Initialize socket service
const { init: initSocket } = require("./services/socketService");
try {
  initSocket(server, { allowedOrigins });
  console.log("Socket service initialized");
} catch (e) {
  console.error(
    "Failed to initialize socket service:",
    e && e.message ? e.message : e,
  );
}

server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
  try {
    startPaymentReminderScheduler();
  } catch (e) {
    console.error(
      "Failed to start payment reminder scheduler:",
      e && e.message ? e.message : e,
    );
  }

  try {
    startOrderFeedbackScheduler();
  } catch (e) {
    console.error(
      "Failed to start order feedback scheduler:",
      e && e.message ? e.message : e,
    );
  }
});
