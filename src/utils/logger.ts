import { existsSync, mkdirSync, appendFileSync } from "node:fs";
import path from "node:path";

const LOGS_DIR = path.join(process.cwd(), "logs");

// Ensure logs folder exists
if (!existsSync(LOGS_DIR)) {
  mkdirSync(LOGS_DIR);
}

function getLogFile(): string {
  const date = new Date().toISOString().slice(0, 10); // 2026-04-01
  return path.join(LOGS_DIR, `${date}.log`);
}

function writeToFile(level: string, message: string, error?: unknown) {
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  let line = `[${ts}] ${level}  ${message}\n`;
  if (error && error instanceof Error && error.stack) {
    line += `${error.stack}\n`;
  }
  appendFileSync(getLogFile(), line);
}

const colors = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
};

function timestamp(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

export const logger = {
  info(message: string) {
    console.log(`${colors.dim}${timestamp()}${colors.reset} ${colors.green}INFO${colors.reset}  ${message}`);
    writeToFile("INFO", message);
  },

  warn(message: string) {
    console.log(`${colors.dim}${timestamp()}${colors.reset} ${colors.yellow}WARN${colors.reset}  ${message}`);
    writeToFile("WARN", message);
  },

  error(message: string, error?: unknown) {
    console.error(`${colors.dim}${timestamp()}${colors.reset} ${colors.red}ERROR${colors.reset} ${message}`);
    if (error && error instanceof Error && error.stack) {
      console.error(`${colors.dim}${error.stack}${colors.reset}`);
    }
    writeToFile("ERROR", message, error);
  },

  debug(message: string) {
    if (process.env.DEBUG === "true") {
      console.log(`${colors.dim}${timestamp()}${colors.reset} ${colors.cyan}DEBUG${colors.reset} ${message}`);
    }
    writeToFile("DEBUG", message);
  },
};
