/**
 * Load .env only in development. Railway injects env at runtime — skip file read in production for fast boot.
 */
import { createRequire } from "module";
const require = createRequire(import.meta.url);
if (process.env.NODE_ENV !== "production") {
  require("dotenv").config();
}
