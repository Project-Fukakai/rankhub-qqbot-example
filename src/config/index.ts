import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { z } from 'zod';

/**
 * 极简 `.env` 加载器：只填「进程里还没有」的键，不覆盖外部显式注入的环境变量。
 * 不引入 dotenv，避免多一个运行时依赖。
 */
function loadEnvFile(path: string): void {
  if (!existsSync(path)) return;
  const text = readFileSync(path, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

const booleanish = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const schema = z.object({
  QQ_APP_ID: z.string().min(1, 'QQ_APP_ID is required'),
  QQ_APP_SECRET: z.string().min(1, 'QQ_APP_SECRET is required'),
  QQ_API_BASE: z.string().url().default('https://api.bot.qq.com'),
  QQ_TOKEN_URL: z.string().url().default('https://api.bot.qq.com/app/getAppAccessToken'),
  QQ_INTENTS: z.coerce.number().int().positive().default(1 << 25),

  RANKHUB_CLIENT_ID: z.string().min(1).default('rankhub-qqbot'),
  RANKHUB_CLIENT_SECRET: z.string().min(1, 'RANKHUB_CLIENT_SECRET is required'),
  RANKHUB_AUTH_BASE: z.string().url().default('https://auth.rankhub.cc'),
  RANKHUB_API_BASE: z.string().url().default('https://api.rankhub.cc'),
  RANKHUB_SCOPES: z.string().default('openid profile offline_access game:read'),
  RANKHUB_DEVICE_POLL_MAX_SECONDS: z.coerce.number().int().positive().default(240),

  TOKEN_ENC_KEY: z
    .string()
    .min(1)
    .refine((v) => {
      try {
        return Buffer.from(v, 'base64').length === 32;
      } catch {
        return false;
      }
    }, 'TOKEN_ENC_KEY must be base64 of exactly 32 bytes'),
  DB_PATH: z.string().default('./data/bot.db'),

  RENDER_BROWSER_PATH: z.string().optional(),
  MAIMAIDX_STATIC: z.string().optional(),
  PHI_PLUGIN_RES: z.string().optional(),
  MAIMAI_RENDERER: z.enum(['auto', 'node', 'python']).default('auto'),
  MAIMAI_PYTHON: z.string().default('python3.11'),

  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  QQ_FAKE_BASE: z.string().optional(),
  QQ_FAKE_ONLY: booleanish.optional(),
});

export type AppConfig = z.infer<typeof schema> & {
  rootDir: string;
  envFileLoaded: boolean;
};

let cached: AppConfig | null = null;

export function loadConfig(envFile = resolve(process.cwd(), '.env.local')): AppConfig {
  if (cached) return cached;
  const existed = existsSync(envFile);
  loadEnvFile(envFile);
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`配置校验失败（${envFile}）：${issues}`);
  }
  cached = {
    ...parsed.data,
    rootDir: process.cwd(),
    envFileLoaded: existed,
  };
  return cached;
}

/** 测试用：清掉缓存，允许换一套 env 重新加载。 */
export function resetConfigCache(): void {
  cached = null;
}
