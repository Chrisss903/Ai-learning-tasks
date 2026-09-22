import { readFileSync } from "fs";
import path from "path";

// Loaded by hand because scripts run outside Next, which normally does it.
// Import this first: lib modules read the environment when they load.
for (const file of [".env", ".env.local"]) {
  try {
    for (const line of readFileSync(path.join(process.cwd(), file), "utf-8").split("\n")) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (match) process.env[match[1]] = match[2].replace(/^["']|["']$/g, "");
    }
  } catch {
    // A missing env file is fine; the next one may have what is needed.
  }
}
