/**
 * Environment-Aware Logger
 * In production (NODE_ENV=production), development milestone logs (log, info, warn)
 * are silenced to protect performance and avoid log clutter.
 * Critical errors (error) always pass through.
 * To enable verbose logging in production for debugging, set ENABLE_PROD_LOGS=true.
 */

export const isProduction = process.env.NODE_ENV === 'production' && process.env.ENABLE_PROD_LOGS !== 'true';

export const logger = {
  log: (...args: any[]) => {
    if (!isProduction) console.log(...args);
  },
  info: (...args: any[]) => {
    if (!isProduction) console.info(...args);
  },
  warn: (...args: any[]) => {
    if (!isProduction) console.warn(...args);
  },
  error: (...args: any[]) => {
    console.error(...args);
  },
};
