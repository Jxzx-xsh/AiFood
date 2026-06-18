import dotenv from 'dotenv';
dotenv.config();

export const config = {
  server: {
    port: parseInt(process.env.PORT || '3000', 10),
    nodeEnv: process.env.NODE_ENV || 'development',
    apiKey: process.env.API_KEY || '',
  },
  database: {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
    name: process.env.DB_NAME || 'food_mgr',
  },
  redis: {
    url: process.env.REDIS_URL || 'redis://localhost:6379',
  },
  lmstudio: {
    host: process.env.LMSTUDIO_HOST || 'http://localhost:1234',
    model: process.env.VISION_MODEL || 'llama-3.2-11b-vision',
    timeout: 180000, // 180 seconds - 视觉模型推理需要更长时间
  },
  homeAssistant: {
    url: process.env.HA_URL || 'http://homeassistant.local:8123',
    token: process.env.HA_TOKEN || '',
  },
} as const;
