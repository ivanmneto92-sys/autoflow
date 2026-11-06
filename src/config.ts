import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.string().default('development'),
  PORT: z.coerce.number().default(3000),
  PUBLIC_BASE_URL: z.string().url(), // ex.: https://api.autoflow.com.br (usado no redirect do OAuth)
  IG_CONNECT_START_BASE_URL: z.string().url().optional(), // URL do botão quando só o callback passa pelo túnel
  DASHBOARD_URL: z.string().url().optional(), // para onde o usuário volta após conectar

  // Painel: login via Supabase Auth (URL do projeto + chave publicável/anon)
  // Endereços de onde o painel pode chamar a API (separados por vírgula)
  PANEL_ORIGINS: z.string().default('http://localhost:5173,https://autoflow.a2bads.com.br'),
  SUPABASE_URL: z.string().url().optional(),
  SUPABASE_PUBLISHABLE_KEY: z.string().optional(),

  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().default('redis://localhost:6379'),

  // App da Meta — "Instagram API com login do Instagram"
  IG_APP_ID: z.string().min(1),
  IG_APP_SECRET: z.string().min(1),
  IG_WEBHOOK_VERIFY_TOKEN: z.string().min(8),
  IG_GRAPH_VERSION: z.string().default('v21.0'),
  // instagram = "API com login do Instagram" (tokens IGAA, graph.instagram.com)
  // facebook  = "login unificado" / Login do Facebook para Empresas (tokens EAA, graph.facebook.com, via Página)
  IG_LOGIN_MODE: z.enum(['instagram', 'facebook']).default('instagram'),
  // Config ID do login unificado (Casos de uso → API setup with Unified login)
  IG_LOGIN_CONFIG_ID: z.string().optional(),
  // Chaves secretas de outros apps da Meta cujos webhooks também chegam aqui (separadas por vírgula)
  IG_EXTRA_APP_SECRETS: z.string().default(''),
  IG_SCOPES: z
    .string()
    .default(
      'instagram_business_basic,instagram_business_manage_messages,instagram_business_manage_comments,instagram_business_content_publish',
    ),

  // 32 bytes em base64 — `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`
  ENCRYPTION_KEY: z.string().min(40),
  // Assina o `state` do OAuth
  STATE_SECRET: z.string().min(16),
  // Protege as rotas /admin enquanto não existe painel
  ADMIN_API_KEY: z.string().min(16),

  // Mídias das publicações agendadas: pasta local servida em PUBLIC_BASE_URL/media (a Meta baixa daí)
  MEDIA_DIR: z.string().default('uploads'),
  MEDIA_MAX_MB: z.coerce.number().positive().default(240),
  // Intervalo (segundos) em que o worker procura publicações vencidas
  PUBLISH_POLL_SECONDS: z.coerce.number().min(5).default(20),

  WORKER_CONCURRENCY: z.coerce.number().default(10),
  LOG_LEVEL: z.string().default('info'),
});

export type Config = z.infer<typeof schema>;

let cached: Config | undefined;
export function config(): Config {
  if (!cached) {
    const parsed = schema.safeParse(process.env);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
      throw new Error(`Variáveis de ambiente inválidas:\n${issues}`);
    }
    cached = parsed.data;
  }
  return cached;
}
