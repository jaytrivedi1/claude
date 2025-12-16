import express, { type Request, Response, NextFunction } from "express";
import { registerRoutes } from "../server/routes";
import { serveStatic } from "../server/vite";

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Serve uploaded files statically
app.use('/uploads', express.static('public/uploads'));

// Request logging
app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      console.log(`${req.method} ${path} ${res.statusCode} in ${duration}ms`);
    }
  });

  next();
});

// Error handler
app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  const status = err.status || err.statusCode || 500;
  const message = err.message || "Internal Server Error";
  console.error("Error:", err);
  res.status(status).json({ message });
});

// Register all API routes
let initialized = false;

async function initializeApp() {
  if (!initialized) {
    await registerRoutes(app);
    serveStatic(app);
    initialized = true;
  }
}

// Vercel serverless handler
export default async function handler(req: Request, res: Response) {
  await initializeApp();
  return app(req, res);
}
